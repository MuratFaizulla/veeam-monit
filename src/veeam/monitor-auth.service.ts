import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { VeeamApiError } from './api.error';
import { VeeamHttpService } from './http.service';
import { VeeamTokenResponse } from './types';

const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000;
/** Shortest gap between two logins forced by Veeam refusing a token. */
const REJECT_COOLDOWN_MS = 60_000;

/**
 * Shortest gap between two password sign-ins after Veeam refused the password.
 *
 * Every cycle used to try again, once a minute. On 6 October an account not
 * yet created on veeam03edge was refused three times in three minutes, and
 * Veeam locked it for fifteen minutes, then again, then for thirty — by the
 * time it was created, the bot's own attempts kept it locked. The shared
 * account is a domain one, where the same minute-by-minute retries after a
 * password change would lock it in Active Directory for every server at once.
 */
const REFUSED_WAIT_MS = 15 * 60_000;

/** The statuses a token endpoint refuses credentials with. */
const REFUSALS = new Set([400, 401, 403]);

/**
 * How long to wait after a refusal: Veeam's own lockout and a minute more,
 * when it names one ("locked out for 00:30:00"), and never less than the floor.
 */
const waitAfter = (refusal: string): number => {
  const lockout = /locked out for (\d+):(\d{2}):(\d{2})/i.exec(refusal);
  if (!lockout) return REFUSED_WAIT_MS;
  const [hours, minutes, seconds] = lockout.slice(1).map(Number);
  return Math.max(REFUSED_WAIT_MS, ((hours * 60 + minutes) * 60 + seconds) * 1000 + 60_000);
};

/**
 * The monitor account's token on one Veeam server.
 *
 * One per server, built by `VeeamServers`. Servers are signed in to with the
 * same account, unless one outside the domain has its own, but a token is the
 * server's own either way, and so is the lesson that its refresh grant cannot
 * be trusted.
 */
export class VeeamMonitorAuthService {
  private readonly logger: Logger;
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
  /** Veeam's last refusal of the password, and when it may be offered again. */
  private refusal?: VeeamApiError;
  private refusedUntil = 0;

  constructor(
    account: Pick<AppConfig['veeam'], 'username' | 'password'>,
    private readonly veeam: VeeamHttpService,
    server = '',
  ) {
    this.logger = new Logger(`${VeeamMonitorAuthService.name}${server ? ` ${server}` : ''}`);
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
    // Answered from memory while the wait lasts: asking would be one more
    // failed attempt for Veeam to count.
    if (this.refusal && Date.now() < this.refusedUntil) {
      const minutes = Math.ceil((this.refusedUntil - Date.now()) / 60_000);
      throw new VeeamApiError(
        `${this.refusal.message.replace(/\.?\s*$/, '.')} Следующая попытка входа — через ${minutes} мин.`,
        this.refusal.upstreamStatus,
      );
    }
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

  /**
   * The password grant, remembering a refusal so that the next attempt waits
   * (see REFUSED_WAIT_MS). Anything else — Veeam down, the network gone — is
   * not a refusal of the password, and the next cycle tries again as before.
   */
  private async signIn(): Promise<VeeamTokenResponse> {
    try {
      const token = await this.veeam.login(this.user, this.password);
      this.refusal = undefined;
      this.refusedUntil = 0;
      return token;
    } catch (error) {
      if (error instanceof VeeamApiError && error.upstreamStatus !== null && REFUSALS.has(error.upstreamStatus)) {
        const wait = waitAfter(error.message);
        this.refusal = error;
        this.refusedUntil = Date.now() + wait;
        this.logger.warn(`Veeam refused the password; the next sign-in waits ${Math.round(wait / 60_000)} min`);
      }
      throw error;
    }
  }

  private async authenticate(): Promise<string> {
    const byRefresh = this.refreshUsable && Boolean(this.refreshToken);
    let token: VeeamTokenResponse;
    try {
      token = byRefresh ? await this.veeam.refresh(this.refreshToken) : await this.signIn();
    } catch (error) {
      if (!byRefresh) throw error;
      this.refreshToken = '';
      token = await this.signIn();
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
