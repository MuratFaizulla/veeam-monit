import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from '../telegram/format';
import { plural } from '../telegram/time';
import { instantOf, Job } from '../veeam/estate';
import { saidOf } from '../veeam/session-text';
import { VeeamBackupFile } from '../veeam/types';
import { Answer } from './answer';
import { JobReads } from './job-reads';
import { judgementOf, ProtectionThresholds, thresholdsOf, VerdictWords } from './job-standing';
import { CALENDAR_DAYS } from './points-calendar';
import { MachineError, momentLabel, nextFullWords, PointsReading, pointsReportOf, PointsUnseen } from './points-report';
import { pointsReportPage } from './points-report-page';
import { printedAnswer } from './report-envelope';
import { ReportPrinter } from './report-printer';
import { ServerEstate } from './server-estates';

const DAY = 86_400_000;

/**
 * Failed attempts of the job's newest whose machines are asked what went
 * wrong, a request each: a week of a nightly job that fails with every retry.
 */
const FAILED_ATTEMPTS = 8;

/**
 * The Points report, read and printed when somebody asks for a job's points:
 * the 🗂 key of the points menu, `/points name`, the 🗂 Button under a Job
 * card or 🔄 under the report itself. Its points are the Evidence's, read by
 * the scan already and judged by 🛡's thresholds; what is read when asked is
 * the job's backup files, as /points always did, its configuration — the
 * repository, the machines it names — and the machines of its newest failed
 * attempts, which say why they failed: a dozen requests. Printed by the same
 * browser as the other reports, one at a time, in the same envelope.
 */
@Injectable()
export class PointsReports {
  private readonly logger = new Logger(PointsReports.name);
  private readonly timezone: string;
  private readonly thresholds: ProtectionThresholds;
  /** The 🛡 topic's name, without its icon: the page says the points are as that topic sees them. */
  private readonly topic: string;

  constructor(
    config: ConfigService,
    private readonly printer: ReportPrinter,
  ) {
    const telegram = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.timezone = telegram.timezone;
    this.thresholds = thresholdsOf(telegram);
    this.topic = telegram.liveTopics.protection.replace(/^[^\p{L}\p{N}]+/u, '') || 'Protection';
  }

  /**
   * The points of `job` on `estate`, asked for: said at once to be coming,
   * with the PDF to follow — or, when there is nothing to draw, said at once
   * instead: no Evidence yet, or points the scan does not read.
   */
  asked(estate: ServerEstate, job: Job): Answer {
    const seen = pointsReportOf(this.known(estate, job, Date.now()).reading, this.timezone);
    if (!seen.drawn) return { ...unseenAnswer(seen), jobId: job.id, about: 'points' };
    return {
      text: `⏳ <b>Готовлю PDF по точкам ${escapeHtml(job.name)}</b> — несколько секунд.`,
      later: () => this.answer(estate, job),
    };
  }

  /** The points of `job` on `estate`, as a PDF with its caption, and the Buttons that ask again or open its card. */
  async answer(estate: ServerEstate, job: Job): Promise<Answer> {
    const { reading: known, backups } = this.known(estate, job, Date.now());
    const reading = await readPoints(estate, known, backups, this.timezone);
    const report = pointsReportOf(reading, this.timezone);
    const addressed = { jobId: job.id, about: 'points' as const, server: estate.key };
    if (!report.drawn) return { ...unseenAnswer(report), ...addressed };
    const content = await this.printer.print(pointsReportPage(report, this.timezone));
    const lines = [
      ...verdictLines(report.verdict),
      ...(report.newest !== undefined && report.depth
        ? [`Последняя точка ${momentLabel(report.newest, this.timezone)} · откат на ${report.depth.points} ${plural(report.depth.points, 'точку', 'точки', 'точек')}, до ${momentLabel(report.depth.oldest, this.timezone)}`]
        : ['Точек нет.']),
      ...(report.next ? [`Следующий Full: ${nextFullWords(report.next)}`] : []),
    ];
    this.logger.log(`Points report: ${estate.name} ${job.name}, ${report.calendar.rows.length} machines`);
    return {
      ...printedAnswer(
        { icon: '🗂', title: report.name, kind: 'точки восстановления', lines, covers: `${report.server} · за ${CALENDAR_DAYS} дней`, file: `Точки ${report.name}` },
        content,
        report.at,
        this.timezone,
      ),
      ...addressed,
    };
  }

