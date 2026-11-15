import { instantOf } from '../veeam/estate';
import { CONFIG_BACKUP_SESSION } from '../veeam/estate-reader.service';
import { VeeamSession } from '../veeam/types';

const DAY = 86_400_000;

/**
 * How many of its newest runs are read: enough to find the last good one
 * behind a week of daily failures.
 */
export const CONFIG_BACKUP_RUNS = 10;

/** One run of the configuration backup that has ended. */
export interface ConfigBackupRun {
  /** When it ended, epoch ms. */
  at: number;
  /** Lower-cased, as every result: `success`, `warning`, `failed`. */
  result: string;
  /** What Veeam said of it, when it said anything. */
  message?: string;
}

/**
 * What is wrong with it: Veeam keeps no run of it at all, its latest run
 * failed, or its latest good backup is older than the bot allows.
 */
export type ConfigBackupProblem = 'never' | 'failed' | 'stale';

/** Veeam's configuration backup, as its runs show it. */
export interface ConfigBackup {
  /** The newest run that has ended. */
  last?: ConfigBackupRun;
  /** The newest run that left a backup behind: a success, or a warning. */
  good?: ConfigBackupRun;
  problem?: ConfigBackupProblem;
  /** Days without a good backup after which it is out of date. */
  staleDays: number;
}

/**
 * Veeam's configuration backup, from its newest runs — what a lost backup
 * server is rebuilt from, with its jobs, repositories and passwords.
 *
 * A warning leaves a backup behind as a success does: Veeam ends a run with
 * one when the backup is not encrypted and so holds no passwords, which is a
 * setting and not a failure, and would otherwise be said every day.
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
      const message = session.result?.message?.trim();
      return [{ at, result, ...(message ? { message } : {}) }];
    })
    .sort((a, b) => b.at - a.at);
  const last = ended[0];
  const good = ended.find((run) => run.result === 'success' || run.result === 'warning');
  const backup: ConfigBackup = { ...(last ? { last } : {}), ...(good ? { good } : {}), staleDays };

  if (last?.result === 'failed') return { ...backup, problem: 'failed' };
  if (good && now - good.at > staleDays * DAY) return { ...backup, problem: 'stale' };
  return backup;
};
