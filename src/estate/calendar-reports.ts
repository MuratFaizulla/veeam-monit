import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from '../telegram/format';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { fromServerClock, Job } from '../veeam/estate';
import { VeeamJob, VeeamProxy } from '../veeam/types';
import {
  CalendarFinding, CalendarJob, CalendarPlan, CalendarReport, CalendarResult, CalendarRun, freeStretches, fromNoon, heaviestFullDay, hm, nightLoad, overran,
} from './calendar-report';
import { retentionFrom } from './evidence';
import { describeFulls, FullSchedule, fullSchedulesOf, isFullDay } from './full-schedule';
import { isDisabled } from './job-state';
import { Answer } from './answer';
import { calendarReportPage } from './calendar-report-page';
import { retentionWords } from './point-facts';
import { printedAnswer, STATUS_ICON } from './report-envelope';
import { ReportPrinter } from './report-printer';
import { ServerEstate } from './server-estates';
import { fullSessionsOf } from './repository-reports';
import { retryWindowOf, runsOf } from './runs';
import { dayIn, describeSchedule, scheduledStarts, timetableOf } from './schedule-planner';
import { valueOf } from './settled';

/**
 * The Calendar report, read from one server: every job's schedule and Fulls,
 * and its sessions from a month before the month shown — the month for what
 * happened, the month before it for how long a run usually goes.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The night window, as the Repository report has it. */
const WINDOW = { from: 18 * 60, to: 7 * 60 };
/** How far back the usual length of a run is judged from, beyond the month shown. */
const HISTORY_DAYS = 31;

const MONTHS_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** One session of a job, as the calendar needs it. */
export interface CalendarAttempt {
  jobId: string;
  startedAt: string;
  endedAt?: string;
  result: string;
  /** Whether it wrote a Full; absent when its points do not say. */
  full?: boolean;
}

/** What is read from the server. */
export interface CalendarReading {
  server: string;
  /** When it was read. */
  at: number;
  timezone: string;
  /** The jobs as listed, for their state and next start. */
  states: Job[];
  /** Their configurations: schedule, storage. */
  configurations: VeeamJob[];
  /** Repository id → name. */
  repositories: Map<string, string>;
  attempts: CalendarAttempt[];
  /** The backup proxies; empty when they could not be read. */
  proxies: VeeamProxy[];
  /** Job id → the machines it keeps restore points of. */
  machines: Map<string, string[]>;
}

/** Reads one server for the calendar of the month `at` falls in. */
export const readCalendar = async (
  server: string,
  reader: Pick<VeeamEstateReader, 'jobStates' | 'jobConfigurations' | 'repositoryStates' | 'sessionsCreatedAfter' | 'restorePoints' | 'backups' | 'proxies'>,
  at: number,
  timezone: string,
): Promise<CalendarReading> => {
  const { year, month } = monthOf(at, timezone);
  const since = new Date(fromServerClock(Date.UTC(year, month, 1), timezone) - HISTORY_DAYS * DAY_MS);
  const [states, configurations, repositories, sessions, read, backups, proxies] = await Promise.allSettled([
    reader.jobStates(),
    reader.jobConfigurations(),
    reader.repositoryStates(),
    reader.sessionsCreatedAfter(since),
    reader.restorePoints(),
    reader.backups(),
    reader.proxies(),
  ]);
  if (states.status === 'rejected') throw states.reason;
  if (sessions.status === 'rejected') throw sessions.reason;
  const points = valueOf(read) ?? [];
  const full = fullSessionsOf(points);
  // The machines of each job: a restore point names its machine and its backup, the backup its job.
  const jobOfBackup = new Map((valueOf(backups) ?? []).flatMap((backup) => (backup.id && backup.jobId ? [[backup.id, backup.jobId] as [string, string]] : [])));
  const machines = new Map<string, Set<string>>();
  for (const point of points) {
    const jobId = point.backupId && jobOfBackup.get(point.backupId);
    if (!jobId || !point.name) continue;
    machines.set(jobId, (machines.get(jobId) ?? new Set()).add(point.name));
  }
  return {
    server,
    at,
    timezone,
    states: states.value,
    configurations: valueOf(configurations) ?? [],
    repositories: new Map(
      (valueOf(repositories) ?? []).flatMap((repository) => (repository.id && repository.name ? [[repository.id, repository.name] as [string, string]] : [])),
    ),
    attempts: sessions.value
      .filter((session) => session.id && session.jobId && session.creationTime && /Job$/.test(session.sessionType ?? ''))
      .map((session) => ({
        jobId: session.jobId as string,
        startedAt: session.creationTime as string,
        endedAt: session.endTime ?? undefined,
        result: (session.result?.result ?? '').toLowerCase(),
        ...(full.has(session.id as string) ? { full: full.get(session.id as string) } : {}),
      })),
    proxies: valueOf(proxies) ?? [],
    machines: new Map([...machines].map(([jobId, names]) => [jobId, [...names]])),
  };
};

