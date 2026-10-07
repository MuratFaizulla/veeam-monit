import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Job } from '../veeam/estate';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { Evidence, readingOf, ScannedEvidence } from './evidence';
import { MachineOutcomes } from './machine-outcomes';
import { SessionHistory } from './session-history';

/**
 * What one reading of the estate established, kept between readings.
 *
 * Two live slots — 🛡 Protection and 🧹 Orphaned backups — and /points are
 * questions about one body of facts: every restore point Veeam holds,
 * every session that wrote one, and every job configuration that says whether a
 * job was supposed to run at all. Reading that costs around twenty requests and
 * half a minute, so it happens on its own slow cadence and the answer is kept.
 *
 * It used to be kept as nine mutable fields on the monitor. Everything a reader
 * had to know — which fields it may read, that `scannedAt === 0` means "no
 * evidence yet", that the fields may be a cadence stale, and that the slot
 * rendering depth had to run *after* the slot that happened to trigger the scan
 * — was an interface as complicated as the scan itself, and most of it was
 * written in comments. This module has one interface instead: ask for the
 * evidence, and either it is there or it says why not.
 *
 * What a reading means is `readingOf` (evidence.ts). This decides when to
 * read, reads, and keeps what makes the next read cheaper: the sessions, once
 * the heaviest part of it, come from the SessionHistory, which reads only what
 * is new between whole reads, and a failed session's machine outcomes are read
 * once.
 */

/**
 * A reading this young is kept when its server is selected again. Switching
 * back and forth must not become a way of running the heaviest read there is
 * on demand.
 */
const JUST_READ_MS = 10 * 60_000;

const NOT_READ = 'Точки восстановления ещё не прочитаны.';
const NO_ANSWER = 'Veeam не ответил на этот цикл, поэтому точки не перечитывались.';

/** One per Veeam server, built by `ServerEstates`: a scan reads one server. */
export class BackupEvidenceService {
  private readonly logger: Logger;
  private readonly config: AppConfig['telegram'];
  /** The last scan that finished. Survives cycles Veeam did not answer. */
  private scanned?: ScannedEvidence;
  private current: Evidence = { status: 'pending', reason: NOT_READ };
  /** The next refresh reads again, whatever the cadence says. */
  private renewing = false;
  private readonly history: SessionHistory;
  private readonly outcomes: MachineOutcomes;

  constructor(
    config: ConfigService,
    private readonly reader: VeeamEstateReader,
    server = '',
  ) {
    this.logger = new Logger(`${BackupEvidenceService.name}${server ? ` ${server}` : ''}`);
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.history = new SessionHistory(reader, server);
    this.outcomes = new MachineOutcomes(reader, server);
  }

  /** What the readers answer from. Never throws, never blocks. */
  get evidence(): Evidence {
    return this.current;
  }

  /**
   * Has the next refresh read the estate again, ahead of the cadence.
   *
   * For a server that was just selected: only the selected server is scanned,
   * so a server selected again still holds the reading from when it was last
   * shown — up to a whole cadence old, which at two hours is not what somebody
   * who just pressed the button expects to see. A reading from the last few
   * minutes is kept.
   */
  renew(): void {
    if (Date.now() - (this.scanned?.scannedAt ?? 0) >= JUST_READ_MS) this.renewing = true;
  }

  /**
   * Brings the evidence up to date if it is older than the configured cadence,
   * or `renew` asked for it.
   *
   * Called once per cycle, before anything reads. That is what makes the order
   * the slots are published in mean nothing: it used to be that whichever slot
   * ran first paid for the scan, so rendering depth before protection silently
   * showed the previous cycle's numbers.
   *
   * Never throws: a scan that failed leaves the previous evidence in place, and
   * a cycle with nothing to read from says so rather than claiming an estate
   * with no restore points.
   */
  async refresh(authenticated: boolean, jobs: Job[] | undefined): Promise<void> {
    if (!authenticated || !jobs) {
      this.current = { status: 'pending', reason: NO_ANSWER };
      return;
    }
    if (this.renewing || Date.now() - (this.scanned?.scannedAt ?? 0) >= this.config.protectionIntervalMs) {
      const fresh = await this.scan(jobs);
      if (fresh) {
        this.scanned = fresh;
        this.renewing = false;
      }
    }
    this.current = this.scanned ?? { status: 'pending', reason: NOT_READ };
  }

  /** Reads the estate. Returns undefined when the read did not finish. */
  private async scan(jobs: Job[]): Promise<ScannedEvidence | undefined> {
    const startedAt = Date.now();
    try {
      const configurations = await this.reader.jobConfigurations();
      const backups = await this.reader.backups();
      const points = await this.reader.restorePoints();
      const sessions = await this.history.read();
      const reading = readingOf({ jobs, configurations, backups, points, sessions });
      const evidence = reading.evidence(await this.outcomes.learn(reading.failedSessions), Date.now());
      this.logger.log(
        `Evidence scan: ${points.length} restore points (${evidence.failedPoints} from failed machines,` +
          ` ${evidence.keptFromFailed} kept from failed runs), ${sessions.length} sessions,` +
          ` ${evidence.runsByJob.size} jobs, ${evidence.scannedAt - startedAt}ms`,
      );
      return evidence;
    } catch (error) {
      this.logger.error(`Evidence scan failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}
