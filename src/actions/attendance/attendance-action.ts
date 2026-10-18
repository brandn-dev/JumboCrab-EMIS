"use server";

import { listAttendance as listAttendanceImpl } from "./attendance-list-action";
import {
  autoLockAttendance as autoLockAttendanceImpl,
  listAttendanceLockSummary as listAttendanceLockSummaryImpl,
  listLockableEmployees as listLockableEmployeesImpl,
  setAttendanceLockState as setAttendanceLockStateImpl,
} from "./attendance-lock-action";
import {
  deletePunch as deletePunchImpl,
  listAttendancePunches as listAttendancePunchesImpl,
  recordAttendancePunch as recordAttendancePunchImpl,
  updatePunch as updatePunchImpl,
} from "./attendance-punch-action";
import {
  getSelfAttendanceStatus as getSelfAttendanceStatusImpl,
  recordSelfPunch as recordSelfPunchImpl,
} from "./attendance-self-action";
import {
  recomputeAttendance as recomputeAttendanceImpl,
  recomputeAttendanceForDate as recomputeAttendanceForDateImpl,
} from "./attendance-recompute-action";
import {
  getEmployeeAttendanceQr as getEmployeeAttendanceQrImpl,
  getKioskAttendanceConfig as getKioskAttendanceConfigImpl,
  getSearchEmployeeFacePreview as getSearchEmployeeFacePreviewImpl,
  recordKioskResolvedPunch as recordKioskResolvedPunchImpl,
  resolveEmployeeAttendanceQr as resolveEmployeeAttendanceQrImpl,
} from "./attendance-kiosk-flow-action";
import {
  getAttendancePunchClientConfig as getAttendancePunchClientConfigImpl,
  getAttendanceSecuritySettings as getAttendanceSecuritySettingsImpl,
} from "./attendance-security-query-action";
import {
  updateAttendanceSecuritySettings as updateAttendanceSecuritySettingsImpl,
} from "./attendance-security-mutation-action";
import {
  enrollEmployeeFace as enrollEmployeeFaceImpl,
  listEmployeeFaceEnrollments as listEmployeeFaceEnrollmentsImpl,
  listEmployeeFaceVerificationAttempts as listEmployeeFaceVerificationAttemptsImpl,
  revokeEmployeeFaceEnrollment as revokeEmployeeFaceEnrollmentImpl,
  verifyFaceAndRecordKioskPunch as verifyFaceAndRecordKioskPunchImpl,
  verifyFaceAndRecordQrPunch as verifyFaceAndRecordQrPunchImpl,
} from "./face-recognition-action";

export async function listAttendance(
  ...args: Parameters<typeof listAttendanceImpl>
) {
  return listAttendanceImpl(...args);
}

export async function listAttendanceLockSummary(
  ...args: Parameters<typeof listAttendanceLockSummaryImpl>
) {
  return listAttendanceLockSummaryImpl(...args);
}

export async function listLockableEmployees(
  ...args: Parameters<typeof listLockableEmployeesImpl>
) {
  return listLockableEmployeesImpl(...args);
}

export async function setAttendanceLockState(
  ...args: Parameters<typeof setAttendanceLockStateImpl>
) {
  return setAttendanceLockStateImpl(...args);
}

export async function listAttendancePunches(
  ...args: Parameters<typeof listAttendancePunchesImpl>
) {
  return listAttendancePunchesImpl(...args);
}

export async function updatePunch(
  ...args: Parameters<typeof updatePunchImpl>
) {
  return updatePunchImpl(...args);
}

export async function deletePunch(
  ...args: Parameters<typeof deletePunchImpl>
) {
  return deletePunchImpl(...args);
}

export async function autoLockAttendance(
  ...args: Parameters<typeof autoLockAttendanceImpl>
) {
  return autoLockAttendanceImpl(...args);
}

export async function getSelfAttendanceStatus(
  ...args: Parameters<typeof getSelfAttendanceStatusImpl>
) {
  return getSelfAttendanceStatusImpl(...args);
}

export async function recordSelfPunch(
  ...args: Parameters<typeof recordSelfPunchImpl>
) {
  return recordSelfPunchImpl(...args);
}

export async function recordAttendancePunch(
  ...args: Parameters<typeof recordAttendancePunchImpl>
) {
  return recordAttendancePunchImpl(...args);
}

export async function getAttendanceSecuritySettings(
  ...args: Parameters<typeof getAttendanceSecuritySettingsImpl>
) {
  return getAttendanceSecuritySettingsImpl(...args);
}

export async function getAttendancePunchClientConfig(
  ...args: Parameters<typeof getAttendancePunchClientConfigImpl>
) {
  return getAttendancePunchClientConfigImpl(...args);
}

export async function updateAttendanceSecuritySettings(
  ...args: Parameters<typeof updateAttendanceSecuritySettingsImpl>
) {
  return updateAttendanceSecuritySettingsImpl(...args);
}

export async function recomputeAttendance(
  ...args: Parameters<typeof recomputeAttendanceImpl>
) {
  return recomputeAttendanceImpl(...args);
}

export async function recomputeAttendanceForDate(
  ...args: Parameters<typeof recomputeAttendanceForDateImpl>
) {
  return recomputeAttendanceForDateImpl(...args);
}

export async function getEmployeeAttendanceQr(
  ...args: Parameters<typeof getEmployeeAttendanceQrImpl>
) {
  return getEmployeeAttendanceQrImpl(...args);
}

export async function getKioskAttendanceConfig(
  ...args: Parameters<typeof getKioskAttendanceConfigImpl>
) {
  return getKioskAttendanceConfigImpl(...args);
}

export async function resolveEmployeeAttendanceQr(
  ...args: Parameters<typeof resolveEmployeeAttendanceQrImpl>
) {
  return resolveEmployeeAttendanceQrImpl(...args);
}

export async function recordKioskResolvedPunch(
  ...args: Parameters<typeof recordKioskResolvedPunchImpl>
) {
  return recordKioskResolvedPunchImpl(...args);
}

export async function getSearchEmployeeFacePreview(
  ...args: Parameters<typeof getSearchEmployeeFacePreviewImpl>
) {
  return getSearchEmployeeFacePreviewImpl(...args);
}

export async function listEmployeeFaceEnrollments(
  ...args: Parameters<typeof listEmployeeFaceEnrollmentsImpl>
) {
  return listEmployeeFaceEnrollmentsImpl(...args);
}

export async function enrollEmployeeFace(
  ...args: Parameters<typeof enrollEmployeeFaceImpl>
) {
  return enrollEmployeeFaceImpl(...args);
}

export async function listEmployeeFaceVerificationAttempts(
  ...args: Parameters<typeof listEmployeeFaceVerificationAttemptsImpl>
) {
  return listEmployeeFaceVerificationAttemptsImpl(...args);
}

export async function revokeEmployeeFaceEnrollment(
  ...args: Parameters<typeof revokeEmployeeFaceEnrollmentImpl>
) {
  return revokeEmployeeFaceEnrollmentImpl(...args);
}

export async function verifyFaceAndRecordQrPunch(
  ...args: Parameters<typeof verifyFaceAndRecordQrPunchImpl>
) {
  return verifyFaceAndRecordQrPunchImpl(...args);
}

export async function verifyFaceAndRecordKioskPunch(
  ...args: Parameters<typeof verifyFaceAndRecordKioskPunchImpl>
) {
  return verifyFaceAndRecordKioskPunchImpl(...args);
}
