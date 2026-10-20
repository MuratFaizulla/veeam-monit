import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamRepositoryState, VeeamSession } from '../veeam/types';
import { Answer } from './answer';
import { printedAnswer, STATUS_ICON, STATUS_WORD } from './report-envelope';
import { ReportPrinter } from './report-printer';
import { reportPage } from './repository-report-page';
import { RepositoryReading, RepositoryReport, reportOf, repositoriesNamed, ServerReading, tb } from './repository-report';
import { jobsWriting, writesTo } from './repository-writers';
import { loadOf } from './run-speed';
import { ServerEstates } from './server-estates';
import { settled, valueOf } from './settled';
import { escapeHtml } from '../telegram/format';
import { plural } from '../telegram/time';

/**
 * A reading is kept this long: a second `/repos`, for one repository say,
 * draws the same reading again rather than asking every server once more.
 */
const FRESH_MS = 30 * 60_000;
/** A job's newest finished attempts whose logs say how busy each stage was. */
const LOAD_ATTEMPTS = 2;

/** A repository as the report's menu offers it. */
export interface ReportChoice {
  /** "BKP03": what its key says and `/repos` is asked with. */
  short: string;
  site: string;
  /** Undefined when Veeam gives no capacity. */
  freePercent?: number;
}

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
  /** Each server's repositories as its cycle last read them. */
  private readonly seen = new Map<string, VeeamRepositoryState[]>();

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
    if (asked && !chosen.length) return noSuch(asked, report);
    const content = await this.printer.print(reportPage(report, asked ? chosen : undefined, this.timezone));
    const covers = `Данные за ${report.days} дней`;
    if (asked) {
      return printedAnswer(
        {
          title: 'Репозитории Veeam',
          lines: chosen.map((repository) => `${STATUS_ICON[repository.status]} <b>${escapeHtml(repository.short)}</b> — ${escapeHtml(repository.verdict)}`),
          covers,
          file: `Репозиторий ${chosen.map((repository) => repository.short.replace(/ · /g, ' ')).join(', ')}`,
        },
        content,
        report.at,
        this.timezone,
      );
    }
    const counts = (['crit', 'warn', 'ok', 'unknown'] as const)
      .map((status) => [status, report.repositories.filter((repository) => repository.status === status).length] as const)
      .filter(([, count]) => count)
      .map(([status, count]) => `${STATUS_ICON[status]} ${count} ${STATUS_WORD[status].toLowerCase()}`);
    const silent = report.servers.filter((server) => !server.answered).map((server) => escapeHtml(server.name));
    const orphaned = report.repositories.reduce((sum, repository) => sum + repository.orphanBytes, 0);
    return printedAnswer(
      {
        title: 'Репозитории Veeam',
        beside: `${report.repositories.length} ${plural(report.repositories.length, 'хранилище', 'хранилища', 'хранилищ')}`,
        lines: [counts.join(' · '), ...(orphaned ? [`Без задачи: ${tb(orphaned)} ТБ`] : []), ...(silent.length ? [`Не ответил: ${silent.join(', ')}`] : [])],
        covers,
        hint: 'Один репозиторий: /repos имя.',
        file: 'Репозитории Veeam',
      },
      content,
      report.at,
      this.timezone,
    );
  }

  /**
   * The repositories a cycle has just read on `server`. The cycle reads them
   * every minute for their free space anyway, so the menu lists them, and a
   * name is checked, without asking Veeam again.
   */
  saw(server: string, repositories: VeeamRepositoryState[]): void {
    this.seen.set(server, repositories);
  }

  /** Every repository there is, in the report's order. */
  choices(): ReportChoice[] {
    return this.known().repositories.map(({ short, site, capacityGB, freePercent }) => ({
      short,
      site,
      ...(capacityGB ? { freePercent } : {}),
    }));
  }

  /**
   * The report asked for with `query`, answered at once, before it is read:
   * that it is coming, about which repositories, and whether it takes a
   * minute or two or, from a kept reading, seconds — with the PDF to follow.
   * A name that matches nothing is said now, not in two minutes, and nothing
   * follows.
   */
  asked(query: string): Answer {
    const asked = query.trim();
    const known = this.known();
    const chosen = repositoriesNamed(known, asked);
    // Nothing seen yet, the minute after a start, is no reason to refuse a name: it is said as typed.
    if (asked && !chosen.length && known.repositories.length) return noSuch(asked, known);
    const names = !asked ? [] : chosen.length ? chosen.map((repository) => repository.short) : [asked];
    return {
      text: [
        names.length ? `⏳ <b>Готовлю отчёт: ${names.map((name) => escapeHtml(name)).join(', ')}</b>` : '⏳ <b>Готовлю отчёт по всем репозиториям</b>',
        '',
        ...(this.fresh()
          ? ['Данные собраны недавно — PDF будет через несколько секунд.']
          : ['Собираю данные со всех серверов Veeam — это 1–2 минуты.', 'PDF придёт сюда, а бот пока отвечает на другие команды.']),
      ].join('\n'),
      later: () => this.answer(query),
    };
  }

  /**
   * The repositories alone, without a job: enough to name and order them.
   * As each server's cycle last read them, or else as the last reading did.
   */
  private known(): RepositoryReport {
    const servers = this.estates.all.flatMap((estate): ServerReading[] => {
      const repositories = this.seen.get(estate.name) ?? this.kept?.servers.find((server) => server.server === estate.name)?.repositories;
      return repositories ? [{ server: estate.name, repositories, jobs: [], attempts: [], loads: [], working: [], backups: [] }] : [];
    });
    return reportOf({ at: Date.now(), days: this.config.days, servers }, this.config.sites, this.timezone);
  }

  private fresh(): RepositoryReading | undefined {
    return this.kept && Date.now() - this.kept.at < FRESH_MS ? this.kept : undefined;
  }

  /** The kept reading while it is fresh; else a new one, shared by everybody who asks meanwhile. */
  private async read(): Promise<RepositoryReading> {
    const fresh = this.fresh();
    if (fresh) return fresh;
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
    reading.jobs = await jobsWriting(reader);
    const writing = new Set(
      reading.jobs.filter((job) => reading.repositories.some((repository) => writesTo(job, repository.id))).map((job) => job.id),
    );

    const sessions = (await reader.sessionsCreatedAfter(since)).filter(
      (session): session is VeeamSession & { id: string; jobId: string; creationTime: string } =>
        Boolean(session.id && session.jobId && session.creationTime && writing.has(session.jobId)),
    );
    reading.attempts = sessions.map((session) => ({
      jobId: session.jobId,
      startedAt: session.creationTime,
      endedAt: session.endTime,
      result: session.result?.result ?? '',
    }));

    // Newest first, as read: the first finished ones of each job.
    const measured = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const list = measured.get(session.jobId) ?? [];
      if (session.endTime && list.length < LOAD_ATTEMPTS) measured.set(session.jobId, [...list, session]);
    }
    const asked = [...measured.values()].flat();
    const loads = await settled(asked, async (session) => loadOf((await reader.sessionLog(session.id)).map((record) => record.title ?? '')));
    reading.loads = asked.flatMap((session, index) => {
      const load = valueOf(loads[index]);
      return load ? [{ jobId: session.jobId, load }] : [];
    });

    reading.working = (await reader.workingSessions()).sessions.flatMap((session) =>
      session.jobId && session.creationTime ? [{ jobId: session.jobId, since: session.creationTime, percent: session.progressPercent }] : [],
    );

    const backups = (await reader.backups()).filter((backup) => backup.id);
    // A backup whose files cannot be read is still listed, with no size.
    const files = await settled(backups, (backup) => reader.backupFiles(backup.id as string));
    reading.backups = backups.map((backup, index) => {
      const its = valueOf(files[index]) ?? [];
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

/** A name that matches no repository, answered with the names there are. */
const noSuch = (asked: string, report: RepositoryReport): Answer => ({
  text: [
    `🔍 <b>Репозитория «${escapeHtml(asked)}» нет</b>`,
    '',
    `Есть: ${report.repositories.map((repository) => escapeHtml(repository.short)).join(', ')}.`,
  ].join('\n'),
});
