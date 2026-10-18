"use client";

import { useEffect, useMemo, useState } from "react";
import { DateRange } from "react-day-picker";
import { TZ } from "@/lib/timezone";
import { useToast } from "@/components/ui/toast-provider";
import {
  deleteScheduleOverride,
  getScheduleSnapshot,
  getWeekPlannerSnapshot,
  listScheduleOverrides,
  saveWeekPlannerAssignments,
  upsertScheduleOverride,
} from "@/actions/schedule/schedule-action";
import {
  createScheduleDraft,
  discardScheduleDraft,
  getScheduleDraftVersion,
  listScheduleDraftsForWeek,
  saveScheduleDraftVersion,
} from "@/actions/schedule/schedule-draft-action";
import { getSchedulePolicyFeatureAvailability } from "@/actions/schedule/schedule-policy-action";
import { createShift, deleteShift, updateShift } from "@/actions/schedule/shifts-action";
import { DailyScheduleCard } from "./daily-schedule-card";
import { OverridesSection } from "./overrides-section";
import { ShiftEditState, ShiftsSection } from "./shifts-section";
import { WeekPlannerSection } from "./week-planner-section";
import {
  applyWeekPlannerShiftMap,
  countWeekPlannerUnassignedDays,
  hydrateWeekPlannerRowShifts,
  isWeekPlannerDayEditable,
  makeDate,
  minutesToTimeInput,
  normalizeOverride,
  normalizeShift,
  normalizeWeekPlannerSnapshot,
    OverrideRow,
    PlannerDepartmentOption,
    plannerDateInputValue,
    ScheduleEntry,
    ShiftLite,
    todayISO,
    toDateInputValue,
    WeekPlannerAlternatePair,
    WeekPlannerBulkActionInput,
    WeekPlannerDayOffToolInput,
    WeekPlannerDayKey,
    WeekPlannerRow,
  weekPlannerDayKeys,
  weekPlannerRowToShiftMap,
  WeekShiftMap,
} from "@/types/schedule-types";
import type {
  ScheduleDraftAssignment,
  ScheduleDraftDetails,
  ScheduleDraftGroup,
} from "@/types/schedule-draft-types";

type ScheduleBoardProps = {
  mode?: "full" | "overrides" | "patterns";
};

const areWeekShiftMapsEqual = (left: WeekShiftMap, right: WeekShiftMap) =>
  weekPlannerDayKeys.every((dayKey) => (left[dayKey] ?? null) === (right[dayKey] ?? null));

const getDraftDayKey = (workDate: string): WeekPlannerDayKey => {
  const date = new Date(`${workDate}T12:00:00.000Z`);
  const weekday = date.getUTCDay();
  return weekPlannerDayKeys[weekday === 0 ? 6 : weekday - 1];
};

const draftAssignmentsToShiftMaps = (assignments: ScheduleDraftAssignment[]) =>
  assignments.reduce<Record<string, WeekShiftMap>>((maps, assignment) => {
    maps[assignment.employeeId] ??= {
      mon: null,
      tue: null,
      wed: null,
      thu: null,
      fri: null,
      sat: null,
      sun: null,
    };
    maps[assignment.employeeId][getDraftDayKey(assignment.workDate)] = assignment.shiftId;
    return maps;
  }, {});

const sameDraftAssignments = (
  draft: ScheduleDraftDetails,
  maps: Record<string, WeekShiftMap> | undefined,
  shiftsById: Map<number, ShiftLite>,
) => draft.assignments.every((assignment) => {
  const shiftId = maps?.[assignment.employeeId]?.[getDraftDayKey(assignment.workDate)] ?? null;
  if (shiftId !== assignment.shiftId) return false;
  if (assignment.isProtected) return true;
  const kind = shiftId == null ? "UNASSIGNED" : shiftsById.get(shiftId)?.isDayOff ? "DAY_OFF" : "WORK";
  return kind === assignment.assignmentKind;
});

