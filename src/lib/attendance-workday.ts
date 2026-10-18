const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60 * 1000;

export const ATTENDANCE_SHIFT_END_GRACE_MINUTES = 60;

export type AttendanceShiftWindowInput = {
  startMinutes: number | null;
  endMinutes: number | null;
  spansMidnight: boolean;
};

export type AttendanceWorkdayWindow = {
  dayStart: Date;
  scheduledStartMinutes: number | null;
  scheduledEndMinutes: number | null;
  normalizedEndMinutes: number | null;
  spansMidnight: boolean;
  punchWindowStart: Date;
  punchWindowEnd: Date;
};

export const normalizeScheduledEndMinutes = (
  input: AttendanceShiftWindowInput,
) => {
  if (input.endMinutes == null) return null;
  if (
    input.spansMidnight &&
    input.startMinutes != null &&
    input.endMinutes <= input.startMinutes
  ) {
    return input.endMinutes + MINUTES_PER_DAY;
  }
  return input.endMinutes;
};

export const buildAttendanceWorkdayWindow = (
  dayStart: Date,
  input: AttendanceShiftWindowInput,
  graceMinutes = ATTENDANCE_SHIFT_END_GRACE_MINUTES,
): AttendanceWorkdayWindow => {
  const normalizedDayStart = new Date(dayStart);
  const normalizedEndMinutes = normalizeScheduledEndMinutes(input);
  const spansMidnight =
    input.spansMidnight &&
    input.startMinutes != null &&
    input.endMinutes != null &&
    input.endMinutes <= input.startMinutes;
  const punchWindowStart = spansMidnight
    ? new Date(
        normalizedDayStart.getTime() + input.startMinutes! * MINUTE_MS,
      )
    : normalizedDayStart;
  const punchWindowEnd = spansMidnight
    ? new Date(
        normalizedDayStart.getTime() +
          (normalizedEndMinutes! + Math.max(0, graceMinutes)) * MINUTE_MS,
      )
    : new Date(normalizedDayStart.getTime() + MINUTES_PER_DAY * MINUTE_MS);

  return {
    dayStart: normalizedDayStart,
    scheduledStartMinutes: input.startMinutes,
    scheduledEndMinutes: input.endMinutes,
    normalizedEndMinutes,
    spansMidnight,
    punchWindowStart,
    punchWindowEnd,
  };
};

export const getTimeInRestriction = (
  window: AttendanceWorkdayWindow,
  moment: Date,
): "no_shift_today" | "too_early" | "too_late" | null => {
  if (
    window.scheduledStartMinutes == null ||
    window.normalizedEndMinutes == null
  ) {
    return "no_shift_today";
  }
  const minutesSinceDayStart = Math.round(
    (moment.getTime() - window.dayStart.getTime()) / MINUTE_MS,
  );
  if (minutesSinceDayStart < window.scheduledStartMinutes) {
    return "too_early";
  }
  if (minutesSinceDayStart > window.normalizedEndMinutes) {
    return "too_late";
  }
  return null;
};

export const isActiveOvernightCarryover = (
  window: AttendanceWorkdayWindow,
  moment: Date,
) =>
  window.spansMidnight &&
  moment >= window.punchWindowStart &&
  moment < window.punchWindowEnd;
