export const queryKeys = {
  health: ['health'] as const,
  documents: ['documents'] as const,
  document: (id: string) => ['documents', id] as const,
  revisions: (id: string) => ['documents', id, 'revisions'] as const,
  revision: (id: string, revision: number) => ['documents', id, 'revisions', revision] as const,
};
