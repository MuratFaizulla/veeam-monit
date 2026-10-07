import { escapeHtml } from '../telegram/format';
import { ProtectionRisk, ProtectionSnapshot, VERDICT_ICON, verdictWords } from '../estate/job-standing';
import { footerOf, Clock, paged, plural } from './format';

/**
 * "Is everything protected?" — the 🛡 slot.
 *
 * Every other alert in this service fires on a *transition*: a job that was
 * fine and now is not. That leaves the most dangerous case invisible — a job
 * sitting at `lastResult: Success` whose newest restore point is from June,
 * because the job simply stopped running. Nothing transitions, so nothing is
 * reported, and the gap is only found when somebody needs the restore. So this
 * slot asks of the restore points themselves.
 *
 * It used to be two topics. 🛡 said a job was past its deadline, 🗂 Restore
 * points that it had skipped runs or a scheduled Full, and the two said it of
 * the same job in different words: "3 дня без точки" in one, "пропущено 2
 * запуска" in the other. Now one list answers, a job once, with what is wrong
 * first and the facts to check it by under it.
 *
 * Which jobs need somebody, and why, is `assessProtection` in
 * `src/estate/job-standing.ts`, by the verdict /points answers with too; this
 * module only lays the list out.
 */

/**
 * Messages this topic may occupy. On an ordinary day what needs somebody fits
 * in one; on a bad one — a repository gone and every job behind — the list
 * continues into further messages, each kept current like the first.
 */
const MAX_PAGES = 5;

/**
 * Written into the first line while the pages are fitted, then replaced by
 * "1/3". As long as what replaces it, so a page that fitted still fits.
 */
const PAGE_MARK = ' · 0/0';

export const renderProtection = (snapshot: ProtectionSnapshot, clock: Clock): string[] => {
  const footer = footerOf(clock);

  if (snapshot.unavailable) {
    return [['⚠️ <b>Защищённость не проверена</b>', '', escapeHtml(snapshot.unavailable), '', footer].join('\n')];
  }

  const { risks, totalJobs } = snapshot;
  const fine = totalJobs - risks.length;
  const closing = [
    '',
    risks.length === 0
      ? totalJobs === 0
        ? 'Заданий, от которых ждут точек, нет.'
        : `🟢 <b>${totalJobs === 1 ? 'Задание защищено' : `Все ${totalJobs} ${plural(totalJobs, 'задание', 'задания', 'заданий')} защищены`}</b>`
      : fine > 0
        ? `🟢 Остальные ${fine} — в порядке`
        : null,
    skippedLine(snapshot),
    totalJobs > 0 ? 'Подробнее о задании: /points имя' : null,
    '',
    footer,
  ].filter((line): line is string => line !== null);

  if (risks.length === 0) return [closing.slice(1).join('\n')];

  const worst = VERDICT_ICON[risks[0].severity];
  const title =
    `${worst} <b>${risks.length} ${plural(risks.length, 'задание', 'задания', 'заданий')} из ${totalJobs}` +
    ` ${plural(risks.length, 'требует', 'требуют', 'требуют')} внимания</b>${PAGE_MARK}`;

  const pages = paged(risks.length, MAX_PAGES, (from, take, last) => {
    const lines = [title];
    // A blank line around each job: two lines a job, run together, could not
    // be told apart.
    for (const risk of risks.slice(from, from + take)) lines.push('', ...riskLines(risk, clock));
    if (!last) return [...lines, '', footer].join('\n');
    const rest = risks.length - (from + take);
    if (rest > 0) lines.push('', `…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} — не поместились`);
    return [...lines, ...closing].join('\n');
  });

  return pages.map((page, index) =>
    page.replace(PAGE_MARK, pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''),
  );
};

/** Two lines: what is wrong, and the facts to check it by. */
const riskLines = (risk: ProtectionRisk, clock: Clock): string[] => {
  const { icon, problem, facts } = verdictWords(risk, clock);
  const line = `${icon} <b>${escapeHtml(risk.name)}</b> — ${problem}`;
  return facts.length > 0 ? [line, `<i>${facts.join(' · ')}</i>`] : [line];
};

/**
 * Said out loud: a list that silently shrank would be worse than one that is
 * too long, because the reader would not know what is outside it.
 */
const skippedLine = (snapshot: ProtectionSnapshot): string | null => {
  const skipped = [
    snapshot.excludedUnscheduled ? `${snapshot.excludedUnscheduled} без расписания` : undefined,
    snapshot.excludedDisabled ? `${snapshot.excludedDisabled} выключено` : undefined,
  ].filter((part): part is string => part !== undefined);
  return skipped.length > 0 ? `<i>Не проверяются: ${skipped.join(', ')}</i>` : null;
};
