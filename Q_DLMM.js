'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const Decimal = require('decimal.js');
Decimal.set({ precision: 80, rounding: Decimal.ROUND_FLOOR });
const DLMM = require('@meteora-ag/dlmm');
const { mergeCanonicalPool, finalizeQuote } = require('./poolContract.js');

const DEX_TYPE = 'METEORA_DLMM';
const POOL_TYPE = 'dlmm';
const BASIS_POINT_MAX = 10_000;
const DLMM_INIT_TIMEOUT_MS = Math.max(1000, Number(process.env.DLMM_INIT_TIMEOUT_MS || 5000));
const DLMM_RPC_TIMEOUT_MS = Math.max(1000, Number(process.env.DLMM_RPC_TIMEOUT_MS || 5000));
const DLMM_DEFAULT_QUOTE_MODE = String(process.env.DLMM_QUOTE_MODE || 'local-first').toLowerCase();
const DLMM_BIN_PRICE_MODE = String(process.env.DLMM_BIN_PRICE_MODE || 'ui').toLowerCase();

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    if (value.constructor?.name === 'BN' && typeof value.toString === 'function') return value.toString();
    if (typeof value.toBase58 === 'function') return value.toBase58();
  }
  return value;
}

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function toAtomicString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (BN.isBN(value)) return value.toString();
  if (value === undefined || value === null || value === '') return '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return String(Math.trunc(value));
  }
  const text = String(value).trim();
  if (!text) return '0';
  if (text.includes('.') || text.includes('e') || text.includes('E')) {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return '0';
    return String(Math.trunc(parsed));
  }
  return text;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const d = new Decimal(String(value));
    return d.isFinite() ? d : null;
  } catch (_error) {
    return null;
  }
}

function decimalMin(a, b) {
  return a.lte(b) ? a : b;
}

function decimalToAtomicString(value) {
  const d = decimalOrNull(value);
  if (!d || d.lte(0)) return '0';
  return d.floor().toFixed(0);
}

function pow10(exp) {
  return new Decimal(10).pow(Number(exp || 0));
}

function normalizeQuoteMode(value, refresh) {
  const raw = String(value || DLMM_DEFAULT_QUOTE_MODE || '').trim().toLowerCase();
  if (['local', 'local-only', 'local_only'].includes(raw)) return 'local-only';
  if (['local-first', 'local_first', 'local-preferred', 'local_preferred'].includes(raw)) return 'local-first';
  if (['sdk', 'sdk-only', 'sdk_only'].includes(raw)) return 'sdk-only';
  if (['sdk-first', 'sdk_first', 'sdk-preferred', 'sdk_preferred'].includes(raw)) return 'sdk-first';

  // Scanner calls normally pass refresh:false; prefer local hydrated bins there
  // to avoid quote-time RPC. CLI / manual calls keep SDK-first by default.
  return refresh === false ? 'local-first' : 'sdk-first';
}

function resolveAtomicPriceYPerX(bin = {}, xDecimals = 0, yDecimals = 0) {
  const explicitAtomic = decimalOrNull(
    bin.atomicPriceYPerX
    ?? bin.priceYPerXAtomic
    ?? bin.priceAtomic
    ?? bin.pricePerLamport
    ?? bin.rawPrice
  );
  if (explicitAtomic && explicitAtomic.gt(0)) return explicitAtomic;

  const price = decimalOrNull(
    bin.priceYPerX
    ?? bin.pricePerToken
    ?? bin.price
    ?? bin.uiPrice
  );
  if (!price || price.lte(0)) return null;

  const mode = String(bin.priceMode || bin.priceSource || DLMM_BIN_PRICE_MODE || 'ui').toLowerCase();
  if (mode.includes('atomic') || mode.includes('raw') || mode.includes('lamport')) {
    return price;
  }

  // Treat bin.price as UI price by default: tokenY_ui per tokenX_ui.
  // Convert to atomic tokenY per atomic tokenX.
  return price.mul(pow10(Number(yDecimals || 0) - Number(xDecimals || 0)));
}

function atomicToUiNumber(valueAtomic, decimals) {
  const raw = Number(toAtomicString(valueAtomic));
  const scale = 10 ** Number(decimals || 0);
  if (!Number.isFinite(raw) || !Number.isFinite(scale) || scale <= 0) return 0;
  return raw / scale;
}

function normalizePubkey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return String(value);
}

function makeAmount({ mint, decimals, atomic }) {
  ensure(mint, 'mint required');
  ensure(Number.isInteger(decimals) && decimals >= 0, 'decimals required');
  ensure(atomic !== undefined && atomic !== null, 'atomic required');
  return { mint: normalizePubkey(mint), decimals, atomic: toAtomicString(atomic) };
}

