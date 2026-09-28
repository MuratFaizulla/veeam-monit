import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VeeamReachability } from '../veeam/http.service';
import { VeeamServers } from '../veeam/servers';

type ServerProbe = Pick<VeeamReachability, 'reachable' | 'serverTime'>;
type HealthResponse = {
  status: 'ok' | 'degraded';
  veeam: ServerProbe;
  servers: ServerProbe[];
};

const PROBE_CACHE_MS = 5_000;

const SERVER_SCHEMA = {
  type: 'object',
  properties: {
    reachable: { type: 'boolean' },
    serverTime: { type: 'string', example: '2026-09-16T11:00:00+05:00' },
  },
};

@ApiTags('health')
@Controller('health')
export class HealthController {
  private cached?: { until: number; value: Promise<HealthResponse> };

  constructor(private readonly servers: VeeamServers) {}

  /**
   * Unauthenticated probe, asking each server's transport the same question
   * the monitor asks every cycle. It used to ask it in its own words — the same
   * path, the same try/catch, a separately maintained result shape — so "what
   * counts as reachable" had two definitions that could answer differently.
   */
  @Get()
  @ApiOperation({
    summary: 'Отвечают ли серверы Veeam',
    description:
      'Без аутентификации: /api/v1/serverTime не требует токена, поэтому это самый' +
      ' дешёвый способ отличить «сервер лежит» от «наши учётные данные не подходят».\n\n' +
      'Всегда 200. `status: degraded` означает, что не отвечает хотя бы один Veeam, а не' +
      ' этот сервис — проба контейнера не должна перезапускать монитор именно тогда,' +
      ' когда он нужнее всего.\n\n' +
      '`veeam` — первый сервер из списка, как было до списка; `servers` — все.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        veeam: SERVER_SCHEMA,
        servers: { type: 'array', items: SERVER_SCHEMA },
      },
    },
  })
  check(): Promise<HealthResponse> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.value;
    const value = this.probe();
    this.cached = { until: Date.now() + PROBE_CACHE_MS, value };
    return value;
  }

  private async probe(): Promise<HealthResponse> {
    const servers = await Promise.all(
      this.servers.all.map(async ({ http }) => {
        const { reachable, serverTime } = await http.reachability();
        return { reachable, ...(serverTime ? { serverTime } : {}) };
      }),
    );
    return {
      status: servers.every((server) => server.reachable) ? 'ok' : 'degraded',
      veeam: servers[0],
      servers,
    };
  }
}
