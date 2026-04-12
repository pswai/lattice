/**
 * Least-recently-used cache keyed by type K.
 * Uses Map insertion-order for O(1) eviction of the oldest entry.
 */
export class LruCache<K> {
  private readonly map = new Map<K, true>();

  constructor(private readonly maxSize: number) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Add key to the cache. If it already exists, refresh its position (make it newest).
   * Evicts the oldest entry if at capacity.
   */
  add(key: K): void {
    if (this.map.has(key)) {
      // Refresh: delete then re-insert moves it to the end (newest position)
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first in insertion order)
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    this.map.set(key, true);
  }

  get size(): number {
    return this.map.size;
  }
}
