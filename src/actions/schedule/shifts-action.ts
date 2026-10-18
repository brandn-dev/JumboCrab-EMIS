"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { serializeShift } from "@/lib/serializers/schedule";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";

const parseTimeToMinutes = (value: string | null | undefined) => {
  if (!value) return null;
  const [h, m] = value.split(":").map((v) => Number(v));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
};

const computeBreakAndPaid = (
  startMinutes: number,
  endMinutes: number,
  spansMidnight: boolean,
  breakStartMinutes: number | null,
  breakEndMinutes: number | null
) => {
  let totalMinutes =
    spansMidnight && endMinutes <= startMinutes
      ? endMinutes + 24 * 60 - startMinutes
      : endMinutes - startMinutes;
  if (totalMinutes < 0) totalMinutes = 0;

  let breakMinutes = 0;
  if (breakStartMinutes != null && breakEndMinutes != null) {
    let endVal = breakEndMinutes;
    if (spansMidnight && breakEndMinutes <= breakStartMinutes) {
      endVal += 24 * 60;
    }
    breakMinutes = Math.max(0, Math.min(totalMinutes, endVal - breakStartMinutes));
  }

  const paidHours =
    totalMinutes > 0 ? Number(((totalMinutes - breakMinutes) / 60).toFixed(2)) : 0;

  return { breakMinutes, paidHours, totalMinutes };
};

const normalizeColorHex = (value: string | null | undefined) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^#([0-9a-fA-F]{6})$/.test(trimmed) ? trimmed.toUpperCase() : "__INVALID__";
};

