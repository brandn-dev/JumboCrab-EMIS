import { TZ_OFFSET_MINUTES, startOfZonedDay } from "@/lib/timezone";

export const WEEK_PLANNER_DAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type WeekPlannerDayKey = (typeof WEEK_PLANNER_DAYS)[number];

export type WeekShiftMap = Record<WeekPlannerDayKey, number | null>;

export const WEEK_SHIFT_FIELD_MAP: Record<
  WeekPlannerDayKey,
  | "monShiftId"
  | "tueShiftId"
  | "wedShiftId"
  | "thuShiftId"
  | "friShiftId"
  | "satShiftId"
  | "sunShiftId"
> = {
  mon: "monShiftId",
  tue: "tueShiftId",
  wed: "wedShiftId",
  thu: "thuShiftId",
  fri: "friShiftId",
  sat: "satShiftId",
  sun: "sunShiftId",
};

export const WEEKDAY_LABELS: Record<WeekPlannerDayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export type PlannerShiftLike = {
  id: number;
  code: string;
  name: string;
  isDayOff?: boolean | null;
  startMinutes: number;
  spansMidnight?: boolean | null;
};

export type ShiftBucket = "morning" | "afternoon" | "other";

export type CoverageCount = {
  shiftId: number;
  code: string;
  name: string;
  count: number;
};

export type CoverageDaySummary = {
  exact: CoverageCount[];
  buckets: {
    morning: number;
    afternoon: number;
    other: number;
  };
  unassigned: number;
};

export type CoverageSummary = Record<WeekPlannerDayKey, CoverageDaySummary>;

const normalizeInputDate = (value?: string | Date | null) => {
  if (!value) return new Date();
  if (value instanceof Date) return new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(
      Date.UTC(year, Math.max(0, month - 1), day, 12, 0, 0, 0),
    );
  }
  return new Date(value);
};

export const parsePlannerDateInput = (value: string) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day, 12));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }
    return parsed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

