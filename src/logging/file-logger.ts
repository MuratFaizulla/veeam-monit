import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { appendFileSync, chmodSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { dirname } from 'path';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Console logger that also appends every line to a file, so latency and error
 * history survives after the terminal scrollback is gone. The file is rotated
 * once (`.log` -> `.log.1`) when it grows past 5 MB.
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
      if (existsSync(this.filePath) && statSync(this.filePath).size > MAX_BYTES) {
        renameSync(this.filePath, `${this.filePath}.1`);
      }
      appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch {
      // Logging must never break a request: a locked or full disk is ignored.
    }
  }
}
