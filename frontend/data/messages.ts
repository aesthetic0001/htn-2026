import type { ConversationProvider, Participant } from '@/types/messaging';

export const currentUser: Participant = {
  id: 'me',
  displayName: 'You',
};

export const providerLabels: Record<ConversationProvider, string> = {
  discord: 'Discord',
  instagram: 'Instagram',
  merged: 'Merged profile',
};

export const providerColors: Record<ConversationProvider, string> = {
  discord: '#5865F2',
  instagram: '#C13584',
  merged: '#B44D32',
};
