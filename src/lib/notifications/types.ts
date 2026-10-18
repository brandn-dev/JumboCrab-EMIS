import type {
  NotificationEmailStatus,
  NotificationEventType,
  NotificationModule,
  NotificationSeverity,
  Roles,
} from "@prisma/client";

export type NotificationListItem = {
  id: string;
  notificationId: string;
  eventType: NotificationEventType;
  module: NotificationModule;
  title: string;
  message: string;
  severity: NotificationSeverity;
  linkHref: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  emailEligible: boolean;
  emailStatus: NotificationEmailStatus;
  emailError: string | null;
  readAt: string | null;
  archivedAt: string | null;
  emailedAt: string | null;
  createdAt: string;
};

export type NotificationFilters = {
  limit?: number;
  unreadOnly?: boolean;
  includeArchived?: boolean;
  module?: NotificationModule | "ALL";
};

export type NotificationRecipientInput = {
  userIds?: string[];
  roles?: Roles[];
  employeeIds?: string[];
};

export type CreateNotificationInput = {
  dedupeKey?: string | null;
  eventType: NotificationEventType;
  module: NotificationModule;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  linkHref: string;
  metadata?: Record<string, unknown> | null;
  emailEligible?: boolean;
  recipients: NotificationRecipientInput;
};

export type NotificationStreamMessage =
  | {
      type: "snapshot";
      unreadCount: number;
      items: NotificationListItem[];
      serverTime: string;
    }
  | {
      type: "notification";
      unreadCount: number;
      item: NotificationListItem;
      serverTime: string;
    }
  | {
      type: "heartbeat";
      serverTime: string;
    };

export type PublishedNotificationEvent = {
  userId: string;
  unreadCount: number;
  item: NotificationListItem;
  publishedAt: string;
};
