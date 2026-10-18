"use server";

import { getSession } from "@/lib/auth";
import {
  createPunchAndMaybeRecompute,
} from "@/lib/attendance";
import { publishAttendanceUpdate } from "@/lib/attendance-live/service";
import {
  ATTENDANCE_PUNCH_MODES,
  ensureAttendanceSecuritySettings,
  resolveAttendanceRequestMetadata,
  serializeAttendanceSecurityClientConfig,
} from "./attendance-security-shared";
import { captureAttendanceSecurityEvent } from "./attendance-security-service";
import {
  buildPunchSuccessPayload,
  encodeEmployeeQrToken,
  ensureEmployeeQrIdentity,
  loadActiveEmployeeIdentityByEmployeeId,
  loadActiveEmployeeIdentityByUserId,
  prepareKioskPunchContext,
  toActiveEmployeeIdentity,
} from "./attendance-kiosk-flow-shared";
import {
  isKioskPunchIpAllowed,
  serializeKioskPunch,
} from "./kiosk-attendance-shared";

const EMPLOYEE_QR_TTL_MS = 10_000;

export async function getKioskAttendanceConfig() {
  try {
    const settings = await ensureAttendanceSecuritySettings();
    return {
      success: true,
      data: serializeAttendanceSecurityClientConfig(settings),
    };
  } catch (error) {
    console.error("Failed to load kiosk attendance config", error);
    return { success: false, error: "Failed to load kiosk attendance config" };
  }
}

export async function getEmployeeAttendanceQr() {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return { success: false, error: "Unauthorized", reason: "unauthorized" };
    }

    const identity = toActiveEmployeeIdentity(
      await loadActiveEmployeeIdentityByUserId(session.userId),
    );
    if (!identity || identity.isDisabled || identity.isArchived) {
      return {
        success: false,
        error: "Employee not found for user",
        reason: "employee_not_found",
      };
    }

    const settings = await ensureAttendanceSecuritySettings();
    const expiresAt = Date.now() + EMPLOYEE_QR_TTL_MS;
    const token = encodeEmployeeQrToken({
      userId: identity.userId,
      employeeId: identity.employeeId,
      exp: expiresAt,
    });

    return {
      success: true,
      data: {
        token,
        expiresAt,
        employeeId: identity.employeeId,
        employeeCode: identity.employeeCode,
        employeeName: `${identity.firstName} ${identity.lastName}`.trim(),
        attendancePunchMode: settings.attendancePunchMode,
      },
    };
  } catch (error) {
    console.error("Failed to generate employee attendance QR", error);
    return {
      success: false,
      error: "Failed to generate employee attendance QR",
    };
  }
}

export async function resolveEmployeeAttendanceQr(input: { token: string }) {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    if (!isKioskPunchIpAllowed(requestMetadata.ipAddress)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const resolved = await ensureEmployeeQrIdentity(input.token);
    if (!resolved.success) {
      return resolved;
    }

    const context = await prepareKioskPunchContext(resolved.data);
    if (!context.success) {
      return context;
    }

    return {
      success: true,
      data: {
        username: context.data.employee.username,
        employeeId: context.data.employee.employeeId,
        employeeCode: context.data.employee.employeeCode,
        employeeName:
          `${context.data.employee.firstName} ${context.data.employee.lastName}`.trim(),
        nextPunch: context.data.nextPunch,
      },
    };
  } catch (error) {
    console.error("Failed to resolve employee attendance QR", error);
    return {
      success: false,
      error: "Failed to resolve employee attendance QR",
    };
  }
}

export async function recordKioskResolvedPunch(input: {
  token: string;
  latitude?: number | null;
  longitude?: number | null;
}) {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    if (!isKioskPunchIpAllowed(requestMetadata.ipAddress)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const settings = await ensureAttendanceSecuritySettings();
    if (settings.attendancePunchMode !== ATTENDANCE_PUNCH_MODES.QR_ONLY) {
      return {
        success: false,
        error: "QR-only punch mode is not active.",
        reason: "invalid_mode",
      };
    }

    const resolved = await ensureEmployeeQrIdentity(input.token);
    if (!resolved.success) {
      return resolved;
    }

    const context = await prepareKioskPunchContext(resolved.data);
    if (!context.success) {
      return context;
    }

    const result = await createPunchAndMaybeRecompute({
      employeeId: context.data.employee.employeeId,
      punchType: context.data.nextPunch,
      punchTime: context.data.now,
      workDate: context.data.dayStart,
      source: "KIOSK_QR",
      recompute: true,
    });

    if (result.attendance?.id) {
      await captureAttendanceSecurityEvent({
        punchId: result.punch.id,
        attendanceId: result.attendance.id,
        employeeId: context.data.employee.employeeId,
        punchTime: context.data.now,
        payload: {
          ...requestMetadata,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
        },
      });
    }

    await publishAttendanceUpdate({
      employeeId: context.data.employee.employeeId,
      workDate: context.data.dayStart,
      punchId: result.punch.id,
    });

    return {
      success: true,
      data: {
        ...buildPunchSuccessPayload(context.data, result.punch),
        punch: serializeKioskPunch(result.punch),
      },
    };
  } catch (error) {
    console.error("Failed to record kiosk resolved punch", error);
    return { success: false, error: "Failed to record punch" };
  }
}

export async function getSearchEmployeeFacePreview(input: {
  employeeId: string;
}) {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    if (!isKioskPunchIpAllowed(requestMetadata.ipAddress)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const employeeId =
      typeof input.employeeId === "string" ? input.employeeId.trim() : "";
    if (!employeeId) {
      return { success: false, error: "Employee ID is required" };
    }

    const identity = toActiveEmployeeIdentity(
      await loadActiveEmployeeIdentityByEmployeeId(employeeId),
    );
    if (!identity || identity.isDisabled || identity.isArchived) {
      return {
        success: false,
        error: "User not eligible",
        reason: "user_not_eligible",
      };
    }

    const context = await prepareKioskPunchContext(identity);
    if (!context.success) {
      return context;
    }

    return {
      success: true,
      data: {
        username: identity.username,
        employeeId: identity.employeeId,
        employeeCode: identity.employeeCode,
        employeeName: `${identity.firstName} ${identity.lastName}`.trim(),
        nextPunch: context.data.nextPunch,
      },
    };
  } catch (error) {
    console.error("Failed to load search employee face preview", error);
    return {
      success: false,
      error: "Failed to load employee face preview",
    };
  }
}
