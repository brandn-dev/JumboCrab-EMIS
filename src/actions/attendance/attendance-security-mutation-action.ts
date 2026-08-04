"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ATTENDANCE_SECURITY_SETTINGS_ID,
  ATTENDANCE_PUNCH_MODES,
  FACE_MATCH_DEFAULT_DISTANCE,
  FACE_MATCH_MAX_DISTANCE,
  FACE_MATCH_MIN_DISTANCE,
  canManageAttendanceSecuritySettings,
  deriveLegacyFaceFlags,
  hasAttendancePunchModeColumn,
  serializeAttendanceSecuritySettings,
} from "./attendance-security-shared";

const revalidateAttendanceSecurityPaths = () => {
  [
    "/admin/attendance/history",
    "/admin/attendance/settings",
    "/manager/attendance/history",
  ].forEach((path) => {
    revalidatePath(path);
  });
};

export async function updateAttendanceSecuritySettings(input: {
  gpsValidationEnabled: boolean;
  attendancePunchMode?: string;
  faceRecognitionEnabled?: boolean;
  faceRequiredForQrPunch?: boolean;
  faceLivenessRequired?: boolean;
  faceMatchMaxDistance?: number;
  faceFailureMode?: string;
}) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canManageAttendanceSecuritySettings(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const hasModeColumn = await hasAttendancePunchModeColumn();
    const attendancePunchMode =
      input.attendancePunchMode ===
        ATTENDANCE_PUNCH_MODES.EMPLOYEE_QR_KIOSK_FACE ||
      input.attendancePunchMode ===
        ATTENDANCE_PUNCH_MODES.SEARCH_EMPLOYEE_KIOSK_FACE
        ? input.attendancePunchMode
        : ATTENDANCE_PUNCH_MODES.QR_ONLY;
    const legacyFlags = deriveLegacyFaceFlags(attendancePunchMode);

    const data = {
      gpsValidationEnabled: Boolean(input.gpsValidationEnabled),
      ...(hasModeColumn ? { attendancePunchMode } : {}),
      faceRecognitionEnabled: legacyFlags.faceRecognitionEnabled,
      faceRequiredForQrPunch: legacyFlags.faceRequiredForQrPunch,
      faceLivenessRequired: input.faceLivenessRequired !== false,
      faceMatchMaxDistance: Math.max(
        FACE_MATCH_MIN_DISTANCE,
        Math.min(
          FACE_MATCH_MAX_DISTANCE,
          Number(input.faceMatchMaxDistance) || FACE_MATCH_DEFAULT_DISTANCE,
        ),
      ),
      faceFailureMode:
        typeof input.faceFailureMode === "string" &&
        input.faceFailureMode.toUpperCase() === "FLAG"
          ? "FLAG"
          : "BLOCK",
      updatedByUserId: session.userId ?? null,
    };

    const row = await db.attendanceSecuritySetting.upsert({
      where: { id: ATTENDANCE_SECURITY_SETTINGS_ID },
      update: data,
      create: {
        id: ATTENDANCE_SECURITY_SETTINGS_ID,
        ...data,
      },
      select: {
        id: true,
        gpsValidationEnabled: true,
        ...(hasModeColumn ? { attendancePunchMode: true } : {}),
        faceRecognitionEnabled: true,
        faceRequiredForQrPunch: true,
        faceLivenessRequired: true,
        faceMatchMaxDistance: true,
        faceFailureMode: true,
        updatedByUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    revalidateAttendanceSecurityPaths();

    return {
      success: true,
      data: serializeAttendanceSecuritySettings({
        id: row.id,
        gpsValidationEnabled: row.gpsValidationEnabled,
        attendancePunchMode,
        faceRecognitionEnabled: legacyFlags.faceRecognitionEnabled,
        faceRequiredForQrPunch: legacyFlags.faceRequiredForQrPunch,
        faceLivenessRequired: row.faceLivenessRequired,
        faceMatchMaxDistance: Number(row.faceMatchMaxDistance),
        faceFailureMode: row.faceFailureMode,
        updatedByUserId: row.updatedByUserId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    };
  } catch (error) {
    console.error("Failed to update attendance security settings", error);
    return {
      success: false,
      error: "Failed to update attendance security settings",
    };
  }
}
