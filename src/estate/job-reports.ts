import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from '../telegram/format';
import { instantOf } from '../veeam/estate';
import { Answer } from './answer';
import { JOB_REPORT_DAYS, JobReading, jobReportOf } from './job-report';
import { judgementOf, ProtectionThresholds, thresholdsOf } from './job-standing';
import { printedAnswer, STATUS_ICON, STATUS_WORD } from './report-envelope';
import { ReportPrinter } from './report-printer';
import { jobsWriting, writesTo } from './repository-writers';
import { ServerEstate } from './server-estates';
import { jobReportPage } from './job-report-page';
import { sessionReportOf } from './session-report';

const DAY = 86_400_000;

/**
 * The Job report, read and printed when somebody presses its Button under a
 * Job card: one job on one server, over a month. Some eighty requests — the
 * job's sessions and every one's machines, the logs of those that failed, the
 * backups and their files, the repository and who else writes there, a
 * replica read by itself — so it is read on demand only, and printed by the
 * same browser as the Repository report, one at a time. Its points are the
 * server's Evidence's, read by the scan already, and judged by 🛡's
 * thresholds.
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

  /**
   * The report on job `id` of `estate`, asked for: said at once to be coming,
   * and how long it takes, with the PDF to follow. Its points are the last
   * scan's, so what it says it reads is the month's runs and machines.
   */
  asked(estate: ServerEstate, id: string): Answer {
    return {
      text: [
        '⏳ <b>Готовлю отчёт по заданию</b>',
        '',
        `Читаю запуски и машины за ${JOB_REPORT_DAYS} дней — это 20–30 секунд.`,
        'PDF придёт сюда, а бот пока отвечает на другие команды.',
      ].join('\n'),
      later: () => this.answer(estate, id),
    };
  }

  /** The report on job `id` of `estate`, as a PDF; a job that is gone is said so. */
  async answer(estate: ServerEstate, id: string): Promise<Answer> {
    const reading = await readJob(estate, id, Date.now(), this.timezone, this.thresholds);
    if (!reading) return { text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.' };
    if (reading.error) this.logger.warn(`Job report: ${estate.name} ${reading.job.name} read in part: ${reading.error}`);
    const report = jobReportOf(reading, this.timezone);
    const content = await this.printer.print(jobReportPage(report, sessionReportOf(reading, this.timezone), this.timezone));
    return printedAnswer(
      {
        title: report.name,
        beside: `${STATUS_ICON[report.status]} ${STATUS_WORD[report.status].toLowerCase()}`,
        lines: [escapeHtml(report.verdict), ...(report.partial ? ['⚠️ Прочитано не всё — что именно, сказано в отчёте.'] : [])],
        covers: `${report.server} · за ${report.days} дней`,
        file: `Задание ${report.name}`,
      },
      content,
      report.at,
      this.timezone,
    );
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
    // A replica among them, which names the repository only in its own settings, as the Repository report has it.
    reading.neighbours = (await jobsWriting(reader)).flatMap((other) => (other.id !== id && writesTo(other, repositoryId) ? [{ id: other.id, name: other.name }] : []));
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