export const parseWeekStartInput = (value: string) => {
  const parsed = parsePlannerDateInput(value);
  return parsed ? normalizeWeekStart(parsed) : null;
};

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const toPlannerDateKey = (date: Date) => {
  const tzMs = date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000;
  const tzDate = new Date(tzMs);
  const year = tzDate.getUTCFullYear();
  const month = `${tzDate.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${tzDate.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const normalizeWeekStart = (value?: string | Date | null) => {
  const input = normalizeInputDate(value);
  if (Number.isNaN(input.getTime())) {
    return startOfZonedDay(new Date());
  }
  const dayStart = startOfZonedDay(input);
  const tzMs = dayStart.getTime() + TZ_OFFSET_MINUTES * 60 * 1000;
  const tzDate = new Date(tzMs);
  const weekday = tzDate.getUTCDay();
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  return startOfZonedDay(addDays(dayStart, diffToMonday));
};

export const getWeekDates = (weekStart: Date) =>
  WEEK_PLANNER_DAYS.map((dayKey, index) => ({
    dayKey,
    date: addDays(weekStart, index),
  }));

export const weekShiftMapFromValues = (
  values: Partial<
    Record<
      | "sunShiftId"
      | "monShiftId"
      | "tueShiftId"
      | "wedShiftId"
      | "thuShiftId"
      | "friShiftId"
      | "satShiftId",
      number | null | undefined
    >
  >,
): WeekShiftMap => ({
  mon: values.monShiftId ?? null,
  tue: values.tueShiftId ?? null,
  wed: values.wedShiftId ?? null,
  thu: values.thuShiftId ?? null,
  fri: values.friShiftId ?? null,
  sat: values.satShiftId ?? null,
  sun: values.sunShiftId ?? null,
});

export const getShiftBucket = (shift: PlannerShiftLike | null | undefined) => {
  if (!shift) return "other" as ShiftBucket;
  const haystack = `${shift.code} ${shift.name}`.toUpperCase();
  if (
    haystack.includes("AM") ||
    haystack.includes("MORNING")
  ) {
    return "morning" as ShiftBucket;
  }
  if (
    haystack.includes("PM") ||
    haystack.includes("AFTERNOON")
  ) {
    return "afternoon" as ShiftBucket;
  }
  if (shift.spansMidnight) {
    return "other" as ShiftBucket;
  }
  if (shift.startMinutes >= 240 && shift.startMinutes < 720) {
    return "morning" as ShiftBucket;
  }
  if (shift.startMinutes >= 720 && shift.startMinutes < 1080) {
    return "afternoon" as ShiftBucket;
  }
  return "other" as ShiftBucket;
};

export const emptyCoverageSummary = (): CoverageSummary =>
  WEEK_PLANNER_DAYS.reduce(
    (acc, dayKey) => {
      acc[dayKey] = {
        exact: [],
        buckets: {
          morning: 0,
          afternoon: 0,
          other: 0,
        },
        unassigned: 0,
      };
      return acc;
    },
    {} as CoverageSummary,
  );

export const computeCoverageSummary = <
  TRow extends { days: Record<WeekPlannerDayKey, { shiftId: number | null }> },
>(
  rows: TRow[],
  shiftsById: Map<number, PlannerShiftLike>,
) => {
  const summary = emptyCoverageSummary();

  for (const dayKey of WEEK_PLANNER_DAYS) {
    const counts = new Map<number, number>();

    for (const row of rows) {
      const shiftId = row.days[dayKey]?.shiftId ?? null;
      if (shiftId == null) {
        summary[dayKey].unassigned += 1;
        continue;
      }
      const shift = shiftsById.get(shiftId);
      if (!shift || shift.isDayOff) {
        continue;
      }
      counts.set(shiftId, (counts.get(shiftId) ?? 0) + 1);
      const bucket = getShiftBucket(shift);
      summary[dayKey].buckets[bucket] += 1;
    }

    summary[dayKey].exact = Array.from(counts.entries())
      .map(([shiftId, count]) => {
        const shift = shiftsById.get(shiftId);
        return shift
          ? {
              shiftId,
              code: shift.code,
              name: shift.name,
              count,
            }
          : null;
      })
      .filter((entry): entry is CoverageCount => entry != null)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  }

  return summary;
};

export const cloneWeekShiftMap = (map: WeekShiftMap): WeekShiftMap => ({
  mon: map.mon,
  tue: map.tue,
  wed: map.wed,
  thu: map.thu,
  fri: map.fri,
  sat: map.sat,
  sun: map.sun,
});

export const applyWeekShiftMap = <
  TRow extends { days: Record<WeekPlannerDayKey, { shiftId: number | null }> },
>(
  row: TRow,
  nextMap: WeekShiftMap,
) => {
  const nextDays = { ...row.days };
  for (const dayKey of WEEK_PLANNER_DAYS) {
    nextDays[dayKey] = {
      ...nextDays[dayKey],
      shiftId: nextMap[dayKey],
    };
  }
  return {
    ...row,
    days: nextDays,
  };
};

export const swapAmPmWeekShiftMap = (
  sourceMap: WeekShiftMap,
  shiftsById: Map<number, PlannerShiftLike>,
) => {
  const swapped = cloneWeekShiftMap(sourceMap);
  const morningByCode = new Map<string, number>();
  const afternoonByCode = new Map<string, number>();
  const morningShifts: PlannerShiftLike[] = [];
  const afternoonShifts: PlannerShiftLike[] = [];

  for (const shift of shiftsById.values()) {
    const bucket = getShiftBucket(shift);
    if (bucket === "morning") {
      morningShifts.push(shift);
      morningByCode.set(shift.code.toUpperCase(), shift.id);
    }
    if (bucket === "afternoon") {
      afternoonShifts.push(shift);
      afternoonByCode.set(shift.code.toUpperCase(), shift.id);
    }
  }

  const findSwapId = (shiftId: number | null) => {
    if (shiftId == null) return null;
    const shift = shiftsById.get(shiftId);
    if (!shift) return shiftId;
    const bucket = getShiftBucket(shift);
    if (bucket === "other") return shiftId;

    const candidates =
      bucket === "morning" ? afternoonShifts : morningShifts;
    const counterpartByCode =
      bucket === "morning" ? afternoonByCode : morningByCode;

    const exactCounterpart = counterpartByCode.get(
      shift.code
        .toUpperCase()
        .replace("AM", "TMP")
        .replace("PM", bucket === "morning" ? "AM" : "PM")
        .replace("TMP", "PM"),
    );
    if (exactCounterpart) return exactCounterpart;

    const fallback = candidates.find(
      (candidate) =>
        candidate.startMinutes === shift.startMinutes ||
        candidate.name.replace(/Morning|Afternoon|AM|PM/gi, "").trim() ===
          shift.name.replace(/Morning|Afternoon|AM|PM/gi, "").trim(),
    );
    return fallback?.id ?? shiftId;
  };

  for (const dayKey of WEEK_PLANNER_DAYS) {
    swapped[dayKey] = findSwapId(sourceMap[dayKey]);
  }

  return swapped;
};
