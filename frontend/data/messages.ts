import type { Conversation, Message, Participant, ProviderName } from '@/types/messaging';

export const currentUser: Participant = {
  id: 'me',
  displayName: 'You',
};

export const conversations: Conversation[] = [
  {
    id: 'nora',
    provider: 'instagram',
    providerConversationId: 'ig_10487',
    title: 'Nora Chen',
    kind: 'direct',
    unread: true,
  },
  {
    id: 'design-room',
    provider: 'discord',
    providerConversationId: 'dc_82601',
    title: 'design-room',
    kind: 'channel',
    guild: 'Side Projects',
    unread: true,
  },
  {
    id: 'weekend-plans',
    provider: 'messenger',
    providerConversationId: 'ms_12931',
    title: 'Weekend plans',
    kind: 'group',
    unread: false,
  },
  {
    id: 'maya',
    provider: 'slack',
    providerConversationId: 'sl_55380',
    title: 'Maya Patel',
    kind: 'direct',
    guild: 'Fieldwork',
    unread: false,
  },
  {
    id: 'book-club',
    provider: 'discord',
    providerConversationId: 'dc_99334',
    title: 'Book club',
    kind: 'group',
    guild: 'Friends',
    unread: false,
  },
];

export const messages: Message[] = [
  {
    id: 'n1',
    provider: 'instagram',
    providerMessageId: 'igm_1',
    conversationId: 'nora',
    author: { id: 'nora', displayName: 'Nora Chen' },
    content: 'The little coffee place on Adelaide was perfect. You were right ☕',
    sentAt: '2026-09-19T13:18:00.000Z',
    edited: false,
    attachments: [],
    reactions: [{ emoji: '🤎', count: 1 }],
  },
  {
    id: 'n2',
    provider: 'instagram',
    providerMessageId: 'igm_2',
    conversationId: 'nora',
    author: currentUser,
    content: 'Glad you liked it. Their cardamom bun is the real reason I go.',
    sentAt: '2026-09-19T13:24:00.000Z',
    edited: false,
    attachments: [],
    reactions: [],
  },
  {
    id: 'n3',
    provider: 'instagram',
    providerMessageId: 'igm_3',
    conversationId: 'nora',
    author: { id: 'nora', displayName: 'Nora Chen' },
    content: 'Okay, adding that to the list for next time.',
    sentAt: '2026-09-19T13:26:00.000Z',
    edited: false,
    attachments: [],
    reactions: [],
  },
  {
    id: 'd1',
    provider: 'discord',
    providerMessageId: 'dcm_1',
    conversationId: 'design-room',
    author: { id: 'eli', displayName: 'Eli' },
    content: 'Dropped the latest pass here. The quieter type scale feels much better.',
    sentAt: '2026-09-19T12:42:00.000Z',
    edited: true,
    attachments: [
      {
        name: 'inbox-exploration.fig',
        url: 'https://example.com/inbox-exploration.fig',
        contentType: 'application/octet-stream',
      },
    ],
    reactions: [
      { emoji: '✨', count: 4 },
      { emoji: '👍', count: 2 },
    ],
  },
  {
    id: 'w1',
    provider: 'messenger',
    providerMessageId: 'msm_1',
    conversationId: 'weekend-plans',
    author: { id: 'jo', displayName: 'Jo' },
    content: 'Saturday at 11 works for everyone. I booked the table.',
    sentAt: '2026-09-18T22:04:00.000Z',
    edited: false,
    attachments: [],
    reactions: [{ emoji: '🎉', count: 3 }],
  },
  {
    id: 'm1',
    provider: 'slack',
    providerMessageId: 'slm_1',
    conversationId: 'maya',
    author: { id: 'maya', displayName: 'Maya Patel' },
    content: 'The interview notes are cleaned up and ready whenever you are.',
    sentAt: '2026-09-18T19:16:00.000Z',
    edited: false,
    attachments: [],
    reactions: [],
  },
  {
    id: 'b1',
    provider: 'discord',
    providerMessageId: 'dcm_6',
    conversationId: 'book-club',
    author: { id: 'remy', displayName: 'Remy' },
    content: 'I vote we keep the next pick short and strange.',
    sentAt: '2026-09-17T21:10:00.000Z',
    edited: false,
    attachments: [],
    reactions: [{ emoji: '🫡', count: 2 }],
  },
];

export const providerLabels: Record<ProviderName, string> = {
  discord: 'Discord',
  instagram: 'Instagram',
  messenger: 'Messenger',
  slack: 'Slack',
};

export const providerColors: Record<ProviderName, string> = {
  discord: '#5865F2',
  instagram: '#C13584',
  messenger: '#168AFF',
  slack: '#2B7551',
};

export function getConversationMessages(conversationId: string) {
  return messages
    .filter((message) => message.conversationId === conversationId)
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
}

export function getLatestMessage(conversationId: string) {
  const conversationMessages = getConversationMessages(conversationId);
  return conversationMessages.at(-1);
}
