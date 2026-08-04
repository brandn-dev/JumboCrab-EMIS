import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  normalizeLatitude,
  normalizeLongitude,
  type AttendanceSecurityClient,
  type AttendanceSecurityPayload,
} from "./attendance-security-shared";

export async function captureAttendanceSecurityEvent(input: {
  punchId: string;
  attendanceId: string;
  employeeId: string;
  punchTime: Date;
  payload?: AttendanceSecurityPayload | null;
  client?: AttendanceSecurityClient;
}) {
  const client = input.client ?? db;
  const latitude = normalizeLatitude(input.payload?.latitude);
  const longitude = normalizeLongitude(input.payload?.longitude);
  const ipAddress =
    typeof input.payload?.ipAddress === "string" &&
    input.payload.ipAddress.trim().length > 0
      ? input.payload.ipAddress.trim().slice(0, 191)
      : null;
  const userAgent =
    typeof input.payload?.userAgent === "string" &&
    input.payload.userAgent.trim().length > 0
      ? input.payload.userAgent.trim().slice(0, 1000)
      : null;

  const writeSecurityContext = async (writeClient: AttendanceSecurityClient) => {
    await writeClient.punch.update({
      where: { id: input.punchId },
      data: {
        ipAddress,
        userAgent,
        latitude,
        longitude,
      },
    });

    if (process.env.ATTENDANCE_CONTEXT_LOG_DUAL_WRITE === "false") {
      return null;
    }

    const contextLogId = randomUUID();
    await writeClient.$executeRaw`
      INSERT INTO "AttendanceContextLog" (
        "id",
        "punchId",
        "attendanceId",
        "employeeId",
        "ipAddress",
        "userAgent",
        "latitude",
        "longitude",
        "createdAt"
      ) VALUES (
        ${contextLogId},
        ${input.punchId},
        ${input.attendanceId},
        ${input.employeeId},
        ${ipAddress},
        ${userAgent},
        ${latitude},
        ${longitude},
        ${input.punchTime}
      )
    `;
    return contextLogId;
  };

  const contextLogId = input.client
    ? await writeSecurityContext(client)
    : await db.$transaction((transaction) => writeSecurityContext(transaction));

  return {
    contextLogId,
  };
}
