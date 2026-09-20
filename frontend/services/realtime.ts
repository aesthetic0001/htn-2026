import { fetch } from 'expo/fetch';

import { apiUrl } from '@/services/api';
import type { ProviderName } from '@/types/messaging';

export type RealtimeEventType = 'ready' | 'provider.status' | 'conversation.updated' | 'message.created' | 'message.deleted';

export interface RealtimeEvent {
  type: RealtimeEventType;
  provider?: ProviderName;
  occurredAt?: string;
  data: unknown;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export function subscribeToRealtimeEvents(onEvent: (event: RealtimeEvent) => void): () => void {
  let closed = false;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

  const connect = async () => {
    controller = new AbortController();
    try {
      const response = await fetch(`${apiUrl}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}`);

      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = dispatchCompleteEvents(buffer, onEvent);
      }
    } catch (error) {
      if (!closed && !(error instanceof Error && error.name === 'AbortError')) {
        // A snapshot is requested by the `ready` event after the reconnect succeeds.
      }
    } finally {
      controller = undefined;
      if (!closed) {
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimer = setTimeout(() => void connect(), delay);
      }
    }
  };

  void connect();
  return () => {
    closed = true;
    controller?.abort();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}

export function realtimeConversationId(event: RealtimeEvent): string | undefined {
  if (!event.data || typeof event.data !== 'object') return undefined;
  const data = event.data as { id?: unknown; conversationId?: unknown };
  if (typeof data.conversationId === 'string') return data.conversationId;
  return typeof data.id === 'string' ? data.id : undefined;
}

function dispatchCompleteEvents(
  buffer: string,
  onEvent: (event: RealtimeEvent) => void,
): string {
  let remaining = buffer;
  let boundary = remaining.match(/\r?\n\r?\n/);
  while (boundary?.index !== undefined) {
    const block = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary[0].length);
    dispatchEvent(block, onEvent);
    boundary = remaining.match(/\r?\n\r?\n/);
  }
  return remaining;
}

function dispatchEvent(block: string, onEvent: (event: RealtimeEvent) => void): void {
  let eventType: RealtimeEventType = 'message.created';
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event' && isRealtimeEventType(value)) eventType = value;
    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const event = parsed as Partial<RealtimeEvent>;
      onEvent({ ...event, type: eventType, data: eventType === 'ready' ? parsed : event.data });
    }
  } catch {
    // Ignore malformed events; reconnect snapshots prevent permanent state loss.
  }
}

function isRealtimeEventType(value: string): value is RealtimeEventType {
  return value === 'ready'
    || value === 'provider.status'
    || value === 'conversation.updated'
    || value === 'message.created'
    || value === 'message.deleted';
}
