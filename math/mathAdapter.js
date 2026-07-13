/**
 * mathAdapter.js — Unified Math Dispatcher
 *
 * Routes quote requests to the correct Q_* adapter based on pool.dexType.
 * Caches adapter instances by poolAddress.
 *
 * Critical: projectedNetBps uses pool divergence data (pairMidDeviationBps)
 * when available, since that's the actual edge for single-hop profitable swaps.
 */

'use strict';

const { mergeCanonicalPool } = require('./poolContract');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Lazy-loaded adapters ───
let _WhirlpoolAdapter = null;
let _CLMMAdapter = null;
let _DLMMAdapter = null;
let _CPMMAdapter = null;

function loadWhirlpool() {
  if (_WhirlpoolAdapter) return _WhirlpoolAdapter;
  const mod = require('./Q_WHIRLPOOL');
  _WhirlpoolAdapter = mod.WhirlpoolAdapter || mod;
  return _WhirlpoolAdapter;
}
function loadCLMM() {
  if (_CLMMAdapter) return _CLMMAdapter;
  const mod = require('./Q_CLMM');
  _CLMMAdapter = mod.CLMMQuoter || mod.CLMMAdapter || mod;
  return _CLMMAdapter;
}
function loadDLMM() {
  if (_DLMMAdapter) return _DLMMAdapter;
  const mod = require('./Q_DLMM');
  _DLMMAdapter = mod.DLMMAdapter || mod;
  return _DLMMAdapter;
}
function loadCPMM() {
  if (_CPMMAdapter) return _CPMMAdapter;
  const mod = require('./Q_CPMM');
  _CPMMAdapter = mod.CPMMAdapter || mod;
  return _CPMMAdapter;
}

function createAdapter(dexType, poolAddress, poolShape) {
  const type = String(dexType || poolShape?.dexType || '').toUpperCase();
  if (type.includes('WHIRLPOOL') || type.includes('ORCA')) {
    const Adapter = loadWhirlpool();
    return new Adapter(null, poolAddress, poolShape);
  }
  if (type.includes('CLMM') || (type.includes('RAYDIUM') && !type.includes('CPMM') && !type.includes('AMM'))) {
    const Adapter = loadCLMM();
    return new Adapter(null, poolAddress, poolShape);
  }
  if (type.includes('DLMM') || type.includes('METEORA')) {
    const Adapter = loadDLMM();
    return new Adapter(null, poolAddress, poolShape);
  }
  if (type.includes('CPMM') || type.includes('AMM') || type.includes('STABLE')) {
    const Adapter = loadCPMM();
    return new Adapter(null, poolAddress, poolShape);
  }
  throw new Error(`Unsupported dexType for math adapter: ${type}`);
}

function deriveSwapForY(pool, inputMint, outputMint) {
  const xMint = String(pool.tokenXMint || pool.baseMint || pool.mintA || '');
  if (inputMint === xMint) return true;
  const yMint = String(pool.tokenYMint || pool.quoteMint || pool.mintB || '');
  if (inputMint === yMint) return false;
  if (pool.swapForY !== undefined) return Boolean(pool.swapForY);
  return true;
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null || value === '') return 0n;
  try { return BigInt(String(value)); } catch { return 0n; }
}

/**
 * Compute projectedNetBps for a single-hop swap.
 *
 * Uses pool divergence data (pairMidDeviationBps) as the gross edge when
 * available — this is the core signal for profitable swaps. Falls back to
 * price-impact-based estimation only when no divergence data exists.
 */
function computeProjectedNetBps(quote, pool, inputMint, outputMint) {
  // Respect an explicit projectedNetBps if set by a higher layer
  if (quote.projectedNetBps !== undefined && quote.projectedNetBps !== null) {
    const explicit = Number(quote.projectedNetBps);
    if (Number.isFinite(explicit)) return explicit;
  }

  const feeBps = Number(quote.feeBps ?? pool?.feeBps ?? 0);
  const safetyBufferBps = Number(process.env.SAFETY_BUFFER_BPS || 1.5);
  const priceImpactBps = Number(quote.priceImpactBps ?? quote.impactBps ?? 0);

  // ── Primary: use pool divergence/mid-deviation as the gross edge ──
  const deviationBps = Number(pool?.pairMidDeviationBps ?? pool?.midDeviationBps ?? NaN);
  if (Number.isFinite(deviationBps) && deviationBps !== 0) {
    const baseMint = String(pool?.pairBaseMint || pool?.baseMint || pool?.tokenXMint || '').trim();
    const quoteMint = String(pool?.pairQuoteMint || pool?.quoteMint || pool?.tokenYMint || '').trim();

    const isSellingBase = inputMint && outputMint && String(inputMint) === baseMint && String(outputMint) === quoteMint;
    const isSellingQuote = inputMint && outputMint && String(inputMint) === quoteMint && String(outputMint) === baseMint;

    // Deviation > 0: base is expensive, quote is cheap
    // Deviation < 0: base is cheap,   quote is expensive
    let grossEdgeBps = 0;
    if (deviationBps > 0 && isSellingBase) grossEdgeBps = Math.abs(deviationBps);
    else if (deviationBps < 0 && isSellingQuote) grossEdgeBps = Math.abs(deviationBps);
    else if (deviationBps > 0 && isSellingQuote) grossEdgeBps = -Math.abs(deviationBps);
    else if (deviationBps < 0 && isSellingBase) grossEdgeBps = -Math.abs(deviationBps);
    else grossEdgeBps = 0; // no directional info

    // If price impact is reasonable, use it as a penalty; if it's extreme, the
    // pool state is likely broken — treat the edge as 0.
    if (priceImpactBps > 80) return -9999; // broken pool state marker

    return Number((grossEdgeBps - feeBps - safetyBufferBps).toFixed(4));
  }

  // ── Fallback: no divergence data — use price impact direction ──
  // Negative price impact = favorable (output > expected at mid price)
  const grossEdgeBps = -priceImpactBps;
  return Number((grossEdgeBps - feeBps - safetyBufferBps).toFixed(4));
}

