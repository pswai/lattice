import { BusQueueOverflowError } from './errors.js';

type Waiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (err: Error) => void;
};

/**
 * Bounded async queue for inbound messages.
 *
 * - push(): enqueue an item. If a waiter is pending, deliver immediately.
 *   If at capacity, self-terminates with BusQueueOverflowError.
 * - shift(): dequeue or wait. Rejects if the queue ended with an error.
 * - end(err?): drain waiters, mark queue closed.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Waiter<T>[] = [];
  private endError: Error | null = null;
  private ended = false;

  constructor(private readonly maxSize: number) {}

  push(item: T): void {
    if (this.ended) return;

    if (this.waiters.length > 0) {
      const { resolve } = this.waiters.shift()!;
      resolve({ value: item, done: false });
      return;
    }

    if (this.items.length >= this.maxSize) {
      this.end(new BusQueueOverflowError(this.maxSize));
      return;
    }

    this.items.push(item);
  }

  shift(): Promise<IteratorResult<T>> {
    if (this.endError !== null) return Promise.reject(this.endError);
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });

    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift()!, done: false });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  end(err?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = err ?? null;

    const pending = this.waiters.splice(0);
    for (const { resolve, reject } of pending) {
      if (err) reject(err);
      else resolve({ value: undefined as never, done: true });
    }
  }

  get isEnded(): boolean {
    return this.ended;
  }
}
