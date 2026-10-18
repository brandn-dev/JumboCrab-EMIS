"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  approveScheduleDraft,
  generateScheduleDraft,
  listScheduleCoverageRules,
  publishScheduleDraft,
  retrySchedulePublicationNotification,
  saveScheduleCoverageRule,
  validateScheduleDraft,
} from "@/actions/schedule/schedule-policy-action";
import type { ScheduleDraftDetails } from "@/types/schedule-draft-types";
import type {
  ScheduleCoveragePositionOption,
  ScheduleCoverageRuleRecord,
  SchedulePolicyIssueReport,
} from "@/types/schedule-policy-types";
import { AlertTriangle, CheckCircle2, Plus, RefreshCcw, Save, Send, ShieldCheck, WandSparkles } from "lucide-react";

const weekdays = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "7", label: "Sunday" },
];

type RuleForm = {
  id?: string;
  name: string;
  departmentId: string;
  positionId: string;
  shiftId: string;
  weekday: string;
  minimumStaff: string;
  maximumStaff: string;
  priority: "" | "HARD" | "SOFT";
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
};

const emptyForm = (): RuleForm => ({
  name: "",
  departmentId: "",
  positionId: "",
  shiftId: "",
  weekday: "",
  minimumStaff: "",
  maximumStaff: "",
  priority: "",
  isActive: true,
  effectiveFrom: "",
  effectiveTo: "",
});

type Props = {
  departments: Array<{ departmentId: string; name: string }>;
  shifts: Array<{ id: number; code: string; name: string; isDayOff?: boolean }>;
  activeDraft: ScheduleDraftDetails | null;
  draftDirty: boolean;
  onDraftGenerated: (draft: ScheduleDraftDetails) => void;
  onRefresh: () => void | Promise<void>;
};

