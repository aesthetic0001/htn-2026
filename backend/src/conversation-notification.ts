import type { Conversation, ConversationNotification } from "./types.js";

interface NotificationState {
  unread: boolean;
  notification?: ConversationNotification;
}

export function discordConversationNotification(
  notificationCopy: string,
  indicatorCopy: string,
  hasUnreadIndicator: boolean,
  hasMentionIndicator: boolean,
): NotificationState {
  const mentions = hasMentionIndicator || /\b(?:mentions?|pings?)\b/i.test(`${notificationCopy} ${indicatorCopy}`);
  const unread = hasUnreadIndicator || mentions || /\b(?:unread|notification)\b/i.test(notificationCopy);
  if (!unread) return { unread: false };

  const countMatch = indicatorCopy.match(/\b(\d{1,4})\b/);
  const count = countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : undefined;
  return {
    unread: true,
    notification: {
      kind: mentions ? "mention" : "unread",
      ...(count && count > 0 ? { count } : {}),
    },
  };
}

export function instagramConversationNotification(
  text: string,
  notificationCopy: string,
  hasUnreadIndicator: boolean,
): NotificationState {
  const unread = hasUnreadIndicator
    || /\b(?:unread|new messages?|notification)\b/i.test(`${notificationCopy} ${text}`);
  return unread
    ? { unread: true, notification: { kind: "unread" } }
    : { unread: false };
}

export function extractInstagramConversationPreview(text: string, title: string): string | undefined {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const preview = lines.find((line) =>
    line !== title
    && !/^(?:active (?:now|\d+[smhdw])|\d+[smhdw]|\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i.test(line)
    && !/^(?:seen|delivered)$/i.test(line),
  );
  if (!preview) return undefined;
  return /^new messages?\.*$/i.test(preview) ? "New messages…" : preview;
}

export function conversationNotificationChanged(
  previous: Conversation | undefined,
  conversation: Conversation,
): boolean {
  if (!previous) return conversation.unread;
  if (previous.unread !== conversation.unread) return true;
  if (!conversation.unread) return false;
  return previous.preview !== conversation.preview
    || previous.notification?.kind !== conversation.notification?.kind
    || previous.notification?.count !== conversation.notification?.count
    || previous.lastUpdatedAt !== conversation.lastUpdatedAt;
}
