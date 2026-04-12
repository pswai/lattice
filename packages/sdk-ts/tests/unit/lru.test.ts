import { describe, it, expect } from 'vitest';
import { LruCache } from '../../src/lru.js';

describe('LruCache', () => {
  it('reports has() correctly for added and absent keys', () => {
    const cache = new LruCache<string>(3);
    expect(cache.has('a')).toBe(false);
    cache.add('a');
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('evicts the oldest key when at capacity', () => {
    const cache = new LruCache<string>(3);
    cache.add('a');
    cache.add('b');
    cache.add('c');
    expect(cache.size).toBe(3);

    cache.add('d'); // should evict 'a' (oldest)
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
    expect(cache.size).toBe(3);
  });

  it('refreshes an existing key instead of evicting when re-added', () => {
    const cache = new LruCache<string>(3);
    cache.add('a');
    cache.add('b');
    cache.add('c');

    // Refresh 'a' — 'b' should now be oldest
    cache.add('a');
    cache.add('d'); // should evict 'b' (now oldest)

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('tracks size accurately through adds and evictions', () => {
    const cache = new LruCache<number>(5);
    for (let i = 0; i < 5; i++) {
      cache.add(i);
      expect(cache.size).toBe(i + 1);
    }
    // Adding beyond capacity keeps size at max
    cache.add(99);
    expect(cache.size).toBe(5);
    cache.add(100);
    expect(cache.size).toBe(5);
  });

  it('handles a cache of size 1', () => {
    const cache = new LruCache<string>(1);
    cache.add('x');
    expect(cache.has('x')).toBe(true);
    cache.add('y');
    expect(cache.has('x')).toBe(false);
    expect(cache.has('y')).toBe(true);
    expect(cache.size).toBe(1);
  });
});
