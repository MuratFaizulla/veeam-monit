import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, VeeamEndpoint } from '../config/configuration';
import { VeeamEstateReader } from './estate-reader.service';
import { VeeamHttpService } from './http.service';
import { VeeamInventoryService } from './inventory.service';
import { VeeamMonitorAuthService } from './monitor-auth.service';

/**
 * One Veeam server, and everything it takes to read it.
 *
 * Each server has its own token, its own lesson about its refresh grant and its
 * own names behind ids, so each gets its own of all four. Nothing is shared
 * between two servers but the account they are signed in to with.
 */
export interface VeeamServer extends VeeamEndpoint {
  http: VeeamHttpService;
  auth: VeeamMonitorAuthService;
  reader: VeeamEstateReader;
  inventory: VeeamInventoryService;
}

/** A server wired from its configuration. */
export const serverOf = (veeam: AppConfig['veeam'], endpoint: VeeamEndpoint): VeeamServer => {
  const { apiVersion, insecureTls, timeoutMs } = veeam;
  const http = new VeeamHttpService({ apiVersion, insecureTls, timeoutMs, ...endpoint });
  const auth = new VeeamMonitorAuthService(veeam, http, endpoint.name);
  const reader = new VeeamEstateReader(http, auth);
  return { ...endpoint, http, auth, reader, inventory: new VeeamInventoryService(reader) };
};

/**
 * Every configured Veeam server, in the order people see them listed.
 *
 * What the rest of the service asks for instead of a reader: which server to
 * read is a decision the monitor makes each cycle, not one Nest can make once
 * at startup.
 */
@Injectable()
export class VeeamServers {
  readonly all: readonly VeeamServer[];

  constructor(config: ConfigService) {
    const veeam = config.getOrThrow<AppConfig['veeam']>('veeam');
    this.all = veeam.servers.map((endpoint) => serverOf(veeam, endpoint));
  }
}
