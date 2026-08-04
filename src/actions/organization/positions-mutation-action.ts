"use server";

import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  DEFAULT_CURRENCY_CODE,
  deriveCompensationRates,
  isSameRate,
  toRateNumber,
} from "@/actions/employees/employees-shared";
import { shiftDateByDays } from "@/lib/payroll/helpers";
import {
  getPositionBaseName,
  isArchivedTokenName,
  resolvePositionRestoreName,
} from "./positions-shared";
import { requireOrganizationMutationAccess } from "./organization-auth";

const serializePositionDetail = (position: {
  positionId: string;
  name: string;
  description: string | null;
  dailyRate: unknown;
  hourlyRate: unknown;
  monthlyRate: unknown;
  currencyCode: string;
  departmentId: string;
  department: { departmentId: string; name: string } | null;
}) => ({
  positionId: position.positionId,
  name: position.name,
  description: position.description,
  dailyRate: toRateNumber(position.dailyRate),
  hourlyRate: toRateNumber(position.hourlyRate),
  monthlyRate: toRateNumber(position.monthlyRate),
  currencyCode: position.currencyCode,
  departmentId: position.departmentId,
  department: position.department ?? undefined,
});

export async function createPosition(input: {
  name: string;
  description?: string | null;
  departmentId: string;
  dailyRate?: number | string | null;
  currencyCode?: string | null;
}): Promise<{
  success: boolean;
  data?: {
    positionId: string;
    name: string;
    description?: string | null;
    dailyRate: number | null;
    hourlyRate: number | null;
    monthlyRate: number | null;
    currencyCode: string;
    departmentId: string;
    department?: { departmentId: string; name: string };
  };
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description =
      typeof input.description === "string" ? input.description.trim() : null;
    const departmentId =
      typeof input.departmentId === "string"
        ? input.departmentId.trim()
        : "";
    const dailyRate = toRateNumber(input.dailyRate);
    const currencyCode =
      typeof input.currencyCode === "string" && input.currencyCode.trim()
        ? input.currencyCode.trim().toUpperCase()
        : DEFAULT_CURRENCY_CODE;

    if (!name) {
      return { success: false, error: "Name is required" };
    }
    if (!departmentId) {
      return { success: false, error: "Department is required" };
    }
    if (input.dailyRate != null && dailyRate == null) {
      return { success: false, error: "Daily rate must be a valid number" };
    }

    const department = await db.department.findUnique({
      where: { departmentId },
      select: { departmentId: true },
    });
    if (!department) {
      return { success: false, error: "Department not found" };
    }

    const existing = await db.position.findFirst({
      where: { name, departmentId, isActive: true },
      select: { positionId: true },
    });
    if (existing) {
      return {
        success: false,
        error: "Position already exists in this department",
      };
    }

    const session = await getSession();
    const actorUserId = session.userId ?? null;
    const derivedRates = deriveCompensationRates(dailyRate);

    const position = await db.position.create({
      data: {
        name,
        description,
        departmentId,
        dailyRate: derivedRates.dailyRate,
        hourlyRate: derivedRates.hourlyRate,
        monthlyRate: derivedRates.monthlyRate,
        currencyCode,
      },
      select: {
        positionId: true,
        name: true,
        description: true,
        dailyRate: true,
        hourlyRate: true,
        monthlyRate: true,
        currencyCode: true,
        departmentId: true,
        department: { select: { departmentId: true, name: true } },
      },
    });

    if (derivedRates.dailyRate != null) {
      await db.positionRateHistory.create({
        data: {
          positionId: position.positionId,
          dailyRate: derivedRates.dailyRate,
          hourlyRate: derivedRates.hourlyRate,
          monthlyRate: derivedRates.monthlyRate,
          currencyCode,
          effectiveFrom: new Date(),
          reason: "Initial position rate",
          metadata: { source: "position_create" },
          createdByUserId: actorUserId,
        },
      });
    }

    return { success: true, data: serializePositionDetail(position) };
  } catch (error) {
    console.error("Failed to create position", error);
    return { success: false, error: "Failed to create position" };
  }
}

