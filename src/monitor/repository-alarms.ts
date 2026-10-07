import { NotificationEvent } from '../telegram/types';
import { RepositoryCapacity } from '../estate/repository-capacity';

/**
 * Which repositories are short of space, as the alerts they are owed.
 *
 * Reads Repository capacity and nothing else: `freePercent` exists only when
 * Veeam reported free space, and a repository nobody can say anything about is
 * left alone — it used to be treated as zero free and raised a critical alert.
 *
 * `cleared` lists the alarms of repositories that are back above the
 * threshold, so the next shortage is announced at once rather than waiting out
 * the cooldown of the previous one.
 */
export interface RepositoryAlarms {
  events: NotificationEvent[];
  cleared: string[];
}

export const repositoryAlarms = (
  repositories: RepositoryCapacity[],
  policy: { thresholdPercent: number; cooldownMs: number },
): RepositoryAlarms => {
  const { thresholdPercent, cooldownMs } = policy;
  const alarms: RepositoryAlarms = { events: [], cleared: [] };
  if (thresholdPercent <= 0) return alarms;

  for (const repository of repositories) {
    const { freePercent, freeGB, capacityGB } = repository;
    if (freePercent === undefined) continue;
    const key = `repo:${repository.key}`;
    if (freePercent >= thresholdPercent) {
      alarms.cleared.push(key);
      continue;
    }
    alarms.events.push({
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
  return alarms;
};

/** "3.8 TB", "512.0 GB". */
const sizeOf = (gb: number): string => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`);
