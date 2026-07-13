'use strict';

/**
 * rpcRateLimiter.js
 *
 * Small token-bucket wrapper for Solana Connection methods plus a bounded
 * batch processor. The previous local stub processed every item in a batch
 * sequentially, which made route simulation much slower than the configured
 * batch size suggested. This version keeps ordering but runs each batch with
 * bounded parallelism.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  if (!err) return false;
  const msg = String(err?.message || err || '');
  const text = msg.toLowerCase();
  return text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('429')
    || text.includes('websocket')
    || text.includes('timeout');
}

function wrapConnection(connection, options = {}) {
  if (!connection) return connection;

  const tokensPerSecond = Math.max(1, Number(options.tokensPerSecond || 20));
  const burstCapacity = Math.max(1, Number(options.burstCapacity || 20));
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || 4));

  let tokens = burstCapacity;
  let lastRefillTs = Date.now();
  let inFlight = 0;
  const queue = [];

  const refill = () => {
    const now = Date.now();
    const elapsedMs = now - lastRefillTs;
    if (elapsedMs <= 0) return;
    const addTokens = (elapsedMs / 1000) * tokensPerSecond;
    if (addTokens > 0) {
      tokens = Math.min(burstCapacity, tokens + addTokens);
      lastRefillTs = now;
    }
  };

  const tryRun = () => {
    refill();

    while (queue.length && inFlight < maxConcurrent && tokens >= 1) {
      const next = queue.shift();
      tokens -= 1;
      inFlight += 1;

      (async () => {
        try {
          next.resolve(await next.fn());
        } catch (err) {
          next.reject(err);
        } finally {
          inFlight -= 1;
          tryRun();
        }
      })();
    }

    if (queue.length && tokens < 1) {
      setTimeout(tryRun, Math.ceil(1000 / tokensPerSecond));
    }
  };

  const schedule = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    tryRun();
  });

  const wrapMethod = (methodName) => {
    const original = connection[methodName];
    if (typeof original !== 'function') return connection[methodName];
    return (...args) => schedule(() => original.apply(connection, args));
  };

  return {
    ...connection,
    __wrapped: true,
    __rateLimiter: { schedule },
    getAccountInfo: wrapMethod('getAccountInfo'),
    getMultipleAccountsInfo: wrapMethod('getMultipleAccountsInfo'),
    getProgramAccounts: wrapMethod('getProgramAccounts'),
    getSlot: wrapMethod('getSlot'),
  };
}

function createRateLimiter(options = {}) {
  const tokensPerSecond = Math.max(1, Number(options.tokensPerSecond || 20));
  const burstCapacity = Math.max(1, Number(options.burstCapacity || 20));
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || 4));

  let tokens = burstCapacity;
  let lastRefillTs = Date.now();
  let inFlight = 0;
  const queue = [];

  const refill = () => {
    const now = Date.now();
    const elapsedMs = now - lastRefillTs;
    if (elapsedMs <= 0) return;

    const addTokens = (elapsedMs / 1000) * tokensPerSecond;
    tokens = Math.min(burstCapacity, tokens + addTokens);
    lastRefillTs = now;
  };

  const tryRun = () => {
    refill();

    while (queue.length && inFlight < maxConcurrent && tokens >= 1) {
      const next = queue.shift();
      tokens -= 1;
      inFlight += 1;

      Promise.resolve()
        .then(next.fn)
        .then(next.resolve, next.reject)
        .finally(() => {
          inFlight -= 1;
          tryRun();
        });
    }

    if (queue.length && tokens < 1) {
      setTimeout(tryRun, Math.ceil(1000 / tokensPerSecond));
    }
  };

  const schedule = fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    tryRun();
  });

  return {
    schedule,
    wait: () => schedule(() => Promise.resolve(true)),
    stats: () => ({ queued: queue.length, inFlight, tokens })
  };
}

async function mapLimited(items, worker, concurrency) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

async function processInBatchesLimited(items, worker, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const batchSize = Math.max(1, Number(options.batchSize || 20));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const concurrency = Math.max(1, Number(options.concurrency || options.maxConcurrent || batchSize));
  const onBatchComplete = typeof options.onBatchComplete === 'function' ? options.onBatchComplete : null;

  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await mapLimited(
      batch,
      (item, localIndex) => worker(item, start + localIndex),
      Math.min(concurrency, batch.length),
    );
    results.push(...batchResults);

    if (onBatchComplete) {
      await onBatchComplete({
        batchStart: start,
        batchEnd: start + batch.length,
        total: items.length,
        batchSize: batch.length,
        results: batchResults,
      });
    }

    if (delayMs > 0 && start + batchSize < items.length) {
      await sleep(delayMs);
    }

    if (options.limiter && typeof options.limiter.wait === 'function') {
      await options.limiter.wait();
    }
  }

  return results;
}

module.exports = {
  createRateLimiter,
  wrapConnection,
  processInBatchesLimited,
  isRateLimitError,
};
