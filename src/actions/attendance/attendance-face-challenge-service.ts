import {
  AttendanceFaceChallengeStatus,
  Prisma,
  type PUNCH_TYPE,
} from "@prisma/client";
import { db } from "@/lib/db";
import { recomputeAttendanceForDay } from "@/lib/attendance";
import { publishAttendanceUpdate } from "@/lib/attendance-live/service";
import {
  challengeNonceMatches,
  createChallengeNonce,
  createKioskBindingHash,
  createRandomFaceActions,
  evaluateIdentitySequence,
  FaceChallengeValidationError,
  hashAttendanceQrToken,
  hashChallengeNonce,
  normalizeKioskId,
  parseFaceChallengeActions,
  validateAndHashFrameSequence,
  type FaceChallengeAction,
} from "@/lib/attendance-face-challenge";
import { decryptFaceEmbedding } from "@/lib/face-embedding-crypto";
import {
  FaceServiceError,
  isInsightFaceModel,
  verifyFaceChallenge,
} from "@/lib/face-service-client";
import { endOfZonedDay, startOfZonedDay, zonedNow } from "@/lib/timezone";
import { captureAttendanceSecurityEvent } from "./attendance-security-service";
import {
  FACE_MATCH_AMBIGUITY_MARGIN,
  normalizeLatitude,
  normalizeLongitude,
  type AttendanceSecurityPayload,
  type ResolvedAttendanceSecuritySettings,
} from "./attendance-security-shared";
import {
  buildPunchSuccessPayload,
  getExpectedNextPunch,
  type ActiveEmployeeIdentity,
  type KioskPunchContext,
} from "./attendance-kiosk-flow-shared";

export class AttendanceChallengeError extends Error {
  reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "AttendanceChallengeError";
    this.reason = reason;
  }
}

type IssuedFaceChallenge = {
  attemptId: string;
  nonce: string;
  actions: FaceChallengeAction[];
  expiresAt: number;
};

const jsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const publicFailureMessage = (reason: string) => {
  switch (reason) {
    case "challenge_expired":
      return "Face challenge expired. Start again.";
    case "rate_limited":
    case "cooldown_active":
      return "Too many face attempts. Wait before trying again.";
    case "no_face_enrollment":
      return "Active InsightFace enrollment required. Ask a manager to enroll your face.";
    case "anti_spoof_unavailable":
      return "Required anti-spoof service is unavailable.";
    case "face_changed_during_challenge":
    case "ambiguous_face_match":
    case "face_mismatch":
      return "Face verification failed. Start a fresh challenge.";
    default:
      return "Face challenge failed. Start again.";
  }
};

