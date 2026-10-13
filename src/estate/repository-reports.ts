import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamSession } from '../veeam/types';
import { Answer } from './answer';
import { ReportPrinter } from './report-printer';
import { reportPage, stampOf } from './repository-report-page';
import { RepositoryReading, ReportJob, reportOf, repositoriesNamed, ServerReading, tb } from './repository-report';
import { loadOf } from './run-speed';
import { ServerEstates } from './server-estates';
import { escapeHtml } from '../telegram/format';
import { plural } from '../telegram/time';

/**
 * A reading is kept this long: a second `/repos`, for one repository say,
 * draws the same reading again rather than asking every server once more.
 */
const FRESH_MS = 30 * 60_000;
/** Requests in flight to one server at a time. */
const POOL = 6;
/** A job's newest finished attempts whose logs say how busy each stage was. */
const LOAD_ATTEMPTS = 2;

/**
 * The Repository report, read and printed when somebody asks for it.
 *
 * It reads every server, whichever is selected: a share is attached to
 * several of them, and its page is about all the jobs that fill it. That is
 * a few hundred requests — every job's configuration, a fortnight of
 * sessions, a log per job, the files of every backup — so it is read on
 * demand only, never by a cycle, at most one reading at a time, and kept for
 * half an hour.
 */
@Injectable()
export class RepositoryReports {
  private readonly logger = new Logger(RepositoryReports.name);
  private readonly config: AppConfig['report'];
  private readonly timezone: string;
  private kept?: RepositoryReading;
  private reading?: Promise<RepositoryReading>;

  constructor(
    config: ConfigService,
    private readonly estates: ServerEstates,
    private readonly printer: ReportPrinter,
  ) {
    this.config = config.getOrThrow<AppConfig['report']>('report');
    this.timezone = config.getOrThrow<AppConfig['telegram']>('telegram').timezone;
  }

  /**
   * The report as a PDF: every repository, or those `query` names, which then
   * get their own pages and no cover. A name that matches none is answered
   * with the names there are.
   */
  async answer(query: string): Promise<Answer> {
    const report = reportOf(await this.read(), this.config.sites, this.timezone);
    const asked = query.trim();
    const chosen = repositoriesNamed(report, asked);
    if (asked && !chosen.length) {
      return {
        text: [
          `🔍 <b>Репозитория «${escapeHtml(asked)}» нет</b>`,
          '',
          `Есть: ${report.repositories.map((repository) => escapeHtml(repository.short)).join(', ')}.`,
        ].join('\n'),
      };
    }
    const content = await this.printer.print(reportPage(report, asked ? chosen : undefined, this.timezone));
    const stamp = stampOf(report.at, this.timezone);
    if (asked) {
      const words = chosen.map((repository) => `${STATUS_ICON[repository.status]} <b>${escapeHtml(repository.short)}</b> — ${escapeHtml(repository.verdict)}`);
      return {
        text: ['📄 <b>Репозитории Veeam</b>', ...words, '', `<i>Данные за ${report.days} дней, на ${stamp}.</i>`].join('\n'),
        document: { filename: `Репозиторий ${chosen.map((repository) => repository.short.replace(/ · /g, ' ')).join(', ')} ${stamp.slice(0, 10)}.pdf`, content },
      };
    }
    const counts = (['crit', 'warn', 'ok', 'unknown'] as const)
      .map((status) => [status, report.repositories.filter((repository) => repository.status === status).length] as const)
      .filter(([, count]) => count)
      .map(([status, count]) => `${STATUS_ICON[status]} ${count} ${STATUS_WORD[status]}`);
    const silent = report.servers.filter((server) => !server.answered).map((server) => escapeHtml(server.name));
    const orphaned = report.repositories.reduce((sum, repository) => sum + repository.orphanBytes, 0);
    return {
      text: [
        `📄 <b>Репозитории Veeam</b> — ${report.repositories.length} ${plural(report.repositories.length, 'хранилище', 'хранилища', 'хранилищ')}`,
        counts.join(' · '),
        ...(orphaned ? [`Без задачи: ${tb(orphaned)} ТБ`] : []),
        ...(silent.length ? [`Не ответил: ${silent.join(', ')}`] : []),
        '',
        `<i>Данные за ${report.days} дней, на ${stamp}. Один репозиторий: /repos имя.</i>`,
      ].join('\n'),
      document: { filename: `Репозитории Veeam ${stamp.slice(0, 10)}.pdf`, content },
    };
  }

