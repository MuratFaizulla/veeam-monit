import { instantOf } from '../veeam/estate';
import { linesOf, sessionLines } from '../veeam/session-text';
import { VeeamBackupFile, VeeamLogRecord, VeeamTaskSession } from '../veeam/types';
import { JobReading, runsOfMonth } from './job-report';

/**
 * The Session report: one job's sessions over the month the way Veeam's own
 * console and e-mail print them — a block a session, newest first, coloured
 * by how it ended, its numbers, and every machine in a row with what went
 * wrong. It is the page people already read from Veeam every day, so it says
 * things in Veeam's words and in Veeam's English.
 *
 * Here is what it says, from what was read for the Job report; nothing here
 * asks Veeam. The page is `./session-report-page`.
 */

/** How a session, or a machine in it, came out — in the words of Veeam's report. */
export type SessionStatus = 'Success' | 'Warning' | 'Error' | 'In progress' | 'Pending';

export interface SessionMachine {
  name: string;
  status: SessionStatus;
  start?: number;
  end?: number;
  /** Bytes: the machine's disks, what was read of them, and what went to the repository. */
  size?: number;
  read?: number;
  transferred?: number;
  /** Start to end, or to the reading while it is still going. */
  minutes?: number;
  /** What Veeam wrote about it that was not a success, in order. */
  details: string[];
}

export interface SessionBlock {
  /** "OPS_Files (Full, Retry 1)". */
  title: string;
  status: SessionStatus;
  start: number;
  end?: number;
  /** While it is still going, 0–100. */
  progress?: number;
  /** Machines finished, of all it took on; undefined when they were not read. */
  processed?: number;
  of?: number;
  counts: { success: number; warning: number; error: number };
  /** Bytes, summed over its machines. */
  totalSize?: number;
  read?: number;
  transferred?: number;
  /** The files it wrote: undefined when none is on disk any more to say. */
  backupSize?: number;
  dedupe?: number;
  compression?: number;
  /** What Veeam said about the session as a whole, a line each. */
  notes: string[];
  /** Undefined when the session's machines were not read. */
  machines?: SessionMachine[];
}

export interface SessionReport {
  at: number;
  days: number;
  server: string;
  name: string;
  /** "Backup job", "Replication job", as Veeam heads its report. */
  kind: string;
  /** The job's description: Veeam's "Created by … at …", unless somebody wrote another. */
  description?: string;
  /** Newest first. */
  sessions: SessionBlock[];
}

/** What Veeam calls each kind of job at the head of its report. */
const KIND: Record<string, string> = {
  backup: 'Backup job',
  clouddirectorbackup: 'Backup job',
  vspherereplica: 'Replication job',
  hypervreplica: 'Replication job',
  clouddirectorreplica: 'Replication job',
  cdpreplica: 'CDP policy',
  backupcopy: 'Backup Copy job',
  vmbackupcopy: 'Backup Copy job',
  filebackup: 'File Backup job',
  filebackupcopy: 'File Backup Copy job',
  objectstoragebackup: 'Object Storage Backup job',
  windowsagentbackup: 'Agent Backup job',
  linuxagentbackup: 'Agent Backup job',
  surebackup: 'SureBackup job',
};

/** Lines of a note or a machine's details kept, and characters of each. */
const NOTE_LINES = 6;
const DETAIL_LINES = 8;
const LINE_CHARS = 400;
const MINUTE = 60_000;
/** A file written this long before its session's start is still the session's: clocks differ a little. */
const FILE_SLACK = 2 * MINUTE;

const statusOf = (result: string | undefined, state: string | undefined): SessionStatus => {
  const lower = (result ?? '').toLowerCase();
  if (lower === 'success') return 'Success';
  if (lower === 'warning') return 'Warning';
  if (lower === 'failed') return 'Error';
  return /working|starting|resuming|postprocessing|stopping/i.test(state ?? '') ? 'In progress' : 'Pending';
};

