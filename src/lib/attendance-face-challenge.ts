import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { faceDistance } from "./face-embedding-crypto";

export const FACE_CHALLENGE_ACTIONS = [
  "BLINK",
  "TURN_LEFT",
  "TURN_RIGHT",
] as const;

export type FaceChallengeAction = (typeof FACE_CHALLENGE_ACTIONS)[number];

export type FaceChallengeLimits = {
  minFrames: number;
  maxFrames: number;
  maxPayloadBytes: number;
  maxFrameBytes?: number;
};

export class FaceChallengeValidationError extends Error {
  reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "FaceChallengeValidationError";
    this.reason = reason;
  }
}

const secret = () => {
  const value = process.env.KIOSK_CHALLENGE_SECRET || process.env.SESSION_PASSWORD;
  if (!value || value.trim().length < 16) {
    throw new Error(
      "KIOSK_CHALLENGE_SECRET or SESSION_PASSWORD must secure kiosk challenges.",
    );
  }
  return value;
};

export const normalizeKioskId = (value: unknown) => {
  if (typeof value !== "string") return "KIOSK";
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, "-");
  return normalized.slice(0, 96) || "KIOSK";
};

export const createKioskBindingHash = (input: {
  kioskId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) =>
  createHmac("sha256", secret())
    .update(normalizeKioskId(input.kioskId))
    .update("\0")
    .update(input.ipAddress?.trim() || "unknown-ip")
    .update("\0")
    .update(input.userAgent?.trim().slice(0, 512) || "unknown-agent")
    .digest("hex");

export const createChallengeNonce = () => randomBytes(32).toString("base64url");

export const hashChallengeNonce = (nonce: string) =>
  createHmac("sha256", secret()).update(nonce).digest("hex");

export const challengeNonceMatches = (nonce: string, expectedHash: string) => {
  const actual = Buffer.from(hashChallengeNonce(nonce), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const hashAttendanceQrToken = (token: string) =>
  createHash("sha256").update(token.trim()).digest("hex");

export const createRandomFaceActions = (): FaceChallengeAction[] => {
  const turn: FaceChallengeAction = randomInt(2) === 0 ? "TURN_LEFT" : "TURN_RIGHT";
  return randomInt(2) === 0 ? ["BLINK", turn] : [turn, "BLINK"];
};

export const parseFaceChallengeActions = (value: unknown): FaceChallengeAction[] => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new FaceChallengeValidationError(
      "Stored face challenge is invalid.",
      "invalid_challenge_actions",
    );
  }
  const actions = value.filter(
    (action): action is FaceChallengeAction =>
      typeof action === "string" &&
      FACE_CHALLENGE_ACTIONS.includes(action as FaceChallengeAction),
  );
  if (
    actions.length !== 2 ||
    !actions.includes("BLINK") ||
    !actions.some((action) => action.startsWith("TURN_"))
  ) {
    throw new FaceChallengeValidationError(
      "Stored face challenge is invalid.",
      "invalid_challenge_actions",
    );
  }
  return actions;
};

const base64Body = (frame: string) =>
  frame.includes(",") ? frame.split(",", 2)[1] ?? "" : frame;

export const validateAndHashFrameSequence = (
  frames: unknown,
  limits: FaceChallengeLimits,
) => {
  if (!Array.isArray(frames)) {
    throw new FaceChallengeValidationError(
      "Continuous face frames are required.",
      "missing_face_frames",
    );
  }
  if (frames.length < limits.minFrames || frames.length > limits.maxFrames) {
    throw new FaceChallengeValidationError(
      `Capture must contain ${limits.minFrames}-${limits.maxFrames} frames.`,
      "invalid_frame_count",
    );
  }

  const normalized: string[] = [];
  const sequenceHash = createHash("sha256");
  let totalBytes = 0;
  const maxFrameBytes = limits.maxFrameBytes ?? 120_000;

  frames.forEach((frame, index) => {
    if (typeof frame !== "string") {
      throw new FaceChallengeValidationError(
        "Capture contains an invalid frame.",
        "invalid_frame_encoding",
      );
    }
    const body = base64Body(frame).replace(/\s/g, "");
    if (body.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
      throw new FaceChallengeValidationError(
        "Capture contains an invalid frame.",
        "invalid_frame_encoding",
      );
    }
    const decoded = Buffer.from(body, "base64");
    if (decoded.length < 100 || decoded.length > maxFrameBytes) {
      throw new FaceChallengeValidationError(
        "Capture frame is outside allowed size.",
        "invalid_frame_size",
      );
    }
    totalBytes += decoded.length;
    if (totalBytes > limits.maxPayloadBytes) {
      throw new FaceChallengeValidationError(
        "Face capture payload is too large.",
        "face_payload_too_large",
      );
    }
    sequenceHash.update(String(index)).update("\0").update(decoded).update("\0");
    normalized.push(body);
  });

  return {
    frames: normalized,
    totalBytes,
    sequenceHash: sequenceHash.digest("hex"),
  };
};

export const evaluateIdentitySequence = (input: {
  embeddings: number[][];
  representativeIndices: number[];
  targetEmbeddings: number[][];
  otherEmbeddings: Array<{ employeeId: string; enrollmentId: string; embedding: number[] }>;
  matchThreshold: number;
  continuityThreshold: number;
  ambiguityMargin: number;
  requiredRepresentativeFrames: number;
}) => {
  if (
    input.embeddings.length < input.requiredRepresentativeFrames ||
    input.targetEmbeddings.length === 0
  ) {
    return { success: false as const, reason: "insufficient_identity_frames" };
  }

  let maxAdjacentDistance = 0;
  for (let index = 1; index < input.embeddings.length; index += 1) {
    maxAdjacentDistance = Math.max(
      maxAdjacentDistance,
      faceDistance(input.embeddings[index - 1], input.embeddings[index]),
    );
  }
  if (maxAdjacentDistance > input.continuityThreshold) {
    return {
      success: false as const,
      reason: "face_changed_during_challenge",
      maxAdjacentDistance,
    };
  }

  const representatives = Array.from(new Set(input.representativeIndices))
    .map((index) => input.embeddings[index])
    .filter((embedding): embedding is number[] => Array.isArray(embedding));
  if (representatives.length < input.requiredRepresentativeFrames) {
    return {
      success: false as const,
      reason: "insufficient_identity_frames",
      maxAdjacentDistance,
    };
  }

  let worstTargetDistance = 0;
  let nearestOtherDistance: number | null = null;
  let nearestOtherEmployeeId: string | null = null;
  let nearestOtherEnrollmentId: string | null = null;

  for (const embedding of representatives) {
    const targetDistance = Math.min(
      ...input.targetEmbeddings.map((target) => faceDistance(target, embedding)),
    );
    worstTargetDistance = Math.max(worstTargetDistance, targetDistance);
    if (!Number.isFinite(targetDistance) || targetDistance > input.matchThreshold) {
      return {
        success: false as const,
        reason: "face_mismatch",
        worstTargetDistance,
        maxAdjacentDistance,
      };
    }

    for (const other of input.otherEmbeddings) {
      const distance = faceDistance(other.embedding, embedding);
      if (nearestOtherDistance == null || distance < nearestOtherDistance) {
        nearestOtherDistance = distance;
        nearestOtherEmployeeId = other.employeeId;
        nearestOtherEnrollmentId = other.enrollmentId;
      }
    }
    if (
      nearestOtherDistance != null &&
      nearestOtherDistance <= targetDistance + input.ambiguityMargin
    ) {
      return {
        success: false as const,
        reason: "ambiguous_face_match",
        worstTargetDistance,
        maxAdjacentDistance,
        nearestOtherDistance,
        nearestOtherEmployeeId,
        nearestOtherEnrollmentId,
      };
    }
  }

  return {
    success: true as const,
    worstTargetDistance,
    maxAdjacentDistance,
    nearestOtherDistance,
    nearestOtherEmployeeId,
    nearestOtherEnrollmentId,
  };
};
