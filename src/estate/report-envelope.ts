import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { escapeHtml as esc } from '../telegram/format';
import { Answer } from './answer';

/**
 * What every report's file is put in, whatever it says: the document around
 * its pages, with the font inside it and a rule that the browser fetches
 * nothing; and, beside the file, the moment it was read, the caption under
 * it and its name. The Repository report, the Job report and the Points report go in it.
 *
 * It used to be the Repository report's: the Job report's pages borrowed its
 * fonts and its stamp, each page wrote its own document around them, and the
 * one thing that lets the browser print without a sandbox — that the page
 * asks for nothing outside itself — was each page's to keep.
 */

/** One report's page, before it goes in the envelope. */
export interface Page {
  /** The language it is written in: Veeam's sessions are in English, the rest in Russian. */
  lang: 'ru' | 'en';
  /** What the document is called, as plain text. */
  title: string;
  /** Its stylesheet. */
  style: string;
  /** Everything on it, as HTML. */
  body: string;
}

/**
 * A page in its envelope: what the printer is handed, and nothing else is.
 * A string the type tells apart, so that no page reaches the browser — which
 * runs with no sandbox — without the rule that it fetches nothing.
 */
export type ReportDocument = string & { readonly enveloped: true };

/**
 * The page may fetch nothing, whatever it names: its styles, its font and any
 * picture are inside it. The browser prints it with no sandbox
 * (`./report-printer`), which is safe for a page that asks for nothing else.
 */
const NOTHING_FETCHED = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

export const envelope = (page: Page): ReportDocument =>
  `<!doctype html><html lang="${page.lang}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${NOTHING_FETCHED}"><title>${esc(page.title)}</title><style>${fonts()}${page.style}</style></head><body>${page.body}</body></html>` as ReportDocument;

/**
 * Inter, inside the page: the browser fetches nothing, and the server has no
 * fonts with Cyrillic of its own. Read once, a few hundred kilobytes.
 */
let embedded: string | undefined;
const fonts = (): string => {
  if (embedded === undefined) {
    const css = require.resolve('@fontsource-variable/inter/index.css');
    const dir = dirname(css);
    embedded = readFileSync(css, 'utf8').replace(
      /url\(\.\/files\/([^)]+)\)/g,
      (_, file: string) => `url(data:font/woff2;base64,${readFileSync(join(dir, 'files', file)).toString('base64')})`,
    );
  }
  return embedded;
};

/** "13.10.2026 15:27" in the operator's zone. */
export const stampOf = (at: number, timezone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
};

/* ------------------------------------------------------------------ *
 * Beside the file: how a thing stands, the caption, the file's name
 * ------------------------------------------------------------------ */

/** How a report finds a job or a repository to stand. */
export type Status = 'crit' | 'warn' | 'ok' | 'unknown';

/** A status by its colour, as a caption says it. */
export const STATUS_ICON: Record<Status, string> = { crit: '🔴', warn: '🟡', ok: '🟢', unknown: '⚪' };
/** A status in words, as a page heads it; a caption says them lower-cased. */
export const STATUS_WORD: Record<Status, string> = { crit: 'Критично', warn: 'Внимание', ok: 'Норма', unknown: 'Нет данных' };

/** What the caption under a printed report says, and what its file is called. */
export interface Caption {
  /** Before the title: 📄 for a report, 🗂 for a job's points. */
  icon?: string;
  /** In bold, as plain text: the job's name, «Репозитории Veeam». */
  title: string;
  /** After the title, as plain text: what of it the file is, «точки восстановления». */
  kind?: string;
  /** Beside the title, as plain text: how the job stands, how many repositories there are. */
  beside?: string;
  /** Under it, as HTML: what the report found. */
  lines: string[];
  /** At the foot, as plain text, before the moment it was read: «BAAS · за 30 дней». */
  covers: string;
  /** After that moment, as plain text: how to ask for less. */
  hint?: string;
  /** The file's name before the day it was read, as plain text: «Задание OPS_Exchange». */
  file: string;
}

/**
 * A report printed from a reading made at `at`, as the Answer it is sent as:
 * the file, named for what it is about and the day, and the caption under
 * it — the title in bold, what was found, and in italics what it covers and
 * when it was read.
 */
export const printedAnswer = (caption: Caption, content: Buffer, at: number, timezone: string): Answer => {
  const stamp = stampOf(at, timezone);
  return {
    text: [
      `${caption.icon ?? '📄'} <b>${esc(caption.title)}</b>${caption.kind ? ` · ${esc(caption.kind)}` : ''}${caption.beside ? ` — ${esc(caption.beside)}` : ''}`,
      ...caption.lines,
      '',
      `<i>${esc(caption.covers)}, на ${stamp}.${caption.hint ? ` ${esc(caption.hint)}` : ''}</i>`,
    ].join('\n'),
    // A name from Veeam may hold what a file name may not.
    document: { filename: `${caption.file.replace(/[\\/:*?"<>|]+/g, '_')} ${stamp.slice(0, 10)}.pdf`, content },
  };
};
