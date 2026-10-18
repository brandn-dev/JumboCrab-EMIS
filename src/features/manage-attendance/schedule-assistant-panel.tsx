"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Send, UserRound } from "lucide-react";
import { getScheduleDraftVersion } from "@/actions/schedule/schedule-draft-action";
import { listShifts } from "@/actions/schedule/shifts-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleDraftDetails } from "@/types/schedule-draft-types";

type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
  quickActions?: BulkQuickAction[];
  actionRequest?: string;
};

type ScheduleInteractionChoice = { id: string; label: string; description?: string };
type ScheduleInteraction = {
  id: string;
  kind: "CLARIFICATION" | "PROPOSAL" | "APPLIED" | "CANCELLED" | "EXPIRED" | "UNDONE";
  title: string;
  summary: string;
  selectionMode?: "single" | "multiple";
  options?: ScheduleInteractionChoice[];
  changes?: Array<{ employeeCode: string; employeeName: string; workDate: string; before: string; after: string }>;
  changeCount?: number;
  changesTruncated?: boolean;
  warnings?: string[];
  blockers?: string[];
  canApply?: boolean;
  canUndo?: boolean;
  canGoBack?: boolean;
};

type BulkQuickAction = {
  id: "all_week" | "choose_dates" | "confirm" | "cancel";
  label: string;
  bulkAction?: "all_week" | "confirm" | "cancel";
  sourceMessage?: string;
  prefill?: string;
  expectedDraftVersion?: number;
};

type ShiftOption = { code: string; name: string; isDayOff: boolean };

type ScheduleAssistantPanelProps = {
  weekStart: string;
  referenceWeekStart: string;
  departmentId: string;
  selectedEmployeeIds: string[];
  draftId: string | null;
  onDraftChanged: (draft: ScheduleDraftDetails) => void;
};

const makeMessage = (role: ChatMessage["role"], content: string, extras: Partial<ChatMessage> = {}): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  createdAt: new Date().toISOString(),
  ...extras,
});

