import { Logger } from '@nestjs/common';
import { VeeamApiError } from '../veeam/api.error';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { SessionOutcomes } from './evidence';

/** Failed sessions whose machine outcomes are read at once. */
const READS_AT_ONCE = 5;

/**
 * How each machine of a failed session ended, for the sessions the Evidence
 * still needs, each read once: a finished session's outcomes never change.
 *
 * A reading asks for every failed session that wrote a point still on disk,
 * reaching back as far as the points do: 373 of them on the busiest server
 * on 30 September. Read on every scan, that would be the same answers every
 * time; read once each, a scan costs only the sessions that failed since the
 * one before.
 *
 * One per server, like the Evidence it serves.
 */
export class MachineOutcomes {
  private readonly logger: Logger;
  private readonly known = new Map<string, ReadonlyMap<string, string>>();

  constructor(
    private readonly reader: Pick<VeeamEstateReader, 'machineOutcomes'>,
    server = '',
  ) {
    this.logger = new Logger(`${MachineOutcomes.name}${server ? ` ${server}` : ''}`);
  }

  /**
   * How the machines of every session in `needed` ended, reading only those
   * not read before and forgetting those no point needs any more.
   *
   * A session that could not be read is left out, and its points stay
   * discarded — the verdict from before this was asked; it is asked again
   * next time. One Veeam no longer has (404) is remembered as having nothing
   * to say, so it is not asked again every scan. Never throws.
   */
  async learn(needed: ReadonlySet<string>): Promise<SessionOutcomes> {
    for (const id of this.known.keys()) if (!needed.has(id)) this.known.delete(id);
    const missing = [...needed].filter((id) => !this.known.has(id));
    let unread = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < missing.length) {
        const id = missing[next++];
        try {
          this.known.set(id, await this.reader.machineOutcomes(id));
        } catch (error) {
          unread += 1;
          if (error instanceof VeeamApiError && error.upstreamStatus === 404) this.known.set(id, new Map());
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, missing.length) }, () => worker()));
    if (unread > 0) {
      this.logger.warn(
        `Machine outcomes of ${unread} of ${missing.length} failed sessions not read; their points stay discarded`,
      );
    }
    return this.known;
  }
}
