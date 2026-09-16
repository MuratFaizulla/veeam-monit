/** Reject malformed operator settings before the monitor starts using them. */
export const validateEnvironment = (env: Record<string, unknown>): Record<string, unknown> => {
  const value = (key: string): string => String(env[key] ?? '').trim();
  const integer = (key: string, min: number, max = Number.MAX_SAFE_INTEGER): void => {
    const raw = value(key);
    if (!raw) return;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
  };

  integer('PORT', 1, 65535);
  integer('VEEAM_TIMEOUT_MS', 1);
  integer('TELEGRAM_MONITOR_INTERVAL_MS', 0);
  integer('TELEGRAM_SEND_INTERVAL_MS', 0);
  integer('TELEGRAM_QUEUE_LIMIT', 1);
  integer('TELEGRAM_JOB_COOLDOWN_MIN', 0);
  integer('TELEGRAM_AUTH_COOLDOWN_MIN', 0);
  integer('TELEGRAM_REPOSITORY_COOLDOWN_MIN', 0);
  integer('TELEGRAM_REPOSITORY_FREE_PERCENT', 0, 100);
  integer('TELEGRAM_DIGEST_HOUR', -1, 23);
  integer('TELEGRAM_PROTECTION_INTERVAL_MIN', 1);
  integer('TELEGRAM_PROTECTION_STALE_DAYS', 0);
  integer('TELEGRAM_PROTECTION_FAILURE_STREAK', 1);
  integer('TELEGRAM_LIVE_REFRESH_MIN', 1);
  integer('TELEGRAM_PERFORMANCE_TOPIC_ID', 0);
  integer('TELEGRAM_REPOSITORIES_TOPIC_ID', 0);

  const booleans = [
    'API_DOCS', 'VEEAM_INSECURE_TLS', 'TELEGRAM_CREATE_TOPICS',
    'TELEGRAM_LIVE', 'TELEGRAM_LIVE_ORPHANS',
  ];
  for (const key of booleans) {
    const raw = value(key).toLowerCase();
    if (raw && !['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(raw)) {
      throw new Error(`${key} must be true or false`);
    }
  }

  if (Boolean(value('VEEAM_MONITOR_USERNAME')) !== Boolean(value('VEEAM_MONITOR_PASSWORD'))) {
    throw new Error('VEEAM_MONITOR_USERNAME and VEEAM_MONITOR_PASSWORD must be set together');
  }

  const factor = value('TELEGRAM_PROTECTION_OVERDUE_FACTOR');
  if (factor && !(Number(factor) > 0 && Number.isFinite(Number(factor)))) {
    throw new Error('TELEGRAM_PROTECTION_OVERDUE_FACTOR must be greater than 0');
  }

  const url = (key: string, httpsOnly = false): void => {
    const raw = value(key);
    if (!raw) return;
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname || (httpsOnly ? parsed.protocol !== 'https:' : !['http:', 'https:'].includes(parsed.protocol))) {
        throw new Error('invalid protocol');
      }
    } catch {
      throw new Error(`${key} must be a valid ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} URL`);
    }
  };
  url('VEEAM_BASE_URL');
  url('TELEGRAM_WEBHOOK_URL', true);
  if (value('TELEGRAM_WEBHOOK_URL') && !value('TELEGRAM_WEBHOOK_SECRET')) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is set');
  }

  const routing = value('TELEGRAM_ROUTING_MODE');
  if (routing && !['single', 'job', 'severity', 'kind'].includes(routing)) {
    throw new Error('TELEGRAM_ROUTING_MODE must be single, job, severity or kind');
  }
  const severities = value('TELEGRAM_SEVERITIES');
  if (severities && severities.split(',').some((part) => !['critical', 'warning', 'success', 'info'].includes(part.trim()))) {
    throw new Error('TELEGRAM_SEVERITIES contains an unknown severity');
  }
  const chatIds = value('TELEGRAM_CHAT_IDS');
  if (chatIds && chatIds.split(',').some((part) => !/^-?\d+$/.test(part.trim()))) {
    throw new Error('TELEGRAM_CHAT_IDS must contain numeric chat IDs');
  }
  const timezone = value('TELEGRAM_TIMEZONE');
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new Error('TELEGRAM_TIMEZONE must be a valid IANA time zone');
    }
  }
  return env;
};
