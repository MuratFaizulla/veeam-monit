import { escapeHtml, truncate } from '../telegram/format';
import { bar, fitted, footerOf, plural, Clock } from './format';
import { RepositoryCapacity } from '../estate/repository-capacity';

/**
 * The 💾 slot: where is space running out?
 *
 * It renders what it is given, like its siblings; the capacities arrive worked
 * out by the rule in repository-capacity.ts and ordered by name.
 *
 * It used to give every repository a block of five lines and a rule between
 * blocks — thirty lines for four repositories, each saying "Доступен" — so the
 * one running out of space had to be found by reading. Now the first line
 * says where space is running out, each repository is one line, the fullest
 * first, and the percentages and bars stand in one column to compare by eye.
 */

const BAR_WIDTH = 10;

/** In use from here a repository is filling up, and from here almost full. */
const FILLING_PERCENT = 80;
const FULL_PERCENT = 90;

type Fill = 'offline' | 'full' | 'filling' | 'fine' | 'unknown';

/** The order the list runs in: what needs somebody first, what cannot be told last. */
const RANK: Record<Fill, number> = { offline: 0, full: 1, filling: 2, fine: 3, unknown: 4 };

const ICON: Record<Fill, string> = { offline: '🔴', full: '🔴', filling: '🟠', fine: '🟢', unknown: '⚪' };

const fillOf = (repository: RepositoryCapacity): Fill => {
  if (repository.isOnline === false) return 'offline';
  const percent = repository.usedPercent;
  if (percent === undefined) return 'unknown';
  if (percent >= FULL_PERCENT) return 'full';
  return percent >= FILLING_PERCENT ? 'filling' : 'fine';
};

export const renderRepositories = (
  repositories: RepositoryCapacity[] | undefined,
  clock: Clock,
): string => {
  const footer = footerOf(clock);
  if (!repositories) return ['⚠️ <b>Данные репозиториев временно недоступны</b>', '', footer].join('\n');
  if (!repositories.length) return ['⚪ <b>Репозитории не найдены</b>', '', footer].join('\n');

  // Sorting is stable, so repositories as full as each other keep their
  // name order, Default last.
  const listed = repositories
    .map((repository) => ({ repository, fill: fillOf(repository) }))
    .sort((a, b) => RANK[a.fill] - RANK[b.fill] || (b.repository.usedPercent ?? 0) - (a.repository.usedPercent ?? 0));
  const headline = headlineOf(listed.map(({ fill }) => fill));

  return truncate(
    fitted(listed.length, (shown) => {
      const lines = [headline, ''];
      for (const { repository, fill } of listed.slice(0, shown)) lines.push(lineOf(repository, fill));
      if (shown < listed.length) lines.push(`…и ещё ${listed.length - shown}`);
      lines.push('', footer);
      return lines.join('\n');
    }),
  );
};

/** "Репозитории: 1 почти заполнен, 1 заполняется", or that all of them are fine. */
const headlineOf = (fills: Fill[]): string => {
  const count = (fill: Fill): number => fills.filter((each) => each === fill).length;
  const total = fills.length;
  if (count('fine') === total) {
    if (total === 1) return '🟢 <b>Репозиторий в порядке</b>';
    if (total === 2) return '🟢 <b>Оба репозитория в порядке</b>';
    return `🟢 <b>Все ${total} ${plural(total, 'репозиторий', 'репозитория', 'репозиториев')} в порядке</b>`;
  }
  const offline = count('offline');
  const full = count('full');
  const filling = count('filling');
  const unknown = count('unknown');
  const parts = [
    offline ? `${offline} ${offline === 1 ? 'недоступен' : 'недоступны'}` : '',
    full ? `${full} почти ${full === 1 ? 'заполнен' : 'заполнены'}` : '',
    filling ? `${filling} ${filling === 1 ? 'заполняется' : 'заполняются'}` : '',
    unknown ? `нет данных по ${unknown}` : '',
  ].filter(Boolean);
  const icon = offline || full ? '🔴' : filling ? '🟠' : '⚪';
  return `${icon} <b>Репозитории: ${parts.join(', ')}</b>`;
};

const lineOf = (repository: RepositoryCapacity, fill: Fill): string => {
  const name = `<b>${escapeHtml(repository.name)}</b>`;
  // Only when Veeam said so: a build whose REST API does not report the
  // state (1.1) printed "⚪ UNKNOWN" under every repository it has.
  if (fill === 'offline') return `${ICON.offline} ${name} — недоступен`;
  if (fill === 'unknown' || repository.usedPercent === undefined) return `${ICON.unknown} ${name} — нет данных о месте`;
  const percent = repository.usedPercent;
  const figure = `${String(Math.round(percent)).padStart(3, ' ')}%`;
  return `${ICON[fill]} <code>${figure} ${bar(percent, BAR_WIDTH)}</code> ${name} · ${spaceOf(repository)}`;
};

/** "свободно 3.8 из 80 TB", in the units the two figures share where they share one. */
const spaceOf = (repository: RepositoryCapacity): string => {
  const capacity = known(repository.capacityGB);
  const free = known(repository.freeGB);
  const used = known(repository.usedGB);
  if (capacity === undefined) return 'нет данных о свободном месте';
  if (free !== undefined) return `свободно ${pairOf(free, capacity)}`;
  if (used !== undefined) return `занято ${pairOf(used, capacity)}`;
  return 'нет данных о свободном месте';
};

const known = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const pairOf = (part: number, whole: number): string => {
  if (part >= 1024 && whole >= 1024) return `${trim(part / 1024)} из ${trim(whole / 1024)} TB`;
  if (part < 1024 && whole < 1024) return `${trim(part)} из ${trim(whole)} GB`;
  return `${formatGb(part)} из ${formatGb(whole)}`;
};

const formatGb = (gb: number): string => (gb >= 1024 ? `${trim(gb / 1024)} TB` : `${trim(gb)} GB`);

const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
