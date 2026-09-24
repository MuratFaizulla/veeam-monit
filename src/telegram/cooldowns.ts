/**
 * Cooldowns: which reported conditions must not be reported again yet.
 *
 * Keyed by an event's `dedupeKey`; the value is the epoch ms after which the
 * same condition may be reported again.
 *
 * Holds a record owned by the state store and calls `save` after each change;
 * it knows nothing about files. A test hands it a plain object.
 */
export class Cooldowns {
  constructor(
    private readonly until: Record<string, number>,
    private readonly save: () => void,
  ) {}

  /**
   * True when the condition is still inside its cooldown window.
   *
   * Checking and arming are two operations on purpose. Arming on the way in
   * burns the window even when the message never reaches Telegram, which
   * silences the next stretch of a real outage.
   */
  isSuppressed(key: string | undefined): boolean {
    if (!key) return false;
    return (this.until[key] ?? 0) > Date.now();
  }

  /** Starts the cooldown window. Call after the report actually went out. */
  arm(key: string | undefined, cooldownMs: number | undefined): void {
    if (!key || !cooldownMs) return;
    const now = Date.now();
    this.until[key] = now + cooldownMs;
    for (const [existing, until] of Object.entries(this.until)) {
      if (until <= now) delete this.until[existing];
    }
    this.save();
  }

  /** Drops a cooldown so the next occurrence reports immediately. */
  clear(key: string): void {
    if (this.until[key] === undefined) return;
    delete this.until[key];
    this.save();
  }
}
