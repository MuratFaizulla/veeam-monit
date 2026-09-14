import { Controller, Get } from '@nestjs/common';
import { VeeamHttpService } from './veeam/veeam-http.service';

@Controller('health')
export class HealthController {
  constructor(private readonly veeam: VeeamHttpService) {}

  /**
   * Unauthenticated probe. `/api/v1/serverTime` needs no token, which makes it
   * the cheapest way to tell whether the backup server is reachable at all.
   */
  @Get()
  async check(): Promise<{
    status: 'ok' | 'degraded';
    veeam: { baseUrl: string; reachable: boolean; serverTime?: string; error?: string };
  }> {
    try {
      const result = await this.veeam.request<{ serverTime?: string }>({
        method: 'GET',
        path: '/api/v1/serverTime',
      });
      return {
        status: 'ok',
        veeam: {
          baseUrl: this.veeam.baseUrl,
          reachable: true,
          serverTime: result?.serverTime,
        },
      };
    } catch (error) {
      return {
        status: 'degraded',
        veeam: { baseUrl: this.veeam.baseUrl, reachable: false, error: (error as Error).message },
      };
    }
  }
}
