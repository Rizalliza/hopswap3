'use strict';

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { mergeCanonicalPool, finalizeQuote } = require('./poolContract');
const { buildCpmmSwapTx, quoteCpmmLiveExactIn } = require('./transact/tx_cpmm.js');
const { v4Reserve } = require('./helpers/cpmm');

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    if (trimmed.includes('.')) return BigInt(trimmed.split('.')[0] || '0');
    return BigInt(trimmed);
  }
  return BigInt(value.toString());
}

function normalizePools(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.pools)) return raw.pools;
  if (Array.isArray(raw?.data)) return raw.data;
  return Object.values(raw || {});
}

function normalizePoolRecord(pool = {}) {
  return mergeCanonicalPool({
    ...pool,
    type: pool.type || 'cpmm',
    dexType: pool.dexType || 'RAYDIUM_CPMM',
  });
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function reserveSideFromPool(poolShape, side) {
  const isX = side === 'x';
  const reserve = firstDefined(
    poolShape.reserves?.[side],
    isX ? poolShape.reserveX : poolShape.reserveY,
    isX ? poolShape.baseReserve : poolShape.quoteReserve,
    isX ? poolShape.vaultAAmount : poolShape.vaultBAmount,
    isX ? poolShape.baseVaultAmount : poolShape.quoteVaultAmount,
  );
  const openOrders = firstDefined(
    isX ? poolShape.openOrdersBaseTokenTotal : poolShape.openOrdersQuoteTokenTotal,
    isX ? poolShape.baseOpenOrders : poolShape.quoteOpenOrders,
    isX ? poolShape.openOrdersBase : poolShape.openOrdersQuote,
    0,
  );
  const needTakePnl = firstDefined(
    isX ? poolShape.baseNeedTakePnl : poolShape.quoteNeedTakePnl,
    isX ? poolShape.needTakePnlCoin : poolShape.needTakePnlPc,
    isX ? poolShape.baseNeedTakePnlAmount : poolShape.quoteNeedTakePnlAmount,
    0,
  );

  const hasV4Terms = openOrders !== undefined || needTakePnl !== undefined;
  if (hasV4Terms && reserve !== undefined) {
    return v4Reserve({ vault: reserve, openOrders, needTakePnl });
  }
  return toBigInt(reserve);
}

function reserveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps = 20) {
  const amountIn = toBigInt(inAmountAtomic);
  let reserveX = reserveSideFromPool(poolShape, 'x');
  let reserveY = reserveSideFromPool(poolShape, 'y');
  const feeBps = BigInt(poolShape.feeBps || 0);
  const dexType = poolShape.dexType || 'RAYDIUM_CPMM';

  // --- DECIMAL SANITY ---
  const inDecimals = swapForY ? (poolShape.tokenXDecimals ?? 9) : (poolShape.tokenYDecimals ?? 6);
  const outDecimals = swapForY ? (poolShape.tokenYDecimals ?? 6) : (poolShape.tokenXDecimals ?? 9);
  // If reserves are suspiciously small ( < 1e6 atomic units ) assume they are in UI decimals.
  const needsScaling = (reserveX < 1_000_000n && (poolShape.tokenXDecimals ?? 9) > 0);
  if (needsScaling) {
    const scale = 10n ** BigInt(inDecimals);
    reserveX = reserveX * scale;
    reserveY = reserveY * (10n ** BigInt(outDecimals));
  }

  if (reserveX <= 0n || reserveY <= 0n) {
    return finalizeQuote({ success: false, error: 'Zero reserves' }, poolShape);
  }

  const amountAfterFee = amountIn * (10_000n - feeBps) / 10_000n;
  const outAmount = swapForY
    ? (amountAfterFee * reserveY) / (reserveX + amountAfterFee)
    : (amountAfterFee * reserveX) / (reserveY + amountAfterFee);

  // --- SANITY CHECK: reject if output > 1_000_000× input (in lamport terms) ---
  const maxPlausible = amountIn * 1_000_000n;
  if (outAmount > maxPlausible) {
    return finalizeQuote({ success: false, error: 'Implausibly large output (sanity cap)' }, poolShape);
  }

  const minOutAmount = outAmount * (10_000n - BigInt(slippageBps)) / 10_000n;
  return finalizeQuote({
    dexType,
    poolAddress: poolShape.poolAddress,
    swapForY: Boolean(swapForY),
    inAmountRaw: amountIn.toString(),
    outAmountRaw: outAmount.toString(),
    minOutAmountRaw: minOutAmount.toString(),
    feeBps: Number(poolShape.feeBps || 0),
    success: outAmount > 0n,
    error: outAmount > 0n ? null : 'Zero output',
    quoteSource: 'native-reserves',
  }, poolShape);
}

