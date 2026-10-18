import "server-only";

import {
  NotificationEmailStatus,
  type NotificationModule,
  type NotificationSeverity,
  type Prisma,
  type Roles,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildNotificationEmail,
  getAppBaseUrl,
  isEmailConfigured,
  sendEmail,
} from "@/lib/email";
import {
  getHomePathForRole,
  getRoleFromPath,
  normalizeRole,
} from "@/lib/rbac";
import { publishNotificationEvent } from "./bus.server";
import type {
  CreateNotificationInput,
  NotificationFilters,
  NotificationListItem,
  NotificationRecipientInput,
} from "./types";

const userNotificationInclude = {
  notification: {
    include: {
      actor: {
        select: {
          userId: true,
          username: true,
        },
      },
    },
  },
} satisfies Prisma.UserNotificationInclude;

type UserNotificationRecord = Prisma.UserNotificationGetPayload<{
  include: typeof userNotificationInclude;
}>;

function toIsoString(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function isRoleSafeHref(href: string, role: string) {
  const hrefRole = getRoleFromPath(href);
  return !hrefRole || hrefRole === role;
}

function toSafeHref(href: string, role: string) {
  if (isRoleSafeHref(href, role)) {
    return href;
  }

  const normalizedRole = normalizeRole(role);
  return normalizedRole ? getHomePathForRole(normalizedRole) : href;
}

function serializeNotification(
  row: UserNotificationRecord,
  role: string,
): NotificationListItem {
  return {
    id: row.id,
    notificationId: row.notificationId,
    eventType: row.notification.eventType,
    module: row.notification.module,
    title: row.notification.title,
    message: row.notification.message,
    severity: row.notification.severity,
    linkHref: toSafeHref(row.notification.linkHref, role),
    entityType: row.notification.entityType ?? null,
    entityId: row.notification.entityId ?? null,
    actorUserId: row.notification.actorUserId ?? null,
    actorUsername: row.notification.actor?.username ?? null,
    emailEligible: Boolean(row.notification.emailEligible),
    emailStatus: row.emailStatus,
    emailError: row.emailError ?? null,
    readAt: toIsoString(row.readAt),
    archivedAt: toIsoString(row.archivedAt),
    emailedAt: toIsoString(row.emailedAt),
    createdAt: row.notification.createdAt.toISOString(),
  };
}

export async function resolveNotificationUserIds(
  recipients: NotificationRecipientInput,
) {
  const userIds = new Set<string>();

  for (const userId of recipients.userIds ?? []) {
    const trimmed = userId.trim();
    if (trimmed) {
      userIds.add(trimmed);
    }
  }

  if ((recipients.roles?.length ?? 0) > 0) {
    const rows = await db.user.findMany({
      where: {
        role: { in: recipients.roles },
        isDisabled: false,
      },
      select: { userId: true },
    });
    rows.forEach((row) => userIds.add(row.userId));
  }

  if ((recipients.employeeIds?.length ?? 0) > 0) {
    const rows = await db.employee.findMany({
      where: {
        employeeId: { in: recipients.employeeIds },
        userId: { not: null },
        user: {
          isDisabled: false,
        },
      },
      select: { userId: true },
    });
    rows.forEach((row) => {
      if (row.userId) {
        userIds.add(row.userId);
      }
    });
  }

  return Array.from(userIds);
}

export async function getUnreadNotificationCount(userId: string) {
  return db.userNotification.count({
    where: {
      userId,
      readAt: null,
      archivedAt: null,
    },
  });
}

export async function listNotificationsForUser(input: {
  userId: string;
  role: string;
  filters?: NotificationFilters;
}) {
  const limit = Math.min(Math.max(input.filters?.limit ?? 20, 1), 100);
  const includeArchived = input.filters?.includeArchived ?? false;
  const unreadOnly = input.filters?.unreadOnly ?? false;
  const moduleFilter = input.filters?.module;

  const where: Prisma.UserNotificationWhereInput = {
    userId: input.userId,
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(unreadOnly ? { readAt: null } : {}),
    ...(moduleFilter && moduleFilter !== "ALL"
      ? { notification: { module: moduleFilter } }
      : {}),
  };

  const [rows, unreadCount] = await Promise.all([
    db.userNotification.findMany({
      where,
      include: userNotificationInclude,
      orderBy: [
        { notification: { createdAt: "desc" } },
        { createdAt: "desc" },
      ],
      take: limit,
    }),
    getUnreadNotificationCount(input.userId),
  ]);

  return {
    items: rows.map((row) => serializeNotification(row, input.role)),
    unreadCount,
  };
}

export async function createNotification(input: CreateNotificationInput) {
  const recipientUserIds = await resolveNotificationUserIds(input.recipients);
  if (recipientUserIds.length === 0) {
    return {
      notificationId: null,
      items: [] as NotificationListItem[],
      recipientUserIds,
    };
  }

  const dedupeKey = input.dedupeKey?.trim() || null;
  const existingNotification = dedupeKey
    ? await db.notification.findUnique({ where: { dedupeKey }, select: { id: true } })
    : null;
  const { rows, notificationId } = await db.$transaction(async (tx) => {
    const notificationData = {
      eventType: input.eventType,
      module: input.module,
      title: input.title,
      message: input.message,
      severity: input.severity,
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      linkHref: input.linkHref,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : undefined,
      emailEligible: Boolean(input.emailEligible),
    } satisfies Prisma.NotificationUncheckedCreateInput;
    const notification = dedupeKey
      ? await tx.notification.upsert({
          where: { dedupeKey },
          update: {},
          create: { ...notificationData, dedupeKey },
          select: { id: true },
        })
      : await tx.notification.create({
          data: notificationData,
          select: { id: true },
        });

    await tx.userNotification.createMany({
      data: recipientUserIds.map((userId) => ({
        notificationId: notification.id,
        userId,
        emailStatus: input.emailEligible
          ? NotificationEmailStatus.PENDING
          : NotificationEmailStatus.SKIPPED,
      })),
      skipDuplicates: true,
    });

    const rows = await tx.userNotification.findMany({
      where: {
        notificationId: notification.id,
        userId: { in: recipientUserIds },
      },
      include: userNotificationInclude,
    });
    return { rows, notificationId: notification.id };
  });

  const userRoles = await db.user.findMany({
    where: {
      userId: { in: recipientUserIds },
    },
    select: {
      userId: true,
      role: true,
    },
  });
  const roleByUserId = new Map(
    userRoles.map((row) => [row.userId, normalizeRole(row.role) ?? "employee"]),
  );

  const items = rows.map((row) =>
    serializeNotification(row, roleByUserId.get(row.userId) ?? "employee"),
  );

  const unreadCounts = await db.userNotification.groupBy({
    by: ["userId"],
    where: {
      userId: { in: recipientUserIds },
      readAt: null,
      archivedAt: null,
    },
    _count: {
      _all: true,
    },
  });
  const unreadCountByUserId = new Map(
    unreadCounts.map((row) => [row.userId, row._count._all]),
  );

  if (!existingNotification) {
    await Promise.all(
      items.map((item, index) =>
        publishNotificationEvent({
          userId: rows[index]!.userId,
          unreadCount: unreadCountByUserId.get(rows[index]!.userId) ?? 0,
          item,
          publishedAt: new Date().toISOString(),
        }),
      ),
    );
  }

  return {
    notificationId,
    items,
    recipientUserIds,
  };
}

export async function deliverNotificationEmails(notificationId: string) {
  if (!isEmailConfigured()) {
    await db.userNotification.updateMany({
      where: {
        notificationId,
        emailStatus: NotificationEmailStatus.PENDING,
      },
      data: {
        emailStatus: NotificationEmailStatus.SKIPPED,
        emailError: "SMTP is not configured.",
      },
    });
    return;
  }

  const recipients = await getNotificationEmailRecipients(notificationId);
  const appBaseUrl = getAppBaseUrl();

  for (const recipient of recipients) {
    try {
      const { subject, text, html } = buildNotificationEmail({
        title: recipient.notification.title,
        message: recipient.notification.message,
        actionUrl: new URL(recipient.notification.linkHref, appBaseUrl).toString(),
      });
      await sendEmail({
        to: recipient.user.email,
        subject,
        text,
        html,
      });
      await db.userNotification.update({
        where: {
          id: recipient.id,
        },
        data: {
          emailedAt: new Date(),
          emailStatus: NotificationEmailStatus.SENT,
          emailError: null,
        },
      });
    } catch (error) {
      await db.userNotification.update({
        where: {
          id: recipient.id,
        },
        data: {
          emailStatus: NotificationEmailStatus.FAILED,
          emailError:
            error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed.",
        },
      });
    }
  }
}

export async function createAndDispatchNotification(
  input: CreateNotificationInput,
) {
  const created = await createNotification(input);
  if (created.notificationId && input.emailEligible) {
    void deliverNotificationEmails(created.notificationId).catch((error) => {
      console.error("Failed to deliver notification emails:", error);
    });
  }
  return created;
}

async function updateNotificationState(input: {
  userId: string;
  ids?: string[];
  updater: Prisma.UserNotificationUpdateManyMutationInput;
  where?: Prisma.UserNotificationWhereInput;
}) {
  const ids = (input.ids ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  await db.userNotification.updateMany({
    where: {
      userId: input.userId,
      ...(ids.length > 0 ? { id: { in: ids } } : {}),
      ...(input.where ?? {}),
    },
    data: input.updater,
  });

  return listNotificationsForUser({
    userId: input.userId,
    role: "employee",
    filters: {
      limit: 20,
      includeArchived: false,
    },
  });
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  return updateNotificationState({
    userId,
    ids,
    updater: {
      readAt: new Date(),
    },
  });
}

export async function markNotificationsUnread(userId: string, ids: string[]) {
  return updateNotificationState({
    userId,
    ids,
    updater: {
      readAt: null,
    },
  });
}

export async function markAllNotificationsRead(userId: string) {
  return updateNotificationState({
    userId,
    updater: {
      readAt: new Date(),
    },
    where: {
      archivedAt: null,
      readAt: null,
    },
  });
}

export async function archiveNotifications(userId: string, ids?: string[]) {
  return updateNotificationState({
    userId,
    ids,
    updater: {
      archivedAt: new Date(),
      readAt: new Date(),
    },
  });
}

export async function markNotificationEmailsDelivered(notificationId: string) {
  await db.userNotification.updateMany({
    where: {
      notificationId,
      emailStatus: NotificationEmailStatus.PENDING,
    },
    data: {
      emailedAt: new Date(),
      emailStatus: NotificationEmailStatus.SENT,
      emailError: null,
    },
  });
}

export async function markNotificationEmailFailed(input: {
  notificationId: string;
  userId?: string | null;
  error: string;
}) {
  await db.userNotification.updateMany({
    where: {
      notificationId: input.notificationId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    data: {
      emailStatus: NotificationEmailStatus.FAILED,
      emailError: input.error.slice(0, 500),
    },
  });
}

export async function listNotificationsSince(input: {
  userId: string;
  role: string;
  afterCreatedAt?: string | null;
  afterId?: string | null;
}) {
  const afterCreatedAt = input.afterCreatedAt?.trim()
    ? new Date(input.afterCreatedAt)
    : null;
  const afterId = input.afterId?.trim() || null;

  if (!afterCreatedAt || Number.isNaN(afterCreatedAt.getTime())) {
    return [];
  }

  const rows = await db.userNotification.findMany({
    where: {
      userId: input.userId,
      archivedAt: null,
      OR: [
        {
          notification: {
            createdAt: {
              gt: afterCreatedAt,
            },
          },
        },
        ...(afterId
          ? [
              {
                notification: {
                  createdAt: afterCreatedAt,
                },
                id: {
                  gt: afterId,
                },
              },
            ]
          : []),
      ],
    },
    include: userNotificationInclude,
    orderBy: [
      { notification: { createdAt: "asc" } },
      { id: "asc" },
    ],
  });

  return rows.map((row) => serializeNotification(row, input.role));
}

export async function getNotificationEmailRecipients(notificationId: string) {
  return db.userNotification.findMany({
    where: {
      notificationId,
      emailStatus: NotificationEmailStatus.PENDING,
    },
    include: {
      user: {
        select: {
          userId: true,
          username: true,
          email: true,
          role: true,
        },
      },
      notification: true,
    },
  });
}

export function notificationModuleLabel(module: NotificationModule) {
  return module.replaceAll("_", " ").toLowerCase();
}

export function notificationSeverityLabel(severity: NotificationSeverity) {
  return severity.toLowerCase();
}

export function recipientRoles(...roles: Roles[]) {
  return roles;
}