/** The year and month (from 0) `at` falls in, in `timezone`. */
const monthOf = (at: number, timezone: string): { year: number; month: number; day: number } => {
  const day = new Date(dayIn(at, timezone));
  return { year: day.getUTCFullYear(), month: day.getUTCMonth(), day: day.getUTCDate() };
};

const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * Whether a run of `minutes` is far out of the job's usual `typical`: four
 * times as long and four hours longer at once. A ten-minute job that took an
 * hour was slow; one that took fourteen hours hung.
 */
export const isOutlier = (minutes: number, typical: number | undefined): boolean =>
  typical !== undefined && minutes > Math.max(typical * 4, typical + 240);

const RESULT: Record<string, CalendarResult> = { success: 'success', warning: 'warning', failed: 'failed' };

/** The report, figured from a reading. */
export const calendarOf = (reading: CalendarReading): CalendarReport => {
  const { timezone } = reading;
  const { year, month, day: today } = monthOf(reading.at, timezone);
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const midnight = (day: number) => fromServerClock(Date.UTC(year, month, day), timezone);
  /** Minutes after the local midnight of the day `at` falls on. */
  const minuteOf = (at: number) => Math.round((at - fromServerClock(dayIn(at, timezone), timezone)) / MINUTE_MS);

  const configured = new Map(reading.configurations.filter((job) => job.id).map((job) => [job.id as string, job]));
  const byJob = new Map<string, CalendarAttempt[]>();
  for (const attempt of reading.attempts) byJob.set(attempt.jobId, [...(byJob.get(attempt.jobId) ?? []), attempt]);

  // Each day's plan first, by name, so that a job run after another takes that one's days.
  const plans = new Map<string, CalendarPlan[]>();
  const planOf = (state: Job, depth = 0): CalendarPlan[] => {
    const known = plans.get(state.name);
    if (known) return known;
    const config = configured.get(state.id);
    const timetable = timetableOf(config?.schedule);
    const fulls = fullSchedulesOf(config?.storage) ?? [];
    let runs: boolean[];
    if (isDisabled(state) || !timetable || timetable.kind === 'manual') runs = new Array(days).fill(false);
    else if (timetable.kind === 'continuous') runs = new Array(days).fill(true);
    else if (timetable.kind === 'after') {
      const before = reading.states.find((candidate) => candidate.name === timetable.job);
      runs = before && depth < 8 ? planOf(before, depth + 1).map(Boolean) : new Array(days).fill(false);
    } else runs = Array.from({ length: days }, (_, index) => scheduledStarts(config?.schedule, midnight(index + 1), midnight(index + 2), timezone).length > 0);
    const plan = runs.map((runs, index): CalendarPlan => (runs ? (isFullDay(fulls, Date.UTC(year, month, index + 1)) ? 'full' : 'run') : undefined));
    plans.set(state.name, plan);
    return plan;
  };

  const jobs = reading.states.map((state): CalendarJob => {
    const config = configured.get(state.id);
    const timetable = timetableOf(config?.schedule);
    const fulls: FullSchedule[] | undefined = fullSchedulesOf(config?.storage);
    const planned = planOf(state);

    // Runs: a failure and Veeam's retries of it are one run.
    const newestFirst = [...(byJob.get(state.id) ?? [])].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const all = runsOf(newestFirst, retryWindowOf(config?.schedule)).map((run) => {
      const first = run.attempts[run.attempts.length - 1];
      const last = run.attempts[0];
      const started = Date.parse(first.startedAt);
      const ended = last.endedAt ? Date.parse(last.endedAt) : undefined;
      const local = new Date(dayIn(started, timezone));
      const known = run.attempts.some((attempt) => attempt.full !== undefined);
      return {
        started,
        local: local.getTime(),
        inMonth: local.getUTCFullYear() === year && local.getUTCMonth() === month,
        day: local.getUTCDate(),
        start: minuteOf(started),
        minutes: ended === undefined ? Math.round((reading.at - started) / MINUTE_MS) : Math.round((ended - started) / MINUTE_MS),
        result: ended === undefined ? ('running' as const) : RESULT[run.result] ?? ('warning' as const),
        full: (known ? run.attempts.some((attempt) => attempt.full === true) : undefined) as boolean | undefined,
      };
    });
    // A run whose points do not say is a Full when it is the first of a day the job owes one.
    const begun = new Set<number>();
    for (const run of [...all].sort((a, b) => a.started - b.started)) {
      if (run.full === undefined) run.full = run.result !== 'failed' && !begun.has(run.local) && isFullDay(fulls ?? [], run.local);
      begun.add(run.local);
    }

    const runs: CalendarRun[] = all
      .filter((run) => run.inMonth)
      .sort((a, b) => a.started - b.started)
      .map((run) => ({ day: run.day, start: run.start, minutes: Math.max(run.minutes, 0), result: run.result, full: run.result !== 'failed' && run.full === true }));

    // A day the schedule asked for that passed with no run, once the job is seen to have run at all.
    const firstSeen = all.length ? Math.min(...all.map((run) => run.started)) : undefined;
    const planMinute = timetable && (timetable.kind === 'daily' || timetable.kind === 'monthly') ? timetable.minute : undefined;
    if (firstSeen !== undefined && timetable && ['daily', 'monthly', 'after'].includes(timetable.kind)) {
      for (let day = 1; day < today; day++) {
        if (!planned[day - 1] || midnight(day + 1) <= firstSeen) continue;
        if (!runs.some((run) => run.day === day)) runs.push({ day, start: planMinute ?? 0, minutes: 0, result: 'missed', full: false });
      }
      runs.sort((a, b) => a.day - b.day || a.start - b.start);
    }

    // Judged by the month shown, the month before only for what the month has not had yet: a job whose
    // weekly Full took two days in October and six hours in November is drawn as November has it.
    const done = all.filter((run) => run.result !== 'running' && run.minutes > 0);
    const ofMonth = <T extends { inMonth: boolean }>(runs: T[]): T[] => (runs.some((run) => run.inMonth) ? runs.filter((run) => run.inMonth) : runs);
    const finished = ofMonth(done);
    const ordinary = ofMonth(done.filter((run) => run.full !== true && run.result !== 'failed'));
    const usual = median((ordinary.length ? ordinary : finished).map((run) => run.minutes));
    const usualFull = median(ofMonth(done.filter((run) => run.full === true)).map((run) => run.minutes));
    // A run that hung for half a day says nothing of how long the job goes: the longest is of the others.
    const typical = finished.filter((run) => !isOutlier(run.minutes, (run.full ? usualFull : undefined) ?? usual));
    const outliers = finished.length - typical.length;
    const longest = typical.length ? Math.max(...typical.map((run) => run.minutes)) : undefined;
    const waits = planMinute === undefined ? [] : all.map((run) => (((run.start - planMinute) % 1440) + 1440) % 1440).filter((wait) => wait < 240);
    const waited = median(waits);

    const repositoryId = config?.storage?.backupRepositoryId;
    const retention = retentionFrom(config?.storage);
    const type = state.type ?? config?.type ?? '';
    return {
      name: state.name,
      kind: /copy/i.test(type) ? 'copy' : /replica/i.test(type) ? 'replica' : 'backup',
      enabled: !isDisabled(state),
      schedule: describeSchedule(config?.schedule) ?? 'расписание не прочитано',
      ...(fulls?.length ? { fullRule: describeFulls(fulls) } : {}),
      ...(repositoryId ? { repository: reading.repositories.get(repositoryId) ?? repositoryId.slice(0, 8) } : {}),
      ...(retention ? { retention: retentionWords(retention) } : {}),
      ...(planMinute !== undefined ? { start: planMinute } : {}),
      ...(timetable?.kind === 'periodic' && timetable.every ? { every: timetable.every } : {}),
      ...(timetable?.kind === 'after' && timetable.job ? { after: timetable.job } : {}),
      ...(usual !== undefined ? { usual } : {}),
      ...(longest !== undefined ? { longest } : {}),
      ...(usualFull !== undefined ? { usualFull } : {}),
      ...(outliers ? { outliers } : {}),
      ...(waited !== undefined && waited >= 3 ? { waited } : {}),
      planned,
      runs,
      ...(state.nextRun ? { next: nextOf(Date.parse(state.nextRun), reading.at, timezone) } : {}),
      ...whatItBacksUp(state.id, config, reading),
    };
  });

  const report: CalendarReport = {
    server: reading.server,
    year,
    month,
    today,
    window: WINDOW,
    jobs,
    ...(reading.configurations.length || reading.proxies.length ? { infrastructure: infrastructureOf(reading, jobs) } : {}),
    verdict: { status: 'ok', text: '' },
    findings: [],
  };
  report.findings = findingsOf(report);
  report.verdict = verdictOf(report.findings);
  return report;
};

