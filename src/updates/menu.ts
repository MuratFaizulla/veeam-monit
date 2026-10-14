import { TelegramKey, TelegramReplyKeyboard } from '../telegram/types';
import type { JobChoice, JobMark } from '../monitor/monitor';
import type { CommandName } from './commands';

/**
 * The bot's menu: the keyboard under the input field.
 *
 * What the company's other bots have, and what people reach for first: keys
 * that stay put, rather than commands to remember or buttons that scroll away
 * with the message they hang under. Pressing a key sends its label as an
 * ordinary message, so the label is also the address — which is why the
 * labels are declared here, once, and read back by `menuPressed`.
 *
 * The bot sees an ordinary message in a group only while it is an
 * administrator there or its privacy mode is off. It is an administrator
 * already: creating forum topics needs that.
 */

/**
 * Each key of the main menu by the command it is answered as, with what it
 * does in the words of the menu message. The build fails if a key names a
 * command the bot does not declare.
 */
const KEYS = {
  servers: { label: '🖥 Серверы', does: 'выбрать сервер, который показывают живые темы' },
  // Asks which repository first: the whole report is thirty pages.
  repos: { label: '📄 Отчёт', does: 'PDF по репозиториям: все или один на выбор' },
  digest: { label: '📊 Сводка', does: 'задания выбранного сервера и какие из них не в порядке' },
  check: { label: '🔄 Проверить', does: 'опросить Veeam сейчас' },
  // Offers every job of the Selected server to pick, the worst first.
  job: { label: '📦 Задание', does: 'выбрать задание из списка: карточка, ⚡ скорость, настройки' },
  // Asked with no name, as it is, offers the jobs that need somebody.
  points: { label: '🗂 Точки', does: 'точки восстановления задания' },
  status: { label: '🩺 Статус', does: 'отвечает ли Veeam' },
  topics: { label: '📑 Темы', does: 'темы форума, которые знает бот' },
  clear: { label: '🧹 Очистить', does: 'убрать из General всё за двое суток, спросив сначала' },
  help: { label: '🤖 Помощь', does: 'все команды' },
} as const satisfies Partial<Record<CommandName, { label: string; does: string }>>;

/**
 * The keys, a row each. `/menu` alone has none: the keyboard is the menu.
 */
const ROWS: readonly (readonly MenuCommand[])[] = [
  ['servers', 'repos'],
  ['digest', 'check'],
  ['job', 'points'],
  ['status', 'topics'],
  ['clear', 'help'],
];

/** The name of a command a key of the main menu stands for. */
export type MenuCommand = keyof typeof KEYS;

/** Back from the server menu, the report menu and the job menu. */
const HOME = '⬅️ На главную';
/** Marks the Selected server in the server menu. */
const SELECTED = '✅ ';
/** The report menu's key for the whole report. */
export const EVERY_REPOSITORY = '📚 Все репозитории';
/**
 * Begins the key of one repository. It is what tells the key from anything
 * else said in the chat, so a repository is known by it without a list to
 * look it up in.
 */
export const REPOSITORY = '🗄 ';
/**
 * What a job's key in the job menu begins with: how the job stands, in the
 * icons the bot says it with everywhere. The mark is also what tells the key
 * from anything else said in the chat.
 */
export const JOB_MARK: Record<JobMark, string> = {
  failed: '🔴',
  warning: '🟡',
  running: '▶️',
  success: '🟢',
  none: '⚪',
  disabled: '⏸',
};
/**
 * Jobs on one keyboard of the job menu. A keyboard is the markup of one
 * message, and Telegram refuses one too long; a server has over a hundred.
 */
export const JOBS_PER_PAGE = 50;
/** Above this many keys the way back is offered on top too, not only after the scroll. */
const LONG = 8;
/** The keys that turn the job menu's pages: «➡️ Дальше · 2/3» goes to page 2 of 3. */
const NEXT = '➡️ Дальше';
const BACK = '⬅️ Назад';
const TURN = /^(?:➡️ Дальше|⬅️ Назад) · (\d+)\/\d+$/u;

const keys = (rows: string[][]): TelegramKey[][] => rows.map((row) => row.map((text) => ({ text })));

/** Two to a row: five servers fit in three rows. */
const pairs = (labels: string[]): string[][] => {
  const rows: string[][] = [];
  for (let from = 0; from < labels.length; from += 2) rows.push(labels.slice(from, from + 2));
  return rows;
};

/**
 * The main menu. `selective` shows it only to the sender of the message the
 * menu answers: somebody stepping back out of the server menu must not reset
 * the keyboard of everybody else in the group.
 */
export const mainMenu = ({ selective = false } = {}): TelegramReplyKeyboard => ({
  keyboard: keys(ROWS.map((row) => row.map((name) => KEYS[name].label))),
  is_persistent: true,
  resize_keyboard: true,
  input_field_placeholder: 'Меню Veeam Monitor',
  ...(selective ? { selective: true } : {}),
});

