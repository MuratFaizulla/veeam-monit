/**
 * The live slots, declared once.
 *
 * A slot used to be spelled in five places: a union type, a config record, the
 * literal arguments in the monitor, two hard-coded `['performance',
 * 'repositories']` arrays governing pinning and heartbeat rewrites, and a
 * ternary chain mapping two slots to their configured thread ids. Which slots
 * get pinned was a string array buried inside an unrelated method, which is the
 * last place anybody would look for it.
 *
 * This module imports nothing, so the config shape can be derived from it
 * without a cycle.
 */

/** Everything about a slot except what it says. */
export interface LiveSlotSpec {
  /** Pinned in the chat, so the room sees it without scrolling. */
  pinned: boolean;
  /**
   * Rewritten on the heartbeat even when the content has not changed, so a
   * frozen "Обновлено" is evidence the monitor stopped rather than evidence
   * that nothing is happening.
   *
   * Off wherever `pinned` is on: rewriting a pinned message is churn the whole
   * room sees, and a pinned slot is looked at directly anyway.
   */
  heartbeat: boolean;
  /**
   * Config key holding a thread id set by hand, for a topic somebody created
   * themselves rather than letting the bot create it. Named rather than read,
   * so this module stays free of the config type.
   */
  fixedThread?: 'performanceTopicId' | 'repositoriesTopicId';
}

export const LIVE_SLOTS = {
  health: { pinned: false, heartbeat: true },
  running: { pinned: false, heartbeat: true },
  schedule: { pinned: false, heartbeat: true },
  performance: { pinned: true, heartbeat: false, fixedThread: 'performanceTopicId' },
  repositories: { pinned: true, heartbeat: false, fixedThread: 'repositoriesTopicId' },
  protection: { pinned: false, heartbeat: true },
  restorePoints: { pinned: false, heartbeat: true },
  orphans: { pinned: false, heartbeat: true },
} as const satisfies Record<string, LiveSlotSpec>;

/** A topic that holds one always-current message instead of a stream of them. */
export type LiveSlot = keyof typeof LIVE_SLOTS;

export const specOf = (slot: LiveSlot): LiveSlotSpec => LIVE_SLOTS[slot];
