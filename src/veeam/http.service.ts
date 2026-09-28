import { Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import { Agent } from 'https';
import { AppConfig, VeeamEndpoint } from '../config/configuration';
import { VeeamApiError } from './api.error';
import { VeeamTokenResponse } from './types';

/** Where one server is, and how to talk to it. */
export type VeeamConnection = Pick<AppConfig['veeam'], 'apiVersion' | 'insecureTls' | 'timeoutMs'> &
  Pick<VeeamEndpoint, 'name' | 'baseUrl'> &
  Partial<Pick<VeeamEndpoint, 'legacyTls'>>;

/** One answer to "is the backup server there": reachable, and the proof either way. */
export interface VeeamReachability {
  reachable: boolean;
  /** Veeam's own clock, when it answered. */
  serverTime?: string;
  /** Why it did not, when it did not. */
  error?: string;
}

export interface RawRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  accessToken?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
}

/**
 * Thin transport layer over the Veeam REST API. It knows about the base URL,
 * the mandatory `x-api-version` header and the OAuth2 endpoints, and it knows
 * nothing about browser sessions — see AuthService for that.
 *
 * One per Veeam server, built by `VeeamServers`: not a Nest provider, since
 * there is no single one to inject.
 */
export class VeeamHttpService {
  private readonly logger: Logger;
  private readonly http: AxiosInstance;
  /**
   * The `x-api-version` this server is spoken to in: the configured one, until
   * the server refuses it and names the ones it speaks. Servers of one estate
   * run different Veeam builds, and each speaks the API of its own build.
   */
  private apiVersion: string;

