import { EventEmitter } from "node:events";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { AsyncLock } from "./async-lock.js";
import { normalizeDiscordConversationTitle } from "./discord-conversation-title.js";
import {
  normalizeDiscordMessages,
  type DiscordUserIdentity,
} from "./discord-message-normalizer.js";
import { AppError, errorMessage } from "./errors.js";
import type {
  Conversation,
  Message,
  MessageProvider,
  ProvidenceEvent,
  SendMessageInput,
} from "./types.js";

interface DiscordProviderOptions {
  email: string;
  password: string;
  userDataDir: string;
  executablePath?: string;
  headless: boolean;
  pollIntervalMs: number;
}

interface DiscoveredConversation extends Conversation {
  path: string;
}

interface RawDiscordConversation {
  channelId: string;
  path: string;
  label: string;
  avatarUrl?: string;
  kind: "direct" | "group";
  unread: boolean;
}

const DISCORD_ORIGIN = "https://discord.com";
const CHANNEL_PATH = /^\/channels\/(?:@me|\d+)\/(\d+)/;
const MESSAGE_SELECTORS = '[data-list-item-id^="chat-messages"], [id^="chat-messages-"]';

export class DiscordProvider extends EventEmitter implements MessageProvider {
  readonly name = "discord" as const;
  private context?: BrowserContext;
  private page?: Page;
  private state: ReturnType<MessageProvider["status"]> = { state: "disconnected" };
  private readonly lock = new AsyncLock();
  private readonly conversations = new Map<string, DiscoveredConversation>();
  private currentUser?: DiscordUserIdentity;
  private conversationSnapshotInitialized = false;
  private pollTimer?: NodeJS.Timeout;
  private pollInProgress = false;

  constructor(private readonly options: DiscordProviderOptions) {
    super();
  }

  status() {
    return { ...this.state };
  }

