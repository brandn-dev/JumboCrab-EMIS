"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAttendanceSecuritySettings,
  updateAttendanceSecuritySettings,
} from "@/actions/attendance/attendance-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ModuleLoadingState } from "@/components/loading/loading-states";
import { useToast } from "@/components/ui/toast-provider";

type AttendancePunchMode =
  | "QR_ONLY"
  | "EMPLOYEE_QR_KIOSK_FACE"
  | "SEARCH_EMPLOYEE_KIOSK_FACE";

type AttendanceSecuritySettingsForm = {
  gpsValidationEnabled: boolean;
  attendancePunchMode: AttendancePunchMode;
  faceLivenessRequired: boolean;
  faceMatchMaxDistance: number;
  faceFailureMode: string;
};

const defaultForm: AttendanceSecuritySettingsForm = {
  gpsValidationEnabled: false,
  attendancePunchMode: "QR_ONLY",
  faceLivenessRequired: false,
  faceMatchMaxDistance: 0.35,
  faceFailureMode: "BLOCK",
};

const toggleRows: Array<{
  key: "gpsValidationEnabled" | "faceLivenessRequired";
  title: string;
  description: string;
}> = [
  {
    key: "gpsValidationEnabled",
    title: "Capture location when available",
    description:
      "Attach optional location coordinates to attendance punch context.",
  },
];

const modeOptions: Array<{
  value: AttendancePunchMode;
  title: string;
  description: string;
}> = [
  {
    value: "QR_ONLY",
    title: "QR only",
    description:
      "Employee shows personal QR. Kiosk scans it and records the next punch.",
  },
  {
    value: "EMPLOYEE_QR_KIOSK_FACE",
    title: "Employee QR then kiosk face",
    description:
      "Kiosk scans employee QR first, then kiosk camera verifies face before punch.",
  },
  {
    value: "SEARCH_EMPLOYEE_KIOSK_FACE",
    title: "Search employee then kiosk face",
    description:
      "Kiosk searches employee by name or username, then kiosk camera verifies face.",
  },
];

export function AttendanceSecuritySettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState<AttendanceSecuritySettingsForm>(defaultForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getAttendanceSecuritySettings();
      if (!result.success || !result.data) {
        throw new Error(
          result.error || "Failed to load attendance security settings",
        );
      }

      setForm({
        gpsValidationEnabled: result.data.gpsValidationEnabled,
        attendancePunchMode:
          (result.data.attendancePunchMode as AttendancePunchMode) ??
          defaultForm.attendancePunchMode,
        faceLivenessRequired:
          result.data.faceLivenessRequired ?? defaultForm.faceLivenessRequired,
        faceMatchMaxDistance:
          result.data.faceMatchMaxDistance ?? defaultForm.faceMatchMaxDistance,
        faceFailureMode:
          result.data.faceFailureMode ?? defaultForm.faceFailureMode,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load attendance security settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      const result = await updateAttendanceSecuritySettings({
        ...form,
        faceMatchMaxDistance: Math.max(
          0.35,
          Math.min(0.55, Number(form.faceMatchMaxDistance) || 0.35),
        ),
      });

      if (!result.success) {
        throw new Error(
          result.error || "Failed to save attendance security settings",
        );
      }

      toast.success("Attendance settings updated.", {
        description: "Attendance security settings were saved successfully.",
      });
      await load();
    } catch (err) {
      toast.error("Failed to update attendance settings.", {
        description:
          err instanceof Error
            ? err.message
            : "Failed to update attendance security settings",
      });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <ModuleLoadingState
        title="Attendance Settings"
        description="Loading attendance security configuration."
      />
    );
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Attendance Settings</CardTitle>
        <p className="text-sm text-muted-foreground">
          Choose kiosk punch mode, then tune face and location validation.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="rounded-xl border border-border/70 bg-muted/10 p-4">
          <div className="space-y-3">
            <p className="font-medium">Primary kiosk punch mode</p>
            <p className="text-sm text-muted-foreground">
              New attendance flow now starts from the kiosk. Pick exactly one
              primary mode.
            </p>
            <div className="space-y-3">
              {modeOptions.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border/70 bg-background/80 p-4"
                >
                  <div className="space-y-1">
                    <p className="font-medium">{option.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {option.description}
                    </p>
                  </div>
                  <input
                    type="radio"
                    name="attendancePunchMode"
                    checked={form.attendancePunchMode === option.value}
                    onChange={() =>
                      setForm((current) => ({
                        ...current,
                        attendancePunchMode: option.value,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {toggleRows.map((setting) => (
            <label
              key={setting.key}
              className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-muted/10 p-4"
            >
              <div className="space-y-1">
                <p className="font-medium">{setting.title}</p>
                <p className="text-sm text-muted-foreground">
                  {setting.description}
                </p>
              </div>
              <input
                type="checkbox"
                checked={form[setting.key]}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    [setting.key]: event.target.checked,
                  }))
                }
                className="mt-1 h-4 w-4"
              />
            </label>
          ))}
        </div>

        <div className="rounded-xl border border-border/70 bg-muted/10 p-4">
          <div className="space-y-2">
            <p className="font-medium">Face match distance threshold</p>
            <p className="text-sm text-muted-foreground">
              Lower is stricter. Start at 0.35, then tune after real employee
              enrollment tests.
            </p>
            <Input
              type="number"
              min={0.35}
              max={0.55}
              step={0.01}
              value={form.faceMatchMaxDistance}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  faceMatchMaxDistance: Number(event.target.value),
                }))
              }
              className="max-w-xs"
            />
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-muted/10 p-4">
          <div className="space-y-2">
            <p className="font-medium">Face failure mode</p>
            <p className="text-sm text-muted-foreground">
              Block is safest. Fallback allows punch flow to continue when
              camera is unavailable.
            </p>
            <select
              value={form.faceFailureMode}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  faceFailureMode: event.target.value,
                }))
              }
              className="h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="BLOCK">Block punch when face check fails</option>
              <option value="FLAG">
                Allow fallback punch when camera is unavailable
              </option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={saving}>
            Reset
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
