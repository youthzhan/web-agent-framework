import type { PersistenceStore } from "./store.js";

/**
 * Development-only persistence. It mirrors the Redis commands used by the
 * message/thread stores, but intentionally does not survive process restart.
 */
export class MemoryPersistenceStore implements PersistenceStore {
  private readonly values = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode?: "EX",
    _ttlSeconds?: number
  ): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async expire(_key: string, _ttlSeconds: number): Promise<1> {
    return 1;
  }

  async lrange(key: string, start: number, end: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const normalizedStart = start < 0 ? Math.max(list.length + start, 0) : start;
    const normalizedEnd =
      end < 0 ? list.length + end : Math.min(end, list.length - 1);
    return normalizedEnd < normalizedStart
      ? []
      : list.slice(normalizedStart, normalizedEnd + 1);
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }
}
