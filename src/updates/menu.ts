import { TelegramKey, TelegramReplyKeyboard } from '../telegram/types';
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
  digest: { label: '📊 Сводка', does: 'задания выбранного сервера и какие из них не в порядке' },
  check: { label: '🔄 Проверить', does: 'опросить Veeam сейчас' },
  status: { label: '🩺 Статус', does: 'отвечает ли Veeam' },
  help: { label: '🤖 Помощь', does: 'все команды' },
} as const satisfies Partial<Record<CommandName, { label: string; does: string }>>;

/** The name of a command a key of the main menu stands for. */
export type MenuCommand = keyof typeof KEYS;

/** Back from the server menu. */
const HOME = '⬅️ На главную';
/** Marks the Selected server in the server menu. */
const SELECTED = '✅ ';

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
  keyboard: keys(
    [['servers'], ['digest', 'check'], ['status', 'help']].map((row) =>
      row.map((name) => KEYS[name as MenuCommand].label),
    ),
  ),
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

/** What pressing a key of the menu asks for. */
export type Pressed =
  | { kind: 'command'; name: MenuCommand }
  | { kind: 'home' }
  | { kind: 'server'; name: string };

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
