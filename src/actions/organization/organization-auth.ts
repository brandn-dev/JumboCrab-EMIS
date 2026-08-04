import "server-only";

import { Roles } from "@prisma/client";
import { getSession } from "@/lib/auth";

const ORGANIZATION_MUTATION_ROLES = new Set<Roles>([
  Roles.Admin,
  Roles.GeneralManager,
]);

export async function requireOrganizationMutationAccess(): Promise<{
  success: false;
  error: string;
} | null> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.role) {
    return { success: false, error: "Unauthorized" };
  }

  return ORGANIZATION_MUTATION_ROLES.has(session.role)
    ? null
    : { success: false, error: "Unauthorized" };
}
