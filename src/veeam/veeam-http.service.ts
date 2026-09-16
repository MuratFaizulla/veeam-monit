import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import { Agent } from 'https';
import { AppConfig } from '../config/configuration';
import { VeeamApiError } from './veeam-api.error';
import { VeeamTokenResponse } from './veeam.types';

type VeeamConfig = AppConfig['veeam'];

/** One answer to "is the backup server there": reachable, and the proof either way. */
export interface VeeamReachability {
  reachable: boolean;
  /** Veeam's own clock, when it answered. */
  serverTime?: string;
  /** Why it did not, when it did not. */
  error?: string;
}

interface RawRequest {
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
 */
@Injectable()
export class VeeamHttpService {
  private readonly logger = new Logger(VeeamHttpService.name);
  private readonly http: AxiosInstance;
  private readonly config: VeeamConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<VeeamConfig>('veeam');

    if (this.config.insecureTls) {
      this.logger.warn(
        `TLS verification is disabled for ${this.config.baseUrl}. Set VEEAM_INSECURE_TLS=false once the certificate is trusted.`,
      );
    }

    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      // VBR uses a self-signed certificate out of the box; the agent is what
      // makes that tolerable without touching NODE_TLS_REJECT_UNAUTHORIZED.
      httpsAgent: new Agent({ rejectUnauthorized: !this.config.insecureTls }),
      // Statuses are inspected by hand so failures carry the Veeam error body.
      validateStatus: () => true,
      headers: {
        'x-api-version': this.config.apiVersion,
        Accept: 'application/json',
      },
    });
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
    const options: AxiosRequestConfig = {
      method: req.method,
      url: req.path,
      params: req.params,
      data: req.data,
      headers: {
        ...(req.headers ?? {}),
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
