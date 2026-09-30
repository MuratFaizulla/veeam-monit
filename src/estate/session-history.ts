import { Logger } from '@nestjs/common';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamSession } from '../veeam/types';

/**
 * How far before the previous read a partial one reaches back.
 *
 * A session still running at the last read is read again only if it began
 * inside this overlap, and that is how its result gets in once it finishes.
 * Runs last hours; one that runs for days is set right by the whole read.
 */
const OVERLAP_MS = 2 * 86_400_000;

/**
 * How often the whole history is read anyway. Veeam drops sessions older than
 * its history retention, and only a whole read sees them go.
 */
const WHOLE_EVERY_MS = 86_400_000;

type KeptSession = VeeamSession & { id: string };

/** Only what the Evidence reads: ten thousand sessions stay a few megabytes. */
const slim = (session: KeptSession): KeptSession => ({
  id: session.id,
  jobId: session.jobId,
  sessionType: session.sessionType,
  creationTime: session.creationTime,
  endTime: session.endTime,
  result: { result: session.result?.result },
});

/** A session without an id could never be brought up to date; Veeam gives every one an id. */
const keepable = (sessions: VeeamSession[]): KeptSession[] =>
  sessions.filter((session): session is KeptSession => Boolean(session.id));

/**
 * Every session one Veeam server keeps, kept current without reading it all.
 *
 * The Evidence needs all of them — a restore point from July is judged by the
 * run that wrote it — and on veeam01ast01 that was 9 800 sessions: twenty
 * pages of up to seven seconds each, the heaviest queries the bot sends, on
 * every scan, to learn about the hundred or so that had appeared since the
 * one before. Now the whole history is read on start and once a day; in
 * between, only the last couple of days are read, one page, and merged in by
 * id.
 *
 * One per server, like the Evidence it serves.
 */
export class SessionHistory {
  private readonly logger: Logger;
  private kept = new Map<string, KeptSession>();
  /** When the last read began, and when the last whole one did. */
  private readAt = 0;
  private wholeAt?: number;

  constructor(
    private readonly reader: VeeamEstateReader,
    server = '',
  ) {
    this.logger = new Logger(`${SessionHistory.name}${server ? ` ${server}` : ''}`);
  }

  /**
   * Every session, current as of this read, in no particular order.
   *
   * Throws when Veeam does not answer, and keeps what it had: the next read
   * then reaches back from the last one that worked, so nothing is skipped.
   */
  async read(): Promise<VeeamSession[]> {
    const startedAt = Date.now();
    if (this.wholeAt === undefined || startedAt - this.wholeAt >= WHOLE_EVERY_MS) {
      const all = await this.reader.sessions();
      this.kept = new Map(keepable(all).map((session) => [session.id, slim(session)]));
      this.wholeAt = startedAt;
      this.logger.log(`Read the whole session history: ${this.kept.size} sessions`);
    } else {
      const since = new Date(this.readAt - OVERLAP_MS);
      const recent = keepable(await this.reader.sessionsCreatedAfter(since));
      for (const session of recent) this.kept.set(session.id, slim(session));
      this.logger.log(
        `Read ${recent.length} sessions begun since ${since.toISOString()}; ${this.kept.size} in the history`,
      );
    }
    this.readAt = startedAt;
    return [...this.kept.values()];
  }
}
