import { FailedObject } from '../estate/job-card';
import { iconOf } from '../estate/job-state';
import { RunStanding } from '../estate/runs';

/**
 * What a job alert says beyond the job's own fields: where its run stands, and
 * which of its machines went wrong.
 *
 * Both are the answers to the question every failure alert raised and none
 * answered. "Попытка: 1 из 4" was on every one of them, because a failure is
 * announced after its first attempt; whether Veeam would try again, and when,
 * was not. The body was the session's message, which for a machine that
 * failed is "Processing APPDB1-T3Q4" — its name, and not a word about why.
 */

/** Objects listed per group; the rest are counted. */
const OBJECTS_SHOWN = 5;

/** A reason longer than this is cut: the head of it is what says what broke. */
const REASON_SHOWN = 300;

/**
 * "2 из 4 · Veeam повторит ≈ сегодня в 04:33", "4 из 4 · повторов больше не
 * будет", or nothing when there is nothing to count.
 *
 * `when` writes an epoch-ms moment as the rest of the message writes moments.
 */
export const attemptLine = (
  standing: RunStanding,
  result: string,
  when: (at: number) => string,
): string | undefined => {
  const { attempt, allowed, retryAt } = standing;
  const count = allowed ? `${attempt} из ${allowed}` : String(attempt);
  // Veeam retries a failure only. A warning or a success ends the run, and its
  // count is worth saying only when retries came before it; so is a failure's
  // when the job's policy could not be read and nothing is known of what next.
  if (result !== 'failed' || !allowed) return attempt > 1 ? count : undefined;
  if (retryAt !== undefined) return `${count} · Veeam повторит ≈ ${when(retryAt)}`;
  return `${count} · повторов больше не будет`;
};

/**
 * The machines that went wrong, each with its reason, or `message` — the
 * session's own — when Veeam named none: a run that never reached its machine
 * starts no task for it, and then the session message is the whole story.
 *
 * Plain text: it is sent as the alert's preformatted block, which is also what
 * lets an error be copied whole into a search or a ticket.
 */
export const objectsBody = (objects: FailedObject[], message?: string): string | undefined => {
  const failed = objects.filter((object) => object.result === 'failed');
  const warned = objects.filter((object) => object.result === 'warning');
  if (failed.length + warned.length === 0) return message;

  const lines: string[] = [];
  const group = (title: string, list: FailedObject[]): void => {
    if (list.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(`${title}: ${list.length} из ${objects.length}`);
    for (const object of list.slice(0, OBJECTS_SHOWN)) {
      const why = object.message ? ` — ${clip(object.message)}` : '';
      lines.push(`${iconOf(object.result ?? '')} ${object.name}${why}`);
    }
    if (list.length > OBJECTS_SHOWN) lines.push(`… и ещё ${list.length - OBJECTS_SHOWN}`);
  };
  group('Не прошли', failed);
  group('С предупреждением', warned);
  return lines.join('\n');
};

const clip = (text: string): string =>
  text.length <= REASON_SHOWN ? text : `${text.slice(0, REASON_SHOWN - 1).trimEnd()}…`;
