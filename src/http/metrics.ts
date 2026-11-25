import { ConfigBackupProblem } from '../estate/config-backup';
import { MonitorHealth, ServerReading } from '../monitor/monitor';
import { instantOf, Job } from '../veeam/estate';

/**
 * What the monitor read, in the Prometheus text format, for a Grafana to chart.
 *
 * Nothing here asks Veeam anything: a scrape reads what the cycle already read,
 * so Prometheus scraping every fifteen seconds costs Veeam nothing more than
 * the monitor does on its own. What the cycle did not read this pass is left
 * out rather than repeated (see `ServerReading`), and a series that stops
 * coming is what tells Prometheus a server went quiet.
 *
 * The labels avoid `job` and `instance`: Prometheus sets those on every series
 * it scrapes, and a series bringing its own would see them renamed
 * `exported_job`. A job is `job_name`, and its id rides along because Veeam
 * does not forbid two jobs one name.
 */

/** The media type of the Prometheus text format. */
export const PROMETHEUS_TEXT = 'text/plain; version=0.0.4; charset=utf-8';

type Labels = Record<string, string>;

interface Family {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: [Labels, number][];
}

/**
 * A result as a number a chart can colour, the order of how bad it is:
 * failed 2, warning 1, success 0, and -1 for none — a job never run, or one
 * running now, whose last result Veeam clears for the length of the run.
 */
const RESULT_CODES: Readonly<Record<string, number>> = { none: -1, success: 0, warning: 1, failed: 2 };

/** Every state the configuration backup can be in, `ok` being no problem. */
const CONFIG_BACKUP_STATES: readonly ('ok' | ConfigBackupProblem)[] = ['ok', 'never', 'failed', 'stale', 'unencrypted'];

const GIB = 2 ** 30;

/** The longest message or reason a label carries: one line worth reading, not a log. */
const LABEL_TEXT = 300;

/**
 * The whole exposition. `timezone` is the Veeam server's, for the job times
 * a build writes without an offset.
 */