  /** The kept reading while it is fresh; else a new one, shared by everybody who asks meanwhile. */
  private async read(): Promise<RepositoryReading> {
    if (this.kept && Date.now() - this.kept.at < FRESH_MS) return this.kept;
    if (!this.reading) {
      this.reading = (async () => {
        const since = new Date(Date.now() - this.config.days * 86_400_000);
        const servers = await Promise.all(this.estates.all.map((estate) => readServer(estate.name, estate.reader, since)));
        for (const server of servers) if (server.error) this.logger.warn(`Repository report: ${server.server} read in part: ${server.error}`);
        return { at: Date.now(), days: this.config.days, servers };
      })().finally(() => (this.reading = undefined));
      this.kept = await this.reading;
      return this.kept;
    }
    return this.reading;
  }
}

/**
 * Everything the report needs from one server. A request that fails stops
 * the reading of that server, and what was read before it is kept: a server
 * that answered its repositories and then timed out on its jobs is still
 * worth a line about its free space.
 */
export const readServer = async (server: string, reader: VeeamEstateReader, since: Date): Promise<ServerReading> => {
  const reading: ServerReading = { server, repositories: [], jobs: [], attempts: [], loads: [], working: [], backups: [] };
  try {
    reading.repositories = await reader.repositoryStates();
    const ids = new Set(reading.repositories.flatMap((repository) => (repository.id ? [repository.id] : [])));

    // A replica names its repository only on a job read by id.
    const listed = (await reader.jobConfigurations()).filter((job) => job.id);
    const whole = await pooled(listed, (job) =>
      !job.storage?.backupRepositoryId && /replica/i.test(job.type ?? '') ? reader.jobConfiguration(job.id as string) : Promise.resolve(job),
    );
    reading.jobs = listed.map((job, index): ReportJob => ({
      id: job.id as string,
      name: job.name ?? (job.id as string),
      type: job.type,
      disabled: Boolean(job.isDisabled),
      schedule: job.schedule,
      backupRepositoryId: (whole[index] ?? job).storage?.backupRepositoryId,
      metadataRepositoryId: (whole[index] ?? job).jobSettings?.metadataRepositoryId,
    }));
    const writing = new Set(
      reading.jobs
        .filter((job) => ids.has(job.backupRepositoryId ?? '') || ids.has(job.metadataRepositoryId ?? ''))
        .map((job) => job.id),
    );

    const sessions = (await reader.sessionsCreatedAfter(since)).filter(
      (session): session is VeeamSession & { id: string; jobId: string; creationTime: string } =>
        Boolean(session.id && session.jobId && session.creationTime && writing.has(session.jobId)),
    );
    reading.attempts = sessions.map((session) => ({
      jobId: session.jobId,
      startedAt: session.creationTime,
      endedAt: endOf(session),
      result: session.result?.result ?? '',
    }));

    // Newest first, as read: the first finished ones of each job.
    const measured = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const list = measured.get(session.jobId) ?? [];
      if (endOf(session) && list.length < LOAD_ATTEMPTS) measured.set(session.jobId, [...list, session]);
    }
    const asked = [...measured.values()].flat();
    const loads = await pooled(asked, async (session) => loadOf((await reader.sessionLog(session.id)).map((record) => record.title ?? '')));
    reading.loads = asked.flatMap((session, index) => {
      const load = loads[index];
      return load ? [{ jobId: session.jobId, load }] : [];
    });

    reading.working = (await reader.workingSessions()).sessions.flatMap((session) =>
      session.jobId && session.creationTime ? [{ jobId: session.jobId, since: session.creationTime, percent: session.progressPercent }] : [],
    );

    const backups = (await reader.backups()).filter((backup) => backup.id);
    // A backup whose files cannot be read is still listed, with no size.
    const files = await pooled(backups, (backup) => reader.backupFiles(backup.id as string));
    reading.backups = backups.map((backup, index) => {
      const its = files[index] ?? [];
      const newest = its.map((file) => file.creationTime ?? '').sort().pop();
      return {
        name: backup.name ?? (backup.id as string),
        platform: backup.platformName,
        repositoryId: backup.repositoryId,
        jobId: backup.jobId,
        size: its.reduce((sum, file) => sum + (file.backupSize ?? 0), 0),
        ...(newest ? { newest } : {}),
      };
    });
  } catch (error) {
    reading.error = (error as Error).message;
  }
  return reading;
};

/** When a session ended; a session still going has none, or Veeam's year-1900 placeholder. */
const endOf = (session: VeeamSession): string | undefined =>
  session.endTime && Date.parse(session.endTime) > Date.UTC(2000, 0, 1) ? session.endTime : undefined;

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

const STATUS_ICON = { crit: '🔴', warn: '🟡', ok: '🟢', unknown: '⚪' } as const;
const STATUS_WORD = { crit: 'критично', warn: 'внимание', ok: 'норма', unknown: 'нет данных' } as const;
