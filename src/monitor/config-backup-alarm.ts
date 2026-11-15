import { ConfigBackup, ConfigBackupRun } from '../estate/config-backup';
import { Clock, dayOfEn, durationEn } from '../telegram/time';
import { NotificationEvent } from '../telegram/types';
import { Sending } from './server-sending';

const HOUR = 3_600_000;

/** The cooldown its alarm is kept under: said once a day while it lasts. */
export const CONFIG_BACKUP_ALARM = 'config-backup';
const COOLDOWN_MS = 24 * HOUR;

/** Where it is set, in the console: whoever reads the alarm goes there next. */
const WHERE = 'In the Veeam console: Menu → Configuration Backup.';

/**
 * Says what is wrong with one server's configuration backup, through that
 * server's sending: once a day while it lasts.
 *
 * A backup that is fine again has its alarm forgotten, so the next problem is
 * said at once rather than waiting out the day; a reading that could not be
 * trusted says nothing either way.
 */
export const sendConfigBackupAlarm = async (
  backup: ConfigBackup | undefined,
  clock: Clock,
  sending: Sending,
): Promise<void> => {
  if (!backup) return;
  if (!backup.problem) {
    sending.forget(CONFIG_BACKUP_ALARM);
    return;
  }
  await sending.send({ ...alarmOf(backup, clock), dedupeKey: CONFIG_BACKUP_ALARM, cooldownMs: COOLDOWN_MS });
};

const alarmOf = (backup: ConfigBackup, clock: Clock): NotificationEvent => {
  const { last, good, staleDays } = backup;
  if (backup.problem === 'never') {
    return {
      kind: 'infrastructure',
      severity: 'warning',
      title: 'Veeam makes no configuration backup',
      body:
        'Not one run of it is in the session history Veeam keeps. Without one, a backup server that is lost ' +
        `is set up again by hand: its jobs, repositories and passwords. ${WHERE}`,
    };
  }
  if (backup.problem === 'failed') {
    return {
      kind: 'infrastructure',
      severity: 'warning',
      title: 'Configuration backup failed',
      fields: [
        ['Run', last && whenOf(last, clock)],
        ['Last good backup', good ? `${whenOf(good, clock)} (${agoOf(good, clock)})` : 'none among the latest runs'],
      ],
      body: last?.message,
    };
  }
  return {
    kind: 'infrastructure',
    severity: 'warning',
    title: 'Configuration backup is out of date',
    fields: [
      ['Last good backup', good && `${whenOf(good, clock)} (${agoOf(good, clock)})`],
      ['Alert after', `${staleDays} ${staleDays === 1 ? 'day' : 'days'}`],
    ],
    body: `Veeam has not made one since. Is its schedule still on? ${WHERE}`,
  };
};

const whenOf = (run: ConfigBackupRun, clock: Clock): string => dayOfEn(new Date(run.at).toISOString(), clock);

const agoOf = (run: ConfigBackupRun, clock: Clock): string => `${durationEn(clock.now.getTime() - run.at)} ago`;
