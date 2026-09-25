/**
 * How one environment variable becomes one value, or one complaint naming it.
 *
 * Startup's check and the parser used to be two modules reading the same
 * environment by two sets of rules, and they disagreed: startup refused
 * `TELEGRAM_ROUTING_MODE=Single`, which the parser would have lower-cased, and
 * passed `TELEGRAM_QUEUE_LIMIT=1e3`, which the parser then read as 1. Here the
 * rule that yields a value is the rule that refuses one, so there is nothing
 * left to disagree.
 *
 * Every kind treats a variable that is unset, empty or blank as not set, and
 * yields its fallback. Every kind trims, except `verbatim`.
 */

/** The environment as ConfigModule hands it over, or process.env. */
export type Environment = Record<string, unknown>;

export interface Settings {
  /** 1, true, yes, on — or 0, false, no, off. Any case. */
  flag(key: string, fallback: boolean): boolean;
  /**
   * Digits with an optional minus sign and nothing else. `1e3`, `12abc`, `1.0`
   * and `0x10` are refused rather than read as whatever a parser makes of them.
   */
  integer(key: string, fallback: number, range: { min: number; max?: number }): number;
  /** A decimal number greater than zero: `2.5`, `3`, `.5`. */
  positive(key: string, fallback: number): number;
  /** Any text. With a rule, the text must pass it; `must` finishes "KEY must …". */
  text(key: string, fallback: string, rule?: { valid: (value: string) => boolean; must: string }): string;
  /** Exactly as written, for the values where surrounding spaces may be meant. */
  verbatim(key: string): string;
  /** An http or https URL (https only, when asked) without trailing slashes. */
  url(key: string, fallback: string, options?: { httpsOnly?: boolean }): string;
  /** One of `allowed`, in any case. */
  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
  /**
   * Comma-separated items of `allowed`, in any case. Empty items are ignored,
   * so a trailing comma is harmless. Not set means all of them.
   */
  someOf<T extends string>(key: string, allowed: readonly T[]): T[];
  /** Comma-separated items, each matching `item`. Empty items are ignored. */
  list(key: string, item: RegExp, must: string): string[];
  /** A rule across several variables. The message names them. */
  require(holds: boolean, message: string): void;
}

const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off'];
const INTEGER = /^-?\d+$/;
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

const either = (values: readonly string[]): string =>
  values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;

const isOneOf = <T extends string>(allowed: readonly T[], value: string): value is T =>
  (allowed as readonly string[]).includes(value);

const items = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Reads the settings `declare` asks for. Returns what it built, or throws one
 * error listing every variable that was wrong — all of them, so an operator
 * fixes the file once rather than once per restart.
 */
export const readSettings = <T>(env: Environment, declare: (settings: Settings) => T): T => {
  const problems: string[] = [];
  const raw = (key: string): string => {
    const value = env[key];
    return value === undefined || value === null ? '' : String(value);
  };
  const given = (key: string): string => raw(key).trim();
  /** Records what is wrong and yields the fallback, so reading carries on. */
  const refuse = <V>(message: string, fallback: V): V => {
    problems.push(message);
    return fallback;
  };

  const settings: Settings = {
    flag(key, fallback) {
      const value = given(key).toLowerCase();
      if (!value) return fallback;
      if (TRUE.includes(value)) return true;
      if (FALSE.includes(value)) return false;
      return refuse(`${key} must be true or false, not "${given(key)}"`, fallback);
    },

    integer(key, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
      const value = given(key);
      if (!value) return fallback;
      const parsed = INTEGER.test(value) ? Number(value) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
      const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
      return refuse(`${key} must be an integer ${range}, not "${value}"`, fallback);
    },

    positive(key, fallback) {
      const value = given(key);
      if (!value) return fallback;
      const parsed = DECIMAL.test(value) ? Number(value) : Number.NaN;
      if (parsed > 0) return parsed;
      return refuse(`${key} must be a number greater than 0, not "${value}"`, fallback);
    },

    text(key, fallback, rule) {
      const value = given(key);
      if (!value) return fallback;
      if (!rule || rule.valid(value)) return value;
      return refuse(`${key} must ${rule.must}, not "${value}"`, fallback);
    },

    verbatim(key) {
      return given(key) ? raw(key) : '';
    },

    url(key, fallback, { httpsOnly = false } = {}) {
      const value = given(key);
      if (!value) return fallback;
      const protocols = httpsOnly ? ['https:'] : ['http:', 'https:'];
      try {
        const parsed = new URL(value);
        if (parsed.hostname && protocols.includes(parsed.protocol)) return value.replace(/\/+$/, '');
      } catch {
        // Not a URL at all; refused below with the same message.
      }
      // The value is not repeated: a URL can carry credentials.
      return refuse(`${key} must be a valid ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} URL`, fallback);
    },

    oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
      const value = given(key).toLowerCase();
      if (!value) return fallback;
      if (isOneOf(allowed, value)) return value;
      return refuse(`${key} must be ${either(allowed)}, not "${given(key)}"`, fallback);
    },

    someOf<T extends string>(key: string, allowed: readonly T[]): T[] {
      const requested = items(given(key).toLowerCase());
      const unknown = requested.filter((item) => !isOneOf(allowed, item));
      if (unknown.length) {
        return refuse(`${key} may list only ${either(allowed)}, not "${unknown.join('", "')}"`, [...allowed]);
      }
      const chosen = requested.filter((item): item is T => isOneOf(allowed, item));
      return chosen.length ? chosen : [...allowed];
    },

    list(key, item, must) {
      const values = items(given(key));
      const wrong = values.filter((value) => !item.test(value));
      if (wrong.length) return refuse(`${key} must contain ${must}, not "${wrong.join('", "')}"`, []);
      return values;
    },

    require(holds, message) {
      if (!holds) problems.push(message);
    },
  };

  const value = declare(settings);
  if (problems.length) throw new Error(`Invalid settings:\n  ${problems.join('\n  ')}`);
  return value;
};