export function SchedulePolicyPanel({ departments, shifts, activeDraft, draftDirty, onDraftGenerated, onRefresh }: Props) {
  const [rules, setRules] = useState<ScheduleCoverageRuleRecord[]>([]);
  const [positions, setPositions] = useState<ScheduleCoveragePositionOption[]>([]);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<"generate" | "validate" | "approve" | "publish" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localReport, setLocalReport] = useState<{ draftId: string; report: SchedulePolicyIssueReport } | null>(null);
  const [warningAcknowledgedDraftId, setWarningAcknowledgedDraftId] = useState<string | null>(null);
  const [publishDialogDraftId, setPublishDialogDraftId] = useState<string | null>(null);
  const report = activeDraft?.validationReport ?? (localReport && localReport.draftId === activeDraft?.id ? localReport.report : null);
  const warningAcknowledged = Boolean(activeDraft?.warningsAcknowledgedAt) || activeDraft?.id === warningAcknowledgedDraftId;
  const publishOpen = Boolean(activeDraft && publishDialogDraftId === activeDraft.id);

  const filteredPositions = useMemo(() =>
    positions.filter((position) => !form.departmentId || position.departmentId === form.departmentId),
  [form.departmentId, positions]);
  const canGenerate = Boolean(
    activeDraft?.isLatestVersion &&
    activeDraft.status !== "PUBLISHED" &&
    activeDraft.status !== "DISCARDED" &&
    !draftDirty &&
    (activeDraft.sourceMode === "REFERENCE_WEEK" || activeDraft.sourceMode === "EMPTY"),
  );
  const canApprove = Boolean(
    activeDraft?.isLatestVersion &&
    activeDraft.status === "VALIDATED" &&
    !activeDraft.isSourceStale &&
    !draftDirty &&
    report?.isValid &&
    (report.warningCount === 0 || warningAcknowledged),
  );
  const canPublish = Boolean(
    activeDraft?.isLatestVersion &&
    activeDraft.status === "APPROVED" &&
    !activeDraft.isSourceStale &&
    !draftDirty,
  );
  const changedAssignments = activeDraft?.assignments.filter((assignment) =>
    assignment.source === "MANUAL" ||
    (assignment.shiftId !== assignment.baselineShiftId && !(
      assignment.hasBaselineOverride && assignment.shiftId === assignment.baselineOverrideShiftId
    )),
  ) ?? [];
  const changedEmployeeCount = new Set(changedAssignments.map((assignment) => assignment.employeeId)).size;
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const shiftLabel = (shiftId: number | null) => {
    if (shiftId == null) return "Unassigned";
    const shift = shiftById.get(shiftId);
    if (!shift) return `Shift ${shiftId}`;
    return `${shift.isDayOff ? "Day off · " : ""}${shift.code} · ${shift.name}`;
  };
  const assignmentLabel = (assignment: ScheduleDraftDetails["assignments"][number], shiftId: number | null) => {
    if (assignment.isProtected) return `Protected leave · base ${shiftLabel(shiftId)}`;
    return shiftLabel(shiftId);
  };
  const dateLabel = (workDate: string) => new Date(`${workDate}T12:00:00.000Z`).toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const refreshRules = async () => {
    setLoading(true);
    setError(null);
    const result = await listScheduleCoverageRules();
    if (!result.success) {
      setError(result.error || "Failed to load coverage rules.");
      setLoading(false);
      return;
    }
    setRules(result.data.rules as ScheduleCoverageRuleRecord[]);
    setPositions(result.data.positions as ScheduleCoveragePositionOption[]);
    setLoading(false);
  };

  useEffect(() => {
    let ignore = false;
    void listScheduleCoverageRules().then((result) => {
      if (ignore) return;
      if (!result.success) {
        setError(result.error || "Failed to load coverage rules.");
      } else {
        setRules(result.data.rules as ScheduleCoverageRuleRecord[]);
        setPositions(result.data.positions as ScheduleCoveragePositionOption[]);
      }
      setLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, []);

  const editRule = (rule: ScheduleCoverageRuleRecord) => {
    setForm({
      id: rule.id,
      name: rule.name,
      departmentId: rule.departmentId ?? "",
      positionId: rule.positionId ?? "",
      shiftId: rule.shiftId == null ? "" : String(rule.shiftId),
      weekday: String(rule.weekday),
      minimumStaff: String(rule.minimumStaff),
      maximumStaff: rule.maximumStaff == null ? "" : String(rule.maximumStaff),
      priority: rule.priority,
      isActive: rule.isActive,
      effectiveFrom: rule.effectiveFrom ?? "",
      effectiveTo: rule.effectiveTo ?? "",
    });
    setError(null);
    setNotice(null);
  };

  const submitRule = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const minimum = form.minimumStaff === "" ? Number.NaN : Number(form.minimumStaff);
    const maximum = form.maximumStaff === "" ? null : Number(form.maximumStaff);
    if (!Number.isSafeInteger(minimum) || (maximum != null && !Number.isSafeInteger(maximum))) {
      setError("Enter a whole number for each staffing limit.");
      setSaving(false);
      return;
    }
    if (!form.weekday || !form.priority) {
      setError("Choose a weekday and rule priority.");
      setSaving(false);
      return;
    }
    const result = await saveScheduleCoverageRule({
      id: form.id,
      name: form.name,
      departmentId: form.departmentId || null,
      positionId: form.positionId || null,
      shiftId: form.shiftId ? Number(form.shiftId) : null,
      weekday: Number(form.weekday),
      minimumStaff: minimum,
      maximumStaff: maximum,
      priority: form.priority,
      isActive: form.isActive,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
    });
    if (!result.success) {
      setError(result.error || "Failed to save coverage rule.");
      setSaving(false);
      return;
    }
    setNotice(form.id ? "Coverage rule updated." : "Coverage rule added.");
    setForm(emptyForm());
    await refreshRules();
    setSaving(false);
  };

  const validate = async () => {
    if (!activeDraft || draftDirty) return;
    setRunning("validate");
    setError(null);
    setNotice(null);
    const result = await validateScheduleDraft({ draftId: activeDraft.id });
    if (!result.success) {
      setError(result.error || "Failed to validate draft.");
    } else {
      setLocalReport({ draftId: result.data.draft.id, report: result.data as SchedulePolicyIssueReport });
      setWarningAcknowledgedDraftId(null);
      onDraftGenerated(result.data.draft as ScheduleDraftDetails);
      setNotice(result.data.isValid
        ? `Validation complete: ${result.data.warningCount} warning(s), ${result.data.infoCount} information item(s).`
        : `Validation found ${result.data.blockerCount} blocking issue(s).`);
    }
    setRunning(null);
  };

  const approve = async () => {
    if (!activeDraft) return;
    setRunning("approve");
    setError(null);
    setNotice(null);
    const result = await approveScheduleDraft({
      draftId: activeDraft.id,
      acknowledgeWarnings: warningAcknowledged,
    });
    if (!result.success) {
      setError(result.error || "Failed to approve draft.");
    } else {
      onDraftGenerated(result.data as ScheduleDraftDetails);
      setNotice(`Draft v${result.data.version} approved. Publish remains a separate action.`);
    }
    setRunning(null);
  };

  const publish = async () => {
    if (!activeDraft) return;
    setRunning("publish");
    setError(null);
    setNotice(null);
    const result = await publishScheduleDraft({ draftId: activeDraft.id, confirmed: true });
    if (!result.success) {
      setError(result.error || "Failed to publish schedule.");
    } else {
      onDraftGenerated(result.data.draft as ScheduleDraftDetails);
      setPublishDialogDraftId(null);
      const notificationStatus = result.data.notificationStatus;
      setNotice(notificationStatus === "FAILED"
        ? "Schedule published. Employee notification failed; retry is available below."
        : notificationStatus === "SKIPPED"
          ? "Schedule published. No linked employee accounts needed notification."
          : "Schedule published. Employee notifications sent.");
      await onRefresh();
    }
    setRunning(null);
  };

  const retryNotification = async () => {
    if (!activeDraft) return;
    setRunning("retry");
    setError(null);
    setNotice(null);
    const result = await retrySchedulePublicationNotification({ draftId: activeDraft.id });
    if (!result.success) {
      setError(result.error || "Failed to retry employee notification.");
    } else {
      onDraftGenerated(result.data.draft as ScheduleDraftDetails);
      setNotice(result.data.notificationStatus === "FAILED"
        ? result.data.notificationError || "Notification retry failed."
        : result.data.notificationStatus === "SKIPPED"
          ? "No linked employee accounts needed notification."
          : "Employee notification sent.");
    }
    setRunning(null);
  };

  const generate = async () => {
    if (!activeDraft) return;
    setRunning("generate");
    setError(null);
    setNotice(null);
    const result = await generateScheduleDraft({ draftId: activeDraft.id });
    if (!result.success) {
      setError(result.error || "Failed to generate from reference.");
    } else {
      onDraftGenerated(result.data.draft as ScheduleDraftDetails);
      setLocalReport({ draftId: result.data.draft.id, report: {
        issues: result.data.issues,
        isValid: !result.data.issues.some((issue) => issue.severity === "BLOCKER"),
        blockerCount: result.data.issues.filter((issue) => issue.severity === "BLOCKER").length,
        warningCount: result.data.issues.filter((issue) => issue.severity === "WARNING").length,
        infoCount: result.data.issues.filter((issue) => issue.severity === "INFO").length,
        coverageConfigured: !result.data.issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED"),
      } });
      setNotice(`Generated draft v${result.data.draft.version}; ${result.data.changedCells} cell change(s).`);
    }
    setRunning(null);
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-base">Staffing rules and checks</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure reviewed staffing levels. No minimum, rest period, or weekly-hour policy is assumed.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={validate}
              disabled={
                !activeDraft ||
                !activeDraft.isLatestVersion ||
                draftDirty ||
                (activeDraft.status !== "DRAFT" && activeDraft.status !== "VALIDATED") ||
                running !== null
              }
            >
              {running === "validate" ? "Checking…" : "Validate draft"}
            </Button>
            <Button type="button" size="sm" onClick={generate} disabled={!canGenerate || running !== null}>
              <WandSparkles className="mr-2 h-4 w-4" />
              {running === "generate"
                ? "Generating…"
                : activeDraft?.sourceMode === "EMPTY"
                  ? "Generate new schedule"
                  : "Generate from reference"}
            </Button>
            {activeDraft?.status === "VALIDATED" ? (
              <Button type="button" size="sm" onClick={approve} disabled={!canApprove || running !== null}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                {running === "approve" ? "Approving…" : "Approve exact version"}
              </Button>
            ) : null}
            {activeDraft?.status === "APPROVED" ? (
              <Button type="button" size="sm" onClick={() => activeDraft && setPublishDialogDraftId(activeDraft.id)} disabled={!canPublish || running !== null}>
                <Send className="mr-2 h-4 w-4" />
                Publish schedule
              </Button>
            ) : null}
            {activeDraft?.status === "PUBLISHED" && (activeDraft.notificationStatus === "FAILED" || activeDraft.notificationStatus === "PENDING") ? (
              <Button type="button" size="sm" variant="outline" onClick={retryNotification} disabled={running !== null}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                {running === "retry" ? "Retrying…" : "Retry employee notification"}
              </Button>
            ) : null}
          </div>
        </div>
        {activeDraft && activeDraft.sourceMode !== "REFERENCE_WEEK" && activeDraft.sourceMode !== "EMPTY" ? (
          <p className="text-xs text-muted-foreground">Create a draft from a reference week or an empty template to enable deterministic generation.</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={submitRule} className="grid gap-3 rounded-lg border p-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5 xl:col-span-2">
            <Label htmlFor="coverage-rule-name">Rule name</Label>
            <Input id="coverage-rule-name" value={form.name} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Kitchen morning minimum" />
          </div>
          <div className="space-y-1.5">
            <Label>Department scope</Label>
            <Select value={form.departmentId || "__any"} onValueChange={(value) => setForm((current) => ({
              ...current,
              departmentId: value === "__any" ? "" : value,
              positionId: value !== "__any" && current.positionId && positions.find((position) => position.positionId === current.positionId)?.departmentId !== value ? "" : current.positionId,
            }))}>
              <SelectTrigger><SelectValue placeholder="Any department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any department</SelectItem>
                {departments.map((department) => <SelectItem key={department.departmentId} value={department.departmentId}>{department.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Position scope</Label>
            <Select value={form.positionId || "__any"} onValueChange={(value) => setForm((current) => ({ ...current, positionId: value === "__any" ? "" : value }))}>
              <SelectTrigger><SelectValue placeholder="Any position" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any position</SelectItem>
                {filteredPositions.map((position) => <SelectItem key={position.positionId} value={position.positionId}>{position.name} · {position.departmentName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Shift scope</Label>
            <Select value={form.shiftId || "__any"} onValueChange={(value) => setForm((current) => ({ ...current, shiftId: value === "__any" ? "" : value }))}>
              <SelectTrigger><SelectValue placeholder="Any working shift" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any working shift</SelectItem>
                {shifts.filter((shift) => !shift.isDayOff).map((shift) => <SelectItem key={shift.id} value={String(shift.id)}>{shift.code} · {shift.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Weekday</Label>
            <Select value={form.weekday} onValueChange={(value) => setForm((current) => ({ ...current, weekday: value }))}>
              <SelectTrigger><SelectValue placeholder="Choose day" /></SelectTrigger>
              <SelectContent>{weekdays.map((day) => <SelectItem key={day.value} value={day.value}>{day.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coverage-minimum">Minimum staff</Label>
            <Input id="coverage-minimum" type="number" min="0" step="1" value={form.minimumStaff} onChange={(event) => setForm((current) => ({ ...current, minimumStaff: event.target.value }))} placeholder="Required" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coverage-maximum">Maximum staff (optional)</Label>
            <Input id="coverage-maximum" type="number" min="0" step="1" value={form.maximumStaff} onChange={(event) => setForm((current) => ({ ...current, maximumStaff: event.target.value }))} placeholder="No maximum" />
          </div>
          <div className="space-y-1.5">
            <Label>Priority</Label>
            <Select value={form.priority} onValueChange={(value: "HARD" | "SOFT") => setForm((current) => ({ ...current, priority: value }))}>
              <SelectTrigger><SelectValue placeholder="Choose priority" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="HARD">Hard requirement</SelectItem>
                <SelectItem value="SOFT">Soft preference</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coverage-effective-from">Effective from (optional)</Label>
            <Input id="coverage-effective-from" type="date" value={form.effectiveFrom} onChange={(event) => setForm((current) => ({ ...current, effectiveFrom: event.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coverage-effective-to">Effective to (optional)</Label>
            <Input id="coverage-effective-to" type="date" value={form.effectiveTo} onChange={(event) => setForm((current) => ({ ...current, effectiveTo: event.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Rule status</Label>
            <Select value={form.isActive ? "ACTIVE" : "INACTIVE"} onValueChange={(value) => setForm((current) => ({ ...current, isActive: value === "ACTIVE" }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ACTIVE">Active</SelectItem><SelectItem value="INACTIVE">Inactive</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 xl:col-span-4">
            <Button type="submit" size="sm" disabled={saving}>
              {form.id ? <Save className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              {saving ? "Saving…" : form.id ? "Update rule" : "Add rule"}
            </Button>
            {form.id ? <Button type="button" size="sm" variant="outline" onClick={() => setForm(emptyForm())}>Cancel edit</Button> : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => void refreshRules()} disabled={loading || saving}>
              <RefreshCcw className="mr-2 h-4 w-4" /> Refresh
            </Button>
          </div>
        </form>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}

        {activeDraft?.isSourceStale && activeDraft.status !== "PUBLISHED" ? (
          <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            Live schedule inputs changed after this draft was created. Refresh source by creating a new draft, then validate and approve that version.
          </div>
        ) : null}

        {report ? (
          <section aria-label="Schedule validation report" className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              {report.isValid
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : <AlertTriangle className="h-4 w-4 text-amber-500" />}
              <span className="font-medium">
                {report.isValid ? "Validation passed" : "Validation has blockers"}
              </span>
              <Badge variant={report.blockerCount > 0 ? "destructive" : "secondary"}>{report.blockerCount} blockers</Badge>
              <Badge variant="outline">{report.warningCount} warnings</Badge>
              <Badge variant="outline">{report.infoCount} info</Badge>
              {!report.coverageConfigured ? <Badge variant="outline">Coverage not configured</Badge> : null}
              {report.validatedAt ? (
                <span className="text-xs text-muted-foreground">
                  Checked {new Date(report.validatedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
            </div>
            {report.issues.length > 0 ? (
              <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3 text-sm">
                {report.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.employeeId ?? ""}-${issue.workDate ?? ""}-${index}`} className="border-b pb-2 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={issue.severity === "BLOCKER" ? "destructive" : issue.severity === "WARNING" ? "warning" : "outline"}>{issue.severity}</Badge>
                      <span className="font-medium">{issue.code.replaceAll("_", " ").toLowerCase()}</span>
                      {issue.workDate ? <span className="text-xs text-muted-foreground">{issue.workDate}</span> : null}
                    </div>
                    <p className="mt-1">{issue.message}</p>
                    {issue.suggestedFix ? <p className="mt-1 text-xs text-muted-foreground">Suggested fix: {issue.suggestedFix}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No blockers or warnings found.</p>
            )}
            {activeDraft?.status === "VALIDATED" && report.warningCount > 0 ? (
              <div className="flex items-start gap-2 border-t pt-3">
                <input
                  type="checkbox"
                  id="acknowledge-schedule-warnings"
                  checked={warningAcknowledged}
                  onChange={(event) => setWarningAcknowledgedDraftId(event.target.checked && activeDraft ? activeDraft.id : null)}
                  className="mt-1 size-4 shrink-0 rounded border border-input accent-primary"
                />
                <Label htmlFor="acknowledge-schedule-warnings" className="cursor-pointer text-sm leading-5">
                  I reviewed these warnings for draft v{activeDraft.version} and approve this exact version.
                </Label>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeDraft?.status === "APPROVED" ? (
          <div role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            Draft v{activeDraft.version} approved by manager. Publication requires separate confirmation.
          </div>
        ) : null}

        {activeDraft?.status === "PUBLISHED" ? (
          <div role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            Draft v{activeDraft.version} published{activeDraft.publishedAt ? ` on ${new Date(activeDraft.publishedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" })}` : ""}.
            {activeDraft.notificationStatus ? <span> Employee notification: {activeDraft.notificationStatus.toLowerCase()}.</span> : null}
            {activeDraft.notificationError ? <span className="block text-destructive">{activeDraft.notificationError}</span> : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Configured coverage rules</h3>
            <span className="text-xs text-muted-foreground">{rules.filter((rule) => rule.isActive).length} active</span>
          </div>
          {loading ? <p className="text-sm text-muted-foreground">Loading rules…</p> : rules.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Not configured. Add company-reviewed minimums to evaluate coverage.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {rules.map((rule) => (
                <div key={rule.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{rule.name}</span>
                      <Badge variant={rule.priority === "HARD" ? "destructive" : "secondary"}>{rule.priority === "HARD" ? "Hard" : "Soft"}</Badge>
                      {!rule.isActive ? <Badge variant="outline">Inactive</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {weekdays.find((day) => Number(day.value) === rule.weekday)?.label} · {rule.departmentName ?? "All departments"} · {rule.positionName ?? "All positions"} · {rule.shiftLabel ?? "Any working shift"} · min {rule.minimumStaff}{rule.maximumStaff == null ? "" : ` · max ${rule.maximumStaff}`}
                    </p>
                    {rule.effectiveFrom || rule.effectiveTo ? <p className="text-xs text-muted-foreground">Effective {rule.effectiveFrom ?? "any date"} to {rule.effectiveTo ?? "any date"}</p> : null}
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => editRule(rule)}>Edit</Button>
                </div>
              ))}
            </div>
          )}
        </div>


      </CardContent>
      <Dialog open={publishOpen} onOpenChange={(open) => setPublishDialogDraftId(open && activeDraft ? activeDraft.id : null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Publish reviewed weekly schedule?</DialogTitle>
            <DialogDescription>
              This publishes draft v{activeDraft?.version} for week starting {activeDraft?.weekStart} to employee schedules.
            </DialogDescription>
          </DialogHeader>
          {activeDraft ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Employees in draft</div>
                  <div className="text-lg font-semibold">{activeDraft.scope.employeeIds.length}</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Changed cells</div>
                  <div className="text-lg font-semibold">{changedAssignments.length}</div>
                  <div className="text-xs text-muted-foreground">Across {changedEmployeeCount} employee(s)</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Validation</div>
                  <div className="text-lg font-semibold">{report?.warningCount ?? 0} warning(s)</div>
                  <div className="text-xs text-muted-foreground">Warnings acknowledged: {activeDraft.warningsAcknowledgedAt ? "Yes" : "Not needed"}</div>
                </div>
              </div>

              <div className="rounded-md border border-amber-500/35 bg-amber-500/5 p-3 text-sm">
                Publication writes complete seven-day weekly maps. Approved leave remains protected, and existing day-specific overrides remain effective while their underlying weekly values are preserved.
              </div>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Changed cells</h3>
                {changedAssignments.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No weekly base assignments change in this version.</p>
                ) : (
                  <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                    {changedAssignments.map((assignment) => (
                      <li key={`${assignment.employeeId}:${assignment.workDate}`} className="grid gap-2 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)] sm:items-center">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{assignment.employeeName}</div>
                          <div className="text-xs text-muted-foreground">{assignment.employeeCode} · {dateLabel(assignment.workDate)}</div>
                        </div>
                        <div className="text-xs text-muted-foreground">{assignment.hasBaselineOverride ? "Base / effective" : "Current → draft"}</div>
                        <div className="min-w-0 break-words">
                          {assignmentLabel(assignment, assignment.baselineShiftId)}
                          <span className="mx-2 text-muted-foreground">→</span>
                          {assignmentLabel(assignment, assignment.shiftId)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {report?.issues.length ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Validation notes</h3>
                  <ul className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3 text-sm">
                    {report.issues.map((issue, index) => (
                      <li key={`${issue.code}-${issue.employeeId ?? ""}-${issue.workDate ?? ""}-${index}`} className="border-b pb-2 last:border-b-0 last:pb-0">
                        <Badge variant={issue.severity === "BLOCKER" ? "destructive" : issue.severity === "WARNING" ? "warning" : "outline"}>{issue.severity}</Badge>
                        <span className="ml-2">{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPublishDialogDraftId(null)} disabled={running === "publish"}>Cancel</Button>
            <Button type="button" onClick={publish} disabled={!canPublish || running !== null}>
              <Send className="mr-2 h-4 w-4" />
              {running === "publish" ? "Publishing…" : "Publish week schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
