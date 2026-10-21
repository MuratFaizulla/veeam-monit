import { RepositoryCapacity } from '../estate/repository-capacity';
import { Sending } from './server-sending';

/**
 * Says which of one server's repositories are short of space, through that
 * server's sending.
 *
 * Reads Repository capacity and nothing else: `freePercent` exists only when
 * Veeam reported free space, and a repository nobody can say anything about is
 * left alone — it used to be treated as zero free and raised a critical alert.
 *
 * A repository back above the threshold has its alarm forgotten, so the next
 * shortage is announced at once rather than waiting out the cooldown of the
 * previous one. Under which key is this module's own: it used to hand the
 * keys back for the monitor to make them the server's, which only the
 * monitor knew how to do; the server's sending does that now.
 */
export const sendRepositoryAlarms = async (
  repositories: RepositoryCapacity[],
  policy: { thresholdPercent: number; cooldownMs: number },
  sending: Sending,
): Promise<void> => {
  const { thresholdPercent, cooldownMs } = policy;
  if (thresholdPercent <= 0) return;

  for (const repository of repositories) {
    const { freePercent, freeGB, capacityGB } = repository;
    if (freePercent === undefined) continue;
    const key = `repo:${repository.key}`;
    if (freePercent >= thresholdPercent) {
      sending.forget(key);
      continue;
    }
    await sending.send({
      kind: 'repository',
      // Under half the threshold is the one that fills up tonight.
      severity: freePercent < thresholdPercent / 2 ? 'critical' : 'warning',
      subject: repository.subject,
      title: `Repository ${repository.name} is low on space`,
      fields: [
        ['Free', `${sizeOf(freeGB ?? 0)} (${freePercent.toFixed(1)}%)`],
        ['Capacity', sizeOf(capacityGB ?? 0)],
        ['Alert below', `${thresholdPercent}% free`],
        ['Server', repository.hostName],
        ['Path', repository.path],
      ],
      dedupeKey: key,
      cooldownMs,
    });
  }
};

/** "3.8 TB", "512.0 GB". */
const sizeOf = (gb: number): string => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`);
