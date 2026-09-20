import type { Attachment, Message } from "./types.js";

export interface RawDiscordMessage {
  id: string;
  author?: string;
  avatarUrl?: string;
  content: string;
  timestamp?: string;
  edited: boolean;
  attachments: Attachment[];
  reactions: Array<{ emoji: string; count?: number }>;
}

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DISCORD_SNOWFLAKE = /^\d{15,25}$/;

export function normalizeDiscordMessages(
  rawMessages: RawDiscordMessage[],
  conversationId: string,
  limit: number,
): Message[] {
  const unique = new Map<string, RawDiscordMessage>();

  for (const raw of rawMessages) {
    if (!DISCORD_SNOWFLAKE.test(raw.id)) continue;
    const existing = unique.get(raw.id);
    unique.set(raw.id, existing ? mergeRawMessages(existing, raw) : raw);
  }

  return inheritContinuationAuthors([...unique.values()])
    .filter(hasMessagePayload)
    .slice(-limit)
    .map((raw) => ({
      id: `discord:${raw.id}`,
      provider: "discord",
      providerMessageId: raw.id,
      conversationId,
      author: {
        displayName: raw.author?.trim() || "Unknown Discord user",
        ...(raw.avatarUrl ? { avatarUrl: raw.avatarUrl } : {}),
      },
      content: raw.content,
      sentAt: validTimestamp(raw.timestamp) ?? timestampFromSnowflake(raw.id),
      edited: raw.edited,
      attachments: raw.attachments,
      reactions: raw.reactions,
    }));
}

function inheritContinuationAuthors(messages: RawDiscordMessage[]): RawDiscordMessage[] {
  const avatarsByAuthor = new Map<string, string>();
  let previousAuthor: string | undefined;
  let previousAvatarUrl: string | undefined;

  return messages.map((message) => {
    const author = message.author?.trim();
    if (!author) {
      return {
        ...message,
        author: previousAuthor,
        avatarUrl: message.avatarUrl || previousAvatarUrl,
      };
    }

    const avatarUrl = message.avatarUrl
      || (author === previousAuthor ? previousAvatarUrl : undefined)
      || avatarsByAuthor.get(author);
    if (avatarUrl) avatarsByAuthor.set(author, avatarUrl);
    previousAuthor = author;
    previousAvatarUrl = avatarUrl;

    return { ...message, author, avatarUrl };
  });
}

function hasMessagePayload(message: RawDiscordMessage): boolean {
  return message.content.trim().length > 0 || message.attachments.length > 0;
}

function mergeRawMessages(first: RawDiscordMessage, second: RawDiscordMessage): RawDiscordMessage {
  return {
    id: first.id,
    author: preferText(first.author, second.author),
    avatarUrl: first.avatarUrl || second.avatarUrl,
    content: preferText(first.content, second.content) ?? "",
    timestamp: validTimestamp(first.timestamp) ?? validTimestamp(second.timestamp),
    edited: first.edited || second.edited,
    attachments: uniqueBy([...first.attachments, ...second.attachments], (attachment) => attachment.url),
    reactions: richerArray(first.reactions, second.reactions),
  };
}

function preferText(first?: string, second?: string): string | undefined {
  const firstTrimmed = first?.trim();
  const secondTrimmed = second?.trim();
  if (!firstTrimmed) return secondTrimmed;
  if (!secondTrimmed) return firstTrimmed;
  return secondTrimmed.length > firstTrimmed.length ? secondTrimmed : firstTrimmed;
}

function validTimestamp(value?: string): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function timestampFromSnowflake(id: string): string {
  const timestamp = (BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
  return new Date(Number(timestamp)).toISOString();
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function richerArray<T>(first: T[], second: T[]): T[] {
  return second.length > first.length ? second : first;
}