export const metricsText = (servers: ServerReading[], health: Pick<MonitorHealth, 'delivered' | 'undelivered'>, timezone: string): string => {
  const family = (name: string, type: Family['type'], help: string): Family => ({ name, type, help, samples: [] });
  const up = family('veeam_server_up', 'gauge', 'Whether the Veeam server answered the latest pass: 1 yes, 0 no.');
  const authenticated = family('veeam_server_authenticated', 'gauge', "Whether the monitor's account signed in to it: 1 yes, 0 no.");
  const checked = family('veeam_server_last_check_timestamp_seconds', 'gauge', "When the monitor's latest pass of the server ended.");
  const result = family('veeam_job_last_result', 'gauge', 'Last result of the job: 2 failed, 1 warning, 0 success, -1 none (never run, or running now).');
  const running = family('veeam_job_running', 'gauge', 'Whether the job is running: 1 yes, 0 no.');
  const disabled = family('veeam_job_disabled', 'gauge', 'Whether the job is disabled: 1 yes, 0 no.');
  const lastRun = family('veeam_job_last_run_timestamp_seconds', 'gauge', 'When the job last started.');
  const nextRun = family('veeam_job_next_run_timestamp_seconds', 'gauge', 'When the job is scheduled to start next; absent for a job nothing schedules.');
  const objects = family('veeam_job_objects', 'gauge', 'Machines and other objects the job protects.');
  const sessionStart = family('veeam_job_last_session_start_timestamp_seconds', 'gauge', "When the job's newest ended session started.");
  const sessionEnd = family('veeam_job_last_session_end_timestamp_seconds', 'gauge', "When the job's newest ended session ended.");
  const sessionDuration = family('veeam_job_last_session_duration_seconds', 'gauge', "How long the job's newest ended session ran.");
  const sessionResult = family('veeam_job_last_session_result', 'gauge', "How the job's newest ended session ended: 2 failed, 1 warning, 0 success.");
  const sessionMessage = family('veeam_job_last_session_message', 'gauge', 'What Veeam said of that session when it failed or warned, as the message label; always 1.');
  const sessionRead = family('veeam_job_last_session_read_bytes', 'gauge', "Bytes that session read from its machines' disks.");
  const sessionTransferred = family('veeam_job_last_session_transferred_bytes', 'gauge', 'Bytes that session sent on, after compression and deduplication.');
  const sessionProcessed = family('veeam_job_last_session_processed_bytes', 'gauge', "Bytes of its machines' disks that session went through, the blocks it skipped included.");
  const sessionMachines = family('veeam_job_last_session_machines', 'gauge', 'Machines of that session by how they ended, the result label.');
  const sessionBottleneck = family('veeam_job_last_session_bottleneck', 'gauge', 'The stage that held most of its machines back, as the bottleneck label; always 1.');
  const machineResult = family('veeam_job_last_session_machine_result', 'gauge', 'How each machine of that session ended: 2 failed, 1 warning, 0 success, -1 none; the reason label says why when it did not succeed.');
  const progress = family('veeam_job_session_progress_percent', 'gauge', 'How far the session the job is running now has got, 0 to 100.');
  const runningSince = family('veeam_job_session_running_since_timestamp_seconds', 'gauge', 'When the session the job is running now started.');
  const capacity = family('veeam_repository_capacity_bytes', 'gauge', "The repository's capacity, taking Veeam's GB as GiB.");
  const free = family('veeam_repository_free_bytes', 'gauge', 'Free space on the repository.');
  const used = family('veeam_repository_used_bytes', 'gauge', 'Space in use on the repository: capacity minus free whenever Veeam reports free space.');
  const online = family('veeam_repository_online', 'gauge', 'Whether the repository is online: 1 yes, 0 no.');
  const configResult = family('veeam_config_backup_last_result', 'gauge', 'Last result of the configuration backup: 2 failed, 1 warning, 0 success.');
  const configGood = family('veeam_config_backup_last_good_timestamp_seconds', 'gauge', 'When the newest configuration backup that left a backup behind ended.');
  const configState = family('veeam_config_backup_state', 'gauge', 'The configuration backup is in this state when 1: ok, never, failed, stale or unencrypted.');
  const delivered = family('veeam_monitor_events_delivered_total', 'counter', 'Events that reached at least one chat since the monitor started.');
  const undelivered = family('veeam_monitor_events_undelivered_total', 'counter', 'Events attempted that reached no chat since the monitor started.');

  for (const reading of servers) {
    const server = { server: reading.name };
    if (reading.reachable !== null) up.samples.push([server, flag(reading.reachable)]);
    if (reading.authenticated !== null) authenticated.samples.push([server, flag(reading.authenticated)]);
    if (reading.checkedAt !== undefined) checked.samples.push([server, seconds(reading.checkedAt)]);

    for (const job of reading.jobs ?? []) {
      const labels = { ...server, job_name: job.name, job_id: job.id, job_type: job.type ?? '' };
      const code = RESULT_CODES[job.result];
      if (code !== undefined) result.samples.push([labels, code]);
      const status = (job.status ?? '').toLowerCase();
      running.samples.push([labels, flag(status === 'running')]);
      disabled.samples.push([labels, flag(status === 'disabled')]);
      pushInstant(lastRun, labels, job.lastRun, timezone);
      pushInstant(nextRun, labels, job.nextRun, timezone);
      if (isNumber(job.objectsCount)) objects.samples.push([labels, job.objectsCount]);

      const { last, running: now } = reading.sessions?.get(job.id) ?? {};
      if (last) {
        sessionStart.samples.push([labels, seconds(last.startedAt)]);
        if (last.endedAt !== undefined) {
          sessionEnd.samples.push([labels, seconds(last.endedAt)]);
          sessionDuration.samples.push([labels, Math.round((last.endedAt - last.startedAt) / 1000)]);
        }
        const ended = last.result === undefined ? undefined : RESULT_CODES[last.result];
        if (ended !== undefined) sessionResult.samples.push([labels, ended]);
        if (last.message && (last.result === 'failed' || last.result === 'warning')) {
          sessionMessage.samples.push([{ ...labels, message: clipped(last.message) }, 1]);
        }
        const details = last.details;
        if (details) {
          if (details.read !== undefined) sessionRead.samples.push([labels, details.read]);
          if (details.transferred !== undefined) sessionTransferred.samples.push([labels, details.transferred]);
          if (details.processed !== undefined) sessionProcessed.samples.push([labels, details.processed]);
          if (details.bottleneck) sessionBottleneck.samples.push([{ ...labels, bottleneck: details.bottleneck }, 1]);
          const byResult = new Map<string, number>();
          for (const machine of details.machines) {
            byResult.set(machine.result || 'none', (byResult.get(machine.result || 'none') ?? 0) + 1);
            const reason = machine.result === 'success' ? '' : clipped(machine.reason ?? '');
            machineResult.samples.push([{ ...labels, machine: machine.name, reason }, RESULT_CODES[machine.result] ?? -1]);
          }
          for (const [each, count] of byResult) sessionMachines.samples.push([{ ...labels, result: each }, count]);
        }
      }
      if (now) {
        runningSince.samples.push([labels, seconds(now.startedAt)]);
        if (isNumber(now.progressPercent)) progress.samples.push([labels, now.progressPercent]);
      }
    }

    for (const repository of reading.repositories ?? []) {
      const labels = { ...server, repository: repository.name, repository_id: repository.key };
      if (isNumber(repository.capacityGB)) capacity.samples.push([labels, bytes(repository.capacityGB)]);
      if (isNumber(repository.freeGB)) free.samples.push([labels, bytes(repository.freeGB)]);
      if (isNumber(repository.usedGB)) used.samples.push([labels, bytes(repository.usedGB)]);
      if (repository.isOnline !== undefined) online.samples.push([labels, flag(repository.isOnline)]);
    }

    const backup = reading.configBackup;
    if (backup) {
      const code = backup.last && RESULT_CODES[backup.last.result];
      if (code !== undefined) configResult.samples.push([server, code]);
      if (backup.good) configGood.samples.push([server, seconds(backup.good.at)]);
      const state = backup.problem ?? 'ok';
      for (const each of CONFIG_BACKUP_STATES) configState.samples.push([{ ...server, state: each }, flag(each === state)]);
    }
  }
  delivered.samples.push([{}, health.delivered]);
  undelivered.samples.push([{}, health.undelivered]);

  return [
    up, authenticated, checked,
    result, running, disabled, lastRun, nextRun, objects,
    sessionStart, sessionEnd, sessionDuration, sessionResult, sessionMessage, sessionRead, sessionTransferred, sessionProcessed,
    sessionMachines, sessionBottleneck, machineResult, progress, runningSince,
    capacity, free, used, online,
    configResult, configGood, configState,
    delivered, undelivered,
  ]
    .filter((each) => each.samples.length > 0)
    .map(exposition)
    .join('');
};

const exposition = ({ name, help, type, samples }: Family): string =>
  `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n` +
  samples.map(([labels, value]) => `${name}${labelsText(labels)} ${value}\n`).join('');

const labelsText = (labels: Labels): string => {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escaped(value)}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
};

/** A label value as the text format writes it: backslash, quote and line feed escaped. */
const escaped = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const pushInstant = (into: Family, labels: Labels, text: Job['lastRun'], timezone: string): void => {
  const at = instantOf(text, timezone);
  if (at !== undefined) into.samples.push([labels, seconds(at)]);
};

/** A message as a label carries it: one line, at most `LABEL_TEXT` characters. */
const clipped = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > LABEL_TEXT ? `${line.slice(0, LABEL_TEXT - 1)}…` : line;
};

const flag = (value: boolean): number => (value ? 1 : 0);
const seconds = (epochMs: number): number => Math.floor(epochMs / 1000);
const bytes = (gb: number): number => Math.round(gb * GIB);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
