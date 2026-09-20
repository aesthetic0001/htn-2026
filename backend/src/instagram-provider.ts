import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { AsyncLock } from "./async-lock.js";
import {
  conversationNotificationChanged,
  extractInstagramConversationPreview,
  instagramConversationNotification,
} from "./conversation-notification.js";
import { applyProviderConversationOrder } from "./conversation-order.js";
import { ConversationReadTracker } from "./conversation-read-tracker.js";
import { AppError, errorMessage } from "./errors.js";
import type {
  Attachment,
  Conversation,
  Message,
  MessageProvider,
  ProvidenceEvent,
  SendMessageInput,
} from "./types.js";

interface InstagramProviderOptions {
  email: string;
  password: string;
  userDataDir: string;
  executablePath?: string;
  headless: boolean;
  pollIntervalMs: number;
}

interface DiscoveredConversation extends Conversation {
  path?: string;
}

interface RawInstagramConversation {
  threadId: string;
  path: string;
  text: string;
  label: string;
  imageAlts: string[];
  avatarUrl?: string;
  notificationCopy: string;
  hasUnreadIndicator: boolean;
}

interface InstagramThreadRow extends Omit<RawInstagramConversation, "threadId" | "path"> {
  index: number;
}

interface MessageDomReference {
  selector: string;
  index: number;
}

interface RawInstagramMessage {
  selector: string;
  index: number;
  providerId?: string;
  author: string;
  avatarUrl?: string;
  content: string;
  timestamp?: string;
  edited: boolean;
  attachments: Attachment[];
  reactions: Array<{ emoji: string; count?: number }>;
}

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const THREAD_LINK_SELECTOR = 'a[href^="/direct/t/"]';
const THREAD_ROW_SELECTOR = '[role="button"][tabindex="0"]';
const LOGIN_IDENTIFIER_SELECTOR = [
  'input[name="username"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
].join(", ");
const LOGIN_PASSWORD_SELECTOR = [
  'input[name="password"]',
  'input[name="pass"]',
  'input[autocomplete="current-password"]',
].join(", ");
const LOGIN_SUBMIT_SELECTOR = [
  '[role="button"][aria-label="Log In" i]',
  'button[type="submit"]',
  'input[type="submit"]',
].map((selector) => `${selector}:visible`).join(", ");
const ID_MESSAGE_SELECTOR = "main [data-message-id]";
const ARTICLE_MESSAGE_SELECTOR = 'main [role="article"]';
const ROW_MESSAGE_SELECTOR = 'main [role="row"]';
const TEXT_MESSAGE_SELECTOR = 'main div[dir="auto"]';

export class InstagramProvider extends EventEmitter implements MessageProvider {
  readonly name = "instagram" as const;
  private context?: BrowserContext;
  private page?: Page;
  private state: ReturnType<MessageProvider["status"]> = { state: "disconnected" };
  private readonly lock = new AsyncLock();
  private readonly conversations = new Map<string, DiscoveredConversation>();
  private readonly readTracker = new ConversationReadTracker();
  private conversationSnapshotInitialized = false;
  private readonly messageDomReferences = new Map<string, MessageDomReference>();
  private pollTimer?: NodeJS.Timeout;
  private pollInProgress = false;

  constructor(private readonly options: InstagramProviderOptions) {
    super();
  }

  status() {
    return { ...this.state };
  }

  async connect(): Promise<void> {
    if (this.state.state === "connected" || this.state.state === "connecting") return;
    this.setStatus("connecting", "Opening Instagram");

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
    this.conversationSnapshotInitialized = false;
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    this.setStatus("disconnected");
  }

  async listConversations(): Promise<Conversation[]> {
    return this.lock.run(async () => {
      await this.discoverConversations(this.connectedPage());
      return [...this.conversations.values()]
        .map(({ path: _path, ...conversation }) => conversation);
    });
  }

  async listMessages(conversationId: string, limit: number, acknowledge = false): Promise<Message[]> {
    return this.lock.run(async () => {
      const messages = await this.readMessages(this.connectedPage(), conversationId, limit);
      this.updateConversationFromMessages(conversationId, messages, acknowledge, true);
      return messages;
    });
  }