/** A kind of object a job names, as the operator says it; a machine is said by its name alone. */
const OBJECT_KIND: Record<string, string> = {
  folder: 'папка', cluster: 'кластер', host: 'хост', tag: 'тег', resourcepool: 'пул ресурсов', datastore: 'datastore',
  vapp: 'vApp', datacenter: 'датацентр', computeresource: 'кластер', template: 'шаблон',
};

/** A proxy's transport mode, as the operator says it. */
const MODE: Record<string, string> = { auto: 'автоматически', directaccess: 'Direct SAN', virtualappliance: 'Hot-Add', network: 'NBD (сеть)' };

/** What `jobId` names to back up, where those live, how many machines it keeps points of and which proxies it is pinned to. */
const whatItBacksUp = (jobId: string, config: VeeamJob | undefined, reading: CalendarReading): Partial<CalendarJob> => {
  const includes = config?.virtualMachines?.includes ?? [];
  const objects = includes.flatMap((object) => {
    if (!object.name) return [];
    const kind = OBJECT_KIND[(object.type ?? '').toLowerCase()];
    return [{ name: object.name, ...(kind ? { kind } : {}) }];
  });
  const vcenters = [...new Set(includes.map((object) => object.hostName).filter((host): host is string => Boolean(host)))];
  const named = includes.filter((object) => (object.type ?? '').toLowerCase() === 'virtualmachine').length;
  const machines = reading.machines.get(jobId)?.length ?? (named || undefined);
  const chosen = config?.storage?.backupProxies;
  const proxies = chosen && !chosen.autoSelectEnabled
    ? (chosen.proxyIds ?? []).map((id) => reading.proxies.find((proxy) => proxy.id === id)?.name ?? id.slice(0, 8))
    : undefined;
  return {
    ...(machines ? { machines } : {}),
    ...(vcenters.length ? { vcenters } : {}),
    ...(objects.length ? { objects } : {}),
    ...(proxies ? { proxies } : {}),
  };
};

