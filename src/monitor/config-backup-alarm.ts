import { ConfigBackup, ConfigBackupRun } from '../estate/config-backup';
import { Clock, dayOfEn, durationEn } from '../telegram/time';
import { NotificationEvent } from '../telegram/types';
import { Sending } from './server-sending';

const HOUR = 3_600_000;

/** The cooldown its alarm is kept under: said once a day while it lasts. */
export const CONFIG_BACKUP_ALARM = 'config-backup';
const COOLDOWN_MS = 24 * HOUR;

/**
 * A backup made without encryption has an alarm and a cooldown of its own: it
 * is a setting somebody has to change, said once a week, and a failure after
 * it must not wait out its week.
 */
export const UNENCRYPTED_ALARM = 'config-backup:unencrypted';
const UNENCRYPTED_COOLDOWN_MS = 7 * 24 * HOUR;

/** Where it is set, in the console: whoever reads the alarm goes there next. */
const WHERE = 'It is set in the Veeam console: Menu → Configuration Backup.';

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
    sending.forget(UNENCRYPTED_ALARM);
    return;
  }
  if (backup.problem === 'unencrypted') {
    // A backup was made: whatever was wrong before is over.
    sending.forget(CONFIG_BACKUP_ALARM);
    await sending.send({ ...unencryptedAlarm(backup, clock), dedupeKey: UNENCRYPTED_ALARM, cooldownMs: UNENCRYPTED_COOLDOWN_MS });
    return;
  }
  await sending.send({ ...alarmOf(backup, clock), dedupeKey: CONFIG_BACKUP_ALARM, cooldownMs: COOLDOWN_MS });
};

const unencryptedAlarm = (backup: ConfigBackup, clock: Clock): NotificationEvent => ({
  kind: 'infrastructure',
  severity: 'warning',
  title: 'Configuration backup is not encrypted',
  fields: [['Last backup', backup.good && whenOf(backup.good, clock)]],
  body:
    `${(backup.reasons ?? []).filter((reason) => /encryption/i.test(reason)).join('\n')}\n\n` +
    'Veeam leaves the passwords and certificates out of a backup it does not encrypt, and a lost backup ' +
    'server has them all entered again by hand. Turn encryption on in the Veeam console: Menu → Configuration Backup.',
});

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
      body: backup.reasons ? `${backup.reasons.join('\n')}\n\n${WHERE}` : last?.message,
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
