/**
 * Reorders a conversation cache to match the order in which the provider
 * exposed the conversations in its UI. Cached conversations that were not
 * present in the latest DOM snapshot remain at the end in their prior order.
 */
export function applyProviderConversationOrder<T>(
  conversations: Map<string, T>,
  providerOrderedIds: Iterable<string>,
): void {
  const reordered = new Map<string, T>();

  for (const id of providerOrderedIds) {
    const conversation = conversations.get(id);
    if (conversation !== undefined) reordered.set(id, conversation);
  }

  for (const [id, conversation] of conversations) {
    if (!reordered.has(id)) reordered.set(id, conversation);
  }

  conversations.clear();
  for (const [id, conversation] of reordered) conversations.set(id, conversation);
}
