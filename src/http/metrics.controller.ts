import { Controller, Get, Header, Headers, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { AppConfig } from '../config/configuration';
import { Monitor, MONITOR } from '../monitor/monitor';
import { metricsText, PROMETHEUS_TEXT } from './metrics';

/**
 * What the monitor read, for Prometheus to scrape and a Grafana to chart.
 *
 * Off until `METRICS_TOKEN` is set, and then only to a caller sending it as a
 * bearer token, which is how Prometheus authenticates a scrape. A 404 rather
 * than a 403 while it is off: there is nothing there to be refused.
 */
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  private readonly token: string;
  private readonly timezone: string;

  constructor(
    config: ConfigService,
    @Inject(MONITOR) private readonly monitor: Monitor,
  ) {
    this.token = config.getOrThrow<string>('metricsToken');
    this.timezone = config.getOrThrow<AppConfig['telegram']>('telegram').timezone;
  }

  @Get()
  @Header('Content-Type', PROMETHEUS_TEXT)
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('metricsToken')
  @ApiOperation({
    summary: 'Метрики для Prometheus',
    description:
      'То, что прочитал последний цикл монитора, в текстовом формате Prometheus: доступность серверов,' +
      ' результат и время запуска каждого задания, место на репозиториях, бэкап конфигурации.' +
      ' Сам Veeam при этом не опрашивается.\n\n' +
      'Выключено, пока не задан `METRICS_TOKEN`, и тогда отвечает 404. Включённое требует' +
      ' `Authorization: Bearer <METRICS_TOKEN>`.',
  })
  @ApiOkResponse({ content: { 'text/plain': { schema: { type: 'string', example: 'veeam_server_up{server="veeam01"} 1\n' } } } })
  @ApiUnauthorizedResponse({ description: 'Нет токена или не тот токен.' })
  @ApiNotFoundResponse({ description: 'METRICS_TOKEN не задан: метрики выключены.' })
  scrape(@Headers('authorization') authorization?: string): string {
    if (!this.token) throw new NotFoundException();
    if (!bearerOf(authorization, this.token)) throw new UnauthorizedException();
    return metricsText(this.monitor.readings(), this.monitor.status, this.timezone);
  }
}

/** Whether the header carries the token, compared without leaking a matching prefix in timing. */
const bearerOf = (header: string | undefined, token: string): boolean => {
  const given = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '')?.[1];
  if (!given) return false;
  const actual = Buffer.from(given);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