export async function updatePosition(input: {
  positionId: string;
  name: string;
  description?: string | null;
  departmentId: string;
  dailyRate?: number | string | null;
  currencyCode?: string | null;
}): Promise<{
  success: boolean;
  data?: {
    positionId: string;
    name: string;
    description?: string | null;
    dailyRate: number | null;
    hourlyRate: number | null;
    monthlyRate: number | null;
    currencyCode: string;
    departmentId: string;
    department?: { departmentId: string; name: string };
  };
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const positionId =
      typeof input.positionId === "string" ? input.positionId.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description =
      typeof input.description === "string" ? input.description.trim() : null;
    const departmentId =
      typeof input.departmentId === "string"
        ? input.departmentId.trim()
        : "";
    const dailyRate = toRateNumber(input.dailyRate);
    const currencyCode =
      typeof input.currencyCode === "string" && input.currencyCode.trim()
        ? input.currencyCode.trim().toUpperCase()
        : DEFAULT_CURRENCY_CODE;

    if (!positionId) {
      return { success: false, error: "Position ID is required" };
    }
    if (!name) {
      return { success: false, error: "Name is required" };
    }
    if (!departmentId) {
      return { success: false, error: "Department is required" };
    }
    if (input.dailyRate != null && dailyRate == null) {
      return { success: false, error: "Daily rate must be a valid number" };
    }

    const position = await db.position.findUnique({
      where: { positionId },
      select: {
        positionId: true,
        dailyRate: true,
        currencyCode: true,
      },
    });
    if (!position) {
      return { success: false, error: "Position not found" };
    }

    const department = await db.department.findUnique({
      where: { departmentId },
      select: { departmentId: true },
    });
    if (!department) {
      return { success: false, error: "Department not found" };
    }

    const conflict = await db.position.findFirst({
      where: {
        positionId: { not: positionId },
        name,
        departmentId,
        isActive: true,
      },
      select: { positionId: true },
    });
    if (conflict) {
      return {
        success: false,
        error: "Another position in this department uses this name",
      };
    }

    const session = await getSession();
    const actorUserId = session.userId ?? null;
    const derivedRates = deriveCompensationRates(dailyRate);

    const updated = await db.position.update({
      where: { positionId },
      data: {
        name,
        description,
        departmentId,
        dailyRate: derivedRates.dailyRate,
        hourlyRate: derivedRates.hourlyRate,
        monthlyRate: derivedRates.monthlyRate,
        currencyCode,
      },
      select: {
        positionId: true,
        name: true,
        description: true,
        dailyRate: true,
        hourlyRate: true,
        monthlyRate: true,
        currencyCode: true,
        departmentId: true,
        department: { select: { departmentId: true, name: true } },
      },
    });

    if (
      !isSameRate(toRateNumber(position.dailyRate), derivedRates.dailyRate) ||
      (position.currencyCode ?? DEFAULT_CURRENCY_CODE) !== currencyCode
    ) {
      const effectiveFrom = new Date();
      await db.positionRateHistory.updateMany({
        where: {
          positionId,
          effectiveTo: null,
        },
        data: {
          effectiveTo: shiftDateByDays(effectiveFrom, -1),
        },
      });

      await db.positionRateHistory.create({
        data: {
          positionId,
          dailyRate: derivedRates.dailyRate,
          hourlyRate: derivedRates.hourlyRate,
          monthlyRate: derivedRates.monthlyRate,
          currencyCode,
          effectiveFrom,
          reason: "Position rate updated",
          metadata: { source: "position_update" },
          createdByUserId: actorUserId,
        },
      });
    }

    return { success: true, data: serializePositionDetail(updated) };
  } catch (error) {
    console.error("Failed to update position", error);
    return { success: false, error: "Failed to update position" };
  }
}

export async function archivePosition(positionId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const id = typeof positionId === "string" ? positionId.trim() : "";
    if (!id) {
      return { success: false, error: "Position ID is required" };
    }

    const existing = await db.position.findUnique({
      where: { positionId: id },
      select: { positionId: true, name: true },
    });
    if (!existing) {
      return { success: false, error: "Position not found" };
    }

    if (isArchivedTokenName(existing.name)) {
      await db.position.update({
        where: { positionId: id },
        data: { isActive: false },
      });
      return { success: true };
    }

    await db.position.update({
      where: { positionId: id },
      data: {
        isActive: false,
        name: `${existing.name}__archived__${existing.positionId}`,
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to archive position", error);
    return { success: false, error: "Failed to archive position" };
  }
}

export async function unarchivePosition(positionId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const id = typeof positionId === "string" ? positionId.trim() : "";
    if (!id) {
      return { success: false, error: "Position ID is required" };
    }

    const existing = await db.position.findUnique({
      where: { positionId: id },
      select: {
        positionId: true,
        name: true,
        isActive: true,
        departmentId: true,
        department: {
          select: { departmentId: true, isActive: true },
        },
      },
    });
    if (!existing) {
      return { success: false, error: "Position not found" };
    }
    if (existing.isActive) {
      return { success: true };
    }
    if (!existing.department?.isActive) {
      return {
        success: false,
        error: "Unarchive the department first before restoring this position",
      };
    }

    const restoredName = await resolvePositionRestoreName(
      id,
      existing.departmentId,
      getPositionBaseName(existing.name),
    );

    await db.position.update({
      where: { positionId: id },
      data: {
        isActive: true,
        name: restoredName,
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to unarchive position", error);
    return { success: false, error: "Failed to unarchive position" };
  }
}

export async function deletePosition(positionId: string) {
  return archivePosition(positionId);
}
