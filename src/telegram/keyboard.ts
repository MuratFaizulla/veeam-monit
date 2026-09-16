import { TelegramBotCommand, TelegramKeyboard } from './types';

/**
 * The buttons under an answer, and what a pressed one means.
 *
 * Both halves live here because they are one decision seen twice: a button
 * carries `callback_data`, and something has to read it back. Written apart,
 * the two drift — the button says `job:abc`, the reader expects `j|abc`, and
 * nothing fails until somebody presses it in production. Here a change to the
 * encoding cannot reach one side without the other.
 *
 * Telegram caps `callback_data` at 64 bytes, which is why a job is addressed by
 * its id — a 36-character GUID — and never by its name.
 */

/** What pressing a button asks for. */
export type Action =
  | { kind: 'summary' }
  | { kind: 'check' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'job'; id: string };

const PREFIX = {
  summary: 'a:sum',
  check: 'a:chk',
  help: 'a:hlp',
  status: 'a:sts',
  job: 'a:job:',
} as const;

/** Telegram's own limit. A longer id is not encoded rather than truncated. */
const DATA_LIMIT = 64;

export const encode = (action: Action): string | undefined => {
  if (action.kind === 'job') {
    const data = `${PREFIX.job}${action.id}`;
    return Buffer.byteLength(data) <= DATA_LIMIT ? data : undefined;
  }
  return PREFIX[action.kind];
};

/** Undefined for anything this version does not recognise — an old message. */
export const decode = (data: string | undefined): Action | undefined => {
  if (!data) return undefined;
  if (data === PREFIX.summary) return { kind: 'summary' };
  if (data === PREFIX.check) return { kind: 'check' };
  if (data === PREFIX.help) return { kind: 'help' };
  if (data === PREFIX.status) return { kind: 'status' };
  if (data.startsWith(PREFIX.job)) {
    const id = data.slice(PREFIX.job.length);
    return id ? { kind: 'job', id } : undefined;
  }
  return undefined;
};

/** Telegram refuses an empty keyboard, so no rows means no markup at all. */
const keyboard = (rows: Array<Array<[string, Action]>>): TelegramKeyboard | undefined => {
  const inline_keyboard = rows
    .map((row) =>
      row
        .map(([text, action]) => {
          const callback_data = encode(action);
          return callback_data ? { text, callback_data } : undefined;
        })
        .filter((button): button is { text: string; callback_data: string } => Boolean(button)),
    )
    .filter((row) => row.length > 0);
  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
};

/** The standing offer under a status or help answer. */
export const mainKeyboard = (): TelegramKeyboard | undefined =>
  keyboard([
    [['📊 Сводка', { kind: 'summary' }], ['🔄 Проверить', { kind: 'check' }]],
    [['🤖 Команды', { kind: 'help' }]],
  ]);

/** Buttons that are the whole point of the message: a job each. */
const MAX_JOB_BUTTONS = 8;

export const jobsKeyboard = (
  jobs: Array<{ id: string; name: string }>,
  tail: Array<[string, Action]> = [],
): TelegramKeyboard | undefined =>
  keyboard([
    // One per row: a job name is long, and two to a row truncates both.
    ...jobs
      .slice(0, MAX_JOB_BUTTONS)
      .map((job): Array<[string, Action]> => [[job.name, { kind: 'job', id: job.id }]]),
    tail,
  ]);

/** Under a job card: ask the same question again, or step back out. */
export const cardKeyboard = (id: string): TelegramKeyboard | undefined =>
  keyboard([[['🔄 Обновить', { kind: 'job', id }], ['📊 Сводка', { kind: 'summary' }]]]);

/**
 * The menu Telegram shows next to the input field.
 *
 * Registered with the Bot API rather than printed, so somebody who has never
 * read `/help` still sees what the bot can do — which in a group, where the bot
 * was added once by one person and inherited by everybody else, is most people.
 *
 * `/job` is listed with its argument spelled out: the menu inserts the command
 * and leaves the cursor after it, so the description is the only place the
 * argument can be explained.
 */
export const BOT_COMMANDS: TelegramBotCommand[] = [
  { command: 'status', description: 'Состояние монитора: отвечает ли Veeam' },
  { command: 'digest', description: 'Сводка по всем заданиям' },
  { command: 'job', description: 'Карточка задания: /job часть имени' },
  { command: 'check', description: 'Опросить Veeam сейчас' },
  { command: 'topics', description: 'Известные боту темы форума' },
  { command: 'help', description: 'Что умеет бот' },
];
