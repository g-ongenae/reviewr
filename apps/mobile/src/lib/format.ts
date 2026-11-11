export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const countWords = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;
