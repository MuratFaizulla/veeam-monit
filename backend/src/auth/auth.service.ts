import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { VeeamHttpService } from '../veeam/veeam-http.service';
import { VeeamApiError } from '../veeam/veeam-api.error';
import { VeeamTokenResponse } from '../veeam/veeam.types';
import { SessionStore, VeeamSessionData } from './session.store';

/** Renew the access token this long before it actually expires. */
const REFRESH_SKEW_MS = 60_000;
/** Used when Veeam omits expires_in. */
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000;

export interface SessionUser {
  username: string;
  role?: string;
  expiresAt: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Guards against several concurrent requests refreshing the same session. */
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly veeam: VeeamHttpService,
    private readonly sessions: SessionStore,
  ) {}

  async login(username: string, password: string): Promise<VeeamSessionData> {
    let token: VeeamTokenResponse;
    try {
      token = await this.veeam.login(username, password);
    } catch (error) {
      // A rejected password is a 401 from Veeam, which the transport layer maps
      // to 502. For the login endpoint it really is a 401 for our client.
      if (error instanceof VeeamApiError && error.isUnauthorized) {
        throw new UnauthorizedException('Invalid Veeam credentials');
      }
      throw error;
    }

    if (token.mfa_token) {
      // Completing MFA needs a second call to /api/oauth2/token with the
      // mfa_token and the one-time code, which this MVP does not collect.
      throw new UnauthorizedException(
        'This account requires multi-factor authentication, which is not supported yet',
      );
    }

    const session = this.sessions.create({
      username: token.username ?? username,
      role: token.role,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: this.expiryOf(token),
    });

    this.logger.log(`Session opened for ${session.username}`);
    return session;
  }

  async logout(sessionId: string | undefined): Promise<void> {
    const session = this.sessions.delete(sessionId);
    if (!session) return;

    try {
      await this.veeam.logout(session.accessToken);
    } catch (error) {
      // The local session is already gone; a failed upstream logout only means
      // the Veeam token lives until it expires on its own.
      this.logger.warn(
        `Upstream logout failed for ${session.username}: ${(error as Error).message}`,
      );
    }
  }

  describe(session: VeeamSessionData): SessionUser {
    return {
      username: session.username,
      role: session.role,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  /** Returns a usable access token, refreshing it first when it is about to expire. */
  async getAccessToken(session: VeeamSessionData): Promise<string> {
    if (Date.now() < session.accessTokenExpiresAt - REFRESH_SKEW_MS) {
      return session.accessToken;
    }
    return this.refreshAccessToken(session);
  }

  /** Forces a refresh — used when Veeam rejects a token we believed was valid. */
  async refreshAccessToken(session: VeeamSessionData): Promise<string> {
    const pending = this.refreshes.get(session.id);
    if (pending) return pending;

    const promise = this.doRefresh(session).finally(() => this.refreshes.delete(session.id));
    this.refreshes.set(session.id, promise);
    return promise;
  }

  private async doRefresh(session: VeeamSessionData): Promise<string> {
    if (!session.refreshToken) {
      this.sessions.delete(session.id);
      throw new UnauthorizedException('Session expired, please sign in again');
    }

    try {
      const token = await this.veeam.refresh(session.refreshToken);
      session.accessToken = token.access_token;
      session.refreshToken = token.refresh_token ?? session.refreshToken;
      session.accessTokenExpiresAt = this.expiryOf(token);
      this.sessions.update(session);
      return session.accessToken;
    } catch (error) {
      this.sessions.delete(session.id);
      this.logger.warn(`Token refresh failed for ${session.username}: ${(error as Error).message}`);
      throw new UnauthorizedException('Session expired, please sign in again');
    }
  }

  private expiryOf(token: VeeamTokenResponse): number {
    const lifetimeMs = token.expires_in ? token.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    return Date.now() + lifetimeMs;
  }
}
