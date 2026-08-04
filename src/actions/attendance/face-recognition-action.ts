"use server";

import { PUNCH_TYPE, Roles, type Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  decryptFaceEmbedding,
  encryptFaceEmbedding,
  faceDistance,
} from "@/lib/face-embedding-crypto";
import {
  INSIGHTFACE_MODEL_VERSION,
  embedFaceFrames,
  isInsightFaceModel,
} from "@/lib/face-service-client";
import { isKioskPunchIpAllowed } from "./kiosk-attendance-shared";
import {
  ATTENDANCE_PUNCH_MODES,
  FACE_MATCH_DEFAULT_DISTANCE,
  ensureAttendanceSecuritySettings,
  hasAttendanceFaceChallengeSchema,
  resolveAttendanceRequestMetadata,
} from "./attendance-security-shared";
import { verifyAndRecordAttendanceFaceChallenge } from "./attendance-face-challenge-service";

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


const normalizeModelVersion = (value: unknown) => {
  if (typeof value !== "string") return INSIGHTFACE_MODEL_VERSION;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 191) : INSIGHTFACE_MODEL_VERSION;
};

const logFaceAttempt = async (input: {
  employeeId: string;
  status: string;
  reason: string;
  distance?: number | null;
  threshold?: number | null;
  faceCount?: number | null;
  modelVersion?: string | null;
  serviceLatencyMs?: number | null;
  details?: unknown;
}) =>
  db.faceVerificationAttempt.create({
    data: {
      employeeId: input.employeeId,
      status: input.status,
      reason: input.reason,
      distance: input.distance ?? null,
      threshold: input.threshold ?? null,
      faceCount: input.faceCount ?? null,
      modelVersion: input.modelVersion ?? null,
      serviceLatencyMs: input.serviceLatencyMs ?? null,
      details:
        input.details == null
          ? undefined
          : (JSON.parse(JSON.stringify(input.details)) as Prisma.InputJsonValue),
    },
  });

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
  challengeId: string | null;
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
  challengeId: row.challengeId,
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
        challengeId: true,
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

export async function verifyFaceAndRecordKioskPunch(input: {
  attemptId?: string | null;
  nonce?: string | null;
  kioskId?: string | null;
  frames?: unknown;
  latitude?: number | null;
  longitude?: number | null;
}) {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    if (!isKioskPunchIpAllowed(requestMetadata.ipAddress)) {
      return {
        success: false as const,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }
    const settings = await ensureAttendanceSecuritySettings();
    if (settings.attendancePunchMode === ATTENDANCE_PUNCH_MODES.QR_ONLY) {
      return {
        success: false as const,
        error: "Face verification is not enabled for current attendance mode.",
        reason: "face_not_enabled",
      };
    }
    if (!(await hasAttendanceFaceChallengeSchema())) {
      return {
        success: false as const,
        error: "Secure face challenge migration is not installed.",
        reason: "security_migration_required",
      };
    }
    return verifyAndRecordAttendanceFaceChallenge({
      ...input,
      requestMetadata,
      settings,
    });
  } catch (error) {
    console.error("Failed to verify server face challenge", error);
    return {
      success: false as const,
      error: "Face challenge failed. Start again.",
      reason: "face_verification_error",
    };
  }
}
