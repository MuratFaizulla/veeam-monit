import { escapeHtml } from '../telegram/format';
import { dayOf, fitted, footerOf, LiveClock, plural } from './format';

/**
 * Backup chains no live job owns any more.
 *
 * Deleting a job in Veeam does not delete what it produced: the backup and its
 * restore points stay on the repository. Most of an estate's stored data can
 * end up here without anything reporting it, because every other check starts
 * from the job list — and these have no job to start from.
 *
 * They are not automatically garbage. A chain kept deliberately after a job was
 * retired looks exactly the same as one nobody remembers. So this reports what
 * is there and how old it is, and leaves the deleting to a human.
 */

const DAY = 86_400_000;

export interface OrphanBackup {
  name: string;
  points: number;
  /** Epoch ms of the newest point in the chain. */
  newest?: number;
  oldest?: number;
}

export interface OrphansSnapshot {
  backups: OrphanBackup[];
  /** Restore points held by these chains. */
  points: number;
  /** Restore points in the whole estate, for the share. */
  totalPoints: number;
  unavailable?: string;
}

export const renderOrphans = (snapshot: OrphansSnapshot, clock: LiveClock): string => {
  const footer = footerOf(clock);

  if (snapshot.unavailable) {
    return [
      '⚠️ <b>Бэкапы без заданий не проверены</b>',
      '',
      escapeHtml(snapshot.unavailable),
      '',
      footer,
    ].join('\n');
  }

  if (snapshot.backups.length === 0) {
    return [
      '🟢 <b>Бэкапов без заданий нет</b>',
      '',
      'У каждой цепочки на репозитории есть живое задание.',
      '',
      footer,
    ].join('\n');
  }

  // Biggest first: this list exists to be acted on, and the chains holding the
  // most restore points are where acting pays.
  const sorted = [...snapshot.backups].sort(
    (a, b) => b.points - a.points || (b.newest ?? 0) - (a.newest ?? 0),
  );
  const share = snapshot.totalPoints
    ? Math.round((snapshot.points / snapshot.totalPoints) * 100)
    : 0;

  const tail = [
    '',
    `<b>Цепочек:</b> ${sorted.length}`,
    `<b>Точек в них:</b> ${snapshot.points} из ${snapshot.totalPoints} (${share}%)`,
    '<i>Задание удалено, а его бэкап остался. Удалять — только вручную: часть' +
      ' таких цепочек хранят намеренно.</i>',
    footer,
  ];

  return fitted(sorted.length, (shown) => {
    const lines = ['🧹 <b>Бэкапы без заданий</b>', '<i>(точек · цепочка · последняя)</i>', ''];
    for (const backup of sorted.slice(0, shown)) lines.push(orphanLine(backup, clock));
    const rest = sorted.length - shown;
    if (rest > 0) {
      const restPoints = sorted.slice(shown).reduce((sum, backup) => sum + backup.points, 0);
      lines.push(
        `…и ещё ${rest} ${plural(rest, 'цепочка', 'цепочки', 'цепочек')} на ${restPoints} ${plural(restPoints, 'точку', 'точки', 'точек')}`,
      );
    }
    lines.push(...tail);
    return lines.join('\n');
  });
};

const orphanLine = (backup: OrphanBackup, clock: LiveClock): string => {
  const age =
    backup.newest === undefined
      ? 0
      : (clock.now.getTime() - backup.newest) / DAY;
  // Older than a quarter is the point at which "we might still need it" stops
  // being the likely explanation.
  const icon = age >= 90 ? '🔴' : age >= 30 ? '🟠' : '🟢';
  const last =
    backup.newest === undefined
      ? ''
      : ` · ${dayOf(new Date(backup.newest).toISOString(), clock).replace(/ в \d\d:\d\d$/, '')}`;
  return `${icon} ${backup.points} · ${escapeHtml(backup.name)}${last}`;
};
