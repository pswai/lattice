/**
 * Least-recently-used cache keyed by K with value V.
 * Uses Map insertion-order for O(1) eviction of the oldest entry.
 * Defaults V to `true` so set-style dedup callers can still do `cache.add(k)`.
 */
export class LruCache<K, V = true> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /**
   * Set key → value. Refreshes position on re-set; evicts oldest at capacity.
   */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  /** Convenience for set-style usage: `cache.add(key)` stores `true`. */
  add(this: LruCache<K, true>, key: K): void {
    this.set(key, true);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
