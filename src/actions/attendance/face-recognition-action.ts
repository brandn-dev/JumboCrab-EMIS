"use server";

import { PUNCH_TYPE, Roles, type Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { publishAttendanceUpdate } from "@/lib/attendance-live/service";
import {
  createPunchAndMaybeRecompute,
  getExpectedShiftForDate,
} from "@/lib/attendance";
import { endOfZonedDay, startOfZonedDay, zonedNow } from "@/lib/timezone";
import {
  decryptFaceEmbedding,
  encryptFaceEmbedding,
  faceDistance,
} from "@/lib/face-embedding-crypto";
import {
  FaceServiceError,
  INSIGHTFACE_MODEL_VERSION,
  embedFaceFrames,
  isInsightFaceModel,
} from "@/lib/face-service-client";
import {
  computeBreakStats,
  getAttendanceFreezeStateForMoment,
  isSelfPunchIpAllowed,
  serializePunch,
} from "./attendance-shared";
import { isKioskPunchIpAllowed } from "./kiosk-attendance-shared";
import { captureAttendanceSecurityEvent } from "./attendance-security-service";
import {
  ATTENDANCE_PUNCH_MODES,
  FACE_MATCH_AMBIGUITY_MARGIN,
  FACE_MATCH_DEFAULT_DISTANCE,
  ensureAttendanceSecuritySettings,
  resolveAttendanceRequestMetadata,
} from "./attendance-security-shared";
import {
  buildPunchSuccessPayload,
  ensureEmployeeQrIdentity,
  loadActiveEmployeeIdentityByEmployeeId,
  prepareKioskPunchContext,
  toActiveEmployeeIdentity,
} from "./attendance-kiosk-flow-shared";

const MIN_ENROLLMENT_SAMPLES = 3;
const MAX_ENROLLMENT_SAMPLES = 5;
const MAX_ENROLLMENT_SAMPLE_DISTANCE = 0.32;
const MAX_ACTIVE_FACE_ENROLLMENTS_PER_EMPLOYEE = 3;
const FACE_DUPLICATE_ENROLLMENT_DISTANCE = FACE_MATCH_DEFAULT_DISTANCE;

const FACE_CONSENT_TEXT =
  "Employee consented to store encrypted face templates for attendance verification. Raw enrollment and punch photos are not stored by default.";

const canManageFaceEnrollments = (role?: Roles) =>
  role === Roles.Admin || role === Roles.Manager;

const canViewFaceEnrollments = (role?: Roles) =>
  canManageFaceEnrollments(role) || role === Roles.GeneralManager || role === Roles.Employee;

const averageDescriptors = (descriptors: number[][]) =>
  Array.from({ length: descriptors[0]?.length ?? 0 }, (_, index) => {
    const sum = descriptors.reduce(
      (total, descriptor) => total + descriptor[index],
      0,
    );
    return sum / descriptors.length;
  });

const normalizeFaceFrames = (frames: unknown, maxFrames = MAX_ENROLLMENT_SAMPLES) => {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter((frame): frame is string => {
      if (typeof frame !== "string") return false;
      const normalized = frame.includes(",") ? frame.split(",").pop() : frame;
      return Boolean(normalized && normalized.length > 100);
    })
    .map((frame) => (frame.includes(",") ? frame.split(",").pop() ?? "" : frame))
    .slice(0, maxFrames);
};

const maxPairwiseFaceDistance = (descriptors: number[][]) => {
  let maxDistance = 0;

  for (let left = 0; left < descriptors.length; left += 1) {
    for (let right = left + 1; right < descriptors.length; right += 1) {
      maxDistance = Math.max(
        maxDistance,
        faceDistance(descriptors[left], descriptors[right]),
      );
    }
  }

  return maxDistance;
};

type NearestFaceMatch = {
  employeeId: string;
  enrollmentId: string;
  distance: number;
};

const findNearestOtherActiveFace = async (
  employeeId: string,
  descriptor: number[],
): Promise<NearestFaceMatch | null> => {
  const otherEnrollments = await db.employeeFaceEnrollment.findMany({
    where: {
      employeeId: { not: employeeId },
      isActive: true,
    },
    select: {
      id: true,
      employeeId: true,
      embedding: true,
      modelVersion: true,
    },
  });

  return otherEnrollments.reduce<NearestFaceMatch | null>((nearest, row) => {
    if (!isInsightFaceModel(row.modelVersion)) return nearest;
    const distance = faceDistance(decryptFaceEmbedding(row.embedding), descriptor);
    if (!Number.isFinite(distance)) return nearest;
    if (!nearest || distance < nearest.distance) {
      return {
        employeeId: row.employeeId,
        enrollmentId: row.id,
        distance,
      };
    }
    return nearest;
  }, null);
};

const evaluateFaceMatch = async (input: {
  employeeId: string;
  descriptor: number[];
  activeEnrollments: Array<{ embedding: Buffer | Uint8Array; modelVersion: string }>;
  threshold: number;
}) => {
  const targetDistances = input.activeEnrollments.map((enrollment) =>
    faceDistance(decryptFaceEmbedding(enrollment.embedding), input.descriptor),
  );
  const bestDistance = Math.min(...targetDistances);
  const nearestOther = await findNearestOtherActiveFace(
    input.employeeId,
    input.descriptor,
  );

  if (!Number.isFinite(bestDistance) || bestDistance > input.threshold) {
    return {
      success: false as const,
      reason: "face_mismatch",
      error: "Face did not match enrolled employee.",
      bestDistance: Number.isFinite(bestDistance) ? bestDistance : null,
      nearestOther,
    };
  }

  if (
    nearestOther &&
    nearestOther.distance <= bestDistance + FACE_MATCH_AMBIGUITY_MARGIN
  ) {
    return {
      success: false as const,
      reason: "ambiguous_face_match",
      error:
        nearestOther.distance < bestDistance
          ? "Face matched another employee more closely."
          : "Face match is too close to another employee. Please retry or re-enroll.",
      bestDistance,
      nearestOther,
    };
  }

  return {
    success: true as const,
    bestDistance,
    nearestOther,
  };
};

const toJsonValue = (value: unknown) =>
  value == null
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

const normalizeModelVersion = (value: unknown) => {
  if (typeof value !== "string") return INSIGHTFACE_MODEL_VERSION;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 191) : INSIGHTFACE_MODEL_VERSION;
};