/** The machines, vCenters and proxies of the server's jobs. */
const infrastructureOf = (reading: CalendarReading, jobs: CalendarJob[]): CalendarReport['infrastructure'] => {
  const idOf = new Map(reading.states.map((state) => [state.name, state.id]));
  const namesOf = (job: CalendarJob) => reading.machines.get(idOf.get(job.name) ?? '') ?? [];
  const active = jobs.filter((job) => job.enabled);
  const everyMachine = new Set(active.flatMap(namesOf));

  const byVCenter = new Map<string, CalendarJob[]>();
  for (const job of active) for (const vcenter of job.vcenters ?? []) byVCenter.set(vcenter, [...(byVCenter.get(vcenter) ?? []), job]);
  const vcenters = [...byVCenter].map(([name, its]) => ({
    name,
    jobs: its.map((job) => job.name),
    machines: new Set(its.flatMap(namesOf)).size || its.reduce((sum, job) => sum + (job.machines ?? 0), 0),
  })).sort((a, b) => b.machines - a.machines || a.name.localeCompare(b.name));

  const proxies = reading.proxies.filter((proxy) => proxy.name).map((proxy) => {
    const mode = MODE[(proxy.server?.transportMode ?? '').toLowerCase()];
    return {
      name: proxy.name as string,
      ...(mode ? { mode } : {}),
      ...(proxy.server?.maxTaskCount ? { tasks: proxy.server.maxTaskCount } : {}),
      pinned: active.filter((job) => job.proxies?.includes(proxy.name as string)).map((job) => job.name),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    machines: everyMachine.size || active.reduce((sum, job) => sum + (job.machines ?? 0), 0),
    vcenters,
    proxies,
    automatic: active.filter((job) => job.kind !== 'copy' && job.proxies === undefined && (job.vcenters?.length ?? 0) > 0).map((job) => job.name),
  };
};

/** «сегодня 21:00», «завтра 01:30», «24.11 21:00». */
const nextOf = (at: number, now: number, timezone: string): string | undefined => {
  if (!Number.isFinite(at)) return undefined;
  const days = Math.round((dayIn(at, timezone) - dayIn(now, timezone)) / DAY_MS);
  const time = hm(Math.round((at - fromServerClock(dayIn(at, timezone), timezone)) / MINUTE_MS));
  if (days === 0) return `сегодня ${time}`;
  if (days === 1) return `завтра ${time}`;
  const day = new Date(dayIn(at, timezone));
  return `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')} ${time}`;
};

const plural = (n: number, one: string, few: string, many: string): string => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  return ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
};

/** What the cover points at, worst first. */
const findingsOf = (report: CalendarReport): CalendarFinding[] => {
  const found: CalendarFinding[] = [];
  const of = MONTHS_OF[report.month];
  const active = report.jobs.filter((job) => job.enabled);

  for (const job of active) {
    // Nights in a row it failed.
    const failedDays = [...new Set(job.runs.filter((run) => run.result === 'failed').map((run) => run.day))].sort((a, b) => a - b);
    let best: [number, number] | undefined;
    for (let i = 0; i < failedDays.length; i++) {
      let j = i;
      while (j + 1 < failedDays.length && failedDays[j + 1] === failedDays[j] + 1) j++;
      if (!best || j - i > best[1] - best[0]) best = [failedDays[i], failedDays[j]];
      i = j;
    }
    const last = [...job.runs].filter((run) => run.result !== 'missed').pop();
    const nowBad = last?.result === 'failed';
    if (best && best[1] > best[0]) {
      const n = best[1] - best[0] + 1;
      found.push({
        status: 'crit',
        title: `${job.name} падало ${n} ${plural(n, 'ночь', 'ночи', 'ночей')} подряд, ${best[0]}–${best[1]} ${of}`,
        text: nowBad ? 'И последний запуск с ошибкой — открыть отчёт по заданию.' : 'Сейчас снова проходит — причину видно в отчёте по заданию.',
      });
    } else if (nowBad) {
      found.push({ status: 'crit', title: `${job.name}: последний запуск с ошибкой`, text: `Ошибок за месяц: ${failedDays.length}. Открыть отчёт по заданию.` });
    }

    // Past the morning end of the window.
    const late = job.runs.filter((run) => run.result !== 'missed' && overran(report.window, run));
    if (late.length) {
      const latest = Math.max(...late.map((run) => fromNoon(run.start) + run.minutes));
      const nights = new Set(late.map((run) => run.day)).size;
      found.push({
        status: nights >= 3 ? 'crit' : 'warn',
        title: `${job.name} заканчивается после ${hm(report.window.to)}`,
        text: `${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')} за месяц, самое позднее до ${hm(720 + latest)}${late.some((run) => run.full) ? ', особенно в ночь с Full' : ''}. Начинать раньше или разнести Full по другим дням.`,
      });
    }

    // Days it should have run and did not.
    const missed = job.runs.filter((run) => run.result === 'missed').map((run) => run.day);
    if (missed.length) {
      found.push({
        status: 'warn',
        title: `${job.name} не запускалось по расписанию ${missed.length} ${plural(missed.length, 'раз', 'раза', 'раз')}`,
        text: `${missed.slice(0, 8).join(', ')} ${of}${missed.length > 8 ? ' и другие дни' : ''}. Проверить, не стоял ли сервер или само задание.`,
      });
    }
  }

  // Jobs that start together and wait for one another.
  const groups = new Map<number, CalendarJob[]>();
  for (const job of active) if (job.start !== undefined) groups.set(job.start, [...(groups.get(job.start) ?? []), job]);
  for (const [start, jobs] of groups) {
    const waiting = jobs.filter((job) => (job.waited ?? 0) >= 10);
    if (jobs.length < 3 || !waiting.length) continue;
    const longest = Math.max(...waiting.map((job) => job.waited as number));
    found.push({
      status: 'warn',
      title: `В ${hm(start)} стартуют ${jobs.length} ${plural(jobs.length, 'задание', 'задания', 'заданий')} разом`,
      text: `Ждут прокси или репозиторий до ${longest} мин: ${waiting.slice(0, 4).map((job) => job.name).join(', ')}. Сдвинуть часть на другое время.`,
    });
  }

  // The heaviest night with Fulls.
  const heaviest = heaviestFullDay(report);
  if (heaviest && heaviest.fulls >= 4) {
    found.push({
      status: 'warn',
      title: `${heaviest.day} ${of}: ${heaviest.fulls} Full в одну ночь`,
      text: 'Самая тяжёлая ночь месяца. Разнести Full по разным дням недели.',
    });
  }

  // Where a new job fits.
  const free = freeStretches(report.window, nightLoad(report));
  const widest = [...free].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
  if (widest) {
    found.push({
      status: 'ok',
      title: `Свободное окно ${hm(720 + widest[0])}–${hm(720 + widest[1])}`,
      text: 'В обычную ночь в это время ничего не идёт: сюда можно поставить новое задание.',
    });
  }

  const order = { crit: 0, warn: 1, ok: 2 } as const;
  const sorted = found.sort((a, b) => order[a.status] - order[b.status]);
  // The free window is said even when there is much to fix: it is where a fix goes.
  const tip = sorted.find((finding) => finding.status === 'ok');
  const top = sorted.filter((finding) => finding.status !== 'ok').slice(0, tip ? 4 : 5);
  return tip ? [...top, tip] : top;
};

const verdictOf = (findings: CalendarFinding[]): CalendarReport['verdict'] => {
  const crit = findings.filter((finding) => finding.status === 'crit').length;
  const warn = findings.filter((finding) => finding.status === 'warn').length;
  if (crit) return { status: 'crit', text: `${crit} ${plural(crit, 'проблема требует', 'проблемы требуют', 'проблем требуют')} внимания${warn ? `, и ещё ${warn} — поправить в расписании` : ''}.` };
  if (warn) return { status: 'warn', text: `ночи проходят, но ${warn} ${plural(warn, 'вещь стоит', 'вещи стоит', 'вещей стоит')} поправить в расписании.` };
  return { status: 'ok', text: 'все ночи месяца прошли успешно и уложились в окно.' };
};

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/**
 * The Calendar report, read and printed when somebody asks for one server's
 * month: `/calendar`, or `/calendar name` for another server than the
 * Selected one. Five requests — the jobs, their configurations, the
 * repositories, a month and a half of sessions, the restore points — and a
 * print: some seconds on a server of a hundred jobs.
 */
@Injectable()
export class CalendarReports {
  private readonly timezone: string;

  constructor(
    config: ConfigService,
    private readonly printer: ReportPrinter,
  ) {
    this.timezone = config.getOrThrow<AppConfig['telegram']>('telegram').timezone;
  }

  /** The month of `estate`, asked for: said at once to be coming, the PDF to follow. */
  asked(estate: ServerEstate): Answer {
    return {
      text: `⏳ <b>Готовлю календарь заданий ${escapeHtml(estate.name)}</b> — это 10–30 секунд.`,
      later: () => this.answer(estate),
    };
  }

  /** The month of `estate` as a PDF, and under it the verdict and what to look at first. */
  async answer(estate: ServerEstate): Promise<Answer> {
    const at = Date.now();
    const report = calendarOf(await readCalendar(estate.name, estate.reader, at, this.timezone));
    const content = await this.printer.print(calendarReportPage(report, at, this.timezone));
    const month = `${MONTHS[report.month]} ${report.year}`;
    return {
      ...printedAnswer(
        {
          icon: '📅',
          title: `Календарь ${estate.name}`,
          kind: month,
          beside: `${report.jobs.filter((job) => job.enabled).length} заданий`,
          lines: [
            `${STATUS_ICON[report.verdict.status]} ${escapeHtml(report.verdict.text.replace(/^./, (first) => first.toUpperCase()))}`,
            ...report.findings.slice(0, 3).map((finding) => `• ${escapeHtml(finding.title)}`),
          ],
          covers: `${estate.name} · ${month}`,
          hint: 'Другой сервер: /calendar имя.',
          file: `Календарь ${estate.name}`,
        },
        content,
        at,
        this.timezone,
      ),
      server: estate.key,
    };
  }
}
