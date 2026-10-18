import { normalizeRole, type AppRole } from "@/lib/rbac";

export const SCHEDULE_MANAGER_ROLES = ["admin", "manager"] as const satisfies readonly AppRole[];

export type ScheduleActor = {
  userId: string;
  role: AppRole;
  employeeId: string | null;
};

export type ScheduleSessionInput = {
  isLoggedIn?: boolean;
  userId?: string;
};

export type ScheduleUserInput = {
  userId: string;
  role: unknown;
  isDisabled: boolean;
  employeeId?: string | null;
};

export function resolveScheduleActor(
  session: ScheduleSessionInput,
  user: ScheduleUserInput | null,
): { actor: ScheduleActor | null; error: "Unauthorized" | null } {
  if (
    !session.isLoggedIn ||
    !session.userId ||
    !user ||
    user.userId !== session.userId ||
    user.isDisabled
  ) {
    return { actor: null, error: "Unauthorized" };
  }

  const role = normalizeRole(user.role);
  if (!role) return { actor: null, error: "Unauthorized" };

  return {
    actor: {
      userId: user.userId,
      role,
      employeeId: user.employeeId ?? null,
    },
    error: null,
  };
}

export function assertScheduleRole(
  actor: ScheduleActor,
  allowedRoles: readonly AppRole[],
) {
  if (!allowedRoles.includes(actor.role)) {
    throw new Error("Forbidden");
  }
}

export function canReadEmployeeSchedule(
  actor: ScheduleActor,
  employee: { userId: string | null; supervisorUserId: string | null },
) {
  if (actor.role === "admin" || actor.role === "manager") return true;
  if (actor.role === "supervisor") {
    return employee.supervisorUserId === actor.userId;
  }
  if (actor.role === "employee") {
    return employee.userId === actor.userId;
  }
  return false;
}

export function scheduleAccessError(error: unknown, fallback: string) {
  return error instanceof Error &&
    (error.message === "Unauthorized" || error.message === "Forbidden")
    ? error.message
    : fallback;
}