async function liveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps = 20, connection = null) {
  if (!connection) throw new Error('CPMM live quote requires connection');
  return quoteCpmmLiveExactIn({
    connection,
    poolShape,
    inAmountAtomic,
    swapForY,
    slippageBps,
  });
}


class CPMMAdapter {
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection || new Connection(
      process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.poolAddress = poolAddress || poolData?.poolAddress || poolData?.address || '';
    this.poolPublicKey = null;
    try {
      this.poolPublicKey = this.poolAddress ? new PublicKey(this.poolAddress) : null;
    } catch (_error) {
      this.poolPublicKey = null;
    }
    this.poolShape = normalizePoolRecord({ ...(poolData || {}), poolAddress: this.poolAddress });
  }

  async init() {
    return this;
  }

  loadPools(raw) {
    return normalizePools(raw).map(normalizePoolRecord);
  }

  async getQuote(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
    return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
  }

  async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
    const poolShape = normalizePoolRecord({ ...this.poolShape, ...(opts.pool || {}) });
    const wantsLive = Boolean(opts.liveRpc || opts.requireLiveRpc || opts.useLiveRpc);
    if (wantsLive) {
      try {
        const liveQuote = await liveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps, this.connection);
        return finalizeQuote({
          ...liveQuote,
          dexType: poolShape.dexType || 'RAYDIUM_CPMM',
          poolAddress: poolShape.poolAddress,
          quoteSource: 'rpc-live',
        }, poolShape);
      } catch (error) {
        if (opts.requireLiveRpc) {
          return finalizeQuote({
            success: false,
            error: `CPMM live quote failed: ${error.message}`,
            quoteSource: 'rpc-live',
            dexType: poolShape.dexType || 'RAYDIUM_CPMM',
            poolAddress: poolShape.poolAddress,
            swapForY: Boolean(swapForY),
            inAmountRaw: String(inAmountAtomic || '0'),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            feeBps: Number(poolShape.feeBps || 0),
          }, poolShape);
        }
      }
    }
    if (typeof opts?.quoteProvider === 'function') {
      const rawQuote = await opts.quoteProvider({
        pool: poolShape,
        inAmountAtomic: String(inAmountAtomic),
        swapForY,
        slippageBps,
        connection: this.connection,
      });
      return finalizeQuote({
        ...rawQuote,
        dexType: poolShape.dexType || 'RAYDIUM_CPMM',
        poolAddress: poolShape.poolAddress,
        quoteSource: 'custom-provider',
      }, poolShape);
    }

    return reserveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps);
  }

  async buildSwapTx({ user, standardQuote, opts = {} }) {
    const poolShape = normalizePoolRecord({ ...this.poolShape, ...(opts.pool || {}) });
    return buildCpmmSwapTx({ user, standardQuote, pool: poolShape });
  }
}

function parseArgs(argv) {
  const out = {
    input: 'sol_usdc.json',
    pool: null,
    amount: '1000000000',
    output: 'Qseries/_cpmm.json',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      continue;
    }
    if (!out.pool && arg.length >= 32) out.pool = arg;
    else if (out.amount === '1000000000') out.amount = arg;
  }
  return out;
}


module.exports = CPMMAdapter;
module.exports.CPMMAdapter = CPMMAdapter;
module.exports.normalizePoolRecord = normalizePoolRecord;
module.exports.reserveQuoteCpmm = reserveQuoteCpmm;
module.exports.liveQuoteCpmm = liveQuoteCpmm;
module.exports.buildCpmmSwapTx = buildCpmmSwapTx;

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    const pool = normalizePools(raw).find((entry) => String(entry?.type || '').toLowerCase().includes('cpmm'));
    if (!pool) throw new Error('No CPMM pool found in input file');
    const adapter = new CPMMAdapter(null, args.pool || pool.poolAddress || pool.address || pool.id, pool);
    const quote = await adapter.quoteExactIn(args.amount, true, 50);
    const result = { poolAddress: adapter.poolShape.poolAddress, poolShape: adapter.poolShape, quote };
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
// node math/Q_CPMM.js  --input pools/02_enriched.json
