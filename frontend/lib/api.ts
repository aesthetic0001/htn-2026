import { Platform } from 'react-native';

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProviderStatus {
  name: 'discord';
  state: ProviderState;
  detail?: string;
}

export interface Conversation {
  id: string;
  provider: 'discord';
  providerConversationId: string;
  title: string;
  kind: 'direct' | 'group';
  avatarUrl?: string;
  unread: boolean;
}

export interface Participant {
  id?: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Attachment {
  name: string;
  url: string;
  contentType?: string;
}

export interface Message {
  id: string;
  provider: 'discord';
  providerMessageId: string;
  conversationId: string;
  author: Participant;
  content: string;
  sentAt: string;
  edited: boolean;
  attachments: Attachment[];
  reactions: Array<{ emoji: string; count?: number }>;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

const defaultApiUrl = Platform.OS === 'android'
  ? 'http://10.0.2.2:3001'
  : 'http://localhost:3001';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL?.trim() || defaultApiUrl).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError(
      `Cannot reach the Providence backend at ${API_URL}. Check that it is running and that EXPO_PUBLIC_API_URL points to this device-accessible address.`,
      0,
      'NETWORK_ERROR',
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new ApiError(
      body.error?.message || `Request failed with status ${response.status}`,
      response.status,
      body.error?.code,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  async listProviders() {
    return (await request<{ providers: ProviderStatus[] }>('/api/providers')).providers;
  },

  async connectDiscord() {
    return (await request<{ provider: ProviderStatus }>('/api/providers/discord/connect', {
      method: 'POST',
    })).provider;
  },

  async listConversations() {
    return (await request<{ conversations: Conversation[] }>('/api/conversations')).conversations;
  },

  async listMessages(conversationId: string, limit = 50) {
    const id = encodeURIComponent(conversationId);
    return (await request<{ messages: Message[] }>(`/api/conversations/${id}/messages?limit=${limit}`)).messages;
  },

  async sendMessage(conversationId: string, content: string) {
    const id = encodeURIComponent(conversationId);
    return (await request<{ message: Message }>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })).message;
  },

  async addReaction(conversationId: string, messageId: string, emoji: string) {
    const conversation = encodeURIComponent(conversationId);
    const message = encodeURIComponent(messageId);
    await request<void>(`/api/conversations/${conversation}/messages/${message}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
