"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ATTENDANCE_SECURITY_SETTINGS_ID,
  ATTENDANCE_PUNCH_MODES,
  DEFAULT_ATTENDANCE_SECURITY_SETTINGS,
  FACE_MATCH_DEFAULT_DISTANCE,
  FACE_MATCH_MAX_DISTANCE,
  FACE_MATCH_MIN_DISTANCE,
  canManageAttendanceSecuritySettings,
  deriveLegacyFaceFlags,
  hasAttendanceFaceChallengeSchema,
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
  activeFaceChallengeRequired?: boolean;
  identityContinuityRequired?: boolean;
  passiveAntiSpoofRequired?: boolean;
  faceChallengeExpiresSeconds?: number;
  faceChallengeMaxFrames?: number;
  faceChallengeMaxPayloadBytes?: number;
  faceChallengeMaxAttemptsPerMinute?: number;
  faceChallengeMaxFailures?: number;
  faceChallengeCooldownSeconds?: number;
  faceContinuityFrameCount?: number;
  faceContinuityMaxDistance?: number;
}) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canManageAttendanceSecuritySettings(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const [hasModeColumn, hasChallengeSchema] = await Promise.all([
      hasAttendancePunchModeColumn(),
      hasAttendanceFaceChallengeSchema(),
    ]);
    const attendancePunchMode =
      input.attendancePunchMode ===
        ATTENDANCE_PUNCH_MODES.EMPLOYEE_QR_KIOSK_FACE ||
      input.attendancePunchMode ===
        ATTENDANCE_PUNCH_MODES.SEARCH_EMPLOYEE_KIOSK_FACE
        ? input.attendancePunchMode
        : ATTENDANCE_PUNCH_MODES.QR_ONLY;
    const legacyFlags = deriveLegacyFaceFlags(attendancePunchMode);
    if (
      !hasChallengeSchema &&
      attendancePunchMode !== ATTENDANCE_PUNCH_MODES.QR_ONLY
    ) {
      return {
        success: false,
        error: "Apply secure face challenge migration before enabling face mode.",
      };
    }
    const clampInteger = (value: unknown, min: number, max: number, fallback: number) =>
      Math.max(min, Math.min(max, Math.round(Number(value) || fallback)));

    const data = {
      gpsValidationEnabled: Boolean(input.gpsValidationEnabled),
      ...(hasModeColumn ? { attendancePunchMode } : {}),
      faceRecognitionEnabled: legacyFlags.faceRecognitionEnabled,
      faceRequiredForQrPunch: legacyFlags.faceRequiredForQrPunch,
      faceLivenessRequired:
        attendancePunchMode === ATTENDANCE_PUNCH_MODES.QR_ONLY
          ? input.faceLivenessRequired !== false
          : true,
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
      ...(hasChallengeSchema
        ? {
            activeFaceChallengeRequired:
              attendancePunchMode === ATTENDANCE_PUNCH_MODES.QR_ONLY
                ? input.activeFaceChallengeRequired !== false
                : true,
            identityContinuityRequired:
              attendancePunchMode === ATTENDANCE_PUNCH_MODES.QR_ONLY
                ? input.identityContinuityRequired !== false
                : true,
            passiveAntiSpoofRequired: input.passiveAntiSpoofRequired === true,
            faceChallengeExpiresSeconds: clampInteger(
              input.faceChallengeExpiresSeconds,
              15,
              30,
              20,
            ),
            faceChallengeActionCount: 2,
            faceChallengeMaxFrames: clampInteger(
              input.faceChallengeMaxFrames,
              18,
              24,
              24,
            ),
            faceChallengeMaxPayloadBytes: clampInteger(
              input.faceChallengeMaxPayloadBytes,
              500_000,
              1_500_000,
              1_250_000,
            ),
            faceChallengeMaxAttemptsPerMinute: clampInteger(
              input.faceChallengeMaxAttemptsPerMinute,
              1,
              10,
              5,
            ),
            faceChallengeMaxFailures: clampInteger(
              input.faceChallengeMaxFailures,
              1,
              10,
              3,
            ),
            faceChallengeCooldownSeconds: clampInteger(
              input.faceChallengeCooldownSeconds,
              10,
              300,
              60,
            ),
            faceContinuityFrameCount: clampInteger(
              input.faceContinuityFrameCount,
              5,
              8,
              5,
            ),
            faceContinuityMaxDistance: Math.max(
              0.25,
              Math.min(
                0.45,
                Number(input.faceContinuityMaxDistance) || 0.35,
              ),
            ),
          }
        : {}),
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
        ...(hasChallengeSchema
          ? {
              activeFaceChallengeRequired: true,
              identityContinuityRequired: true,
              passiveAntiSpoofRequired: true,
              faceChallengeExpiresSeconds: true,
              faceChallengeActionCount: true,
              faceChallengeMaxFrames: true,
              faceChallengeMaxPayloadBytes: true,
              faceChallengeMaxAttemptsPerMinute: true,
              faceChallengeMaxFailures: true,
              faceChallengeCooldownSeconds: true,
              faceContinuityFrameCount: true,
              faceContinuityMaxDistance: true,
            }
          : {}),
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
        activeFaceChallengeRequired:
          row.activeFaceChallengeRequired ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.activeFaceChallengeRequired,
        identityContinuityRequired:
          row.identityContinuityRequired ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.identityContinuityRequired,
        passiveAntiSpoofRequired:
          row.passiveAntiSpoofRequired ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.passiveAntiSpoofRequired,
        faceChallengeExpiresSeconds:
          row.faceChallengeExpiresSeconds ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeExpiresSeconds,
        faceChallengeActionCount:
          row.faceChallengeActionCount ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeActionCount,
        faceChallengeMaxFrames:
          row.faceChallengeMaxFrames ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeMaxFrames,
        faceChallengeMaxPayloadBytes:
          row.faceChallengeMaxPayloadBytes ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeMaxPayloadBytes,
        faceChallengeMaxAttemptsPerMinute:
          row.faceChallengeMaxAttemptsPerMinute ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeMaxAttemptsPerMinute,
        faceChallengeMaxFailures:
          row.faceChallengeMaxFailures ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeMaxFailures,
        faceChallengeCooldownSeconds:
          row.faceChallengeCooldownSeconds ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceChallengeCooldownSeconds,
        faceContinuityFrameCount:
          row.faceContinuityFrameCount ??
          DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceContinuityFrameCount,
        faceContinuityMaxDistance: Number(
          row.faceContinuityMaxDistance ??
            DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceContinuityMaxDistance,
        ),
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
