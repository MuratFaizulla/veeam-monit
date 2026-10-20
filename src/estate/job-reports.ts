import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from '../telegram/format';
import { instantOf } from '../veeam/estate';
import { Answer } from './answer';
import { JOB_REPORT_DAYS, JobReading, jobReportOf } from './job-report';
import { judgementOf, ProtectionThresholds, thresholdsOf } from './job-standing';
import { ReportPrinter } from './report-printer';
import { stampOf } from './repository-report-page';
import { ServerEstate } from './server-estates';
import { jobReportPage } from './job-report-page';
import { sessionReportOf } from './session-report';

const DAY = 86_400_000;

const STATUS_ICON = { crit: '🔴', warn: '🟡', ok: '🟢', unknown: '⚪' } as const;
const STATUS_WORD = { crit: 'критично', warn: 'внимание', ok: 'норма', unknown: 'нет данных' } as const;

/**
 * The Job report, read and printed when somebody presses its Button under a
 * Job card: one job on one server, over a month. Some eighty requests — the
 * job's sessions and every one's machines, the logs of those that failed, the
 * backups and their files, the repository and who else writes there — so it
 * is read on demand only, and printed by the same browser as the Repository
 * report, one at a time. Its points are the server's Evidence's, read by the
 * scan already, and judged by 🛡's thresholds.
 */
@Injectable()
export class JobReports {
  private readonly logger = new Logger(JobReports.name);
  private readonly timezone: string;
  private readonly thresholds: ProtectionThresholds;

  constructor(
    config: ConfigService,
    private readonly printer: ReportPrinter,
  ) {
    const telegram = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.timezone = telegram.timezone;
    this.thresholds = thresholdsOf(telegram);
  }

  /** The report on job `id` of `estate`, as a PDF; a job that is gone is said so. */
  async answer(estate: ServerEstate, id: string): Promise<Answer> {
    const reading = await readJob(estate, id, Date.now(), this.timezone, this.thresholds);
    if (!reading) return { text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.' };
    if (reading.error) this.logger.warn(`Job report: ${estate.name} ${reading.job.name} read in part: ${reading.error}`);
    const report = jobReportOf(reading, this.timezone);
    const content = await this.printer.print(jobReportPage(report, sessionReportOf(reading, this.timezone), this.timezone));
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
 * server no longer has the job. The job's month is its Job reads': its
 * attempts are the report, and throw when they cannot be read. Its points are
 * the server's Evidence's, judged against `now` by `thresholds` as 🛡 judges
 * them; while there is none, why not. What else could not be read, of the
 * month or beside it, is said in `error`, and the rest is kept.
 */
export const readJob = async (
  estate: Pick<ServerEstate, 'name' | 'reader' | 'reads' | 'evidence'>,
  id: string,
  now: number,
  timezone: string,
  thresholds: ProtectionThresholds,
  days = JOB_REPORT_DAYS,
): Promise<JobReading | undefined> => {
  const { reader } = estate;
  const job = (await reader.jobStates()).find((candidate) => candidate.id === id);
  if (!job) return undefined;
  const { missing, ...month } = await estate.reads.historyOf(job, now - days * DAY);
  // Every restore point of the server, read again for one job, is what the scan read already.
  const scanned = estate.evidence.evidence;
  const evidence: JobReading['evidence'] =
    scanned.status === 'ready' ? { status: 'ready', ...judgementOf(job, scanned, { now: new Date(now), timezone }, thresholds) } : scanned;
  const reading: JobReading = { at: now, days, server: estate.name, job, ...month, evidence, files: [], neighbours: [], neighbourRuns: [] };
  const step = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      missing.push(`${what}: ${(error as Error).message}`);
    }
  };

  const repositoryId = reading.configured?.storage?.backupRepositoryId ?? reading.configured?.jobSettings?.metadataRepositoryId;
  await step('репозиторий', async () => {
    if (repositoryId) reading.repository = (await reader.repositoryStates()).find((repository) => repository.id === repositoryId);
  });
  await step('бэкапы', async () => {
    const backups = (await reader.backups()).filter((backup) => backup.id && backup.jobId === id);
    // A job has a backup or two: nothing to take turns over.
    reading.files = (await Promise.all(backups.map((backup) => reader.backupFiles(backup.id as string)))).flat();
  });
  await step('соседи', async () => {
    if (!repositoryId) return;
    reading.neighbours = (await reader.jobConfigurations()).flatMap((other) =>
      other.id && other.id !== id && other.storage?.backupRepositoryId === repositoryId ? [{ id: other.id, name: other.name ?? other.id }] : [],
    );
    const newest = instantOf(reading.attempts[0]?.session.creationTime, timezone);
    if (newest === undefined || !reading.neighbours.length) return;
    const theirs = new Set(reading.neighbours.map((neighbour) => neighbour.id));
    reading.neighbourRuns = (await reader.sessionsCreatedAfter(new Date(newest - DAY))).flatMap((session) =>
      session.jobId && session.creationTime && theirs.has(session.jobId) ? [{ jobId: session.jobId, start: session.creationTime, end: session.endTime }] : [],
    );
  });
  if (missing.length) reading.error = missing.join('; ');
  return reading;
};
