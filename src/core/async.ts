/** An unbounded async queue usable as an AsyncIterable that never ends until closed. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A promise you can resolve from outside. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Calls `fn` at most once per `ms`, always with the latest arguments; a call during the wait is
 * delivered when the wait ends. `flush()` runs a pending call now.
 */
export function throttle<A extends unknown[]>(ms: number, fn: (...args: A) => void | Promise<void>) {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let pending: A | undefined;
  let running: Promise<void> | undefined;
  const fire = () => {
    timer = undefined;
    if (!pending) return;
    const args = pending;
    pending = undefined;
    last = Date.now();
    running = Promise.resolve(fn(...args)).catch(() => {}).finally(() => (running = undefined));
  };
  const call = (...args: A) => {
    pending = args;
    if (timer) return;
    const wait = Math.max(0, ms - (Date.now() - last));
    timer = setTimeout(fire, wait);
  };
  call.flush = async () => {
    if (timer) {
      clearTimeout(timer);
      fire();
    }
    await running;
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return call;
}
