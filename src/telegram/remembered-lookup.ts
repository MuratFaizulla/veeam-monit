import { lookup, LookupAddress, LookupOptions } from 'dns';

type Answer = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Lookup = (hostname: string, options: LookupOptions, callback: Answer) => void;

/**
 * A name lookup that answers from the last address it was given when the
 * resolver does not answer.
 *
 * The host's two DNS servers went silent for a night. Telegram itself was
 * where it had been, at the address resolved a minute earlier, and the bot
 * neither sent an alert nor heard a button until the resolvers came back:
 * every call ended in `EAI_AGAIN api.telegram.org`. An address is remembered
 * only as long as the process lives and used only when the resolver fails, so
 * the day Telegram moves, the first lookup that works moves the bot with it.
 */
export const rememberingLookup = (resolve: Lookup = lookup as Lookup): Lookup => {
  const known = new Map<string, [string | LookupAddress[], number | undefined]>();
  return (hostname, options, callback) => {
    // `all` and `family` change the shape of the answer: one memory for each.
    const key = `${hostname} ${JSON.stringify(options ?? {})}`;
    resolve(hostname, options, (error, address, family) => {
      if (!error) {
        known.set(key, [address, family]);
        return callback(null, address, family);
      }
      const last = known.get(key);
      return last ? callback(null, last[0], last[1]) : callback(error, address, family);
    });
  };
};
