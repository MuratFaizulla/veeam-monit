import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { WorkingSessions, workingUnavailable } from '../veeam/estate';
import { VeeamServer, VeeamServers } from '../veeam/servers';
import { BackupEvidenceService } from './backup-evidence.service';
import { JobQueryService } from './job-query.service';
import { JobReads, VeeamJobReads } from './job-reads';

/**
 * One Veeam server with what the estate establishes about it: its Evidence and
 * the on-demand answers behind a Job card and the Summary.
 *
 * Evidence is a server's own, like its token: a scan reads one server, and two
 * servers' restore points in one Evidence would be two estates' facts
 * answering one question.
 */
export interface ServerEstate extends VeeamServer {
  evidence: BackupEvidenceService;
  jobs: JobQueryService;
  /** What its Job alerts and Job cards ask Veeam about one job. */
  reads: JobReads;
}

/** Every configured server's estate, in the order the servers are listed. */
@Injectable()
export class ServerEstates {
  readonly all: readonly ServerEstate[];

  constructor(config: ConfigService, servers: VeeamServers) {
    this.all = servers.all.map((server) => estateOf(config, server));
  }

  /**
   * The Selected server: the one `chosen`, or the first while nobody has
   * chosen one that is still listed. What the live slots show and what a
   * question without a Button is about, by this one rule: written twice, it
   * was two places to forget a server taken off the list.
   */
  selected(chosen: string | undefined): ServerEstate {
    return this.all.find(({ key }) => key === chosen) ?? this.all[0];
  }
}

/** A server's estate, wired. */
export const estateOf = (config: ConfigService, server: VeeamServer): ServerEstate => {
  const evidence = new BackupEvidenceService(config, server.reader, server.name);
  const reads = new VeeamJobReads(server.reader, config.getOrThrow<AppConfig['telegram']>('telegram').timezone);
  const jobs = new JobQueryService(config, server.reader, server.auth, evidence, server.inventory, reads);
  return { ...server, evidence, jobs, reads };
};

const logger = new Logger(ServerEstates.name);

/**
 * What `estate`'s Veeam is running right now, for a cycle or for the Summary
 * somebody asked for. Never throws.
 *
 * A failed read is an empty one with the reason, which is the safe direction:
 * a running count falls back to the job status alone and never invents a run,
 * and 📈 says why it has nothing to show.
 */
export const workingOn = async (estate: ServerEstate): Promise<WorkingSessions> => {
  try {
    return await estate.reader.workingSessions();
  } catch (error) {
    logger.warn(`${estate.name}: working sessions unavailable: ${(error as Error).message}`);
    return workingUnavailable((error as Error).message);
  }
};