function addFeeToLedger(ledger, feeAmt) {
  const mint = feeAmt.mint;
  const amount = BigInt(toAtomicString(feeAmt.atomic));
  ledger[mint] = (ledger[mint] ? (BigInt(ledger[mint]) + amount) : amount).toString();
  return ledger;
}

function attachTypedToDlmmQuote(q, { inMint, outMint, inDecimals, outDecimals }) {
  q.typed = {
    in: makeAmount({ mint: inMint, decimals: inDecimals, atomic: q.inAmountRaw }),
    out: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.outAmountRaw }),
    minOut: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.minOutAmountRaw }),
    fee: null,
    feeRateBps: q.feeBps ?? null,
  };

  if (q.typed.in.atomic !== toAtomicString(q.inAmountRaw)) throw new Error('typed.in.atomic mismatch');
  if (q.typed.out.atomic !== toAtomicString(q.outAmountRaw)) throw new Error('typed.out.atomic mismatch');
  if (q.typed.minOut.atomic !== toAtomicString(q.minOutAmountRaw)) throw new Error('typed.minOut.atomic mismatch');

  return q;
}

async function loadDLMM(connection) {
  return async (addr) => {
    try {
      return await DLMM.getPool(new PublicKey(addr), connection);
    } catch (error) {
      console.error(`Failed to load DLMM pool at address ${addr}:`, error);
      throw error;
    }
  };
}

function normalizePoolRecord(pool = {}) {
  const merged = mergeCanonicalPool ? mergeCanonicalPool({ ...pool }) : { ...pool };
  const dexType = String(merged.dexType || '').toUpperCase();

  return mergeCanonicalPool ? mergeCanonicalPool({
    ...merged,
    mathType: POOL_TYPE,
    type: POOL_TYPE,
    poolType: POOL_TYPE,
    dexType: !dexType || dexType === 'UNKNOWN' ? DEX_TYPE : merged.dexType,
    protocol: merged.protocol || DEX_TYPE,
    poolAddress: merged.poolAddress || merged.address || merged.id || '',
    address: merged.address || merged.poolAddress || merged.id || '',
  }) : {
    ...merged,
    mathType: POOL_TYPE,
    type: POOL_TYPE,
    poolType: POOL_TYPE,
    dexType: !dexType || dexType === 'UNKNOWN' ? DEX_TYPE : merged.dexType,
    protocol: merged.protocol || DEX_TYPE,
    poolAddress: merged.poolAddress || merged.address || merged.id || '',
    address: merged.address || merged.poolAddress || merged.id || '',
  };
}

function getPoolMints(pool = {}) {
  return {
    tokenXMint: normalizePubkey(
      pool.tokenXMint
      || pool.baseMint
      || pool.mintA
      || pool.tokenMintA
      || pool.tokenA?.mint
      || pool.tokenA
      || pool.lbPair?.tokenXMint
      || pool._raw?.tokenXMint
      || pool._raw?.baseMint
      || null
    ),
    tokenYMint: normalizePubkey(
      pool.tokenYMint
      || pool.quoteMint
      || pool.mintB
      || pool.tokenMintB
      || pool.tokenB?.mint
      || pool.tokenB
      || pool.lbPair?.tokenYMint
      || pool._raw?.tokenYMint
      || pool._raw?.quoteMint
      || null
    ),
  };
}

function getPoolDecimals(pool = {}) {
  return {
    tokenXDecimals: toFiniteNumber(
      pool.tokenXDecimals
      ?? pool.baseDecimals
      ?? pool.decimalsA
      ?? pool.tokenA?.decimals
      ?? pool._raw?.tokenXDecimals
      ?? pool._raw?.baseDecimals,
      null,
    ),
    tokenYDecimals: toFiniteNumber(
      pool.tokenYDecimals
      ?? pool.quoteDecimals
      ?? pool.decimalsB
      ?? pool.tokenB?.decimals
      ?? pool._raw?.tokenYDecimals
      ?? pool._raw?.quoteDecimals,
      null,
    ),
  };
}

function getPoolSymbols(pool = {}) {
  return {
    tokenXSymbol: pool.tokenXSymbol || pool.baseSymbol || pool.tokenA?.symbol || pool._raw?.baseSymbol || null,
    tokenYSymbol: pool.tokenYSymbol || pool.quoteSymbol || pool.tokenB?.symbol || pool._raw?.quoteSymbol || null,
  };
}

