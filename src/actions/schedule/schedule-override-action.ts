"use server";

import { db } from "@/lib/db";
import { serializeShift } from "@/lib/serializers/schedule";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import {
  endOfZonedDay,
  startOfZonedDay,
  zonedNow,
} from "@/lib/timezone";
import { parsePlannerDateInput } from "@/lib/week-planner";
import { shiftSelect } from "./schedule-shared";

export async function listScheduleOverrides(input?: {
  start?: string;
  end?: string;
}) {
  try {
    await requireScheduleManager();
    const startInput = input?.start ? new Date(input.start) : zonedNow();
    const endInput = input?.end ? new Date(input.end) : null;

    if (Number.isNaN(startInput.getTime())) {
      return { success: false, error: "Invalid start date" };
    }
    if (endInput && Number.isNaN(endInput.getTime())) {
      return { success: false, error: "Invalid end date" };
    }

    const start = startOfZonedDay(startInput);
    const end =
      endInput != null
        ? endOfZonedDay(endInput)
        : endOfZonedDay(new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000));

    const overrides = await db.employeeShiftOverride.findMany({
      where: {
        workDate: {
          gte: start,
          lt: end,
        },
      },
      orderBy: { workDate: "asc" },
      include: {
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
        },
        shift: { select: shiftSelect },
      },
    });

    const data = overrides.map((override) => ({
      id: override.id,
      workDate: override.workDate.toISOString(),
      source: override.source,
      note: override.note ?? null,
      employee: override.employee,
      shift: override.shift ? serializeShift(override.shift) : null,
    }));

    return { success: true, data };
  } catch (error) {
    console.error("Failed to list overrides", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to load overrides"),
    };
  }
}

export async function upsertScheduleOverride(input: {
  employeeId: string;
  workDate: string;
  shiftId?: number | null;
  source?: string | null;
}) {
  try {
    await requireScheduleManager();
    const employeeId =
      typeof input.employeeId === "string" && input.employeeId.trim()
        ? input.employeeId.trim()
        : "";
    const workDateRaw = input.workDate;
    const shiftId = typeof input.shiftId === "number" ? input.shiftId : null;
    const source =
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : "MANUAL";

    if (!employeeId) {
      return { success: false, error: "employeeId is required" };
    }

    const workDateInput = parsePlannerDateInput(workDateRaw);
    if (!workDateInput) {
      return { success: false, error: "workDate is invalid" };
    }
    const workDate = startOfZonedDay(workDateInput);

    const [employee, shift] = await Promise.all([
      db.employee.findUnique({
        where: { employeeId },
        select: { employeeId: true },
      }),
      shiftId
        ? db.shift.findUnique({ where: { id: shiftId }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    if (!employee) {
      return { success: false, error: "Employee not found" };
    }
    if (shiftId && !shift) {
      return { success: false, error: "Shift not found" };
    }

    const existing = await db.employeeShiftOverride.findFirst({
      where: { employeeId, workDate },
      select: { id: true },
    });

    const data = {
      employeeId,
      workDate,
      shiftId: shiftId ?? null,
      source,
    };

    const override = existing
      ? await db.employeeShiftOverride.update({ where: { id: existing.id }, data })
      : await db.employeeShiftOverride.create({ data });

    return {
      success: true,
      data: {
        id: override.id,
        employeeId: override.employeeId,
        workDate: override.workDate.toISOString(),
        shiftId: override.shiftId,
        source: override.source,
      },
    };
  } catch (error) {
    console.error("Failed to save override", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to save override"),
    };
  }
}

export async function deleteScheduleOverride(id: string) {
  try {
    await requireScheduleManager();
    const overrideId = typeof id === "string" ? id.trim() : "";
    if (!overrideId) {
      return { success: false, error: "id is required" };
    }
    const existing = await db.employeeShiftOverride.findUnique({
      where: { id: overrideId },
      select: { id: true },
    });
    if (!existing) {
      return { success: false, error: "Override not found" };
    }
    await db.employeeShiftOverride.delete({ where: { id: overrideId } });
    return { success: true };
  } catch (error) {
    console.error("Failed to delete override", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to delete override"),
    };
  }
}
