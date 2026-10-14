import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { AppConfig } from '../config/configuration';

/** Longest a page may take to print. Thirty pages take about ten seconds. */
const PRINT_TIMEOUT_MS = 120_000;

/**
 * What the browser is started with. No sandbox: the container runs with no
 * capability to make one, and the page is the report's own HTML, which
 * fetches nothing. No GPU, no /dev/shm — the container has neither to spare.
 */
const FLAGS = [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--no-first-run',
  '--no-pdf-header-footer',
  '--hide-scrollbars',
  // Time for the embedded fonts to load before the page is printed.
  '--virtual-time-budget=10000',
];

/**
 * Prints one page of HTML to PDF with a headless Chromium.
 *
 * The browser's own `--print-to-pdf`, one process per report, nothing kept
 * running between: a report is asked for a few times a week, and a browser
 * idling in the container for the rest of it would be the bot's largest
 * tenant. Page size and margins are the page's own (`@page`), and so are the
 * colours (`print-color-adjust`).
 */
@Injectable()
export class ReportPrinter {
  private readonly browser: string;
  /** The print before this one, done or not. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(config: ConfigService) {
    this.browser = config.getOrThrow<AppConfig['report']>('report').browser;
  }

  /**
   * One browser at a time: a few hundred megabytes each, in a container of a
   * gigabyte, and three people pressing a repository each in the same minute.
   */
  print(html: string): Promise<Buffer> {
    const printed = this.turn.then(() => this.printed(html));
    this.turn = printed.catch(() => undefined);
    return printed;
  }

  private async printed(html: string): Promise<Buffer> {
    if (!this.browser) throw new Error('REPORT_BROWSER не задан — PDF собрать нечем.');
    try {
      await access(this.browser);
    } catch {
      throw new Error(`Нет браузера для PDF: ${this.browser}. В образе бота он есть; вне образа укажите REPORT_BROWSER.`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'veeam-report-'));
    try {
      const page = join(dir, 'report.html');
      const pdf = join(dir, 'report.pdf');
      await writeFile(page, html);
      await run(this.browser, [...FLAGS, `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${pdf}`, pathToFileURL(page).href], {
        // The image's file system is read-only but for /tmp, where the browser writes everything.
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        XDG_CACHE_HOME: dir,
      });
      return await readFile(pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

const run = (file: string, args: string[], env: Record<string, string>): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PRINT_TIMEOUT_MS, env: { ...process.env, ...env } }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const said = String(stderr).split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error(`Браузер не напечатал PDF: ${error.killed ? 'не уложился во время' : error.message}${said ? ` — ${said}` : ''}`));
    });
  });
