"use client";

import { useEffect, useRef, useState } from "react";
import {
  enrollEmployeeFace,
  listEmployeeFaceEnrollments,
  listEmployeeFaceVerificationAttempts,
  revokeEmployeeFaceEnrollment,
} from "@/actions/attendance/attendance-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineLoadingState } from "@/components/loading/loading-states";
import { useToast } from "@/components/ui/toast-provider";
import {
  FaceCaptureClientError,
  captureFrontFaceFrames,
} from "@/lib/face-capture-client";

type FaceEnrollmentRow = {
  id: string;
  employeeId: string;
  sampleCount: number;
  modelVersion: string;
  consentText: string | null;
  consentedAt: string | null;
  enrolledByUserId: string | null;
  revokedByUserId: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type FaceAttemptRow = {
  id: string;
  punchType: string | null;
  status: string;
  reason: string | null;
  distance: number | null;
  threshold: number | null;
  livenessPassed: boolean | null;
  livenessPrompt: string | null;
  faceCount: number | null;
  modelVersion: string | null;
  createdAt: string;
};

const REQUIRED_SAMPLES = 3;
const MAX_SAMPLES = 5;

type EnrollmentMode = "add" | "replace";

const enrollmentSteps = [
  {
    id: "center",
    label: "Center",
    prompt: "CENTER FACE",
    hint: "Look straight at the camera.",
  },
  {
    id: "hold-front",
    label: "Hold",
    prompt: "HOLD STILL",
    hint: "Keep facing the camera.",
  },
  {
    id: "blink",
    label: "Blink",
    prompt: "BLINK ONCE",
    hint: "Blink once while facing forward.",
  },
  {
    id: "hold-centered",
    label: "Hold",
    prompt: "HOLD STILL",
    hint: "Keep your face centered.",
  },
  {
    id: "final-front",
    label: "Finish",
    prompt: "FINAL FRONT FACE",
    hint: "Look straight for the final sample.",
  },
] as const;

const cameraUnavailableMessage =
  "Camera is unavailable in this browser context. Open this page over HTTPS or use localhost on the same device.";

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

export function EmployeeFaceEnrollmentCard({
  employeeId,
}: {
  employeeId: string;
}) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoCaptureBusyRef = useRef(false);
  const lastAutoCaptureAtRef = useRef(0);
  const [rows, setRows] = useState<FaceEnrollmentRow[]>([]);
  const [attempts, setAttempts] = useState<FaceAttemptRow[]>([]);
  const [samples, setSamples] = useState<string[]>([]);
  const [liveFeedback, setLiveFeedback] = useState(
    "Open camera and center one face.",
  );
  const [autoCapture, setAutoCapture] = useState(true);
  const [capturePulse, setCapturePulse] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollmentMode, setEnrollmentMode] =
    useState<EnrollmentMode>("replace");
  const [error, setError] = useState<string | null>(null);

  const activeEnrollments = rows.filter((row) => row.isActive);
  const activeEnrollment = activeEnrollments[0] ?? null;
  const currentStep =
    enrollmentSteps[Math.min(samples.length, enrollmentSteps.length - 1)];
  const progressPercent = Math.min(
    100,
    Math.round((samples.length / REQUIRED_SAMPLES) * 100),
  );
  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await listEmployeeFaceEnrollments(employeeId);
      const attemptsResult =
        await listEmployeeFaceVerificationAttempts(employeeId);
      if (!result.success) {
        throw new Error(result.error || "Failed to load face enrollments");
      }
      if (!attemptsResult.success) {
        throw new Error(
          attemptsResult.error || "Failed to load face verification attempts",
        );
      }
      setRows((result.data as FaceEnrollmentRow[] | undefined) ?? []);
      setAttempts((attemptsResult.data as FaceAttemptRow[] | undefined) ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load face enrollments",
      );
    } finally {
      setLoading(false);
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraStream(null);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setLiveFeedback("Open camera and center one face.");
    setCapturePulse(false);
    autoCaptureBusyRef.current = false;
    lastAutoCaptureAtRef.current = 0;
    setCameraReady(false);
    setCameraOpen(false);
  };

  const startCamera = async (mode: EnrollmentMode = "replace") => {
    try {
      setError(null);
      setEnrollmentMode(mode);
      setSamples([]);
      setLiveFeedback("Starting camera...");
      setCapturePulse(false);
      autoCaptureBusyRef.current = false;
      lastAutoCaptureAtRef.current = 0;
      setCameraReady(false);
      setModelsReady(true);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraStream(null);
      setCameraOpen(true);
      setLiveFeedback("Allow camera, then center one face.");
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new Error(cameraUnavailableMessage);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraStream(stream);
      setLiveFeedback("Camera starting...");
    } catch (err) {
      setCameraOpen(false);
      setCameraReady(false);
      setCameraStream(null);
      setError(
        err instanceof Error ? err.message : "Camera permission was denied.",
      );
    }
  };

  const captureSample = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    try {
      setCapturing(true);
      setError(null);
      const capture = await captureFrontFaceFrames(video, { frameCount: 1 });
      const sample = capture.frames[0];
      if (!sample) throw new Error("Face sample could not be captured.");
      setLiveFeedback("Sample saved");
      setSamples((current) =>
        current.length >= MAX_SAMPLES ? current : [...current, sample],
      );
      setCapturePulse(true);
      window.setTimeout(() => setCapturePulse(false), 280);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Face sample could not be captured.",
      );
      setLiveFeedback("Face not ready");
    } finally {
      setCapturing(false);
    }
  };

  const submitEnrollment = async () => {
    try {
      setSaving(true);
      setError(null);
      const result = await enrollEmployeeFace({
        employeeId,
        frames: samples,
        faceMetadata: {
          source: "browser-frame-capture",
          sampleCount: samples.length,
        },
        replaceExisting: enrollmentMode === "replace",
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to enroll face");
      }
      toast.success("Face enrollment saved.", {
        description:
          enrollmentMode === "replace"
            ? "Encrypted face template replaced existing active templates."
            : "Encrypted face variant is now active for QR punches.",
      });
      stopCamera();
      setSamples([]);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enroll face";
      setError(message);
      toast.error("Failed to enroll face.", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const revokeActiveEnrollment = async () => {
    if (!activeEnrollment) return;
    try {
      setSaving(true);
      const result = await revokeEmployeeFaceEnrollment({
        enrollmentId: activeEnrollment.id,
        reason: "Revoked from employee profile.",
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to revoke face enrollment");
      }
      toast.success("Face enrollment revoked.");
      await load();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to revoke face enrollment";
      setError(message);
      toast.error("Failed to revoke face enrollment.", { description: message });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  useEffect(() => {
    if (!cameraOpen || !cameraStream || !videoRef.current) return;

    const video = videoRef.current;
    setCameraReady(false);

    const markReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setError(null);
        setCameraReady(true);
      }
    };

    video.addEventListener("loadedmetadata", markReady);
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);
    video.srcObject = cameraStream;

    const frameTimeout = window.setTimeout(() => {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        setError(
          "Camera permission is active, but no video frames are arriving. Close other apps or browser tabs using the camera, then retry.",
        );
      }
    }, 3000);

    void video
      .play()
      .then(markReady)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Camera preview could not start.",
        );
      });

    return () => {
      window.clearTimeout(frameTimeout);
      video.removeEventListener("loadedmetadata", markReady);
      video.removeEventListener("loadeddata", markReady);
      video.removeEventListener("canplay", markReady);
      video.removeEventListener("playing", markReady);
    };
  }, [cameraOpen, cameraStream]);

  useEffect(() => {
    if (
      !cameraOpen ||
      !cameraReady ||
      !modelsReady ||
      !autoCapture ||
      saving ||
      capturing ||
      samples.length >= MAX_SAMPLES
    ) {
      return;
    }

    let cancelled = false;

    const scanFrame = async () => {
      const video = videoRef.current;
      if (
        !video ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        autoCaptureBusyRef.current
      ) {
        return;
      }

      autoCaptureBusyRef.current = true;

      try {
        const capture = await captureFrontFaceFrames(video, { frameCount: 1 });
        if (cancelled) return;
        const sample = capture.frames[0];
        if (!sample) throw new FaceCaptureClientError(
          "Camera frame could not be captured.",
          "frame_capture_failed",
        );

        setLiveFeedback(`${currentStep.hint} Hold still...`);

        if (
          Date.now() - lastAutoCaptureAtRef.current > 1600
        ) {
          lastAutoCaptureAtRef.current = Date.now();
          setSamples((current) =>
            current.length >= MAX_SAMPLES ? current : [...current, sample],
          );
          setError(null);
          setLiveFeedback(
            samples.length + 1 >= REQUIRED_SAMPLES
              ? "Enough samples captured. Save when ready."
              : "Sample captured. Follow next prompt.",
          );
          setCapturePulse(true);
          window.setTimeout(() => {
            if (!cancelled) setCapturePulse(false);
          }, 280);
        }
      } catch (err) {
        if (cancelled) return;
        setLiveFeedback(
          err instanceof Error ? err.message : "Center one face in frame.",
        );
      } finally {
        autoCaptureBusyRef.current = false;
      }
    };

    const interval = window.setInterval(() => {
      void scanFrame();
    }, 850);
    void scanFrame();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    autoCapture,
    cameraOpen,
    cameraReady,
    capturing,
    currentStep.hint,
    modelsReady,
    samples.length,
    saving,
  ]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Face Enrollment</CardTitle>
            <CardDescription>
              Stores encrypted face templates for QR attendance verification. Raw
              photos are not saved.
            </CardDescription>
          </div>
          <Badge variant={activeEnrollment ? "success" : "secondary"}>
            {activeEnrollment ? "Active" : "Not enrolled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <InlineLoadingState
            label="Loading face enrollment"
            lines={2}
            className="border-border/60 bg-muted/10"
          />
        ) : (
          <div className="rounded-lg border bg-background/60 p-3 text-sm">
            <p>
              <span className="font-medium">Active enrollments:</span>{" "}
              {activeEnrollments.length > 0
                ? `${activeEnrollments.length} active template${
                    activeEnrollments.length === 1 ? "" : "s"
                  }, latest has ${activeEnrollment?.sampleCount ?? 0} samples`
                : "None"}
            </p>
            <p className="text-muted-foreground">
              Last enrolled: {formatDateTime(activeEnrollment?.createdAt)}
            </p>
          </div>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {cameraOpen ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_1fr]">
              <div className="space-y-3">
                <div
                  className={`relative mx-auto max-w-sm overflow-hidden rounded-xl bg-black ring-2 transition ${
                    capturePulse ? "ring-emerald-400" : "ring-border/60"
                  }`}
                >
                  <div className="pointer-events-none absolute inset-x-3 top-3 z-20 rounded-lg bg-black/75 px-3 py-3 text-center text-xl font-bold tracking-wide text-white">
                    {currentStep.prompt}
                  </div>
                  <video
                    ref={videoRef}
                    className="aspect-[4/3] w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
                  >
                    <div className="relative h-[62%] w-[52%] rounded-[50%] border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.28)]">
                      <div className="absolute left-[18%] right-[18%] top-[38%] border-t border-white/70" />
                      <div className="absolute bottom-[18%] left-1/2 top-[18%] border-l border-white/35" />
                      <div className="absolute -bottom-[18%] left-1/2 h-[22%] w-[78%] -translate-x-1/2 rounded-t-full border-t border-white/50" />
                    </div>
                  </div>
                  <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 rounded-lg bg-background/90 px-3 py-2 text-center text-sm font-medium text-foreground">
                    {liveFeedback}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Auto-capture sends temporary frames to the local Python face service. Raw photos are not saved.
                </p>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">
                      {samples.length >= REQUIRED_SAMPLES
                        ? "Ready to save"
                        : `Need ${REQUIRED_SAMPLES - samples.length} more`}
                    </span>
                    <span className="text-muted-foreground">
                      {samples.length}/{MAX_SAMPLES}
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-5 lg:grid-cols-1 xl:grid-cols-5">
                  {enrollmentSteps.map((step, index) => {
                    const done = samples.length > index;
                    const active = samples.length === index;
                    return (
                      <div
                        key={step.id}
                        className={`rounded-lg border px-3 py-2 text-sm transition ${
                          done
                            ? "border-emerald-500/60 bg-emerald-500/10"
                            : active
                              ? "border-primary/70 bg-primary/10"
                              : "bg-muted/20"
                        }`}
                      >
                        <p className="font-medium">{step.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {done ? "Captured" : active ? step.hint : "Pending"}
                        </p>
                      </div>
                    );
                  })}
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border bg-background/60 px-3 py-2 text-sm">
                    <p className="text-xs text-muted-foreground">Capture</p>
                    <p className="font-medium">
                      {modelsReady ? "Ready" : "Starting..."}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-background/60 px-3 py-2 text-sm">
                    <p className="text-xs text-muted-foreground">Validator</p>
                    <p className="font-medium">Python service</p>
                  </div>
                  <div className="rounded-lg border bg-background/60 px-3 py-2 text-sm">
                    <p className="text-xs text-muted-foreground">Pose</p>
                    <p className="font-medium">Use face guide</p>
                  </div>
                  <div className="rounded-lg border bg-background/60 px-3 py-2 text-sm sm:col-span-3">
                    <p className="text-xs text-muted-foreground">Face size</p>
                    <p className="font-medium">Fit face inside the oval</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={autoCapture ? "secondary" : "outline"}
                onClick={() => setAutoCapture((current) => !current)}
                disabled={saving}
              >
                Auto capture {autoCapture ? "on" : "off"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void captureSample()}
                disabled={
                  !cameraReady ||
                  !modelsReady ||
                  capturing ||
                  samples.length >= MAX_SAMPLES ||
                  saving
                }
              >
                {capturing
                  ? "Reading face..."
                  : "Capture now"}
              </Button>
              <Button
                type="button"
                onClick={() => void submitEnrollment()}
                disabled={samples.length < REQUIRED_SAMPLES || saving}
              >
                {saving
                  ? "Saving..."
                  : enrollmentMode === "replace"
                    ? "Replace all templates"
                    : "Save appearance variant"}
              </Button>
              {samples.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSamples([]);
                    setLiveFeedback("Samples cleared. Center one face.");
                  }}
                  disabled={saving}
                >
                  Reset samples
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                onClick={stopCamera}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() =>
                void startCamera(activeEnrollment ? "add" : "replace")
              }
            >
              {activeEnrollment ? "Add appearance variant" : "Enroll front face"}
            </Button>
            {activeEnrollment ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void startCamera("replace")}
                disabled={saving}
              >
                Replace all templates
              </Button>
            ) : null}
            {activeEnrollment ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void revokeActiveEnrollment()}
                disabled={saving}
              >
                Revoke latest enrollment
              </Button>
            ) : null}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-semibold">Recent face attempts</p>
          {attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No face verification attempts yet.
            </p>
          ) : (
            <div className="space-y-2">
              {attempts.slice(0, 5).map((attempt) => (
                <div
                  key={attempt.id}
                  className="flex flex-col gap-1 rounded-lg border bg-background/60 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">
                      {attempt.punchType || "Face check"} · {attempt.status}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(attempt.createdAt)}
                      {attempt.reason ? ` · ${attempt.reason}` : ""}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {attempt.distance != null
                      ? `Distance ${attempt.distance.toFixed(3)}${
                          attempt.threshold != null
                            ? ` / threshold ${attempt.threshold.toFixed(2)}`
                            : ""
                        }`
                      : "No score"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
