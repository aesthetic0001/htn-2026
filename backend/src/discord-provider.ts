import { EventEmitter } from "node:events";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { AsyncLock } from "./async-lock.js";
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
  private readonly watchedConversations = new Set<string>();
  private readonly knownMessageIds = new Map<string, Set<string>>();
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
    return this.lock.run(async () => {
      const messages = await this.readMessages(this.connectedPage(), conversationId, limit);
      this.watchedConversations.add(conversationId);
      this.knownMessageIds.set(conversationId, new Set(messages.map((message) => message.id)));
      return messages;
    });
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
      const sent = [...messages].reverse().find((message) => message.content === input.content);
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

  private async discoverConversations(page: Page): Promise<void> {
    await this.navigateDiscordPath(page, "/channels/@me");
    await this.waitForDiscordShell(page);
    await page.waitForTimeout(400);
    this.conversations.clear();
    await this.collectDirectConversationLinks(page);
  }

  private async collectDirectConversationLinks(page: Page): Promise<void> {
    const links = await page.locator('a[href^="/channels/@me/"]').evaluateAll((anchors) =>
      anchors.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const path = anchor.getAttribute("href") || "";
        const match = path.match(/^\/channels\/@me\/(\d+)/);
        if (!match?.[1]) return [];
        const label = anchor.getAttribute("aria-label") || anchor.textContent?.trim() || `Discord ${match[1]}`;
        const image = anchor.querySelector("img") as HTMLImageElement | null;
        const text = anchor.textContent || label;
        return [{
          channelId: match[1],
          path,
          label,
          avatarUrl: image?.src,
          kind: /\b\d+\s+members?\b/i.test(text) ? "group" as const : "direct" as const,
          unread: /\bunread\b/i.test(label),
        }];
      }),
    );

    for (const link of links) {
      const id = this.conversationId(link.channelId);
      this.conversations.set(id, {
        id,
        provider: "discord",
        providerConversationId: link.channelId,
        title: cleanLabel(link.label),
        kind: link.kind,
        avatarUrl: link.avatarUrl,
        unread: link.unread,
        path: link.path,
      });
    }
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
    const rawMessages = await page.locator(MESSAGE_SELECTORS).evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        const rawId = element.id || element.dataset.listItemId || "";
        const id = rawId.match(/(\d{15,25})$/)?.[1] || rawId;
        const authorNode = element.querySelector('[class*="username"], [class*="headerText"]');
        const avatar = element.querySelector('img[class*="avatar"]') as HTMLImageElement | null;
        const time = element.querySelector("time") as HTMLTimeElement | null;
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
          author: authorNode?.textContent?.trim() || "Unknown Discord user",
          avatarUrl: avatar?.src,
          content,
          timestamp: time?.dateTime || time?.getAttribute("datetime") || new Date().toISOString(),
          edited: /edited/i.test(element.textContent || ""),
          attachments: attachmentLinks,
          reactions,
        };
      }),
    );

    const unique = new Map<string, Message>();
    for (const raw of rawMessages) {
      if (!raw.id) continue;
      unique.set(raw.id, {
        id: this.messageId(raw.id),
        provider: "discord",
        providerMessageId: raw.id,
        conversationId,
        author: { displayName: raw.author, avatarUrl: raw.avatarUrl },
        content: raw.content,
        sentAt: raw.timestamp,
        edited: raw.edited,
        attachments: raw.attachments,
        reactions: raw.reactions,
      });
    }
    return [...unique.values()].slice(-limit);
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.pollWatchedConversations(), this.options.pollIntervalMs);
    this.pollTimer.unref();
  }

  private async pollWatchedConversations(): Promise<void> {
    if (this.pollInProgress || this.watchedConversations.size === 0 || this.state.state !== "connected") return;
    this.pollInProgress = true;
    try {
      for (const conversationId of this.watchedConversations) {
        await this.lock.run(async () => {
          const messages = await this.readMessages(this.connectedPage(), conversationId, 50);
          const known = this.knownMessageIds.get(conversationId) ?? new Set<string>();
          for (const message of messages) {
            if (!known.has(message.id)) this.emitEvent("message.created", message);
            known.add(message.id);
          }
          this.knownMessageIds.set(conversationId, known);
        });
      }
    } catch (error) {
      this.setStatus("error", errorMessage(error));
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

  private messageId(providerId: string): string {
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

function cleanLabel(label: string): string {
  return label
    .replace(/,?\s*\d+\s+members?\b/gi, "")
    .replace(/,?\s*(unread|selected)$/gi, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
