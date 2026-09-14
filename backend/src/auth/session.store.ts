import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, randomBytes } from 'crypto';
import { AppConfig } from '../config/configuration';

export interface VeeamSessionData {
  id: string;
  username: string;
  role?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms after which the access token must be refreshed. */
  accessTokenExpiresAt: number;
  /** Epoch ms after which the browser session itself is dropped. */
  expiresAt: number;
  createdAt: number;
}

/**
 * In-memory store mapping an opaque cookie value to the Veeam tokens obtained
 * on the user's behalf. Tokens never leave the backend.
 *
 * Restarting the process logs everyone out, and a multi-instance deployment
 * needs a shared store (Redis) instead — see README.
 */
@Injectable()
export class SessionStore implements OnModuleDestroy {
  private readonly logger = new Logger(SessionStore.name);
  private readonly sessions = new Map<string, VeeamSessionData>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(configService: ConfigService) {
    this.ttlMs = configService.getOrThrow<AppConfig['session']>('session').ttlMs;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  create(data: Omit<VeeamSessionData, 'id' | 'expiresAt' | 'createdAt'>): VeeamSessionData {
    const now = Date.now();
    const session: VeeamSessionData = {
      ...data,
      // The cookie value is unguessable and unrelated to the Veeam token.
      id: `${randomUUID()}.${randomBytes(24).toString('base64url')}`,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): VeeamSessionData | null {
    if (!id) return null;

    const session = this.sessions.get(id);
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }

    return session;
  }

  /** Slides the idle timeout forward on every authenticated request. */
  touch(session: VeeamSessionData): void {
    session.expiresAt = Date.now() + this.ttlMs;
  }

  update(session: VeeamSessionData): void {
    this.sessions.set(session.id, session);
  }

  delete(id: string | undefined): VeeamSessionData | null {
    if (!id) return null;
    const session = this.sessions.get(id) ?? null;
    this.sessions.delete(id);
    return session;
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Removed ${removed} expired session(s)`);
    }
  }
}