export function ScheduleBoard({ mode = "full" }: ScheduleBoardProps) {
  const toast = useToast();
  const [date, setDate] = useState(todayISO());
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [shifts, setShifts] = useState<ShiftLite[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [plannerWeekStart, setPlannerWeekStart] = useState(plannerDateInputValue(todayISO()));
  const [plannerCompareWeekStart, setPlannerCompareWeekStart] = useState(
    plannerDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [plannerDepartmentId, setPlannerDepartmentId] = useState("");
  const [plannerEmployeeSearch, setPlannerEmployeeSearch] = useState("");
  const [plannerSelectedEmployeeIds, setPlannerSelectedEmployeeIds] = useState<string[]>([]);
  const [plannerRowCacheByWeek, setPlannerRowCacheByWeek] = useState<
    Record<string, Record<string, WeekPlannerRow>>
  >({});
  const [plannerDraftShiftMapByWeek, setPlannerDraftShiftMapByWeek] = useState<
    Record<string, Record<string, WeekShiftMap>>
  >({});
  const [plannerMode, setPlannerMode] = useState<"MANUAL" | "AI_DRAFT">("MANUAL");
  const [plannerDraftGroups, setPlannerDraftGroups] = useState<ScheduleDraftGroup[]>([]);
  const [plannerActiveDraft, setPlannerActiveDraft] = useState<ScheduleDraftDetails | null>(null);
  const [plannerAIDraftShiftMaps, setPlannerAIDraftShiftMaps] = useState<
    Record<string, Record<string, WeekShiftMap>>
  >({});
  const [plannerDraftLoading, setPlannerDraftLoading] = useState(false);
  const [plannerAiSchedulingEnabled, setPlannerAiSchedulingEnabled] = useState(false);
  const [plannerAiSchedulingChatEnabled, setPlannerAiSchedulingChatEnabled] = useState(false);
  const [plannerDraftError, setPlannerDraftError] = useState<string | null>(null);
  const [plannerDepartments, setPlannerDepartments] = useState<PlannerDepartmentOption[]>([]);
  const [plannerScheduleWeekOptions, setPlannerScheduleWeekOptions] = useState<
    Array<{ weekStart: string; isAssigned: boolean; unassignedCount: number }>
  >([]);
  const [plannerReferenceWeekOptions, setPlannerReferenceWeekOptions] = useState<
    Array<{ weekStart: string; isAssigned: boolean; unassignedCount: number }>
  >([]);
  const [plannerLoading, setPlannerLoading] = useState(false);
  const [plannerSaving, setPlannerSaving] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);

  const [overrideEmployeeId, setOverrideEmployeeId] = useState("");
  const [overrideShiftId, setOverrideShiftId] = useState<string>("");
  const [overrideDate, setOverrideDate] = useState("");
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const overrideSource = "MANUAL";
  const [overrideIsRange, setOverrideIsRange] = useState(false);
  const [overrideEndDate, setOverrideEndDate] = useState<string | null>(null);
  const [editingOverride, setEditingOverride] = useState<OverrideRow | null>(null);
  const [overrideEditOpen, setOverrideEditOpen] = useState(false);
  const [overridePickerOpen, setOverridePickerOpen] = useState(false);

  const [shiftCode, setShiftCode] = useState("");
  const [shiftName, setShiftName] = useState("");
  const [shiftColorHex, setShiftColorHex] = useState("");
  const [shiftIsDayOff, setShiftIsDayOff] = useState(false);
  const [shiftStart, setShiftStart] = useState("09:00");
  const [shiftEnd, setShiftEnd] = useState("18:00");
  const [shiftSpansMidnight, setShiftSpansMidnight] = useState(false);
  const [shiftBreakStart, setShiftBreakStart] = useState("");
  const [shiftBreakEnd, setShiftBreakEnd] = useState("");
  const [shiftNotes, setShiftNotes] = useState("");
  const [shiftSaving, setShiftSaving] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);

  const [editingShiftId, setEditingShiftId] = useState<number | null>(null);
  const [shiftEdit, setShiftEdit] = useState<ShiftEditState | null>(null);
  const [shiftEditSaving, setShiftEditSaving] = useState(false);
  const [shiftEditError, setShiftEditError] = useState<string | null>(null);

  const showSchedule = mode === "full";
  const showOverrideForm = mode !== "patterns";
  const showOverrideTables = mode !== "patterns";
  const showShifts = mode === "full";
  const showWeekPlanner = mode === "patterns";
  const hasDayOffShift = useMemo(
    () => shifts.some((shift) => shift.isDayOff),
    [shifts],
  );

  const countDays = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    const diff = Math.floor((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
    return diff >= 0 ? diff + 1 : 0;
  };

  const overrideDaysCount =
    overrideIsRange && overrideEndDate ? countDays(overrideDate, overrideEndDate) : 1;

  const selectedRange: DateRange = {
    from: makeDate(overrideDate),
    to: makeDate(overrideEndDate),
  };

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      setShiftEditError(null);
      const [scheduleResult, overrideResult] = await Promise.all([
        getScheduleSnapshot(date),
        listScheduleOverrides({ start: date }),
      ]);
      if (!scheduleResult.success) {
        throw new Error(scheduleResult.error || "Failed to load schedule");
      }
      if (!overrideResult.success) {
        throw new Error(overrideResult.error || "Failed to load overrides");
      }

      setEntries(
        ((scheduleResult.schedule ?? []) as Array<ScheduleEntry & { shift?: ShiftLite | null }>).map(
          (entry) => ({
            ...entry,
            shift: entry.shift ? normalizeShift(entry.shift) : null,
          }),
        ),
      );
      setShifts((scheduleResult.shifts ?? []).map(normalizeShift));
      setOverrides((overrideResult.data ?? []).map(normalizeOverride));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedule");
    } finally {
      setLoading(false);
    }
  };

  const loadPlanner = async () => {
    if (!showWeekPlanner) return;
    try {
      setPlannerLoading(true);
      setPlannerError(null);
      const result = await getWeekPlannerSnapshot({
        weekStart: plannerWeekStart,
        compareWeekStart: plannerCompareWeekStart,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to load week planner snapshot");
      }
      const snapshot = normalizeWeekPlannerSnapshot(result.data);
      setPlannerRowCacheByWeek((prev) => ({
        ...prev,
        [plannerWeekStart]: Object.fromEntries(
          snapshot.rows.map((row) => [row.employee.employeeId, row] as const),
        ),
      }));
      setPlannerDepartments(snapshot.departments);
      setShifts(snapshot.shifts);
      setPlannerScheduleWeekOptions(snapshot.scheduleWeekOptions);
      setPlannerReferenceWeekOptions(snapshot.referenceWeekOptions);

      const featureResult = await getSchedulePolicyFeatureAvailability();
      const aiEnabled = featureResult.success && featureResult.enabled;
      setPlannerAiSchedulingEnabled(aiEnabled);
      setPlannerAiSchedulingChatEnabled(aiEnabled && featureResult.success && featureResult.chatEnabled);
      if (!aiEnabled) {
        setPlannerAiSchedulingChatEnabled(false);
        setPlannerDraftGroups([]);
        setPlannerActiveDraft(null);
        setPlannerMode("MANUAL");
      } else {
        setPlannerDraftLoading(true);
        setPlannerDraftError(null);
        const draftResult = await listScheduleDraftsForWeek({ weekStart: plannerWeekStart });
        if (!draftResult.success) {
          setPlannerDraftError(draftResult.error || "Draft storage is unavailable.");
          setPlannerDraftGroups([]);
          setPlannerActiveDraft(null);
        } else {
          setPlannerDraftGroups(draftResult.data);
          const activeStillExists = plannerActiveDraft?.weekStart === plannerWeekStart &&
            draftResult.data.some((group) => group.versions.some((version) => version.id === plannerActiveDraft.id));
          if (!activeStillExists) {
            const latest = draftResult.data[0]?.latest;
            if (latest) {
              const latestResult = await getScheduleDraftVersion({ draftId: latest.id });
              if (latestResult.success) setActivePlannerDraft(latestResult.data);
              else setPlannerDraftError(latestResult.error || "Failed to restore saved draft");
            } else {
              setPlannerActiveDraft(null);
            }
          }
        }
      }
    } catch (err) {
      setPlannerError(err instanceof Error ? err.message : "Failed to load week planner");
    } finally {
      setPlannerDraftLoading(false);
      setPlannerLoading(false);
    }
  };

  useEffect(() => {
    if (mode !== "patterns") {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    void loadPlanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWeekPlanner, plannerWeekStart, plannerCompareWeekStart]);

  const employees = useMemo(() => entries.map((entry) => entry.employee), [entries]);
  const shiftsById = useMemo(
    () => new Map(shifts.map((shift) => [shift.id, shift] as const)),
    [shifts],
  );
  const currentWeekRowCache = useMemo(
    () => plannerRowCacheByWeek[plannerWeekStart] ?? {},
    [plannerRowCacheByWeek, plannerWeekStart],
  );
  const currentWeekDraftShiftMap = useMemo(
    () => plannerDraftShiftMapByWeek[plannerWeekStart] ?? {},
    [plannerDraftShiftMapByWeek, plannerWeekStart],
  );
  const currentWeekAIDraft =
    plannerActiveDraft?.weekStart === plannerWeekStart ? plannerActiveDraft : null;
  const currentWeekAIDraftShiftMap = useMemo(
    () => currentWeekAIDraft
      ? plannerAIDraftShiftMaps[currentWeekAIDraft.id] ?? {}
      : {},
    [currentWeekAIDraft, plannerAIDraftShiftMaps],
  );
  const aiDraftDirty = currentWeekAIDraft
    ? !sameDraftAssignments(
        currentWeekAIDraft,
        currentWeekAIDraftShiftMap,
        shiftsById,
      )
    : false;
  const plannerDirty = plannerMode === "AI_DRAFT"
    ? aiDraftDirty
    : Object.keys(currentWeekDraftShiftMap).length > 0;

  const plannerAllRows = useMemo(
    () =>
      Object.values(currentWeekRowCache)
        .map((baseRow) => {
          const draftShiftMap = plannerMode === "AI_DRAFT"
            ? currentWeekAIDraftShiftMap[baseRow.employee.employeeId]
            : currentWeekDraftShiftMap[baseRow.employee.employeeId];
          const nextRow = draftShiftMap ? applyWeekPlannerShiftMap(baseRow, draftShiftMap) : baseRow;
          return hydrateWeekPlannerRowShifts(nextRow, shiftsById);
        })
        .sort((left, right) => {
          const lastCmp = left.employee.lastName.localeCompare(right.employee.lastName);
          return lastCmp !== 0 ? lastCmp : left.employee.firstName.localeCompare(right.employee.firstName);
        }),
    [currentWeekAIDraftShiftMap, currentWeekDraftShiftMap, currentWeekRowCache, plannerMode, shiftsById],
  );

  const plannerDepartmentRows = useMemo(() => {
    if (!plannerDepartmentId) return plannerAllRows;
    return plannerAllRows.filter(
      (row) => (row.employee.department?.departmentId ?? "") === plannerDepartmentId,
    );
  }, [plannerAllRows, plannerDepartmentId]);

  const plannerSearchText = plannerEmployeeSearch.trim().toLowerCase();
  const plannerVisibleRows = useMemo(
    () =>
      plannerDepartmentRows.filter((row) => {
        if (
          plannerSelectedEmployeeIds.length > 0 &&
          !plannerSelectedEmployeeIds.includes(row.employee.employeeId)
        ) {
          return false;
        }
        if (!plannerSearchText) return true;
        const haystack = [
          row.employee.firstName,
          row.employee.lastName,
          row.employee.employeeCode,
          row.employee.position?.name ?? "",
          row.employee.department?.name ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(plannerSearchText);
      }),
    [plannerDepartmentRows, plannerSearchText, plannerSelectedEmployeeIds],
  );
  const plannerUnassignedEditableCount = useMemo(
    () => countWeekPlannerUnassignedDays(plannerAllRows),
    [plannerAllRows],
  );

  const selectedDayKey = date;
  const overrideDayKey = (value: string) =>
    new Date(value).toLocaleDateString("en-CA", { timeZone: TZ });

  const overridesForDay = useMemo(
    () => overrides.filter((o) => overrideDayKey(o.workDate) === selectedDayKey),
    [overrides, selectedDayKey],
  );
  const upcomingOverrides = useMemo(
    () => overrides.filter((o) => overrideDayKey(o.workDate) > selectedDayKey),
    [overrides, selectedDayKey],
  );

  const startShiftEdit = (shift: ShiftLite) => {
    setEditingShiftId(shift.id);
    setShiftEdit({
      code: shift.code,
      name: shift.name,
      colorHex: shift.colorHex ?? "",
      isDayOff: Boolean(shift.isDayOff),
      startTime: minutesToTimeInput(shift.startMinutes),
      endTime: minutesToTimeInput(shift.endMinutes),
      spansMidnight: Boolean(shift.spansMidnight),
      breakStartTime:
        shift.breakStartMinutes != null ? minutesToTimeInput(shift.breakStartMinutes) : "",
      breakEndTime:
        shift.breakEndMinutes != null ? minutesToTimeInput(shift.breakEndMinutes) : "",
      notes: shift.notes ?? "",
    });
    setShiftEditError(null);
  };

  const cancelShiftEdit = () => {
    setEditingShiftId(null);
    setShiftEdit(null);
    setShiftEditError(null);
  };

  const saveShiftEdit = async () => {
    if (!editingShiftId || !shiftEdit) return;
    try {
      setShiftEditSaving(true);
      setShiftEditError(null);
      const result = await updateShift({
        id: editingShiftId,
        code: shiftEdit.code,
        name: shiftEdit.name,
        colorHex: shiftEdit.colorHex,
        isDayOff: shiftEdit.isDayOff,
        startTime: shiftEdit.startTime,
        endTime: shiftEdit.endTime,
        spansMidnight: shiftEdit.spansMidnight,
        breakStartTime: shiftEdit.breakStartTime ?? null,
        breakEndTime: shiftEdit.breakEndTime ?? null,
        notes: shiftEdit.notes,
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to update shift");
      }
      cancelShiftEdit();
      await load();
      toast.success("Shift updated.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update shift";
      setShiftEditError(message);
      toast.error("Failed to update shift.", { description: message });
    } finally {
      setShiftEditSaving(false);
    }
  };

  const handleOverride = async () => {
    if (!overrideEmployeeId) {
      setOverrideError("Employee is required");
      return false;
    }
    if (!overrideDate) {
      setOverrideError("Start date is required");
      return false;
    }
    if (overrideIsRange && !overrideEndDate) {
      setOverrideError("End date is required for a range");
      return false;
    }
    if (overrideIsRange && overrideEndDate && new Date(overrideEndDate) < new Date(overrideDate)) {
      setOverrideError("End date must be on or after start date");
      return false;
    }
    try {
      setOverrideSaving(true);
      setOverrideError(null);
      const dates: string[] = (() => {
        if (!overrideIsRange || !overrideEndDate) return [overrideDate];
        const start = new Date(overrideDate);
        const end = new Date(overrideEndDate);
        const days: string[] = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          days.push(d.toISOString().slice(0, 10));
        }
        return days;
      })();

      for (const day of dates) {
        const result = await upsertScheduleOverride({
          employeeId: overrideEmployeeId,
          shiftId: overrideShiftId ? Number(overrideShiftId) : null,
          workDate: day,
          source: overrideSource,
        });
        if (!result.success) {
          throw new Error(result.error || `Failed to save override for ${day}`);
        }
      }

      await load();
      setOverrideEmployeeId("");
      setOverrideShiftId("");
      setOverrideDate("");
      setOverrideEndDate(null);
      setOverrideIsRange(false);
      toast.success("Override saved.", {
        description: dates.length > 1 ? `${dates.length} dates updated.` : "Selected date updated.",
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save override";
      setOverrideError(message);
      toast.error("Failed to save override.", { description: message });
      return false;
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleCreateShift = async () => {
    if (!shiftIsDayOff && (!shiftCode.trim() || !shiftName.trim())) {
      setShiftError("Code and name are required");
      return;
    }
    try {
      setShiftSaving(true);
      setShiftError(null);
      const result = await createShift({
        code: shiftCode,
        name: shiftName,
        colorHex: shiftColorHex,
        isDayOff: shiftIsDayOff,
        startTime: shiftStart,
        endTime: shiftEnd,
        spansMidnight: shiftSpansMidnight,
        breakStartTime: shiftBreakStart || null,
        breakEndTime: shiftBreakEnd || null,
        notes: shiftNotes,
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to create shift");
      }
      setShiftCode("");
      setShiftName("");
      setShiftColorHex("");
      setShiftIsDayOff(false);
      setShiftStart("09:00");
      setShiftEnd("18:00");
      setShiftSpansMidnight(false);
      setShiftBreakStart("");
      setShiftBreakEnd("");
      setShiftNotes("");
      await load();
      if (showWeekPlanner) {
        await loadPlanner();
      }
      toast.success("Shift created.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create shift";
      setShiftError(message);
      toast.error("Failed to create shift.", { description: message });
    } finally {
      setShiftSaving(false);
    }
  };

  const handleRangeSelect = (value?: DateRange) => {
    if (!value) {
      setOverrideDate("");
      setOverrideEndDate(null);
      setOverrideIsRange(false);
      return;
    }
    if (value.from) {
      setOverrideDate(value.from.toLocaleDateString("en-CA", { timeZone: TZ }));
    }
    if (value.to) {
      setOverrideEndDate(value.to.toLocaleDateString("en-CA", { timeZone: TZ }));
      setOverrideIsRange(true);
    } else {
      setOverrideEndDate(null);
      setOverrideIsRange(false);
    }
  };

  const clearOverrideSelection = () => {
    setOverrideDate("");
    setOverrideEndDate(null);
    setOverrideIsRange(false);
  };

  const startOverrideEdit = (o: OverrideRow) => {
    setOverrideEmployeeId(o.employee.employeeId);
    setOverrideShiftId(o.shift ? String(o.shift.id) : "");
    setOverrideDate(toDateInputValue(o.workDate));
    setOverrideIsRange(false);
    setOverrideEndDate(null);
    setEditingOverride(o);
    setOverrideEditOpen(true);
  };

  const deleteOverride = async (id: string) => {
    const result = await deleteScheduleOverride(id);
    if (!result.success) {
      const message = result.error || "Failed to delete override";
      setOverrideError(message);
      toast.error("Failed to delete override.", { description: message });
      return;
    }
    await load();
    toast.success("Override deleted.");
  };

  const handleShiftFormChange = (field: string, value: string | number | boolean) => {
    switch (field) {
      case "code":
        setShiftCode(String(value));
        break;
      case "name":
        setShiftName(String(value));
        break;
      case "colorHex":
        setShiftColorHex(String(value));
        break;
      case "isDayOff": {
        const checked = Boolean(value);
        setShiftIsDayOff(checked);
        if (checked) {
          setShiftStart("00:00");
          setShiftEnd("00:00");
          setShiftBreakStart("");
          setShiftBreakEnd("");
          setShiftSpansMidnight(false);
          if (!shiftCode.trim()) setShiftCode("OFF");
          if (!shiftName.trim()) setShiftName("Day Off");
        }
        break;
      }
      case "start":
        setShiftStart(String(value));
        break;
      case "end":
        setShiftEnd(String(value));
        break;
      case "breakStart":
        setShiftBreakStart(String(value));
        break;
      case "breakEnd":
        setShiftBreakEnd(String(value));
        break;
      case "spansMidnight":
        setShiftSpansMidnight(Boolean(value));
        break;
      case "notes":
        setShiftNotes(String(value));
        break;
      default:
        break;
    }
  };

  const setPlannerDraftsForCurrentWeek = (
    updater: (drafts: Record<string, WeekShiftMap>) => Record<string, WeekShiftMap>,
  ) => {
    setPlannerDraftShiftMapByWeek((prev) => ({
      ...prev,
      [plannerWeekStart]: updater(prev[plannerWeekStart] ?? {}),
    }));
  };

  const setActivePlannerDraft = (draft: ScheduleDraftDetails) => {
    setPlannerActiveDraft(draft);
    setPlannerDepartmentId(draft.scope.departmentId ?? "");
    setPlannerSelectedEmployeeIds(
      draft.scope.selectionMode === "SELECTED" ? draft.scope.employeeIds : [],
    );
    setPlannerAIDraftShiftMaps((previous) => ({
      ...previous,
      [draft.id]: draftAssignmentsToShiftMaps(draft.assignments),
    }));
    setPlannerMode("AI_DRAFT");
    setPlannerDraftError(null);
  };

  const handlePlannerDraftSelect = async (draftId: string) => {
    if (!draftId) {
      setPlannerActiveDraft(null);
      return;
    }
    try {
      setPlannerDraftLoading(true);
      setPlannerDraftError(null);
      const result = await getScheduleDraftVersion({ draftId });
      if (!result.success) throw new Error(result.error || "Failed to load draft version");
      setActivePlannerDraft(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load draft version";
      setPlannerDraftError(message);
      toast.error("Failed to load draft.", { description: message });
    } finally {
      setPlannerDraftLoading(false);
    }
  };

  const handlePlannerDraftCreate = async (sourceMode: "CURRENT_SCHEDULE" | "REFERENCE_WEEK" | "EMPTY") => {
    try {
      setPlannerSaving(true);
      setPlannerDraftError(null);
      const result = await createScheduleDraft({
        requestKey: globalThis.crypto.randomUUID(),
        weekStart: plannerWeekStart,
        referenceWeekStart: sourceMode === "REFERENCE_WEEK" ? plannerCompareWeekStart : null,
        departmentId: plannerDepartmentId || null,
        selectedEmployeeIds: plannerSelectedEmployeeIds,
        sourceMode,
      });
      if (!result.success) throw new Error(result.error || "Failed to create draft");
      setActivePlannerDraft(result.data);
      const listResult = await listScheduleDraftsForWeek({ weekStart: plannerWeekStart });
      if (listResult.success) setPlannerDraftGroups(listResult.data);
      toast.success("Draft created.", {
        description: `Draft v${result.data.version} is saved separately from live schedules.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create draft";
      setPlannerDraftError(message);
      toast.error("Failed to create draft.", { description: message });
    } finally {
      setPlannerSaving(false);
    }
  };

  const handlePlannerDraftSave = async () => {
    if (!currentWeekAIDraft) return;
    const shiftMaps = currentWeekAIDraftShiftMap;
    try {
      setPlannerSaving(true);
      setPlannerDraftError(null);
      const assignments = currentWeekAIDraft.assignments.map((assignment) => {
        const dayKey = getDraftDayKey(assignment.workDate);
        const liveRow = currentWeekRowCache[assignment.employeeId];
        const day = liveRow?.days[dayKey];
        const shiftId = day?.leave
          ? assignment.baselineShiftId
          : shiftMaps[assignment.employeeId]?.[dayKey] ?? assignment.shiftId;
        const assignmentKind = day?.leave
          ? "PROTECTED_LEAVE"
          : shiftId == null
            ? "UNASSIGNED"
            : shiftsById.get(shiftId)?.isDayOff
              ? "DAY_OFF"
              : "WORK";
        return { ...assignment, shiftId, assignmentKind };
      });
      const result = await saveScheduleDraftVersion({
        requestKey: globalThis.crypto.randomUUID(),
        draftId: currentWeekAIDraft.id,
        assignments,
      });
      if (!result.success) throw new Error(result.error || "Failed to save draft");
      setActivePlannerDraft(result.data);
      const listResult = await listScheduleDraftsForWeek({ weekStart: plannerWeekStart });
      if (listResult.success) setPlannerDraftGroups(listResult.data);
      toast.success("Draft version saved.", {
        description: `Saved draft v${result.data.version}. Live schedules were not changed.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save draft";
      setPlannerDraftError(message);
      toast.error("Failed to save draft.", { description: message });
    } finally {
      setPlannerSaving(false);
    }
  };

  const handlePlannerDraftGenerated = async (draft: ScheduleDraftDetails) => {
    setActivePlannerDraft(draft);
    const listResult = await listScheduleDraftsForWeek({ weekStart: plannerWeekStart });
    if (listResult.success) setPlannerDraftGroups(listResult.data);
  };

  const handlePlannerDraftDiscard = async () => {
    if (!currentWeekAIDraft) return;
    try {
      setPlannerSaving(true);
      setPlannerDraftError(null);
      const result = await discardScheduleDraft({ draftId: currentWeekAIDraft.id });
      if (!result.success) throw new Error(result.error || "Failed to discard draft");
      setPlannerActiveDraft(null);
      setPlannerAIDraftShiftMaps((previous) => {
        const next = { ...previous };
        delete next[currentWeekAIDraft.id];
        return next;
      });
      const listResult = await listScheduleDraftsForWeek({ weekStart: plannerWeekStart });
      if (listResult.success) setPlannerDraftGroups(listResult.data);
      toast.success("Draft discarded.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to discard draft";
      setPlannerDraftError(message);
      toast.error("Failed to discard draft.", { description: message });
    } finally {
      setPlannerSaving(false);
    }
  };

  const handlePlannerModeChange = (mode: "MANUAL" | "AI_DRAFT") => {
    setPlannerMode(mode);
    if (mode === "AI_DRAFT" && !currentWeekAIDraft) {
      const latestDraft = plannerDraftGroups[0]?.latest;
      if (latestDraft) void handlePlannerDraftSelect(latestDraft.id);
    }
  };

  const applyPlannerShiftMaps = (
    employeeShiftMaps: Array<{ employeeId: string; shiftMap: WeekShiftMap }>,
  ) => {
    if (plannerMode === "AI_DRAFT") {
      if (
        !currentWeekAIDraft ||
        !currentWeekAIDraft.isLatestVersion ||
        currentWeekAIDraft.status === "PUBLISHED" ||
        currentWeekAIDraft.status === "DISCARDED"
      ) {
        return;
      }
      setPlannerAIDraftShiftMaps((previous) => {
        const next = { ...previous };
        const draftMap = { ...(previous[currentWeekAIDraft.id] ?? draftAssignmentsToShiftMaps(currentWeekAIDraft.assignments)) };
        for (const { employeeId, shiftMap } of employeeShiftMaps) {
          draftMap[employeeId] = shiftMap;
        }
        next[currentWeekAIDraft.id] = draftMap;
        return next;
      });
      return;
    }

    setPlannerDraftsForCurrentWeek((drafts) => {
      const nextDrafts = { ...drafts };

      for (const { employeeId, shiftMap } of employeeShiftMaps) {
        const baseRow = currentWeekRowCache[employeeId];
        if (!baseRow) continue;
        const baseShiftMap = weekPlannerRowToShiftMap(baseRow);
        if (areWeekShiftMapsEqual(baseShiftMap, shiftMap)) {
          delete nextDrafts[employeeId];
          continue;
        }
        nextDrafts[employeeId] = shiftMap;
      }

      return nextDrafts;
    });
  };

  const reloadPlannerFromServer = async () => {
    if (plannerMode === "AI_DRAFT" && currentWeekAIDraft) {
      const result = await getScheduleDraftVersion({ draftId: currentWeekAIDraft.id });
      if (result.success) setActivePlannerDraft(result.data);
      else setPlannerDraftError(result.error || "Failed to reload draft");
    } else {
      setPlannerDraftShiftMapByWeek((prev) => {
        const next = { ...prev };
        delete next[plannerWeekStart];
        return next;
      });
    }
    await loadPlanner();
  };

  const handlePlannerShiftChange = (
    employeeId: string,
    dayKey: WeekPlannerDayKey,
    shiftId: number | null,
  ) => {
    const row = plannerAllRows.find((entry) => entry.employee.employeeId === employeeId);
    if (!row) return;
    if (!isWeekPlannerDayEditable(row.days[dayKey])) return;
    const nextShiftMap = {
      ...weekPlannerRowToShiftMap(row),
      [dayKey]: shiftId,
    };
    applyPlannerShiftMaps([{ employeeId, shiftMap: nextShiftMap }]);
  };

  const handlePlannerCopyPreviousWeek = (employeeIds?: string[]) => {
    const scopedRows = employeeIds?.length
      ? plannerVisibleRows.filter((row) => employeeIds.includes(row.employee.employeeId))
      : plannerVisibleRows;
    applyPlannerShiftMaps(
      scopedRows.map((row) => ({
        employeeId: row.employee.employeeId,
        shiftMap: weekPlannerDayKeys.reduce(
          (acc, dayKey) => {
            acc[dayKey] = isWeekPlannerDayEditable(row.days[dayKey])
              ? row.days[dayKey].compareShiftId ?? null
              : row.days[dayKey].shiftId ?? null;
            return acc;
          },
          {} as WeekShiftMap,
        ),
      })),
    );
  };

  const handlePlannerSwapPreviousWeek = (
    pairs: WeekPlannerAlternatePair[],
    employeeIds?: string[],
  ) => {
    const invalidPair = pairs.find(
      (pair) =>
        !shiftsById.has(pair.leftShiftId) ||
        !shiftsById.has(pair.rightShiftId),
    );
    if (invalidPair) {
      setPlannerError("Alternate picker contains archived or missing shifts");
      return;
    }
    const scopedRows = employeeIds?.length
      ? plannerVisibleRows.filter((row) => employeeIds.includes(row.employee.employeeId))
      : plannerVisibleRows;
    applyPlannerShiftMaps(
      scopedRows.map((row) => ({
        employeeId: row.employee.employeeId,
        shiftMap: weekPlannerDayKeys.reduce(
          (acc, dayKey) => {
            if (!isWeekPlannerDayEditable(row.days[dayKey])) {
              acc[dayKey] = row.days[dayKey].shiftId ?? null;
              return acc;
            }
            const currentShiftId = row.days[dayKey].shiftId ?? null;
            const matchedPair = pairs.find(
              (pair) =>
                pair.leftShiftId === currentShiftId ||
                pair.rightShiftId === currentShiftId,
            );
            acc[dayKey] = matchedPair
              ? matchedPair.leftShiftId === currentShiftId
                ? matchedPair.rightShiftId
                : matchedPair.leftShiftId
              : currentShiftId;
            return acc;
          },
          {} as WeekShiftMap,
        ),
      })),
    );
  };

  const handlePlannerClearWeek = (employeeIds?: string[]) => {
    const scopedRows = employeeIds?.length
      ? plannerVisibleRows.filter((row) => employeeIds.includes(row.employee.employeeId))
      : plannerVisibleRows;
    applyPlannerShiftMaps(
      scopedRows.map((row) => ({
        employeeId: row.employee.employeeId,
        shiftMap: weekPlannerDayKeys.reduce(
          (acc, dayKey) => {
            acc[dayKey] = isWeekPlannerDayEditable(row.days[dayKey])
              ? null
              : row.days[dayKey].shiftId ?? null;
            return acc;
          },
          {} as WeekShiftMap,
        ),
      })),
    );
  };

  const handlePlannerDayOffTool = (input: WeekPlannerDayOffToolInput) => {
    const dayOffShift = shifts.find((shift) => shift.isDayOff) ?? null;
    if (!dayOffShift) {
      setPlannerError("Create a Day Off shift first");
      return;
    }

    const targetedDayKeys = input.dayKeys.filter(
      (dayKey) => (input.employeeIdsByDay[dayKey] ?? []).length > 0,
    );
    const targetedEmployeeIds = Array.from(
      new Set(
        Object.values(input.employeeIdsByDay)
          .flatMap((employeeIds) => employeeIds ?? [])
          .filter(Boolean),
      ),
    );

    if (targetedEmployeeIds.length === 0) {
      setPlannerError("Pick at least one employee for a selected day");
      return;
    }
    if (input.mode !== "clearAllOff" && targetedDayKeys.length === 0) {
      setPlannerError("Pick at least one employee for a selected day");
      return;
    }

    applyPlannerShiftMaps(
      plannerAllRows
        .filter((row) => targetedEmployeeIds.includes(row.employee.employeeId))
        .map((row) => ({
        employeeId: row.employee.employeeId,
        shiftMap: weekPlannerDayKeys.reduce(
          (acc, dayKey) => {
            const currentShiftId = row.days[dayKey].shiftId ?? null;
            const currentShift = currentShiftId != null ? shiftsById.get(currentShiftId) ?? null : null;
            const employeeIdsForDay = input.employeeIdsByDay[dayKey] ?? [];
            const employeeSelectedForDay = employeeIdsForDay.includes(row.employee.employeeId);
            const employeeSelectedForAnyDay = targetedEmployeeIds.includes(row.employee.employeeId);
            if (
              !isWeekPlannerDayEditable(row.days[dayKey])
            ) {
              acc[dayKey] = currentShiftId;
              return acc;
            }

            if (input.mode === "clearAllOff") {
              acc[dayKey] =
                employeeSelectedForAnyDay && currentShift?.isDayOff ? null : currentShiftId;
              return acc;
            }

            if (!targetedDayKeys.includes(dayKey)) {
              if (
                input.mode === "assignOff" &&
                input.replaceExistingOff &&
                employeeSelectedForAnyDay &&
                currentShift?.isDayOff
              ) {
                acc[dayKey] = null;
                return acc;
              }
              acc[dayKey] = currentShiftId;
              return acc;
            }

            if (!employeeSelectedForDay) {
              if (
                input.mode === "assignOff" &&
                input.replaceExistingOff &&
                employeeSelectedForAnyDay &&
                currentShift?.isDayOff
              ) {
                acc[dayKey] = null;
                return acc;
              }
              acc[dayKey] = currentShiftId;
              return acc;
            }

            acc[dayKey] =
              input.mode === "assignOff"
                ? dayOffShift.id
                : currentShift?.isDayOff
                  ? null
                  : currentShiftId;
            return acc;
          },
          {} as WeekShiftMap,
        ),
      })),
    );
  };

  const handlePlannerBulkAction = (input: WeekPlannerBulkActionInput) => {
    const matchesPositionFilter = (row: WeekPlannerRow, positionNames: string[] | null | undefined) => {
      if (!positionNames?.length) return true;
      const rowPositionName = (row.employee.position?.name ?? "").trim();
      return positionNames.includes(rowPositionName);
    };

    const scopeRows = plannerDepartmentRows.filter((row) => {
      if (input.employeeIds?.length && !input.employeeIds.includes(row.employee.employeeId)) {
        return false;
      }
      if (input.mode === "positionAllocate") return true;
      return matchesPositionFilter(row, input.positionNames);
    });

    if (scopeRows.length === 0) {
      setPlannerError("No employees matched bulk filter");
      return;
    }

    const rowOrder = new Map(
      scopeRows.map((row, index) => [row.employee.employeeId, index] as const),
    );
    const nextMapsByEmployeeId = new Map<string, WeekShiftMap>(
      scopeRows.map((row) => [row.employee.employeeId, { ...weekPlannerRowToShiftMap(row) }]),
    );

    const getShiftIdForRowDay = (row: WeekPlannerRow, dayKey: WeekPlannerDayKey) =>
      nextMapsByEmployeeId.get(row.employee.employeeId)?.[dayKey] ?? null;

    const countAssignedWorkDays = (row: WeekPlannerRow) =>
      weekPlannerDayKeys.reduce((count, dayKey) => {
        const shiftId = getShiftIdForRowDay(row, dayKey);
        const shift = shiftId != null ? shiftsById.get(shiftId) ?? null : null;
        return count + (shift && !shift.isDayOff ? 1 : 0);
      }, 0);

    const matchesBulkTarget = (
      shiftId: number | null,
      targetMode: "bucket" | "shift",
      targetShiftId: number | null,
      targetBucket: "morning" | "afternoon" | "other" | null,
    ) => {
      if (shiftId == null) return false;
      const shift = shiftsById.get(shiftId) ?? null;
      if (!shift || shift.isDayOff) return false;
      if (targetMode === "shift") {
        return shiftId === targetShiftId;
      }
      return targetBucket != null ? getPlannerBucket(shift) === targetBucket : false;
    };

    const countTargetMatches = (
      row: WeekPlannerRow,
      targetMode: "bucket" | "shift",
      targetShiftId: number | null,
      targetBucket: "morning" | "afternoon" | "other" | null,
    ) =>
      weekPlannerDayKeys.reduce(
        (count, dayKey) =>
          count +
          (matchesBulkTarget(
            getShiftIdForRowDay(row, dayKey),
            targetMode,
            targetShiftId,
            targetBucket,
          )
            ? 1
            : 0),
        0,
      );

    const applyHeadcountTarget = (
      rowsToUse: WeekPlannerRow[],
      dayKey: WeekPlannerDayKey,
      targetMode: "bucket" | "shift",
      targetShiftId: number | null,
      targetBucket: "morning" | "afternoon" | "other" | null,
      assignShiftId: number,
      targetCount: number,
    ) => {
      const matchedRows = rowsToUse.filter((row) =>
        isWeekPlannerDayEditable(row.days[dayKey]) &&
        matchesBulkTarget(
          getShiftIdForRowDay(row, dayKey),
          targetMode,
          targetShiftId,
          targetBucket,
        ),
      );

      if (matchedRows.length > targetCount) {
        const removalCandidates = [...matchedRows].sort((left, right) => {
          const categoryDiff =
            countTargetMatches(right, targetMode, targetShiftId, targetBucket) -
            countTargetMatches(left, targetMode, targetShiftId, targetBucket);
          if (categoryDiff !== 0) return categoryDiff;
          const assignmentDiff = countAssignedWorkDays(right) - countAssignedWorkDays(left);
          if (assignmentDiff !== 0) return assignmentDiff;
          return (rowOrder.get(right.employee.employeeId) ?? 0) - (rowOrder.get(left.employee.employeeId) ?? 0);
        });

        for (const row of removalCandidates.slice(targetCount)) {
          const nextMap = nextMapsByEmployeeId.get(row.employee.employeeId);
          if (!nextMap) continue;
          nextMap[dayKey] = null;
        }
      }

      const currentMatchedCount = rowsToUse.filter((row) =>
        isWeekPlannerDayEditable(row.days[dayKey]) &&
        matchesBulkTarget(
          getShiftIdForRowDay(row, dayKey),
          targetMode,
          targetShiftId,
          targetBucket,
        ),
      ).length;

      if (currentMatchedCount < targetCount) {
        const additionCandidates = rowsToUse
          .filter((row) => {
            if (!isWeekPlannerDayEditable(row.days[dayKey])) return false;
            const currentShiftId = getShiftIdForRowDay(row, dayKey);
            return !matchesBulkTarget(currentShiftId, targetMode, targetShiftId, targetBucket);
          })
          .sort((left, right) => {
            const categoryDiff =
              countTargetMatches(left, targetMode, targetShiftId, targetBucket) -
              countTargetMatches(right, targetMode, targetShiftId, targetBucket);
            if (categoryDiff !== 0) return categoryDiff;
            const assignmentDiff = countAssignedWorkDays(left) - countAssignedWorkDays(right);
            if (assignmentDiff !== 0) return assignmentDiff;
            return (rowOrder.get(left.employee.employeeId) ?? 0) - (rowOrder.get(right.employee.employeeId) ?? 0);
          });

        for (const row of additionCandidates.slice(0, targetCount - currentMatchedCount)) {
          const nextMap = nextMapsByEmployeeId.get(row.employee.employeeId);
          if (!nextMap) continue;
          nextMap[dayKey] = assignShiftId;
        }
      }
    };

    if (input.mode === "replace") {
      for (const dayKey of input.dayKeys) {
        for (const row of scopeRows) {
          if (!isWeekPlannerDayEditable(row.days[dayKey])) continue;
          const currentShiftId = getShiftIdForRowDay(row, dayKey);
          const currentShift = currentShiftId != null ? shiftsById.get(currentShiftId) ?? null : null;
          const matchesSource =
            input.sourceMode === "any"
              ? true
              : input.sourceMode === "unassigned"
                ? currentShiftId == null
                : input.sourceMode === "dayOff"
                  ? Boolean(currentShift?.isDayOff)
                  : currentShiftId === input.sourceShiftId;

          if (!matchesSource) continue;
          const nextMap = nextMapsByEmployeeId.get(row.employee.employeeId);
          if (!nextMap) continue;
          nextMap[dayKey] = input.targetShiftId;
        }
      }
    } else if (input.mode === "headcount") {
      const assignShiftId = input.targetMode === "shift" ? input.targetShiftId : input.assignShiftId;
      const assignShift = assignShiftId != null ? shiftsById.get(assignShiftId) ?? null : null;
      if (assignShiftId == null || !assignShift || assignShift.isDayOff) {
        setPlannerError("Headcount mode needs working shift");
        return;
      }

      for (const dayKey of input.dayKeys) {
        applyHeadcountTarget(
          scopeRows,
          dayKey,
          input.targetMode,
          input.targetShiftId,
          input.targetBucket,
          assignShiftId,
          input.targetCount,
        );
      }
    } else {
      const validAllocations = input.allocations.filter(
        (allocation) => allocation.shiftId != null && allocation.targetCount > 0,
      );
      if (validAllocations.length === 0) {
        setPlannerError("Position allocate mode needs at least one position with count and shift");
        return;
      }

      for (const allocation of validAllocations) {
        const assignShift = shiftsById.get(allocation.shiftId!) ?? null;
        if (!assignShift || assignShift.isDayOff) {
          setPlannerError(`Position allocate mode needs working shift for ${allocation.positionName}`);
          return;
        }
      }

      for (const dayKey of input.dayKeys) {
        const allocationsByPosition = new Map<
          string,
          Array<{ shiftId: number; targetCount: number }>
        >();
        for (const allocation of validAllocations) {
          allocationsByPosition.set(allocation.positionName, [
            ...(allocationsByPosition.get(allocation.positionName) ?? []),
            { shiftId: allocation.shiftId!, targetCount: allocation.targetCount },
          ]);
        }

        for (const [positionName, positionAllocations] of allocationsByPosition.entries()) {
          const positionRows = scopeRows.filter(
            (row) => (row.employee.position?.name ?? "").trim() === positionName,
          );
          if (positionRows.length === 0) continue;

          let remainingCapacity = positionRows.length;
          for (const allocation of positionAllocations) {
            const cappedTargetCount = Math.max(
              0,
              Math.min(allocation.targetCount, remainingCapacity),
            );
            if (cappedTargetCount <= 0) continue;

            applyHeadcountTarget(
              positionRows,
              dayKey,
              "shift",
              allocation.shiftId,
              null,
              allocation.shiftId,
              cappedTargetCount,
            );
            remainingCapacity -= cappedTargetCount;
            if (remainingCapacity <= 0) break;
          }
        }
      }
    }

    applyPlannerShiftMaps(
      Array.from(nextMapsByEmployeeId.entries()).map(([employeeId, shiftMap]) => ({
        employeeId,
        shiftMap,
      })),
    );
  };

  const handlePlannerSave = async () => {
    if (plannerMode === "AI_DRAFT") {
      await handlePlannerDraftSave();
      return;
    }

    const dirtyEmployeeIds = Object.keys(currentWeekDraftShiftMap);
    if (dirtyEmployeeIds.length === 0) {
      setPlannerError("No planner changes to save");
      return;
    }

    try {
      setPlannerSaving(true);
      setPlannerError(null);
      const result = await saveWeekPlannerAssignments({
        weekStart: plannerWeekStart,
        rows: dirtyEmployeeIds
          .map((employeeId) => {
            const draftShiftMap = currentWeekDraftShiftMap[employeeId];
            if (!draftShiftMap) return null;
            return {
              employeeId,
              days: {
                mon: draftShiftMap.mon,
                tue: draftShiftMap.tue,
                wed: draftShiftMap.wed,
                thu: draftShiftMap.thu,
                fri: draftShiftMap.fri,
                sat: draftShiftMap.sat,
                sun: draftShiftMap.sun,
              },
            };
          })
          .filter(
            (
              row,
            ): row is {
              employeeId: string;
              days: Record<WeekPlannerDayKey, number | null>;
            } => row != null,
          ),
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to save week planner");
      }
      toast.success("Week saved.", {
        description: `${dirtyEmployeeIds.length} employee schedules updated.`,
      });
      setPlannerDraftShiftMapByWeek((prev) => {
        const next = { ...prev };
        delete next[plannerWeekStart];
        return next;
      });
      await loadPlanner();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save week planner";
      setPlannerError(message);
      toast.error("Failed to save week.", { description: message });
    } finally {
      setPlannerSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {showSchedule && (
        <DailyScheduleCard
          date={date}
          entries={entries}
          loading={loading}
          error={error}
          onDateChange={setDate}
          onReload={load}
        />
      )}

      {showWeekPlanner && (
        <WeekPlannerSection
          weekStart={plannerWeekStart}
          compareWeekStart={plannerCompareWeekStart}
          departmentId={plannerDepartmentId}
          employeeSearch={plannerEmployeeSearch}
          selectedEmployeeIds={plannerSelectedEmployeeIds}
          departments={plannerDepartments}
          scheduleWeekOptions={plannerScheduleWeekOptions}
          referenceWeekOptions={plannerReferenceWeekOptions}
          shifts={shifts}
          rows={plannerVisibleRows}
          summaryRows={plannerDepartmentRows}
          loading={plannerLoading}
          saving={plannerSaving}
          error={plannerError}
          dirty={plannerDirty}
          canSave={plannerMode === "AI_DRAFT"
            ? Boolean(
                currentWeekAIDraft?.isLatestVersion &&
                currentWeekAIDraft.status !== "PUBLISHED" &&
                currentWeekAIDraft.status !== "DISCARDED" &&
                aiDraftDirty,
              )
            : plannerDirty && plannerUnassignedEditableCount === 0}
          unassignedCount={plannerUnassignedEditableCount}
          plannerMode={plannerMode}
          aiSchedulingEnabled={plannerAiSchedulingEnabled}
          aiSchedulingChatEnabled={plannerAiSchedulingChatEnabled}
          draftGroups={plannerDraftGroups}
          activeDraft={currentWeekAIDraft}
          draftLoading={plannerDraftLoading}
          draftError={plannerDraftError}
          onPlannerModeChange={handlePlannerModeChange}
          onDraftVersionChange={handlePlannerDraftSelect}
          onCreateDraft={handlePlannerDraftCreate}
          onDraftGenerated={handlePlannerDraftGenerated}
          onDiscardDraft={handlePlannerDraftDiscard}
          onWeekStartChange={setPlannerWeekStart}
          onCompareWeekStartChange={setPlannerCompareWeekStart}
          onDepartmentChange={setPlannerDepartmentId}
          onEmployeeSearchChange={setPlannerEmployeeSearch}
          onSelectedEmployeeIdsChange={setPlannerSelectedEmployeeIds}
          onRefresh={reloadPlannerFromServer}
          onSave={handlePlannerSave}
          onCopyPreviousWeek={handlePlannerCopyPreviousWeek}
          onSwapPreviousWeek={handlePlannerSwapPreviousWeek}
          onClearWeek={handlePlannerClearWeek}
          onApplyDayOffTool={handlePlannerDayOffTool}
          onChangeShift={handlePlannerShiftChange}
          onApplyBulkAction={handlePlannerBulkAction}
        />
      )}

      <OverridesSection
        showOverrideForm={showOverrideForm}
        showOverrideTables={showOverrideTables}
        employees={employees}
        shifts={shifts}
        overrideEmployeeId={overrideEmployeeId}
        overrideShiftId={overrideShiftId}
        overrideDate={overrideDate}
        overrideEndDate={overrideEndDate}
        overrideIsRange={overrideIsRange}
        overrideError={overrideError}
        overrideSaving={overrideSaving}
        overrideDaysCount={overrideDaysCount}
        selectedRange={selectedRange}
        overridesForDay={overridesForDay}
        upcomingOverrides={upcomingOverrides}
        onRefresh={load}
        overridePickerOpen={overridePickerOpen}
        onOverridePickerOpenChange={setOverridePickerOpen}
        overrideEditOpen={overrideEditOpen}
        onOverrideEditOpenChange={(open) => {
          setOverrideEditOpen(open);
          if (!open) setEditingOverride(null);
        }}
        editingOverride={editingOverride}
        onOverrideEmployeeChange={setOverrideEmployeeId}
        onOverrideShiftChange={setOverrideShiftId}
        onRangeSelect={handleRangeSelect}
        onClearSelection={clearOverrideSelection}
        onOpenCalendar={() => setOverridePickerOpen(true)}
        onSaveOverride={handleOverride}
        onOverrideDateChange={setOverrideDate}
        onStartEditOverride={startOverrideEdit}
        onDeleteOverride={deleteOverride}
      />

      <ShiftsSection
        showShifts={showShifts}
        shifts={shifts}
        shiftEditId={editingShiftId}
        shiftEdit={shiftEdit}
        shiftEditSaving={shiftEditSaving}
        shiftEditError={shiftEditError}
        shiftCode={shiftCode}
        shiftName={shiftName}
        shiftColorHex={shiftColorHex}
        shiftIsDayOff={shiftIsDayOff}
        shiftStart={shiftStart}
        shiftEnd={shiftEnd}
        shiftSpansMidnight={shiftSpansMidnight}
        shiftBreakStart={shiftBreakStart}
        shiftBreakEnd={shiftBreakEnd}
        shiftNotes={shiftNotes}
        shiftSaving={shiftSaving}
        shiftError={shiftError}
        onRefresh={load}
        onStartEdit={startShiftEdit}
        onChangeEdit={(value) => setShiftEdit(value)}
        onSaveEdit={saveShiftEdit}
        onCancelEdit={cancelShiftEdit}
        onDeleteShift={async (id) => {
          const result = await deleteShift(id);
          if (!result.success) {
            const message = result.error || "Failed to archive shift";
            setShiftError(message);
            toast.error("Failed to archive shift.", { description: message });
            return;
          }
          await load();
          if (showWeekPlanner) {
            await loadPlanner();
          }
          toast.success("Shift archived.");
        }}
        onCreateShift={handleCreateShift}
        onChangeField={handleShiftFormChange}
        hasDayOffShift={hasDayOffShift}
      />
    </div>
  );
}

const getPlannerBucket = (shift: ShiftLite) => {
  if (shift.isDayOff) return "other";
  const start = shift.startMinutes;
  const haystack = `${shift.code} ${shift.name}`.toUpperCase();
  if (haystack.includes("AM") || haystack.includes("MORNING")) return "morning";
  if (haystack.includes("PM") || haystack.includes("AFTERNOON")) return "afternoon";
  if (!shift.spansMidnight && start >= 240 && start < 720) return "morning";
  if (!shift.spansMidnight && start >= 720 && start < 1080) return "afternoon";
  return "other";
};
