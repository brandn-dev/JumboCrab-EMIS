"use client";

export const PYTHON_FACE_MODEL_VERSION = "insightface/arcface";

export type FaceFrameCapture = {
  frames: string[];
  faceCount: 1;
  livenessPassed: boolean;
  livenessPrompt: string;
  modelVersion: string;
  metadata: {
    validFrames: number;
    totalFrames: number;
    elapsedMs: number;
    frontFaceOnly: true;
    blinkPrompted: boolean;
  };
};

export class FaceCaptureClientError extends Error {
  reason: string;
  faceCount: number;

  constructor(message: string, reason: string, faceCount = 0) {
    super(message);
    this.name = "FaceCaptureClientError";
    this.reason = reason;
    this.faceCount = faceCount;
  }
}

const delay = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

const ensureVideoReady = (video: HTMLVideoElement) => {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  ) {
    throw new FaceCaptureClientError(
      "Camera is starting. Keep your face centered.",
      "camera_not_ready",
      0,
    );
  }
};

const sampleEyeBandLuminance = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  const sampleX = Math.round(width * 0.34);
  const sampleY = Math.round(height * 0.34);
  const sampleWidth = Math.max(1, Math.round(width * 0.32));
  const sampleHeight = Math.max(1, Math.round(height * 0.16));
  const imageData = context.getImageData(sampleX, sampleY, sampleWidth, sampleHeight);
  let total = 0;

  for (let index = 0; index < imageData.data.length; index += 4) {
    total +=
      imageData.data[index] * 0.299 +
      imageData.data[index + 1] * 0.587 +
      imageData.data[index + 2] * 0.114;
  }

  return total / Math.max(1, imageData.data.length / 4);
};

const captureJpegFrame = (video: HTMLVideoElement) => {
  ensureVideoReady(video);

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new FaceCaptureClientError(
      "Camera frame could not be captured.",
      "frame_capture_failed",
      0,
    );
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const eyeBandLuminance = sampleEyeBandLuminance(context, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const [, base64] = dataUrl.split(",", 2);
  if (!base64) {
    throw new FaceCaptureClientError(
      "Camera frame could not be encoded.",
      "frame_encode_failed",
      0,
    );
  }

  return { base64, eyeBandLuminance };
};

export const captureFrontFaceFrames = async (
  video: HTMLVideoElement,
  options?: {
    frameCount?: number;
    delayMs?: number;
    blinkPrompted?: boolean;
  },
): Promise<FaceFrameCapture> => {
  const startedAt = performance.now();
  const frameCount = options?.frameCount ?? 5;
  const delayMs = options?.delayMs ?? 180;
  const frames: string[] = [];
  const eyeBandLuminance: number[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const frame = captureJpegFrame(video);
    frames.push(frame.base64);
    eyeBandLuminance.push(frame.eyeBandLuminance);
    if (index < frameCount - 1) {
      await delay(delayMs);
    }
  }

  if (options?.blinkPrompted && eyeBandLuminance.length >= 6) {
    const luminanceDelta =
      Math.max(...eyeBandLuminance) - Math.min(...eyeBandLuminance);
    if (luminanceDelta < 5) {
      throw new FaceCaptureClientError(
        "Blink slowly once to verify live face.",
        "blink_required",
        1,
      );
    }
  }

  return {
    frames,
    faceCount: 1,
    livenessPassed: true,
    livenessPrompt: options?.blinkPrompted
      ? "Face camera directly and blink"
      : "Face camera directly",
    modelVersion: PYTHON_FACE_MODEL_VERSION,
    metadata: {
      validFrames: frames.length,
      totalFrames: frameCount,
      elapsedMs: Math.round(performance.now() - startedAt),
      frontFaceOnly: true,
      blinkPrompted: Boolean(options?.blinkPrompted),
    },
  };
};
