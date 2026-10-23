import type { Platform } from '../platform/types.js';

/**
 * The bot's own reactions on messages, so it only removes what it added (each add/remove is an
 * API call, and reaction endpoints are rate limited).
 */
export class Marks {
  private added = new Map<string, Set<string>>();

  constructor(private platform: Platform) {}

  private set(messageId: string): Set<string> {
    let s = this.added.get(messageId);
    if (!s) {
      s = new Set();
      this.added.set(messageId, s);
      if (this.added.size > 500) this.added.delete(this.added.keys().next().value!);
    }
    return s;
  }

  has(messageId: string, emoji: string): boolean {
    return this.added.get(messageId)?.has(emoji) ?? false;
  }

  async add(channelId: string, messageId: string, emoji: string): Promise<void> {
    const s = this.set(messageId);
    if (s.has(emoji)) return;
    s.add(emoji);
    await this.platform.react(channelId, messageId, emoji).catch(() => s.delete(emoji));
  }

  async remove(channelId: string, messageId: string, emoji: string): Promise<void> {
    const s = this.added.get(messageId);
    if (!s?.has(emoji)) return;
    s.delete(emoji);
    await this.platform.unreact(channelId, messageId, emoji).catch(() => {});
  }

  /** Adds `keep` (if given) and removes every other mark in `drop`. */
  async swap(channelId: string, messageId: string, drop: string[], keep?: string): Promise<void> {
    if (keep) await this.add(channelId, messageId, keep);
    for (const e of drop) if (e !== keep) await this.remove(channelId, messageId, e);
  }

  /** Removes all marks except `keep`. */
  async settle(channelId: string, messageId: string, keep: string | undefined): Promise<void> {
    await this.swap(channelId, messageId, [...(this.added.get(messageId) ?? [])], keep);
  }
}
