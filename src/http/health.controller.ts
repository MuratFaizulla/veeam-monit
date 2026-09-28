import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VeeamReachability } from '../veeam/http.service';
import { VeeamServers } from '../veeam/servers';

type ServerProbe = { name: string; baseUrl: string } & VeeamReachability;

const SERVER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', example: 'veeam01ast01' },
    baseUrl: { type: 'string', example: 'https://veeam.example:9419' },
    reachable: { type: 'boolean' },
    serverTime: { type: 'string', example: '2026-09-16T11:00:00+05:00' },
    error: { type: 'string', example: 'connect ETIMEDOUT 10.0.0.1:9419' },
  },
};

@ApiTags('health')
@Controller('health')
export class HealthController {
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
  async check(): Promise<{
    status: 'ok' | 'degraded';
    veeam: ServerProbe;
    servers: ServerProbe[];
  }> {
    const servers = await Promise.all(
      this.servers.all.map(async ({ name, http }) => ({
        name,
        baseUrl: http.baseUrl,
        ...(await http.reachability()),
      })),
    );
    return {
      status: servers.every((server) => server.reachable) ? 'ok' : 'degraded',
      veeam: servers[0],
      servers,
    };
  }
}