function resolveFeeBps(pool = {}, dlmmInstance = null) {
  const candidates = [
    pool.feeBps,
    pool.feeBpsCanonical,
    pool.tradeFeeBps,
    pool.feeRateBps,
    pool.baseFeeBps,
    pool.lbPair?.parameters?.baseFactor,
    pool._raw?.feeBps,
    pool._raw?.feeBpsCanonical,
    pool.normalized?.feeBps,
  ];

  for (const value of candidates) {
    const fee = Number(value);
    if (Number.isFinite(fee) && fee >= 0) return fee;
  }

  const feeRate = Number(pool.feeRate ?? pool._raw?.feeRate ?? pool.normalized?.feeRate);
  if (Number.isFinite(feeRate) && feeRate >= 0) {
    return feeRate > 0 && feeRate < 1 ? feeRate * BASIS_POINT_MAX : feeRate;
  }

  try {
    const feeInfo = dlmmInstance?.getFeeInfo?.();
    const fee = Number(feeInfo?.baseFeeBps ?? feeInfo?.feeBps ?? feeInfo?.feeRateBps);
    if (Number.isFinite(fee) && fee >= 0) return fee;
  } catch (_error) {
    // SDK fee helpers vary by version. Keep fallback deterministic.
  }

  return 25;
}

function hasLocalDlmmState(pool = {}) {
  return Boolean(
    pool
    && Array.isArray(pool.bins)
    && pool.bins.length > 0
    && pool.activeBinId !== undefined
    && pool.binStep !== undefined
  );
}

function binReserveX(bin = {}) {
  return toAtomicString(bin.xAmount ?? bin.reserveX ?? bin.reserveA ?? 0);
}

function binReserveY(bin = {}) {
  return toAtomicString(bin.yAmount ?? bin.reserveY ?? bin.reserveB ?? 0);
}

function applySlippage(outAmountRaw, slippageBps) {
  const out = BigInt(toAtomicString(outAmountRaw));
  const bps = BigInt(Math.max(0, Math.trunc(Number(slippageBps) || 0)));
  return ((out * (BigInt(BASIS_POINT_MAX) - bps)) / BigInt(BASIS_POINT_MAX)).toString();
}

function numberToAtomicString(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return String(Math.floor(value));
}

function binArrayAddress(binArray) {
  return normalizePubkey(binArray?.publicKey || binArray?.pubkey || binArray?.address || binArray);
}

function normalizeQuoteArgs(args, legacySwapForY = true, legacySlippageBps = 20, legacyOpts = {}) {
  if (args && typeof args === 'object' && !BN.isBN(args)) {
    return {
      pool: args.pool || legacyOpts.pool || null,
      inputMint: args.inputMint || args.tokenInMint || args.tokenMint || null,
      outputMint: args.outputMint || args.tokenOutMint || null,
      amountInAtomic: toAtomicString(args.amountInAtomic ?? args.inAmountLamports ?? args.inputAmount ?? args.inAmountRaw),
      swapForY: args.swapForY,
      slippageBps: args.slippageBps ?? legacySlippageBps,
      connection: args.connection || legacyOpts.connection || null,
      refresh: args.refresh,
      binArrayCount: args.binArrayCount,
      extraBinArrays: args.extraBinArrays,
      quoteMode: args.quoteMode || args.mode || legacyOpts.quoteMode,
    };
  }

  return {
    pool: legacyOpts.pool || null,
    inputMint: legacyOpts.inputMint || legacyOpts.tokenInMint || legacyOpts.tokenMint || null,
    outputMint: legacyOpts.outputMint || legacyOpts.tokenOutMint || null,
    amountInAtomic: toAtomicString(args),
    swapForY: legacySwapForY,
    slippageBps: legacySlippageBps,
    connection: legacyOpts.connection || null,
    refresh: legacyOpts.refresh,
    binArrayCount: legacyOpts.binArrayCount,
    extraBinArrays: legacyOpts.extraBinArrays,
    quoteMode: legacyOpts.quoteMode,
  };
}

class DLMMAdapter {
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection || new Connection(
      process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );

    this.poolAddressString = normalizePubkey(poolAddress || poolData?.poolAddress || poolData?.address || poolData?.id);
    if (!this.poolAddressString) throw new Error('DLMMAdapter requires poolAddress');

    this.poolAddress = new PublicKey(this.poolAddressString);
    this.poolData = poolData ? normalizePoolRecord(poolData) : null;
    this.pool = null;