class MathAdapter {
  constructor(opts = {}) {
    this.cache = new Map();
    this.cacheTTLMs = Number(opts.cacheTTLMs || 30000);
    this.connection = opts.connection || null;
    this.log = opts.logger || console;
  }

  async quote(params) {
    const { poolShape, amountInAtomic, inputMint, outputMint, slippageBps = 50, refresh = false, swapForY: swapForYParam } = params;
    if (!poolShape) return this._fail('poolShape is required');

    const pool = mergeCanonicalPool(poolShape);
    const poolAddress = pool.poolAddress || pool.address;
    if (!poolAddress) return this._fail('pool missing address');

    // Use explicit swapForY if provided (from PoolInterestGate), else derive from mints
    const swapForY = swapForYParam !== undefined ? swapForYParam : deriveSwapForY(pool, inputMint, outputMint);

    try {
      const adapter = await this._getAdapter(poolAddress, pool, refresh);
      const quoteResult = await adapter.quoteExactIn(
        String(amountInAtomic), swapForY, Number(slippageBps),
        { pool, refresh: !!refresh, connection: this.connection }
      );

      if (!quoteResult) return this._fail('quote returned null');

      const success = Boolean(quoteResult.success);
      const outAmountRaw = String(quoteResult.outAmountRaw ?? quoteResult.amountOutRaw ?? '0');
      const minOutAmountRaw = String(quoteResult.minOutAmountRaw ?? '0');

      if (!success) {
        return {
          success: false, outAmountRaw: '0', minOutAmountRaw: '0',
          feeBps: Number(quoteResult.feeBps ?? pool.feeBps ?? 0),
          projectedNetBps: null, priceImpactBps: null, error: quoteResult.error || 'quote_unsuccessful', raw: quoteResult,
        };
      }

      if (toBigInt(outAmountRaw) <= 0n) {
        return {
          success: false, outAmountRaw: '0', minOutAmountRaw: '0',
          feeBps: Number(quoteResult.feeBps ?? pool.feeBps ?? 0),
          projectedNetBps: null, priceImpactBps: null, error: 'zero_output', raw: quoteResult,
        };
      }

      const feeBps = Number(quoteResult.feeBps ?? pool.feeBps ?? 0);
      const priceImpactBps = Number(quoteResult.priceImpactBps ?? quoteResult.impactBps ?? 0);
      const projectedNetBps = computeProjectedNetBps(quoteResult, pool, inputMint, outputMint);

      return {
        success: true, outAmountRaw, minOutAmountRaw, feeBps, projectedNetBps, priceImpactBps,
        error: null, raw: quoteResult,
      };
    } catch (err) {
      this.log.debug('[mathAdapter] quote error', { pool: poolAddress, error: err.message });
      return this._fail(err.message);
    }
  }

  async _getAdapter(poolAddress, poolShape, refresh) {
    const now = Date.now();
    const cached = this.cache.get(poolAddress);
    if (!refresh && cached && (now - cached.createdAt) < this.cacheTTLMs) {
      cached.poolShape = { ...cached.poolShape, ...poolShape };
      return cached.adapter;
    }
    const adapter = createAdapter(poolShape.dexType, poolAddress, poolShape);
    if (typeof adapter.init === 'function') await adapter.init();
    this.cache.set(poolAddress, { adapter, poolShape, createdAt: now });
    return adapter;
  }

  _fail(error) {
    return { success: false, outAmountRaw: '0', minOutAmountRaw: '0', feeBps: 0, projectedNetBps: null, priceImpactBps: null, error };
  }

  clearCache() { this.cache.clear(); }
  cacheSize() { return this.cache.size; }
  warmup(pools = []) {
    return { ok: true, pools: Array.isArray(pools) ? pools.length : 0 };
  }
}

module.exports = { MathAdapter, SOL_MINT, deriveSwapForY, computeProjectedNetBps };
