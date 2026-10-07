/**
 * What the bot last said about one Veeam server: whether it answered, and
 * whether the monitor account signed in there.
 *
 * Kept in the state file, so a change is announced once whatever restarts in
 * between. It used to be kept by the monitor in memory: an outage the bot was
 * started into was never announced, though its recovery was, and a sign-in
 * that came back after a restart came back without a word.
 */
export interface ServerSeen {
  /** Absent until the server has been asked once. */
  reachable?: boolean;
  /** Absent until the account has tried to sign in once. */
  authenticated?: boolean;
}

/** One server's part of the state file, and a way to save it. */
export class ServerMemory {
  constructor(
    private readonly record: ServerSeen,
    private readonly save: () => void,
  ) {}

  get reachable(): boolean | undefined {
    return this.record.reachable;
  }

  get authenticated(): boolean | undefined {
    return this.record.authenticated;
  }

  remember(seen: ServerSeen): void {
    let changed = false;
    for (const key of ['reachable', 'authenticated'] as const) {
      const value = seen[key];
      if (value === undefined || this.record[key] === value) continue;
      this.record[key] = value;
      changed = true;
    }
    if (changed) this.save();
  }
}

/**
 * The servers' part of a state file, entry by entry: what this version would
 * not have written is left out and said, rather than failing the file — which
 * would cost the chats, topics and live messages beside it. Absent from files
 * written before it existed, and read as empty: every server is then seen for
 * the first time, which announces only a server that does not answer.
 */
export const serversFromFile = (value: unknown, warn: (message: string) => void): Record<string, ServerSeen> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warn('Telegram state field servers is invalid; what was said about the servers is forgotten');
    return {};
  }
  const servers: Record<string, ServerSeen> = {};
  for (const [server, entry] of Object.entries(value as Record<string, unknown>)) {
    const seen = entry as Record<string, unknown> | null;
    const valid =
      seen !== null &&
      typeof seen === 'object' &&
      !Array.isArray(seen) &&
      ['reachable', 'authenticated'].every((key) => seen[key] === undefined || typeof seen[key] === 'boolean');
    if (!valid) {
      warn(`Telegram state for server ${server} is invalid; what was said about it is forgotten`);
      continue;
    }
    servers[server] = {
      ...(seen.reachable === undefined ? {} : { reachable: seen.reachable as boolean }),
      ...(seen.authenticated === undefined ? {} : { authenticated: seen.authenticated as boolean }),
    };
  }
  return servers;
};
