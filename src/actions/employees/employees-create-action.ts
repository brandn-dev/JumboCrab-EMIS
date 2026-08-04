"use server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { generateUniqueEmployeeCode } from "@/lib/employees/employee-code";
import {
  EMPLOYEE_CODE_REGEX,
  SUFFIX,
  createEmployeeSchema,
  type Employee,
} from "@/lib/validations/employees";
import type { Prisma } from "@prisma/client";
import {
  employeeLookupInclude,
  normalizeEmployeeRelationIds,
  revalidateEmployeePages,
  serializeEmployeeWithLookups,
  validateEmployeeRelationIds,
} from "./employees-shared";
import type { EmployeeActionRecord } from "./types";

export async function createEmployee(employeeData: Employee): Promise<{
  success: boolean;
  data?: EmployeeActionRecord;
  error?: string;
}> {
  try {
    console.log("Creating new employee with data:", employeeData);
    const session = await getSession();

    const code =
      typeof employeeData.employeeCode === "string" &&
      EMPLOYEE_CODE_REGEX.test(employeeData.employeeCode)
        ? employeeData.employeeCode
        : await generateUniqueEmployeeCode();

    const payloadStart = {
      ...employeeData,
      employeeCode: code,
    };

    const parsed = createEmployeeSchema.safeParse(payloadStart);

    if (!parsed.success) {
      const errorMessage = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ");
      console.error("Validation failed:", errorMessage);
      return {
        success: false,
        error: `Validation failed: ${errorMessage}`,
      };
    }

    const {
      userId,
      departmentId,
      positionId,
      isEnded: _legacyIsEnded,
      department: _legacyDepartment,
      position: _legacyPosition,
      ...baseData
    } = parsed.data;
    void _legacyDepartment;
    void _legacyPosition;
    void _legacyIsEnded;

    const { suffix, ...restBaseData } = baseData;
    type AllowedSuffix = (typeof SUFFIX)[number];
    const normalizedSuffix: AllowedSuffix | null =
      typeof suffix === "string" && SUFFIX.includes(suffix as AllowedSuffix)
        ? (suffix as AllowedSuffix)
        : null;
    const normalizedRelationIds = normalizeEmployeeRelationIds({
      userId,
      departmentId,
      positionId,
    });
    const relationError =
      await validateEmployeeRelationIds(normalizedRelationIds);
    if (relationError) {
      return { success: false, error: relationError };
    }

    const employeeCreateData = {
      ...restBaseData,
      ...(suffix !== undefined && { suffix: normalizedSuffix }),
      departmentId: normalizedRelationIds.departmentId,
      positionId: normalizedRelationIds.positionId,
      userId: normalizedRelationIds.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Prisma.EmployeeUncheckedCreateInput;
    console.log("Final validated create data:", employeeCreateData);

    const actorUserId = session.userId ?? null;

    const newEmployee = await db.employee.create({
      data: employeeCreateData,
      include: employeeLookupInclude,
    });

    if (employeeCreateData.positionId || employeeCreateData.departmentId) {
      await db.employeePositionHistory.create({
        data: {
          employeeId: newEmployee.employeeId,
          departmentId: employeeCreateData.departmentId ?? null,
          positionId: employeeCreateData.positionId ?? null,
          effectiveFrom: employeeCreateData.startDate ?? new Date(),
          reason: "Initial department/position assignment",
          metadata: {
            source: "employee_create",
          },
          createdByUserId: actorUserId,
        },
      });
    }

    revalidateEmployeePages(newEmployee.employeeId);
    return { success: true, data: serializeEmployeeWithLookups(newEmployee) };
  } catch (error) {
    console.error("Error in createEmployee:", error);
    return {
      success: false,
      error: `Failed to create employee: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}
