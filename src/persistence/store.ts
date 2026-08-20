/**
 * Minimal persistence contract shared by Redis and the development memory
 * implementation. Keeping this boundary small prevents the rest of the
 * application from depending directly on a Redis client.
 */
export interface PersistenceStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: "EX",
    ttlSeconds?: number
  ): Promise<unknown>;
  rpush(key: string, value: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  lrange(key: string, start: number, end: number): Promise<string[]>;
  quit(): Promise<unknown>;
}