  async sendMessage(conversationId: string, input: SendMessageInput): Promise<Message> {
    return this.lock.run(async () => {
      const page = this.connectedPage();
      await this.openConversation(page, conversationId);
      const editor = page.locator(
        'textarea[placeholder*="message" i], [role="textbox"][contenteditable="true"]',
      ).last();
      await editor.waitFor({ state: "visible" });
      await editor.fill(input.content);
      await editor.press("Enter");

      await page.waitForTimeout(600);
      const messages = await this.scrapeVisibleMessages(page, conversationId, 100);
      const sent = [...messages].reverse().find(
        (message) => message.content === input.content && message.author.displayName === "You",
      ) ?? [...messages].reverse().find((message) => message.content === input.content);
      if (!sent) {
        throw new AppError(
          "Instagram accepted the send action, but the new message could not be read",
          502,
          "INSTAGRAM_READ_FAILED",
        );
      }
      this.emitEvent("message.created", sent);
      return sent;
    });
  }

  async addReaction(conversationId: string, messageId: string, emoji: string): Promise<void> {
    await this.lock.run(async () => {
      this.parseMessageId(messageId);
      const page = this.connectedPage();
      await this.openConversation(page, conversationId);
      if (!this.messageDomReferences.has(messageId)) {
        await this.scrapeVisibleMessages(page, conversationId, 100);
      }
      const reference = this.messageDomReferences.get(messageId);
      if (!reference) throw new AppError("Message is not currently visible in Instagram", 404, "MESSAGE_NOT_FOUND");

      const message = page.locator(reference.selector).nth(reference.index);
      if (!(await message.isVisible().catch(() => false))) {
        throw new AppError("Message is not currently visible in Instagram", 404, "MESSAGE_NOT_FOUND");
      }
      await message.hover();
      const reactionButton = page.getByRole("button", { name: /react|add reaction/i }).last();
      if (await reactionButton.isVisible().catch(() => false)) {
        await reactionButton.click();
        const picker = page.locator('[role="dialog"]').last();
        const emojiButton = picker.getByRole("button", { name: new RegExp(escapeRegExp(emoji), "i") }).first();
        if (await emojiButton.isVisible().catch(() => false)) {
          await emojiButton.click();
          return;
        }
        const exactEmoji = picker.getByText(emoji, { exact: true }).first();
        if (await exactEmoji.isVisible().catch(() => false)) {
          await exactEmoji.click();
          return;
        }
      }

      if (emoji === "❤" || emoji === "❤️") {
        await message.dblclick();
        return;
      }
      throw new AppError("Instagram's reaction picker did not offer that emoji", 422, "REACTION_NOT_AVAILABLE");
    });
  }

  private async ensureAuthenticated(page: Page): Promise<void> {
    await page.goto(`${INSTAGRAM_ORIGIN}/direct/inbox/`, { waitUntil: "domcontentloaded" });
    await this.dismissCookiePrompt(page);

    const loginIdentifier = page.locator(LOGIN_IDENTIFIER_SELECTOR).first();
    if (!new URL(page.url()).pathname.startsWith("/direct/")) {
      await loginIdentifier.or(page.locator(THREAD_LINK_SELECTOR)).first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => undefined);
    }

    if (await loginIdentifier.isVisible().catch(() => false)) {
      await loginIdentifier.fill(this.options.email);
      await page.locator(LOGIN_PASSWORD_SELECTOR).first().fill(this.options.password);
      await page.locator(LOGIN_SUBMIT_SELECTOR).first().click();
      const loginOutcome = await waitForInstagramLoginOutcome(page, 120_000);
      if (loginOutcome !== "authenticated") {
        throw new AppError(
          loginOutcome === "verification"
            ? "Instagram requires interactive verification. Complete it in the opened browser, then reconnect."
            : loginOutcome === "invalid-credentials"
              ? "Instagram rejected INSTAGRAM_EMAIL or INSTAGRAM_PASSWORD. Update the backend credentials and reconnect."
              : "Instagram login did not complete. Check the credentials and the opened browser.",
          503,
          "INSTAGRAM_LOGIN_FAILED",
        );
      }
    }

