// Buffers frames a test socket receives, for RelayUnderTest adapters.
import type { Received } from "./suite.js";

export class FrameQueue {
  #items: Received[] = [];
  #waiters: ((ev: Received) => void)[] = [];

  push(ev: Received): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(ev);
    else this.#items.push(ev);
  }

  next(timeoutMs = 3000): Promise<Received> {
    const ready = this.#items.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`no frame within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = (ev: Received) => {
        clearTimeout(timer);
        resolve(ev);
      };
      this.#waiters.push(waiter);
    });
  }

  async quiet(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.#items.length > 0) throw new Error(`expected no frames, got ${JSON.stringify(this.#items[0])}`);
  }
}
