// Time source for the relay. Timers replace Durable Object alarms (03, Node implementation).

export interface Clock {
  now(): number;
  /** Runs `fn` at time `at` (ms); returns a cancel function. */
  schedule(at: number, fn: () => void): () => void;
}

/** setTimeout caps delays at 2^31-1 ms; longer waits re-arm in steps. */
const MAX_DELAY = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(at, fn) {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const delay = at - Date.now();
      timer = setTimeout(delay > MAX_DELAY ? arm : fn, Math.max(0, Math.min(delay, MAX_DELAY)));
    };
    arm();
    return () => clearTimeout(timer);
  },
};

/** A clock that only moves when told to; for tests (REQ-ROOM-7 without waiting). */
export class ManualClock implements Clock {
  #now: number;
  #timers: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  schedule(at: number, fn: () => void): () => void {
    const timer = { at, seq: this.#seq++, fn };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }

  /** Moves time forward, running every timer that falls due, in time order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = target;
  }
}
