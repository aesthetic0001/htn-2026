export type ProviderName = "discord" | "instagram";

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

export interface Conversation {
  id: string;
  provider: ProviderName;
  providerConversationId: string;
  title: string;
  kind: "direct" | "group";
  avatarUrl?: string;
  unread: boolean;
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
  sentAt: string;
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
  listMessages(conversationId: string, limit: number): Promise<Message[]>;
  sendMessage(conversationId: string, input: SendMessageInput): Promise<Message>;
  addReaction(conversationId: string, messageId: string, emoji: string): Promise<void>;
}

export interface ProvidenceEvent {
  type: "provider.status" | "conversation.updated" | "message.created";
  provider: ProviderName;
  occurredAt: string;
  data: unknown;
}
