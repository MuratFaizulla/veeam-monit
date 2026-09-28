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
  /**
   * One job's card. `server` is the key of the server the job is on; a Button
   * from before there was a list carries none.
   */
  | { kind: 'job'; id: string; server?: string };

const PREFIX = {
  summary: 'a:sum',
  check: 'a:chk',
  help: 'a:hlp',
  status: 'a:sts',
  job: 'a:job:',
} as const;

/** Telegram's own limit. A longer id is not encoded rather than truncated. */
const DATA_LIMIT = 64;

const fits = (data: string): string | undefined =>
  Buffer.byteLength(data) <= DATA_LIMIT ? data : undefined;

export const encode = (action: Action): string | undefined => {
  if (action.kind === 'job') {
    // A job id is a GUID and never holds a colon, so the server goes first.
    const server = action.server === undefined ? '' : `${action.server}:`;
    return fits(`${PREFIX.job}${server}${action.id}`);
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
    const rest = data.slice(PREFIX.job.length);
    const colon = rest.indexOf(':');
    if (colon === -1) return rest ? { kind: 'job', id: rest } : undefined;
    const server = rest.slice(0, colon);
    const id = rest.slice(colon + 1);
    return server && id ? { kind: 'job', id, server } : undefined;
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
  server?: string,
): TelegramKeyboard | undefined =>
  keyboard([
    // One per row: a job name is long, and two to a row truncates both.
    ...jobs
      .slice(0, MAX_JOB_BUTTONS)
      .map((job): Array<[string, Action]> => [[job.name, { kind: 'job', id: job.id, server }]]),
    tail,
  ]);

/** Under a job card: ask the same question again, or step back out. */
export const cardKeyboard = (id: string, server?: string): TelegramKeyboard | undefined =>
  keyboard([[['🔄 Обновить', { kind: 'job', id, server }], ['📊 Сводка', { kind: 'summary' }]]]);
