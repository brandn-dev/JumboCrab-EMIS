"use server";

import { getSession } from "@/lib/auth";
import { checkConnection, db } from "@/lib/db";
import type { Employee as PrismaEmployee, Prisma } from "@prisma/client";
import { shiftDateByDays } from "@/lib/payroll/helpers";
import { SUFFIX } from "@/lib/validations/employees";
import {
  employeeLookupInclude,
  normalizeEmployeeRelationIds,
  parseDateInput,
  revalidateEmployeePages,
  serializeEmployeeWithLookups,
  validateEmployeeRelationIds,
} from "./employees-shared";
import type { EmployeeActionRecord } from "./types";

export async function updateEmployee(
  employeeData: Partial<Omit<PrismaEmployee, "isEnded">> & {
    employeeId: string;
    isEnded?: boolean | null;
  },
): Promise<{
  success: boolean;
  data?: EmployeeActionRecord;
  error?: string;
}> {
  const isConnected = await checkConnection();
  if (!isConnected) {
    throw new Error("Database connection not available");
  }

  try {
    const session = await getSession();
    const actorUserId = session.userId ?? null;
    const data = JSON.parse(JSON.stringify(employeeData));
    const { employeeId } = data;
    delete data.employeeId;

    if ("employeeCode" in data) {
      delete data.employeeCode;
    }

    const currentData = await db.employee.findUnique({
      where: { employeeId },
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        nationality: true,
        departmentId: true,
        positionId: true,
        updatedAt: true,
      },
    });

    if (!currentData) {
      return { success: false, error: "Employee not found" };
    }

    console.log(
      "[SERVER] Current employee data in DB:",
      JSON.stringify(currentData, null, 2),
    );

    const updateData: Record<string, unknown> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };

    const allowedFields = [
      "employeeCode",
      "firstName",
      "middleName",
      "lastName",
      "sex",
      "birthdate",
      "startDate",
      "civilStatus",
      "departmentId",
      "positionId",
      "supervisorUserId",
      "employmentStatus",
      "currentStatus",
      "nationality",
      "address",
      "city",
      "state",
      "postalCode",
      "country",
      "img",
      "endDate",
      "email",
      "phone",
      "description",
      "suffix",
      "emergencyContactName",
      "emergencyContactRelationship",
      "emergencyContactPhone",
      "emergencyContactEmail",
      "userId",
    ] as const;

    allowedFields.forEach((field) => {
      if (field in data) {
        updateData[field] = data[field as keyof typeof data];
      }
    });

    const normalizedRelationIds = normalizeEmployeeRelationIds({
      userId: updateData.userId,
      departmentId: updateData.departmentId,
      positionId: updateData.positionId,
      supervisorUserId: updateData.supervisorUserId,
    });

    (["userId", "departmentId", "positionId", "supervisorUserId"] as const).forEach((field) => {
      if (field in updateData) {
        updateData[field] = normalizedRelationIds[field];
      }
    });

    const relationError =
      await validateEmployeeRelationIds(normalizedRelationIds);
    if (relationError) {
      return { success: false, error: relationError };
    }

    (["birthdate", "startDate", "endDate"] as const).forEach((field) => {
      if (field in updateData) {
        const value = updateData[field];
        if (value == null || value === "") {
          updateData[field] = field === "endDate" ? null : undefined;
          if (updateData[field] === undefined) delete updateData[field];
          return;
        }
        const parsed = parseDateInput(value);
        if (!parsed) {
          delete updateData[field];
        } else {
          updateData[field] = parsed;
        }
      }
    });

    if (data.suffix && !SUFFIX.includes(data.suffix)) {
      delete updateData.suffix;
    }

    const updatedEmployee = await db.employee.update({
      where: { employeeId },
      data: updateData as Prisma.EmployeeUncheckedUpdateInput,
      include: employeeLookupInclude,
    });
    const hasDepartmentUpdate = Object.prototype.hasOwnProperty.call(
      updateData,
      "departmentId",
    );
    const hasPositionUpdate = Object.prototype.hasOwnProperty.call(
      updateData,
      "positionId",
    );
    const nextDepartmentId = hasDepartmentUpdate
      ? (updateData.departmentId as string | null | undefined) ?? null
      : currentData.departmentId ?? null;
    const nextPositionId = hasPositionUpdate
      ? (updateData.positionId as string | null | undefined) ?? null
      : currentData.positionId ?? null;

    if (
      (hasDepartmentUpdate || hasPositionUpdate) &&
      (nextDepartmentId !== (currentData.departmentId ?? null) ||
        nextPositionId !== (currentData.positionId ?? null))
    ) {
      const effectiveFrom = new Date();
      await db.employeePositionHistory.updateMany({
        where: {
          employeeId,
          effectiveTo: null,
        },
        data: {
          effectiveTo: shiftDateByDays(effectiveFrom, -1),
        },
      });

      await db.employeePositionHistory.create({
        data: {
          employeeId,
          departmentId: nextDepartmentId,
          positionId: nextPositionId,
          effectiveFrom,
          reason: "Department/position updated",
          metadata: {
            previousDepartmentId: currentData.departmentId ?? null,
            previousPositionId: currentData.positionId ?? null,
            source: "employee_update",
          },
          createdByUserId: actorUserId,
        },
      });
    }

    revalidateEmployeePages(employeeId);
    return { success: true, data: serializeEmployeeWithLookups(updatedEmployee) };
  } catch (error) {
    console.error("Error in updateEmployee:", error);
    return {
      success: false,
      error: `Failed to update employee: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}