const serializeEnrollment = (row: {
  id: string;
  employeeId: string;
  sampleCount: number;
  modelVersion: string;
  consentText: string | null;
  consentedAt: Date | null;
  enrolledByUserId: string | null;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  employeeId: row.employeeId,
  sampleCount: row.sampleCount,
  modelVersion: row.modelVersion,
  consentText: row.consentText,
  consentedAt: row.consentedAt?.toISOString() ?? null,
  enrolledByUserId: row.enrolledByUserId,
  revokedByUserId: row.revokedByUserId,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  revokeReason: row.revokeReason,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const serializeFaceAttempt = (row: {
  id: string;
  employeeId: string;
  attendanceId: string | null;
  punchId: string | null;
  kioskId: string | null;
  punchType: PUNCH_TYPE | null;
  status: string;
  reason: string | null;
  distance: unknown;
  threshold: unknown;
  livenessPassed: boolean | null;
  livenessPrompt: string | null;
  faceCount: number | null;
  modelVersion: string | null;
  serviceLatencyMs: number | null;
  createdAt: Date;
}) => ({
  id: row.id,
  employeeId: row.employeeId,
  attendanceId: row.attendanceId,
  punchId: row.punchId,
  kioskId: row.kioskId,
  punchType: row.punchType,
  status: row.status,
  reason: row.reason,
  distance: row.distance == null ? null : Number(row.distance),
  threshold: row.threshold == null ? null : Number(row.threshold),
  livenessPassed: row.livenessPassed,
  livenessPrompt: row.livenessPrompt,
  faceCount: row.faceCount,
  modelVersion: row.modelVersion,
  serviceLatencyMs: row.serviceLatencyMs,
  createdAt: row.createdAt.toISOString(),
});

export async function listEmployeeFaceEnrollments(employeeId: string) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canViewFaceEnrollments(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const targetEmployeeId =
      typeof employeeId === "string" ? employeeId.trim() : "";
    if (!targetEmployeeId) {
      return { success: false, error: "Employee ID is required" };
    }

    if (session.role === Roles.Employee) {
      const ownedEmployee = session.userId
        ? await db.employee.findUnique({
            where: { userId: session.userId },
            select: { employeeId: true },
          })
        : null;
      if (!ownedEmployee || ownedEmployee.employeeId !== targetEmployeeId) {
        return { success: false, error: "Unauthorized" };
      }
    }

    const rows = await db.employeeFaceEnrollment.findMany({
      where: { employeeId: targetEmployeeId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        employeeId: true,
        sampleCount: true,
        modelVersion: true,
        consentText: true,
        consentedAt: true,
        enrolledByUserId: true,
        revokedByUserId: true,
        revokedAt: true,
        revokeReason: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { success: true, data: rows.map(serializeEnrollment) };
  } catch (error) {
    console.error("Failed to list face enrollments", error);
    return { success: false, error: "Failed to load face enrollment records" };
  }
}

export async function listEmployeeFaceVerificationAttempts(employeeId: string) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canViewFaceEnrollments(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const targetEmployeeId =
      typeof employeeId === "string" ? employeeId.trim() : "";
    if (!targetEmployeeId) {
      return { success: false, error: "Employee ID is required" };
    }

    if (session.role === Roles.Employee) {
      const ownedEmployee = session.userId
        ? await db.employee.findUnique({
            where: { userId: session.userId },
            select: { employeeId: true },
          })
        : null;
      if (!ownedEmployee || ownedEmployee.employeeId !== targetEmployeeId) {
        return { success: false, error: "Unauthorized" };
      }
    }

    const rows = await db.faceVerificationAttempt.findMany({
      where: { employeeId: targetEmployeeId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        employeeId: true,
        attendanceId: true,
        punchId: true,
        kioskId: true,
        punchType: true,
        status: true,
        reason: true,
        distance: true,
        threshold: true,
        livenessPassed: true,
        livenessPrompt: true,
        faceCount: true,
        modelVersion: true,
        serviceLatencyMs: true,
        createdAt: true,
      },
    });

    return { success: true, data: rows.map(serializeFaceAttempt) };
  } catch (error) {
    console.error("Failed to list face verification attempts", error);
    return { success: false, error: "Failed to load face verification attempts" };
  }
}

export async function enrollEmployeeFace(input: {
  employeeId: string;
  frames: string[];
  modelVersion?: string | null;
  descriptorMetadata?: unknown;
  faceMetadata?: unknown;
  consentText?: string | null;
  replaceExisting?: boolean | null;
}) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canManageFaceEnrollments(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const employeeId =
      typeof input.employeeId === "string" ? input.employeeId.trim() : "";
    if (!employeeId) {
      return { success: false, error: "Employee ID is required" };
    }

    const employee = await db.employee.findUnique({
      where: { employeeId },
      select: { employeeId: true },
    });
    if (!employee) {
      return { success: false, error: "Employee not found" };
    }

    const frames = normalizeFaceFrames(input.frames);
    if (frames.length < MIN_ENROLLMENT_SAMPLES) {
      return {
        success: false,
        error: `Capture at least ${MIN_ENROLLMENT_SAMPLES} clear face samples.`,
      };
    }

    const embeddingResults = await Promise.all(
      frames.map((frame) =>
        embedFaceFrames({
          frames: [frame],
          purpose: "enrollment",
          requireFrontFace: true,
        }),
      ),
    );
    const embeddings = embeddingResults.map((result) => result.embedding);
    const modelVersion = normalizeModelVersion(embeddingResults[0]?.modelVersion);
    const serviceLatencyMs = embeddingResults.reduce(
      (total, result) => total + (result.serviceLatencyMs ?? 0),
      0,
    );
    const sampleSpread = maxPairwiseFaceDistance(embeddings);
    if (sampleSpread > MAX_ENROLLMENT_SAMPLE_DISTANCE) {
      await logFaceAttempt({
        employeeId,
        status: "FAILED",
        reason: "poor_enrollment_consistency",
        distance: sampleSpread,
        threshold: MAX_ENROLLMENT_SAMPLE_DISTANCE,
        modelVersion,
        serviceLatencyMs,
        faceCount: frames.length,
        details: {
          sampleCount: frames.length,
          faceMetadata: input.faceMetadata ?? input.descriptorMetadata ?? null,
          quality: embeddingResults.map((result) => result.quality),
        },
      });
      return {
        success: false,
        error:
          "Face samples are inconsistent. Re-enroll with only the target employee in frame.",
        reason: "poor_enrollment_consistency",
      };
    }

    const averagedDescriptor = averageDescriptors(embeddings);
    const nearestOther = await findNearestOtherActiveFace(
      employeeId,
      averagedDescriptor,
    );
    if (
      nearestOther &&
      nearestOther.distance <= FACE_DUPLICATE_ENROLLMENT_DISTANCE
    ) {
      await logFaceAttempt({
        employeeId,
        status: "FAILED",
        reason: "duplicate_face_enrollment",
        distance: nearestOther.distance,
        threshold: FACE_DUPLICATE_ENROLLMENT_DISTANCE,
        modelVersion,
        serviceLatencyMs,
        faceCount: frames.length,
        details: {
          matchedEmployeeId: nearestOther.employeeId,
          matchedEnrollmentId: nearestOther.enrollmentId,
          sampleCount: frames.length,
          faceMetadata: input.faceMetadata ?? input.descriptorMetadata ?? null,
          quality: embeddingResults.map((result) => result.quality),
        },
      });
      return {
        success: false,
        error:
          "This face is already too close to another active employee enrollment.",
        reason: "duplicate_face_enrollment",
      };
    }

    const encryptedEmbedding = encryptFaceEmbedding(averagedDescriptor);
    const consentText =
      typeof input.consentText === "string" && input.consentText.trim()
        ? input.consentText.trim()
        : FACE_CONSENT_TEXT;
    const replaceExisting = input.replaceExisting === true;

    const enrollment = await db.$transaction(async (tx) => {
      if (replaceExisting) {
        await tx.employeeFaceEnrollment.updateMany({
          where: { employeeId, isActive: true },
          data: {
            isActive: false,
            revokedAt: new Date(),
            revokedByUserId: session.userId ?? null,
            revokeReason: "Replaced by new face enrollment.",
          },
        });
      } else {
        const activeEnrollments = await tx.employeeFaceEnrollment.findMany({
          where: { employeeId, isActive: true },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        const enrollmentsToRevoke = activeEnrollments.slice(
          MAX_ACTIVE_FACE_ENROLLMENTS_PER_EMPLOYEE - 1,
        );

        if (enrollmentsToRevoke.length > 0) {
          await tx.employeeFaceEnrollment.updateMany({
            where: {
              id: { in: enrollmentsToRevoke.map((row) => row.id) },
            },
            data: {
              isActive: false,
              revokedAt: new Date(),
              revokedByUserId: session.userId ?? null,
              revokeReason: "Rotated out after adding appearance variant.",
            },
          });
        }
      }

      return tx.employeeFaceEnrollment.create({
        data: {
          employeeId,
          embedding: encryptedEmbedding,
          sampleCount: frames.length,
          modelVersion,
          consentText,
          consentedAt: new Date(),
          enrolledByUserId: session.userId ?? null,
          isActive: true,
        },
      });
    });

    revalidatePath(`/admin/employees/${employeeId}/view`);
    revalidatePath(`/manager/employees/${employeeId}/view`);

    return { success: true, data: serializeEnrollment(enrollment) };
  } catch (error) {
    console.error("Failed to enroll employee face", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to enroll face",
    };
  }
}

export async function revokeEmployeeFaceEnrollment(input: {
  enrollmentId: string;
  reason?: string | null;
}) {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canManageFaceEnrollments(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const enrollmentId =
      typeof input.enrollmentId === "string" ? input.enrollmentId.trim() : "";
    if (!enrollmentId) {
      return { success: false, error: "Enrollment ID is required" };
    }

    const reason =
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : "Revoked by manager.";

    const row = await db.employeeFaceEnrollment.update({
      where: { id: enrollmentId },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedByUserId: session.userId ?? null,
        revokeReason: reason,
      },
    });

    revalidatePath(`/admin/employees/${row.employeeId}/view`);
    revalidatePath(`/manager/employees/${row.employeeId}/view`);

    return { success: true, data: serializeEnrollment(row) };
  } catch (error) {
    console.error("Failed to revoke face enrollment", error);
    return { success: false, error: "Failed to revoke face enrollment" };
  }
}

const expectedNextPunch = (lastType?: PUNCH_TYPE | null) => {
  const allowedNext: Record<PUNCH_TYPE | "NONE", PUNCH_TYPE> = {
    NONE: PUNCH_TYPE.TIME_IN,
    TIME_OUT: PUNCH_TYPE.TIME_IN,
    TIME_IN: PUNCH_TYPE.BREAK_IN,
    BREAK_IN: PUNCH_TYPE.BREAK_OUT,
    BREAK_OUT: PUNCH_TYPE.TIME_OUT,
  };
  return allowedNext[lastType ?? "NONE"];
};

const logFaceAttempt = async (input: {
  employeeId: string;
  attendanceId?: string | null;
  punchId?: string | null;
  kioskId?: string | null;
  kioskNonce?: string | null;
  punchType?: PUNCH_TYPE | null;
  status: string;
  reason?: string | null;
  distance?: number | null;
  threshold?: number | null;
  livenessPassed?: boolean | null;
  livenessPrompt?: string | null;
  faceCount?: number | null;
  modelVersion?: string | null;
  serviceLatencyMs?: number | null;
  details?: unknown;
}) => {
  return db.faceVerificationAttempt.create({
    data: {
      employeeId: input.employeeId,
      attendanceId: input.attendanceId ?? null,
      punchId: input.punchId ?? null,
      kioskId: input.kioskId?.slice(0, 191) ?? null,
      kioskNonce: input.kioskNonce?.slice(0, 191) ?? null,
      punchType: input.punchType ?? null,
      status: input.status,
      reason: input.reason?.slice(0, 500) ?? null,
      distance: input.distance ?? null,
      threshold: input.threshold ?? null,
      livenessPassed: input.livenessPassed ?? null,
      livenessPrompt: input.livenessPrompt?.slice(0, 191) ?? null,
      faceCount: input.faceCount ?? null,
      modelVersion: input.modelVersion?.slice(0, 191) ?? null,
      serviceLatencyMs: input.serviceLatencyMs ?? null,
      details: toJsonValue(input.details),
    },
  });
};

export async function verifyFaceAndRecordKioskPunch(input: {
  employeeQrToken?: string | null;
  employeeId?: string | null;
  kioskId?: string | null;
  frames?: string[] | null;
  livenessPassed?: boolean | null;
  livenessPrompt?: string | null;
  faceCount?: number | null;
  modelVersion?: string | null;
  faceMetadata?: unknown;
  latitude?: number | null;
  longitude?: number | null;
}) {
  let employeeIdForAudit: string | null = null;
  let punchTypeForAudit: PUNCH_TYPE | null = null;

  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    const clientIp = requestMetadata.ipAddress;
    if (!isKioskPunchIpAllowed(clientIp)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const settings = await ensureAttendanceSecuritySettings();
    if (settings.attendancePunchMode === ATTENDANCE_PUNCH_MODES.QR_ONLY) {
      return {
        success: false,
        error: "Face verification is not enabled for current attendance mode.",
        reason: "face_not_enabled",
      };
    }

    const employeeQrToken =
      typeof input.employeeQrToken === "string"
        ? input.employeeQrToken.trim()
        : "";
    const employeeId =
      typeof input.employeeId === "string" ? input.employeeId.trim() : "";

    if (!employeeQrToken && !employeeId) {
      return {
        success: false,
        error: "Employee QR token or employee ID is required.",
        reason: "missing_employee_target",
      };
    }

    let resolvedEmployee:
      | Awaited<ReturnType<typeof ensureEmployeeQrIdentity>>
      | { success: true; data: NonNullable<ReturnType<typeof toActiveEmployeeIdentity>> };

    if (employeeQrToken.length > 0) {
      resolvedEmployee = await ensureEmployeeQrIdentity(employeeQrToken);
    } else {
      const loaded = toActiveEmployeeIdentity(
        await loadActiveEmployeeIdentityByEmployeeId(employeeId),
      );
      if (!loaded || loaded.isDisabled || loaded.isArchived) {
        return {
          success: false,
          error: "User not eligible",
          reason: "user_not_eligible",
        };
      }
      resolvedEmployee = {
        success: true as const,
        data: loaded,
      };
    }

    if (!resolvedEmployee.success) {
      return resolvedEmployee;
    }

    const context = await prepareKioskPunchContext(resolvedEmployee.data);
    if (!context.success) {
      return context;
    }
    employeeIdForAudit = context.data.employee.employeeId;
    punchTypeForAudit = context.data.nextPunch;

    const frames = normalizeFaceFrames(input.frames, 18);
    if (frames.length === 0) {
      return {
        success: false,
        error: "Face frames are required before punching.",
        reason: "missing_face_frames",
      };
    }
    const embeddedFace = await embedFaceFrames({
      frames,
      purpose: "verification",
      requireFrontFace: true,
    });
    const descriptor = embeddedFace.embedding;
    const faceCount = embeddedFace.faceCount;
    const modelVersion = normalizeModelVersion(embeddedFace.modelVersion);
    const livenessPrompt =
      typeof input.livenessPrompt === "string" && input.livenessPrompt.trim()
        ? input.livenessPrompt.trim().slice(0, 191)
        : null;
    const faceMetadata = {
      source: "python-insightface",
      frameCount: frames.length,
      quality: embeddedFace.quality,
      ...(typeof input.faceMetadata === "object" && input.faceMetadata
        ? (input.faceMetadata as Record<string, unknown>)
        : {}),
    };

    const activeEnrollments = await db.employeeFaceEnrollment.findMany({
      where: { employeeId: context.data.employee.employeeId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { embedding: true, modelVersion: true },
      take: 3,
    });
    const activeInsightFaceEnrollments = activeEnrollments.filter((enrollment) =>
      isInsightFaceModel(enrollment.modelVersion),
    );
    if (activeInsightFaceEnrollments.length === 0) {
      await logFaceAttempt({
        employeeId: context.data.employee.employeeId,
        kioskId: input.kioskId ?? null,
        punchType: context.data.nextPunch,
        status: "FAILED",
        reason: "no_active_insightface_enrollment",
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
      });
      return {
        success: false,
        error: "Python face enrollment required. Ask a manager to re-enroll your face.",
        reason: "no_face_enrollment",
      };
    }

    if (faceCount !== 1) {
      await logFaceAttempt({
        employeeId: context.data.employee.employeeId,
        kioskId: input.kioskId ?? null,
        punchType: context.data.nextPunch,
        status: "FAILED",
        reason: faceCount === 0 ? "no_face_detected" : "multiple_faces",
        livenessPassed: Boolean(input.livenessPassed),
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: faceMetadata,
      });
      return {
        success: false,
        error:
          faceCount === 0
            ? "No face detected. Please retry."
            : "Multiple faces detected. Only one employee may be in frame.",
        reason: faceCount === 0 ? "no_face_detected" : "multiple_faces",
      };
    }

    if (settings.faceLivenessRequired && input.livenessPassed !== true) {
      await logFaceAttempt({
        employeeId: context.data.employee.employeeId,
        kioskId: input.kioskId ?? null,
        punchType: context.data.nextPunch,
        status: "FAILED",
        reason: "liveness_failed",
        livenessPassed: false,
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: faceMetadata,
      });
      return {
        success: false,
        error: "Face liveness check failed. Please retry with your face centered.",
        reason: "liveness_failed",
      };
    }

    const threshold = Number(settings.faceMatchMaxDistance);
    const faceMatch = await evaluateFaceMatch({
      employeeId: context.data.employee.employeeId,
      descriptor,
      activeEnrollments: activeInsightFaceEnrollments,
      threshold,
    });

    if (!faceMatch.success) {
      await logFaceAttempt({
        employeeId: context.data.employee.employeeId,
        kioskId: input.kioskId ?? null,
        punchType: context.data.nextPunch,
        status: "FAILED",
        reason: faceMatch.reason,
        distance: faceMatch.bestDistance,
        threshold,
        livenessPassed: Boolean(input.livenessPassed),
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: {
          ...faceMetadata,
          ambiguityMargin: FACE_MATCH_AMBIGUITY_MARGIN,
          nearestOtherEmployeeId: faceMatch.nearestOther?.employeeId ?? null,
          nearestOtherEnrollmentId: faceMatch.nearestOther?.enrollmentId ?? null,
          nearestOtherDistance: faceMatch.nearestOther?.distance ?? null,
        },
      });
      return {
        success: false,
        error: faceMatch.error,
        reason: faceMatch.reason,
      };
    }

    const punch = await createPunchAndMaybeRecompute({
      employeeId: context.data.employee.employeeId,
      punchType: context.data.nextPunch,
      punchTime: context.data.now,
      source: "KIOSK_FACE",
      recompute: true,
    });

    const securityResult = punch.attendance?.id
        ? await captureAttendanceSecurityEvent({
          punchId: punch.punch.id,
          attendanceId: punch.attendance.id,
          employeeId: context.data.employee.employeeId,
          punchTime: context.data.now,
          payload: {
            ...requestMetadata,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
          },
        })
      : null;

    await logFaceAttempt({
      employeeId: context.data.employee.employeeId,
      attendanceId: punch.attendance?.id ?? null,
      punchId: punch.punch.id,
      kioskId: input.kioskId ?? null,
      punchType: context.data.nextPunch,
      status: "PASSED",
      reason: "face_match",
      distance: faceMatch.bestDistance,
      threshold,
      livenessPassed: Boolean(input.livenessPassed),
      livenessPrompt,
      faceCount,
      modelVersion,
      serviceLatencyMs: embeddedFace.serviceLatencyMs,
      details: {
        ...faceMetadata,
        contextLogId: securityResult?.contextLogId ?? null,
        ambiguityMargin: FACE_MATCH_AMBIGUITY_MARGIN,
        nearestOtherEmployeeId: faceMatch.nearestOther?.employeeId ?? null,
        nearestOtherEnrollmentId: faceMatch.nearestOther?.enrollmentId ?? null,
        nearestOtherDistance: faceMatch.nearestOther?.distance ?? null,
      },
    });

    await publishAttendanceUpdate({
      employeeId: context.data.employee.employeeId,
      workDate: context.data.dayStart,
      punchId: punch.punch.id,
    });

    return {
      success: true,
      data: {
        ...buildPunchSuccessPayload(context.data, punch.punch),
        ...serializePunch(punch.punch),
        faceVerified: true,
        faceDistance: faceMatch.bestDistance,
        faceThreshold: threshold,
        livenessPassed: Boolean(input.livenessPassed),
      },
    };
  } catch (error) {
    console.error("Failed to verify face and record kiosk punch", error);
    const reason =
      error instanceof FaceServiceError
        ? error.reason
        : "face_verification_error";
    if (employeeIdForAudit) {
      await logFaceAttempt({
        employeeId: employeeIdForAudit,
        kioskId: input.kioskId ?? null,
        punchType: punchTypeForAudit,
        status: "ERROR",
        reason: error instanceof Error ? error.message : reason,
      }).catch(() => null);
    }
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Face verification failed. Use supervisor fallback if needed.",
      reason,
    };
  }
}

export async function verifyFaceAndRecordQrPunch(input: {
  punchType: string;
  kioskId?: string | null;
  nonce?: string | null;
  exp?: number | null;
  frames?: string[] | null;
  livenessPassed?: boolean | null;
  livenessPrompt?: string | null;
  faceCount?: number | null;
  modelVersion?: string | null;
  faceMetadata?: unknown;
  latitude?: number | null;
  longitude?: number | null;
}) {
  let employeeIdForAudit: string | null = null;
  let punchTypeForAudit: PUNCH_TYPE | null = null;

  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return { success: false, error: "Unauthorized", reason: "unauthorized" };
    }

    const requestMetadata = await resolveAttendanceRequestMetadata();
    const clientIp = requestMetadata.ipAddress;
    if (!isSelfPunchIpAllowed(clientIp)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const exp =
      typeof input.exp === "number" && Number.isFinite(input.exp) ? input.exp : 0;
    if (exp <= 0 || Date.now() > exp) {
      return {
        success: false,
        error: "Kiosk QR expired. Please scan a fresh QR.",
        reason: "qr_expired",
      };
    }

    const punchType =
      typeof input.punchType === "string" ? input.punchType : "";
    if (!Object.values(PUNCH_TYPE).includes(punchType as PUNCH_TYPE)) {
      return {
        success: false,
        error: "Invalid punchType",
        reason: "invalid_punch_type",
      };
    }
    punchTypeForAudit = punchType as PUNCH_TYPE;

    const employee = await db.employee.findUnique({
      where: { userId: session.userId },
      select: { employeeId: true },
    });
    if (!employee) {
      return {
        success: false,
        error: "Employee not found for user",
        reason: "employee_not_found",
      };
    }
    employeeIdForAudit = employee.employeeId;

    const settings = await ensureAttendanceSecuritySettings();
    if (!settings.faceRecognitionEnabled || !settings.faceRequiredForQrPunch) {
      return {
        success: false,
        error: "Face recognition is not enabled for QR punches.",
        reason: "face_not_enabled",
      };
    }

    const frames = normalizeFaceFrames(input.frames, 18);
    if (frames.length === 0) {
      return {
        success: false,
        error: "Face frames are required before punching.",
        reason: "missing_face_frames",
      };
    }
    const embeddedFace = await embedFaceFrames({
      frames,
      purpose: "verification",
      requireFrontFace: true,
    });
    const descriptor = embeddedFace.embedding;
    const faceCount = embeddedFace.faceCount;
    const modelVersion = normalizeModelVersion(embeddedFace.modelVersion);
    const livenessPrompt =
      typeof input.livenessPrompt === "string" && input.livenessPrompt.trim()
        ? input.livenessPrompt.trim().slice(0, 191)
        : null;
    const faceMetadata = {
      source: "python-insightface",
      frameCount: frames.length,
      quality: embeddedFace.quality,
      ...(typeof input.faceMetadata === "object" && input.faceMetadata
        ? (input.faceMetadata as Record<string, unknown>)
        : {}),
    };

    const now = zonedNow();
    const todayStart = startOfZonedDay(now);
    const todayEnd = endOfZonedDay(now);
    const expected = await getExpectedShiftForDate(employee.employeeId, todayStart);
    const dayState = await getAttendanceFreezeStateForMoment(
      employee.employeeId,
      now,
    );

    if (dayState?.payrollPeriodId) {
      return {
        success: false,
        error:
          "Attendance is already linked to payroll for today. Contact payroll admin for adjustment.",
        reason: "payroll_linked",
      };
    }
    if (dayState?.isLocked) {
      return {
        success: false,
        error: "Attendance is locked for today. Contact admin to unlock.",
        reason: "attendance_locked",
      };
    }

    const punchesToday = await db.punch.findMany({
      where: {
        employeeId: employee.employeeId,
        punchTime: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { punchTime: "asc" },
    });
    const lastPunch = punchesToday[punchesToday.length - 1] ?? null;
    if (lastPunch?.punchType === PUNCH_TYPE.TIME_OUT) {
      return {
        success: false,
        error: "Already clocked out today",
        reason: "already_clocked_out",
      };
    }
    const nextPunch = expectedNextPunch(lastPunch?.punchType ?? null);
    if (nextPunch !== punchType) {
      return {
        success: false,
        error: `Next allowed punch is ${nextPunch.replace("_", " ").toLowerCase()}`,
        reason: "invalid_sequence",
      };
    }

    if (punchType === PUNCH_TYPE.TIME_IN) {
      if (expected.scheduledStartMinutes == null) {
        return {
          success: false,
          error: "No scheduled shift for today",
          reason: "no_shift_today",
        };
      }
      const minutesSinceStart = Math.round(
        (now.getTime() - todayStart.getTime()) / 60000,
      );
      if (minutesSinceStart < expected.scheduledStartMinutes) {
        return {
          success: false,
          error:
            "Too early to clock in. You can time in at the scheduled start time.",
          reason: "too_early",
        };
      }
      if (
        expected.scheduledEndMinutes != null &&
        minutesSinceStart > expected.scheduledEndMinutes
      ) {
        return {
          success: false,
          error: "Cannot clock in after your scheduled end time.",
          reason: "too_late",
        };
      }
    }

    const activeEnrollments = await db.employeeFaceEnrollment.findMany({
      where: { employeeId: employee.employeeId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { embedding: true, modelVersion: true },
      take: 3,
    });
    const activeInsightFaceEnrollments = activeEnrollments.filter((enrollment) =>
      isInsightFaceModel(enrollment.modelVersion),
    );
    if (activeInsightFaceEnrollments.length === 0) {
      await logFaceAttempt({
        employeeId: employee.employeeId,
        kioskId: input.kioskId ?? null,
        kioskNonce: input.nonce ?? null,
        punchType: punchType as PUNCH_TYPE,
        status: "FAILED",
        reason: "no_active_insightface_enrollment",
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
      });
      return {
        success: false,
        error: "Python face enrollment required. Ask a manager to re-enroll your face.",
        reason: "no_face_enrollment",
      };
    }

    if (faceCount !== 1) {
      await logFaceAttempt({
        employeeId: employee.employeeId,
        kioskId: input.kioskId ?? null,
        kioskNonce: input.nonce ?? null,
        punchType: punchType as PUNCH_TYPE,
        status: "FAILED",
        reason: faceCount === 0 ? "no_face_detected" : "multiple_faces",
        livenessPassed: Boolean(input.livenessPassed),
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: faceMetadata,
      });
      return {
        success: false,
        error:
          faceCount === 0
            ? "No face detected. Please retry."
            : "Multiple faces detected. Only one employee may be in frame.",
        reason: faceCount === 0 ? "no_face_detected" : "multiple_faces",
      };
    }

    if (settings.faceLivenessRequired && input.livenessPassed !== true) {
      await logFaceAttempt({
        employeeId: employee.employeeId,
        kioskId: input.kioskId ?? null,
        kioskNonce: input.nonce ?? null,
        punchType: punchType as PUNCH_TYPE,
        status: "FAILED",
        reason: "liveness_failed",
        livenessPassed: false,
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: faceMetadata,
      });
      return {
        success: false,
        error: "Face liveness check failed. Please retry with your face centered.",
        reason: "liveness_failed",
      };
    }

    const threshold = Number(settings.faceMatchMaxDistance);
    const faceMatch = await evaluateFaceMatch({
      employeeId: employee.employeeId,
      descriptor,
      activeEnrollments: activeInsightFaceEnrollments,
      threshold,
    });

    if (!faceMatch.success) {
      await logFaceAttempt({
        employeeId: employee.employeeId,
        kioskId: input.kioskId ?? null,
        kioskNonce: input.nonce ?? null,
        punchType: punchType as PUNCH_TYPE,
        status: "FAILED",
        reason: faceMatch.reason,
        distance: faceMatch.bestDistance,
        threshold,
        livenessPassed: Boolean(input.livenessPassed),
        livenessPrompt,
        faceCount,
        modelVersion,
        serviceLatencyMs: embeddedFace.serviceLatencyMs,
        details: {
          ...faceMetadata,
          ambiguityMargin: FACE_MATCH_AMBIGUITY_MARGIN,
          nearestOtherEmployeeId: faceMatch.nearestOther?.employeeId ?? null,
          nearestOtherEnrollmentId: faceMatch.nearestOther?.enrollmentId ?? null,
          nearestOtherDistance: faceMatch.nearestOther?.distance ?? null,
        },
      });
      return {
        success: false,
        error: faceMatch.error,
        reason: faceMatch.reason,
      };
    }

    const punch = await createPunchAndMaybeRecompute({
      employeeId: employee.employeeId,
      punchType: punchType as PUNCH_TYPE,
      punchTime: now,
      source: "QR_FACE",
      recompute: true,
    });

    const securityResult = punch.attendance?.id
        ? await captureAttendanceSecurityEvent({
          punchId: punch.punch.id,
          attendanceId: punch.attendance.id,
          employeeId: employee.employeeId,
          punchTime: now,
          payload: {
            ...requestMetadata,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
          },
        })
      : null;

    await logFaceAttempt({
      employeeId: employee.employeeId,
      attendanceId: punch.attendance?.id ?? null,
      punchId: punch.punch.id,
      kioskId: input.kioskId ?? null,
      kioskNonce: input.nonce ?? null,
      punchType: punchType as PUNCH_TYPE,
      status: "PASSED",
      reason: "face_match",
      distance: faceMatch.bestDistance,
      threshold,
      livenessPassed: Boolean(input.livenessPassed),
      livenessPrompt,
      faceCount,
      modelVersion,
      serviceLatencyMs: embeddedFace.serviceLatencyMs,
      details: {
        ...faceMetadata,
        contextLogId: securityResult?.contextLogId ?? null,
        breakStats: computeBreakStats([...punchesToday, punch.punch]),
        ambiguityMargin: FACE_MATCH_AMBIGUITY_MARGIN,
        nearestOtherEmployeeId: faceMatch.nearestOther?.employeeId ?? null,
        nearestOtherEnrollmentId: faceMatch.nearestOther?.enrollmentId ?? null,
        nearestOtherDistance: faceMatch.nearestOther?.distance ?? null,
      },
    });

    await publishAttendanceUpdate({
      employeeId: employee.employeeId,
      workDate: todayStart,
      punchId: punch.punch.id,
    });

    return {
      success: true,
      data: {
        ...serializePunch(punch.punch),
        faceVerified: true,
        faceDistance: faceMatch.bestDistance,
        faceThreshold: threshold,
        livenessPassed: Boolean(input.livenessPassed),
      },
    };
  } catch (error) {
    console.error("Failed to verify face and record QR punch", error);
    const reason =
      error instanceof FaceServiceError
        ? error.reason
        : "face_verification_error";
    if (employeeIdForAudit) {
      await logFaceAttempt({
        employeeId: employeeIdForAudit,
        kioskId: input.kioskId ?? null,
        kioskNonce: input.nonce ?? null,
        punchType: punchTypeForAudit,
        status: "ERROR",
        reason: error instanceof Error ? error.message : reason,
      }).catch(() => null);
    }
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Face verification failed. Use supervisor fallback if needed.",
      reason,
    };
  }
}
