import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VeeamHttpService, VeeamReachability } from './veeam/veeam-http.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly veeam: VeeamHttpService) {}

  /**
   * Unauthenticated probe, asking the transport the same question the monitor
   * asks every cycle. It used to ask it in its own words — the same path, the
   * same try/catch, a separately maintained result shape — so "what counts as
   * reachable" had two definitions that could answer differently.
   */
  @Get()
  @ApiOperation({
    summary: 'Отвечает ли Veeam',
    description:
      'Без аутентификации: /api/v1/serverTime не требует токена, поэтому это самый' +
      ' дешёвый способ отличить «сервер лежит» от «наши учётные данные не подходят».\n\n' +
      'Всегда 200. `status: degraded` означает, что не отвечает Veeam, а не этот' +
      ' сервис — проба контейнера не должна перезапускать монитор именно тогда,' +
      ' когда он нужнее всего.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        veeam: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string', example: 'https://veeam.example:9419' },
            reachable: { type: 'boolean' },
            serverTime: { type: 'string', example: '2026-09-16T11:00:00+05:00' },
            error: { type: 'string', example: 'connect ETIMEDOUT 10.0.0.1:9419' },
          },
        },
      },
    },
  })
  async check(): Promise<{
    status: 'ok' | 'degraded';
    veeam: { baseUrl: string } & VeeamReachability;
  }> {
    const reachability = await this.veeam.reachability();
    return {
      status: reachability.reachable ? 'ok' : 'degraded',
      veeam: { baseUrl: this.veeam.baseUrl, ...reachability },
    };
  }
}
