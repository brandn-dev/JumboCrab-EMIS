"use client";

import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { Search, ScanLine } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getKioskAttendanceConfig,
  getSearchEmployeeFacePreview,
  recordKioskResolvedPunch,
  resolveEmployeeAttendanceQr,
  verifyFaceAndRecordKioskPunch,
} from "@/actions/attendance/attendance-action";
import { searchKioskUsers } from "@/actions/attendance/kiosk-attendance-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast-provider";
import {
  FaceCaptureClientError,
  captureFaceChallengeFrames,
  type BrowserFaceChallengeAction,
} from "@/lib/face-capture-client";

type AttendancePunchMode =
  | "QR_ONLY"
  | "EMPLOYEE_QR_KIOSK_FACE"
  | "SEARCH_EMPLOYEE_KIOSK_FACE";

type KioskUserSuggestion = {
  username: string;
  role: string;
  employee: {
    employeeId: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
  } | null;
};

type PrimaryPunchNotice = {
  username: string;
  employeeName: string;
  employeeCode: string;
  punchType: string;
  punchTime: string;
};

type PendingFacePunch = {
  employeeName: string;
  employeeCode: string;
  username: string;
  nextPunch: string;
  attemptId: string;
  nonce: string;
  actions: BrowserFaceChallengeAction[];
  faceExpiresAt: number;
};

type KioskPrimaryAttendancePanelProps = {
  onPunchSuccess: (notice: PrimaryPunchNotice) => void | Promise<void>;
};

const darkCardClass =
  "rounded-[30px] border border-slate-800 bg-[#0b1120]/92 text-slate-100 shadow-[0_28px_80px_-48px_rgba(0,0,0,0.85)]";

const formatPunchLabel = (punchType: string) => {
  switch (punchType) {
    case "TIME_IN":
      return "TIME IN";
    case "TIME_OUT":
      return "TIME OUT";
    case "BREAK_IN":
      return "BREAK START";
    case "BREAK_OUT":
      return "BREAK END";
    default:
      return punchType.replace("_", " ").toUpperCase();
  }
};

const canUseBrowserCamera = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia);

const toErrorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

const cameraUnavailableMessage =
  "Camera unavailable. Use HTTPS or kiosk fallback when camera access is blocked.";

const getBrowserKioskId = () =>
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_KIOSK_ID || window.location.hostname
    : process.env.NEXT_PUBLIC_KIOSK_ID || "KIOSK";

const modeLabel = (mode: AttendancePunchMode) => {
  switch (mode) {
    case "EMPLOYEE_QR_KIOSK_FACE":
      return "Employee QR -> Kiosk Face";
    case "SEARCH_EMPLOYEE_KIOSK_FACE":
      return "Search Employee -> Kiosk Face";
    default:
      return "QR Only";
  }
};

