import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from '../telegram/format';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { Answer } from './answer';
import { endOf, JOB_REPORT_DAYS, JobReading, jobReportOf } from './job-report';
import { jobReportPage } from './job-report-page';
import { ReportPrinter } from './report-printer';
import { stampOf } from './repository-report-page';
import { ServerEstate } from './server-estates';

const DAY = 86_400_000;
/** The job's newest sessions asked for: a month of a daily job with every retry, and then some. */
const SESSIONS = 500;
/** Sessions whose machines are read, a request each: an hourly job's month would be seven hundred. */
const TASK_SESSIONS = 60;
/** The newest finished sessions whose log says what held them back. */
const LOG_SESSIONS = 6;
/** Requests in flight at a time. */
const POOL = 6;

const STATUS_ICON = { crit: '🔴', warn: '🟡', ok: '🟢', unknown: '⚪' } as const;
const STATUS_WORD = { crit: 'критично', warn: 'внимание', ok: 'норма', unknown: 'нет данных' } as const;

/**
 * The Job report, read and printed when somebody presses its Button under a
 * Job card: one job on one server, over a month. Some eighty requests — the
 * job's sessions and every one's machines, the backups and their files, the
 * repository and who else writes there — so it is read on demand only, and
 * printed by the same browser as the Repository report, one at a time.
 */
@Injectable()
export class JobReports {
  private readonly logger = new Logger(JobReports.name);
  private readonly timezone: string;

  constructor(
    config: ConfigService,
    private readonly printer: ReportPrinter,
  ) {
    this.timezone = config.getOrThrow<AppConfig['telegram']>('telegram').timezone;
  }

  /** The report on job `id` of `estate`, as a PDF; a job that is gone is said so. */
  async answer(estate: ServerEstate, id: string): Promise<Answer> {
    const reading = await readJob(estate.name, estate.reader, id, Date.now());
    if (!reading) return { text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.' };
    if (reading.error) this.logger.warn(`Job report: ${estate.name} ${reading.job.name} read in part: ${reading.error}`);
    const report = jobReportOf(reading, this.timezone);
    const content = await this.printer.print(jobReportPage(report, this.timezone));
    const stamp = stampOf(report.at, this.timezone);
    return {
      text: [
        `📄 <b>${escapeHtml(report.name)}</b> — ${STATUS_ICON[report.status]} ${STATUS_WORD[report.status]}`,
        escapeHtml(report.verdict),
        ...(report.partial ? ['⚠️ Прочитано не всё — что именно, сказано в отчёте.'] : []),
        '',
        `<i>${escapeHtml(report.server)} · за ${report.days} дней, на ${stamp}.</i>`,
      ].join('\n'),
      // A job's name may hold what a file name may not.
      document: { filename: `Задание ${report.name.replace(/[\\/:*?"<>|]+/g, '_')} ${stamp.slice(0, 10)}.pdf`, content },
    };
  }
}

/**
 * Everything one job's report needs from its server, or undefined when the
 * server no longer has the job. The job and its sessions are the report; a
 * request after them that fails is said in `error`, and the rest is kept.
 */
export const readJob = async (server: string, reader: VeeamEstateReader, id: string, now: number, days = JOB_REPORT_DAYS): Promise<JobReading | undefined> => {
  const job = (await reader.jobStates()).find((candidate) => candidate.id === id);
  if (!job) return undefined;
  const since = now - days * DAY;
  const reading: JobReading = { at: now, days, server, job, attempts: [], bottlenecks: [], files: [], points: [], neighbours: [], neighbourRuns: [] };
  const missing: string[] = [];
  const step = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      missing.push(`${what}: ${(error as Error).message}`);
    }
  };

  await step('настройки', async () => {
    reading.configured = await reader.jobConfiguration(id);
  });
  const sessions = (await reader.recentSessions(id, SESSIONS)).filter((session) => session.id && Date.parse(session.creationTime ?? '') >= since);
  // A server whose REST API predates task sessions answers 404: the machines are unknown, the runs are not.
  const tasks = await pooled(sessions.slice(0, TASK_SESSIONS), (session) => reader.taskSessions(session.id as string));
  reading.attempts = sessions.map((session, index) => ({ session, tasks: tasks[index] }));

  await step('журналы', async () => {
    const logs = await pooled(sessions.filter((session) => endOf(session)).slice(0, LOG_SESSIONS), (session) => reader.sessionLog(session.id as string));
    reading.bottlenecks = logs.flatMap((records) => (records ?? []).flatMap((record) => /Primary bottleneck:\s*(\w+)/i.exec(record.title ?? '')?.[1] ?? []));
  });
  const repositoryId = reading.configured?.storage?.backupRepositoryId ?? reading.configured?.jobSettings?.metadataRepositoryId;
  await step('репозиторий', async () => {
    if (repositoryId) reading.repository = (await reader.repositoryStates()).find((repository) => repository.id === repositoryId);
  });
  await step('бэкапы', async () => {
    const backups = (await reader.backups()).filter((backup) => backup.id && backup.jobId === id);
    const files = await pooled(backups, (backup) => reader.backupFiles(backup.id as string));
    reading.files = files.flatMap((list) => list ?? []);
    // The whole list: filtered by backup, Veeam answers each machine's newest point only.
    const ids = new Set(backups.map((backup) => backup.id));
    reading.points = (await reader.restorePoints()).filter((point) => ids.has(point.backupId));
  });
  await step('соседи', async () => {
    if (!repositoryId) return;
    reading.neighbours = (await reader.jobConfigurations()).flatMap((other) =>
      other.id && other.id !== id && other.storage?.backupRepositoryId === repositoryId ? [{ id: other.id, name: other.name ?? other.id }] : [],
    );
    const newest = sessions[0]?.creationTime;
    if (!newest || !reading.neighbours.length) return;
    const theirs = new Set(reading.neighbours.map((neighbour) => neighbour.id));
    reading.neighbourRuns = (await reader.sessionsCreatedAfter(new Date(Date.parse(newest) - DAY))).flatMap((session) =>
      session.jobId && session.creationTime && theirs.has(session.jobId) ? [{ jobId: session.jobId, start: session.creationTime, end: endOf(session) }] : [],
    );
  });
  if (missing.length) reading.error = missing.join('; ');
  return reading;
};

/** `work` over `items`, `POOL` at a time. One that fails leaves its place empty. */
const pooled = async <T, R>(items: T[], work: (item: T) => Promise<R>): Promise<Array<R | undefined>> => {
  const out = new Array<R | undefined>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          out[index] = await work(items[index]);
        } catch {
          out[index] = undefined;
        }
      }
    }),
  );
  return out;
};