/** Veeam's lines, none longer than a reader reads. */
const clipped = (lines: string[]): string[] =>
  lines.map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line));

/**
 * What a machine's log says that was not a success; Veeam's report shows only
 * these. A machine Veeam retried inside the session says the same error twice,
 * once as "Processing <machine> Error: …": the row already names the machine,
 * and a line is said once. The last line — "Processing finished with errors
 * at …" — is kept, however long the rest.
 */
const detailsOf = (task: VeeamTaskSession, log: VeeamLogRecord[] | undefined, status: SessionStatus): string[] => {
  if (status === 'Success') return [];
  const said = log?.length
    ? log.filter((record) => !/^succeeded$/i.test(record.status ?? '')).map((record) => record.title)
    : [/^success$/i.test(task.result?.message ?? '') ? '' : task.result?.message];
  const prefix = `Processing ${task.name ?? ''} `;
  const lines = [...new Set(said.flatMap((text) => clipped(linesOf(text))).map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line)))];
  return lines.length > DETAIL_LINES ? [...lines.slice(0, DETAIL_LINES - 1), lines.at(-1) as string] : lines;
};

const machineOf = (task: VeeamTaskSession, log: VeeamLogRecord[] | undefined, at: number, timezone: string): SessionMachine => {
  const status = statusOf(task.result?.result, task.state);
  const start = instantOf(task.creationTime, timezone);
  const end = instantOf(task.endTime, timezone);
  return {
    name: task.name ?? '—',
    status,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(task.progress?.processedSize != null ? { size: task.progress.processedSize } : {}),
    ...(task.progress?.readSize != null ? { read: task.progress.readSize } : {}),
    ...(task.progress?.transferredSize != null ? { transferred: task.progress.transferredSize } : {}),
    ...(start !== undefined && (end !== undefined || status === 'In progress') ? { minutes: Math.max(0, ((end ?? at) - start) / MINUTE) } : {}),
    details: detailsOf(task, log, status),
  };
};

/** "Processing vm-01 Error: …" is two lines in Veeam's report: which machine, then what. */
const notesOf = (status: SessionStatus, message: string | undefined, end: number | undefined, progress: number | undefined, clock: (at: number) => string): string[] => {
  if (status === 'In progress') return [`Processing${progress !== undefined ? ` (${progress}% done)` : ''}`];
  const said = /^success$/i.test(message ?? '') ? [] : clipped(sessionLines(message));
  const verdict = status === 'Error' ? 'error' : status === 'Warning' ? 'warning' : '';
  return [...said.slice(0, NOTE_LINES), ...(verdict && end !== undefined ? [`Job finished with ${verdict} at ${clock(end)}`] : [])];
};

/** The files a session wrote, and how much Veeam squeezed them: Veeam gives each ratio in percent. */
const writtenBy = (files: Array<VeeamBackupFile & { at: number }>, start: number, end: number) => {
  const mine = files.filter((file) => file.at >= start - FILE_SLACK && file.at <= end + MINUTE);
  if (!mine.length) return undefined;
  const data = mine.reduce((sum, file) => sum + (file.dataSize ?? 0), 0);
  const deduped = mine.reduce((sum, file) => sum + ((file.dataSize ?? 0) * (file.dedupRatio ?? 100)) / 100, 0);
  const compressed = mine.reduce((sum, file) => sum + ((((file.dataSize ?? 0) * (file.dedupRatio ?? 100)) / 100) * (file.compressRatio ?? 100)) / 100, 0);
  return {
    backupSize: mine.reduce((sum, file) => sum + (file.backupSize ?? 0), 0),
    dedupe: deduped ? data / deduped : 1,
    compression: compressed ? deduped / compressed : 1,
  };
};