  /** What the server's Evidence knows of `job` at `now`, before anything is read for it, and where its files are. */
  private known(estate: ServerEstate, job: Job, now: number): { reading: PointsReading; backups: readonly string[] } {
    const scanned = estate.evidence.evidence;
    const base = { at: now, server: estate.name, job, failures: [], named: [], topic: this.topic };
    if (scanned.status === 'pending') return { reading: { ...base, evidence: scanned }, backups: [] };
    const reading: PointsReading = {
      ...base,
      evidence: {
        status: 'ready',
        scannedAt: scanned.scannedAt,
        // By the verdict 🛡 lists the job by, so the two cannot disagree about it.
        ...judgementOf(job, scanned, { now: new Date(now), timezone: this.timezone }, this.thresholds),
        schedule: scanned.schedulesByJob.get(job.id),
        setAside: scanned.machineFailuresByJob.get(job.id) ?? [],
      },
    };
    return { reading, backups: scanned.backupsByJob.get(job.id) ?? [] };
  }
}

/**
 * What one job's Points report reads beside the Evidence, asked of its
 * server: its backup files, a request a backup — what its points take up —
 * its configuration, the repository's name and the machines it names, and
 * the machines of its newest failed attempts with what Veeam said of them.
 * Best effort, all of it: a report without one of them is still the answer.
 */
export const readPoints = async (
  estate: Pick<ServerEstate, 'reader' | 'reads' | 'inventory'>,
  reading: PointsReading,
  backups: readonly string[],
  timezone: string,
): Promise<PointsReading> => {
  if (reading.evidence.status !== 'ready' || reading.evidence.byRuns) return reading;
  const { job } = reading;
  const [files, configured, names, failures] = await Promise.all([
    filesOf(estate.reader, backups),
    estate.reads.configurationOf(job),
    estate.inventory.names(),
    failuresOf(estate.reads, job, reading.at - CALENDAR_DAYS * DAY, timezone),
  ]);
  const repositoryId = configured?.storage?.backupRepositoryId;
  const repository = repositoryId ? names.repositories.get(repositoryId) : undefined;
  const named = (configured?.virtualMachines?.includes ?? [])
    .filter((object) => /virtualmachine/i.test(object.type ?? '') && object.name)
    .map((object) => object.name as string);
  return { ...reading, failures, named, ...(files ? { files } : {}), ...(repository ? { repository } : {}) };
};

const logger = new Logger(PointsReports.name);

/** The job's backup files; undefined when Veeam would not give them, which is not none. */
const filesOf = async (reader: ServerEstate['reader'], backups: readonly string[]): Promise<VeeamBackupFile[] | undefined> => {
  try {
    return (await Promise.all(backups.map((backup) => reader.backupFiles(backup)))).flat();
  } catch (error) {
    logger.warn(`Backup files could not be read: ${(error as Error).message}`);
    return undefined;
  }
};

/**
 * The machines that failed in the job's newest failed attempts since `since`,
 * and what Veeam said of each, a line worth showing: the Job reads'.
 */
const failuresOf = async (reads: JobReads, job: Job, since: number, timezone: string): Promise<MachineError[]> => {
  const failed = (await reads.sessionsOf(job))
    .filter((session) => session.result === 'failed' && (instantOf(session.startedAt, timezone) ?? -Infinity) >= since)
    .slice(0, FAILED_ATTEMPTS);
  const machines = await Promise.all(failed.map((session) => reads.machinesOf(session)));
  return failed.flatMap((session, place) =>
    machines[place]
      .filter((machine) => machine.result === 'failed')
      .map((machine) => {
        const reason = saidOf(machine.message);
        return { machine: machine.name, at: instantOf(session.startedAt, timezone) as number, ...(reason ? { reason } : {}) };
      }),
  );
};

/** 🛡's verdict as the caption says it: what is wrong in bold, the facts under it. */
const verdictLines = ({ icon, problem, facts }: VerdictWords): string[] => [
  `${icon} <b>${escapeHtml(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}`)}</b>`,
  ...(facts.length ? [`<i>${escapeHtml(facts.join(' · '))}</i>`] : []),
];

/** What is said of a job's points with nothing to draw: why, and 🛡's verdict where there is one. */
const unseenAnswer = (seen: PointsUnseen): Answer => ({
  text: [
    `🗂 <b>${escapeHtml(seen.name)}</b> · точки восстановления`,
    '',
    ...(seen.verdict ? [...verdictLines(seen.verdict), ''] : []),
    escapeHtml(seen.why),
  ].join('\n'),
});

