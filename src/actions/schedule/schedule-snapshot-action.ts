"use server";

import { db } from "@/lib/db";
import { getDailySchedule } from "@/lib/schedule";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { serializeShift } from "@/lib/serializers/schedule";
import { shiftSelect } from "./schedule-shared";

export async function getScheduleSnapshot(dateParam?: string) {
  try {
    await requireScheduleManager();
    const date = dateParam ? new Date(dateParam) : new Date();
    if (Number.isNaN(date.getTime())) {
      return { success: false, error: "Invalid date" };
    }

    const [schedule, shifts] = await Promise.all([
      getDailySchedule(date),
      db.shift.findMany({
        where: { isActive: true },
        orderBy: [{ isDayOff: "asc" }, { name: "asc" }],
        select: shiftSelect,
      }),
    ]);

    const normalizedSchedule = schedule.map((entry) => ({
      employee: entry.employee,
      shift: entry.shift ? serializeShift(entry.shift) : null,
      source: entry.source,
      scheduledStartMinutes: entry.scheduledStartMinutes,
      scheduledEndMinutes: entry.scheduledEndMinutes,
    }));

    return {
      success: true,
      date: date.toISOString(),
      schedule: normalizedSchedule,
      shifts: shifts.map((shift) => serializeShift(shift)),
    };
  } catch (error) {
    console.error("Failed to fetch schedule", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to load schedule"),
    };
  }
}
