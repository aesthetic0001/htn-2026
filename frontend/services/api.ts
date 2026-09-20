import type { Conversation, Message, ProviderName, ProviderStatus, SendMessageInput } from '@/types/messaging';
import { Platform } from 'react-native';

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
const defaultApiUrl = Platform.OS === 'android' ? 'http://10.0.2.2:3001' : 'http://localhost:3001';

export const apiUrl = (configuredApiUrl || defaultApiUrl).replace(/\/$/, '');

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(`Cannot reach Providence at ${apiUrl}.`, 0, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new ApiError(
      body.error?.message || `Providence returned ${response.status}.`,
      response.status,
      body.error?.code,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function getProviders(): Promise<ProviderStatus[]> {
  const body = await request<{ providers: ProviderStatus[] }>('/api/providers');
  return body.providers;
}

export async function connectProvider(provider: ProviderName): Promise<ProviderStatus> {
  const body = await request<{ provider: ProviderStatus }>(`/api/providers/${provider}/connect`, {
    method: 'POST',
  });
  return body.provider;
}

export async function getConversations(): Promise<Conversation[]> {
  const body = await request<{ conversations: Conversation[] }>('/api/conversations');
  return body.conversations;
}

export async function getMessages(conversationId: string, limit = 100): Promise<Message[]> {
  const body = await request<{ messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
  );
  return body.messages.sort((left, right) =>
    new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime());
}

export async function sendMessage(
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  const body = await request<{ message: Message }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body.message;
}

export function addReaction(conversationId: string, messageId: string, emoji: string) {
  return request<void>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    },
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