    await this.dismissPostLoginPrompts(page);
    if (!new URL(page.url()).pathname.startsWith("/direct")) {
      await page.goto(`${INSTAGRAM_ORIGIN}/direct/inbox/`, { waitUntil: "domcontentloaded" });
    }
    await page.waitForURL(/instagram\.com\/direct\//, { timeout: 60_000 }).catch(() => {
      throw new AppError("Instagram messaging did not load", 503, "INSTAGRAM_LOAD_FAILED");
    });
    await page.waitForTimeout(700);
  }

  private async dismissCookiePrompt(page: Page): Promise<void> {
    const button = page.getByRole("button", { name: /allow all cookies|decline optional cookies/i }).first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }

  private async dismissPostLoginPrompts(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const notNow = page.getByRole("button", { name: /not now/i }).first();
      if (!(await notNow.isVisible().catch(() => false))) break;
      await notNow.click();
      await page.waitForTimeout(250);
    }
  }

  private async discoverConversations(page: Page): Promise<void> {
    const startingPath = new URL(page.url()).pathname;
    if (!startingPath.startsWith("/direct/")) {
      await page.goto(`${INSTAGRAM_ORIGIN}/direct/inbox/`, { waitUntil: "domcontentloaded" });
    }
    await page.locator(`${THREAD_LINK_SELECTOR}, ${THREAD_ROW_SELECTOR}`).first()
      .waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);

    const links = await this.findThreadLinks(page);

    if (links.length > 0) {
      this.applyDiscoveredConversations(links, false);
    } else {
      this.applyThreadRows(await this.findThreadRows(page), false);
    }
  }

  private async findThreadLinks(page: Page): Promise<RawInstagramConversation[]> {
    return page.locator(THREAD_LINK_SELECTOR).evaluateAll((anchors) =>
      anchors.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const path = new URL(anchor.href).pathname;
        const match = path.match(/^\/direct\/t\/([^/?#]+)\/?$/);
        if (!match?.[1]) return [];
        const imageAlts = [...anchor.querySelectorAll("img")]
          .map((image) => image.getAttribute("alt") || "")
          .filter(Boolean);
        const row = anchor.closest('[role="listitem"], [role="button"], li') || anchor;
        const notificationCopy = `${anchor.getAttribute("aria-label") || ""} ${row.getAttribute("aria-label") || ""}`;
        const hasAccessibleIndicator = Boolean(row.querySelector([
          '[aria-label*="unread" i]',
          '[aria-label*="new message" i]',
          '[aria-label*="notification" i]',
        ].join(", ")));
        const hasVisualBubble = [...row.querySelectorAll("div, span")].some((candidate) => {
          const element = candidate as HTMLElement;
          const rect = element.getBoundingClientRect();
          if (rect.width < 4 || rect.width > 24 || rect.height < 4 || rect.height > 24
            || Math.abs(rect.width - rect.height) > 3) return false;
          const color = getComputedStyle(element).backgroundColor;
          const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
          if (!channels || channels.length < 3) return false;
          const [red = 0, green = 0, blue = 0] = channels;
          return blue >= 180 && blue > red + 50 && blue > green + 30;
        });
        return [{
          threadId: match[1],
          path,
          text: (anchor as HTMLElement).innerText || anchor.textContent || "",
          label: anchor.getAttribute("aria-label") || "",
          imageAlts,
          avatarUrl: (anchor.querySelector("img") as HTMLImageElement | null)?.src,
          notificationCopy,
          hasUnreadIndicator: hasAccessibleIndicator || hasVisualBubble,
        }];
      }),
    );
  }

  private applyDiscoveredConversations(links: RawInstagramConversation[], emitChanges: boolean): void {
    const uniqueLinks = new Map<string, RawInstagramConversation>();
    const discoveredConversationIds: string[] = [];
    for (const link of links) {
      const existing = uniqueLinks.get(link.threadId);
      uniqueLinks.set(link.threadId, existing ? {
        ...existing,
        ...link,
        avatarUrl: link.avatarUrl || existing.avatarUrl,
        notificationCopy: `${existing.notificationCopy} ${link.notificationCopy}`,
        hasUnreadIndicator: existing.hasUnreadIndicator || link.hasUnreadIndicator,
      } : link);
    }

    for (const link of uniqueLinks.values()) {
      const title = normalizeInstagramConversationTitle(link.text, link.label, link.imageAlts, link.threadId);
      const previous = this.conversations.get(this.conversationId(link.threadId))
        ?? [...this.conversations.values()].find((conversation) =>
          conversation.path === link.path
          || (link.avatarUrl && conversation.avatarUrl === link.avatarUrl && conversation.title === title));
      const id = previous?.id ?? this.conversationId(link.threadId);
      const preview = extractInstagramConversationPreview(link.text, title);
      const notificationState = instagramConversationNotification(
        link.text,
        link.notificationCopy,
        link.hasUnreadIndicator,
      );
      this.readTracker.observeNativeNotification(id, notificationState.notification, preview);
      const conversation = this.readTracker.apply<DiscoveredConversation>({
        id,
        provider: "instagram",
        providerConversationId: previous?.providerConversationId ?? link.threadId,
        title,
        kind: link.imageAlts.length > 1 || /\bgroup\b/i.test(link.label) ? "group" : "direct",
        ...(link.avatarUrl ? { avatarUrl: link.avatarUrl } : {}),
        ...(preview ? { preview } : {}),
        ...notificationState,
        path: link.path,
      });
      this.conversations.set(id, conversation);
      discoveredConversationIds.push(id);
      this.emitConversationChange(previous, conversation, emitChanges);
    }
    applyProviderConversationOrder(this.conversations, discoveredConversationIds);
    if (uniqueLinks.size > 0) this.conversationSnapshotInitialized = true;
  }

  private applyThreadRows(rows: InstagramThreadRow[], emitChanges: boolean): void {
    const discoveredConversationIds: string[] = [];
    for (const row of rows) {
      const title = normalizeInstagramConversationTitle(row.text, row.label, row.imageAlts, "");
      const previous = [...this.conversations.values()].find((conversation) =>
        (row.avatarUrl && conversation.avatarUrl === row.avatarUrl) || conversation.title === title);
      const rowProviderId = instagramThreadRowProviderId(title, row.avatarUrl, row.imageAlts);
      const preview = extractInstagramConversationPreview(row.text, title);
      const notificationState = instagramConversationNotification(
        row.text,
        row.notificationCopy,
        row.hasUnreadIndicator,
      );
      const conversationId = previous?.id ?? this.conversationId(rowProviderId);
      this.readTracker.observeNativeNotification(conversationId, notificationState.notification, preview);
      const conversation = this.readTracker.apply<DiscoveredConversation>({
        ...previous,
        id: conversationId,
        provider: "instagram",
        providerConversationId: previous?.providerConversationId ?? rowProviderId,
        title,
        kind: row.imageAlts.length > 1 || /\bgroup\b/i.test(row.label) ? "group" : "direct",
        ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
        ...(preview ? { preview } : {}),
        ...notificationState,
      });
      this.conversations.set(conversation.id, conversation);
      discoveredConversationIds.push(conversation.id);
      this.emitConversationChange(previous, conversation, emitChanges);
    }
    applyProviderConversationOrder(this.conversations, discoveredConversationIds);
    if (rows.length > 0 && this.conversations.size > 0) this.conversationSnapshotInitialized = true;
  }

  private emitConversationChange(
    previous: DiscoveredConversation | undefined,
    conversation: DiscoveredConversation,
    emitChanges: boolean,
  ): void {
    if (!emitChanges || !this.conversationSnapshotInitialized
      || !conversationNotificationChanged(previous, conversation)) return;
    const { path: _path, ...publicConversation } = conversation;
    this.emitEvent("conversation.updated", publicConversation);
  }

  private async findThreadRows(page: Page): Promise<InstagramThreadRow[]> {
    return page.locator(THREAD_ROW_SELECTOR).evaluateAll((buttons) =>
      buttons.flatMap((node, index) => {
        const button = node as HTMLElement;
        const rect = button.getBoundingClientRect();
        const images = [...button.querySelectorAll("img")];
        const text = button.innerText || button.textContent || "";
        // The current inbox uses wide button rows instead of links. Exclude compact
        // controls such as the account menu, compose button, and Notes carousel.
        if (rect.width < 250 || rect.height < 48 || images.length === 0 || !text.trim()) return [];
        const label = button.getAttribute("aria-label") || "";
        const notificationCopy = `${label} ${button.getAttribute("title") || ""}`;
        const hasAccessibleIndicator = Boolean(button.querySelector([
          '[aria-label*="unread" i]',
          '[aria-label*="new message" i]',
          '[aria-label*="notification" i]',
        ].join(", ")));
        const hasVisualBubble = [...button.querySelectorAll("div, span")].some((candidate) => {
          const element = candidate as HTMLElement;
          const bubbleRect = element.getBoundingClientRect();
          if (bubbleRect.width < 4 || bubbleRect.width > 24 || bubbleRect.height < 4 || bubbleRect.height > 24
            || Math.abs(bubbleRect.width - bubbleRect.height) > 3) return false;
          const color = getComputedStyle(element).backgroundColor;
          const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
          if (!channels || channels.length < 3) return false;
          const [red = 0, green = 0, blue = 0] = channels;
          return blue >= 180 && blue > red + 50 && blue > green + 30;
        });
        return [{
          index,
          text,
          label,
          imageAlts: images.map((image) => image.getAttribute("alt") || "").filter(Boolean),
          ...(images[0]?.src ? { avatarUrl: images[0].src } : {}),
          notificationCopy,
          hasUnreadIndicator: hasAccessibleIndicator || hasVisualBubble,
        }];
      }),
    );
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
    if (!conversation) throw new AppError("Instagram conversation not found", 404, "CONVERSATION_NOT_FOUND");

    if (!conversation.path) {
      const rows = await this.findThreadRows(page);
      const row = rows.find((candidate) => {
        const title = normalizeInstagramConversationTitle(candidate.text, candidate.label, candidate.imageAlts, "");
        return (candidate.avatarUrl && candidate.avatarUrl === conversation?.avatarUrl) || title === conversation?.title;
      });
      if (!row) throw new AppError("Instagram conversation is not visible", 404, "CONVERSATION_NOT_FOUND");
      const previousPath = new URL(page.url()).pathname;
      const rowLocator = page.locator(THREAD_ROW_SELECTOR).nth(row.index);
      await rowLocator.scrollIntoViewIfNeeded();
      await rowLocator.click();
      await page.waitForURL((url) =>
        url.pathname !== previousPath && /^\/direct\/t\/[^/?#]+\/?$/.test(url.pathname),
      { timeout: 20_000 });
      conversation = { ...conversation, path: new URL(page.url()).pathname };
      this.conversations.set(conversationId, conversation);
    } else if (new URL(page.url()).pathname !== conversation.path) {
      const link = page.locator(`a[href="${conversation.path}"]`).first();
      if (await link.isVisible().catch(() => false)) await link.click();
      else await page.goto(`${INSTAGRAM_ORIGIN}${conversation.path}`, { waitUntil: "domcontentloaded" });
    }
    const targetPath = conversation.path;
    await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
    await page.locator('textarea[placeholder*="message" i], [role="textbox"][contenteditable="true"]')
      .last().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
        throw new AppError("Instagram messages did not load", 502, "INSTAGRAM_READ_FAILED");
      });
  }

  private async scrapeVisibleMessages(page: Page, conversationId: string, limit: number): Promise<Message[]> {
    const conversation = this.conversations.get(conversationId);
    const rawMessages = await extractVisibleInstagramMessages(page, conversation?.title ?? "Instagram user");
    const duplicateOrdinals = new Map<string, number>();
    const messages: Message[] = [];

    for (const raw of rawMessages) {
      const sentAt = normalizeInstagramTimestamp(raw.timestamp);
      const fingerprint = JSON.stringify([
        conversationId,
        raw.author,
        raw.content,
        raw.attachments.map(({ name, contentType }) => [name, contentType]),
      ]);
      const ordinal = duplicateOrdinals.get(fingerprint) ?? 0;
      duplicateOrdinals.set(fingerprint, ordinal + 1);
      const stableSource = raw.providerId || `${fingerprint}:${ordinal}`;
      const providerMessageId = createHash("sha256").update(stableSource).digest("hex").slice(0, 24);
      const id = this.messageId(providerMessageId);
      this.messageDomReferences.set(id, { selector: raw.selector, index: raw.index });
      messages.push({
        id,
        provider: "instagram",
        providerMessageId,
        conversationId,
        author: {
          ...(raw.author === "You" ? { id: "me" } : {}),
          displayName: raw.author,
          ...(raw.avatarUrl ? { avatarUrl: raw.avatarUrl } : {}),
        },
        content: raw.content,
        ...(sentAt ? { sentAt } : {}),
        edited: raw.edited,
        attachments: raw.attachments,
        reactions: raw.reactions,
      });
    }
    return messages.slice(-limit);
  }

  private updateConversationFromMessages(
    conversationId: string,
    messages: readonly Message[],
    acknowledge: boolean,
    emitChanges: boolean,
  ): void {
    this.readTracker.observeMessages(conversationId, messages);
    if (acknowledge) this.readTracker.acknowledge(conversationId);
    const previous = this.conversations.get(conversationId);
    if (!previous) return;

    const conversation = this.readTracker.apply(previous);
    this.conversations.set(conversationId, conversation);
    if (emitChanges && conversationNotificationChanged(previous, conversation)) {
      const { path: _path, ...publicConversation } = conversation;
      this.emitEvent("conversation.updated", publicConversation);
    }
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
        const currentPath = new URL(page.url()).pathname;
        if (!currentPath.startsWith("/direct/")) return;
        const links = await this.findThreadLinks(page);
        if (links.length > 0) this.applyDiscoveredConversations(links, true);
        else this.applyThreadRows(await this.findThreadRows(page), true);
        if (!/^\/direct\/t\/[^/?#]+\/?$/.test(currentPath)) return;
        const activeConversation = [...this.conversations.values()].find(
          (conversation) => conversation.path === currentPath,
        );
        if (!activeConversation) return;
        const messages = await this.scrapeVisibleMessages(page, activeConversation.id, 100);
        this.updateConversationFromMessages(activeConversation.id, messages, false, true);
      });
    } catch {
      // Native notification polling is best-effort and must not disconnect the provider.
    } finally {
      this.pollInProgress = false;
    }
  }

  private connectedPage(): Page {
    if (this.state.state !== "connected" || !this.page) {
      throw new AppError("Instagram is not connected", 503, "PROVIDER_NOT_CONNECTED");
    }
    return this.page;
  }

  private conversationId(providerId: string): string {
    return `instagram:${providerId}`;
  }

  private messageId(providerId: string): string {
    return `instagram:${providerId}`;
  }

  private parseMessageId(messageId: string): string {
    const match = messageId.match(/^instagram:([a-f0-9]{24})$/);
    if (!match?.[1]) throw new AppError("Invalid Instagram message id", 400, "INVALID_MESSAGE_ID");
    return match[1];
  }

  private setStatus(state: ReturnType<MessageProvider["status"]>["state"], detail?: string): void {
    this.state = { state, ...(detail ? { detail } : {}) };
    this.emitEvent("provider.status", this.status());
  }

  private emitEvent(type: ProvidenceEvent["type"], data: unknown): void {
    this.emit("event", {
      type,
      provider: "instagram",
      occurredAt: new Date().toISOString(),
      data,
    } satisfies ProvidenceEvent);
  }
}