const lockEmployeePunchFlow = async (
  tx: Prisma.TransactionClient,
  employeeId: string,
) => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`;
};

const assertCurrentPunchSequence = async (input: {
  tx: Prisma.TransactionClient;
  employeeId: string;
  expectedPunchType: PUNCH_TYPE;
  now: Date;
}) => {
  const dayStart = startOfZonedDay(input.now);
  const dayEnd = endOfZonedDay(input.now);
  const employee = await input.tx.employee.findUnique({
    where: { employeeId: input.employeeId },
    select: {
      isArchived: true,
      user: { select: { isDisabled: true } },
    },
  });
  if (
    !employee ||
    employee.isArchived ||
    !employee.user ||
    employee.user.isDisabled
  ) {
    throw new AttendanceChallengeError(
      "Employee is not eligible for attendance.",
      "user_not_eligible",
    );
  }
  const attendance = await input.tx.attendance.findUnique({
    where: {
      employeeId_workDate: {
        employeeId: input.employeeId,
        workDate: dayStart,
      },
    },
    select: { isLocked: true, payrollPeriodId: true },
  });
  if (attendance?.payrollPeriodId) {
    throw new AttendanceChallengeError(
      "Attendance is linked to payroll.",
      "payroll_linked",
    );
  }
  if (attendance?.isLocked) {
    throw new AttendanceChallengeError("Attendance is locked.", "attendance_locked");
  }

  const lastPunch = await input.tx.punch.findFirst({
    where: {
      employeeId: input.employeeId,
      punchTime: { gte: dayStart, lt: dayEnd },
    },
    orderBy: [{ punchTime: "desc" }, { createdAt: "desc" }],
    select: { punchType: true },
  });
  if (lastPunch?.punchType === "TIME_OUT") {
    throw new AttendanceChallengeError(
      "Employee already clocked out today.",
      "already_clocked_out",
    );
  }
  if (getExpectedNextPunch(lastPunch?.punchType) !== input.expectedPunchType) {
    throw new AttendanceChallengeError(
      "Punch sequence changed. Start again.",
      "stale_punch_sequence",
    );
  }
  return { dayStart };
};

export const issueAttendanceFaceChallenge = async (input: {
  identity: ActiveEmployeeIdentity;
  expectedPunchType: PUNCH_TYPE;
  kioskId: unknown;
  requestMetadata: { ipAddress?: string | null; userAgent?: string | null };
  settings: ResolvedAttendanceSecuritySettings;
  qrToken?: string | null;
  qrExpiresAt?: number | null;
}): Promise<IssuedFaceChallenge> => {
  const enrollmentCount = await db.employeeFaceEnrollment.count({
    where: {
      employeeId: input.identity.employeeId,
      isActive: true,
      modelVersion: { startsWith: "insightface/", mode: "insensitive" },
    },
  });
  if (enrollmentCount === 0) {
    throw new AttendanceChallengeError(
      publicFailureMessage("no_face_enrollment"),
      "no_face_enrollment",
    );
  }

  const now = new Date();
  const kioskId = normalizeKioskId(input.kioskId);
  const kioskBindingHash = createKioskBindingHash({
    kioskId,
    ...input.requestMetadata,
  });
  const nonce = createChallengeNonce();
  const actions = createRandomFaceActions();
  const expiresAt = new Date(
    now.getTime() + input.settings.faceChallengeExpiresSeconds * 1_000,
  );
  const windowStart = new Date(now.getTime() - 60_000);
  const cooldownStart = new Date(
    now.getTime() - input.settings.faceChallengeCooldownSeconds * 1_000,
  );
  const qrToken = input.qrToken?.trim() || null;
  const qrTokenHash = qrToken ? hashAttendanceQrToken(qrToken) : null;
  if (qrTokenHash && (!input.qrExpiresAt || input.qrExpiresAt <= now.getTime())) {
    throw new AttendanceChallengeError(
      "Employee QR expired. Scan a fresh QR.",
      "qr_expired",
    );
  }

  try {
    return await db.$transaction(
      async (tx) => {
        await lockEmployeePunchFlow(tx, input.identity.employeeId);
        await tx.attendanceFaceChallenge.updateMany({
          where: {
            employeeId: input.identity.employeeId,
            status: {
              in: [
                AttendanceFaceChallengeStatus.PENDING,
                AttendanceFaceChallengeStatus.PROCESSING,
              ],
            },
            expiresAt: { lte: now },
          },
          data: {
            status: AttendanceFaceChallengeStatus.EXPIRED,
            failureReason: "challenge_expired",
          },
        });

        const [
          recentEmployeeAttempts,
          recentKioskAttempts,
          recentFailures,
          pending,
        ] = await Promise.all([
          tx.attendanceFaceChallenge.count({
            where: {
              employeeId: input.identity.employeeId,
              createdAt: { gte: windowStart },
            },
          }),
          tx.attendanceFaceChallenge.count({
            where: {
              kioskBindingHash,
              createdAt: { gte: windowStart },
            },
          }),
          tx.attendanceFaceChallenge.count({
            where: {
              employeeId: input.identity.employeeId,
              status: AttendanceFaceChallengeStatus.FAILED,
              createdAt: { gte: cooldownStart },
            },
          }),
          tx.attendanceFaceChallenge.findFirst({
            where: {
              employeeId: input.identity.employeeId,
              status: {
                in: [
                  AttendanceFaceChallengeStatus.PENDING,
                  AttendanceFaceChallengeStatus.PROCESSING,
                ],
              },
              expiresAt: { gt: now },
            },
            select: { id: true },
          }),
        ]);
        if (pending) {
          throw new AttendanceChallengeError(
            "Face challenge already active.",
            "challenge_pending",
          );
        }
        if (
          recentEmployeeAttempts >=
            input.settings.faceChallengeMaxAttemptsPerMinute ||
          recentKioskAttempts >=
            input.settings.faceChallengeMaxAttemptsPerMinute * 10
        ) {
          throw new AttendanceChallengeError(
            publicFailureMessage("rate_limited"),
            "rate_limited",
          );
        }
        if (recentFailures >= input.settings.faceChallengeMaxFailures) {
          throw new AttendanceChallengeError(
            publicFailureMessage("cooldown_active"),
            "cooldown_active",
          );
        }

        const challenge = await tx.attendanceFaceChallenge.create({
          data: {
            employeeId: input.identity.employeeId,
            kioskId,
            kioskBindingHash,
            nonceHash: hashChallengeNonce(nonce),
            actions,
            expectedPunchType: input.expectedPunchType,
            expiresAt,
          },
        });

        if (qrTokenHash) {
          await tx.attendanceQrRedemption.create({
            data: {
              tokenHash: qrTokenHash,
              employeeId: input.identity.employeeId,
              challengeId: challenge.id,
              kioskBindingHash,
              expiresAt: new Date(input.qrExpiresAt || expiresAt.getTime()),
            },
          });
        }

        return {
          attemptId: challenge.id,
          nonce,
          actions,
          expiresAt: expiresAt.getTime(),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof AttendanceChallengeError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AttendanceChallengeError(
        "Employee QR was already used. Scan a fresh QR.",
        "qr_replayed",
      );
    }
    throw error;
  }
};

const recordFailedAttempt = async (input: {
  challengeId: string;
  employeeId: string;
  kioskId: string;
  expectedPunchType: PUNCH_TYPE;
  reason: string;
  livenessPassed?: boolean;
  faceCount?: number;
  modelVersion?: string;
  serviceLatencyMs?: number;
  details?: unknown;
}) => {
  await db.$transaction(async (tx) => {
    await tx.attendanceFaceChallenge.updateMany({
      where: {
        id: input.challengeId,
        status: AttendanceFaceChallengeStatus.PROCESSING,
      },
      data: {
        status: AttendanceFaceChallengeStatus.FAILED,
        failureReason: input.reason.slice(0, 191),
        details: input.details == null ? undefined : jsonValue(input.details),
      },
    });
    await tx.faceVerificationAttempt.create({
      data: {
        employeeId: input.employeeId,
        challengeId: input.challengeId,
        kioskId: input.kioskId,
        punchType: input.expectedPunchType,
        status: "FAILED",
        reason: input.reason,
        livenessPassed: input.livenessPassed ?? false,
        livenessPrompt: null,
        faceCount: input.faceCount ?? null,
        modelVersion: input.modelVersion ?? null,
        serviceLatencyMs: input.serviceLatencyMs ?? null,
        details: input.details == null ? undefined : jsonValue(input.details),
      },
    });
  });
};

export const verifyAndRecordAttendanceFaceChallenge = async (input: {
  attemptId?: string | null;
  nonce?: string | null;
  kioskId?: string | null;
  frames?: unknown;
  latitude?: number | null;
  longitude?: number | null;
  requestMetadata: { ipAddress?: string | null; userAgent?: string | null };
  settings: ResolvedAttendanceSecuritySettings;
}) => {
  const attemptId = input.attemptId?.trim() || "";
  const nonce = input.nonce?.trim() || "";
  if (!attemptId || !nonce) {
    return {
      success: false as const,
      error: publicFailureMessage("invalid_challenge"),
      reason: "invalid_challenge",
    };
  }

  const challenge = await db.attendanceFaceChallenge.findUnique({
    where: { id: attemptId },
    include: {
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          isArchived: true,
          user: {
            select: { userId: true, username: true, isDisabled: true },
          },
        },
      },
      qrRedemption: { select: { tokenHash: true, usedAt: true } },
    },
  });
  if (!challenge || !challenge.employee.user) {
    return {
      success: false as const,
      error: publicFailureMessage("invalid_challenge"),
      reason: "invalid_challenge",
    };
  }
  if (challenge.employee.isArchived || challenge.employee.user.isDisabled) {
    await db.attendanceFaceChallenge.updateMany({
      where: { id: challenge.id, status: AttendanceFaceChallengeStatus.PENDING },
      data: {
        status: AttendanceFaceChallengeStatus.FAILED,
        failureReason: "user_not_eligible",
      },
    });
    return {
      success: false as const,
      error: "Employee is not eligible for attendance.",
      reason: "user_not_eligible",
    };
  }
  if (challenge.qrRedemption?.usedAt) {
    return {
      success: false as const,
      error: "Employee QR was already used. Scan a fresh QR.",
      reason: "qr_replayed",
    };
  }

  const kioskId = normalizeKioskId(input.kioskId);
  const bindingHash = createKioskBindingHash({
    kioskId,
    ...input.requestMetadata,
  });
  const now = new Date();
  if (
    challenge.status === AttendanceFaceChallengeStatus.PENDING &&
    challenge.expiresAt <= now
  ) {
    await db.attendanceFaceChallenge.updateMany({
      where: { id: challenge.id, status: AttendanceFaceChallengeStatus.PENDING },
      data: {
        status: AttendanceFaceChallengeStatus.EXPIRED,
        failureReason: "challenge_expired",
      },
    });
  }
  if (
    challenge.status !== AttendanceFaceChallengeStatus.PENDING ||
    challenge.expiresAt <= now ||
    challenge.kioskBindingHash !== bindingHash ||
    !challengeNonceMatches(nonce, challenge.nonceHash)
  ) {
    return {
      success: false as const,
      error: publicFailureMessage(
        challenge.expiresAt <= now ? "challenge_expired" : "invalid_challenge",
      ),
      reason:
        challenge.expiresAt <= now ? "challenge_expired" : "invalid_challenge",
    };
  }

  let captured: ReturnType<typeof validateAndHashFrameSequence>;
  try {
    captured = validateAndHashFrameSequence(input.frames, {
      minFrames: 18,
      maxFrames: input.settings.faceChallengeMaxFrames,
      maxPayloadBytes: input.settings.faceChallengeMaxPayloadBytes,
    });
  } catch (error) {
    const reason =
      error instanceof FaceChallengeValidationError
        ? error.reason
        : "invalid_frame_sequence";
    await db.attendanceFaceChallenge.updateMany({
      where: { id: challenge.id, status: AttendanceFaceChallengeStatus.PENDING },
      data: {
        status: AttendanceFaceChallengeStatus.FAILED,
        failureReason: reason,
      },
    });
    return { success: false as const, error: publicFailureMessage(reason), reason };
  }

  try {
    const claimed = await db.attendanceFaceChallenge.updateMany({
      where: {
        id: challenge.id,
        status: AttendanceFaceChallengeStatus.PENDING,
        expiresAt: { gt: now },
      },
      data: {
        status: AttendanceFaceChallengeStatus.PROCESSING,
        processingStartedAt: now,
        frameSequenceHash: captured.sequenceHash,
      },
    });
    if (claimed.count !== 1) {
      return {
        success: false as const,
        error: publicFailureMessage("challenge_used"),
        reason: "challenge_used",
      };
    }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      await db.attendanceFaceChallenge.updateMany({
        where: { id: challenge.id, status: AttendanceFaceChallengeStatus.PENDING },
        data: {
          status: AttendanceFaceChallengeStatus.FAILED,
          failureReason: "replay_detected",
        },
      });
      return {
        success: false as const,
        error: publicFailureMessage("replay_detected"),
        reason: "replay_detected",
      };
    }
    throw error;
  }

  let actions: FaceChallengeAction[] = [];
  let serviceResult: Awaited<ReturnType<typeof verifyFaceChallenge>> | null = null;
  try {
    actions = parseFaceChallengeActions(challenge.actions);
    serviceResult = await verifyFaceChallenge({
      frames: captured.frames,
      actions,
    });
    if (!serviceResult.livenessPassed) {
      throw new AttendanceChallengeError(
        "Server liveness check failed.",
        "liveness_failed",
      );
    }
    if (
      input.settings.passiveAntiSpoofRequired &&
      serviceResult.antiSpoof.status === "UNAVAILABLE"
    ) {
      throw new AttendanceChallengeError(
        "Passive anti-spoof is unavailable.",
        "anti_spoof_unavailable",
      );
    }
    if (serviceResult.antiSpoof.status === "FAILED") {
      throw new AttendanceChallengeError("Spoof suspected.", "spoof_suspected");
    }

    const [targetRows, otherRows] = await Promise.all([
      db.employeeFaceEnrollment.findMany({
        where: { employeeId: challenge.employeeId, isActive: true },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { embedding: true, modelVersion: true },
      }),
      db.employeeFaceEnrollment.findMany({
        where: { employeeId: { not: challenge.employeeId }, isActive: true },
        select: {
          id: true,
          employeeId: true,
          embedding: true,
          modelVersion: true,
        },
      }),
    ]);
    const targetEmbeddings = targetRows
      .filter((row) => isInsightFaceModel(row.modelVersion))
      .map((row) => decryptFaceEmbedding(row.embedding));
    if (targetEmbeddings.length === 0) {
      throw new AttendanceChallengeError(
        "Active InsightFace enrollment required.",
        "no_face_enrollment",
      );
    }
    const otherEmbeddings = otherRows
      .filter((row) => isInsightFaceModel(row.modelVersion))
      .map((row) => ({
        employeeId: row.employeeId,
        enrollmentId: row.id,
        embedding: decryptFaceEmbedding(row.embedding),
      }));
    const identityResult = evaluateIdentitySequence({
      embeddings: serviceResult.embeddings,
      representativeIndices: serviceResult.representativeIndices,
      targetEmbeddings,
      otherEmbeddings,
      matchThreshold: Number(input.settings.faceMatchMaxDistance),
      continuityThreshold: Number(input.settings.faceContinuityMaxDistance),
      ambiguityMargin: FACE_MATCH_AMBIGUITY_MARGIN,
      requiredRepresentativeFrames: input.settings.faceContinuityFrameCount,
    });
    if (!identityResult.success) {
      throw new AttendanceChallengeError(
        "Face identity check failed.",
        identityResult.reason,
      );
    }
    if (!serviceResult) {
      throw new AttendanceChallengeError(
        "Face service returned no result.",
        "face_service_error",
      );
    }
    const verifiedServiceResult = serviceResult;

    const punchTime = zonedNow();
    const details = {
      frameCount: captured.frames.length,
      payloadBytes: captured.totalBytes,
      frameSequenceHash: captured.sequenceHash,
      actions,
      actionResults: serviceResult.actionResults,
      antiSpoof: serviceResult.antiSpoof,
      quality: serviceResult.quality,
      identity: identityResult,
    };
    const committed = await db.$transaction(
      async (tx) => {
        await lockEmployeePunchFlow(tx, challenge.employeeId);
        const locked = await tx.attendanceFaceChallenge.findUnique({
          where: { id: challenge.id },
          select: {
            status: true,
            expiresAt: true,
            kioskBindingHash: true,
            frameSequenceHash: true,
            expectedPunchType: true,
          },
        });
        if (
          !locked ||
          locked.status !== AttendanceFaceChallengeStatus.PROCESSING ||
          locked.expiresAt <= punchTime ||
          locked.kioskBindingHash !== bindingHash ||
          locked.frameSequenceHash !== captured.sequenceHash
        ) {
          throw new AttendanceChallengeError(
            "Challenge expired or already used.",
            "challenge_used",
          );
        }
        const { dayStart } = await assertCurrentPunchSequence({
          tx,
          employeeId: challenge.employeeId,
          expectedPunchType: locked.expectedPunchType,
          now: punchTime,
        });
        const punch = await tx.punch.create({
          data: {
            employeeId: challenge.employeeId,
            punchType: locked.expectedPunchType,
            punchTime,
            source: "KIOSK_FACE_CHALLENGE",
            ipAddress: input.requestMetadata.ipAddress?.slice(0, 191) ?? null,
            userAgent: input.requestMetadata.userAgent?.slice(0, 1000) ?? null,
            latitude: normalizeLatitude(input.latitude),
            longitude: normalizeLongitude(input.longitude),
          },
        });
        await tx.attendanceFaceChallenge.update({
          where: { id: challenge.id },
          data: {
            status: AttendanceFaceChallengeStatus.PASSED,
            usedAt: punchTime,
            punchId: punch.id,
            failureReason: null,
            details: jsonValue(details),
          },
        });
        if (challenge.qrRedemption) {
          const consumedQr = await tx.attendanceQrRedemption.updateMany({
            where: {
              tokenHash: challenge.qrRedemption.tokenHash,
              challengeId: challenge.id,
              usedAt: null,
            },
            data: { usedAt: punchTime, punchId: punch.id },
          });
          if (consumedQr.count !== 1) {
            throw new AttendanceChallengeError(
              "Employee QR was already used.",
              "qr_replayed",
            );
          }
        }
        const attempt = await tx.faceVerificationAttempt.create({
          data: {
            employeeId: challenge.employeeId,
            challengeId: challenge.id,
            punchId: punch.id,
            kioskId,
            punchType: punch.punchType,
            status: "PASSED",
            reason: "face_challenge_passed",
            distance: identityResult.worstTargetDistance,
            threshold: input.settings.faceMatchMaxDistance,
            livenessPassed: true,
            livenessPrompt: actions.join(" then "),
            faceCount: verifiedServiceResult.faceCount,
            modelVersion: verifiedServiceResult.modelVersion,
            serviceLatencyMs: verifiedServiceResult.serviceLatencyMs,
            details: jsonValue(details),
          },
        });
        return { punch, dayStart, attemptId: attempt.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const recomputed = await recomputeAttendanceForDay(
      challenge.employeeId,
      punchTime,
    ).catch((error) => {
      console.error("Punch saved but attendance recompute failed", error);
      return null;
    });
    if (recomputed?.attendance?.id) {
      await captureAttendanceSecurityEvent({
        punchId: committed.punch.id,
        attendanceId: recomputed.attendance.id,
        employeeId: challenge.employeeId,
        punchTime,
        payload: {
          ...input.requestMetadata,
          latitude: input.latitude,
          longitude: input.longitude,
        },
      }).catch((error) => console.error("Attendance context audit failed", error));
      await db.faceVerificationAttempt
        .update({
          where: { id: committed.attemptId },
          data: { attendanceId: recomputed.attendance.id },
        })
        .catch(() => null);
    }
    await publishAttendanceUpdate({
      employeeId: challenge.employeeId,
      workDate: committed.dayStart,
      punchId: committed.punch.id,
    }).catch((error) => console.error("Attendance live update failed", error));

    const identity: ActiveEmployeeIdentity = {
      userId: challenge.employee.user.userId,
      username: challenge.employee.user.username,
      employeeId: challenge.employee.employeeId,
      employeeCode: challenge.employee.employeeCode,
      firstName: challenge.employee.firstName,
      lastName: challenge.employee.lastName,
      isDisabled: challenge.employee.user.isDisabled,
      isArchived: challenge.employee.isArchived,
    };
    const context: KioskPunchContext = {
      employee: identity,
      nextPunch: committed.punch.punchType,
      now: punchTime,
      dayStart: committed.dayStart,
    };
    return {
      success: true as const,
      data: {
        ...buildPunchSuccessPayload(context, committed.punch),
        faceVerified: true,
        faceDistance: identityResult.worstTargetDistance,
        faceThreshold: Number(input.settings.faceMatchMaxDistance),
        livenessPassed: true,
      },
    };
  } catch (error) {
    const reason =
      error instanceof AttendanceChallengeError ||
      error instanceof FaceServiceError ||
      error instanceof FaceChallengeValidationError
        ? error.reason
        : "face_verification_error";
    await recordFailedAttempt({
      challengeId: challenge.id,
      employeeId: challenge.employeeId,
      kioskId,
      expectedPunchType: challenge.expectedPunchType,
      reason,
      livenessPassed: serviceResult?.livenessPassed,
      faceCount: serviceResult?.faceCount,
      modelVersion: serviceResult?.modelVersion,
      serviceLatencyMs: serviceResult?.serviceLatencyMs,
      details: serviceResult
        ? {
            frameCount: captured.frames.length,
            payloadBytes: captured.totalBytes,
            actions,
            actionResults: serviceResult.actionResults,
            antiSpoof: serviceResult.antiSpoof,
            quality: serviceResult.quality,
          }
        : { frameCount: captured.frames.length, actions },
    }).catch((auditError) => console.error("Face failure audit failed", auditError));
    return {
      success: false as const,
      error: publicFailureMessage(reason),
      reason,
    };
  }
};

export const recordAtomicQrOnlyPunch = async (input: {
  identity: ActiveEmployeeIdentity;
  expectedPunchType: PUNCH_TYPE;
  token: string;
  tokenExpiresAt: number;
  kioskId: unknown;
  requestMetadata: { ipAddress?: string | null; userAgent?: string | null };
  payload?: AttendanceSecurityPayload;
}) => {
  const now = zonedNow();
  if (input.tokenExpiresAt <= now.getTime()) {
    throw new AttendanceChallengeError(
      "Employee QR expired. Scan a fresh QR.",
      "qr_expired",
    );
  }
  const kioskId = normalizeKioskId(input.kioskId);
  const kioskBindingHash = createKioskBindingHash({
    kioskId,
    ...input.requestMetadata,
  });
  const tokenHash = hashAttendanceQrToken(input.token);

  try {
    return await db.$transaction(
      async (tx) => {
        await lockEmployeePunchFlow(tx, input.identity.employeeId);
        const { dayStart } = await assertCurrentPunchSequence({
          tx,
          employeeId: input.identity.employeeId,
          expectedPunchType: input.expectedPunchType,
          now,
        });
        await tx.attendanceQrRedemption.create({
          data: {
            tokenHash,
            employeeId: input.identity.employeeId,
            kioskBindingHash,
            expiresAt: new Date(input.tokenExpiresAt),
            usedAt: now,
          },
        });
        const punch = await tx.punch.create({
          data: {
            employeeId: input.identity.employeeId,
            punchType: input.expectedPunchType,
            punchTime: now,
            source: "KIOSK_QR",
            ipAddress: input.requestMetadata.ipAddress?.slice(0, 191) ?? null,
            userAgent: input.requestMetadata.userAgent?.slice(0, 1000) ?? null,
            latitude: normalizeLatitude(input.payload?.latitude),
            longitude: normalizeLongitude(input.payload?.longitude),
          },
        });
        await tx.attendanceQrRedemption.update({
          where: { tokenHash },
          data: { punchId: punch.id },
        });
        return { punch, dayStart };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AttendanceChallengeError(
        "Employee QR was already used. Scan a fresh QR.",
        "qr_replayed",
      );
    }
    throw error;
  }
};
