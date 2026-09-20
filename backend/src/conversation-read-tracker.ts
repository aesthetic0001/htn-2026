import type { Conversation, ConversationNotification, Message } from "./types.js";

interface ConversationReadState {
  updateVersion: number;
  acknowledgedVersion: number;
  messagesInitialized: boolean;
  latestIncomingMessageId?: string;
  nativeNotificationSignature?: string;
  nativeNotification?: ConversationNotification;
  lastUpdatedAt?: string;
  lastAcknowledgedAt?: string;
}

export class ConversationReadTracker {
  private readonly states = new Map<string, ConversationReadState>();

  observeNativeNotification(
    conversationId: string,
    notification: ConversationNotification | undefined,
    preview?: string,
  ): boolean {
    const state = this.state(conversationId);
    const signature = notification ? JSON.stringify([notification, preview]) : undefined;
    state.nativeNotification = notification;

    if (!signature) {
      state.nativeNotificationSignature = undefined;
      return false;
    }
    if (signature === state.nativeNotificationSignature) return false;

    state.nativeNotificationSignature = signature;
    this.advanceUpdated(state);
    return true;
  }

  observeMessages(conversationId: string, messages: readonly Message[]): boolean {
    const state = this.state(conversationId);
    const latestIncoming = [...messages].reverse().find((message) => message.author.id !== "me");
    if (!latestIncoming) {
      state.messagesInitialized = true;
      return false;
    }

    if (!state.messagesInitialized) {
      state.messagesInitialized = true;
      state.latestIncomingMessageId = latestIncoming.id;
      if (latestIncoming.sentAt) state.lastUpdatedAt ??= latestIncoming.sentAt;
      return false;
    }
    if (latestIncoming.id === state.latestIncomingMessageId) return false;

    state.latestIncomingMessageId = latestIncoming.id;
    this.advanceUpdated(state);
    return true;
  }

  acknowledge(conversationId: string): boolean {
    const state = this.state(conversationId);
    const wasUnread = this.isUnread(state);
    state.lastUpdatedAt ??= new Date().toISOString();
    state.acknowledgedVersion = state.updateVersion;
    state.lastAcknowledgedAt = state.lastUpdatedAt;
    return wasUnread;
  }

  apply<T extends Conversation>(conversation: T): T {
    const state = this.state(conversation.id);
    const unread = this.isUnread(state);
    const {
      notification: _notification,
      lastUpdatedAt: _lastUpdatedAt,
      lastAcknowledgedAt: _lastAcknowledgedAt,
      ...base
    } = conversation;
    return {
      ...base,
      unread,
      ...(unread ? { notification: state.nativeNotification ?? { kind: "unread" as const } } : {}),
      ...(state.lastUpdatedAt ? { lastUpdatedAt: state.lastUpdatedAt } : {}),
      ...(state.lastAcknowledgedAt ? { lastAcknowledgedAt: state.lastAcknowledgedAt } : {}),
    } as T;
  }

  private state(conversationId: string): ConversationReadState {
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        updateVersion: 0,
        acknowledgedVersion: 0,
        messagesInitialized: false,
      };
      this.states.set(conversationId, state);
    }
    return state;
  }

  private advanceUpdated(state: ConversationReadState): void {
    state.updateVersion += 1;
    const now = Date.now();
    const previous = state.lastUpdatedAt ? Date.parse(state.lastUpdatedAt) : Number.NaN;
    state.lastUpdatedAt = new Date(Number.isFinite(previous) && previous >= now ? previous + 1 : now).toISOString();
  }

  private isUnread(state: ConversationReadState): boolean {
    return state.updateVersion > state.acknowledgedVersion;
  }
}
