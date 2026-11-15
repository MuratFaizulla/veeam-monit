import { instantOf } from '../veeam/estate';
import { CONFIG_BACKUP_SESSION } from '../veeam/estate-reader.service';
import { VeeamLogRecord, VeeamSession } from '../veeam/types';

const DAY = 86_400_000;

/**
 * How many of its newest runs are read: enough to find the last good one
 * behind a week of daily failures.
 */
export const CONFIG_BACKUP_RUNS = 10;

/** One run of the configuration backup that has ended. */
export interface ConfigBackupRun {
  /** Its session, whose log says why it failed or warned. */
  id?: string;
  /** When it ended, epoch ms. */
  at: number;
  /** Lower-cased, as every result: `success`, `warning`, `failed`. */
  result: string;
  /** What Veeam said of it, when it said anything. */
  message?: string;
}

/**
 * What is wrong with it: Veeam keeps no run of it at all, its latest run
 * failed, its latest good backup is older than the bot allows, or it is made
 * without encryption and so leaves the passwords and certificates out.
 */
export type ConfigBackupProblem = 'never' | 'failed' | 'stale' | 'unencrypted';

/** Veeam's configuration backup, as its runs show it. */
export interface ConfigBackup {
  /** The newest run that has ended. */
  last?: ConfigBackupRun;
  /** The newest run that left a backup behind: a success, or a warning. */
  good?: ConfigBackupRun;
  problem?: ConfigBackupProblem;
  /** What the latest run's log says went wrong or warned of, in Veeam's words. */
  reasons?: string[];
  /** Days without a good backup after which it is out of date. */
  staleDays: number;
}

/**
 * Veeam's configuration backup, from its newest runs — what a lost backup
 * server is rebuilt from, with its jobs, repositories and passwords.
 *
 * A warning leaves a backup behind as a success does. Why it warned, and why
 * a run failed, is in the run's log alone — the session's own message is
 * empty, or says "Warning" — and `explained` reads it in.
 *
 * Undefined when the reading cannot be trusted: sessions came back and not
 * one is a configuration backup, so the server did not filter them by type,
 * and the runs it does keep were not among them.
 */
export const configBackupOf = (
  sessions: VeeamSession[],
  now: number,
  settings: { staleDays: number; timezone: string },
): ConfigBackup | undefined => {
  const { staleDays, timezone } = settings;
  const runs = sessions.filter((session) => session.sessionType === CONFIG_BACKUP_SESSION);
  if (sessions.length > 0 && runs.length === 0) return undefined;
  if (runs.length === 0) return { problem: 'never', staleDays };

  const ended = runs
    .flatMap((session): ConfigBackupRun[] => {
      const at = instantOf(session.endTime, timezone);
      const result = session.result?.result;
      if (at === undefined || !result || result === 'none') return [];
      // "Warning" and "Failed" are only the result again.
      const message = session.result?.message?.trim();
      const said = message && message.toLowerCase() !== result ? { message } : {};
      return [{ ...(session.id ? { id: session.id } : {}), at, result, ...said }];
    })
    .sort((a, b) => b.at - a.at);
  const last = ended[0];
  const good = ended.find((run) => run.result === 'success' || run.result === 'warning');
  const backup: ConfigBackup = { ...(last ? { last } : {}), ...(good ? { good } : {}), staleDays };

  if (last?.result === 'failed') return { ...backup, problem: 'failed' };
  if (good && now - good.at > staleDays * DAY) return { ...backup, problem: 'stale' };
  return backup;
};

/** Whether the latest run's log is worth reading: it failed or warned, and only the log says why. */
export const unexplained = (backup: ConfigBackup | undefined): string | undefined => {
  const last = backup?.last;
  return last?.id && last.result !== 'success' ? last.id : undefined;
};

/** Veeam's last line of a run, which says only how it ended. */
const ENDING = /^job (finished|stopped|completed) with/i;

/** What Veeam writes when the backup leaves the passwords and certificates out for want of encryption. */
const UNENCRYPTED = /encryption is disabled/i;

/**
 * The configuration backup with what its latest run's log says: the lines
 * that failed or warned, in Veeam's words, and whether the backup it made
 * holds no passwords for want of encryption.
 *
 * Seen on a real server: a run with a warning every day — «Skipping
 * credentials backup because encryption is disabled. This will complicate the
 * restore process significantly» — and, on a newer Veeam, a run that fails
 * every day in three seconds with «Cannot create configuration backup without
 * encryption enabled», its session's message empty.
 */
export const explained = (backup: ConfigBackup, log: VeeamLogRecord[]): ConfigBackup => {
  const reasons = [
    ...new Set(
      log
        .filter((record) => /^(failed|warning)$/i.test(record.status ?? ''))
        .map((record) => (record.title ?? '').trim())
        .filter((title) => title && !ENDING.test(title)),
    ),
  ];
  if (!reasons.length) return backup;
  const unencrypted = !backup.problem && backup.last?.result === 'warning' && reasons.some((reason) => UNENCRYPTED.test(reason));
  return { ...backup, reasons, ...(unencrypted ? { problem: 'unencrypted' as const } : {}) };
};
