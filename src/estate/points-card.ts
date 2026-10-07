import { escapeHtml } from '../telegram/format';
import { Clock, dateOf, everyLabel, momentOf } from '../telegram/time';
import { chainWords, sizeWords } from '../telegram/words';
import { describeFulls } from './full-schedule';
import { Excuse, Verdict, verdictWords } from './job-standing';
import { everyRunFull, JobPoints, retentionWords } from './point-facts';
import { calendarOf, MARKS } from './points-calendar';
import { PointSizes } from './points-sizes';

/**
 * One job's restore points, answered for: what /points says.
 *
 * 🛡 lists only the jobs that need somebody and counts the rest, so the
 * question it leaves is "and this one?". The Job card answers it about runs;
 * this answers it about points — how far back each machine reaches, the chain
 * being written, the Fulls it is set to take and the ones it did not — opening
 * with what 🛡 says of the job, in 🛡's words, from the Evidence already read.
 * Asking costs the request that finds the job and one for each of its backups'
 * files, which say what its Fulls and increments take up.
 */

/** What is known of one job's points. */
export interface PointsCard {
  name: string;
  /** Why the job owes nobody a point, when it does not. */
  excused?: Excuse;
  /** Where it stands by 🛡's verdict; absent when it is excused. */
  verdict?: Verdict;
  /** Its points; absent when it has none in the list the scan reads. */
  points?: JobPoints;
  /** What they take up; absent when its backup files could not be read. */
  sizes?: PointSizes;
  /** A replica or the like, whose points Veeam keeps where the scan does not read. */
  elsewhere?: boolean;
  /** Why there is no Evidence to answer from yet. */
  unavailable?: string;
}

export const renderPointsCard = (card: PointsCard, clock: Clock): string => {
  const lines = [`🗂 <b>${escapeHtml(card.name)}</b> · точки восстановления`, ''];
  if (card.unavailable) return [...lines, escapeHtml(card.unavailable)].join('\n');

  if (card.excused === 'disabled') {
    lines.push('⚪ <b>Выключено в Veeam</b> — новых точек от него не ждут.');
  } else if (card.excused === 'unscheduled') {
    lines.push('⚪ <b>Запускается только вручную</b> — по расписанию точек от него не ждут.');
  }

  // A job nobody expects points from is not judged against a rhythm it no longer keeps.
  if (!card.excused && card.verdict) lines.push(...verdictLines(card.verdict, clock));

  const points = card.points;
  if (!points) {
    // Said beside the verdict by its runs: "no points at all" is what a
    // replica read as while it was replicating every night.
    if (card.elsewhere) {
      lines.push('', 'Точки заданий этого типа Veeam хранит отдельно, поэтому о нём судят по успешным запускам — подробнее в /job.');
    }
    return lines.join('\n');
  }

  lines.push(...calendarLines(points, clock));
  lines.push('', ...factLines(points, clock), ...sizeLines(card.sizes, clock));
  lines.push(
    '',
    '<i>Точки — на сколько моментов можно откатить каждую ВМ задания.' +
      ' Цепочка — Full и инкременты после него, которые пишутся сейчас.</i>',
  );
  return lines.join('\n');
};

/** Where the job stands, as 🛡 says it: what is wrong, or that nothing is, and the facts under it. */
const verdictLines = (verdict: Verdict, clock: Clock): string[] => {
  const { icon, problem, facts } = verdictWords(verdict, clock);
  const line = `${icon} <b>${problem.charAt(0).toUpperCase()}${problem.slice(1)}</b>`;
  return facts.length > 0 ? [line, `<i>${facts.join(' · ')}</i>`] : [line];
};

/** The days of the last weeks, a Full, an increment or nothing each, and what the marks mean. */
const calendarLines = (points: JobPoints, clock: Clock): string[] => {
  const calendar = calendarOf(points.retained ?? [], clock);
  if (!calendar) return [];
  // Without types every point is just a point: nothing says which were Fulls.
  const typed = points.retained?.some((run) => run.full !== undefined);
  const legend = [
    ...(typed ? [`${MARKS.full} Full`, `${MARKS.increment} инкремент`] : [`${MARKS.increment} точка`]),
    `${MARKS.none} нет точки`,
    `${MARKS.today} сегодня ещё нет`,
  ].join('  ');
  return ['', `<pre>${escapeHtml(calendar.join('\n'))}</pre>`, `<i>${legend}</i>`];
};

/** How big a Full and an increment are, and what the job takes up altogether. */
const sizeLines = (sizes: PointSizes | undefined, clock: Clock): string[] => {
  if (!sizes) return [];
  const { full, increment, fullWriting } = sizes;
  const writing = fullWriting === undefined ? '' : `новый Full с ${dateOf(fullWriting, clock)} ещё пишется`;
  const lines: string[] = [];
  if (full) {
    const tail = writing ? ` · ${writing}` : '';
    lines.push(`<b>Full ${dateOf(full.at, clock)}:</b> ${sizeWords(full.data)} данных → ${sizeWords(full.disk)} на диске${tail}`);
  } else if (writing) {
    lines.push(`<b>Full:</b> ${writing}`);
  }
  if (increment) {
    const share = full && full.data > 0 ? ` (${shareWords(increment.data / full.data)} от Full)` : '';
    lines.push(
      `<b>Инкремент:</b> обычно ${sizeWords(increment.data)} данных${share} → ${sizeWords(increment.disk)} на диске`,
    );
  }
  lines.push(`<b>На диске всего:</b> ${sizeWords(sizes.onDisk)}`);
  return lines;
};

/** "≈20%", "<1%". */
const shareWords = (share: number): string => (share < 0.01 ? '<1%' : `≈${Math.round(share * 100)}%`);

const label = (name: string, value: string | undefined): string | undefined =>
  value === undefined ? undefined : `<b>${name}:</b> ${value}`;

const factLines = (points: JobPoints, clock: Clock): string[] => {
  const { runs, machines, chain } = points;
  // Chains are worth counting only where they are not one Full apiece.
  const chains = chain && chain.fulls > 1 && !everyRunFull(points) ? ` · цепочек в хранении: ${chain.fulls}` : '';
  return [
    `<b>Точек на ВМ:</b> ${runs} · <b>ВМ:</b> ${machines} · <b>в Veeam всего:</b> ${points.points}`,
    label('Самая ранняя', points.oldest === undefined ? undefined : momentOf(points.oldest, clock)),
    label('Самая новая', points.newest === undefined ? undefined : momentOf(points.newest, clock)),
    label('Цепочка', chain ? `${chainWords(runs, chain, clock)}${chains}` : undefined),
    label('Full по расписанию', points.fulls ? describeFulls(points.fulls) : undefined),
    label('Хранение', points.retention ? retentionWords(points.retention) : undefined),
    label('Ритм', points.intervalDays ? everyLabel(points.intervalDays) : undefined),
  ].filter((line): line is string => line !== undefined);
};
