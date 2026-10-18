import { headers } from "next/headers";
import { Roles, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const ATTENDANCE_SECURITY_SETTINGS_ID = "default";

export const ATTENDANCE_PUNCH_MODES = {
  QR_ONLY: "QR_ONLY",
  EMPLOYEE_QR_KIOSK_FACE: "EMPLOYEE_QR_KIOSK_FACE",
  SEARCH_EMPLOYEE_KIOSK_FACE: "SEARCH_EMPLOYEE_KIOSK_FACE",
} as const;

export const FACE_MATCH_MIN_DISTANCE = 0.35;
export const FACE_MATCH_MAX_DISTANCE = 0.55;
export const FACE_MATCH_DEFAULT_DISTANCE = 0.35;
export const FACE_MATCH_AMBIGUITY_MARGIN = 0.05;

export type AttendancePunchModeValue =
  (typeof ATTENDANCE_PUNCH_MODES)[keyof typeof ATTENDANCE_PUNCH_MODES];

export const DEFAULT_ATTENDANCE_SECURITY_SETTINGS = {
  gpsValidationEnabled: false,
  attendancePunchMode: ATTENDANCE_PUNCH_MODES.QR_ONLY,
  faceRecognitionEnabled: false,
  faceRequiredForQrPunch: false,
  faceLivenessRequired: false,
  faceMatchMaxDistance: FACE_MATCH_DEFAULT_DISTANCE,
  faceFailureMode: "BLOCK",
} as const;

export type AttendanceSecurityClient = Prisma.TransactionClient | typeof db;

export type AttendanceSecurityPayload = {
  ipAddress?: string | null;
  userAgent?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type ResolvedAttendanceSecuritySettings = {
  id: string;
  gpsValidationEnabled: boolean;
  attendancePunchMode: AttendancePunchModeValue;
  faceRecognitionEnabled: boolean;
  faceRequiredForQrPunch: boolean;
  faceLivenessRequired: boolean;
  faceMatchMaxDistance: number;
  faceFailureMode: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let cachedHasAttendancePunchModeColumn: boolean | null = null;

export const canManageAttendanceSecuritySettings = (role?: Roles) =>
  role === Roles.Admin;

export const normalizeAttendancePunchMode = (
  value: unknown,
): AttendancePunchModeValue => {
  switch (value) {
    case ATTENDANCE_PUNCH_MODES.EMPLOYEE_QR_KIOSK_FACE:
      return ATTENDANCE_PUNCH_MODES.EMPLOYEE_QR_KIOSK_FACE;
    case ATTENDANCE_PUNCH_MODES.SEARCH_EMPLOYEE_KIOSK_FACE:
      return ATTENDANCE_PUNCH_MODES.SEARCH_EMPLOYEE_KIOSK_FACE;
    default:
      return ATTENDANCE_PUNCH_MODES.QR_ONLY;
  }
};

export const deriveLegacyFaceFlags = (mode: AttendancePunchModeValue) => ({
  faceRecognitionEnabled: mode !== ATTENDANCE_PUNCH_MODES.QR_ONLY,
  faceRequiredForQrPunch: mode !== ATTENDANCE_PUNCH_MODES.QR_ONLY,
});

const normalizeCoordinate = (
  value: number | null | undefined,
  min: number,
  max: number,
) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
};

export const normalizeLatitude = (value: number | null | undefined) =>
  normalizeCoordinate(value, -90, 90);

export const normalizeLongitude = (value: number | null | undefined) =>
  normalizeCoordinate(value, -180, 180);

export const resolveAttendanceRequestMetadata = async () => {
  const hdr = await headers();

  return {
    ipAddress:
      hdr.get("x-forwarded-for")?.split(",")[0].trim() ||
      hdr.get("x-real-ip") ||
      null,
    userAgent: hdr.get("user-agent") || null,
  };
};

export const hasAttendancePunchModeColumn = async () => {
  if (cachedHasAttendancePunchModeColumn != null) {
    return cachedHasAttendancePunchModeColumn;
  }

  try {
    const rows = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AttendanceSecuritySetting'
          AND column_name = 'attendancePunchMode'
      ) AS "exists"
    `;
    cachedHasAttendancePunchModeColumn = Boolean(rows[0]?.exists);
    return cachedHasAttendancePunchModeColumn;
  } catch (error) {
    console.error("Could not check attendancePunchMode column existence:", error);
    cachedHasAttendancePunchModeColumn = false;
    return cachedHasAttendancePunchModeColumn;
  }
};

const buildAttendanceSecuritySelect = (hasModeColumn: boolean) =>
  ({
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
  }) as const;

const hydrateAttendanceSecuritySettings = (
  row: {
    id: string;
    gpsValidationEnabled: boolean;
    faceRecognitionEnabled: boolean;
    faceRequiredForQrPunch: boolean;
    faceLivenessRequired: boolean;
    faceMatchMaxDistance: Prisma.Decimal | number;
    faceFailureMode: string;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
    attendancePunchMode?: string | null;
  },
  hasModeColumn: boolean,
): ResolvedAttendanceSecuritySettings => {
  const legacyMode =
    row.faceRecognitionEnabled && row.faceRequiredForQrPunch
      ? ATTENDANCE_PUNCH_MODES.EMPLOYEE_QR_KIOSK_FACE
      : ATTENDANCE_PUNCH_MODES.QR_ONLY;
  const attendancePunchMode = hasModeColumn
    ? normalizeAttendancePunchMode(row.attendancePunchMode)
    : legacyMode;
  const legacyFlags = deriveLegacyFaceFlags(attendancePunchMode);

  return {
    id: row.id,
    gpsValidationEnabled: Boolean(row.gpsValidationEnabled),
    attendancePunchMode,
    faceRecognitionEnabled: legacyFlags.faceRecognitionEnabled,
    faceRequiredForQrPunch: legacyFlags.faceRequiredForQrPunch,
    // Liveness is intentionally disabled in the restored stable face-match flow.
    // Ignore older database rows that may still contain `true`.
    faceLivenessRequired: false,
    faceMatchMaxDistance: Number(row.faceMatchMaxDistance),
    faceFailureMode: row.faceFailureMode,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const ensureAttendanceSecuritySettings = async (
  client: AttendanceSecurityClient = db,
) => {
  const hasModeColumn = await hasAttendancePunchModeColumn();
  const select = buildAttendanceSecuritySelect(hasModeColumn);
  const row = await client.attendanceSecuritySetting.upsert({
    where: { id: ATTENDANCE_SECURITY_SETTINGS_ID },
    update: {},
    create: {
      id: ATTENDANCE_SECURITY_SETTINGS_ID,
      gpsValidationEnabled: DEFAULT_ATTENDANCE_SECURITY_SETTINGS.gpsValidationEnabled,
      ...(hasModeColumn
        ? {
            attendancePunchMode:
              DEFAULT_ATTENDANCE_SECURITY_SETTINGS.attendancePunchMode,
          }
        : {}),
      faceRecognitionEnabled:
        DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceRecognitionEnabled,
      faceRequiredForQrPunch:
        DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceRequiredForQrPunch,
      faceLivenessRequired:
        DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceLivenessRequired,
      faceMatchMaxDistance:
        DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceMatchMaxDistance,
      faceFailureMode: DEFAULT_ATTENDANCE_SECURITY_SETTINGS.faceFailureMode,
    },
    select,
  });

  return hydrateAttendanceSecuritySettings(row, hasModeColumn);
};

export const serializeAttendanceSecuritySettings = (
  row: ResolvedAttendanceSecuritySettings,
) => ({
  id: row.id,
  gpsValidationEnabled: row.gpsValidationEnabled,
  attendancePunchMode: row.attendancePunchMode,
  faceRecognitionEnabled: row.faceRecognitionEnabled,
  faceRequiredForQrPunch: row.faceRequiredForQrPunch,
  faceLivenessRequired: row.faceLivenessRequired,
  faceMatchMaxDistance: row.faceMatchMaxDistance,
  faceFailureMode: row.faceFailureMode,
  updatedByUserId: row.updatedByUserId ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const serializeAttendanceSecurityClientConfig = (
  row: ResolvedAttendanceSecuritySettings,
) => ({
  gpsValidationEnabled: row.gpsValidationEnabled,
  attendancePunchMode: row.attendancePunchMode,
  faceRecognitionEnabled: row.faceRecognitionEnabled,
  faceRequiredForQrPunch: row.faceRequiredForQrPunch,
  faceLivenessRequired: row.faceLivenessRequired,
  faceMatchMaxDistance: row.faceMatchMaxDistance,
  faceFailureMode: row.faceFailureMode,
});