    this.tokenXMint = null;
    this.tokenYMint = null;
    this.tokenXDecimals = null;
    this.tokenYDecimals = null;
    this.tokenXSymbol = null;
    this.tokenYSymbol = null;
    this.feeBps = null;
  }

  async init() {
    try {
      this.pool = await withTimeout(
        DLMM.create(this.connection, this.poolAddress),
        DLMM_INIT_TIMEOUT_MS,
        `DLMM.create ${this.poolAddressString}`,
      );

      const poolData = this.poolData || {};
      const dataMints = getPoolMints(poolData);
      const sdkMints = {
        tokenXMint: normalizePubkey(this.pool?.lbPair?.tokenXMint),
        tokenYMint: normalizePubkey(this.pool?.lbPair?.tokenYMint),
      };
      const dataDecimals = getPoolDecimals(poolData);
      const symbols = getPoolSymbols(poolData);

      this.tokenXMint = new PublicKey(dataMints.tokenXMint || sdkMints.tokenXMint);
      this.tokenYMint = new PublicKey(dataMints.tokenYMint || sdkMints.tokenYMint);
      this.tokenXDecimals = Number.isInteger(dataDecimals.tokenXDecimals) ? dataDecimals.tokenXDecimals : null;
      this.tokenYDecimals = Number.isInteger(dataDecimals.tokenYDecimals) ? dataDecimals.tokenYDecimals : null;
      this.tokenXSymbol = symbols.tokenXSymbol;
      this.tokenYSymbol = symbols.tokenYSymbol;

      if (this.tokenXDecimals === null || this.tokenYDecimals === null) {
        const [tokenXInfo, tokenYInfo] = await withTimeout(
          Promise.all([
            this.connection.getParsedAccountInfo(this.tokenXMint),
            this.connection.getParsedAccountInfo(this.tokenYMint),
          ]),
          DLMM_RPC_TIMEOUT_MS,
          `DLMM token decimals ${this.poolAddressString}`,
        );

        if (this.tokenXDecimals === null) {
          this.tokenXDecimals = Number(tokenXInfo?.value?.data?.parsed?.info?.decimals);
        }
        if (this.tokenYDecimals === null) {
          this.tokenYDecimals = Number(tokenYInfo?.value?.data?.parsed?.info?.decimals);
        }
      }

      if (!Number.isInteger(this.tokenXDecimals) || !Number.isInteger(this.tokenYDecimals)) {
        throw new Error('Unable to resolve DLMM token decimals');
      }

      this.feeBps = resolveFeeBps(poolData, this.pool);

      this.poolData = normalizePoolRecord({
        ...poolData,
        poolAddress: this.poolAddressString,
        tokenXMint: this.tokenXMint.toBase58(),
        tokenYMint: this.tokenYMint.toBase58(),
        tokenXDecimals: this.tokenXDecimals,
        tokenYDecimals: this.tokenYDecimals,
        baseMint: this.tokenXMint.toBase58(),
        quoteMint: this.tokenYMint.toBase58(),
        baseDecimals: this.tokenXDecimals,
        quoteDecimals: this.tokenYDecimals,
        tokenXSymbol: this.tokenXSymbol,
        tokenYSymbol: this.tokenYSymbol,
        feeBps: this.feeBps,
      });

      return this;
    } catch (error) {
      if (hasLocalDlmmState(this.poolData)) {
        this.initFromLocalPoolData();
        this.pool = null;
        this.initWarning = `sdk-init-failed-local-bin-fallback:${error.message}`;
        return this;
      }
      throw new Error(`DLMM init failed for ${this.poolAddressString}: ${error.message}`);
    }
  }

  initFromLocalPoolData() {
    const poolData = this.poolData || {};
    const dataMints = getPoolMints(poolData);
    const dataDecimals = getPoolDecimals(poolData);
    const symbols = getPoolSymbols(poolData);

    if (!dataMints.tokenXMint || !dataMints.tokenYMint) {
      throw new Error('Local DLMM fallback missing token mints');
    }
    if (!Number.isInteger(dataDecimals.tokenXDecimals) || !Number.isInteger(dataDecimals.tokenYDecimals)) {
      throw new Error('Local DLMM fallback missing token decimals');
    }

    this.tokenXMint = new PublicKey(dataMints.tokenXMint);
    this.tokenYMint = new PublicKey(dataMints.tokenYMint);
    this.tokenXDecimals = dataDecimals.tokenXDecimals;
    this.tokenYDecimals = dataDecimals.tokenYDecimals;
    this.tokenXSymbol = symbols.tokenXSymbol;
    this.tokenYSymbol = symbols.tokenYSymbol;
    this.feeBps = resolveFeeBps(poolData, null);
    this.poolData = normalizePoolRecord({
      ...poolData,
      poolAddress: this.poolAddressString,
      tokenXMint: this.tokenXMint.toBase58(),
      tokenYMint: this.tokenYMint.toBase58(),
      tokenXDecimals: this.tokenXDecimals,
      tokenYDecimals: this.tokenYDecimals,
      baseMint: this.tokenXMint.toBase58(),
      quoteMint: this.tokenYMint.toBase58(),
      baseDecimals: this.tokenXDecimals,
      quoteDecimals: this.tokenYDecimals,
      tokenXSymbol: this.tokenXSymbol,
      tokenYSymbol: this.tokenYSymbol,
      feeBps: this.feeBps,
    });
  }

  async refresh() {
    if (this.pool && typeof this.pool.refetchStates === 'function') {
      await withTimeout(
        this.pool.refetchStates(),
        DLMM_RPC_TIMEOUT_MS,
        `DLMM refetchStates ${this.poolAddressString}`,
      );
    }
  }

  resolveOrientation({ inputMint = null, outputMint = null, swapForY = undefined } = {}) {
    const tokenXMint = this.tokenXMint?.toBase58();
    const tokenYMint = this.tokenYMint?.toBase58();
    const inMintText = normalizePubkey(inputMint);
    const outMintText = normalizePubkey(outputMint);

    let direction;
    if (inMintText) {
      if (inMintText === tokenXMint) direction = true;
      else if (inMintText === tokenYMint) direction = false;
      else throw new Error(`Input mint ${inMintText} is not in DLMM pool ${this.poolAddressString}`);
    } else {
      direction = Boolean(swapForY);
    }

    const resolvedInputMint = direction ? tokenXMint : tokenYMint;
    const resolvedOutputMint = direction ? tokenYMint : tokenXMint;

    if (outMintText && outMintText !== resolvedOutputMint) {
      throw new Error(`DLMM pool ${this.poolAddressString} does not support ${resolvedInputMint} -> ${outMintText}`);
    }

    return {
      swapForY: direction,
      aToB: direction,
      swapDirection: direction ? 'A_TO_B' : 'B_TO_A',
      direction: direction ? 'A_TO_B' : 'B_TO_A',
      inputMint: resolvedInputMint,
      outputMint: resolvedOutputMint,
      tokenInMint: resolvedInputMint,
      tokenOutMint: resolvedOutputMint,
      inputDecimals: direction ? this.tokenXDecimals : this.tokenYDecimals,
      outputDecimals: direction ? this.tokenYDecimals : this.tokenXDecimals,
      inDecimals: direction ? this.tokenXDecimals : this.tokenYDecimals,
      outDecimals: direction ? this.tokenYDecimals : this.tokenXDecimals,
    };
  }

  async quoteFastExactIn(args = {}) {
    const params = normalizeQuoteArgs({
      ...args,
      amountInAtomic: args.amountInAtomic ?? args.inAmountLamports,
      binArrayCount: args.binArrayCount ?? 2,
      extraBinArrays: args.extraBinArrays ?? 0,
      refresh: false,
    });

    return this._quoteSdk(params, 'sdk-fast');
  }

  async getQuote(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
    return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
  }

  async quoteExactIn(args, legacySwapForY = true, legacySlippageBps = 20, legacyOpts = {}) {
    const params = normalizeQuoteArgs(args, legacySwapForY, legacySlippageBps, {
      ...legacyOpts,
      binArrayCount: legacyOpts.binArrayCount ?? 6,
      extraBinArrays: legacyOpts.extraBinArrays ?? 3,
      refresh: legacyOpts.refresh ?? true,
    });

    return this._quoteSdk(params, 'sdk');
  }

  async _quoteSdk(params, quoteSource) {
    // Apply the latest pool state before deciding between local and SDK paths.
    // MathAdapter caches this adapter by pool address, so each quote can carry
    // fresher bins/fees/decimals than the constructor saw at warmup time.
    if (params.pool) {
      this.poolData = normalizePoolRecord({
        ...(this.poolData || {}),
        ...params.pool,
        poolAddress: this.poolAddressString,
      });
    }

    const quoteMode = normalizeQuoteMode(params.quoteMode, params.refresh);
    const hasLocal = hasLocalDlmmState(this.poolData);

    if ((quoteMode === 'local-only' || quoteMode === 'local-first') && hasLocal) {
      try {
        return this._quoteLocalBins(params, `${quoteSource}-local-bins`);
      } catch (localError) {
        if (quoteMode === 'local-only') {
          return {
            success: false,
            error: `local DLMM quote failed: ${localError.message}`,
            dexType: DEX_TYPE,
            mathType: POOL_TYPE,
            type: POOL_TYPE,
            poolAddress: this.poolAddressString,
            quoteSource: `${quoteSource}-local-bins`,
          };
        }
        this.localQuoteWarning = localError.message;
      }
    }

    if (quoteMode === 'local-only' && !hasLocal) {
      return {
        success: false,
        error: 'local DLMM quote requested but hydrated bins are missing',
        dexType: DEX_TYPE,
        mathType: POOL_TYPE,
        type: POOL_TYPE,
        poolAddress: this.poolAddressString,
        quoteSource: `${quoteSource}-local-bins`,
      };
    }

    try {
      if (!this.pool) await this.init();

      // If SDK init failed but local bins are available, init() sets pool=null.
      if (!this.pool && hasLocalDlmmState(this.poolData)) {
        return this._quoteLocalBins(params, `${quoteSource}-local-bins`);
      }

      if (params.connection && params.connection !== this.connection) this.connection = params.connection;
      if (params.refresh !== false) await this.refresh();

      const orientation = this.resolveOrientation(params);
      const amountInAtomic = toAtomicString(params.amountInAtomic);
      const binArrayCount = Number(params.binArrayCount || 6);
      const extraBinArrays = Number(params.extraBinArrays || 0);
      const slippageBps = Math.max(0, Math.trunc(Number(params.slippageBps ?? 20) || 0));

      const binArrays = await withTimeout(
        this.pool.getBinArrayForSwap(orientation.swapForY, binArrayCount),
        DLMM_RPC_TIMEOUT_MS,
        `DLMM getBinArrayForSwap ${this.poolAddressString}`,
      );
      const quote = this.pool.swapQuote(
        new BN(amountInAtomic),
        orientation.swapForY,
        new BN(slippageBps),
        binArrays,
        false,
        extraBinArrays,
      );

      return this._normalizeQuote({
        quote,
        amountInAtomic,
        orientation,
        slippageBps,
        binArrays,
        quoteSource,
      });
    } catch (error) {
      // Last chance: if SDK path failed and hydrated bins exist, return a local
      // quote instead of dropping the whole edge.
      if (quoteMode === 'sdk-first' && hasLocalDlmmState(this.poolData)) {
        try {
          return this._quoteLocalBins(params, `${quoteSource}-local-bins-after-sdk-error`);
        } catch (_localError) {
          // Fall through to the SDK error below.
        }
      }

      return {
        success: false,
        error: error.message,
        dexType: DEX_TYPE,
        mathType: POOL_TYPE,
        type: POOL_TYPE,
        poolAddress: this.poolAddressString,
        quoteSource,
      };
    }
  }

  _quoteLocalBins(params, quoteSource) {
    if (params.pool) {
      this.poolData = normalizePoolRecord({
        ...(this.poolData || {}),
        ...params.pool,
        poolAddress: this.poolAddressString,
      });
    }
    if (!this.tokenXMint || !this.tokenYMint) this.initFromLocalPoolData();

    const orientation = this.resolveOrientation(params);
    const amountInRaw = toAtomicString(params.amountInAtomic);
    const amountIn = decimalOrNull(amountInRaw);
    if (!amountIn || amountIn.lte(0)) {
      throw new Error('DLMM local quote requires positive amountInAtomic');
    }

    const feeBps = Math.max(0, Number(resolveFeeBps(this.poolData, null)) || 0);
    const effectiveIn = amountIn
      .mul(new Decimal(Math.max(0, BASIS_POINT_MAX - Math.trunc(feeBps))))
      .div(BASIS_POINT_MAX);

    const bins = [...(this.poolData?.bins || [])]
      .filter((bin) => {
        const idOk = Number.isFinite(Number(bin.binId));
        const px = resolveAtomicPriceYPerX(bin, this.tokenXDecimals, this.tokenYDecimals);
        return idOk && px && px.gt(0);
      })
      .sort((a, b) => Number(a.binId) - Number(b.binId));

    if (bins.length === 0) {
      throw new Error('DLMM local quote has no usable bins with price/reserves');
    }

    let remainingIn = effectiveIn;
    let out = new Decimal(0);
    const usedBins = [];
    const ordered = orientation.swapForY ? bins : [...bins].reverse();

    for (const bin of ordered) {
      if (remainingIn.lte(0)) break;

      const priceAtomicYPerX = resolveAtomicPriceYPerX(bin, this.tokenXDecimals, this.tokenYDecimals);
      if (!priceAtomicYPerX || priceAtomicYPerX.lte(0)) continue;

      if (orientation.swapForY) {
        const yAvailable = decimalOrNull(binReserveY(bin));
        if (!yAvailable || yAvailable.lte(0)) continue;

        const inputCapacity = yAvailable.div(priceAtomicYPerX);
        const inputUsed = decimalMin(remainingIn, inputCapacity);
        if (inputUsed.lte(0)) continue;

        out = out.plus(inputUsed.mul(priceAtomicYPerX));
        remainingIn = remainingIn.minus(inputUsed);
      } else {
        const xAvailable = decimalOrNull(binReserveX(bin));
        if (!xAvailable || xAvailable.lte(0)) continue;

        const inputCapacity = xAvailable.mul(priceAtomicYPerX);
        const inputUsed = decimalMin(remainingIn, inputCapacity);
        if (inputUsed.lte(0)) continue;

        out = out.plus(inputUsed.div(priceAtomicYPerX));
        remainingIn = remainingIn.minus(inputUsed);
      }

      usedBins.push(bin);
    }

    const outAmountRaw = decimalToAtomicString(out);
    if (BigInt(outAmountRaw || '0') <= 0n) {
      throw new Error('DLMM local quote produced zero output');
    }

    const minOutAmountRaw = applySlippage(outAmountRaw, params.slippageBps);
    return this._normalizeQuote({
      quote: {
        outAmount: outAmountRaw,
        minOutAmount: minOutAmountRaw,
        priceImpact: 0,
      },
      amountInAtomic: amountInRaw,
      orientation,
      slippageBps: params.slippageBps,
      binArrays: usedBins,
      quoteSource,
    });
  }

  _normalizeQuote({ quote, amountInAtomic, orientation, slippageBps, binArrays, quoteSource }) {
    const outAmountRaw = toAtomicString(quote.outAmount);
    const minOutAmountRaw = toAtomicString(quote.minOutAmount);
    const inAmountRaw = toAtomicString(amountInAtomic);

    const inAmountDecimal = atomicToUiNumber(inAmountRaw, orientation.inputDecimals);
    const outAmountDecimal = atomicToUiNumber(outAmountRaw, orientation.outputDecimals);
    const minOutAmountDecimal = atomicToUiNumber(minOutAmountRaw, orientation.outputDecimals);
    const executionPrice = inAmountDecimal > 0 ? outAmountDecimal / inAmountDecimal : 0;

    const rawImpact = quote.priceImpact;
    const priceImpact = rawImpact != null ? Number(rawImpact.toString()) : 0;
    const feeBps = Number.isFinite(Number(this.feeBps)) ? Number(this.feeBps) : 25;

    const rawQuote = attachTypedToDlmmQuote({
      dexType: DEX_TYPE,
      mathType: POOL_TYPE,
      type: POOL_TYPE,
      poolAddress: this.poolAddressString,
      swapForY: orientation.swapForY,
      aToB: orientation.aToB,
      swapDirection: orientation.swapDirection,
      direction: orientation.direction,
      inputMint: orientation.inputMint,
      outputMint: orientation.outputMint,
      tokenInMint: orientation.tokenInMint,
      tokenOutMint: orientation.tokenOutMint,
      inputDecimals: orientation.inputDecimals,
      outputDecimals: orientation.outputDecimals,
      inDecimals: orientation.inDecimals,
      outDecimals: orientation.outDecimals,

      inAmountRaw,
      outAmountRaw,
      minOutAmountRaw,
      inAmountDecimal,
      outAmountDecimal,
      minOutAmountDecimal,

      executionPrice,
      priceImpact,
      impactPct: priceImpact * 100,
      impactBps: priceImpact * BASIS_POINT_MAX,
      feeBps,
      fee: feeBps / BASIS_POINT_MAX,

      quoteSource,
      slippageBps,
      quoteMode: quoteSource.includes('local-bins') ? 'local-bins' : 'sdk',
      localQuoteWarning: this.localQuoteWarning || null,
      binPriceMode: DLMM_BIN_PRICE_MODE,
      binArrays: (binArrays || []).map(binArrayAddress).filter(Boolean),

      success: true,
      error: null,
    }, {
      inMint: orientation.inputMint,
      outMint: orientation.outputMint,
      inDecimals: orientation.inputDecimals,
      outDecimals: orientation.outputDecimals,
    });

    const poolShape = normalizePoolRecord({
      ...(this.poolData || {}),
      poolAddress: this.poolAddressString,
      tokenXMint: this.tokenXMint?.toBase58(),
      tokenYMint: this.tokenYMint?.toBase58(),
      tokenXDecimals: this.tokenXDecimals,
      tokenYDecimals: this.tokenYDecimals,
      feeBps,
    });

    return finalizeQuote(rawQuote, poolShape);
  }

  async buildSwapTx({ user, standardQuote }) {
    if (!this.pool) await this.init();

    const inTokenMint = new PublicKey(standardQuote.tokenInMint || standardQuote.inputMint || (
      standardQuote.swapForY ? this.tokenXMint : this.tokenYMint
    ));
    const outTokenMint = new PublicKey(standardQuote.tokenOutMint || standardQuote.outputMint || (
      standardQuote.swapForY ? this.tokenYMint : this.tokenXMint
    ));
    const binArraysPubkey = (standardQuote.binArrays || []).map((addr) => new PublicKey(addr));

    return this.pool.swap({
      inToken: inTokenMint,
      outToken: outTokenMint,
      inAmount: new BN(standardQuote.inAmountRaw),
      minOutAmount: new BN(standardQuote.minOutAmountRaw),
      lbPair: this.pool.pubkey,
      user: new PublicKey(user),
      binArraysPubkey,
    });
  }
}

