"use client";

export type FaceFrameCapture = {
  frames: string[];
  metadata: {
    validFrames: number;
    totalFrames: number;
    elapsedMs: number;
  };
};

export type FaceChallengeCapture = {
  frames: string[];
  elapsedMs: number;
  totalFrames: number;
};

export type BrowserFaceChallengeAction =
  | "BLINK"
  | "TURN_LEFT"
  | "TURN_RIGHT";

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
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const [, base64] = dataUrl.split(",", 2);
  if (!base64) {
    throw new FaceCaptureClientError(
      "Camera frame could not be encoded.",
      "frame_encode_failed",
      0,
    );
  }

  return base64;
};

const captureChallengeJpegFrame = (video: HTMLVideoElement) => {
  ensureVideoReady(video);
  const width = 480;
  const height = 360;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new FaceCaptureClientError(
      "Camera frame could not be captured.",
      "frame_capture_failed",
    );
  }

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;
  if (sourceRatio > targetRatio) {
    sourceWidth = Math.round(video.videoHeight * targetRatio);
    sourceX = Math.round((video.videoWidth - sourceWidth) / 2);
  } else {
    sourceHeight = Math.round(video.videoWidth / targetRatio);
    sourceY = Math.round((video.videoHeight - sourceHeight) / 2);
  }
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
  const [, base64] = canvas.toDataURL("image/jpeg", 0.65).split(",", 2);
  if (!base64) {
    throw new FaceCaptureClientError(
      "Camera frame could not be encoded.",
      "frame_encode_failed",
    );
  }
  return base64;
};

const actionPrompt = (action: BrowserFaceChallengeAction) => {
  switch (action) {
    case "BLINK":
      return "Blink once";
    case "TURN_LEFT":
      return "Turn head left";
    case "TURN_RIGHT":
      return "Turn head right";
  }
};

export const captureFaceChallengeFrames = async (
  video: HTMLVideoElement,
  actions: BrowserFaceChallengeAction[],
  onPrompt?: (prompt: string) => void,
): Promise<FaceChallengeCapture> => {
  if (
    actions.length !== 2 ||
    !actions.includes("BLINK") ||
    !actions.some((action) => action.startsWith("TURN_"))
  ) {
    throw new FaceCaptureClientError(
      "Face challenge is invalid. Start again.",
      "invalid_challenge_actions",
    );
  }

  const startedAt = performance.now();
  const frames: string[] = [];
  const frameCount = 24;
  const delayMs = 200;

  for (let index = 0; index < frameCount; index += 1) {
    if (index === 0) onPrompt?.("Face camera directly");
    if (index === 4) onPrompt?.(actionPrompt(actions[0]));
    if (index === 10) onPrompt?.("Face camera directly");
    if (index === 13) onPrompt?.(actionPrompt(actions[1]));
    if (index === 19) onPrompt?.("Face camera directly");
    frames.push(captureChallengeJpegFrame(video));
    if (index < frameCount - 1) await delay(delayMs);
  }

  return {
    frames,
    elapsedMs: Math.round(performance.now() - startedAt),
    totalFrames: frames.length,
  };
};

export const captureFrontFaceFrames = async (
  video: HTMLVideoElement,
  options?: {
    frameCount?: number;
    delayMs?: number;
  },
): Promise<FaceFrameCapture> => {
  const startedAt = performance.now();
  const frameCount = options?.frameCount ?? 5;
  const delayMs = options?.delayMs ?? 180;
  const frames: string[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    frames.push(captureJpegFrame(video));
    if (index < frameCount - 1) {
      await delay(delayMs);
    }
  }

  return {
    frames,
    metadata: {
      validFrames: frames.length,
      totalFrames: frameCount,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
  };
};
