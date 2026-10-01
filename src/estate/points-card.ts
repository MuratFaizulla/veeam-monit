import { escapeHtml } from '../telegram/format';
import { Clock, everyLabel, momentOf } from '../telegram/time';
import { chainWords } from '../telegram/words';
import { describeFulls, fullKindOf } from './full-schedule';
import {
  everyRunFull,
  JobPoints,
  missedRunsWords,
  owedDaysWords,
  retentionWords,
  verdictIcon,
  verdictOf,
} from './point-verdict';

/**
 * One job's restore points, answered for: what /points says.
 *
 * 🗂 lists only the jobs that need somebody and counts the rest, so the
 * question it leaves is "and this one?". The Job card answers it about runs;
 * this answers it about points — how far back each machine reaches, the chain
 * being written, the Fulls it is set to take and the ones it did not — by the
 * same verdict 🗂 uses, from the Evidence already read. Asking costs the one
 * request that finds the job.
 */

/** What is known of one job's points. */
export interface PointsCard {
  name: string;
  /** Why the job owes nobody a point, when it does not. */
  excused?: 'disabled' | 'unscheduled';
  /** Its points; absent when it has none in the list the scan reads. */
  points?: JobPoints;
  /** A replica or the like, whose points Veeam keeps where the scan does not read. */
  elsewhere?: boolean;
  /** Why there is no Evidence to answer from yet. */
  unavailable?: string;
}

/** Missed days spelled out before the earlier ones are only counted. */
const DAYS_SHOWN = 10;

export const renderPointsCard = (card: PointsCard, clock: Clock): string => {
  const lines = [`🗂 <b>${escapeHtml(card.name)}</b> · точки восстановления`, ''];
  if (card.unavailable) return [...lines, escapeHtml(card.unavailable)].join('\n');

  if (card.excused === 'disabled') {
    lines.push('⚪ <b>Выключено в Veeam</b> — новых точек от него не ждут.');
  } else if (card.excused === 'unscheduled') {
    lines.push('⚪ <b>Запускается только вручную</b> — по расписанию точек от него не ждут.');
  }

  const points = card.points;
  if (!points) {
    if (card.elsewhere) {
      // Said instead of "no points at all", which is what a replica read as
      // while it was replicating every night.
      lines.push('Точки заданий этого типа Veeam хранит отдельно; защищённость видна по успешным запускам — /job.');
    } else if (!card.excused) {
      lines.push('🔴 <b>Точек восстановления нет</b>');
    }
    return lines.join('\n');
  }

  // A job nobody expects points from is not judged against a rhythm it no longer keeps.
  if (!card.excused) lines.push(...verdictLines(points, clock));
  lines.push('', ...factLines(points, clock));
  lines.push(
    '',
    '<i>Точки — на сколько моментов можно откатить каждую ВМ задания.' +
      ' Цепочка — Full и инкременты после него, которые пишутся сейчас.</i>',
  );
  return lines.join('\n');
};

/** Where the job stands, in the words and marks 🗂 uses for it. */
const verdictLines = (points: JobPoints, clock: Clock): string[] => {
  const verdict = verdictOf(points, clock);
  const lines: string[] = [];
  if (verdict.standing === 'behind' && verdict.missed !== null) {
    lines.push(`${verdictIcon(verdict)} <b>Отстаёт от своего расписания:</b> ${missedRunsWords(verdict.missed)}`);
  }
  if (verdict.owed.length > 0) {
    const days = owedDaysWords(verdict.owed, clock.now.getTime(), DAYS_SHOWN);
    lines.push(`🟡 <b>Пропущен ${fullKindOf(points.fulls ?? [])}:</b> ${days}`);
  }
  if (verdict.standing === 'unknown') {
    lines.push('⚪ <b>Ритм ещё не ясен</b> — точек слишком мало, чтобы судить о пропусках.');
  }
  if (verdict.standing === 'onTime') {
    const fullsKnown = points.chain !== undefined && (points.fulls?.length ?? 0) > 0;
    lines.push(`🟢 <b>По расписанию</b>${fullsKnown ? ', Full проходят вовремя' : ''}`);
  }
  return lines;
};

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
