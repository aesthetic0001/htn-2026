import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'providence.mutedConversationIds';

type Listener = (conversationIds: ReadonlySet<string>) => void;

let mutedConversationIds = new Set<string>();
let hydrationPromise: Promise<ReadonlySet<string>> | undefined;
const listeners = new Set<Listener>();

function notifyListeners() {
  listeners.forEach((listener) => listener(mutedConversationIds));
}

function parseStoredIds(value: string | null) {
  if (!value) return new Set<string>();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set<string>();
  }
}

export function getCachedMutedConversationIds(): ReadonlySet<string> {
  return mutedConversationIds;
}

export function getMutedConversationIds(): Promise<ReadonlySet<string>> {
  if (!hydrationPromise) {
    hydrationPromise = AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      mutedConversationIds = parseStoredIds(value);
      notifyListeners();
      return mutedConversationIds;
    });
  }

  return hydrationPromise;
}

export function subscribeToMutedConversations(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function setConversationMuted(conversationId: string, muted: boolean) {
  await getMutedConversationIds();
  const nextIds = new Set(mutedConversationIds);

  if (muted) {
    nextIds.add(conversationId);
  } else {
    nextIds.delete(conversationId);
  }

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...nextIds]));
  mutedConversationIds = nextIds;
  notifyListeners();
}
