export type ProviderName = 'discord' | 'instagram';

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProviderStatus {
  name: ProviderName;
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
  kind: 'direct' | 'group';
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
