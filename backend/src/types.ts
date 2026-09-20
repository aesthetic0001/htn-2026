export type ProviderName = "discord" | "instagram";
export type ConversationProvider = ProviderName | "merged";

export type ProviderState = "disconnected" | "connecting" | "connected" | "error";

export interface ProviderStatus {
  state: ProviderState;
  detail?: string;
}

export interface Participant {
  id?: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ConversationNotification {
  kind: "unread" | "mention";
  count?: number;
}

export interface Conversation {
  id: string;
  provider: ConversationProvider;
  providerConversationId: string;
  title: string;
  kind: "direct" | "group";
  avatarUrl?: string;
  unread: boolean;
  preview?: string;
  notification?: ConversationNotification;
  lastUpdatedAt?: string;
  lastAcknowledgedAt?: string;
  sources?: ConversationSource[];
  sendConversationId?: string;
  sendRoute?: "override" | "most_frequent";
}

export interface ConversationSource {
  conversationId: string;
  provider: ProviderName;
  title: string;
  avatarUrl?: string;
}

export interface ProfileMerge {
  id: string;
  conversationIds: string[];
  displayName?: string;
  sendConversationId?: string;
  createdAt: string;
}

export interface Attachment {
  name: string;
  url: string;
  contentType?: string;
}

export interface Message {
  id: string;
  provider: ProviderName;
  providerMessageId: string;
  conversationId: string;
  author: Participant;
  content: string;
  sentAt?: string;
  edited: boolean;
  attachments: Attachment[];
  reactions: Array<{ emoji: string; count?: number }>;
}

export interface SendMessageInput {
  content: string;
}

export interface MessageProvider {
  readonly name: ProviderName;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): ProviderStatus;
  listConversations(): Promise<Conversation[]>;
  listMessages(conversationId: string, limit: number, acknowledge?: boolean): Promise<Message[]>;
  sendMessage(conversationId: string, input: SendMessageInput): Promise<Message>;
  addReaction(conversationId: string, messageId: string, emoji: string): Promise<void>;
}

export interface ProvidenceEvent {
  type: "provider.status" | "conversation.updated" | "message.created";
  provider: ProviderName;
  occurredAt: string;
  data: unknown;
}
