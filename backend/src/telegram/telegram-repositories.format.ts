import { escapeHtml, MAX_LENGTH } from './telegram.format';
import { LiveClock } from './telegram-live.format';
import { VeeamRepositoryState } from '../veeam/veeam.types';

const BAR_WIDTH = 20;

export const renderRepositories = (
  repositories: VeeamRepositoryState[] | undefined,
  clock: LiveClock,
): string => {
  const footer = `<i>Обновлено ${stamp(clock.now, clock.timezone)}</i>`;
  if (!repositories) {
    return ['💾 <b>VEEAM REPOSITORIES</b>', '', '⚠️ Данные репозиториев временно недоступны.', '', footer].join('\n');
  }
  if (!repositories.length) {
    return ['💾 <b>VEEAM REPOSITORIES</b>', '', 'Репозитории не найдены.', '', footer].join('\n');
  }

  const sorted = [...repositories].sort(compareRepositoriesByName);
  for (let shown = sorted.length; shown >= 0; shown -= 1) {
    const lines = ['💾 <b>VEEAM REPOSITORIES</b>', ''];
    sorted.slice(0, shown).forEach((repository, index) => {
      lines.push(...repositoryLines(repository, index + 1));
      if (index < shown - 1) lines.push('', '────────────────────', '');
    });
    if (shown < sorted.length) lines.push(`…и ещё ${sorted.length - shown}`, '');
    lines.push(`<b>Всего:</b> ${sorted.length}`, '', footer);
    const text = lines.join('\n');
    if (text.length <= MAX_LENGTH) return text;
  }
  return ['💾 <b>VEEAM REPOSITORIES</b>', '', `<b>Всего:</b> ${sorted.length}`, '', footer].join('\n');
};

const compareRepositoriesByName = (a: VeeamRepositoryState, b: VeeamRepositoryState): number => {
  const aName = a.name ?? a.id ?? '';
  const bName = b.name ?? b.id ?? '';
  const aIsDefault = /^default\b/i.test(aName);
  const bIsDefault = /^default\b/i.test(bName);
  if (aIsDefault !== bIsDefault) return aIsDefault ? 1 : -1;
  return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
};

const repositoryLines = (repository: VeeamRepositoryState, index: number): string[] => {
  const percent = usedPercent(repository);
  const filled = percent === undefined ? 0 : Math.round((percent / 100) * BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
  const capacity = repository.capacityGB;
  const free = repository.freeGB;
  const used =
    typeof capacity === 'number' && typeof free === 'number'
      ? Math.max(0, capacity - free)
      : repository.usedSpaceGB;
  const usageIcon =
    percent === undefined ? '⚪' : percent >= 90 ? '🔴' : percent >= 80 ? '🟠' : percent >= 70 ? '🟡' : '🟢';
  const onlineIcon = repository.isOnline === undefined ? '⚪' : repository.isOnline ? '🟢' : '🔴';
  return [
    `<b>${index}. ${escapeHtml(repository.name ?? repository.id ?? 'Без имени')}</b>`,
    '',
    `${usageIcon} ${bar}  <b>${percent === undefined ? 'нет данных' : `${Math.round(percent)}% занято`}</b>`,
    `📦 ${formatGb(used)} / ${formatGb(capacity)}`,
    `💧 Свободно: <b>${formatGb(free)}</b>`,
    `${onlineIcon} Статус: <b>${repository.isOnline === undefined ? 'UNKNOWN' : repository.isOnline ? 'ONLINE' : 'OFFLINE'}</b>`,
  ];
};

const usedPercent = (repository: VeeamRepositoryState): number | undefined => {
  const capacity = repository.capacityGB;
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) return undefined;
  // On some VBR/storage combinations usedSpaceGB is not the physical
  // capacity consumption (it may include logical or deduplicated data and can
  // even exceed capacityGB). The capacity bar must therefore use the physical
  // invariant Capacity - Free whenever freeGB is available.
  const used = typeof repository.freeGB === 'number'
    ? capacity - repository.freeGB
    : typeof repository.usedSpaceGB === 'number'
      ? repository.usedSpaceGB
      : undefined;
  return used === undefined ? undefined : Math.max(0, Math.min(100, (used / capacity) * 100));
};

const formatGb = (gb: number | undefined): string => {
  if (typeof gb !== 'number' || !Number.isFinite(gb)) return 'нет данных';
  if (gb >= 1024) return `${trim(gb / 1024)} TB`;
  return `${trim(gb)} GB`;
};
const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
const stamp = (date: Date, timezone: string): string => new Intl.DateTimeFormat('ru-RU', {
  timeZone: timezone || undefined,
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(date);
