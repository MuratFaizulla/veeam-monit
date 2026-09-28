import { escapeHtml } from '../telegram/format';
import { Action, mainKeyboard } from './keyboard';
import { TelegramBotCommand, TelegramChat, TelegramMarkup } from '../telegram/types';

/**
 * The bot's commands, declared once.
 *
 * A command used to be spelled in four places: the menu registered with
 * `setMyCommands`, the `/help` text, the dispatch that answered it, and — for
 * one with a Button — the dispatch that answered the press. Adding one meant
 * editing all of them, and they had already drifted: the menu told the group
 * `/clear` worked "в этой теме" while `/help` said General, which is the only
 * place any command is answered at all.
 *
 * Everything a reader of the chat can learn about a command comes from its
 * entry here. The menu and `/help` are derived from this list and the dispatch
 * reads it, so a command cannot be listed without being answered or answered
 * without being listed.
 *
 * What each Answer says is not here — bar `/help`, which is this list. The
 * rest need the monitor, the rate limits and the Answer log, and live in
 * `TelegramCommandsService`; an entry only names which one it gives, through
 * `Answers`.
 */

/** One Answer, rendered: the lines of one message and the Buttons under it. */
export interface Reply {
  lines: readonly string[];
  /** Buttons under the message, or the menu under the input field. */
  markup?: TelegramMarkup;
}

/** The question a command or a Button put. */
export interface Asked {
  /** The chat it was asked in. The Answer goes to that chat's General. */
  chat: TelegramChat;
  /**
   * Everything typed after the command word, as one argument in the case it
   * was typed: a job name has underscores and capitals, and the person asking
   * copied it from somewhere. Empty for a Button.
   */
  argument: string;
  /** The message that asked, when it was typed rather than pressed. */
  messageId?: number;
}

/** The Answers a command can give. `TelegramCommandsService` gives them. */
export interface Answers {
  status(asked: Asked): Reply;
  menu(): Reply;
  servers(): Reply;
  check(): Promise<Reply>;
  summary(): Promise<Reply>;
  job(name: string): Promise<Reply>;
  knownTopics(asked: Asked): Reply;
  clear(asked: Asked): Promise<Reply>;
}

/**
 * A Button that stands for a command. A job's own Button is not one: it
 * carries an id, and `/job` is asked with a half-remembered name.
 */
export type CommandButton = Exclude<Action['kind'], 'job'>;

export interface Command {
  /** What is typed after the slash, and what the menu shows. */
  name: string;
  /**
   * Also answered, never listed. `/start` is what Telegram sends when somebody
   * presses "Start"; `/chatid` is what people type while setting the bot up.
   */
  aliases?: readonly string[];
  /** Spelled out in `/help` after the name, e.g. `<имя>`. Plain text. */
  argument?: string;
  /**
   * One line in the command menu. The menu inserts the command and leaves the
   * cursor after it, so for a command with an argument this line is the only
   * place the argument can be explained.
   */
  menu: string;
  /**
   * The command's paragraph in `/help`, after "<b>/name</b> — ". HTML. Says
   * what the command *does*, not what it is called: "/check" tells somebody
   * who already knows nothing.
   */
  help: readonly string[];
  /**
   * The Button that asks the same thing. A press is answered exactly as the
   * command typed with nothing after it.
   */
  button?: CommandButton;
  /** Which Answer the command gives. */
  answer(answers: Answers, asked: Asked): Reply | Promise<Reply>;
}

