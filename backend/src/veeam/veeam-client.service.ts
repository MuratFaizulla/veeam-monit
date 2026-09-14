import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { VeeamSessionData } from '../auth/session.store';
import { AppConfig } from '../config/configuration';
import { VeeamApiError } from './veeam-api.error';
import { VeeamHttpService } from './veeam-http.service';
import {
  VeeamCollection,
  VeeamJob,
  VeeamJobState,
  VeeamServerInfo,
  VeeamSession,
} from './veeam.types';

/**
 * Session-aware wrapper around VeeamHttpService: it resolves the access token
 * for the caller, retries once after a refresh when Veeam rejects the token,
 * and exposes the handful of read endpoints this application needs.
 */
@Injectable()
export class VeeamClientService {
  private readonly logger = new Logger(VeeamClientService.name);
  private readonly cacheTtlMs: number;
  /**
   * Short-lived cache of in-flight and just-finished GETs, keyed by session and
   * URL. It collapses the duplicate reads a single page makes — the dashboard
   * and the jobs tab both want /jobs/states within the same second — and holds
   * the promise, so concurrent callers share one upstream request.
   */
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(
    private readonly http: VeeamHttpService,
    private readonly auth: AuthService,
    configService: ConfigService,
  ) {
    this.cacheTtlMs = configService.getOrThrow<AppConfig['veeam']>('veeam').cacheTtlMs;
  }

  async get<T>(
    session: VeeamSessionData,
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (this.cacheTtlMs <= 0) {
      return this.fetch<T>(session, path, params);
    }

    const key = `${session.id}|${path}|${JSON.stringify(params ?? {})}`;
    const now = Date.now();
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > now) {
      return cached.value as Promise<T>;
    }

    const value = this.fetch<T>(session, path, params);
    this.cache.set(key, { expiresAt: now + this.cacheTtlMs, value });

    // A failed call must not be served from cache for the rest of the TTL.
    value.catch(() => this.cache.delete(key));
    this.sweepCache(now);

    return value;
  }

  private async fetch<T>(
    session: VeeamSessionData,
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const accessToken = await this.auth.getAccessToken(session);

    try {
      return await this.http.request<T>({ method: 'GET', path, params, accessToken });
    } catch (error) {
      if (!(error instanceof VeeamApiError) || !error.isUnauthorized) {
        throw error;
      }
      // The token was rejected earlier than its stated expiry (server restart,
      // forced logout). One refresh-and-retry tells us whether it is recoverable.
      const refreshed = await this.auth.refreshAccessToken(session);
      return this.http.request<T>({ method: 'GET', path, params, accessToken: refreshed });
    }
  }

  private sweepCache(now: number): void {
    if (this.cache.size < 200) return;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  /**
   * Same as `get`, but returns null when the endpoint is missing on this build
   * or the signed-in role may not read it. Used for optional dashboard tiles.
   */
  async getOptional<T>(
    session: VeeamSessionData,
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      return await this.get<T>(session, path, params);
    } catch (error) {
      if (error instanceof VeeamApiError && (error.isNotFound || error.isForbidden)) {
        this.logger.debug(`Skipping ${path}: HTTP ${error.upstreamStatus}`);
        return null;
      }
      throw error;
    }
  }

  getServerInfo(session: VeeamSessionData): Promise<VeeamServerInfo | null> {
    // Requires the ViewServices claim, so a restricted operator gets null here.
    return this.getOptional<VeeamServerInfo>(session, '/api/v1/serverInfo');
  }

  async getJobs(session: VeeamSessionData): Promise<VeeamJob[]> {
    const result = await this.get<VeeamCollection<VeeamJob>>(session, '/api/v1/jobs', {
      skip: 0,
      limit: 1000,
    });
    return result?.data ?? [];
  }

  getJob(session: VeeamSessionData, jobId: string): Promise<VeeamJob> {
    return this.get<VeeamJob>(session, `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * Runtime state of every job. Older builds do not expose this path; callers
   * fall back to the job configuration when it returns null.
   */
  async getJobStates(session: VeeamSessionData): Promise<VeeamJobState[] | null> {
    const result = await this.getOptional<VeeamCollection<VeeamJobState>>(
      session,
      '/api/v1/jobs/states',
      { skip: 0, limit: 1000 },
    );
    return result ? (result.data ?? []) : null;
  }

  async getSessions(
    session: VeeamSessionData,
    options: { limit?: number; jobId?: string; createdAfter?: string; createdBefore?: string; all?: boolean } = {},
  ): Promise<VeeamSession[]> {
    const items: VeeamSession[] = [];
    const requested = options.limit ?? 200;
    let skip = 0;
    for (;;) {
      const result = await this.get<VeeamCollection<VeeamSession>>(session, '/api/v1/sessions', {
        skip, limit: Math.min(options.all ? 200 : requested - items.length, 200),
        orderColumn: 'CreationTime', orderAsc: false,
        ...(options.jobId ? { jobIdFilter: options.jobId } : {}),
        ...(options.createdAfter ? { createdAfterFilter: options.createdAfter } : {}),
        ...(options.createdBefore ? { createdBeforeFilter: options.createdBefore } : {}),
      });
      if (!Array.isArray(result.data)) throw new Error('Invalid sessions response');
      items.push(...result.data);
      skip += result.data.length;
      if (!options.all && items.length >= requested) return items.slice(0, requested);
      if (!result.data.length || (result.pagination?.total !== undefined && skip >= result.pagination.total)) return items;
    }
  }

  /* ---------------------------------------------------------------- *
   * Collections
   * ---------------------------------------------------------------- */

  /**
   * Reads a paged collection. Returns null (instead of throwing) when the path
   * does not exist on this build or the role may not read it, so a single
   * unsupported section never takes a whole page down.
   */
  async collection<T>(
    session: VeeamSessionData,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T[] | null> {
    const items: T[] = [];
    let skip = Number(params.skip ?? 0);
    const limit = Number(params.limit ?? 1000);
    for (;;) {
      const result = await this.getOptional<VeeamCollection<T>>(session, path, {
        ...params, skip, limit,
      });
      if (result === null) return null;
      if (!Array.isArray(result.data)) throw new Error(`Invalid collection response: ${path}`);
      items.push(...result.data);
      skip += result.data.length;
      const total = result.pagination?.total;
      if (result.data.length === 0 || (total !== undefined ? skip >= total : result.data.length < limit)) {
        return items;
      }
    }
  }

  /**
   * Tries several paths in order and returns the first one that answers.
   * Used where the endpoint was renamed between VBR builds and the exact path
   * on this server is not known in advance.
   */
  async collectionFrom<T>(
    session: VeeamSessionData,
    paths: string[],
    params: Record<string, unknown> = {},
  ): Promise<{ data: T[]; path: string } | null> {
    for (const path of paths) {
      try {
        const data = await this.get<VeeamCollection<T>>(session, path, {
          skip: 0,
          limit: 1000,
          ...params,
        });
        return { data: data?.data ?? [], path };
      } catch (error) {
        if (error instanceof VeeamApiError && error.isForbidden) {
          // 403 means the path exists but this role may not read it. Trying the
          // next spelling would be pointless, and would hide the real reason.
          this.logger.debug(`Stopping at ${path}: HTTP 403`);
          return null;
        }
        if (error instanceof VeeamApiError && error.isNotFound) {
          continue;
        }
        throw error;
      }
    }
    this.logger.debug(`None of the candidate paths answered: ${paths.join(', ')}`);
    return null;
  }
}
