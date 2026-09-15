import { Controller, Get } from '@nestjs/common';
import { VeeamHttpService, VeeamReachability } from './veeam/veeam-http.service';

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
