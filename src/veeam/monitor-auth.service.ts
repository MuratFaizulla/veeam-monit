import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from './http.service';
import { VeeamTokenResponse } from './types';

const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000;
/** Shortest gap between two logins forced by Veeam refusing a token. */
const REJECT_COOLDOWN_MS = 60_000;

@Injectable()
export class VeeamMonitorAuthService {
  private readonly logger = new Logger(VeeamMonitorAuthService.name);
  private readonly user: string;
  private readonly password: string;
  private accessToken = '';
  private refreshToken = '';
  private expiresAt = 0;
  private rejectedAt = 0;
  /** Whether the current access token came from the refresh grant. */
  private tokenCameFromRefresh = false;
  /** Cleared for good once this server has refused a refreshed token. */
  private refreshUsable = true;
  private pending?: Promise<string>;

  constructor(config: ConfigService, private readonly veeam: VeeamHttpService) {
    const account = config.getOrThrow<AppConfig['veeam']>('veeam');
    this.user = account.username;
    this.password = account.password;
  }

  get configured(): boolean {
    return Boolean(this.user && this.password);
  }

  /** Account name for alert text. The password never leaves this class. */
  get username(): string {
    return this.user;
  }

  async getAccessToken(): Promise<string> {
    if (!this.configured) throw new Error('VEEAM_MONITOR_USERNAME/PASSWORD are not configured');
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_SKEW_MS) return this.accessToken;
    if (this.pending) return this.pending;
    this.pending = this.authenticate().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Forces the next request to refresh after Veeam rejects the access token. */
  invalidateAccessToken(): void {
    this.accessToken = '';
    this.expiresAt = 0;
  }

  /**
   * Veeam refused this token. Says whether a fresh one is worth fetching.
   *
   * A burst of refusals is one event, not twenty: every call in a cycle carries
   * the same token, so the first refusal already told us everything and the
   * rest would each buy their own login. One per minute is enough to recover
   * quickly without turning a Veeam that refuses everything — a genuine
   * permission problem, say — into a login storm against it.
   */
  rejectToken(): boolean {
    const now = Date.now();
    if (now - this.rejectedAt < REJECT_COOLDOWN_MS) return false;
    this.rejectedAt = now;

    // The refusal is the refresh grant's doing on this server, so a second
    // refresh would hand us another refused token and nothing would change.
    // Learned rather than configured: where refreshing works it is never
    // switched off, and where it does not it is switched off once, for the life
    // of the process, by the only evidence that could establish it.
    if (this.tokenCameFromRefresh && this.refreshUsable) {
      this.refreshUsable = false;
      this.logger.warn(
        'Veeam refused a refreshed token; signing in with the password grant from now on',
      );
    }
    this.refreshToken = '';
    this.invalidateAccessToken();
    return true;
  }

  private async authenticate(): Promise<string> {
    const byRefresh = this.refreshUsable && Boolean(this.refreshToken);
    let token: VeeamTokenResponse;
    try {
      token = byRefresh
        ? await this.veeam.refresh(this.refreshToken)
        : await this.veeam.login(this.user, this.password);
    } catch (error) {
      if (!byRefresh) throw error;
      this.refreshToken = '';
      token = await this.veeam.login(this.user, this.password);
    }
    if (token.mfa_token) throw new Error('Monitor account requires MFA; use a dedicated non-interactive account');
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token ?? this.refreshToken;
    // Remembered because a refused token is only worth one conclusion if we
    // know how it was obtained: the refresh grant here returns HTTP 200 and an
    // access token the same server then answers 403 to, on every endpoint, for
    // as long as the process keeps refreshing. That is the hourly outage this
    // monitor had, and the reason restarting it helped — a restart is simply
    // the only thing that used to force the password grant.
    this.tokenCameFromRefresh = byRefresh;
    this.expiresAt = Date.now() + (token.expires_in ? token.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS);
    this.logger.log(
      `Veeam monitor authenticated as ${token.username ?? this.user}${byRefresh ? ' (refreshed)' : ''}`,
    );
    return this.accessToken;
  }
}
