/**
 * The live slots, declared once.
 *
 * A slot used to be spelled in five places: a union type, a config record, the
 * literal arguments in the monitor, two hard-coded `['performance',
 * 'repositories']` arrays governing pinning and heartbeat rewrites, and a
 * ternary chain mapping two slots to their configured thread ids.
 *
 * This module imports nothing, so the config shape can be derived from it
 * without a cycle.
 */

/**
 * Everything about a slot except what it says.
 *
 * Nothing is pinned, and every slot gets the heartbeat. 📈 and 💾 used to pin
 * their message, and skipped the heartbeat so as not to churn a pinned one.
 * But a slot posts a fresh message every 36 hours, and each pin left a
 * "pinned …" notice in the topic that outlived the message it pointed at and
 * that the bot cannot delete. A topic holds its one message anyway.
 */
export interface LiveSlotSpec {
  /**
   * Config key holding a thread id set by hand, for a topic somebody created
   * themselves rather than letting the bot create it. Named rather than read,
   * so this module stays free of the config type.
   */
  fixedThread?: 'performanceTopicId' | 'repositoriesTopicId';
}

export const LIVE_SLOTS = {
  health: {},
  running: {},
  schedule: {},
  performance: { fixedThread: 'performanceTopicId' },
  repositories: { fixedThread: 'repositoriesTopicId' },
  protection: {},
  restorePoints: {},
  orphans: {},
} as const satisfies Record<string, LiveSlotSpec>;

/** A topic that holds one always-current message instead of a stream of them. */
export type LiveSlot = keyof typeof LIVE_SLOTS;

export const specOf = (slot: LiveSlot): LiveSlotSpec => LIVE_SLOTS[slot];