/** Most of its machines took a Full: a machine added to a job takes its first Full on an incremental night. */
const isFull = (tasks: VeeamTaskSession[] | undefined): boolean => {
  const known = (tasks ?? []).filter((task) => /^(full|increment)$/i.test(task.algorithm ?? ''));
  return known.length > 0 && known.filter((task) => /^full$/i.test(task.algorithm ?? '')).length * 2 > known.length;
};

export const sessionReportOf = (reading: JobReading, timezone: string): SessionReport => {
  const { at } = reading;
  const clock = (moment: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
      .format(new Date(moment))
      .replace(',', '')
      .replace(/[  ]/g, ' ');
  const files = reading.files.flatMap((file) => {
    const written = instantOf(file.creationTime, timezone);
    return written === undefined ? [] : [{ ...file, at: written }];
  });
  // Files are kept as long as the chain is: before the oldest, a session's files are gone, not unwritten.
  const oldestFile = files.length ? Math.min(...files.map((file) => file.at)) : Infinity;

  // Which attempt of its run each session was, by the fold the first page reads its runs by.
  const retryOf = new Map<string, number>();
  for (const run of runsOfMonth(reading)) {
    [...run.attempts].reverse().forEach((attempt, index) => retryOf.set(attempt.session.id ?? '', index));
  }
  // A replica writes no backup files: Veeam calls what a good session sent its backup size, and a failed one's nothing.
  const replica = /replica/i.test(reading.job.type ?? '');

  const sessions = reading.attempts
    .map(({ session, tasks }): SessionBlock | undefined => {
      const start = instantOf(session.creationTime, timezone);
      if (start === undefined) return undefined;
      const end = instantOf(session.endTime, timezone);
      const status = statusOf(session.result?.result, session.state);
      const progress = status === 'In progress' ? session.progressPercent : undefined;
      // In the order Veeam took them on, as its report lists them.
      const machines = tasks
        ?.map((task) => machineOf(task, task.id ? reading.taskLogs?.[task.id] : undefined, at, timezone))
        .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
      const sum = (pick: (machine: SessionMachine) => number | undefined) =>
        machines?.some((machine) => pick(machine) !== undefined) ? machines.reduce((total, machine) => total + (pick(machine) ?? 0), 0) : undefined;
      const retry = retryOf.get(session.id ?? '') ?? 0;
      const label = [isFull(tasks) ? 'Full' : '', retry ? `Retry ${retry}` : ''].filter(Boolean).join(', ');
      const transferred = sum((machine) => machine.transferred);
      const written = replica
        ? { backupSize: status === 'Success' || status === 'Warning' ? transferred ?? 0 : 0, dedupe: 1, compression: 1 }
        : writtenBy(files, start, end ?? at) ?? (start >= oldestFile ? { backupSize: 0, dedupe: 1, compression: 1 } : {});
      return {
        title: `${reading.job.name}${label ? ` (${label})` : ''}`,
        status,
        start,
        ...(end !== undefined ? { end } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(machines ? { processed: machines.filter((machine) => machine.status !== 'In progress' && machine.status !== 'Pending').length, of: machines.length } : {}),
        counts: {
          success: machines?.filter((machine) => machine.status === 'Success').length ?? 0,
          warning: machines?.filter((machine) => machine.status === 'Warning').length ?? 0,
          error: machines?.filter((machine) => machine.status === 'Error').length ?? 0,
        },
        totalSize: sum((machine) => machine.size),
        read: sum((machine) => machine.read),
        transferred,
        ...written,
        notes: notesOf(status, session.result?.message, end, progress, clock),
        ...(machines ? { machines } : {}),
      };
    })
    .filter((block): block is SessionBlock => block !== undefined)
    .sort((a, b) => b.start - a.start);

  return {
    at,
    days: reading.days,
    server: reading.server,
    name: reading.job.name,
    kind: KIND[(reading.job.type ?? '').toLowerCase()] ?? `${reading.job.type ?? 'Backup'} job`,
    ...(reading.configured?.description ? { description: reading.configured.description } : {}),
    sessions,
  };
};
