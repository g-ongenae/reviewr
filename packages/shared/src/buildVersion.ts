/**
 * The version of the JavaScript being run: read from git when the bundle is built (Vite for the web, Metro for the
 * phone) and compiled into it as a string, so a client still running an old bundle shows the old version.
 */
export interface BuildVersion {
  /** Short hash of the commit built, or undefined when git could not tell. */
  commit?: string;
  /** Whether the checkout had uncommitted changes, so the bundle is not exactly that commit. */
  dirty: boolean;
  /** ISO 8601 date the bundle was built. */
  builtAt: string;
}

/** Runs `git` with these arguments in the checkout and returns what it prints; throws when git fails. */
export type RunGit = (args: string[]) => string;

/** Reads the version of the checkout being built; the commit is left out when git is missing or fails. */
export const readBuildVersion = (git: RunGit, now: Date = new Date()): BuildVersion => {
  const builtAt: string = now.toISOString();
  try {
    const commit: string = git(['rev-parse', '--short', 'HEAD']).trim();
    const dirty: boolean = git(['status', '--porcelain']).trim().length > 0;

    return commit.length > 0 ? { commit, dirty, builtAt } : { dirty: false, builtAt };
  } catch {
    return { dirty: false, builtAt };
  }
};

/** Options of {@link formatBuildVersion}; tests set them, the apps use the defaults. */
export interface FormatBuildVersionOptions {
  /** IANA time zone the build date is read in. Defaults to the device's. */
  timeZone?: string;
}

/** The version compiled into the bundle, or undefined when it holds none (or nothing readable). */
const parse = (compiled: string | undefined): BuildVersion | undefined => {
  try {
    const value: unknown = JSON.parse(compiled ?? '');
    if (typeof value !== 'object' || !value) {
      return undefined;
    }
    const { commit, dirty, builtAt } = value as Record<string, unknown>;
    if (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt))) {
      return undefined;
    }

    return { commit: typeof commit === 'string' ? commit : undefined, dirty: dirty === true, builtAt };
  } catch {
    return undefined;
  }
};

/**
 * The line telling which build is running, from the {@link BuildVersion} compiled into the bundle as JSON:
 * "eae0529 · 19 Nov 23:10", "eae0529+ · …" when built with uncommitted changes, "unknown · …" when git could not
 * tell the commit, and "unknown" when the bundle holds no version at all.
 */
export const formatBuildVersion = (compiled: string | undefined, options: FormatBuildVersionOptions = {}): string => {
  const version: BuildVersion | undefined = parse(compiled);
  if (version === undefined) {
    return 'unknown';
  }
  const builtAt: Date = new Date(version.builtAt);
  const day: string = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: options.timeZone,
  }).format(builtAt);
  const time: string = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: options.timeZone,
  }).format(builtAt);
  const commit: string = version.commit === undefined ? 'unknown' : `${version.commit}${version.dirty ? '+' : ''}`;

  return `${commit} · ${day} ${time}`;
};
