export const APP_ROLES = [
  "admin",
  "generalManager",
  "manager",
  "supervisor",
  "employee",
] as const;

export type AppRole = (typeof APP_ROLES)[number];
export type ManageableAppRole = Exclude<AppRole, "admin">;

export const MANAGEABLE_APP_ROLES = APP_ROLES.filter(
  (role): role is ManageableAppRole => role !== "admin",
);

export const ADMIN_PANEL_ROLES: AppRole[] = ["admin", "generalManager"];

export const EMPLOYEE_PANEL_ROLES: AppRole[] = ["employee"];

const ACCOUNT_ROLE_MANAGEMENT: Partial<Record<AppRole, AppRole[]>> = {
  admin: [...APP_ROLES],
  generalManager: ["generalManager", "manager", "supervisor", "employee"],
  manager: ["employee"],
};

type AccessRule = {
  path: string;
  allowedRoles: AppRole[];
};

const ROLE_BASE_PATHS: Record<AppRole, string> = {
  admin: "/admin",
  generalManager: "/generalManager",
  manager: "/manager",
  supervisor: "/supervisor",
  employee: "/employee",
};

function rolePath(role: AppRole, subPath = "") {
  const basePath = ROLE_BASE_PATHS[role];
  if (!subPath || subPath === "/") return basePath;

  const normalizedSubPath = subPath.startsWith("/") ? subPath : `/${subPath}`;
  return `${basePath}${normalizedSubPath}`;
}

const RBAC_RULES: AccessRule[] = [
  {
    path: rolePath("admin", "/users"),
    allowedRoles: ["admin", "generalManager"],
  },
  {
    path: rolePath("admin", "/notifications"),
    allowedRoles: ["admin", "generalManager"],
  },
  {
    path: rolePath("admin", "/employees/new"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/employees"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/organization/departments"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/organization/positions"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/organization/structure"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/organization"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/schedule/overrides"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/schedule/shifts"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/schedule/patterns"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/schedule"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/attendance"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/contributions"),
    allowedRoles: ["admin"],
  },
  {
    path: rolePath("admin", "/violations"),
    allowedRoles: ["admin"],
  },

  {
    path: rolePath("manager", "/users"),
    allowedRoles: ["manager"],
  },
  {
    path: rolePath("manager", "/notifications"),
    allowedRoles: ["manager"],
  },
  {
    path: rolePath("manager", "/organization"),
    allowedRoles: [],
  },
  {
    path: rolePath("supervisor", "/notifications"),
    allowedRoles: ["supervisor"],
  },
  {
    path: rolePath("generalManager", "/notifications"),
    allowedRoles: ["generalManager"],
  },
  {
    path: rolePath("employee", "/notifications"),
    allowedRoles: ["employee"],
  },
  { path: rolePath("admin"), allowedRoles: ADMIN_PANEL_ROLES },
  { path: rolePath("employee"), allowedRoles: EMPLOYEE_PANEL_ROLES },
  { path: rolePath("manager"), allowedRoles: ["manager"] },
  { path: rolePath("supervisor"), allowedRoles: ["supervisor"] },
  { path: rolePath("generalManager"), allowedRoles: ["generalManager"] },
];

const ROLE_NORMALIZATION: Record<string, AppRole> = {
  admin: "admin",
  generalmanager: "generalManager",
  manager: "manager",
  supervisor: "supervisor",
  employee: "employee",
};

function hasPathPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function normalizeRole(role: unknown): AppRole | null {
  if (typeof role !== "string") return null;
  const normalizedKey = role.replace(/[\s_-]/g, "").toLowerCase();
  return ROLE_NORMALIZATION[normalizedKey] ?? null;
}

export function getManageableAccountRoles(actorRole: unknown): AppRole[] {
  const role = normalizeRole(actorRole);
  return role ? (ACCOUNT_ROLE_MANAGEMENT[role] ?? []) : [];
}

export function canManageAccountRole(
  actorRole: unknown,
  targetRole: unknown,
): boolean {
  const target = normalizeRole(targetRole);
  if (!target) return false;

  return getManageableAccountRoles(actorRole).includes(target);
}

export function getHomePathForRole(role: AppRole): string {
  return rolePath(role, "/dashboard");
}

export function getNotificationsPathForRole(role: AppRole): string {
  return rolePath(role, "/notifications");
}

export function getForcedPasswordChangePath(role: AppRole): string {
  return rolePath(role, "/account/force-password-change");
}

export function getPostSignInPath(role: AppRole, mustChangePassword = false) {
  return mustChangePassword
    ? getForcedPasswordChangePath(role)
    : getHomePathForRole(role);
}

export function getRoleFromPath(pathname: string): AppRole | null {
  const [firstSegment] = pathname.split("/").filter(Boolean);
  return normalizeRole(firstSegment);
}

export function toCanonicalRolePath(pathname: string): string {
  const roleFromPath = getRoleFromPath(pathname);
  if (!roleFromPath) return pathname;

  const firstSlashAfterRole = pathname.indexOf("/", 1);
  const restPath =
    firstSlashAfterRole === -1 ? "" : pathname.slice(firstSlashAfterRole);
  return `${rolePath(roleFromPath)}${restPath}`;
}

export function getAllowedRolesForPath(pathname: string): AppRole[] | null {
  const rule = RBAC_RULES.find((candidate) =>
    hasPathPrefix(pathname, candidate.path),
  );
  return rule?.allowedRoles ?? null;
}
