export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/**
 * Semicolon, not comma: Excel on a ru/kk locale splits on the list separator
 * from Windows regional settings, which is ";" there. A comma-separated file
 * would open as a single column.
 */
const DELIMITER = ';';

/** Excel only detects UTF-8 in a .csv when the file starts with a BOM. */
const BOM = '﻿';

function escape(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'boolean' ? (value ? 'да' : 'нет') : String(value);

  // A leading =, +, - or @ makes Excel treat the cell as a formula. Values here
  // come from Veeam object names, so neutralise that.
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;

  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => escape(column.header)).join(DELIMITER);
  const body = rows.map((row) =>
    columns.map((column) => escape(column.value(row))).join(DELIMITER),
  );

  // CRLF keeps Excel happy on Windows.
  return BOM + [header, ...body].join('\r\n') + '\r\n';
}

/** Human-readable timestamp for a spreadsheet cell: 09.09.2026 10:14 */
export function csvDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Filename-safe timestamp: 2026-09-09_1014 */
export function fileStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}
