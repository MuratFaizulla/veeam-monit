import { escapeHtml, truncate } from '../telegram/format';
import { bar, fitted, footerOf, Clock } from './format';
import { RepositoryCapacity } from '../estate/repository-capacity';

/**
 * The 💾 slot: how full every repository is.
 *
 * This used to take the Veeam wire shape and work the answer out itself, which
 * put the physical-capacity rule inside a renderer and out of reach of the
 * alert that needed the same rule. It now renders what it is given, like its
 * four siblings, and the list arrives already ordered.
 */

const BAR_WIDTH = 20;

export const renderRepositories = (
  repositories: RepositoryCapacity[] | undefined,
  clock: Clock,
): string => {
  const footer = footerOf(clock);
  if (!repositories) {
    return ['💾 <b>VEEAM REPOSITORIES</b>', '', '⚠️ Данные репозиториев временно недоступны.', '', footer].join('\n');
  }
  if (!repositories.length) {
    return ['💾 <b>VEEAM REPOSITORIES</b>', '', 'Репозитории не найдены.', '', footer].join('\n');
  }

  return truncate(
    fitted(repositories.length, (shown) => {
      const lines = ['💾 <b>VEEAM REPOSITORIES</b>', ''];
      repositories.slice(0, shown).forEach((repository, index) => {
        lines.push(...repositoryLines(repository, index + 1));
        if (index < shown - 1) lines.push('', '────────────────────', '');
      });
      if (shown < repositories.length) lines.push(`…и ещё ${repositories.length - shown}`, '');
      lines.push(`<b>Всего:</b> ${repositories.length}`, '', footer);
      return lines.join('\n');
    }),
  );
};

const repositoryLines = (repository: RepositoryCapacity, index: number): string[] => {
  const percent = repository.usedPercent;
  const usage = bar(percent ?? 0, BAR_WIDTH);
  const usageIcon =
    percent === undefined ? '⚪' : percent >= 90 ? '🔴' : percent >= 80 ? '🟠' : percent >= 70 ? '🟡' : '🟢';
  const onlineIcon = repository.isOnline === undefined ? '⚪' : repository.isOnline ? '🟢' : '🔴';
  return [
    `<b>${index}. ${escapeHtml(repository.name)}</b>`,
    '',
    `${usageIcon} ${usage}  <b>${percent === undefined ? 'нет данных' : `${Math.round(percent)}% занято`}</b>`,
    `📦 ${formatGb(repository.usedGB)} / ${formatGb(repository.capacityGB)}`,
    `💧 Свободно: <b>${formatGb(repository.freeGB)}</b>`,
    `${onlineIcon} Статус: <b>${repository.isOnline === undefined ? 'UNKNOWN' : repository.isOnline ? 'ONLINE' : 'OFFLINE'}</b>`,
  ];
};

const formatGb = (gb: number | undefined): string => {
  if (typeof gb !== 'number' || !Number.isFinite(gb)) return 'нет данных';
  if (gb >= 1024) return `${trim(gb / 1024)} TB`;
  return `${trim(gb)} GB`;
};
const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