  async connect(): Promise<void> {
    if (this.state.state === "connected" || this.state.state === "connecting") return;
    this.setStatus("connecting", "Opening Discord");

    try {
      const args = ["--disable-blink-features=AutomationControlled"];
      if (this.options.executablePath) args.push("--force-runtime-enable-passive");
      this.context = await chromium.launchPersistentContext(this.options.userDataDir, {
        executablePath: this.options.executablePath,
        headless: this.options.headless,
        args,
        viewport: { width: 1440, height: 1000 },
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.setDefaultTimeout(15_000);
      await this.ensureAuthenticated(this.page);
      this.currentUser = await this.readCurrentUserIdentity(this.page);
      this.setStatus("connected");
      this.startPolling();
    } catch (error) {
      this.setStatus("error", errorMessage(error));
      await this.context?.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.conversationSnapshotInitialized = false;
    this.currentUser = undefined;
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    this.setStatus("disconnected");
  }

  async listConversations(): Promise<Conversation[]> {
    return this.lock.run(async () => {
      const page = this.connectedPage();
      await this.discoverConversations(page);
      return [...this.conversations.values()]
        .map(({ path: _path, ...conversation }) => conversation)
        .sort((a, b) => a.title.localeCompare(b.title));
    });
  }

  async listMessages(conversationId: string, limit: number): Promise<Message[]> {
    return this.lock.run(() => this.readMessages(this.connectedPage(), conversationId, limit));
  }

  async sendMessage(conversationId: string, input: SendMessageInput): Promise<Message> {
    return this.lock.run(async () => {
      const page = this.connectedPage();
      await this.openConversation(page, conversationId);
      const editor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await editor.waitFor({ state: "visible" });
      await editor.fill(input.content);
      await editor.press("Enter");

      await page.waitForTimeout(500);
      const messages = await this.scrapeVisibleMessages(page, conversationId, 100);
      const scraped = [...messages].reverse().find((message) => message.content === input.content);
      const sent = scraped ? { ...scraped, author: { ...scraped.author, id: "me" } } : undefined;
      if (!sent) {
        throw new AppError("Discord accepted the send action, but the new message could not be read", 502, "DISCORD_READ_FAILED");
      }
      this.emitEvent("message.created", sent);
      return sent;
    });
  }

  async addReaction(conversationId: string, messageId: string, emoji: string): Promise<void> {
    await this.lock.run(async () => {
      const page = this.connectedPage();
      await this.openConversation(page, conversationId);
      const providerMessageId = this.parseMessageId(messageId);
      const message = page.locator(`[id$="-${providerMessageId}"], [data-list-item-id$="-${providerMessageId}"]`).first();
      if ((await message.count()) === 0) throw new AppError("Message is not currently visible in Discord", 404, "MESSAGE_NOT_FOUND");

      const existingReaction = message.getByText(emoji, { exact: true }).first();
      if (await existingReaction.isVisible().catch(() => false)) {
        await existingReaction.click();
        return;
      }

      await message.hover();
      const addReaction = message.getByRole("button", { name: /add reaction/i }).first();
      await addReaction.click();
      const picker = page.locator('[role="dialog"]').last();
      const emojiButton = picker.getByRole("button", { name: new RegExp(escapeRegExp(emoji), "i") }).first();
      if ((await emojiButton.count()) > 0) {
        await emojiButton.click();
        return;
      }
      const search = picker.locator('input[placeholder*="earch" i]').first();
      await search.fill(emoji);
      await picker.getByRole("button").last().click();
    });
  }

  private async ensureAuthenticated(page: Page): Promise<void> {
    await page.goto(`${DISCORD_ORIGIN}/channels/@me`, { waitUntil: "domcontentloaded" });
    const email = page.locator('input[name="email"]');
    const shell = this.discordShell(page);
    await email.or(shell).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);

    if (await shell.isVisible().catch(() => false)) {
      await this.waitForDiscordShell(page);
      return;
    }

    const password = page.locator('input[name="password"]');
    if (!(await email.isVisible().catch(() => false))) {
      throw new AppError("Discord did not show either its login form or messaging interface", 503, "DISCORD_LOAD_FAILED");
    }
    await email.fill(this.options.email);
    await password.fill(this.options.password);
    await page.locator('button[type="submit"]').click();

    try {
      await page.waitForURL(/\/channels\//, { timeout: 120_000 });
    } catch {
      const verificationVisible = await page
        .getByText(/verify|captcha|two-factor|authenticator/i)
        .first()
        .isVisible()
        .catch(() => false);
      throw new AppError(
        verificationVisible
          ? "Discord requires interactive verification. Complete it in the opened browser, then restart the backend."
          : "Discord login did not complete. Check the credentials and the opened browser.",
        503,
        "DISCORD_LOGIN_FAILED",
      );
    }
    await this.waitForDiscordShell(page);
  }

  private async waitForDiscordShell(page: Page): Promise<void> {
    await this.discordShell(page).waitFor({ state: "visible", timeout: 60_000 });
  }

  private discordShell(page: Page): Locator {
    return page
      .locator('[data-list-id="guildsnav"], nav[aria-label*="server" i], [class*="guilds_"]')
      .first();
  }

  private async readCurrentUserIdentity(page: Page): Promise<DiscordUserIdentity | undefined> {
    const statusPanel = page.locator('[aria-label*="User status and settings" i]').first();
    if (!(await statusPanel.isVisible().catch(() => false))) return this.currentUser;

    return statusPanel.evaluate((node) => {
      let scope: Element | null = node;
      let avatar: HTMLImageElement | null = null;
      for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
        avatar = scope.querySelector('img[src*="/avatars/"], img[class*="avatar" i]');
        if (avatar) break;
      }
      if (!scope || !avatar) return undefined;
      const nameNode = scope.querySelector('[class*="username" i], [class*="nameTag" i]');
      const displayName = nameNode?.textContent?.trim() || avatar.alt.trim() || undefined;
      return {
        ...(displayName ? { displayName } : {}),
        ...(avatar.src ? { avatarUrl: avatar.src } : {}),
      };
    });
  }

  private async discoverConversations(page: Page): Promise<void> {
    await this.navigateDiscordPath(page, "/channels/@me");
    await this.waitForDiscordShell(page);
    await page.waitForTimeout(400);
    await this.collectDirectConversationLinks(page, false);
  }

  private async collectDirectConversationLinks(page: Page, emitChanges: boolean): Promise<void> {
    const links: RawDiscordConversation[] = await page.locator('a[href^="/channels/@me/"]').evaluateAll((anchors) =>
      anchors.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const path = anchor.getAttribute("href") || "";
        const match = path.match(/^\/channels\/@me\/(\d+)/);
        if (!match?.[1]) return [];
        const label = anchor.getAttribute("aria-label") || anchor.textContent?.trim() || `Discord ${match[1]}`;
        const image = anchor.querySelector("img") as HTMLImageElement | null;
        const text = anchor.textContent || label;
        const row = anchor.closest('[role="listitem"], li') || anchor.parentElement;
        const notificationCopy = `${anchor.getAttribute("aria-label") || ""} ${row?.getAttribute("aria-label") || ""}`;
        const hasNotificationIndicator = Boolean(row?.querySelector([
          '[class*="unread" i]',
          '[class*="mention" i]',
          '[class*="numberBadge" i]',
          '[aria-label*="unread" i]',
          '[aria-label*="mention" i]',
          '[aria-label*="notification" i]',
        ].join(", ")));
        const participantCount = text.match(/\b(\d+)\s+members?\b/i)?.[1];
        return [{
          channelId: match[1],
          path,
          label,
          avatarUrl: image?.src,
          kind: participantCount || /(?:\(|,\s*)group (?:message|chat)\b/i.test(label)
            ? "group" as const
            : "direct" as const,
          unread: /\b(?:unread|mention|notification)\b/i.test(notificationCopy) || hasNotificationIndicator,
        }];
      }),
    );

    const uniqueLinks = new Map<string, RawDiscordConversation>();
    for (const link of links) {
      const existing = uniqueLinks.get(link.channelId);
      uniqueLinks.set(link.channelId, existing ? {
        ...existing,
        ...link,
        avatarUrl: link.avatarUrl || existing.avatarUrl,
        unread: existing.unread || link.unread,
      } : link);
    }

    for (const link of uniqueLinks.values()) {
      const id = this.conversationId(link.channelId);
      const previous = this.conversations.get(id);
      const conversation: DiscoveredConversation = {
        id,
        provider: "discord",
        providerConversationId: link.channelId,
        title: normalizeDiscordConversationTitle(link.label),
        kind: link.kind,
        avatarUrl: link.avatarUrl,
        unread: link.unread,
        path: link.path,
      };
      this.conversations.set(id, conversation);
      if (emitChanges && this.conversationSnapshotInitialized
        && ((!previous && conversation.unread) || (previous && previous.unread !== conversation.unread))) {
        const { path: _path, ...publicConversation } = conversation;
        this.emitEvent("conversation.updated", publicConversation);
      }
    }
    if (uniqueLinks.size > 0) this.conversationSnapshotInitialized = true;
  }

  private async readMessages(page: Page, conversationId: string, limit: number): Promise<Message[]> {
    await this.openConversation(page, conversationId);
    return this.scrapeVisibleMessages(page, conversationId, limit);
  }

  private async openConversation(page: Page, conversationId: string): Promise<void> {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      await this.discoverConversations(page);
      conversation = this.conversations.get(conversationId);
    }
    if (!conversation) throw new AppError("Discord conversation not found", 404, "CONVERSATION_NOT_FOUND");

    await this.navigateDiscordPath(page, conversation.path);
    await page.locator(MESSAGE_SELECTORS).last().waitFor({ state: "visible", timeout: 20_000 }).catch(async () => {
      const empty = await page.getByText(/beginning of the|no messages/i).isVisible().catch(() => false);
      if (!empty) throw new AppError("Discord messages did not load", 502, "DISCORD_READ_FAILED");
    });
  }

