"use client";

import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PlannerDepartmentOption,
  ShiftLite,
  ShiftBucket,
  WeekPlannerQuickSelectOption,
  WeekPlannerBulkActionInput,
  WeekPlannerAlternatePair,
  WeekPlannerDayOffToolInput,
  WeekPlannerDayKey,
  WeekPlannerRow,
  formatDateDisplay,
  getPlannerShiftBucket,
  weekPlannerDayKeys,
  weekPlannerDayLabel,
} from "@/types/schedule-types";
import type { ScheduleDraftDetails, ScheduleDraftGroup } from "@/types/schedule-draft-types";
import { SchedulePolicyPanel } from "./schedule-policy-panel";
import { ScheduleAssistantPanel } from "./schedule-assistant-panel";
import { CalendarDays, Plus, RefreshCcw, Save, Users, X } from "lucide-react";

type WeekPlannerSectionProps = {
  weekStart: string;
  compareWeekStart: string;
  departmentId: string;
  employeeSearch: string;
  selectedEmployeeIds: string[];
  departments: PlannerDepartmentOption[];
  scheduleWeekOptions: WeekPlannerQuickSelectOption[];
  referenceWeekOptions: WeekPlannerQuickSelectOption[];
  shifts: ShiftLite[];
  rows: WeekPlannerRow[];
  summaryRows: WeekPlannerRow[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  dirty: boolean;
  canSave: boolean;
  unassignedCount: number;
  plannerMode: "MANUAL" | "AI_DRAFT";
  aiSchedulingEnabled: boolean;
  aiSchedulingChatEnabled: boolean;
  draftGroups: ScheduleDraftGroup[];
  activeDraft: ScheduleDraftDetails | null;
  draftLoading: boolean;
  draftError: string | null;
  onPlannerModeChange: (mode: "MANUAL" | "AI_DRAFT") => void;
  onDraftVersionChange: (draftId: string) => void;
  onCreateDraft: (sourceMode: "CURRENT_SCHEDULE" | "REFERENCE_WEEK" | "EMPTY") => void;
  onDraftGenerated: (draft: ScheduleDraftDetails) => void;
  onDiscardDraft: () => void;
  onWeekStartChange: (value: string) => void;
  onCompareWeekStartChange: (value: string) => void;
  onDepartmentChange: (value: string) => void;
  onEmployeeSearchChange: (value: string) => void;
  onSelectedEmployeeIdsChange: (value: string[]) => void;
  onRefresh: () => void;
  onSave: () => void;
  onCopyPreviousWeek: (employeeIds?: string[]) => void;
  onSwapPreviousWeek: (
    pairs: WeekPlannerAlternatePair[],
    employeeIds?: string[],
  ) => void;
  onClearWeek: (employeeIds?: string[]) => void;
  onApplyDayOffTool: (input: WeekPlannerDayOffToolInput) => void;
  onChangeShift: (
    employeeId: string,
    dayKey: WeekPlannerDayKey,
    shiftId: number | null,
  ) => void;
  onApplyBulkAction: (input: WeekPlannerBulkActionInput) => void;
};

const formatShiftCode = (shift: ShiftLite | null | undefined) =>
  shift ? shift.code : "—";

const formatWeekRange = (value: string) => {
  if (!value) return "Pick week";
  const start = new Date(`${value}T12:00:00`);
  if (Number.isNaN(start.getTime())) return "Pick week";
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const sameYear = start.getFullYear() === end.getFullYear();
  const startMonth = start.toLocaleDateString(undefined, { month: "short" });
  const endMonth = end.toLocaleDateString(undefined, { month: "short" });
  if (sameMonth) {
    return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (sameYear) {
    return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()}, ${start.getFullYear()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
};

const getWeekRangeDates = (value: string) => {
  if (!value) return undefined;
  const from = new Date(`${value}T12:00:00`);
  if (Number.isNaN(from.getTime())) return undefined;
  const to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
  return { from, to };
};

const toWeekStartValue = (date: Date) => {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  const weekday = base.getDay();
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  base.setDate(base.getDate() + diffToMonday);
  const year = base.getFullYear();
  const month = `${base.getMonth() + 1}`.padStart(2, "0");
  const day = `${base.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isDateInsideWeekRange = (date: Date, value: string) => {
  const range = getWeekRangeDates(value);
  if (!range?.from || !range?.to) return false;
  const time = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0).getTime();
  return time >= range.from.getTime() && time <= range.to.getTime();
};

const getSelectStyle = (shift: ShiftLite | null | undefined) =>
  shift?.colorHex
    ? {
        borderColor: shift.colorHex,
        backgroundColor: `${shift.colorHex}14`,
        boxShadow: `inset 0 0 0 1px ${shift.colorHex}22`,
      }
    : undefined;

const formatLeaveType = (value: string) =>
  value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const getEmployeeInitials = (row: WeekPlannerRow) =>
  `${row.employee.firstName.charAt(0)}${row.employee.lastName.charAt(0)}`
    .trim()
    .toUpperCase();

const summarizeRowsByDay = (rows: WeekPlannerRow[], shiftsById: Map<number, ShiftLite>) =>
  weekPlannerDayKeys.reduce(
    (acc, dayKey) => {
      const counts = new Map<string, number>();
      let assigned = 0;
      for (const row of rows) {
        if (row.days[dayKey].leave) continue;
        const shiftId = row.days[dayKey].shiftId;
        const shift = shiftId != null ? shiftsById.get(shiftId) ?? null : null;
        if (!shift || shift.isDayOff) continue;
        assigned += 1;
        counts.set(shift.code, (counts.get(shift.code) ?? 0) + 1);
      }
      acc[dayKey] = {
        assigned,
        labels: Array.from(counts.entries())
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([code, count]) => `${code} ${count}`),
      };
      return acc;
    },
    {} as Record<WeekPlannerDayKey, { assigned: number; labels: string[] }>,
  );

const QuickWeekButton = ({
  option,
  active,
  onClick,
}: {
  option: WeekPlannerQuickSelectOption;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
      option.isAssigned
        ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-100"
        : "border-red-500/40 bg-red-500/10 text-red-100"
    } ${active ? "ring-2 ring-primary/40" : ""}`}
  >
    <div className="font-medium">{formatWeekRange(option.weekStart)}</div>
    <div className="text-xs opacity-80">
      {option.isAssigned ? "Assigned" : `${option.unassignedCount} unassigned`}
    </div>
  </button>
);

export function WeekPlannerSection({
  weekStart,
  compareWeekStart,
  departmentId,
  employeeSearch,
  selectedEmployeeIds,
  departments,
  scheduleWeekOptions,
  referenceWeekOptions,
  shifts,
  rows,
  summaryRows,
  loading,
  saving,
  error,
  dirty,
  canSave,
  unassignedCount,
  plannerMode,
  aiSchedulingEnabled,
  aiSchedulingChatEnabled,
  draftGroups,
  activeDraft,
  draftLoading,
  draftError,
  onPlannerModeChange,
  onDraftVersionChange,
  onCreateDraft,
  onDraftGenerated,
  onDiscardDraft,
  onWeekStartChange,
  onCompareWeekStartChange,
  onDepartmentChange,
  onEmployeeSearchChange,
  onSelectedEmployeeIdsChange,
  onRefresh,
  onSave,
  onCopyPreviousWeek,
  onSwapPreviousWeek,
  onClearWeek,
  onApplyDayOffTool,
  onChangeShift,
  onApplyBulkAction,
}: WeekPlannerSectionProps) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [alternateOpen, setAlternateOpen] = useState(false);
  const [dayOffOpen, setDayOffOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [dayOffMode, setDayOffMode] = useState<"assignOff" | "clearOff">("assignOff");
  const [dayOffDayKeys, setDayOffDayKeys] = useState<WeekPlannerDayKey[]>([]);
  const [dayOffSearchByDay, setDayOffSearchByDay] = useState<
    Partial<Record<WeekPlannerDayKey, string>>
  >({});
  const [dayOffEmployeeIdsByDay, setDayOffEmployeeIdsByDay] = useState<
    Partial<Record<WeekPlannerDayKey, string[]>>
  >({});
  const [dayOffReplaceExisting, setDayOffReplaceExisting] = useState(false);
  const [scheduleWeekPickerOpen, setScheduleWeekPickerOpen] = useState(false);
  const [referenceWeekPickerOpen, setReferenceWeekPickerOpen] = useState(false);
  const [activePositionTab, setActivePositionTab] = useState("__all");
  const [bulkMode, setBulkMode] = useState<
    "replace" | "headcount" | "positionAllocate"
  >("replace");
  const [bulkPositionNames, setBulkPositionNames] = useState<string[]>([]);
  const [bulkDayKeys, setBulkDayKeys] = useState<WeekPlannerDayKey[]>([]);
  const [bulkSourceMode, setBulkSourceMode] = useState<
    "any" | "dayOff" | "unassigned" | "shift"
  >("any");
  const [bulkSourceShiftId, setBulkSourceShiftId] = useState<string>("");
  const [bulkTargetShiftId, setBulkTargetShiftId] = useState<string>("");
  const [bulkTargetMode, setBulkTargetMode] = useState<"bucket" | "shift">("bucket");
  const [bulkTargetBucket, setBulkTargetBucket] = useState<ShiftBucket>("morning");
  const [bulkAssignShiftId, setBulkAssignShiftId] = useState<string>("");
  const [bulkHeadcountTargetShiftId, setBulkHeadcountTargetShiftId] = useState<string>("");
  const [bulkTargetCount, setBulkTargetCount] = useState("1");
  const [bulkPositionAllocations, setBulkPositionAllocations] = useState<
    Record<string, Array<{ id: string; shiftId: string; targetCount: string }>>
  >({});
  const [alternatePairs, setAlternatePairs] = useState<
    Array<{ id: string; leftShiftId: string; rightShiftId: string }>
  >([{ id: "0", leftShiftId: "", rightShiftId: "" }]);
  const [alternateError, setAlternateError] = useState<string | null>(null);

  const shiftsById = useMemo(
    () => new Map(shifts.map((shift) => [shift.id, shift] as const)),
    [shifts],
  );
  const dayOffShift = useMemo(
    () => shifts.find((shift) => shift.isDayOff) ?? null,
    [shifts],
  );
  const workingShifts = useMemo(() => shifts.filter((shift) => !shift.isDayOff), [shifts]);
  const exactByDay = useMemo(() => summarizeRowsByDay(summaryRows, shiftsById), [summaryRows, shiftsById]);
  const positionOptions = useMemo(
    () =>
      Array.from(
        new Set(
          summaryRows
            .map((row) => row.employee.position?.name?.trim() ?? "")
            .filter((name) => name.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [summaryRows],
  );
  const employeePickerRows = summaryRows;
  const employeePickerSearchText = pickerSearch.trim().toLowerCase();
  const filteredEmployeePickerRows = useMemo(
    () =>
      employeePickerRows.filter((row) => {
        if (!employeePickerSearchText) return true;
        const haystack = [
          row.employee.firstName,
          row.employee.lastName,
          row.employee.employeeCode,
          row.employee.position?.name ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(employeePickerSearchText);
      }),
    [employeePickerRows, employeePickerSearchText],
  );
  const allFilteredPicked =
    filteredEmployeePickerRows.length > 0 &&
    filteredEmployeePickerRows.every((row) =>
      selectedEmployeeIds.includes(row.employee.employeeId),
    );
  const bulkScopeRows = useMemo(
    () =>
      selectedEmployeeIds.length > 0
        ? summaryRows.filter((row) => selectedEmployeeIds.includes(row.employee.employeeId))
        : summaryRows,
    [selectedEmployeeIds, summaryRows],
  );
  const shiftsForBucket = useMemo(
    () => ({
      morning: workingShifts.filter((shift) => getPlannerShiftBucket(shift) === "morning"),
      afternoon: workingShifts.filter((shift) => getPlannerShiftBucket(shift) === "afternoon"),
      other: workingShifts.filter((shift) => getPlannerShiftBucket(shift) === "other"),
    }),
    [workingShifts],
  );
  const positionSummary = useMemo(() => {
    const groups = new Map<string, WeekPlannerRow[]>();
    for (const row of summaryRows) {
      const key = row.employee.position?.name?.trim() || "Unassigned position";
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return Array.from(groups.entries())
      .map(([positionName, positionRows]) => ({
        positionName,
        active: positionRows.length,
        days: summarizeRowsByDay(positionRows, shiftsById),
      }))
      .sort((left, right) => left.positionName.localeCompare(right.positionName));
  }, [summaryRows, shiftsById]);
  const positionTabs = useMemo(
    () =>
      positionSummary.map((position) => ({
        name: position.positionName,
        count: position.active,
      })),
    [positionSummary],
  );
  const effectivePositionTab =
    activePositionTab === "__all" || positionTabs.some((tab) => tab.name === activePositionTab)
      ? activePositionTab
      : "__all";
  const tableRows = useMemo(
    () =>
      effectivePositionTab === "__all"
        ? rows
        : rows.filter(
            (row) =>
              (row.employee.position?.name?.trim() || "Unassigned position") ===
              effectivePositionTab,
          ),
    [effectivePositionTab, rows],
  );
  const tableEmployeeIds = useMemo(
    () => tableRows.map((row) => row.employee.employeeId),
    [tableRows],
  );
  const dayOffScopeRows = useMemo(() => {
    const scopedIds = selectedEmployeeIds.length > 0 ? selectedEmployeeIds : tableEmployeeIds;
    return summaryRows.filter((row) => scopedIds.includes(row.employee.employeeId));
  }, [selectedEmployeeIds, summaryRows, tableEmployeeIds]);
  const dayOffRowsByEmployeeId = useMemo(
    () => new Map(dayOffScopeRows.map((row) => [row.employee.employeeId, row] as const)),
    [dayOffScopeRows],
  );
  const positionActiveCounts = useMemo(
    () =>
      bulkScopeRows.reduce(
        (acc, row) => {
          const key = row.employee.position?.name?.trim() || "Unassigned position";
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    [bulkScopeRows],
  );
  const selectedShiftById = (shiftId: number | null) =>
    shiftId != null ? shiftsById.get(shiftId) ?? null : null;
  const scheduleWeekRange = getWeekRangeDates(weekStart);
  const referenceWeekRange = getWeekRangeDates(compareWeekStart);

  const toggleBulkDay = (dayKey: WeekPlannerDayKey) => {
    setBulkDayKeys((prev) =>
      prev.includes(dayKey) ? prev.filter((entry) => entry !== dayKey) : [...prev, dayKey],
    );
  };

  const toggleDayOffDay = (dayKey: WeekPlannerDayKey) => {
    setDayOffDayKeys((prev) => {
      const next = prev.includes(dayKey)
        ? prev.filter((entry) => entry !== dayKey)
        : [...prev, dayKey];
      return next;
    });
    setDayOffSearchByDay((prev) => ({
      ...prev,
      [dayKey]: prev[dayKey] ?? "",
    }));
    setDayOffEmployeeIdsByDay((prev) => ({
      ...prev,
      [dayKey]: prev[dayKey] ?? [],
    }));
  };

  const toggleEmployeePick = (employeeId: string) => {
    onSelectedEmployeeIdsChange(
      selectedEmployeeIds.includes(employeeId)
        ? selectedEmployeeIds.filter((id) => id !== employeeId)
        : [...selectedEmployeeIds, employeeId],
    );
  };

  const toggleBulkPosition = (positionName: string) => {
    setBulkPositionNames((prev) =>
      prev.includes(positionName)
        ? prev.filter((entry) => entry !== positionName)
        : [...prev, positionName],
    );
  };

  const setBulkAllocation = (
    positionName: string,
    allocationId: string,
    patch: Partial<{ shiftId: string; targetCount: string }>,
  ) => {
    setBulkPositionAllocations((prev) => ({
      ...prev,
      [positionName]: (prev[positionName] ?? [{ id: "0", shiftId: "", targetCount: "0" }]).map(
        (allocation) =>
          allocation.id === allocationId ? { ...allocation, ...patch } : allocation,
      ),
    }));
  };

  const addBulkAllocation = (positionName: string) => {
    setBulkPositionAllocations((prev) => ({
      ...prev,
      [positionName]: [
        ...(prev[positionName] ?? [{ id: "0", shiftId: "", targetCount: "0" }]).filter(
          (allocation, index) => !(allocation.id === "0" && index === 0 && !allocation.shiftId && allocation.targetCount === "0"),
        ),
        {
          id: `${positionName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          shiftId: "",
          targetCount: "0",
        },
      ],
    }));
  };

  const removeBulkAllocation = (positionName: string, allocationId: string) => {
    setBulkPositionAllocations((prev) => {
      const nextRows = (prev[positionName] ?? []).filter(
        (allocation) => allocation.id !== allocationId,
      );
      return {
        ...prev,
        [positionName]:
          nextRows.length > 0 ? nextRows : [{ id: "0", shiftId: "", targetCount: "0" }],
      };
    });
  };

  const getBulkAllocations = (positionName: string) =>
    bulkPositionAllocations[positionName] ?? [{ id: "0", shiftId: "", targetCount: "0" }];

  const getBulkAllocatedTotal = (positionName: string) =>
    getBulkAllocations(positionName).reduce(
      (total, allocation) => total + Math.max(0, Number(allocation.targetCount) || 0),
      0,
    );

  const resetAlternateForm = () => {
    setAlternatePairs([{ id: "0", leftShiftId: "", rightShiftId: "" }]);
    setAlternateError(null);
  };

  const resetDayOffForm = () => {
    setDayOffMode("assignOff");
    setDayOffDayKeys([]);
    setDayOffSearchByDay({});
    setDayOffEmployeeIdsByDay({});
    setDayOffReplaceExisting(false);
  };

  const setAlternatePair = (
    pairId: string,
    patch: Partial<{ leftShiftId: string; rightShiftId: string }>,
  ) => {
    setAlternatePairs((prev) =>
      prev.map((pair) => (pair.id === pairId ? { ...pair, ...patch } : pair)),
    );
    setAlternateError(null);
  };

  const addAlternatePair = () => {
    setAlternatePairs((prev) => [
      ...prev,
      {
        id: `pair-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        leftShiftId: "",
        rightShiftId: "",
      },
    ]);
    setAlternateError(null);
  };

  const removeAlternatePair = (pairId: string) => {
    setAlternatePairs((prev) =>
      prev.length === 1
        ? [{ id: "0", leftShiftId: "", rightShiftId: "" }]
        : prev.filter((pair) => pair.id !== pairId),
    );
    setAlternateError(null);
  };

  const resetBulkForm = () => {
    setBulkMode("replace");
    setBulkPositionNames([]);
    setBulkDayKeys([]);
    setBulkSourceMode("any");
    setBulkSourceShiftId("");
    setBulkTargetShiftId("");
    setBulkTargetMode("bucket");
    setBulkTargetBucket("morning");
    setBulkAssignShiftId("");
    setBulkHeadcountTargetShiftId("");
    setBulkTargetCount("1");
    setBulkPositionAllocations({});
  };

  const handleApplyAlternate = () => {
    const normalizedPairs = alternatePairs
      .map((pair) => ({
        leftShiftId: pair.leftShiftId ? Number(pair.leftShiftId) : null,
        rightShiftId: pair.rightShiftId ? Number(pair.rightShiftId) : null,
      }))
      .filter((pair) => pair.leftShiftId != null || pair.rightShiftId != null);

    if (normalizedPairs.length === 0) {
      setAlternateError("Add at least one shift pair");
      return;
    }

    if (
      normalizedPairs.some(
        (pair) =>
          pair.leftShiftId == null ||
          pair.rightShiftId == null ||
          pair.leftShiftId === pair.rightShiftId,
      )
    ) {
      setAlternateError("Each pair needs two different shifts");
      return;
    }

    const allShiftIds = normalizedPairs.flatMap((pair) => [
      pair.leftShiftId as number,
      pair.rightShiftId as number,
    ]);
    if (new Set(allShiftIds).size !== allShiftIds.length) {
      setAlternateError("One shift cannot be used in multiple pairs");
      return;
    }

    onSwapPreviousWeek(
      normalizedPairs as WeekPlannerAlternatePair[],
      tableEmployeeIds,
    );
    resetAlternateForm();
    setAlternateOpen(false);
  };

  const handleApplyBulkAction = () => {
    if (bulkDayKeys.length === 0) return;
    if (bulkMode === "replace") {
      onApplyBulkAction({
        mode: "replace",
        dayKeys: bulkDayKeys,
        employeeIds: selectedEmployeeIds.length ? selectedEmployeeIds : null,
        positionNames: bulkPositionNames.length ? bulkPositionNames : null,
        sourceMode: bulkSourceMode,
        sourceShiftId: bulkSourceMode === "shift" && bulkSourceShiftId ? Number(bulkSourceShiftId) : null,
        targetShiftId: bulkTargetShiftId ? Number(bulkTargetShiftId) : null,
      });
      resetBulkForm();
      setBulkOpen(false);
      return;
    }

    if (bulkMode === "headcount") {
      onApplyBulkAction({
        mode: "headcount",
        dayKeys: bulkDayKeys,
        employeeIds: selectedEmployeeIds.length ? selectedEmployeeIds : null,
        positionNames: bulkPositionNames.length ? bulkPositionNames : null,
        targetMode: bulkTargetMode,
        targetBucket: bulkTargetMode === "bucket" ? bulkTargetBucket : null,
        targetShiftId:
          bulkTargetMode === "shift" && bulkHeadcountTargetShiftId
            ? Number(bulkHeadcountTargetShiftId)
            : null,
        assignShiftId: bulkAssignShiftId ? Number(bulkAssignShiftId) : null,
        targetCount: Math.max(0, Number(bulkTargetCount) || 0),
      });
      resetBulkForm();
      setBulkOpen(false);
      return;
    }

    onApplyBulkAction({
      mode: "positionAllocate",
      dayKeys: bulkDayKeys,
      employeeIds: selectedEmployeeIds.length ? selectedEmployeeIds : null,
      allocations: (bulkPositionNames.length ? bulkPositionNames : positionOptions).flatMap(
        (positionName) =>
          getBulkAllocations(positionName).map((allocation) => ({
            positionName,
            shiftId: allocation.shiftId ? Number(allocation.shiftId) : null,
            targetCount: Math.max(0, Number(allocation.targetCount) || 0),
          })),
      ),
    });
    resetBulkForm();
    setBulkOpen(false);
  };

  const handleApplyDayOffTool = () => {
    const hasSelections = dayOffDayKeys.some(
      (dayKey) => (dayOffEmployeeIdsByDay[dayKey] ?? []).length > 0,
    );
    if (dayOffDayKeys.length === 0 || !hasSelections) return;
    onApplyDayOffTool({
      mode: dayOffMode,
      dayKeys: dayOffDayKeys,
      employeeIdsByDay: dayOffEmployeeIdsByDay,
      replaceExistingOff: dayOffReplaceExisting,
    });
    resetDayOffForm();
    setDayOffOpen(false);
  };

  const handleRemoveAllDayOff = () => {
    const hasSelections = dayOffDayKeys.some(
      (dayKey) => (dayOffEmployeeIdsByDay[dayKey] ?? []).length > 0,
    );
    if (dayOffDayKeys.length === 0 || !hasSelections) return;
    onApplyDayOffTool({
      mode: "clearAllOff",
      dayKeys: dayOffDayKeys,
      employeeIdsByDay: dayOffEmployeeIdsByDay,
      replaceExistingOff: false,
    });
    resetDayOffForm();
    setDayOffOpen(false);
  };

  const getFilteredDayOffRows = (dayKey: WeekPlannerDayKey) => {
    const searchText = (dayOffSearchByDay[dayKey] ?? "").trim().toLowerCase();
    return dayOffScopeRows.filter((row) => {
      if (!searchText) return true;
      const haystack = [
        row.employee.firstName,
        row.employee.lastName,
        row.employee.employeeCode,
        row.employee.position?.name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchText);
    });
  };

  const toggleDayOffEmployee = (dayKey: WeekPlannerDayKey, employeeId: string) => {
    setDayOffEmployeeIdsByDay((prev) => {
      const current = prev[dayKey] ?? [];
      return {
        ...prev,
        [dayKey]: current.includes(employeeId)
          ? current.filter((id) => id !== employeeId)
          : [...current, employeeId],
      };
    });
  };

  const toggleAllFilteredDayOffEmployees = (dayKey: WeekPlannerDayKey, checked: boolean) => {
    const filteredRows = getFilteredDayOffRows(dayKey);
    setDayOffEmployeeIdsByDay((prev) => {
      const current = prev[dayKey] ?? [];
      return {
        ...prev,
        [dayKey]: checked
          ? Array.from(new Set([...current, ...filteredRows.map((row) => row.employee.employeeId)]))
          : current.filter(
              (employeeId) =>
                !filteredRows.some((row) => row.employee.employeeId === employeeId),
            ),
      };
    });
  };
  const dayOffAssignments = useMemo(
    () =>
      dayOffDayKeys.flatMap((dayKey) =>
        (dayOffEmployeeIdsByDay[dayKey] ?? []).map((employeeId) => ({
          dayKey,
          employeeId,
          row: dayOffRowsByEmployeeId.get(employeeId) ?? null,
        })),
      ),
    [dayOffDayKeys, dayOffEmployeeIdsByDay, dayOffRowsByEmployeeId],
  );
  const dayOffSelectionSummary = useMemo(
    () =>
      Array.from(
        new Set(dayOffAssignments.map((entry) => entry.employeeId).filter(Boolean)),
      )
        .map((employeeId) => {
          const row = dayOffRowsByEmployeeId.get(employeeId);
          if (!row) return null;
          const selectedDays = dayOffDayKeys.filter((dayKey) =>
            (dayOffEmployeeIdsByDay[dayKey] ?? []).includes(employeeId),
          );
          const leaveDays = selectedDays.filter((dayKey) => Boolean(row.days[dayKey].leave));
          const existingOffDays = weekPlannerDayKeys.filter((dayKey) =>
            Boolean(row.days[dayKey].shift?.isDayOff),
          );
          const projectedOffDays =
            dayOffMode === "assignOff"
              ? Array.from(
                  new Set(
                    dayOffReplaceExisting
                      ? selectedDays.filter((dayKey) => !leaveDays.includes(dayKey))
                      : [
                          ...existingOffDays,
                          ...selectedDays.filter((dayKey) => !leaveDays.includes(dayKey)),
                        ],
                  ),
                )
              : existingOffDays.filter((dayKey) => !selectedDays.includes(dayKey));
          return {
            employeeId,
            row,
            selectedDays,
            leaveDays,
            projectedOffDays,
            hasDoubleDayOff: projectedOffDays.length > 1,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry != null)
        .sort((left, right) => {
          const lastCmp = left.row.employee.lastName.localeCompare(right.row.employee.lastName);
          return lastCmp !== 0
            ? lastCmp
            : left.row.employee.firstName.localeCompare(right.row.employee.firstName);
        }),
    [
      dayOffAssignments,
      dayOffDayKeys,
      dayOffEmployeeIdsByDay,
      dayOffMode,
      dayOffReplaceExisting,
      dayOffRowsByEmployeeId,
    ],
  );
  const dayOffLeaveConflictCount = useMemo(
    () =>
      dayOffAssignments.reduce(
        (count, entry) => count + (entry.row?.days[entry.dayKey].leave ? 1 : 0),
        0,
      ),
    [dayOffAssignments],
  );
  const dayOffDoubleOffCount = useMemo(
    () => dayOffSelectionSummary.filter((entry) => entry.hasDoubleDayOff).length,
    [dayOffSelectionSummary],
  );
  const draftVersions = useMemo(
    () => draftGroups.flatMap((group) => group.versions),
    [draftGroups],
  );
  const draftAssignmentsByKey = useMemo(
    () => new Map(activeDraft?.assignments.map((assignment) => [
      `${assignment.employeeId}:${assignment.workDate}`,
      assignment,
    ]) ?? []),
    [activeDraft],
  );

  return (
    <Card className="shadow-sm">
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle className="text-lg">Weekly Schedule Planner</CardTitle>
            <p className="text-sm text-muted-foreground">
              {plannerMode === "AI_DRAFT"
                ? "Create and revise a private schedule draft. Changes stay out of employee schedules."
                : "Build weekly schedules, compare with a reference week, then save dirty employees only."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={plannerMode === "MANUAL" ? "default" : "outline"}
                onClick={() => onPlannerModeChange("MANUAL")}
              >
                Manual
              </Button>
              {aiSchedulingEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant={plannerMode === "AI_DRAFT" ? "default" : "outline"}
                  onClick={() => onPlannerModeChange("AI_DRAFT")}
                >
                  AI Draft
                </Button>
              ) : null}
            </div>
            {!aiSchedulingEnabled ? (
              <p className="mt-2 text-xs text-muted-foreground">AI Draft is disabled by server configuration. Manual scheduling remains available.</p>
            ) : null}
          </div>
          <div className="flex flex-col items-start gap-2 md:items-end">
            {unassignedCount > 0 ? (
              <p className="text-sm font-medium text-amber-600">
                {unassignedCount} unassigned day{unassignedCount === 1 ? "" : "s"} remaining
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={onRefresh}
                disabled={loading || saving}
              >
                <RefreshCcw className="h-4 w-4" />
                Reload week
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-2"
                onClick={onSave}
                disabled={loading || saving || !canSave}
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : plannerMode === "AI_DRAFT" ? "Save Draft" : "Save week"}
              </Button>
            </div>
          </div>
        </div>

        {plannerMode === "AI_DRAFT" ? (
          <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/[0.03] p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold">Draft workspace</div>
                  {activeDraft ? <Badge variant="secondary">Draft v{activeDraft.version}</Badge> : null}
                  {activeDraft ? <Badge variant="outline">{activeDraft.status}</Badge> : null}
                  {activeDraft?.isSourceStale ? <Badge variant="warning">Source changed</Badge> : null}
                  {activeDraft && !activeDraft.isLatestVersion ? <Badge variant="outline">History · read-only</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Draft edits are versioned separately. Saving here never updates employee schedules.
                </p>
                {activeDraft ? (
                  <p className="text-xs text-muted-foreground">
                    Created by {activeDraft.createdByUsername} · {new Date(activeDraft.createdAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" })}
                    {activeDraft.sourceMode === "REFERENCE_WEEK" && activeDraft.sourceWeekStart
                      ? ` · Reference ${activeDraft.sourceWeekStart}`
                      : ` · Source ${activeDraft.sourceMode.toLowerCase().replaceAll("_", " ")}`}
                  </p>
                ) : null}
                {!activeDraft ? (
                  <p className="text-xs text-muted-foreground">
                    Choose a saved version or create a draft to edit this week.
                  </p>
                ) : null}
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-64">
                <Select
                  value={activeDraft?.id ?? ""}
                  onValueChange={onDraftVersionChange}
                  disabled={draftLoading || draftVersions.length === 0}
                >
                  <SelectTrigger aria-label="Select draft version" className="w-full">
                    <SelectValue placeholder={draftLoading ? "Loading drafts…" : "Draft history"} />
                  </SelectTrigger>
                  <SelectContent>
                    {draftVersions.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        {`v${version.version} · ${version.status} · ${version.updatedAt.slice(0, 10)}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {activeDraft?.isLatestVersion && activeDraft.status === "DRAFT" ? (
                  <Button type="button" variant="outline" size="sm" onClick={onDiscardDraft} disabled={saving}>
                    Discard latest draft
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="mr-1 text-xs font-medium text-muted-foreground">New draft from:</span>
              <Button type="button" size="sm" variant="outline" onClick={() => onCreateDraft("CURRENT_SCHEDULE")} disabled={saving || draftLoading}>
                Current schedule
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => onCreateDraft("REFERENCE_WEEK")} disabled={saving || draftLoading}>
                Reference week
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => onCreateDraft("EMPTY")} disabled={saving || draftLoading}>
                Empty draft
              </Button>
              {draftError ? <span role="alert" className="text-sm text-destructive">{draftError}</span> : null}
            </div>
          </div>
        ) : null}

        {aiSchedulingEnabled && plannerMode === "AI_DRAFT" ? (
          <SchedulePolicyPanel
            departments={departments}
            shifts={shifts}
            activeDraft={activeDraft}
            draftDirty={dirty}
            onDraftGenerated={onDraftGenerated}
            onRefresh={onRefresh}
          />
        ) : null}

        {aiSchedulingChatEnabled && plannerMode === "AI_DRAFT" ? (
          <ScheduleAssistantPanel
            weekStart={weekStart}
            referenceWeekStart={compareWeekStart}
            departmentId={departmentId}
            selectedEmployeeIds={selectedEmployeeIds}
            draftId={activeDraft?.id ?? null}
            onDraftChanged={onDraftGenerated}
          />
        ) : null}

        <div className="rounded-lg border p-4">
          <div className="mb-3">
            <div className="text-sm font-medium">Week setup</div>
            <p className="text-sm text-muted-foreground">
              Schedule week gets saved. Reference week is only source for compare, copy, and alternate.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(240px,320px)_220px]">
            <div className="space-y-2">
              <label className="text-sm font-medium">Schedule week</label>
              <Popover open={scheduleWeekPickerOpen} onOpenChange={setScheduleWeekPickerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-between font-normal">
                    <span>{weekStart}</span>
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <div className="border-b px-4 py-3 text-xs text-muted-foreground">
                    Click one day. Whole Monday to Sunday week is auto-selected.
                  </div>
                  <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                    <Calendar
                      mode="range"
                      selected={scheduleWeekRange}
                      defaultMonth={scheduleWeekRange?.from}
                      onDayClick={(date) => {
                        onWeekStartChange(toWeekStartValue(date));
                        setScheduleWeekPickerOpen(false);
                      }}
                      modifiers={{
                        selected: (date) => isDateInsideWeekRange(date, weekStart),
                        range_start: (date) =>
                          Boolean(scheduleWeekRange?.from) &&
                          date.toDateString() === scheduleWeekRange?.from?.toDateString(),
                        range_end: (date) =>
                          Boolean(scheduleWeekRange?.to) &&
                          date.toDateString() === scheduleWeekRange?.to?.toDateString(),
                        range_middle: (date) =>
                          isDateInsideWeekRange(date, weekStart) &&
                          date.toDateString() !== scheduleWeekRange?.from?.toDateString() &&
                          date.toDateString() !== scheduleWeekRange?.to?.toDateString(),
                      }}
                      showOutsideDays
                      captionLayout="dropdown"
                      ISOWeek
                    />
                    <div className="space-y-2 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        Quick weeks
                      </div>
                      {scheduleWeekOptions.map((option) => (
                        <QuickWeekButton
                          key={`schedule-option-${option.weekStart}`}
                          option={option}
                          active={option.weekStart === weekStart}
                          onClick={() => {
                            onWeekStartChange(option.weekStart);
                            setScheduleWeekPickerOpen(false);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Reference week</label>
              <Popover open={referenceWeekPickerOpen} onOpenChange={setReferenceWeekPickerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-between font-normal">
                    <span>{compareWeekStart}</span>
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <div className="border-b px-4 py-3 text-xs text-muted-foreground">
                    Click one day. Whole Monday to Sunday week is auto-selected.
                  </div>
                  <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                    <Calendar
                      mode="range"
                      selected={referenceWeekRange}
                      defaultMonth={referenceWeekRange?.from}
                      onDayClick={(date) => {
                        onCompareWeekStartChange(toWeekStartValue(date));
                        setReferenceWeekPickerOpen(false);
                      }}
                      modifiers={{
                        selected: (date) => isDateInsideWeekRange(date, compareWeekStart),
                        range_start: (date) =>
                          Boolean(referenceWeekRange?.from) &&
                          date.toDateString() === referenceWeekRange?.from?.toDateString(),
                        range_end: (date) =>
                          Boolean(referenceWeekRange?.to) &&
                          date.toDateString() === referenceWeekRange?.to?.toDateString(),
                        range_middle: (date) =>
                          isDateInsideWeekRange(date, compareWeekStart) &&
                          date.toDateString() !== referenceWeekRange?.from?.toDateString() &&
                          date.toDateString() !== referenceWeekRange?.to?.toDateString(),
                      }}
                      showOutsideDays
                      captionLayout="dropdown"
                      ISOWeek
                    />
                    <div className="space-y-2 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        Quick weeks
                      </div>
                      {referenceWeekOptions.map((option) => (
                        <QuickWeekButton
                          key={`reference-option-${option.weekStart}`}
                          option={option}
                          active={option.weekStart === compareWeekStart}
                          onClick={() => {
                            onCompareWeekStartChange(option.weekStart);
                            setReferenceWeekPickerOpen(false);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <div className="text-xs text-muted-foreground">{formatWeekRange(compareWeekStart)}</div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Department</label>
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                value={departmentId}
                onChange={(event) => onDepartmentChange(event.target.value)}
              >
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department.departmentId} value={department.departmentId}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-lg border bg-muted/20 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Total active
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div className="rounded-full bg-primary/10 p-2.5 text-primary">
                  <Users className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-2xl font-semibold leading-none">{summaryRows.length}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Current department scope</div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Shift mix</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weekPlannerDayKeys.map((dayKey) => (
                <TableRow key={`summary-${dayKey}`}>
                  <TableCell className="font-medium">{weekPlannerDayLabel(dayKey)}</TableCell>
                  <TableCell>{exactByDay[dayKey].assigned}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {exactByDay[dayKey].labels.length > 0
                      ? exactByDay[dayKey].labels.join(" · ")
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">Position</TableHead>
                <TableHead>Active</TableHead>
                {weekPlannerDayKeys.map((dayKey) => (
                  <TableHead key={`position-${dayKey}`} className="min-w-[120px]">
                    {weekPlannerDayLabel(dayKey)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {positionSummary.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-sm text-muted-foreground">
                    No employees in current department scope.
                  </TableCell>
                </TableRow>
              ) : (
                positionSummary.map((position) => (
                  <TableRow key={position.positionName}>
                    <TableCell className="font-medium">{position.positionName}</TableCell>
                    <TableCell>{position.active}</TableCell>
                    {weekPlannerDayKeys.map((dayKey) => (
                      <TableCell key={`${position.positionName}-${dayKey}`} className="text-sm text-muted-foreground">
                        {position.days[dayKey].labels.length > 0
                          ? position.days[dayKey].labels.join(" · ")
                          : "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium">Search rows</label>
              <Input
                value={employeeSearch}
                placeholder="Name, code, role"
                onChange={(event) => onEmployeeSearchChange(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Planner tools</label>
              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onCopyPreviousWeek(tableEmployeeIds)}
                  disabled={loading || saving || tableRows.length === 0}
                >
                  Use reference week
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    resetAlternateForm();
                    setAlternateOpen(true);
                  }}
                  disabled={loading || saving || tableRows.length === 0}
                >
                  Alternate shifts
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onClearWeek(tableEmployeeIds)}
                  disabled={loading || saving || tableRows.length === 0}
                >
                  Clear visible
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerOpen(true)}
                >
                  Employee picker
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    resetDayOffForm();
                    setDayOffOpen(true);
                  }}
                  disabled={!dayOffShift || loading || saving || dayOffScopeRows.length === 0}
                  title={dayOffShift ? undefined : "Create a Day Off shift first"}
                >
                  Day off tool
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkOpen(true)}
                  disabled={loading || saving || summaryRows.length === 0}
                >
                  Bulk actions
                </Button>
              </div>
              {!dayOffShift ? (
                <div className="text-xs text-muted-foreground">Create a Day Off shift first.</div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={effectivePositionTab === "__all" ? "default" : "outline"}
              onClick={() => setActivePositionTab("__all")}
            >
              All
              <span className="text-xs opacity-80">{rows.length}</span>
            </Button>
            {positionTabs.map((tab) => (
              <Button
                key={tab.name}
                type="button"
                size="sm"
                variant={effectivePositionTab === tab.name ? "default" : "outline"}
                onClick={() => setActivePositionTab(tab.name)}
              >
                {tab.name}
                <span className="text-xs opacity-80">{tab.count}</span>
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading week planner...</p>
        ) : tableRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employees match current row filters.</p>
        ) : (
          <div className="rounded-lg border p-3">
            <div className="overflow-x-auto rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Employee</TableHead>
                  <TableHead className="w-[52px] min-w-[52px]" />
                  {weekPlannerDayKeys.map((dayKey) => (
                    <TableHead key={dayKey} className="min-w-[160px] align-top">
                      <div className="space-y-1">
                        <div>{weekPlannerDayLabel(dayKey)}</div>
                        <div className="text-xs font-normal text-muted-foreground">
                          {tableRows[0]?.days[dayKey]?.workDate
                            ? formatDateDisplay(tableRows[0].days[dayKey].workDate)
                            : ""}
                        </div>
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.map((row) => (
                  <TableRow key={row.employee.employeeId}>
                    <TableCell className="align-top">
                      <div className="flex items-start gap-2.5">
                        <Avatar className="h-10 w-10 shrink-0 border border-border/60">
                          {row.employee.img ? (
                            <AvatarImage
                              src={row.employee.img}
                              alt={`${row.employee.firstName} ${row.employee.lastName}`}
                            />
                          ) : null}
                          <AvatarFallback className="bg-primary/10 text-[11px] font-semibold uppercase text-primary">
                            {getEmployeeInitials(row)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-col">
                          <span className="font-medium">
                            {row.employee.firstName} {row.employee.lastName}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {row.employee.position?.name || "—"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-top px-2">
                      <div className="grid gap-2 pt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        <div className="flex h-10 items-center">New</div>
                        <div className="h-4" />
                        <div className="flex h-10 items-center">Old</div>
                      </div>
                    </TableCell>
                    {weekPlannerDayKeys.map((dayKey) => {
                      const day = row.days[dayKey];
                      const isLeaveDay = Boolean(day.leave);
                      const isUnassigned = day.shiftId == null && !isLeaveDay;
                      const draftAssignment = activeDraft
                        ? draftAssignmentsByKey.get(`${row.employee.employeeId}:${day.workDate}`)
                        : undefined;
                      const isChangedDraftCell = plannerMode === "AI_DRAFT" && Boolean(
                        draftAssignment &&
                        (
                          draftAssignment.source === "MANUAL" ||
                          (draftAssignment.shiftId !== draftAssignment.baselineShiftId && !(
                            draftAssignment.source === "CURRENT_SCHEDULE" &&
                            draftAssignment.hasBaselineOverride &&
                            draftAssignment.shiftId === draftAssignment.baselineOverrideShiftId
                          ))
                        ),
                      );
                      return (
                        <TableCell
                          key={`${row.employee.employeeId}-${dayKey}`}
                          className={`align-top ${isChangedDraftCell ? "bg-amber-500/10 ring-1 ring-inset ring-amber-500/35" : ""}`}
                        >
                          <div className="space-y-2">
                            <div className="grid gap-2">
                              <div className="space-y-1">
                                {isLeaveDay ? (
                                  <div className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
                                    <div className="font-medium text-sky-200">
                                      {formatLeaveType(day.leave!.leaveType)}
                                    </div>
                                    {plannerMode === "AI_DRAFT" ? (
                                      <div className="mt-1 text-xs text-muted-foreground">
                                        Base shift: {formatShiftCode(selectedShiftById(day.shiftId))}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : (
                                  <Select
                                    value={day.shiftId != null ? String(day.shiftId) : "__unassigned"}
                                    disabled={plannerMode === "AI_DRAFT" && (
                                      !activeDraft ||
                                      !activeDraft.isLatestVersion ||
                                      activeDraft.status === "PUBLISHED" ||
                                      activeDraft.status === "DISCARDED"
                                    )}
                                    onValueChange={(value) =>
                                      onChangeShift(
                                        row.employee.employeeId,
                                        dayKey,
                                        value === "__unassigned" ? null : Number(value),
                                      )
                                    }
                                  >
                                    <SelectTrigger
                                      className={`w-full ${isUnassigned ? "border-amber-500/60 bg-amber-500/10" : ""}`}
                                      style={getSelectStyle(selectedShiftById(day.shiftId))}
                                      aria-label={`${row.employee.firstName} ${row.employee.lastName} ${weekPlannerDayLabel(dayKey)} shift`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__unassigned">Unassigned</SelectItem>
                                      {shifts.map((shift) => (
                                        <SelectItem key={shift.id} value={String(shift.id)}>
                                          {shift.code} · {shift.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                                <div className="text-[11px] font-medium text-muted-foreground">
                                  {isLeaveDay ? "Protected leave · base shift preserved" : day.hasOverride ? (
                                    <span className="inline-flex items-center gap-1">
                                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                        Override {day.overrideShiftId == null
                                          ? "No shift"
                                          : formatShiftCode(selectedShiftById(day.overrideShiftId))}
                                      </Badge>
                                    </span>
                                  ) : ""}
                                </div>
                              </div>
                              <div className="space-y-1">
                                <div
                                  className="rounded-md border border-border bg-muted/40 px-2 py-2 text-sm text-foreground/85"
                                  style={getSelectStyle(day.compareShift)}
                                >
                                  {formatShiftCode(day.compareShift)}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  {formatDateDisplay(day.compareWorkDate)}
                                </div>
                              </div>
                            </div>
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-[96vw] overflow-y-auto sm:max-w-[96vw] 2xl:max-w-[1400px]">
          <DialogHeader>
            <DialogTitle>Employee picker</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={allFilteredPicked}
                  onChange={(event) =>
                    onSelectedEmployeeIdsChange(
                      event.target.checked
                        ? Array.from(
                            new Set([
                              ...selectedEmployeeIds,
                              ...filteredEmployeePickerRows.map((row) => row.employee.employeeId),
                            ]),
                          )
                        : selectedEmployeeIds.filter(
                            (employeeId) =>
                              !filteredEmployeePickerRows.some(
                                (row) => row.employee.employeeId === employeeId,
                              ),
                          ),
                    )
                  }
                  className="h-4 w-4"
                />
                Select all shown
              </label>
              <Input
                value={pickerSearch}
                placeholder="Search employee"
                onChange={(event) => setPickerSearch(event.target.value)}
                className="w-full lg:max-w-sm"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onSelectedEmployeeIdsChange([])}
              >
                Clear selection
              </Button>
            </div>
            <div className="max-h-[420px] overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Pick</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Position</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEmployeePickerRows.map((row) => (
                    <TableRow key={`pick-${row.employee.employeeId}`}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedEmployeeIds.includes(row.employee.employeeId)}
                          onChange={() => toggleEmployeePick(row.employee.employeeId)}
                          className="h-4 w-4"
                        />
                      </TableCell>
                      <TableCell>
                        {row.employee.firstName} {row.employee.lastName}
                        <div className="text-xs text-muted-foreground">{row.employee.employeeCode}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.employee.position?.name || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setPickerOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dayOffOpen}
        onOpenChange={(open) => {
          setDayOffOpen(open);
          if (!open) resetDayOffForm();
        }}
      >
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-[96vw] overflow-hidden p-0 sm:max-w-[96vw] 2xl:max-w-[1480px]">
          <DialogHeader className="border-b px-7 py-5">
            <DialogTitle>Day off tool</DialogTitle>
          </DialogHeader>
          <div className="max-h-[calc(92vh-148px)] space-y-5 overflow-y-auto px-7 py-6">
            <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              Target scope:{" "}
              {selectedEmployeeIds.length > 0
                ? `${selectedEmployeeIds.length} selected employees`
                : `${tableEmployeeIds.length} visible employees`}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-lg border bg-muted/10 p-4">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Employees in scope
                </div>
                <div className="mt-2 text-2xl font-semibold">{dayOffScopeRows.length}</div>
              </div>
              <div className="rounded-lg border bg-muted/10 p-4">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Being assigned OFF
                </div>
                <div className="mt-2 text-2xl font-semibold">{dayOffSelectionSummary.length}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {dayOffAssignments.length} day-off pick{dayOffAssignments.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/10 p-4">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Warnings
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant={dayOffDoubleOffCount > 0 ? "destructive" : "outline"}>
                    Double OFF {dayOffDoubleOffCount}
                  </Badge>
                  <Badge variant={dayOffLeaveConflictCount > 0 ? "destructive" : "outline"}>
                    Leave conflicts {dayOffLeaveConflictCount}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div className="space-y-2">
                <label className="text-sm font-medium">Action</label>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  value={dayOffMode}
                  onChange={(event) => setDayOffMode(event.target.value as "assignOff" | "clearOff")}
                >
                  <option value="assignOff">Assign OFF</option>
                  <option value="clearOff">Clear OFF</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Days</label>
                <div className="flex flex-wrap gap-3">
                  {weekPlannerDayKeys.map((dayKey) => (
                    <label
                      key={`day-off-${dayKey}`}
                      className="flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={dayOffDayKeys.includes(dayKey)}
                        onChange={() => toggleDayOffDay(dayKey)}
                      />
                      {weekPlannerDayLabel(dayKey)}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {dayOffMode === "assignOff" ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">If employee already has OFF</label>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 lg:max-w-sm"
                  value={dayOffReplaceExisting ? "replace" : "keep"}
                  onChange={(event) => setDayOffReplaceExisting(event.target.value === "replace")}
                >
                  <option value="keep">Keep existing OFF</option>
                  <option value="replace">Remove other OFF days</option>
                </select>
              </div>
            ) : null}

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                {dayOffDayKeys.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    Pick at least one weekday first.
                  </div>
                ) : (
                  dayOffDayKeys.map((dayKey) => {
                    const filteredRows = getFilteredDayOffRows(dayKey);
                    const selectedIds = dayOffEmployeeIdsByDay[dayKey] ?? [];
                    const allFilteredPicked =
                      filteredRows.length > 0 &&
                      filteredRows.every((row) => selectedIds.includes(row.employee.employeeId));
                    return (
                      <div key={`day-off-panel-${dayKey}`} className="space-y-3 rounded-lg border p-4">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <div className="text-sm font-medium">{weekPlannerDayLabel(dayKey)}</div>
                            <div className="text-xs text-muted-foreground">
                              {selectedIds.length} selected
                            </div>
                          </div>
                          <Input
                            value={dayOffSearchByDay[dayKey] ?? ""}
                            placeholder={`Search employee for ${weekPlannerDayLabel(dayKey)}`}
                            onChange={(event) =>
                              setDayOffSearchByDay((prev) => ({
                                ...prev,
                                [dayKey]: event.target.value,
                              }))
                            }
                            className="w-full lg:max-w-sm"
                          />
                        </div>

                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            checked={allFilteredPicked}
                            onChange={(event) =>
                              toggleAllFilteredDayOffEmployees(dayKey, event.target.checked)
                            }
                            className="h-4 w-4"
                          />
                          Select all shown
                        </label>

                        <div className="max-h-[280px] overflow-y-auto rounded-lg border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-12">Pick</TableHead>
                                <TableHead>Employee</TableHead>
                                <TableHead>Position</TableHead>
                                <TableHead className="w-[140px]">Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredRows.length === 0 ? (
                                <TableRow>
                                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                                    No employees match this search.
                                  </TableCell>
                                </TableRow>
                              ) : (
                                filteredRows.map((row) => {
                                  const leaveInfo = row.days[dayKey].leave;
                                  const isDisabled = Boolean(leaveInfo);
                                  const isChecked = selectedIds.includes(row.employee.employeeId);
                                  return (
                                    <TableRow key={`day-off-${dayKey}-${row.employee.employeeId}`}>
                                      <TableCell>
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          disabled={isDisabled}
                                          onChange={() =>
                                            toggleDayOffEmployee(dayKey, row.employee.employeeId)
                                          }
                                          className="h-4 w-4"
                                        />
                                      </TableCell>
                                      <TableCell>
                                        {row.employee.firstName} {row.employee.lastName}
                                        <div className="text-xs text-muted-foreground">
                                          {row.employee.employeeCode}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-sm text-muted-foreground">
                                        {row.employee.position?.name || "—"}
                                      </TableCell>
                                      <TableCell>
                                        {leaveInfo ? (
                                          <Badge variant="outline" className="border-sky-500/40 text-sky-200">
                                            {formatLeaveType(leaveInfo.leaveType)}
                                          </Badge>
                                        ) : row.days[dayKey].shift?.isDayOff ? (
                                          <Badge variant="outline">Already OFF</Badge>
                                        ) : (
                                          <span className="text-xs text-muted-foreground">Available</span>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-3 xl:sticky xl:top-0 xl:self-start">
                <div className="rounded-lg border p-4">
                  <div className="text-sm font-medium">Day-off summary</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Employees and selected OFF days.
                  </div>
                </div>
                <div className="max-h-[560px] space-y-3 overflow-y-auto rounded-lg border p-3">
                  {dayOffSelectionSummary.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No employees picked yet.</div>
                  ) : (
                    dayOffSelectionSummary.map((entry) => (
                      <div key={`day-off-summary-${entry.employeeId}`} className="rounded-md border p-3">
                        <div className="font-medium">
                          {entry.row.employee.firstName} {entry.row.employee.lastName}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {entry.row.employee.position?.name || "—"}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {entry.selectedDays.map((dayKey) => (
                            <Badge key={`${entry.employeeId}-${dayKey}`} variant="outline">
                              {weekPlannerDayLabel(dayKey)}
                            </Badge>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {entry.hasDoubleDayOff ? (
                            <Badge variant="destructive">
                              {entry.projectedOffDays.length} OFF days
                            </Badge>
                          ) : null}
                          {entry.leaveDays.length > 0 ? (
                            <Badge variant="destructive">
                              Leave on {entry.leaveDays.map((dayKey) => weekPlannerDayLabel(dayKey)).join(", ")}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-3 border-t px-7 py-5">
            <Button
              type="button"
              variant="outline"
              onClick={handleRemoveAllDayOff}
              disabled={
                dayOffDayKeys.length === 0 ||
                !dayOffDayKeys.some((dayKey) => (dayOffEmployeeIdsByDay[dayKey] ?? []).length > 0)
              }
            >
              Remove all OFF
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetDayOffForm();
                setDayOffOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleApplyDayOffTool}
              disabled={
                !dayOffShift ||
                dayOffDayKeys.length === 0 ||
                !dayOffDayKeys.some((dayKey) => (dayOffEmployeeIdsByDay[dayKey] ?? []).length > 0)
              }
            >
              Apply day off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={alternateOpen}
        onOpenChange={(open) => {
          setAlternateOpen(open);
          if (!open) resetAlternateForm();
        }}
      >
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-[96vw] overflow-hidden p-0 sm:max-w-[96vw] xl:max-w-[1100px]">
          <DialogHeader className="border-b px-7 py-5">
            <DialogTitle>Alternate shifts</DialogTitle>
          </DialogHeader>

          <div className="max-h-[calc(92vh-148px)] space-y-5 overflow-y-auto px-7 py-6">
            <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              Swap exact shift pairs inside the current Schedule week rows. Renames do not matter.
            </div>

            <div className="space-y-3">
              {alternatePairs.map((pair) => (
                <div
                  key={pair.id}
                  className="grid gap-3 rounded-lg border p-4 lg:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)_44px]"
                >
                  <div className="space-y-2">
                    <label className="text-sm font-medium">From shift</label>
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      style={getSelectStyle(selectedShiftById(pair.leftShiftId ? Number(pair.leftShiftId) : null))}
                      value={pair.leftShiftId}
                      onChange={(event) =>
                        setAlternatePair(pair.id, { leftShiftId: event.target.value })
                      }
                    >
                      <option value="">Pick shift</option>
                      {shifts.map((shift) => (
                        <option
                          key={`alternate-left-${pair.id}-${shift.id}`}
                          value={shift.id}
                          style={
                            shift.colorHex
                              ? {
                                  color: shift.colorHex,
                                  backgroundColor: `${shift.colorHex}14`,
                                }
                              : undefined
                          }
                        >
                          {shift.code}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hidden items-end justify-center pb-2 text-sm text-muted-foreground lg:flex">
                    ↔
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">To shift</label>
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      style={getSelectStyle(selectedShiftById(pair.rightShiftId ? Number(pair.rightShiftId) : null))}
                      value={pair.rightShiftId}
                      onChange={(event) =>
                        setAlternatePair(pair.id, { rightShiftId: event.target.value })
                      }
                    >
                      <option value="">Pick shift</option>
                      {shifts.map((shift) => (
                        <option
                          key={`alternate-right-${pair.id}-${shift.id}`}
                          value={shift.id}
                          style={
                            shift.colorHex
                              ? {
                                  color: shift.colorHex,
                                  backgroundColor: `${shift.colorHex}14`,
                                }
                              : undefined
                          }
                        >
                          {shift.code}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-end">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      onClick={() => removeAlternatePair(pair.id)}
                      disabled={alternatePairs.length === 1}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-start">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={addAlternatePair}
              >
                <Plus className="h-4 w-4" />
                Add pair
              </Button>
            </div>

            {alternateError ? (
              <p className="text-sm text-destructive">{alternateError}</p>
            ) : null}
          </div>

          <DialogFooter className="gap-3 border-t px-7 py-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetAlternateForm();
                setAlternateOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleApplyAlternate}>
              Apply alternate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open);
          if (!open) resetBulkForm();
        }}
      >
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-[96vw] overflow-hidden p-0 sm:max-w-[96vw] 2xl:max-w-[1500px]">
          <DialogHeader className="border-b px-7 py-5">
            <DialogTitle>Bulk planner actions</DialogTitle>
          </DialogHeader>

          <div className="max-h-[calc(92vh-148px)] space-y-6 overflow-y-auto px-7 py-6">
            <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              Target scope: {selectedEmployeeIds.length > 0 ? `${selectedEmployeeIds.length} picked employees` : "all employees in current department scope"}
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
              <div className="space-y-2">
                <label className="text-sm font-medium">Mode</label>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  value={bulkMode}
                  onChange={(event) =>
                    setBulkMode(
                      event.target.value as "replace" | "headcount" | "positionAllocate",
                    )
                  }
                >
                  <option value="replace">Replace shift</option>
                  <option value="positionAllocate">Allocate by position</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Position filter</label>
                <div className="flex flex-wrap gap-2 rounded-md border border-border p-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={bulkPositionNames.length === 0 ? "default" : "outline"}
                    onClick={() => setBulkPositionNames([])}
                  >
                    All positions
                  </Button>
                  {positionOptions.map((positionName) => (
                    <Button
                      key={positionName}
                      type="button"
                      size="sm"
                      variant={bulkPositionNames.includes(positionName) ? "default" : "outline"}
                      onClick={() => toggleBulkPosition(positionName)}
                    >
                      {positionName}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Days</label>
              <div className="flex flex-wrap gap-3">
                {weekPlannerDayKeys.map((dayKey) => (
                  <label
                    key={dayKey}
                    className="flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={bulkDayKeys.includes(dayKey)}
                      onChange={() => toggleBulkDay(dayKey)}
                    />
                    {weekPlannerDayLabel(dayKey)}
                  </label>
                ))}
              </div>
            </div>

            {bulkMode === "replace" ? (
              <div className="grid gap-5 lg:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Source</label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    value={bulkSourceMode}
                    onChange={(event) =>
                      setBulkSourceMode(
                        event.target.value as "any" | "dayOff" | "unassigned" | "shift",
                      )
                    }
                  >
                    <option value="any">Any</option>
                    <option value="unassigned">Unassigned only</option>
                    <option value="dayOff">Day Off only</option>
                    <option value="shift">Specific shift</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Source shift</label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    value={bulkSourceShiftId}
                    disabled={bulkSourceMode !== "shift"}
                    onChange={(event) => setBulkSourceShiftId(event.target.value)}
                  >
                    <option value="">Pick shift</option>
                    {workingShifts.map((shift) => (
                      <option
                        key={shift.id}
                        value={shift.id}
                        style={
                          shift.colorHex
                            ? {
                                color: shift.colorHex,
                                backgroundColor: `${shift.colorHex}14`,
                              }
                            : undefined
                        }
                      >
                        {shift.code}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Target shift</label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    style={getSelectStyle(selectedShiftById(bulkTargetShiftId ? Number(bulkTargetShiftId) : null))}
                    value={bulkTargetShiftId}
                    onChange={(event) => setBulkTargetShiftId(event.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {shifts.map((shift) => (
                      <option
                        key={shift.id}
                        value={shift.id}
                        style={
                          shift.colorHex
                            ? {
                                color: shift.colorHex,
                                backgroundColor: `${shift.colorHex}14`,
                              }
                            : undefined
                        }
                      >
                        {shift.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : bulkMode === "headcount" ? (
              <div className="space-y-5">
                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Target type</label>
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      value={bulkTargetMode}
                      onChange={(event) => setBulkTargetMode(event.target.value as "bucket" | "shift")}
                    >
                      <option value="bucket">Bucket</option>
                      <option value="shift">Exact shift</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Target count</label>
                    <Input
                      type="number"
                      min="0"
                      value={bulkTargetCount}
                      onChange={(event) => setBulkTargetCount(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Target bucket/shift</label>
                    {bulkTargetMode === "bucket" ? (
                      <select
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        value={bulkTargetBucket}
                        onChange={(event) => setBulkTargetBucket(event.target.value as ShiftBucket)}
                      >
                        <option value="morning">Morning</option>
                        <option value="afternoon">Afternoon</option>
                        <option value="other">Other</option>
                      </select>
                    ) : (
                      <select
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        style={getSelectStyle(selectedShiftById(bulkHeadcountTargetShiftId ? Number(bulkHeadcountTargetShiftId) : null))}
                        value={bulkHeadcountTargetShiftId}
                        onChange={(event) => setBulkHeadcountTargetShiftId(event.target.value)}
                      >
                        <option value="">Pick shift</option>
                        {workingShifts.map((shift) => (
                          <option
                            key={shift.id}
                            value={shift.id}
                            style={
                              shift.colorHex
                                ? {
                                    color: shift.colorHex,
                                    backgroundColor: `${shift.colorHex}14`,
                                  }
                                : undefined
                            }
                          >
                            {shift.code}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {bulkTargetMode === "bucket" ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Assign using shift</label>
                      <select
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        style={getSelectStyle(selectedShiftById(bulkAssignShiftId ? Number(bulkAssignShiftId) : null))}
                        value={bulkAssignShiftId}
                        onChange={(event) => setBulkAssignShiftId(event.target.value)}
                      >
                        <option value="">Pick shift</option>
                        {shiftsForBucket[bulkTargetBucket].map((shift) => (
                          <option
                            key={shift.id}
                            value={shift.id}
                            style={
                              shift.colorHex
                                ? {
                                    color: shift.colorHex,
                                    backgroundColor: `${shift.colorHex}14`,
                                  }
                                : undefined
                            }
                          >
                            {shift.code}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      Exact shift mode reuses chosen target shift.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
                  Set many allocations per role. Example: `AM 5`, `PM 4`. Total per role capped by active employees in current scope.
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Position</TableHead>
                        <TableHead className="w-[140px]">Active</TableHead>
                        <TableHead className="w-[360px]">Allocations</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(bulkPositionNames.length ? bulkPositionNames : positionOptions).map(
                        (positionName) => {
                          const activeCount = positionActiveCounts[positionName] ?? 0;
                          const allocations = getBulkAllocations(positionName);
                          const allocatedTotal = getBulkAllocatedTotal(positionName);
                          return (
                            <TableRow key={`allocation-${positionName}`}>
                              <TableCell className="py-5 font-medium">{positionName}</TableCell>
                              <TableCell className="py-5">
                                <div className="space-y-1">
                                  <div className="font-medium">{activeCount}</div>
                                  <div className="text-xs text-muted-foreground">
                                    Allocated {Math.min(allocatedTotal, activeCount)} / {activeCount}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="py-5">
                                <div className="space-y-3">
                                  {allocations.map((allocation) => {
                                    const remainingCap =
                                      activeCount -
                                      (allocatedTotal - Math.max(0, Number(allocation.targetCount) || 0));
                                    return (
                                      <div
                                        key={allocation.id}
                                        className="grid gap-3 lg:grid-cols-[132px_minmax(0,1fr)_44px]"
                                      >
                                        <Input
                                          type="number"
                                          min="0"
                                          max={Math.max(0, remainingCap)}
                                          value={allocation.targetCount}
                                          onChange={(event) =>
                                            setBulkAllocation(positionName, allocation.id, {
                                              targetCount: String(
                                                Math.max(
                                                  0,
                                                  Math.min(
                                                    Math.max(0, remainingCap),
                                                    Number(event.target.value) || 0,
                                                  ),
                                                ),
                                              ),
                                            })
                                          }
                                        />
                                        <select
                                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                                          style={getSelectStyle(selectedShiftById(allocation.shiftId ? Number(allocation.shiftId) : null))}
                                          value={allocation.shiftId}
                                          onChange={(event) =>
                                            setBulkAllocation(positionName, allocation.id, {
                                              shiftId: event.target.value,
                                            })
                                          }
                                        >
                                          <option value="">Pick shift</option>
                                          {workingShifts.map((shift) => (
                                            <option
                                              key={shift.id}
                                              value={shift.id}
                                              style={
                                                shift.colorHex
                                                  ? {
                                                      color: shift.colorHex,
                                                      backgroundColor: `${shift.colorHex}14`,
                                                    }
                                                  : undefined
                                              }
                                            >
                                              {shift.code}
                                            </option>
                                          ))}
                                        </select>
                                        <Button
                                          type="button"
                                          size="icon-sm"
                                          variant="outline"
                                          onClick={() => removeBulkAllocation(positionName, allocation.id)}
                                          disabled={allocations.length === 1}
                                        >
                                          <X className="h-4 w-4" />
                                        </Button>
                                      </div>
                                    );
                                  })}
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-2 px-4"
                                    onClick={() => addBulkAllocation(positionName)}
                                    disabled={allocatedTotal >= activeCount}
                                  >
                                    <Plus className="h-4 w-4" />
                                    Add allocation
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        },
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-3 border-t px-7 py-5">
            <Button type="button" variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleApplyBulkAction}
              disabled={
                bulkDayKeys.length === 0 ||
                (bulkMode === "replace" && bulkSourceMode === "shift" && !bulkSourceShiftId) ||
                (bulkMode === "headcount" &&
                  ((bulkTargetMode === "bucket" && !bulkAssignShiftId) ||
                    (bulkTargetMode === "shift" && !bulkHeadcountTargetShiftId))) ||
                (bulkMode === "positionAllocate" &&
                  (bulkPositionNames.length ? bulkPositionNames : positionOptions).every(
                    (positionName) =>
                      getBulkAllocations(positionName).every(
                        (allocation) =>
                          !allocation.shiftId || Number(allocation.targetCount ?? 0) <= 0,
                      ),
                  ))
              }
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
