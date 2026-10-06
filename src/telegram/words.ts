import { Clock, dateOf } from './time';

/**
 * Veeam's own words, as the bot writes them in Russian.
 *
 * Veeam answers in identifiers — `inactive`, `CloudDirectorBackup`, `Source`,
 * `NONE` — and they reached the chat as they came: "Статус: inactive" in an
 * alert, "Узкое место: Source" in 📈, "Последний результат: NONE" on the card
 * of a job that was running. Every message asks here instead.
 *
 * A value this does not know is written as Veeam wrote it, never dropped: a
 * newer Veeam build must not make a field vanish from a message.
 */

const lookup =
  (words: Record<string, string>) =>
  (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    return words[value.toLowerCase()] ?? value;
  };

/** A job's last result: "ошибка", "успешно". */
export const resultWord = lookup({
  success: 'успешно',
  warning: 'с предупреждением',
  failed: 'ошибка',
  none: 'ещё нет',
});

/** What kind of job it is: "бэкап ВМ", "репликация". */
export const jobTypeWord = lookup({
  backup: 'бэкап ВМ',
  clouddirectorbackup: 'бэкап vCloud',
  vspherereplica: 'репликация',
  hypervreplica: 'репликация Hyper-V',
  clouddirectorreplica: 'репликация vCloud',
  cdpreplica: 'CDP-репликация',
  backupcopy: 'копия бэкапа',
  vmbackupcopy: 'копия бэкапа',
  filebackup: 'бэкап файлов',
  filebackupcopy: 'копия бэкапа файлов',
  objectstoragebackup: 'бэкап объектного хранилища',
  entraidtenantbackup: 'бэкап Entra ID',
  entraidauditlogbackup: 'бэкап журналов Entra ID',
  windowsagentbackup: 'агент Windows',
  linuxagentbackup: 'агент Linux',
  windowsagentbackupworkstationpolicy: 'агент Windows',
  windowsagentbackupserverpolicy: 'агент Windows',
  linuxagentbackupworkstationpolicy: 'агент Linux',
  linuxagentbackupserverpolicy: 'агент Linux',
  surebackup: 'SureBackup',
});

/** Where a job stands right now: "не выполняется", "выключено". */
export const jobStatusWord = lookup({
  inactive: 'не выполняется',
  stopped: 'не выполняется',
  running: 'выполняется',
  working: 'выполняется',
  starting: 'запускается',
  stopping: 'останавливается',
  postprocessing: 'завершается',
  disabled: 'выключено в Veeam',
});

/**
 * The slowest stage of a transfer. Veeam's four names say where to look; the
 * source is the machine's disks as the proxy reads them, the target the
 * repository being written.
 */
export const bottleneckWord = lookup({
  source: 'источник (диски ВМ)',
  proxy: 'прокси',
  network: 'сеть',
  target: 'репозиторий',
});

/**
 * The chain a job is adding to: "Full 26.09 + 4 инкр.", or that it has
 * nothing but Fulls.
 *
 * Written here once for 🗂 and the job card. `chain` is what the Evidence
 * worked out for the job's `runs` retained runs; the shape is spelled out
 * rather than imported, the Evidence being a layer above this one.
 */
export const chainWords = (
  runs: number,
  chain: { fulls: number; lastFull?: number; sinceFull: number },
  clock: Clock,
): string => {
  if (chain.lastFull === undefined) return 'Full среди точек нет';
  if (runs > 1 && chain.fulls === runs) return 'каждый запуск — Full';
  const full = `Full ${dateOf(chain.lastFull, clock)}`;
  if (chain.sinceFull === 0) return runs === 1 ? full : `${full}, инкрементов после него нет`;
  return `${full} + ${chain.sinceFull} инкр.`;
};

const SIZE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];

/**
 * Bytes as Veeam's console shows them, in binary units: "856 ГБ", "15.5 ТБ",
 * "0.9 ГБ". A tenth is kept below a hundred, where it still says something.
 */
export const sizeWords = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 100 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${SIZE_UNITS[unit]}`;
};

/** Bytes a second, as Veeam's console shows a processing rate: "66 МБ/с", "1.2 ГБ/с". */
export const rateWords = (bytesPerSecond: number): string => {
  const mb = Math.max(0, bytesPerSecond) / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} ГБ/с`;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} МБ/с`;
};