export function KioskPrimaryAttendancePanel({
  onPunchSuccess,
}: KioskPrimaryAttendancePanelProps) {
  const toast = useToast();
  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const faceVideoRef = useRef<HTMLVideoElement | null>(null);
  const faceStreamRef = useRef<MediaStream | null>(null);
  const faceAttemptSessionRef = useRef(0);
  const reader = useMemo(() => new BrowserMultiFormatReader(), []);
  const [mode, setMode] = useState<AttendancePunchMode>("QR_ONLY");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"READY" | "SCANNING" | "FACE">("READY");
  const [processing, setProcessing] = useState(false);
  const [pendingFacePunch, setPendingFacePunch] = useState<PendingFacePunch | null>(
    null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [suggestions, setSuggestions] = useState<KioskUserSuggestion[]>([]);
  const [fetchingSuggestions, setFetchingSuggestions] = useState(false);
  const [faceStream, setFaceStream] = useState<MediaStream | null>(null);
  const [faceCameraReady, setFaceCameraReady] = useState(false);
  const [faceModelsReady, setFaceModelsReady] = useState(false);
  const [faceSubmitting, setFaceSubmitting] = useState(false);
  const [faceAutoStatus, setFaceAutoStatus] = useState("Starting camera");
  const [faceNow, setFaceNow] = useState(Date.now());
  const [browserCameraAvailable, setBrowserCameraAvailable] = useState(true);

  const loadConfig = useCallback(async () => {
    try {
      setLoadingConfig(true);
      setError(null);
      const result = await getKioskAttendanceConfig();
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to load kiosk attendance mode");
      }
      setMode((result.data.attendancePunchMode as AttendancePunchMode) ?? "QR_ONLY");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load kiosk attendance mode",
      );
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    setBrowserCameraAvailable(canUseBrowserCamera());
    void loadConfig();
  }, [loadConfig]);

  const resetPrimaryFlow = () => {
    faceAttemptSessionRef.current += 1;
    setStep("READY");
    setPendingFacePunch(null);
    setError(null);
    setProcessing(false);
    setFaceSubmitting(false);
    setFaceAutoStatus("Starting camera");
  };

  const beginFaceStep = (input: PendingFacePunch) => {
    faceAttemptSessionRef.current += 1;
    setPendingFacePunch(input);
    setStep("FACE");
    setError(null);
    setFaceAutoStatus("Starting camera");
  };

  const expireFaceStep = useCallback(() => {
    faceAttemptSessionRef.current += 1;
    setStep("READY");
    setPendingFacePunch(null);
    setFaceSubmitting(false);
    setFaceAutoStatus("Starting camera");
    setError("Face verification expired. Please scan a fresh employee QR.");
    toast.error("Face verification expired.", {
      description: "Please scan a fresh employee QR.",
    });
  }, [toast]);

  const handlePunchSuccess = useCallback(
    async (data: PrimaryPunchNotice) => {
      await Promise.resolve(onPunchSuccess(data));
      resetPrimaryFlow();
      setSearchTerm("");
      setSuggestions([]);
    },
    [onPunchSuccess],
  );

  const resolveEmployeeQr = useCallback(
    async (token: string) => {
      const kioskId = getBrowserKioskId();
      const resolved = await resolveEmployeeAttendanceQr({ token, kioskId });
      if (!resolved.success || !resolved.data) {
        throw new Error(resolved.error || "Failed to resolve employee QR");
      }

      if (mode === "QR_ONLY") {
        const result = await recordKioskResolvedPunch({ token, kioskId });
        if (!result.success || !result.data) {
          throw new Error(result.error || "Failed to record QR punch");
        }
        await handlePunchSuccess({
          username: result.data.username,
          employeeName: result.data.employeeName,
          employeeCode: result.data.employeeCode,
          punchType: result.data.punchType,
          punchTime: result.data.punchTime,
        });
        toast.success("QR punch completed.", {
          description: `${result.data.employeeName} ${formatPunchLabel(
            result.data.punchType,
          )} recorded.`,
        });
        return;
      }

      if (
        !resolved.data.attemptId ||
        !resolved.data.nonce ||
        !resolved.data.expiresAt ||
        !Array.isArray(resolved.data.actions)
      ) {
        throw new Error("Server did not issue a face challenge.");
      }
      beginFaceStep({
        employeeName: resolved.data.employeeName,
        employeeCode: resolved.data.employeeCode,
        username: resolved.data.username,
        nextPunch: resolved.data.nextPunch,
        attemptId: resolved.data.attemptId,
        nonce: resolved.data.nonce,
        actions: resolved.data.actions as BrowserFaceChallengeAction[],
        faceExpiresAt: resolved.data.expiresAt,
      });
    },
    [handlePunchSuccess, mode, toast],
  );

  useEffect(() => {
    if (step !== "SCANNING") return;

    let stopped = false;
    let controls: IScannerControls | null = null;

    (async () => {
      try {
        if (!canUseBrowserCamera()) {
          throw new Error(cameraUnavailableMessage);
        }

        const video = qrVideoRef.current;
        if (!video) return;

        let preferredDeviceId: string | undefined;
        try {
          const devices = await BrowserMultiFormatReader.listVideoInputDevices();
          preferredDeviceId =
            devices.find((device) => /back|rear|environment/i.test(device.label))
              ?.deviceId ?? devices[0]?.deviceId;
        } catch {
          preferredDeviceId = undefined;
        }

        controls = await reader.decodeFromVideoDevice(
          preferredDeviceId,
          video,
          async (result, _error, scannerControls) => {
            if (!result || stopped) return;

            stopped = true;
            scannerControls.stop();
            setProcessing(true);
            try {
              await resolveEmployeeQr(result.getText());
            } catch (err) {
              const message = toErrorMessage(err, "Failed to process employee QR.");
              setError(message);
              toast.error("QR punch failed.", {
                description: message,
              });
              setStep("READY");
            } finally {
              setProcessing(false);
            }
          },
        );
      } catch (err) {
        setError(toErrorMessage(err, "Camera error. Please allow permission."));
        setStep("READY");
      }
    })();

    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [reader, resolveEmployeeQr, step, toast]);

  useEffect(() => {
    if (step !== "FACE") {
      faceStreamRef.current?.getTracks().forEach((track) => track.stop());
      faceStreamRef.current = null;
      setFaceStream(null);
      setFaceCameraReady(false);
      setFaceModelsReady(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        if (!canUseBrowserCamera()) {
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
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        faceStreamRef.current = stream;
        setFaceStream(stream);
        setFaceModelsReady(true);
      } catch (err) {
        setError(toErrorMessage(err, "Face camera error."));
        setStep("READY");
      }
    })();

    return () => {
      cancelled = true;
      faceStreamRef.current?.getTracks().forEach((track) => track.stop());
      faceStreamRef.current = null;
      setFaceStream(null);
      setFaceCameraReady(false);
      setFaceModelsReady(false);
    };
  }, [step]);

  useEffect(() => {
    if (step !== "FACE" || !faceStream || !faceVideoRef.current) return;

    const video = faceVideoRef.current;
    setFaceCameraReady(false);

    const markReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setFaceCameraReady(true);
        setError(null);
        setFaceAutoStatus("Face camera directly");
      }
    };

    video.addEventListener("loadedmetadata", markReady);
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);
    video.srcObject = faceStream;

    void video.play().then(markReady).catch(() => {
      setError("Face camera preview could not start.");
    });

    return () => {
      video.removeEventListener("loadedmetadata", markReady);
      video.removeEventListener("loadeddata", markReady);
      video.removeEventListener("canplay", markReady);
      video.removeEventListener("playing", markReady);
    };
  }, [faceStream, step]);

  useEffect(() => {
    if (step !== "FACE" || !pendingFacePunch) return;

    setFaceNow(Date.now());
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setFaceNow(currentTime);
      if (currentTime >= pendingFacePunch.faceExpiresAt) {
        expireFaceStep();
      }
    }, 250);

    return () => window.clearInterval(interval);
  }, [expireFaceStep, pendingFacePunch, step]);

  const loadSuggestions = async (term: string) => {
    const normalizedTerm = term.trim();
    if (!normalizedTerm) {
      setSuggestions([]);
      setFetchingSuggestions(false);
      return;
    }

    try {
      setFetchingSuggestions(true);
      const result = await searchKioskUsers({ query: normalizedTerm });
      if (!result.success) {
        throw new Error(result.error || "Failed to load suggestions");
      }
      setSuggestions(result.data ?? []);
    } catch {
      setSuggestions([]);
    } finally {
      setFetchingSuggestions(false);
    }
  };

  const selectEmployeeForFace = async (suggestion: KioskUserSuggestion) => {
    if (!suggestion.employee?.employeeId) return;

    try {
      setProcessing(true);
      setError(null);
      const result = await getSearchEmployeeFacePreview({
        employeeId: suggestion.employee.employeeId,
        kioskId: getBrowserKioskId(),
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to prepare face verification");
      }
      beginFaceStep({
        employeeName: result.data.employeeName,
        employeeCode: result.data.employeeCode,
        username: result.data.username,
        nextPunch: result.data.nextPunch,
        attemptId: result.data.attemptId,
        nonce: result.data.nonce,
        actions: result.data.actions as BrowserFaceChallengeAction[],
        faceExpiresAt: result.data.expiresAt,
      });
      setSearchTerm(
        `${result.data.employeeCode} - ${result.data.employeeName}`,
      );
      setSuggestions([]);
    } catch (err) {
      const message = toErrorMessage(err, "Failed to prepare face verification.");
      setError(message);
      toast.error("Face mode failed.", {
        description: message,
      });
    } finally {
      setProcessing(false);
    }
  };

  const submitFaceVerification = async (sessionId: number) => {
    if (!pendingFacePunch) return;
    if (Date.now() >= pendingFacePunch.faceExpiresAt) {
      expireFaceStep();
      return;
    }

    const video = faceVideoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      setFaceAutoStatus("Starting camera");
      return;
    }

    try {
      setFaceSubmitting(true);
      setError(null);
      const facePayload = await captureFaceChallengeFrames(
        video,
        pendingFacePunch.actions,
        setFaceAutoStatus,
      );
      if (faceAttemptSessionRef.current !== sessionId) return;

      setFaceAutoStatus("Verifying");
      const result = await verifyFaceAndRecordKioskPunch({
        attemptId: pendingFacePunch.attemptId,
        nonce: pendingFacePunch.nonce,
        kioskId: getBrowserKioskId(),
        frames: facePayload.frames,
      });

      if (faceAttemptSessionRef.current !== sessionId) return;

      if (!result.success || !result.data) {
        throw new Error(
          result.error || "Failed to verify face and record punch",
        );
      }

      setFaceAutoStatus("Face verified");
      await handlePunchSuccess({
        username: result.data.username,
        employeeName: result.data.employeeName,
        employeeCode: result.data.employeeCode,
        punchType: result.data.punchType,
        punchTime: result.data.punchTime,
      });
      toast.success("Face verified. Punch recorded.", {
        description: `${result.data.employeeName} ${formatPunchLabel(
          result.data.punchType,
        )} recorded.`,
      });
    } catch (err) {
      if (
        err instanceof FaceCaptureClientError &&
        faceAttemptSessionRef.current === sessionId
      ) {
        setFaceAutoStatus(err.message);
        return;
      }

      const message = toErrorMessage(err, "Face verification failed.");
      setError(message);
      setFaceAutoStatus(message);
      faceAttemptSessionRef.current += 1;
      setPendingFacePunch(null);
      setStep("READY");
      toast.error("Face verification failed.", {
        description: message,
      });
    } finally {
      setFaceSubmitting(false);
    }
  };

  useEffect(() => {
    if (
      step !== "FACE" ||
      !pendingFacePunch ||
      !faceCameraReady ||
      !faceModelsReady
    ) {
      return;
    }

    const sessionId = faceAttemptSessionRef.current;
    const timeoutId = window.setTimeout(() => {
      void submitFaceVerification(sessionId);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
    // Challenge is single use. Fresh QR/search selection required after any failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceCameraReady, faceModelsReady, pendingFacePunch, step]);

  const faceSecondsLeft = pendingFacePunch
    ? Math.max(0, Math.ceil((pendingFacePunch.faceExpiresAt - faceNow) / 1000))
    : 0;

  return (
    <Card className={darkCardClass}>
      <CardHeader className="border-b border-slate-800/80 pb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="text-2xl text-slate-50">
              Primary attendance flow
            </CardTitle>
            <p className="max-w-2xl text-sm leading-6 text-slate-400">
              Kiosk follows configured punch mode. Manual username and password
              fallback stays separate.
            </p>
          </div>
          <Badge className="w-fit border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-900">
            {modeLabel(mode)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-6">
        {loadingConfig ? (
          <p className="text-sm text-slate-400">Loading attendance mode...</p>
        ) : null}

        {!loadingConfig && mode !== "SEARCH_EMPLOYEE_KIOSK_FACE" ? (
          <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">
                  Employee QR scanner
                </p>
                <p className="text-sm text-slate-400">
                  Employee shows dynamic QR from own account. Kiosk scans and
                  continues configured flow.
                </p>
              </div>
              <Button
                type="button"
                className="h-11 rounded-2xl bg-orange-500 px-4 text-slate-950 hover:bg-orange-400"
                onClick={() => {
                  setStep("SCANNING");
                  setError(null);
                }}
                disabled={step === "SCANNING" || processing}
              >
                <ScanLine className="mr-2 h-4 w-4" />
                {step === "SCANNING" ? "Scanning..." : "Start scanner"}
              </Button>
            </div>

            {step === "SCANNING" ? (
              <div className="space-y-3">
                {!browserCameraAvailable ? (
                  <p className="text-sm text-rose-400">
                    {cameraUnavailableMessage}
                  </p>
                ) : (
                  <>
                    <video
                      ref={qrVideoRef}
                      className="w-full rounded-xl bg-black"
                      autoPlay
                      playsInline
                      muted
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="border-slate-700 text-slate-200 hover:bg-slate-900 hover:text-slate-50"
                      onClick={resetPrimaryFlow}
                    >
                      Cancel scan
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {!loadingConfig && mode === "SEARCH_EMPLOYEE_KIOSK_FACE" ? (
          <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-500/12 text-orange-300">
                <Search className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">
                  Search employee
                </p>
                <p className="text-sm text-slate-400">
                  Find employee, then kiosk camera verifies face before punch.
                </p>
              </div>
            </div>

            <Input
              placeholder="Search username or employee"
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value);
                void loadSuggestions(event.target.value);
              }}
              className="h-11 border-slate-800 bg-slate-950/70 text-slate-100 placeholder:text-slate-500"
            />

            {suggestions.length > 0 ? (
              <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.username}
                    type="button"
                    className="w-full rounded-xl border border-transparent px-3 py-2 text-left transition hover:border-slate-700 hover:bg-slate-900"
                    onClick={() => void selectEmployeeForFace(suggestion)}
                  >
                    <span className="text-sm font-medium text-slate-100">
                      {suggestion.username}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {suggestion.employee?.firstName}{" "}
                      {suggestion.employee?.lastName} (
                      {suggestion.employee?.employeeCode})
                    </span>
                  </button>
                ))}
                {fetchingSuggestions ? (
                  <p className="text-xs text-slate-500">Searching...</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === "FACE" && pendingFacePunch ? (
          <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-sm text-slate-200">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">{pendingFacePunch.employeeName}</p>
                  <p className="text-xs text-slate-400">
                    {pendingFacePunch.employeeCode} -{" "}
                    {formatPunchLabel(pendingFacePunch.nextPunch)}
                  </p>
                </div>
                <Badge className="w-fit border border-orange-500/30 bg-orange-500/10 text-orange-200 hover:bg-orange-500/10">
                  {faceSecondsLeft}s left
                </Badge>
              </div>
            </div>

            <div className="relative mx-auto max-w-sm overflow-hidden rounded-xl bg-black">
              <div className="pointer-events-none absolute inset-x-3 top-3 z-20 rounded-lg bg-black/75 px-3 py-3 text-center text-xl font-bold tracking-wide text-white">
                {faceAutoStatus.toUpperCase()}
              </div>
              <video
                ref={faceVideoRef}
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
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                <p className="text-xs text-muted-foreground">Face service</p>
                <p className="font-medium">
                  {faceModelsReady ? "Ready" : "Starting..."}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                <p className="text-xs text-muted-foreground">Camera</p>
                <p className="font-medium">
                  {faceCameraReady ? "Ready" : "Starting..."}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-200">
                  {faceSubmitting ? "Verifying..." : faceAutoStatus}
                </p>
                <p className="text-xs text-slate-400">
                  Face verification expires in {faceSecondsLeft}s.
                </p>
              </div>
              <Button
                variant="outline"
                className="border-slate-700 text-slate-200 hover:bg-slate-900 hover:text-slate-50"
                onClick={resetPrimaryFlow}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {processing ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4 text-sm text-slate-400">
            Processing attendance...
          </div>
        ) : null}

        {error ? <p className="text-sm text-rose-400">{error}</p> : null}

        {!loadingConfig && step === "READY" ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-400">
            {mode === "SEARCH_EMPLOYEE_KIOSK_FACE"
              ? "Search employee to start kiosk face verification."
              : "Start kiosk scanner when employee QR is ready."}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
