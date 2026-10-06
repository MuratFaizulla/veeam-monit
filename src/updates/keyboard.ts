import { TelegramKeyboard } from '../telegram/types';

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
 * its id — a 36-character GUID — and never by its name, beside the key of its
 * server, which configuration keeps to 16 ASCII characters for this reason.
 *
 * These are the buttons *under a message*. The menu under the input field is
 * `./menu`.
 */

/** What pressing a button asks for. */
export type Action =
  | { kind: 'summary' }
  | { kind: 'check' }
  | { kind: 'help' }
  | { kind: 'status' }
  /** Empty General: the yes under the question the 🧹 key asks. */
  | { kind: 'clear' }
  /**
   * One job's card. `server` is the key of the server the job is on; a Button
   * from before there was a list carries none.
   */
  | { kind: 'job'; id: string; server?: string }
  /** One job's restore points, addressed the same way. */
  | { kind: 'points'; id: string; server?: string };

/** The Actions that address one job, and so carry its id. */
type JobAction = Extract<Action, { id: string }>;

const PREFIX = {
  summary: 'a:sum',
  check: 'a:chk',
  help: 'a:hlp',
  status: 'a:sts',
  clear: 'a:clr',
  job: 'a:job:',
  points: 'a:pts:',
} as const;

/** Telegram's own limit. A longer id is not encoded rather than truncated. */
const DATA_LIMIT = 64;

const fits = (data: string): string | undefined =>
  Buffer.byteLength(data) <= DATA_LIMIT ? data : undefined;

export const encode = (action: Action): string | undefined => {
  if (action.kind === 'job' || action.kind === 'points') {
    // A job id is a GUID and never holds a colon, so the server goes first.
    const server = action.server === undefined ? '' : `${action.server}:`;
    return fits(`${PREFIX[action.kind]}${server}${action.id}`);
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
  if (data === PREFIX.clear) return { kind: 'clear' };
  for (const kind of ['job', 'points'] as const) {
    if (!data.startsWith(PREFIX[kind])) continue;
    const rest = data.slice(PREFIX[kind].length);
    const colon = rest.indexOf(':');
    if (colon === -1) return rest ? { kind, id: rest } : undefined;
    const server = rest.slice(0, colon);
    const id = rest.slice(colon + 1);
    return server && id ? { kind, id, server } : undefined;
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

/** Under the question the 🧹 key asks: the one Button that empties General. */
export const clearKeyboard = (): TelegramKeyboard | undefined =>
  keyboard([[['🧹 Да, очистить', { kind: 'clear' }]]]);

/** Buttons that are the whole point of the message: a job each. */
const MAX_JOB_BUTTONS = 8;

/** `opens` is what a job's Button shows: its card, or its restore points. */
export const jobsKeyboard = (
  jobs: Array<{ id: string; name: string }>,
  tail: Array<[string, Action]> = [],
  server?: string,
  opens: JobAction['kind'] = 'job',
): TelegramKeyboard | undefined =>
  keyboard([
    // One per row: a job name is long, and two to a row truncates both.
    ...jobs
      .slice(0, MAX_JOB_BUTTONS)
      .map((job): Array<[string, Action]> => [[job.name, { kind: opens, id: job.id, server }]]),
    tail,
  ]);

/** Under a job card: ask the same question again, see its points, or step back out. */
export const cardKeyboard = (id: string, server?: string): TelegramKeyboard | undefined =>
  keyboard([
    [
      ['🔄 Обновить', { kind: 'job', id, server }],
      ['🗂 Точки', { kind: 'points', id, server }],
      ['📊 Сводка', { kind: 'summary' }],
    ],
  ]);

/** Under a job's points: ask again, see its card, or step back out. */
export const pointsKeyboard = (id: string, server?: string): TelegramKeyboard | undefined =>
  keyboard([
    [
      ['🔄 Обновить', { kind: 'points', id, server }],
      ['📋 Карточка', { kind: 'job', id, server }],
      ['📊 Сводка', { kind: 'summary' }],
    ],
  ]);