/** The server menu: a key per server, the Selected one ticked, and the way back. Always selective. */
export const serverMenu = (servers: Array<{ name: string; selected: boolean }>): TelegramReplyKeyboard => ({
  keyboard: keys([...pairs(servers.map(({ name, selected }) => `${selected ? SELECTED : ''}${name}`)), [HOME]]),
  is_persistent: true,
  resize_keyboard: true,
  input_field_placeholder: 'Выберите сервер',
  selective: true,
});

/**
 * The report menu: the whole report, a key per repository two to a row,
 * each site's on rows of their own, and the way back. Always selective.
 */
export const reportMenu = (repositories: Array<{ short: string; site: string }>): TelegramReplyKeyboard => {
  const sites = [...new Set(repositories.map(({ site }) => site))];
  const rows = sites.flatMap((site) =>
    pairs(repositories.filter((repository) => repository.site === site).map(({ short }) => `${REPOSITORY}${short}`)),
  );
  return {
    keyboard: keys([[EVERY_REPOSITORY], ...rows, [HOME]]),
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: 'Выберите репозиторий',
    selective: true,
  };
};

/** Which page of `count` jobs `page` comes to, kept within the pages there are. */
export const jobPage = (count: number, page: number): { at: number; pages: number } => {
  const pages = Math.max(1, Math.ceil(count / JOBS_PER_PAGE));
  return { at: Math.min(Math.max(1, Math.trunc(page) || 1), pages), pages };
};

/**
 * The job menu: a key per job, one to a row since a job's name is long, in
 * the order given, a page at a time. Always selective, and kept while cards
 * are opened from it: a card carries Buttons of its own, not a keyboard.
 */
export const jobMenu = (jobs: JobChoice[], page = 1): TelegramReplyKeyboard => {
  const { at, pages } = jobPage(jobs.length, page);
  const shown = jobs.slice((at - 1) * JOBS_PER_PAGE, at * JOBS_PER_PAGE);
  const turns = [
    ...(at > 1 ? [`${BACK} · ${at - 1}/${pages}`] : []),
    ...(at < pages ? [`${NEXT} · ${at + 1}/${pages}`] : []),
  ];
  return {
    keyboard: keys([
      ...(shown.length > LONG ? [[HOME]] : []),
      ...shown.map(({ name, mark }) => [`${JOB_MARK[mark]} ${name}`]),
      ...(turns.length ? [turns] : []),
      [HOME],
    ]),
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: 'Выберите задание',
    selective: true,
  };
};

/** What pressing a key of the menu asks for. */
export type Pressed =
  | { kind: 'command'; name: MenuCommand }
  | { kind: 'home' }
  | { kind: 'server'; name: string }
  /** A key of the report menu: one repository, or `''` for every one. */
  | { kind: 'repository'; name: string }
  /** A key of the job menu: one job, by its name. */
  | { kind: 'job'; name: string }
  /** A page of the job menu. */
  | { kind: 'jobs'; page: number };

/**
 * The key `text` is the label of, or undefined for anything else said in the
 * chat. A server's key is its name, ticked or not; typing the name by hand is
 * the same as pressing it.
 */
export const menuPressed = (text: string, servers: Array<{ name: string }>): Pressed | undefined => {
  const said = text.trim();
  const command = (Object.keys(KEYS) as MenuCommand[]).find((name) => KEYS[name].label === said);
  if (command) return { kind: 'command', name: command };
  if (said === HOME) return { kind: 'home' };
  if (said === EVERY_REPOSITORY) return { kind: 'repository', name: '' };
  if (said.startsWith(REPOSITORY) && said.length > REPOSITORY.length) {
    return { kind: 'repository', name: said.slice(REPOSITORY.length).trim() };
  }
  const turn = TURN.exec(said);
  if (turn) return { kind: 'jobs', page: Number(turn[1]) };
  const mark = Object.values(JOB_MARK).find((icon) => said.startsWith(`${icon} `));
  const job = mark ? said.slice(mark.length + 1).trim() : '';
  if (job) return { kind: 'job', name: job };
  const name = said.startsWith(SELECTED) ? said.slice(SELECTED.length) : said;
  return servers.some((server) => server.name === name) ? { kind: 'server', name } : undefined;
};

/** Whether this markup is a keyboard for one person only, and so must reply to that person's message. */
export const isSelective = (markup: unknown): boolean =>
  typeof markup === 'object' && markup !== null && (markup as TelegramReplyKeyboard).selective === true;

/** The message the main menu is put under the input field with. */
export const MENU_TEXT: readonly string[] = [
  '🤖 <b>Меню Veeam Monitor</b>',
  '',
  'Кнопки — под полем ввода:',
  ...(Object.values(KEYS) as Array<{ label: string; does: string }>).map(({ label, does }) => `${label} — ${does}`),
];

/**
 * What the main menu is, as a string: posted again to a chat only when this
 * changes, so a restart does not post it every time.
 */
export const MENU_SIGNATURE = JSON.stringify(mainMenu().keyboard);

/** Whether this markup is a keyboard under the input field, rather than buttons on a message. */
export const isMenu = (markup: unknown): boolean =>
  typeof markup === 'object' && markup !== null && 'keyboard' in markup;