type InstagramLoginOutcome = "authenticated" | "invalid-credentials" | "verification" | "pending";

async function waitForInstagramLoginOutcome(page: Page, timeoutMs: number): Promise<InstagramLoginOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visibleText = await page.locator("body").innerText().catch(() => "");
    const outcome = classifyInstagramLoginState(new URL(page.url()).pathname, visibleText);
    if (outcome !== "pending") return outcome;
    await page.waitForTimeout(250);
  }
  return "pending";
}

export function classifyInstagramLoginState(pathname: string, visibleText: string): InstagramLoginOutcome {
  if (pathname.startsWith("/direct/") || pathname.startsWith("/accounts/onetap")) {
    return "authenticated";
  }
  if (/security code|two-factor|suspicious login|confirm it'?s you|challenge/i.test(visibleText)) {
    return "verification";
  }
  if (
    /login information you entered is incorrect|incorrect password|password you entered is incorrect|couldn'?t log in/i
      .test(visibleText)
  ) {
    return "invalid-credentials";
  }
  return "pending";
}

async function extractVisibleInstagramMessages(page: Page, conversationTitle: string): Promise<RawInstagramMessage[]> {
  const idMessageCount = await page.locator(ID_MESSAGE_SELECTOR).count();
  const articleMessageCount = idMessageCount === 0 ? await page.locator(ARTICLE_MESSAGE_SELECTOR).count() : 0;
  const rowCount = idMessageCount === 0 && articleMessageCount === 0
    ? await page.locator(ROW_MESSAGE_SELECTOR).count()
    : 0;
  const selector = idMessageCount > 0
    ? ID_MESSAGE_SELECTOR
    : articleMessageCount > 0
      ? ARTICLE_MESSAGE_SELECTOR
      : rowCount > 0
        ? ROW_MESSAGE_SELECTOR
        : TEXT_MESSAGE_SELECTOR;
  return page.locator(selector).evaluateAll((nodes, options) => {
    const { title, selector: sourceSelector } = options;
    const main = document.querySelector("main")?.getBoundingClientRect();
    const ignoredText = /^(?:active (?:now|\d+[mhd] ago)|seen|sent|delivered|view profile|loading|message)$/i;
    const clockAtEnd = /(?:^|[\s,])\d{1,2}:\d{2}(?:\s*[AP]\.?M\.?)?$/i;
    const results: RawInstagramMessage[] = [];
    const messageElements = new Set(nodes as HTMLElement[]);
    const timestampLabels = new Map<HTMLElement, string>();
    let currentTimestampLabel: string | undefined;
    let lastIncomingAuthor = title;

    // Instagram renders a timestamp separator before each message group. It is a
    // sibling of the message articles, not a descendant, so capture the active
    // separator while walking the thread once in document order.
    for (const candidate of document.querySelectorAll("main *")) {
      const element = candidate as HTMLElement;
      if (messageElements.has(element)) timestampLabels.set(element, currentTimestampLabel ?? "");
      if (
        element.tagName === "SPAN"
        && element.getAttribute("dir") === "auto"
        && element.children.length === 0
        && !element.closest('[data-message-id], [role="article"], [role="row"]')
      ) {
        const value = (element.innerText || element.textContent || "").trim();
        if (clockAtEnd.test(value)) currentTimestampLabel = value;
      }
    }

    nodes.forEach((node, index) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      if (
        rect.width === 0
        || rect.height === 0
        || element.closest('a[href^="/direct/t/"]')
        || element.closest('[contenteditable="true"]')
      ) return;
      const elementText = (element.innerText || element.textContent || "").trim();
      const profileImage = element.querySelector('img[alt*="profile picture" i]') as HTMLImageElement | null;
      const profileName = profileImage?.alt.replace(/'?s profile picture.*$/i, "").trim();
      const leafTextElements = [...element.querySelectorAll('div[dir="auto"]')]
        .filter((candidate) => !candidate.querySelector('div[dir="auto"]')) as HTMLElement[];
      const bodyElement = element.matches('div[dir="auto"]')
        ? element
        : leafTextElements.find((candidate) => {
          const value = (candidate.innerText || candidate.textContent || "").trim();
          return value
            && value !== title
            && value !== profileName
            && !/^(?:edited|seen|sent|delivered)$/i.test(value);
        });
      const content = (bodyElement?.innerText || bodyElement?.textContent || elementText)
        .trim()
        .replace(/\n?edited$/i, "")
        .trim();
      const media = [...element.querySelectorAll("img, video, audio")];
      if ((!content || ignoredText.test(content)) && media.length === 0) return;
      if (sourceSelector.includes('div[dir="auto"]') && element.querySelector('div[dir="auto"]')) return;
      if (content === title || /^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(content)) return;

      const messageRect = bodyElement?.getBoundingClientRect()
        || media.find((item) => !/profile picture|emoji/i.test((item as HTMLImageElement).alt))?.getBoundingClientRect()
        || rect;
      const outgoing = main
        ? messageRect.left + messageRect.width / 2 > main.left + main.width / 2
        : false;
      if (!outgoing && profileName) lastIncomingAuthor = profileName;
      const timestamp = element.querySelector("time")?.getAttribute("datetime")
        || element.closest("[title]")?.getAttribute("title")
        || timestampLabels.get(element)
        || undefined;
      const attachments = media.flatMap((item, mediaIndex) => {
        const mediaElement = item as HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
        if (item.tagName === "IMG" && /profile picture|emoji/i.test((item as HTMLImageElement).alt)) return [];
        const url = "currentSrc" in mediaElement && mediaElement.currentSrc
          ? mediaElement.currentSrc
          : mediaElement.getAttribute("src") || "";
        if (!url) return [];
        const kind = item.tagName.toLowerCase();
        return [{
          name: (item as HTMLImageElement).alt || `instagram-${kind}-${mediaIndex + 1}`,
          url,
          contentType: kind === "img" ? "image/*" : `${kind}/*`,
        }];
      });
      const reactionLabels = [...element.querySelectorAll('[aria-label*="reaction" i], [aria-label*="reacted" i]')]
        .map((reaction) => reaction.querySelector("img")?.getAttribute("alt") || reaction.textContent?.trim() || "")
        .filter((reaction) => reaction && reaction.length <= 16);
      const reactionCounts = new Map<string, number>();
      for (const reaction of reactionLabels) reactionCounts.set(reaction, (reactionCounts.get(reaction) ?? 0) + 1);

      results.push({
        selector: sourceSelector,
        index,
        ...(element.dataset.messageId || element.id
          ? { providerId: element.dataset.messageId || element.id }
          : {}),
        author: outgoing ? "You" : lastIncomingAuthor,
        ...(profileImage?.src ? { avatarUrl: profileImage.src } : {}),
        content,
        ...(timestamp ? { timestamp } : {}),
        edited: /\bedited\b/i.test(elementText),
        attachments,
        reactions: [...reactionCounts].map(([emoji, count]) => ({ emoji, count })),
      });
    });
    return results;
  }, { title: conversationTitle, selector });
}

