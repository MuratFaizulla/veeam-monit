import {
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  NotificationEvent,
  NotificationKind,
  NotificationSeverity,
} from './telegram.types';
// Type-only: the builders accept whatever the HTTP layer may send, and that
// list is declared once, where it is documented.
import type { ProbeBody } from './telegram.dto';

/**
 * The two events a human can ask for over HTTP.
 *
 * Both used to be assembled inside the controller, which meant the shape of an
 * announcement, the list of accepted kinds and the wording of every rejection
 * could only be exercised by standing up an HTTP layer — so none of it was.
 * Here they are plain functions over plain objects: what is accepted and what
 * the event ends up looking like are one decision, made once, in a place a test
 * can call directly.
 *
 * Rejection is a returned value rather than an exception. These inputs are
 * untrusted by definition and being refused is an ordinary outcome, not a
 * failure; the caller turns `message` into whatever its protocol calls a bad
 * request.
 */
export type ManualEvent =
  | { ok: true; event: NotificationEvent }
  | { ok: false; message: string };

/** A free-form announcement, posted as an ordinary manual notification. */
export const announcement = (text: string | undefined): ManualEvent => {
  const title = text?.trim();
  if (!title) return { ok: false, message: 'text is required' };
  return { ok: true, event: { kind: 'manual', severity: 'info', title } };
};

/**
 * A synthetic event sent through the real routing path.
 *
 * This is how a deployment is verified end to end — including topic creation —
 * without waiting for a job to actually fail, which is why it carries a real
 * kind and severity rather than always looking like an announcement.
 */
export const probe = (input: ProbeBody): ManualEvent => {
  const kind = (input.kind ?? 'job') as NotificationKind;
  const severity = (input.severity ?? 'info') as NotificationSeverity;
  if (!NOTIFICATION_KINDS.includes(kind)) {
    return { ok: false, message: `kind must be one of ${NOTIFICATION_KINDS.join(', ')}` };
  }
  if (!NOTIFICATION_SEVERITIES.includes(severity)) {
    return {
      ok: false,
      message: `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`,
    };
  }

  return {
    ok: true,
    event: {
      kind,
      severity,
      subject: input.subject,
      title: input.title ?? 'Проверка маршрутизации Veeam Monitor',
      fields: [
        ['Категория', kind],
        ['Важность', severity],
        ['Объект', input.subject ?? '—'],
      ],
      body: input.body,
    },
  };
};
