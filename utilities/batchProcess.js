'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  const workerCount = Math.min(Math.max(1, Number(concurrency || 1)), list.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

async function processInBatches(items, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const batchSize = Math.max(1, Number(options.batchSize || list.length || 1));
  const concurrency = Math.max(1, Number(options.concurrency || options.maxConcurrent || batchSize));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const onBatchComplete = typeof options.onBatchComplete === 'function' ? options.onBatchComplete : null;
  const results = [];

  for (let start = 0; start < list.length; start += batchSize) {
    const batch = list.slice(start, start + batchSize);
    const batchResults = await mapLimited(
      batch,
      (item, localIndex) => worker(item, start + localIndex),
      Math.min(concurrency, batch.length)
    );

    results.push(...batchResults);

    if (onBatchComplete) {
      await onBatchComplete({
        batchStart: start,
        batchEnd: Math.min(start + batch.length, list.length),
        total: list.length,
        batchSize: batch.length,
        concurrency: Math.min(concurrency, batch.length),
        results: batchResults
      });
    }

    if (delayMs > 0 && start + batchSize < list.length) {
      await sleep(delayMs);
    }
  }

  return results;
}

module.exports = {
  sleep,
  mapLimited,
  processInBatches
};