/** In menu order, which is also the order of `/help`. */
const DECLARED = [
  {
    name: 'status',
    aliases: ['start', 'chatid'],
    menu: 'Состояние монитора: отвечает ли Veeam',
    help: [
      'отвечает ли Veeam, авторизована ли служебная учётная запись,',
      'когда была последняя проверка. Ничего не запускает.',
    ],
    button: 'status',
    answer: (answers, asked) => answers.status(asked),
  },
  {
    name: 'menu',
    menu: 'Показать кнопки меню под полем ввода',
    help: ['показать кнопки меню под полем ввода, если они пропали.'],
    answer: (answers) => answers.menu(),
  },
  {
    name: 'servers',
    menu: 'Выбрать сервер Veeam',
    help: [
      'серверы Veeam и их состояние. Кнопкой выбирается сервер, который',
      'показывают живые темы, <code>/digest</code> и <code>/job</code>. Оповещения приходят со всех.',
    ],
    answer: (answers) => answers.servers(),
  },
  {
    name: 'digest',
    menu: 'Сводка по всем заданиям',
    help: [
      'сводка по всем заданиям: сколько успешных, сколько с ошибкой',
      'и какие именно не в порядке. Это состояние на сейчас, а не за сутки.',
    ],
    button: 'summary',
    answer: (answers) => answers.summary(),
  },
  {
    name: 'job',
    argument: '<имя>',
    menu: 'Карточка задания: /job часть имени',
    help: [
      'карточка одного задания: последний результат и причина,',
      'длительность, следующий запуск, точки восстановления, последние запуски.',
      'Имя можно писать частями и в любом регистре: <code>/job kingston db</code>',
    ],
    answer: (answers, asked) => answers.job(asked.argument),
  },
  {
    name: 'check',
    menu: 'Опросить Veeam сейчас',
    help: [
      'прогнать цикл опроса немедленно, не дожидаясь минутного таймера.',
      'Не чаще раза в полминуты.',
    ],
    button: 'check',
    answer: (answers) => answers.check(),
  },
  {
    name: 'topics',
    menu: 'Известные боту темы форума',
    help: ['какие темы форума бот уже знает.'],
    answer: (answers, asked) => answers.knownTopics(asked),
  },
  {
    name: 'clear',
    menu: 'Убрать мои ответы в General',
    help: [
      'убрать мои ответы в General, когда их накопилось много.',
      'Оповещения и живые сообщения не трогает — это записи о событиях.',
    ],
    answer: (answers, asked) => answers.clear(asked),
  },
  {
    name: 'help',
    menu: 'Что умеет бот',
    help: ['этот список.'],
    button: 'help',
    answer: () => ({ lines: HELP, markup: mainKeyboard() }),
  },
] as const satisfies readonly Command[];

export const COMMANDS: readonly Command[] = DECLARED;

/** The name of every command the bot declares. */
export type CommandName = (typeof DECLARED)[number]['name'];

/**
 * Fails the build, naming the kind, when a Button stands for no command. Its
 * press would otherwise be acknowledged and ignored, like a Button from an
 * older version, and nothing would say so until somebody pressed it.
 */
type Claimed = Extract<(typeof DECLARED)[number], { button: string }>['button'];
type NoneLeft<Unclaimed extends never> = Unclaimed;
export type EveryButtonIsACommand = NoneLeft<Exclude<CommandButton, Claimed>>;

/** The command `/name` (without the slash or a `@bot` suffix) asks for, if any. */
export const commandNamed = (name: string): Command | undefined =>
  COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));

/** The command a Button stands for. */
export const commandPressed = (button: CommandButton): Command | undefined =>
  COMMANDS.find((command) => command.button === button);

/** The menu Telegram shows next to the input field. Aliases stay out of it. */
export const BOT_COMMANDS: TelegramBotCommand[] = COMMANDS.map(({ name, menu }) => ({
  command: name,
  description: menu,
}));

/**
 * `/help`, spelled out.
 *
 * It used to hang off `/start`, which in a group nobody presses — the bot was
 * added by one person years ago and the rest of the room inherited it.
 */
export const HELP: readonly string[] = [
  '🤖 <b>Veeam Monitor — команды</b>',
  '',
  ...COMMANDS.flatMap(({ name, argument, help: [first, ...rest] }) => [
    `<b>/${name}${argument ? ` ${escapeHtml(argument)}` : ''}</b> — ${first}`,
    ...rest,
    '',
  ]),
  '<i>Перезапустить службу из чата нельзя: процесс не может перезапустить сам себя,</i>',
  '<i>а кнопка перезагрузки, доступная всей группе, — это новая проблема вместо старой.</i>',
];