export function normalizeInstagramConversationTitle(
  text: string,
  ariaLabel: string,
  imageAlts: string[],
  fallback: string,
): string {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const textTitle = lines.find((line) =>
    !/^(?:active |you:|sent |new message|\d+[smhdw]$)/i.test(line)
    && !/^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(line),
  );
  const labelTitle = ariaLabel.replace(/,?\s*(?:unread|new message).*$/i, "").trim();
  const imageTitle = imageAlts[0]?.replace(/'?s profile picture.*$/i, "").trim();
  return textTitle || labelTitle || imageTitle || `Instagram ${fallback}`;
}

export function instagramThreadRowProviderId(
  title: string,
  avatarUrl: string | undefined,
  imageAlts: string[],
): string {
  let stableAvatarUrl = avatarUrl ?? "";
  if (avatarUrl) {
    try {
      const parsed = new URL(avatarUrl);
      stableAvatarUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      stableAvatarUrl = avatarUrl.split("?", 1)[0] ?? avatarUrl;
    }
  }
  const fingerprint = JSON.stringify([title, stableAvatarUrl, imageAlts]);
  return `row-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeInstagramTimestamp(
  value: string | undefined,
  referenceDate = new Date(),
): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\u00a0/g, " ").trim();
  const directlyParsed = Date.parse(normalized);
  if (Number.isFinite(directlyParsed) && /\b\d{4}\b/.test(normalized)) {
    return new Date(directlyParsed).toISOString();
  }

  const timeMatch = normalized.match(/(\d{1,2}):(\d{2})(?:\s*([AP])\.?M\.?)?$/i);
  if (!timeMatch) return undefined;
  let hour = Number.parseInt(timeMatch[1]!, 10);
  const minute = Number.parseInt(timeMatch[2]!, 10);
  const meridiem = timeMatch[3]?.toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour === 0 && meridiem) return undefined;
  if (meridiem) {
    hour %= 12;
    if (meridiem === "P") hour += 12;
  }

  const prefix = normalized.slice(0, timeMatch.index).replace(/[\s,]+$/g, "").trim();
  const result = new Date(referenceDate);
  result.setSeconds(0, 0);

  if (!prefix || /^today$/i.test(prefix)) {
    result.setHours(hour, minute, 0, 0);
    return result.toISOString();
  }
  if (/^yesterday$/i.test(prefix)) {
    result.setDate(result.getDate() - 1);
    result.setHours(hour, minute, 0, 0);
    return result.toISOString();
  }

  const weekday = prefix.match(/^(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/i);
  if (weekday) {
    const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const targetDay = names.indexOf(weekday[1]!.slice(0, 3).toLowerCase());
    result.setDate(result.getDate() - (result.getDay() - targetDay + 7) % 7);
    result.setHours(hour, minute, 0, 0);
    if (result.getTime() > referenceDate.getTime()) result.setDate(result.getDate() - 7);
    return result.toISOString();
  }

  const dateOnly = Date.parse(/\b\d{4}\b/.test(prefix)
    ? prefix
    : `${prefix}, ${referenceDate.getFullYear()}`);
  if (!Number.isFinite(dateOnly)) return undefined;
  result.setTime(dateOnly);
  result.setHours(hour, minute, 0, 0);
  if (!/\b\d{4}\b/.test(prefix) && result.getTime() > referenceDate.getTime()) {
    result.setFullYear(result.getFullYear() - 1);
  }
  return result.toISOString();
}
