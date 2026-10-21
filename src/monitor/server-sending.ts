import { Cooldowns, EventCooldowns } from '../telegram/cooldowns';
import { aboutServer } from '../telegram/format';
import { DeliveryReport } from '../telegram/telegram.service';
import { NotificationEvent } from '../telegram/types';

/** What one server's Server watch and repository alarms are handed, and its Job alerts the `send` of: its sending, or a test's. */
export interface Sending {
  /** Sends one event about the server and says what became of it; only whether it reached nobody matters to them. */
  send(event: NotificationEvent): Promise<Pick<DeliveryReport, 'outcome'>>;
  /** Lets the next event about the server under `dedupeKey` go out at once, whatever its cooldown. */
  forget(dedupeKey: string): void;
}

/** Sends one alert and says what became of it. */
export type Send = Sending['send'];

/** Delivery as the monitor does it: the event, checked against and armed in `cooldowns`. */
export type Deliver = (event: NotificationEvent, cooldowns: EventCooldowns) => Promise<DeliveryReport>;

export interface ServerSendingSettings {
  /** Whether there are several servers, and so an event must say which one it is about. */
  several: boolean;
  /** Epoch ms; the clock the cooldowns are read against. */
  now: () => number;
}

/**
 * What the monitor says about one Veeam server, and that server's cooldowns.
 *
 * With several servers an event names its server first in the title — what
 * a notification on a locked phone shows — and its cooldown is that server's
 * alone: the same job id on two servers is two conditions, not one. With one
 * server an event goes as it is, under the key it always had, so a state
 * file from before the server list, or from before this, still holds the
 * cooldowns it was written with. The keys lie in the file as they did: the
 * server's key and a colon before the event's own, with several servers.
 *
 * The scoping used to be the monitor's alone, so whatever else touched a
 * server's cooldown had to hand its key back to it: the Server watch was
 * handed a way to forget one, and the repository alarms returned the keys
 * they cleared for the monitor to scope. Now each of them is handed this, and
 * forgets what it means to under the key it sent.
 *
 * Read against the clock it is handed, so a test that needs a cooldown to
 * run out, or the daily Summary to be due, moves a clock rather than waiting.
 *
 * One per server, built by the monitor beside it, like the Job alerts and the
 * Server watch it is handed to.
 */
export class ServerSending implements Sending {
  /** This server's cooldowns, as Delivery checks an event against them and arms them. */
  private readonly own: EventCooldowns;

  constructor(
    private readonly server: { key: string; name: string },
    private readonly deliver: Deliver,
    private readonly cooldowns: Cooldowns,
    private readonly settings: ServerSendingSettings,
  ) {
    this.own = {
      isSuppressed: (key) => cooldowns.isSuppressed(key && this.scoped(key), settings.now()),
      arm: (key, cooldownMs) => cooldowns.arm(key && this.scoped(key), cooldownMs, settings.now()),
    };
  }

  send(event: NotificationEvent): Promise<DeliveryReport> {
    return this.deliver(this.settings.several ? aboutServer(event, this.server.name) : event, this.own);
  }

  forget(dedupeKey: string): void {
    this.cooldowns.clear(this.scoped(dedupeKey));
  }

  /** Whether an event about this server under `dedupeKey` would be held back by its cooldown now. */
  isSuppressed(dedupeKey: string): boolean {
    return this.own.isSuppressed(dedupeKey);
  }

  /** A key that is this server's alone. With one server the keys are what they always were. */
  private scoped(key: string): string {
    return this.settings.several ? `${this.server.key}:${key}` : key;
  }
}