const ensureSingleDayOffShift = async (shiftId?: number) => {
  const existing = await db.shift.findFirst({
    where: {
      isDayOff: true,
      ...(shiftId ? { id: { not: shiftId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw new Error("Only one Day Off shift can exist");
  }
};

const shiftSelect = {
  id: true,
  code: true,
  name: true,
  colorHex: true,
  isDayOff: true,
  startMinutes: true,
  endMinutes: true,
  spansMidnight: true,
  breakStartMinutes: true,
  breakEndMinutes: true,
  breakMinutesUnpaid: true,
  paidHoursPerDay: true,
  notes: true,
};

export async function listShifts() {
  try {
    await requireScheduleManager();
    const shifts = await db.shift.findMany({
      where: { isActive: true },
      orderBy: [{ isDayOff: "asc" }, { startMinutes: "asc" }, { name: "asc" }],
      select: shiftSelect,
    });
    return { success: true, data: shifts.map((s) => serializeShift(s)) };
  } catch (error) {
    console.error("Failed to list shifts", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to load shifts"),
    };
  }
}

export async function createShift(input: {
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  spansMidnight?: boolean;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  notes?: string | null;
  colorHex?: string | null;
  isDayOff?: boolean;
}) {
  try {
    await requireScheduleManager();
    const isDayOff = Boolean(input.isDayOff);
    const code = (typeof input.code === "string" ? input.code.trim() : "") || (isDayOff ? "OFF" : "");
    const name =
      (typeof input.name === "string" ? input.name.trim() : "") || (isDayOff ? "Day Off" : "");
    const startMinutes = isDayOff ? 0 : parseTimeToMinutes(input.startTime);
    const endMinutes = isDayOff ? 0 : parseTimeToMinutes(input.endTime);
    const spansMidnight = isDayOff ? false : Boolean(input.spansMidnight);
    const breakStartMinutes = isDayOff ? null : parseTimeToMinutes(input.breakStartTime);
    const breakEndMinutes = isDayOff ? null : parseTimeToMinutes(input.breakEndTime);
    const notes =
      typeof input.notes === "string" ? input.notes.trim() : null;
    const colorHex = normalizeColorHex(input.colorHex);

    if (!code || !name) {
      return { success: false, error: "code and name are required" };
    }
    if (colorHex === "__INVALID__") {
      return { success: false, error: "colorHex must be a valid #RRGGBB value" };
    }
    if (!isDayOff && (startMinutes == null || endMinutes == null)) {
      return { success: false, error: "startTime and endTime must be HH:mm" };
    }
    const safeStartMinutes = startMinutes ?? 0;
    const safeEndMinutes = endMinutes ?? 0;
    if (!isDayOff && !spansMidnight && safeEndMinutes <= safeStartMinutes) {
      return {
        success: false,
        error: "endTime must be after startTime unless spansMidnight is true",
      };
    }
    if (isDayOff) {
      await ensureSingleDayOffShift();
    }

    const derived = isDayOff
      ? { breakMinutes: 0, paidHours: 0, totalMinutes: 0 }
      : computeBreakAndPaid(
          safeStartMinutes,
          safeEndMinutes,
          spansMidnight,
          breakStartMinutes,
          breakEndMinutes
        );

    const shift = await db.shift.create({
      data: {
        code,
        name,
        colorHex: colorHex === "__INVALID__" ? null : colorHex,
        isDayOff,
        startMinutes: safeStartMinutes,
        endMinutes: safeEndMinutes,
        spansMidnight,
        breakStartMinutes,
        breakEndMinutes,
        breakMinutesUnpaid: derived.breakMinutes,
        paidHoursPerDay: new Prisma.Decimal(derived.paidHours.toFixed(2)),
        notes,
      },
      select: shiftSelect,
    });

    return { success: true, data: serializeShift(shift) };
  } catch (error) {
    console.error("Failed to create shift", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to create shift"),
    };
  }
}

export async function updateShift(input: {
  id: number;
  code?: string;
  name?: string;
  startTime?: string | null;
  endTime?: string | null;
  spansMidnight?: boolean;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  notes?: string | null;
  colorHex?: string | null;
  isDayOff?: boolean;
}) {
  try {
    await requireScheduleManager();
    const id = typeof input.id === "number" ? input.id : null;
    if (!id) {
      return { success: false, error: "id is required" };
    }

    const existing = await db.shift.findUnique({ where: { id } });
    if (!existing) {
      return { success: false, error: "Shift not found" };
    }

    const code =
      (typeof input.code === "string" && input.code.trim()
        ? input.code.trim()
        : existing.code) || "OFF";
    const name =
      (typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : existing.name) || "Day Off";
    const isDayOff =
      typeof input.isDayOff === "boolean" ? input.isDayOff : existing.isDayOff;
    const startMinutes =
      isDayOff
        ? 0
        : input.startTime != null
          ? parseTimeToMinutes(input.startTime)
          : existing.startMinutes;
    const endMinutes =
      isDayOff
        ? 0
        : input.endTime != null
          ? parseTimeToMinutes(input.endTime)
          : existing.endMinutes;
    const spansMidnight =
      isDayOff
        ? false
        : typeof input.spansMidnight === "boolean"
        ? input.spansMidnight
        : existing.spansMidnight;
    const breakStartMinutes =
      isDayOff
        ? null
        : input.breakStartTime != null
        ? parseTimeToMinutes(input.breakStartTime)
        : existing.breakStartMinutes;
    const breakEndMinutes =
      isDayOff
        ? null
        : input.breakEndTime != null
        ? parseTimeToMinutes(input.breakEndTime)
        : existing.breakEndMinutes;
    const notes =
      typeof input.notes === "string" ? input.notes.trim() : existing.notes ?? null;
    const colorHex =
      input.colorHex !== undefined
        ? normalizeColorHex(input.colorHex)
        : existing.colorHex ?? null;

    if (!code || !name) {
      return { success: false, error: "code and name are required" };
    }
    if (colorHex === "__INVALID__") {
      return { success: false, error: "colorHex must be a valid #RRGGBB value" };
    }
    if (!isDayOff && (startMinutes == null || endMinutes == null)) {
      return { success: false, error: "startTime and endTime must be HH:mm" };
    }
    const safeStartMinutes = startMinutes ?? 0;
    const safeEndMinutes = endMinutes ?? 0;
    if (!isDayOff && !spansMidnight && safeEndMinutes <= safeStartMinutes) {
      return {
        success: false,
        error: "endTime must be after startTime unless spansMidnight is true",
      };
    }
    if (isDayOff) {
      await ensureSingleDayOffShift(id);
    }

    const derived = isDayOff
      ? { breakMinutes: 0, paidHours: 0, totalMinutes: 0 }
      : computeBreakAndPaid(
          safeStartMinutes,
          safeEndMinutes,
          spansMidnight,
          breakStartMinutes,
          breakEndMinutes
        );

    const shift = await db.shift.update({
      where: { id },
      data: {
        code,
        name,
        colorHex: colorHex === "__INVALID__" ? null : colorHex,
        isDayOff,
        startMinutes: safeStartMinutes,
        endMinutes: safeEndMinutes,
        spansMidnight,
        breakStartMinutes,
        breakEndMinutes,
        breakMinutesUnpaid: derived.breakMinutes,
        paidHoursPerDay: new Prisma.Decimal(derived.paidHours.toFixed(2)),
        notes,
      },
      select: shiftSelect,
    });

    return { success: true, data: serializeShift(shift) };
  } catch (error) {
    console.error("Failed to update shift", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to update shift"),
    };
  }
}

export async function deleteShift(id: number) {
  try {
    await requireScheduleManager();
    if (!id || Number.isNaN(Number(id))) {
      return { success: false, error: "id is required" };
    }
    const existing = await db.shift.findUnique({ where: { id } });
    if (!existing) {
      return { success: false, error: "Shift not found" };
    }
    if (!existing.isActive) {
      return { success: true };
    }
    await db.shift.update({
      where: { id },
      data: { isActive: false },
    });
    return { success: true };
  } catch (error) {
    console.error("Failed to archive shift", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to archive shift"),
    };
  }
}
