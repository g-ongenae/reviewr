/** What a document title is displayed from: its title, and its creation date for the fallback name. */
export interface TitledDocument {
  /** Null (as the API sends it) or absent when the document has no title. */
  title?: string | null;
  /** ISO 8601 creation date of the document. */
  createdAt: string;
}

/** Options of {@link displayTitle}; tests set them, the apps use the defaults. */
export interface DisplayTitleOptions {
  /** IANA time zone the date is read in. Defaults to the device's. */
  timeZone?: string;
}

/**
 * Name to show for a document: its title, or "Untitled — 30 Oct" (from its creation date, in the
 * device's time zone) when it has none. A blank title counts as none. The date is always written
 * day first with an English month, like the rest of the interface, whatever the device's locale.
 */
export const displayTitle = ({ title, createdAt }: TitledDocument, options: DisplayTitleOptions = {}): string => {
  if (typeof title === 'string' && title.trim().length > 0) {
    return title;
  }
  const day: string = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: options.timeZone,
  }).format(new Date(createdAt));

  return `Untitled — ${day}`;
};

/**
 * Title to send to the API for the text typed in a title field: none (`undefined`, left out of the
 * request) when it is blank, so an emptied field makes the document untitled.
 */
export const titleToSend = (typed: string): string | undefined => (typed.trim().length > 0 ? typed : undefined);
