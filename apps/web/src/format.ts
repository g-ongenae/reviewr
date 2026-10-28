const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));

export const displayTitle = (title: string): string => (title.trim().length > 0 ? title : 'Untitled');

export const countWords = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;
