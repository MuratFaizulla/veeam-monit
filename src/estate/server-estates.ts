import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
}

/** A server's estate, wired. */
export const estateOf = (config: ConfigService, server: VeeamServer): ServerEstate => {
  const evidence = new BackupEvidenceService(config, server.reader, server.name);
  const reads = new VeeamJobReads(server.reader);
  const jobs = new JobQueryService(config, server.reader, server.auth, evidence, server.inventory, reads);
  return { ...server, evidence, jobs, reads };
};
