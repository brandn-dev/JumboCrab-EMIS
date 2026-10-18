import "server-only";

export const INSIGHTFACE_MODEL_PREFIX = "insightface/";
export const INSIGHTFACE_MODEL_VERSION = "insightface/arcface";
export const INSIGHTFACE_EMBEDDING_LENGTH = 512;

export type FaceServiceQuality = {
  detectionScore?: number;
  faceBoxRatio?: number;
  yawRatio?: number | null;
  frontFace?: boolean;
};

export type FaceServiceEmbeddingResult = {
  embedding: number[];
  modelVersion: string;
  faceCount: number;
  quality: FaceServiceQuality;
  serviceLatencyMs?: number;
};

export class FaceServiceError extends Error {
  reason: string;
  faceCount: number;
  statusCode?: number;

  constructor(
    message: string,
    reason: string,
    options?: { faceCount?: number; statusCode?: number },
  ) {
    super(message);
    this.name = "FaceServiceError";
    this.reason = reason;
    this.faceCount = options?.faceCount ?? 0;
    this.statusCode = options?.statusCode;
  }
}

const serviceUrl = () => {
  const url = process.env.FACE_SERVICE_URL?.trim();
  if (!url) {
    throw new FaceServiceError(
      "Face verification service is not configured.",
      "face_service_not_configured",
    );
  }
  return url.replace(/\/+$/, "");
};

const normalizeEmbedding = (embedding: unknown) => {
  if (!Array.isArray(embedding) || embedding.length !== INSIGHTFACE_EMBEDDING_LENGTH) {
    return null;
  }

  const values = embedding.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values;
};

export const isInsightFaceModel = (modelVersion?: string | null) =>
  typeof modelVersion === "string" &&
  modelVersion.toLowerCase().startsWith(INSIGHTFACE_MODEL_PREFIX);

export const embedFaceFrames = async (input: {
  frames: string[];
  purpose: "enrollment" | "verification";
  requireFrontFace?: boolean;
}) => {
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new FaceServiceError("Face frames are required.", "missing_face_frames");
  }

  const controller = new AbortController();
  const timeout = windowlessSetTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${serviceUrl()}/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.FACE_SERVICE_API_KEY
          ? { "x-face-service-key": process.env.FACE_SERVICE_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        frames: input.frames,
        purpose: input.purpose,
        requireFrontFace: input.requireFrontFace !== false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      reason?: string;
      embedding?: unknown;
      modelVersion?: string;
      faceCount?: number;
      quality?: FaceServiceQuality;
      serviceLatencyMs?: number;
    } | null;

    if (!response.ok || !payload?.success) {
      throw new FaceServiceError(
        payload?.error || "Face verification service rejected the face.",
        payload?.reason || "face_service_error",
        {
          faceCount: payload?.faceCount,
          statusCode: response.status,
        },
      );
    }

    const embedding = normalizeEmbedding(payload.embedding);
    if (!embedding) {
      throw new FaceServiceError(
        "Face verification service returned an invalid embedding.",
        "invalid_face_embedding",
      );
    }

    return {
      embedding,
      modelVersion: payload.modelVersion || INSIGHTFACE_MODEL_VERSION,
      faceCount:
        typeof payload.faceCount === "number" && Number.isFinite(payload.faceCount)
          ? Math.max(0, Math.round(payload.faceCount))
          : 1,
      quality: payload.quality ?? {},
      serviceLatencyMs:
        typeof payload.serviceLatencyMs === "number" &&
        Number.isFinite(payload.serviceLatencyMs)
          ? Math.round(payload.serviceLatencyMs)
          : undefined,
    } satisfies FaceServiceEmbeddingResult;
  } catch (error) {
    if (error instanceof FaceServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new FaceServiceError(
        "Face verification service timed out.",
        "face_service_timeout",
      );
    }
    throw new FaceServiceError(
      error instanceof Error
        ? error.message
        : "Face verification service failed.",
      "face_service_error",
    );
  } finally {
    clearTimeout(timeout);
  }
};

const windowlessSetTimeout = (handler: () => void, timeoutMs: number) =>
  setTimeout(handler, timeoutMs);
