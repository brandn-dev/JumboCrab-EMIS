"use server";

import { Roles } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrganizationMutationAccess } from "./organization-auth";

type SupervisorUser = {
  userId: string;
  username: string;
  email: string;
  role: string;
  img?: string | null;
};

type StructureEmployee = {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  img?: string | null;
  supervisorUserId?: string | null;
  role?: string | null;
  department?: { departmentId: string; name: string; isActive: boolean } | null;
  position?: { positionId: string; name: string; isActive: boolean } | null;
};

const normalizeArchivedLabel = (
  value: { name: string; isActive: boolean },
  fallback: string,
) => {
  const hasArchivedToken =
    value.name.includes("__deleted__") || value.name.includes("__archived__");
  return !value.isActive || hasArchivedToken ? fallback : value.name;
};

export async function getOrganizationStructure(): Promise<{
  success: boolean;
  data?: StructureEmployee[];
  supervisors?: SupervisorUser[];
  supervisorGroups?: { supervisor: SupervisorUser; reports: StructureEmployee[] }[];
  unassigned?: StructureEmployee[];
  error?: string;
}> {
  try {
    const [employees, supervisors] = await Promise.all([
      db.employee.findMany({
        where: { isArchived: false },
        orderBy: { employeeCode: "asc" },
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          img: true,
          supervisorUserId: true,
          user: { select: { userId: true, role: true, username: true, email: true } },
          department: { select: { departmentId: true, name: true, isActive: true } },
          position: { select: { positionId: true, name: true, isActive: true } },
        },
      }),
      db.user.findMany({
        where: {
          role: {
            in: [
              Roles.Admin,
              Roles.GeneralManager,
              Roles.Manager,
              Roles.Supervisor,
            ],
          },
        },
        select: {
          userId: true,
          username: true,
          email: true,
          role: true,
          employee: { select: { img: true } },
        },
        orderBy: { username: "asc" },
      }),
    ]);

    const payload: StructureEmployee[] = employees.map((employee) => ({
      employeeId: employee.employeeId,
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      img: employee.img ?? null,
      supervisorUserId: employee.supervisorUserId,
      role: employee.user?.role ?? null,
      department: employee.department
        ? {
            departmentId: employee.department.departmentId,
            name: normalizeArchivedLabel(employee.department, "Archived department"),
            isActive: employee.department.isActive,
          }
        : null,
      position: employee.position
        ? {
            positionId: employee.position.positionId,
            name: normalizeArchivedLabel(employee.position, "Archived position"),
            isActive: employee.position.isActive,
          }
        : null,
    }));

    const normalizedSupervisors = supervisors.map((supervisor) => ({
      userId: supervisor.userId,
      username: supervisor.username,
      email: supervisor.email,
      role: supervisor.role,
      img: supervisor.employee?.img ?? null,
    }));

    const supervisorGroups = normalizedSupervisors.map((sup) => ({
      supervisor: sup,
      reports: [] as StructureEmployee[],
    }));
    const reportsBySupervisor = new Map<string, StructureEmployee[]>(
      supervisorGroups.map((group) => [group.supervisor.userId, group.reports])
    );
    const unassigned: StructureEmployee[] = [];

    payload.forEach((emp) => {
      const bucket = emp.supervisorUserId
        ? reportsBySupervisor.get(emp.supervisorUserId)
        : undefined;
      if (bucket) {
        bucket.push(emp);
      } else {
        unassigned.push(emp);
      }
    });

    return {
      success: true,
      data: payload,
      supervisors: normalizedSupervisors,
      supervisorGroups,
      unassigned,
    };
  } catch (error) {
    console.error("Failed to fetch organization structure", error);
    return { success: false, error: "Failed to load structure" };
  }
}

export async function updateEmployeeSupervisor(input: {
  employeeId: string;
  supervisorUserId?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const employeeId =
      typeof input.employeeId === "string" ? input.employeeId.trim() : "";
    const supervisorId =
      typeof input.supervisorUserId === "string" && input.supervisorUserId.trim() !== ""
        ? input.supervisorUserId.trim()
        : null;

    if (!employeeId) {
      return { success: false, error: "employeeId is required" };
    }

    const employee = await db.employee.findUnique({
      where: { employeeId },
      select: { employeeId: true },
    });
    if (!employee) {
      return { success: false, error: "Employee not found" };
    }

    if (supervisorId) {
      const supervisor = await db.user.findUnique({
        where: { userId: supervisorId },
        select: { userId: true },
      });
      if (!supervisor) {
        return { success: false, error: "Supervisor not found" };
      }
    }

    await db.employee.update({
      where: { employeeId },
      data: { supervisorUserId: supervisorId },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to update supervisor", error);
    return { success: false, error: "Failed to update supervisor" };
  }
}

export async function updateEmployeesSupervisorBulk(input: {
  employeeIds: string[];
  supervisorUserId?: string | null;
}): Promise<{ success: boolean; updatedCount?: number; error?: string }> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const employeeIds = Array.isArray(input.employeeIds)
      ? Array.from(
          new Set(
            input.employeeIds
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .filter(Boolean),
          ),
        )
      : [];

    const supervisorId =
      typeof input.supervisorUserId === "string" &&
      input.supervisorUserId.trim() !== ""
        ? input.supervisorUserId.trim()
        : null;

    if (employeeIds.length === 0) {
      return { success: false, error: "At least one employee must be selected" };
    }

    if (supervisorId) {
      const supervisor = await db.user.findUnique({
        where: { userId: supervisorId },
        select: { userId: true },
      });
      if (!supervisor) {
        return { success: false, error: "Supervisor not found" };
      }
    }

    const result = await db.employee.updateMany({
      where: {
        employeeId: { in: employeeIds },
        isArchived: false,
      },
      data: { supervisorUserId: supervisorId },
    });

    return { success: true, updatedCount: result.count };
  } catch (error) {
    console.error("Failed to bulk update supervisors", error);
    return { success: false, error: "Failed to bulk update supervisors" };
  }
}