function parseArgs(argv) {
  const out = {
    input: 'sol_usdc.json',
    output: 'Qseries/_DLMM.json',
    amount: '1000000000',
    pool: null,
    rpc: null,
    swapForY: true,
    slippageBps: 20,
    help: false,
    quoteMode: null,
    pos: [],
  };

  const setKey = (keyRaw, valueRaw) => {
    const key = String(keyRaw || '').replace(/^--?/, '').toLowerCase();
    const value = valueRaw == null ? '' : String(valueRaw);
    if (['input', 'in'].includes(key)) out.input = value;
    else if (['output', 'out'].includes(key)) out.output = value;
    else if (['amount', 'amt'].includes(key)) out.amount = value;
    else if (['pool', 'pooladdress', 'address'].includes(key)) out.pool = value;
    else if (['rpc', 'rpcurl'].includes(key)) out.rpc = value;
    else if (['swapfory', 'direction'].includes(key)) out.swapForY = value;
    else if (['slippagebps', 'slippage'].includes(key)) out.slippageBps = value;
    else if (['quotemode', 'mode'].includes(key)) out.quoteMode = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }

    const kv = arg.match(/^([a-zA-Z][\w-]*)=(.*)$/);
    if (kv) {
      let value = kv[2];
      if (value === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) value = argv[++i];
      setKey(kv[1], value);
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.replace(/^--?/, '');
      let value = argv[i + 1];
      if (value && value.startsWith('--')) value = '';
      if (value !== '' && value != null && !value.startsWith('--')) i += 1;
      setKey(key, value);
      continue;
    }

    out.pos.push(arg);
  }

  if (!out.input && out.pos[0] && fs.existsSync(out.pos[0])) out.input = out.pos[0];
  else if (!out.pool && out.pos[0] && out.pos[0].length >= 32) out.pool = out.pos[0];
  else if (!out.input && out.pos[0]) out.output = out.pos[0];

  if (out.pos[1]) out.amount = out.pos[1];
  if (out.pos[2]) out.output = out.pos[2];

  out.swapForY = !['0', 'false', 'no', 'b_to_a', 'y_to_x'].includes(String(out.swapForY).toLowerCase());
  out.slippageBps = Number(out.slippageBps);
  return out;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    let poolAddress = args.pool || '9DiruRpjnAnzhn6ts5HGLouHtJrT1JGsPbXNYCrFz2ad';
    let poolData = null;

    if (args.input) {
      console.log(`Loading pools from ${args.input}...`);
      const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
      const { loadPoolsFromAny } = require('../utilities/poolLoader.js');
      const pools = await loadPoolsFromAny(raw);
      const dlmmPool = pools.find((pool) => String(pool.type || pool.mathType || pool.dexType || '').toLowerCase().includes('dlmm'));
      if (!dlmmPool) throw new Error('No DLMM pool found in input file');
      poolAddress = args.pool || dlmmPool.poolAddress || dlmmPool.address || dlmmPool.id;
      poolData = dlmmPool;
      console.log(`Found DLMM pool in file: ${poolAddress}`);
    }

    console.log('Running DLMM quoter...');
    console.log(`Pool: ${poolAddress}`);
    console.log(`Amount: ${args.amount}`);
    console.log(`Output: ${args.output}`);
    console.log(`swapForY: ${args.swapForY}`);

    const rpcUrl = args.rpc || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const adapter = new DLMMAdapter(new Connection(rpcUrl, 'confirmed'), poolAddress, poolData);
    await adapter.init();

    const fastQuote = await adapter.quoteFastExactIn({
      inAmountLamports: args.amount,
      swapForY: args.swapForY,
      slippageBps: args.slippageBps,
      quoteMode: args.quoteMode,
    });
    console.log('Fast Quote Result:', JSON.stringify(fastQuote, jsonReplacer, 2));

    const exactQuote = await adapter.quoteExactIn({
      inAmountLamports: args.amount,
      swapForY: args.swapForY,
      slippageBps: args.slippageBps,
      quoteMode: args.quoteMode,
    });
    console.log('Exact Quote Result:', JSON.stringify(exactQuote, jsonReplacer, 2));

    const output = {
      timestamp: new Date().toISOString(),
      poolAddress,
      poolShape: poolData ? normalizePoolRecord(poolData) : adapter.poolData,
      amount: args.amount,
      swapForY: args.swapForY,
      fastQuote,
      exactQuote,
    };

    const dir = path.dirname(args.output);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(output, jsonReplacer, 2));
    console.log(`Quotes written to ${args.output}`);
  })().catch((error) => {
    console.error('Error:', error.stack || error.message);
    process.exit(1);
  });
}

// Preserve both old default-import style and newer named destructuring style.
module.exports = DLMMAdapter;
module.exports.DLMMAdapter = DLMMAdapter;
module.exports.loadDLMM = loadDLMM;
module.exports.normalizePoolRecord = normalizePoolRecord;
module.exports.makeAmount = makeAmount;
module.exports.addFeeToLedger = addFeeToLedger;
module.exports.attachTypedToDlmmQuote = attachTypedToDlmmQuote;

/*

 node math/Q_DLMM.js pools/_pool_SET_1.json

*/
