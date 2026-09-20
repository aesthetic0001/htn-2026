import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { AsyncLock } from "./async-lock.js";
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
  path: string;
}

interface RawInstagramConversation {
  threadId: string;
  path: string;
  text: string;
  label: string;
  imageAlts: string[];
  avatarUrl?: string;
  unread: boolean;
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
const ROW_MESSAGE_SELECTOR = 'main [role="row"]';
const TEXT_MESSAGE_SELECTOR = 'main div[dir="auto"]';

export class InstagramProvider extends EventEmitter implements MessageProvider {
  readonly name = "instagram" as const;
  private context?: BrowserContext;
  private page?: Page;
  private state: ReturnType<MessageProvider["status"]> = { state: "disconnected" };
  private readonly lock = new AsyncLock();
  private readonly conversations = new Map<string, DiscoveredConversation>();
  private readonly watchedConversations = new Set<string>();
  private readonly knownMessageIds = new Map<string, Set<string>>();
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
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    this.setStatus("disconnected");
  }

  async listConversations(): Promise<Conversation[]> {
    return this.lock.run(async () => {
      await this.discoverConversations(this.connectedPage());
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
    if (new URL(page.url()).pathname !== "/direct/inbox/") {
      await page.goto(`${INSTAGRAM_ORIGIN}/direct/inbox/`, { waitUntil: "domcontentloaded" });
    }
    await page.locator(`${THREAD_LINK_SELECTOR}, ${THREAD_ROW_SELECTOR}`).first()
      .waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);

    const links: RawInstagramConversation[] = await page.locator(THREAD_LINK_SELECTOR).evaluateAll((anchors) =>
      anchors.flatMap((node) => {
        const anchor = node as HTMLAnchorElement;
        const path = new URL(anchor.href).pathname;
        const match = path.match(/^\/direct\/t\/([^/?#]+)\/?$/);
        if (!match?.[1]) return [];
        const imageAlts = [...anchor.querySelectorAll("img")]
          .map((image) => image.getAttribute("alt") || "")
          .filter(Boolean);
        const unread = /\bunread\b/i.test(anchor.getAttribute("aria-label") || "")
          || Boolean(anchor.querySelector('svg[aria-label*="unread" i], [aria-label*="new message" i]'));
        return [{
          threadId: match[1],
          path,
          text: (anchor as HTMLElement).innerText || anchor.textContent || "",
          label: anchor.getAttribute("aria-label") || "",
          imageAlts,
          avatarUrl: (anchor.querySelector("img") as HTMLImageElement | null)?.src,
          unread,
        }];
      }),
    );

    if (links.length === 0) {
      const rows = await this.findThreadRows(page);
      for (const row of rows) {
        const previousPath = new URL(page.url()).pathname;
        const rowLocator = page.locator(THREAD_ROW_SELECTOR).nth(row.index);
        await rowLocator.scrollIntoViewIfNeeded();
        await rowLocator.click();
        await page.waitForURL((url) =>
          url.pathname !== previousPath && /^\/direct\/t\/[^/?#]+\/?$/.test(url.pathname),
        { timeout: 20_000 });
        const path = new URL(page.url()).pathname;
        const match = path.match(/^\/direct\/t\/([^/?#]+)\/?$/);
        if (match?.[1]) links.push({ ...row, threadId: match[1], path });
      }
    }

    this.conversations.clear();
    for (const link of links) {
      const id = this.conversationId(link.threadId);
      const title = normalizeInstagramConversationTitle(link.text, link.label, link.imageAlts, link.threadId);
      this.conversations.set(id, {
        id,
        provider: "instagram",
        providerConversationId: link.threadId,
        title,
        kind: link.imageAlts.length > 1 || /\bgroup\b/i.test(link.label) ? "group" : "direct",
        ...(link.avatarUrl ? { avatarUrl: link.avatarUrl } : {}),
        unread: link.unread,
        path: link.path,
      });
    }
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
        return [{
          index,
          text,
          label,
          imageAlts: images.map((image) => image.getAttribute("alt") || "").filter(Boolean),
          ...(images[0]?.src ? { avatarUrl: images[0].src } : {}),
          unread: /\bunread\b/i.test(label)
            || Boolean(button.querySelector('svg[aria-label*="unread" i], [aria-label*="new message" i]')),
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

    if (new URL(page.url()).pathname !== conversation.path) {
      const link = page.locator(`a[href="${conversation.path}"]`).first();
      if (await link.isVisible().catch(() => false)) await link.click();
      else await page.goto(`${INSTAGRAM_ORIGIN}${conversation.path}`, { waitUntil: "domcontentloaded" });
    }
    await page.waitForURL((url) => url.pathname === conversation.path, { timeout: 20_000 });
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
      const fingerprint = JSON.stringify([
        conversationId,
        raw.author,
        raw.content,
        raw.timestamp,
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
        sentAt: normalizeTimestamp(raw.timestamp),
        edited: raw.edited,
        attachments: raw.attachments,
        reactions: raw.reactions,
      });
    }
    return messages.slice(-limit);
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
  const rowCount = idMessageCount === 0 ? await page.locator(ROW_MESSAGE_SELECTOR).count() : 0;
  const selector = idMessageCount > 0
    ? ID_MESSAGE_SELECTOR
    : rowCount > 0
      ? ROW_MESSAGE_SELECTOR
      : TEXT_MESSAGE_SELECTOR;
  return page.locator(selector).evaluateAll((nodes, options) => {
    const { title, selector: sourceSelector } = options;
    const main = document.querySelector("main")?.getBoundingClientRect();
    const ignoredText = /^(?:active (?:now|\d+[mhd] ago)|seen|sent|delivered|view profile|loading|message)$/i;
    const results: RawInstagramMessage[] = [];
    let lastIncomingAuthor = title;

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTimestamp(value: string | undefined): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}
