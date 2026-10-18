import "server-only";

import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import {
  assertScheduleRole,
  resolveScheduleActor,
  SCHEDULE_MANAGER_ROLES,
  type ScheduleActor,
} from "@/lib/scheduling-access";
import type { AppRole } from "@/lib/rbac";

export async function requireScheduleActor(
  allowedRoles?: readonly AppRole[],
): Promise<ScheduleActor> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    throw new Error("Unauthorized");
  }

  const user = await db.user.findUnique({
    where: { userId: session.userId },
    select: {
      userId: true,
      role: true,
      isDisabled: true,
      employee: { select: { employeeId: true } },
    },
  });
  const resolved = resolveScheduleActor(session, user
    ? {
        userId: user.userId,
        role: user.role,
        isDisabled: user.isDisabled,
        employeeId: user.employee?.employeeId ?? null,
      }
    : null);

  if (!resolved.actor) throw new Error(resolved.error ?? "Unauthorized");
  if (allowedRoles) assertScheduleRole(resolved.actor, allowedRoles);
  return resolved.actor;
}

export const requireScheduleManager = () =>
  requireScheduleActor(SCHEDULE_MANAGER_ROLES);
