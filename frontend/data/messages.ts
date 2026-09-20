import type { Participant, ProviderName } from '@/types/messaging';

export const currentUser: Participant = {
  id: 'me',
  displayName: 'You',
};

export const providerLabels: Record<ProviderName, string> = {
  discord: 'Discord',
  instagram: 'Instagram',
};

export const providerColors: Record<ProviderName, string> = {
  discord: '#5865F2',
  instagram: '#C13584',
};
