import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VeeamServer, VeeamServers } from '../veeam/servers';
import { BackupEvidenceService } from './backup-evidence.service';
import { JobQueryService } from './job-query.service';

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
  const jobs = new JobQueryService(config, server.reader, server.auth, evidence, server.inventory);
  return { ...server, evidence, jobs };
};
