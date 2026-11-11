import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { appendFileSync, chmodSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { dirname } from 'path';

const MAX_BYTES = 5 * 1024 * 1024;
/**
 * Full files kept beside the one being written. A minute's cycle over five
 * servers fills one in about a day, and one kept file was a day and a half of
 * history: whatever went wrong the night before last was already gone.
 */
const KEPT_FILES = 9;

/**
 * Moves a log that outgrew `maxBytes` aside as `.1`, the one that was `.1` to
 * `.2` and so on; the file past `kept` is dropped.
 */
export const rotate = (filePath: string, maxBytes = MAX_BYTES, kept = KEPT_FILES): void => {
  if (!existsSync(filePath) || statSync(filePath).size <= maxBytes) return;
  for (let index = kept; index >= 1; index -= 1) {
    const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
    // Onto the next name: the oldest is replaced by the rename itself.
    if (existsSync(from)) renameSync(from, `${filePath}.${index}`);
  }
};

/**
 * Console logger that also appends every line to a file, so latency and error
 * history survives after the terminal scrollback is gone. The file is rotated
 * when it grows past 5 MB, and the nine before it are kept (`.log.1` the
 * newest, `.log.9` the oldest): 50 MB at most, a week and more of history.
 */
export class FileLogger extends ConsoleLogger {
  constructor(private readonly filePath: string) {
    super();
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }

  protected printMessages(
    messages: unknown[],
    context?: string,
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
  ): void {
    super.printMessages(messages, context, logLevel, writeStreamType);

    const timestamp = new Date().toISOString();
    const prefix = context ? `[${context}] ` : '';
    const lines = messages
      .map((message) => `${timestamp} ${logLevel.toUpperCase().padEnd(7)} ${prefix}${this.render(message)}`)
      .join('\n');

    this.append(`${lines}\n`);
  }

  private render(message: unknown): string {
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  private append(line: string): void {
    try {
      rotate(this.filePath);
      appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch {
      // Logging must never break a request: a locked or full disk is ignored.
    }
  }
}