export function ScheduleAssistantPanel({
  weekStart,
  referenceWeekStart,
  departmentId,
  selectedEmployeeIds,
  draftId,
  onDraftChanged,
}: ScheduleAssistantPanelProps) {
  const storageKey = `jumbocrab:weekly-schedule-chat:${weekStart}`;
  const actionStorageKey = `${storageKey}:bulk-actions`;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeInteraction, setActiveInteraction] = useState<ScheduleInteraction | null>(null);
  const [selectedInteractionOptionIds, setSelectedInteractionOptionIds] = useState<string[]>([]);
  const [composer, setComposer] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [shiftOptions, setShiftOptions] = useState<ShiftOption[]>([]);
  const [bulkShiftCode, setBulkShiftCode] = useState("");
  const [bulkDates, setBulkDates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const onDraftChangedRef = useRef(onDraftChanged);
  const weekDateOptions = useMemo(() => {
    const [year, month, day] = weekStart.split("-").map(Number);
    const monday = new Date(Date.UTC(year, month - 1, day, 12));
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(monday);
      date.setUTCDate(date.getUTCDate() + index);
      const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      const labelDate = new Date(`${dateKey}T12:00:00.000Z`);
      return {
        date: dateKey,
        label: new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "Asia/Manila" }).format(labelDate),
        shortDate: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
      };
    });
  }, [weekStart]);

  useEffect(() => {
    onDraftChangedRef.current = onDraftChanged;
  }, [onDraftChanged]);

  useEffect(() => {
    setBulkDates([]);
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    void listShifts().then((result) => {
      if (!cancelled && result.success && result.data) {
        setShiftOptions(result.data.map((shift) => ({ code: shift.code, name: shift.name, isDayOff: shift.isDayOff })));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const storedConversationId = window.localStorage.getItem(storageKey);
    setConversationId(storedConversationId);
    setMessages([]);
    setActiveInteraction(null);
    setSelectedInteractionOptionIds([]);
    setError(null);
    if (!storedConversationId) return () => { cancelled = true; };

    const loadHistory = async () => {
      setLoadingHistory(true);
      try {
        const response = await fetch(`/api/ai/chat?conversationId=${encodeURIComponent(storedConversationId)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const result = await response.json() as {
          success?: boolean;
          error?: string;
          data?: { messages?: ChatMessage[]; activeDraftId?: string | null; interaction?: ScheduleInteraction | null };
        };
        if (!response.ok || !result.success || !result.data) {
          if (!cancelled) {
            window.localStorage.removeItem(storageKey);
            setConversationId(null);
            setError(result.error ?? "Could not restore this chat.");
          }
          return;
        }
        if (cancelled) return;
        let restoredMessages = result.data.messages ?? [];
        const storedActions = window.localStorage.getItem(actionStorageKey);
        if (storedActions) {
          try {
            const pending = JSON.parse(storedActions) as {
              conversationId?: string;
              content?: string;
              actionRequest?: string;
              quickActions?: BulkQuickAction[];
            };
            if (pending.conversationId === storedConversationId && pending.content && pending.quickActions?.length) {
              const pendingMessageIndex = restoredMessages.map((message) => message.content).lastIndexOf(pending.content);
              if (pendingMessageIndex >= 0) {
                restoredMessages = restoredMessages.map((message, index) => index === pendingMessageIndex
                  ? { ...message, actionRequest: pending.actionRequest, quickActions: pending.quickActions }
                  : message);
              }
            }
          } catch {
            window.localStorage.removeItem(actionStorageKey);
          }
        }
        setMessages(restoredMessages);
        setActiveInteraction(result.data.interaction ?? null);
        if (result.data.activeDraftId && result.data.activeDraftId !== draftId) {
          const draftResult = await getScheduleDraftVersion({ draftId: result.data.activeDraftId });
          if (!cancelled && draftResult.success) onDraftChangedRef.current(draftResult.data);
        }
      } catch {
        if (!cancelled) setError("Could not restore this chat. Try again shortly.");
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    };
    void loadHistory();
    return () => { cancelled = true; };
  }, [actionStorageKey, draftId, storageKey]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    setSelectedInteractionOptionIds([]);
  }, [activeInteraction?.id]);

  const sendMessage = async (message: string, action?: {
    bulkAction?: "all_week" | "confirm" | "cancel";
    sourceMessage?: string;
    expectedDraftVersion?: number;
    interactionAction?: "select" | "apply" | "cancel" | "edit" | "undo" | "back";
    interactionId?: string;
    optionIds?: string[];
  }) => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage || sending) return;
    if (!action && activeInteraction && ["APPLIED", "CANCELLED", "EXPIRED", "UNDONE"].includes(activeInteraction.kind)) {
      setActiveInteraction(null);
    }
    setComposer("");
    setError(null);
    window.localStorage.removeItem(actionStorageKey);
    setMessages((current) => [
      ...current.map((existing) => existing.quickActions ? { ...existing, quickActions: undefined } : existing),
      makeMessage("USER", normalizedMessage),
    ]);
    setSending(true);
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          requestKey: crypto.randomUUID(),
          ...(conversationId ? { conversationId } : {}),
          draftId,
          weekStart,
          referenceWeekStart,
          departmentId: departmentId || null,
          selectedEmployeeIds,
          message: normalizedMessage,
          ...(action ? {
            ...(action.bulkAction ? { bulkAction: action.bulkAction } : {}),
            ...(action.sourceMessage ? { bulkSourceMessage: action.sourceMessage } : {}),
            ...(action.expectedDraftVersion ? { bulkExpectedDraftVersion: action.expectedDraftVersion } : {}),
            ...(action.interactionAction ? {
              interactionAction: action.interactionAction,
              interactionId: action.interactionId,
              ...(action.optionIds ? { optionIds: action.optionIds } : {}),
            } : {}),
          } : {}),
        }),
      });
      const result = await response.json() as {
        success?: boolean;
        error?: string;
        conversationId?: string;
        activeDraftId?: string | null;
        message?: string;
        quickActions?: BulkQuickAction[];
        interaction?: ScheduleInteraction;
        prefill?: string;
      };
      if (!response.ok || !result.success || !result.conversationId || typeof result.message !== "string") {
        throw new Error(result.error ?? "Scheduling chat request failed.");
      }
      setConversationId(result.conversationId);
      window.localStorage.setItem(storageKey, result.conversationId);
      const assistantMessage = makeMessage("ASSISTANT", result.message!, {
        quickActions: result.quickActions?.length ? result.quickActions : undefined,
        actionRequest: action?.sourceMessage ?? normalizedMessage,
      });
      if (assistantMessage.quickActions?.length) {
        window.localStorage.setItem(actionStorageKey, JSON.stringify({
          conversationId: result.conversationId,
          content: assistantMessage.content,
          actionRequest: assistantMessage.actionRequest,
          quickActions: assistantMessage.quickActions,
        }));
      } else {
        window.localStorage.removeItem(actionStorageKey);
      }
      setMessages((current) => [...current, assistantMessage]);
      if (result.interaction) setActiveInteraction(result.interaction);
      else if (action?.interactionAction) setActiveInteraction(null);
      if (result.prefill) {
        setComposer(result.prefill);
        requestAnimationFrame(() => composerRef.current?.focus());
      }
      if (result.activeDraftId && result.activeDraftId !== draftId) {
        const draftResult = await getScheduleDraftVersion({ draftId: result.activeDraftId });
        if (draftResult.success) onDraftChangedRef.current(draftResult.data);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Scheduling chat request failed.");
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(composer);
  };

  const handleQuickAction = (action: BulkQuickAction, sourceMessage: string) => {
    if (action.prefill) {
      window.localStorage.removeItem(actionStorageKey);
      setMessages((current) => current.map((existing) => existing.actionRequest === sourceMessage
        ? { ...existing, quickActions: undefined }
        : existing));
      setComposer(action.prefill);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (!action.bulkAction || !action.sourceMessage) return;
    const actionText = action.bulkAction === "confirm"
      ? "Apply the reviewed draft changes"
      : action.bulkAction === "cancel"
        ? "Cancel the reviewed draft changes"
        : "Use all seven days for this draft change";
    void sendMessage(actionText, {
      bulkAction: action.bulkAction,
      sourceMessage: action.sourceMessage || sourceMessage,
      ...(action.expectedDraftVersion ? { expectedDraftVersion: action.expectedDraftVersion } : {}),
    });
  };

  const handleInteractionAction = (
    action: "select" | "apply" | "cancel" | "edit" | "undo" | "back",
    optionIds: string[] = [],
  ) => {
    if (!activeInteraction) return;
    const labels = optionIds.map((id) => activeInteraction.options?.find((option) => option.id === id)?.label).filter(Boolean);
    const actionMessage = action === "select"
      ? `Selected ${labels.join(", ")}`
      : action === "apply"
        ? "Apply reviewed schedule proposal"
        : action === "cancel"
          ? "Cancel schedule proposal"
          : action === "undo"
            ? "Undo latest assistant draft change"
            : action === "back"
              ? "Return to previous scheduling question"
            : "Edit schedule request";
    void sendMessage(actionMessage, {
      interactionAction: action,
      interactionId: activeInteraction.id,
      ...(optionIds.length ? { optionIds } : {}),
    });
  };

  return (
    <Card aria-label="AI weekly scheduling assistant">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4" aria-hidden="true" />
          Scheduling assistant
        </CardTitle>
        <Badge variant="outline">Draft only</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={transcriptRef}
          role="log"
          aria-live="polite"
          aria-label="Scheduling chat messages"
          className="max-h-80 min-h-32 space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3"
        >
          {loadingHistory ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Restoring conversation…
            </div>
          ) : messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ask about this week’s draft, request a draft change, or ask for a validation. Assistant cannot approve or publish.
            </p>
          ) : messages.map((message) => (
            <div key={message.id} className={`flex gap-2 ${message.role === "USER" ? "justify-end" : "justify-start"}`}>
              {message.role === "ASSISTANT" ? <Bot className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
              <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${message.role === "USER" ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                <p className="whitespace-pre-wrap">{message.content}</p>
                {message.role === "ASSISTANT" && message.quickActions?.length ? (
                  <div role="group" aria-label="Scheduling choices" className="mt-3 flex flex-wrap gap-2">
                    {message.quickActions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        size="sm"
                        variant={action.id === "confirm" || action.id === "all_week" ? "default" : "outline"}
                        disabled={sending || loadingHistory}
                        onClick={() => handleQuickAction(action, message.actionRequest ?? "")}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
              {message.role === "USER" ? <UserRound className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
            </div>
          ))}
          {sending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking schedule context…
            </div>
          ) : null}
        </div>
        {activeInteraction ? (
          <section aria-label="Schedule proposal controls" className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{activeInteraction.title}</p>
                <p className="text-sm text-muted-foreground">{activeInteraction.summary}</p>
              </div>
              <Badge variant={activeInteraction.kind === "PROPOSAL" ? "secondary" : "outline"}>{activeInteraction.kind.toLowerCase()}</Badge>
            </div>
            {activeInteraction.options?.length ? (
              <div role="group" aria-label="Choose scheduling option" className="flex flex-wrap gap-2">
                {activeInteraction.options.map((option) => {
                  const selected = selectedInteractionOptionIds.includes(option.id);
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      aria-pressed={selected}
                      disabled={sending || loadingHistory}
                      onClick={() => {
                        if (activeInteraction.selectionMode === "multiple") {
                          setSelectedInteractionOptionIds((current) => selected
                            ? current.filter((id) => id !== option.id)
                            : [...current, option.id]);
                        } else {
                          handleInteractionAction("select", [option.id]);
                        }
                      }}
                    >
                      <span className="text-left">
                        {option.label}
                        {option.description ? <span className="block text-xs font-normal opacity-80">{option.description}</span> : null}
                      </span>
                    </Button>
                  );
                })}
                {activeInteraction.selectionMode === "multiple" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={selectedInteractionOptionIds.length === 0 || sending || loadingHistory}
                    onClick={() => handleInteractionAction("select", selectedInteractionOptionIds)}
                  >
                    Continue with {selectedInteractionOptionIds.length || "selected"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {activeInteraction.changes?.length ? (
              <div className="max-h-52 overflow-y-auto rounded-md border bg-background p-2">
                <p className="mb-2 text-xs font-medium">{activeInteraction.changeCount ?? activeInteraction.changes.length} proposed cell changes</p>
                <ul className="space-y-1 text-xs">
                  {activeInteraction.changes.slice(0, 20).map((change, index) => (
                    <li key={`${change.employeeCode}-${change.workDate}-${index}`} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                      <span>{change.employeeName} · {change.employeeCode} · {change.workDate}</span>
                      <span aria-hidden="true">→</span>
                      <span>{change.before} → {change.after}</span>
                    </li>
                  ))}
                </ul>
                {activeInteraction.changesTruncated ? <p className="mt-2 text-xs text-muted-foreground">Showing first 20 changes. Review all affected cells in draft after apply.</p> : null}
              </div>
            ) : null}
            {activeInteraction.blockers?.length ? (
              <div role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                <p className="font-medium">Apply blocked</p>
                <ul className="list-disc pl-5">{activeInteraction.blockers.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
              </div>
            ) : null}
            {activeInteraction.warnings?.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer">{activeInteraction.warnings.length} warning(s) and preserved cells</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{activeInteraction.warnings.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
              </details>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {activeInteraction.kind === "PROPOSAL" ? (
                <Button type="button" size="sm" disabled={!activeInteraction.canApply || sending || loadingHistory} onClick={() => handleInteractionAction("apply")}>
                  Apply reviewed changes to draft
                </Button>
              ) : null}
              {activeInteraction.kind === "APPLIED" && activeInteraction.canUndo ? (
                <Button type="button" size="sm" variant="outline" disabled={sending || loadingHistory} onClick={() => handleInteractionAction("undo")}>
                  Undo draft change
                </Button>
              ) : null}
            {activeInteraction.kind === "CLARIFICATION" || activeInteraction.kind === "PROPOSAL" ? (
                <>
                {activeInteraction.canGoBack ? (
                  <Button type="button" size="sm" variant="outline" disabled={sending || loadingHistory} onClick={() => handleInteractionAction("back")}>
                    Back
                  </Button>
                ) : null}
                  <Button type="button" size="sm" variant="outline" disabled={sending || loadingHistory} onClick={() => handleInteractionAction("edit")}>
                    Edit request
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={sending || loadingHistory} onClick={() => handleInteractionAction("cancel")}>
                    Cancel
                  </Button>
                </>
              ) : null}
            </div>
          </section>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <Textarea
            ref={composerRef}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            maxLength={2_000}
            rows={2}
            aria-label="Message the scheduling assistant"
            placeholder={draftId ? "Ask for a draft change or validation…" : "Ask to create a draft or find an employee…"}
            disabled={sending || loadingHistory}
            className="min-h-12 resize-y"
          />
          <Button type="submit" size="icon" aria-label="Send message" disabled={!composer.trim() || sending || loadingHistory}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
        {shiftOptions.filter((shift) => !shift.isDayOff).length ? (
          <section aria-label="Quick draft shift change" className="space-y-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Quick draft change</p>
              <p className="text-xs text-muted-foreground">Pick a shift code and dates. Change applies to everyone in active draft; you review before saving.</p>
            </div>
            <Select value={bulkShiftCode} onValueChange={setBulkShiftCode} disabled={!draftId || sending || loadingHistory}>
              <SelectTrigger aria-label="Choose a shift code">
                <SelectValue placeholder="Choose working shift code" />
              </SelectTrigger>
              <SelectContent>
                {shiftOptions.filter((shift) => !shift.isDayOff).map((shift) => (
                  <SelectItem key={shift.code} value={shift.code}>{shift.code} · {shift.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Choose schedule dates">
              {weekDateOptions.map((option) => {
                const selected = bulkDates.includes(option.date);
                return (
                  <Button
                    key={option.date}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    disabled={!draftId || sending || loadingHistory}
                    onClick={() => setBulkDates((current) => selected
                      ? current.filter((date) => date !== option.date)
                      : [...current, option.date].sort())}
                  >
                    {option.label} {option.shortDate}
                  </Button>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!draftId || sending || loadingHistory}
                onClick={() => setBulkDates(weekDateOptions.map((option) => option.date))}
              >
                All 7 days
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!draftId || !bulkShiftCode || bulkDates.length === 0 || sending || loadingHistory}
                onClick={() => void sendMessage(`Set all employees to shift ${bulkShiftCode} on ${bulkDates.join(", ")}`)}
              >
                Review {bulkDates.length || "selected"} {bulkDates.length === 1 ? "day" : "days"}
              </Button>
              {!draftId ? <span className="text-xs text-muted-foreground">Select or create draft to use quick change.</span> : null}
            </div>
          </section>
        ) : null}
        <p className="text-xs text-muted-foreground">AI suggestions stay in draft. Manual schedule is not changed.</p>
      </CardContent>
    </Card>
  );
}
