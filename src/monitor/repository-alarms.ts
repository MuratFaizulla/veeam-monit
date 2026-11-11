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
  /** The other servers a repository is attached to, by its key; said under the alarm. */
  alsoOn: ReadonlyMap<string, string[]> = new Map(),
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
        ['Also attached to', alsoOn.get(repository.key)?.join(', ')],
      ],
      dedupeKey: key,
      cooldownMs,
    });
  }
};

/** What one server is to say of its repositories this cycle: the ones it speaks for, and who else attaches them. */
export interface Spoken {
  repositories: RepositoryCapacity[];
  alsoOn: Map<string, string[]>;
}

/**
 * Which server speaks for which repository, so one disk is one alarm.
 *
 * A share attached to four servers is four repositories to Veeam, and each
 * server used to raise its own alarm about it: one full disk was four
 * messages every cooldown. A folder is spoken for by the first server on the
 * list that reads it this cycle, under that server's cooldown, and the alarm
 * names the others. A local disk, which has no folder, is its server's own.
 *
 * `servers` are in the order of the list; one that did not answer has no
 * repositories and speaks for none, so the next one does: while the first is
 * down a shortage may be said once more, which is the right way to be wrong.
 */
export const spokenFor = (servers: { name: string; repositories: RepositoryCapacity[] | undefined }[]): Spoken[] => {
  const holders = new Map<string, string[]>();
  for (const { name, repositories } of servers) {
    for (const folder of new Set((repositories ?? []).flatMap((repository) => repository.folder ?? []))) {
      holders.set(folder, [...(holders.get(folder) ?? []), name]);
    }
  }
  const taken = new Set<string>();
  return servers.map(({ name, repositories }) => {
    const spoken: Spoken = { repositories: [], alsoOn: new Map() };
    for (const repository of repositories ?? []) {
      const { folder } = repository;
      if (folder) {
        if (taken.has(folder)) continue;
        taken.add(folder);
        const others = (holders.get(folder) ?? []).filter((other) => other !== name);
        if (others.length) spoken.alsoOn.set(repository.key, others);
      }
      spoken.repositories.push(repository);
    }
    return spoken;
  });
};

/** "3.8 TB", "512.0 GB". */
const sizeOf = (gb: number): string => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`);
