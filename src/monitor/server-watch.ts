import { VeeamReachability } from '../veeam/http.service';
import { ServerMemory } from '../telegram/server-memory';
import { NotificationEvent } from '../telegram/types';
import { Send } from './job-alerts';

const HOUR = 3_600_000;

/** What a Server watch asks of its server: whether it answers, and whether the account signs in. */
export interface WatchedServer {
  http: { baseUrl: string; reachability(): Promise<VeeamReachability> };
  auth: { configured: boolean; username: string; getAccessToken(): Promise<string> };
}

export interface ServerWatchSettings {
  /** How long a sign-in that keeps failing is not reported again. */
  authCooldownMs: number;
  /**
   * Lets the next sign-in failure be reported at once. Handed in because the
   * cooldown is kept per server under a key the monitor's sending scopes.
   */
  forget: (dedupeKey: string) => void;
}

/** How the latest pass found the server. */
export interface ServerHealth {
  /** Null until the server has been asked once. */
  reachable: boolean | null;
  /** Null until it has been asked, and while no monitor account is configured. */
  authenticated: boolean | null;
  /** What went wrong in the latest pass; null when nothing did. */
  error: string | null;
}

/**
 * Whether one Veeam server answers and whether the monitor account signs in
 * there, and what the bot says when either changes.
 *
 * Two signals, because they fail independently and an operator needs to tell
 * them apart: an expired monitor password used to look exactly like a healthy
 * server with no failing jobs.
 *
 * What was last said is remembered in the state file, so a change is said once
 * whatever restarts in between. A server that does not answer the first time
 * it is seen is reported: "starting up is not an event" was written against
 * six «монитор запущен» in one afternoon of restarts, not against a server
 * nobody would otherwise hear had never answered. It used to be kept by the
 * monitor in memory, and an outage the bot was started into was never
 * announced, though its recovery was.
 *
 * The health is the latest pass's. Its error is what went wrong in that pass —
 * here, or in any step the monitor ran after — and a clean pass clears it:
 * /status used to show «Последняя ошибка» from whatever failed last, a week
 * ago as readily as now.
 *
 * One per Veeam server, built by the monitor beside it, like the Job alerts.
 * Sending is handed in — the monitor's, which names the server.
 */
export class ServerWatch {
  private readonly current: ServerHealth = { reachable: null, authenticated: null, error: null };

  constructor(
    private readonly server: WatchedServer,
    private readonly memory: ServerMemory,
    private readonly send: Send,
    private readonly settings: ServerWatchSettings,
  ) {}

  get health(): ServerHealth {
    return { ...this.current };
  }

  /**
   * Asks the server, first of everything in a pass: whether it answers, and if
   * so whether the account signs in. Says what changed, and begins the pass's
   * health afresh. Never throws.
   */
  async observe(): Promise<{ reachable: boolean; authenticated: boolean }> {
    this.current.error = null;
    const reachable = await this.reachability();
    const authenticated = reachable && (await this.signIn());
    return { reachable, authenticated };
  }

  /** Something else in this pass went wrong: the health says so until the next pass. */
  failed(error: string): void {
    this.current.error = error;
  }

  private async reachability(): Promise<boolean> {
    const { http } = this.server;
    const { reachable, serverTime, error } = await http.reachability();
    const detail = (reachable ? serverTime : error) ?? '';
    if (!reachable) this.current.error = detail;
    this.current.reachable = reachable;

    // Seen for the first time, only a server that does not answer is news.
    const said = this.memory.reachable;
    if (said === undefined ? reachable : said === reachable) {
      this.memory.remember({ reachable });
      return reachable;
    }
    const report = await this.send({
      kind: 'infrastructure',
      severity: reachable ? 'success' : 'critical',
      title: reachable ? 'Veeam is reachable again' : 'Veeam is unreachable',
      fields: [
        ['Server', http.baseUrl],
        [reachable ? 'Server time' : 'Error', detail],
      ],
    });
    // A change nobody was told of has not been said: it is said again next pass.
    if (report.outcome !== 'failed') this.memory.remember({ reachable });
    return reachable;
  }

  /**
   * Whether the monitor account can sign in. The token itself stays with the
   * auth service; the estate reader asks it for one on every request.
   *
   * A broken account is reported once per cooldown instead of every pass, and
   * its recovery is announced so nobody has to check the log.
   */
  private async signIn(): Promise<boolean> {
    const { auth, http } = this.server;
    if (!auth.configured) {
      this.current.authenticated = null;
      await this.send(UNCONFIGURED);
      return false;
    }

    try {
      await auth.getAccessToken();
    } catch (error) {
      this.current.authenticated = false;
      this.current.error = (error as Error).message;
      this.memory.remember({ authenticated: false });
      await this.send({
        kind: 'infrastructure',
        severity: 'critical',
        title: 'Veeam: the monitor account cannot sign in',
        fields: [
          ['Account', auth.username],
          ['Server', http.baseUrl],
        ],
        body: `${(error as Error).message}\n\nUntil it signs in, changes in the jobs' results are not followed.`,
        dedupeKey: AUTH_FAILED,
        cooldownMs: this.settings.authCooldownMs,
      });
      return false;
    }

    this.current.authenticated = true;
    if (this.memory.authenticated === false) {
      // The next failure is news again, however soon it comes.
      this.settings.forget(AUTH_FAILED);
      const report = await this.send({
        kind: 'infrastructure',
        severity: 'success',
        title: 'Veeam: the monitor account signs in again',
        fields: [['Account', auth.username]],
      });
      if (report.outcome === 'failed') return true;
    }
    this.memory.remember({ authenticated: true });
    return true;
  }
}

/** The cooldown a failing sign-in is reported under. */
const AUTH_FAILED = 'veeam:auth:failed';

const UNCONFIGURED: NotificationEvent = {
  kind: 'infrastructure',
  severity: 'warning',
  title: 'Job monitoring is off',
  body: 'VEEAM_MONITOR_USERNAME / VEEAM_MONITOR_PASSWORD are not set, so the jobs are not checked.',
  dedupeKey: 'veeam:auth:unconfigured',
  cooldownMs: 24 * HOUR,
};