  constructor(private readonly config: VeeamConnection) {
    // Named, so a line of the request log says which server it was.
    this.logger = new Logger(`${VeeamHttpService.name} ${config.name}`);

    if (this.config.insecureTls) {
      this.logger.warn(
        `TLS verification is disabled for ${this.config.baseUrl}. Set VEEAM_INSECURE_TLS=false once the certificate is trusted.`,
      );
    }
    if (this.config.legacyTls) {
      this.logger.warn(
        `Legacy TLS algorithms are offered to ${this.config.baseUrl} (VEEAM_LEGACY_TLS). Enable modern TLS 1.2 on that server and remove it from the list.`,
      );
    }

    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      // VBR uses a self-signed certificate out of the box; the agent is what
      // makes that tolerable without touching NODE_TLS_REJECT_UNAUTHORIZED.
      httpsAgent: new Agent({
        rejectUnauthorized: !this.config.insecureTls,
        // Security level 0 puts SHA-1 signatures back into the handshake. An
        // old Windows server that wants them resets the connection when they
        // are missing, which reads as ECONNRESET and says nothing about why.
        ...(this.config.legacyTls ? { ciphers: 'DEFAULT@SECLEVEL=0' } : {}),
      }),
      // Statuses are inspected by hand so failures carry the Veeam error body.
      validateStatus: () => true,
      headers: { Accept: 'application/json' },
    });
    this.apiVersion = this.config.apiVersion;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Whether the backup server answers at all, and what its clock says.
   *
   * `/api/v1/serverTime` needs no token, which makes it the cheapest question
   * that distinguishes "the server is down" from "our credentials are wrong" —
   * a distinction the monitor reports separately and must not fold together.
   *
   * Never throws: being unreachable is the answer, not a failure to produce
   * one. Both callers wanted exactly this and each had written its own copy of
   * the path, the try/catch and the shape of the result.
   */
  async reachability(): Promise<VeeamReachability> {
    try {
      const result = await this.request<{ serverTime?: string }>({
        method: 'GET',
        path: '/api/v1/serverTime',
      });
      return { reachable: true, serverTime: result?.serverTime };
    } catch (error) {
      return { reachable: false, error: (error as Error).message };
    }
  }

  /** Exchanges user credentials for an access/refresh token pair. */
  async login(username: string, password: string): Promise<VeeamTokenResponse> {
    return this.token(
      new URLSearchParams({
        grant_type: 'password',
        username,
        password,
      }),
    );
  }

  /** Exchanges a refresh token for a fresh access token. */
  async refresh(refreshToken: string): Promise<VeeamTokenResponse> {
    return this.token(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    );
  }

  async request<T>(req: RawRequest): Promise<T> {
    const version = this.apiVersion;
    try {
      return await this.send<T>(req, version);
    } catch (error) {
      const spoken = error instanceof VeeamApiError ? spokenVersion(error.message) : undefined;
      if (spoken === undefined || spoken === version) throw error;
      // Another request may have learned it first; the lesson is the same.
      if (this.apiVersion === version) {
        this.apiVersion = spoken;
        this.logger.warn(
          `${this.config.baseUrl} does not speak REST API ${version}; speaking ${spoken}, the newest it offers`,
        );
      }
      return this.send<T>(req, this.apiVersion);
    }
  }

  private async send<T>(req: RawRequest, version: string): Promise<T> {
    const options: AxiosRequestConfig = {
      method: req.method,
      url: req.path,
      params: req.params,
      data: req.data,
      headers: {
        ...(req.headers ?? {}),
        'x-api-version': version,
        ...(req.accessToken ? { Authorization: `Bearer ${req.accessToken}` } : {}),
      },
    };

    const startedAt = Date.now();
    let response: AxiosResponse<T>;
    try {
      response = await this.http.request<T>(options);
    } catch (error) {
      this.logTiming(req, Date.now() - startedAt, null, null);
      throw this.transportError(error, req.path);
    }

    const elapsedMs = Date.now() - startedAt;
    this.logTiming(req, elapsedMs, response.status, this.itemCount(response.data));

    if (response.status >= 400) {
      throw this.responseError(response.status, response.data, req.path);
    }

    return response.data;
  }

  /**
   * One line per upstream call. This is the only place that knows how long a
   * single Veeam request actually took, so every latency question starts here.
   */
  private logTiming(
    req: RawRequest,
    elapsedMs: number,
    status: number | null,
    items: number | null,
  ): void {
    const query = req.params
      ? Object.entries(req.params)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join('&')
      : '';

    const parts = [
      `${req.method} ${req.path}${query ? `?${query}` : ''}`,
      `-> ${status ?? 'ERR'}`,
      `${elapsedMs}ms`,
      items === null ? null : `${items} items`,
    ].filter(Boolean);

    const line = parts.join(' ');

    // Slow upstream calls deserve attention even when the request succeeded.
    if (elapsedMs >= 1000) {
      this.logger.warn(`SLOW ${line}`);
    } else {
      this.logger.log(line);
    }
  }

  /** Size of a returned collection, when the payload looks like one. */
  private itemCount(data: unknown): number | null {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') {
      const collection = (data as { data?: unknown }).data;
      if (Array.isArray(collection)) return collection.length;
    }
    return null;
  }

  private async token(body: URLSearchParams): Promise<VeeamTokenResponse> {
    return this.request<VeeamTokenResponse>({
      method: 'POST',
      path: '/api/oauth2/token',
      data: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /** The request never reached Veeam: DNS, TLS, timeout, connection refused. */
  private transportError(error: unknown, path: string): VeeamApiError {
    let message = `Failed to reach the Veeam server at ${this.config.baseUrl}`;

    if (isAxiosError(error)) {
      const code = error.code ?? '';
      if (code === 'ECONNABORTED') {
        message = `The Veeam server did not respond within ${this.config.timeoutMs} ms`;
      } else if (code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        message = `TLS handshake with ${this.config.baseUrl} failed (${code}). Trust the certificate or set VEEAM_INSECURE_TLS=true`;
      } else if (code) {
        message = `${message} (${code})`;
      }
    }

    this.logger.error(`${path}: ${message}`);

    return new VeeamApiError(message, null);
  }

  /** Veeam answered with a 4xx/5xx and, usually, an Error model in the body. */
  private responseError(status: number, body: unknown, path: string): VeeamApiError {
    const payload = (body ?? {}) as Record<string, unknown>;
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      (typeof payload.error_description === 'string' && payload.error_description) ||
      (typeof payload.error === 'string' && payload.error) ||
      `Veeam API responded with HTTP ${status}`;

    this.logger.warn(`${path}: HTTP ${status} — ${message}`);

    return new VeeamApiError(message, status);
  }
}

/**
 * The newest REST API version a refusal names, or undefined when `message` is
 * not Veeam refusing the version.
 *
 * Veeam answers an `x-api-version` it does not speak with "Unsupported RESTAPI
 * version. The following versions are supported: v1.0-rev1, …, v1.1-rev2" —
 * the whole negotiation, in one error. The newest is taken because the
 * configured version was newer still, or it would not have been refused.
 */
export const spokenVersion = (message: string): string | undefined => {
  if (!/unsupported rest ?api version/i.test(message)) return undefined;
  const offered = [...message.matchAll(/v?(\d+)\.(\d+)-rev(\d+)/gi)].map(
    ([, major, minor, rev]) => [Number(major), Number(minor), Number(rev)],
  );
  if (offered.length === 0) return undefined;
  const [major, minor, rev] = offered.reduce((best, next) => {
    const newer = next[0] - best[0] || next[1] - best[1] || next[2] - best[2];
    return newer > 0 ? next : best;
  });
  return `${major}.${minor}-rev${rev}`;
};
