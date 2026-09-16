import { Injectable, Logger } from '@nestjs/common';
import { allPages, VeeamReader } from './pages';
import { VeeamNamedResource } from './types';

/**
 * The names behind the ids a job points at.
 *
 * A job configuration says `backupRepositoryId: 60df9772-…` and
 * `proxyIds: []`, and neither is worth showing anybody. The names live in two
 * other collections, which change perhaps twice a year, so they are read once
 * and kept rather than fetched again for every question.
 *
 * Never throws and never blocks on a failure: a job card missing the name of
 * its repository is still a job card, and a card that could not be produced at
 * all because an inventory read timed out is not.
 */

const REPOSITORIES = '/api/v1/backupInfrastructure/repositories';
const PROXIES = '/api/v1/backupInfrastructure/proxies';

/** How long a reading stays good. Infrastructure is not what changes here. */
const TTL_MS = 30 * 60_000;

export interface VeeamInventory {
  repositories: ReadonlyMap<string, string>;
  proxies: ReadonlyMap<string, string>;
  /** Epoch ms of the reading; 0 when nothing has ever been read. */
  at: number;
}

const byId = (rows: VeeamNamedResource[]): Map<string, string> =>
  new Map(
    rows
      .filter((row): row is VeeamNamedResource & { id: string } => Boolean(row.id))
      .map((row) => [row.id, row.name ?? row.id]),
  );

@Injectable()
export class VeeamInventoryService {
  private readonly logger = new Logger(VeeamInventoryService.name);
  private cached: VeeamInventory = { repositories: new Map(), proxies: new Map(), at: 0 };

  async names(reader: VeeamReader): Promise<VeeamInventory> {
    if (Date.now() - this.cached.at < TTL_MS) return this.cached;
    try {
      const [repositories, proxies] = await Promise.all([
        allPages<VeeamNamedResource>(reader, REPOSITORIES),
        allPages<VeeamNamedResource>(reader, PROXIES),
      ]);
      this.cached = { repositories: byId(repositories), proxies: byId(proxies), at: Date.now() };
    } catch (error) {
      // Kept rather than cleared: last year's names are far closer to the truth
      // than an id, and the next caller will try the read again anyway.
      this.logger.warn(`Veeam inventory not refreshed: ${(error as Error).message}`);
    }
    return this.cached;
  }
}
