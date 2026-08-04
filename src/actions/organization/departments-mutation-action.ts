"use server";

import { db } from "@/lib/db";
import {
  getDepartmentBaseName,
  isArchivedTokenName,
  resolveDepartmentRestoreName,
} from "./departments-shared";
import { requireOrganizationMutationAccess } from "./organization-auth";

export async function archiveDepartment(departmentId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const id = typeof departmentId === "string" ? departmentId.trim() : "";
    if (!id) {
      return { success: false, error: "Department ID is required" };
    }

    const existing = await db.department.findUnique({
      where: { departmentId: id },
      select: { departmentId: true, name: true },
    });
    if (!existing) {
      return { success: false, error: "Department not found" };
    }

    await db.$transaction(async (tx) => {
      const nextName = isArchivedTokenName(existing.name)
        ? existing.name
        : `${existing.name}__archived__${existing.departmentId}`;

      await tx.department.update({
        where: { departmentId: id },
        data: {
          isActive: false,
          name: nextName,
        },
      });

      await tx.position.updateMany({
        where: { departmentId: id },
        data: { isActive: false },
      });
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to archive department", error);
    return { success: false, error: "Failed to archive department" };
  }
}

export async function unarchiveDepartment(departmentId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const id = typeof departmentId === "string" ? departmentId.trim() : "";
    if (!id) {
      return { success: false, error: "Department ID is required" };
    }

    const existing = await db.department.findUnique({
      where: { departmentId: id },
      select: { departmentId: true, name: true, isActive: true },
    });
    if (!existing) {
      return { success: false, error: "Department not found" };
    }
    if (existing.isActive) {
      return { success: true };
    }

    const restoredName = await resolveDepartmentRestoreName(
      id,
      getDepartmentBaseName(existing.name),
    );

    await db.department.update({
      where: { departmentId: id },
      data: {
        isActive: true,
        name: restoredName,
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to unarchive department", error);
    return { success: false, error: "Failed to unarchive department" };
  }
}

export async function createDepartment(input: {
  name: string;
  description?: string | null;
}): Promise<{
  success: boolean;
  data?: { departmentId: string; name: string; description?: string | null };
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description =
      typeof input.description === "string" ? input.description.trim() : null;

    if (!name) {
      return { success: false, error: "Name is required" };
    }

    const existing = await db.department.findFirst({
      where: { name, isActive: true },
      select: { departmentId: true },
    });
    if (existing) {
      return { success: false, error: "Department already exists" };
    }

    const department = await db.department.create({
      data: { name, description },
      select: { departmentId: true, name: true, description: true },
    });

    return { success: true, data: department };
  } catch (error) {
    console.error("Failed to create department", error);
    return { success: false, error: "Failed to create department" };
  }
}

export async function updateDepartment(input: {
  departmentId: string;
  name: string;
  description?: string | null;
}): Promise<{
  success: boolean;
  data?: { departmentId: string; name: string; description?: string | null };
  error?: string;
}> {
  try {
    const authError = await requireOrganizationMutationAccess();
    if (authError) return authError;

    const departmentId =
      typeof input.departmentId === "string" ? input.departmentId.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description =
      typeof input.description === "string" ? input.description.trim() : null;

    if (!departmentId) {
      return { success: false, error: "Department ID is required" };
    }
    if (!name) {
      return { success: false, error: "Name is required" };
    }

    const existingDept = await db.department.findUnique({
      where: { departmentId },
      select: { departmentId: true },
    });
    if (!existingDept) {
      return { success: false, error: "Department not found" };
    }

    const conflict = await db.department.findFirst({
      where: {
        departmentId: { not: departmentId },
        name,
        isActive: true,
      },
      select: { departmentId: true },
    });
    if (conflict) {
      return {
        success: false,
        error: "Another department already uses this name",
      };
    }

    const department = await db.department.update({
      where: { departmentId },
      data: { name, description },
      select: { departmentId: true, name: true, description: true },
    });

    return { success: true, data: department };
  } catch (error) {
    console.error("Failed to update department", error);
    return { success: false, error: "Failed to update department" };
  }
}