  private async navigateDiscordPath(page: Page, path: string): Promise<void> {
    if (new URL(page.url()).pathname.startsWith(path)) return;

    let target = page.locator(`a[href="${path}"]`).first();
    if (!(await target.isVisible().catch(() => false))) {
      if (/^\/channels\/@me\/\d+$/.test(path)) {
        await this.navigateDiscordHome(page);
        await page.waitForTimeout(350);
        target = page.locator(`a[href="${path}"]`).first();
      }
    }

    if (await target.isVisible().catch(() => false)) {
      await target.click();
      await this.waitForPath(page, path);
      return;
    }

    if (path === "/channels/@me") {
      await this.navigateDiscordHome(page);
      return;
    }
    throw new AppError("Discord direct message or group chat is not visible", 404, "CONVERSATION_NOT_FOUND");
  }

  private async navigateDiscordHome(page: Page): Promise<void> {
    if (new URL(page.url()).pathname.startsWith("/channels/@me")) return;
    const item = page.locator('[data-list-item-id="guildsnav___home"]').first();
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      await this.waitForPath(page, "/channels/@me");
      return;
    }
    await page.goto(`${DISCORD_ORIGIN}/channels/@me`, { waitUntil: "domcontentloaded" });
  }

  private async waitForPath(page: Page, path: string, timeout = 15_000): Promise<void> {
    await page.waitForFunction(
      (expected) => window.location.pathname === expected || window.location.pathname.startsWith(`${expected}/`),
      path,
      { timeout },
    );
  }

  private async scrapeVisibleMessages(page: Page, conversationId: string, limit: number): Promise<Message[]> {
    this.currentUser = await this.readCurrentUserIdentity(page) ?? this.currentUser;
    const rawMessages = await page.locator(MESSAGE_SELECTORS).evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        const rawId = element.id || element.dataset.listItemId || "";
        const id = rawId.match(/(\d{15,25})$/)?.[1] || "";
        const authorNode = element.querySelector('[class*="username"], [class*="headerText"]');
        const avatar = element.querySelector('img[class*="avatar"]') as HTMLImageElement | null;
        const time = element.querySelector("time") as HTMLTimeElement | null;
        const labelledBy = element.getAttribute("aria-labelledby")
          || element.querySelector("[aria-labelledby]")?.getAttribute("aria-labelledby")
          || "";
        const labelledAuthor = labelledBy
          .split(/\s+/)
          .map((labelId) => document.getElementById(labelId))
          .find((label) => label && /username/i.test(`${label.id} ${label.className}`));
        const contentNodes = [...element.querySelectorAll('[class*="markup"]')];
        const content = contentNodes.map((part) => part.textContent || "").join("\n").trim();
        const attachmentLinks = [...element.querySelectorAll('a[href]')]
          .map((anchor) => anchor as HTMLAnchorElement)
          .filter((anchor) => /cdn\.discordapp\.|media\.discordapp\.|attachments\//.test(anchor.href))
          .map((anchor) => ({ name: anchor.getAttribute("download") || anchor.textContent?.trim() || "attachment", url: anchor.href }));
        const reactions = [...element.querySelectorAll('[class*="reaction"]')].flatMap((reaction) => {
          const emoji = reaction.querySelector("img")?.getAttribute("alt") || reaction.querySelector('[class*="emoji"]')?.textContent?.trim();
          if (!emoji) return [];
          const countText = reaction.querySelector('[class*="count"]')?.textContent;
          return [{ emoji, count: countText ? Number.parseInt(countText, 10) || undefined : undefined }];
        });
        return {
          id,
          author: authorNode?.textContent?.trim() || labelledAuthor?.textContent?.trim(),
          avatarUrl: avatar?.src,
          content,
          timestamp: time?.dateTime || time?.getAttribute("datetime") || undefined,
          edited: /edited/i.test(element.textContent || ""),
          attachments: attachmentLinks,
          reactions,
        };
      }),
    );

    return normalizeDiscordMessages(rawMessages, conversationId, limit, this.currentUser);
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.pollNativeNotifications(), this.options.pollIntervalMs);
    this.pollTimer.unref();
  }

  private async pollNativeNotifications(): Promise<void> {
    if (this.pollInProgress || this.state.state !== "connected") return;
    this.pollInProgress = true;
    try {
      await this.lock.run(async () => {
        const page = this.connectedPage();
        if (!new URL(page.url()).pathname.startsWith("/channels/@me")) return;
        await this.collectDirectConversationLinks(page, true);
      });
    } catch {
      // Native notification polling is best-effort and must not disconnect the provider.
    } finally {
      this.pollInProgress = false;
    }
  }

  private connectedPage(): Page {
    if (this.state.state !== "connected" || !this.page) {
      throw new AppError("Discord is not connected", 503, "PROVIDER_NOT_CONNECTED");
    }
    return this.page;
  }

  private conversationId(providerId: string): string {
    return `discord:${providerId}`;
  }

  private parseMessageId(messageId: string): string {
    const match = messageId.match(/^discord:(\d+)$/);
    if (!match?.[1]) throw new AppError("Invalid Discord message id", 400, "INVALID_MESSAGE_ID");
    return match[1];
  }

  private setStatus(state: ReturnType<MessageProvider["status"]>["state"], detail?: string): void {
    this.state = { state, ...(detail ? { detail } : {}) };
    this.emitEvent("provider.status", this.status());
  }

  private emitEvent(type: ProvidenceEvent["type"], data: unknown): void {
    this.emit("event", {
      type,
      provider: "discord",
      occurredAt: new Date().toISOString(),
      data,
    } satisfies ProvidenceEvent);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
