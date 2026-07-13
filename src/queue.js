const { signalDedupKey } = require("./signal.js");

class BoundedSignalQueue {
  #items = [];
  #dedupe = new Map();

  constructor({ capacity = 100, slotBucketSize = 2 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.slotBucketSize = slotBucketSize;
  }

  push(signal, now = Date.now()) {
    this.#purgeExpired(now);
    const key = signalDedupKey(signal, this.slotBucketSize);
    if (this.#dedupe.has(key)) {
      return { accepted: false, reason: "duplicate" };
    }

    if (this.#items.length >= this.capacity) {
      let worstIndex = 0;
      for (let index = 1; index < this.#items.length; index += 1) {
        if (
          Number(this.#items[index].projectedNetBps) <
          Number(this.#items[worstIndex].projectedNetBps)
        ) {
          worstIndex = index;
        }
      }

      if (
        Number(signal.projectedNetBps) <=
        Number(this.#items[worstIndex].projectedNetBps)
      ) {
        return { accepted: false, reason: "queue_full_lower_score" };
      }

      const [evicted] = this.#items.splice(worstIndex, 1);
      this.#dedupe.delete(signalDedupKey(evicted, this.slotBucketSize));
    }

    this.#items.push(signal);
    this.#dedupe.set(key, true);
    return { accepted: true };
  }

  popBest({ cycleId, legIndex, inputMint, now = Date.now() } = {}) {
    this.#purgeExpired(now);
    const eligible = this.#items
      .map((signal, index) => ({ signal, index }))
      .filter(({ signal }) => {
        if (cycleId !== undefined && signal.cycleId !== cycleId) return false;
        if (legIndex !== undefined && signal.legIndex !== legIndex) return false;
        if (inputMint !== undefined && signal.inputMint !== inputMint) return false;
        return true;
      })
      .sort((a, b) => Number(b.signal.projectedNetBps) - Number(a.signal.projectedNetBps));

    if (eligible.length === 0) return null;
    const { signal, index } = eligible[0];
    this.#items.splice(index, 1);
    this.#dedupe.delete(signalDedupKey(signal, this.slotBucketSize));
    return signal;
  }

  #purgeExpired(now) {
    const retained = [];
    for (const signal of this.#items) {
      const expiresAt = Date.parse(signal.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        this.#dedupe.delete(signalDedupKey(signal, this.slotBucketSize));
      } else {
        retained.push(signal);
      }
    }
    this.#items = retained;
  }

  get size() {
    return this.#items.length;
  }

  snapshot() {
    return [...this.#items];
  }
}
module.exports = BoundedSignalQueue;