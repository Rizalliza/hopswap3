#!/usr/bin/env node
'use strict';
/**
 * UNIFIED POOL ENRICHMENT  (refactored)
 *
 * What changed vs the previous version:
 *  1. Whirlpool tick-array fetch is now ONE batched getMultipleAccountsInfo call
 *     (was 7 sequential getAccountInfo calls). Same pattern CLMM already used.
 *  2. enrichAllPools uses processInBatches — concurrency across pools instead of
 *     a strictly serial for-loop. Tick batching alone only fixes one pool at a
 *     time; this fixes the wall.
 *  3. The dead RPCManager shadow class was removed. The imported
 *     createRpcConnection proxy already provides rotation + failover, so we
 *     just trust it.
 *  4. binArray_util.js is now actually imported. The duplicate copies of
 *     binIdToBinArrayIndex / getBinArrayLowerUpperBinId / normalizeBinArrays /
 *     normalizeBins / deriveBinArray / etc. that were inlined are gone.
 *  5. The toPublicKey ReferenceError in normalizeBinArrays is fixed because we
 *     now call into binArray_util's version (which has toPublicKey).
 *  6. The CLMM RPC_DELAY_MS sleep was removed — concurrency is governed by
 *     the batch size and the RPC manager's failure cooldown, not a fixed
 *     sleep that throttled single-threaded throughput.
 *  7. Whirlpool pool + vaults + tick arrays now resolve in 2 round trips total
 *     (was up to 10).
 *  8. enrichAllPools now de-duplicates repeated pool addresses before RPC work,
 *     then copies the enriched state back to aliases. This avoids repeated
 *     enrichment when the same pool appears in multiple circuits/routes.
 *
 * Public API unchanged:
 *   enrichAllPools(pools, connection)
 *   buildEnrichmentDebugReport / buildEnrichmentDiagnosticsEntry
 *   printEnrichmentDebugSummary
 *   parseCliArgs / extractPoolsFromInput / mergeOutputPayload
 *   plus re-exports from binArray_util that older callers depend on.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const {
    ParsableWhirlpool,
    ParsableTickArray,
    TickUtil,
    PDAUtil,
    ORCA_WHIRLPOOL_PROGRAM_ID,
} = require('@orca-so/whirlpools-sdk');
const {
    PoolInfoLayout: RaydiumClmmPoolInfoLayout,
    CpmmPoolInfoLayout,
    liquidityStateV4Layout,
    liquidityStateV5Layout,
    TickArrayLayout: RaydiumClmmTickArrayLayout,
    getPdaTickArrayAddress: getRaydiumClmmTickArrayAddress,
} = require('@raydium-io/raydium-sdk-v2');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const BN = require('bn.js');

// Project utilities — actually used now
const { buildNormalizedAux } = require('./utilities/aux-builders.js');
const { TickArrayUtil: RaydiumTickArrayUtil } = require('./utilities/tickArrayUtil.js');
const { normalizePoolRecord, validateCanonicalPool } = require('./utilities/normalizer.js');
const { normalizeStructuredTickArray } = require('./utilities/whirlpool_tick_utils.js');
const { decodeEntry: decodeWhirlpoolTickEntry, decodePoolTickArrays } = require('./utilities/whirlpoolTickDecoder.js');
const { createRpcConnection, getConfiguredRpcUrls } = require('./utilities/rpcConnectionManager.js');
const { wrapConnection } = require('./utilities/rpcRateLimiter.js');
const { processInBatches } = require('./utilities/batchProcess.js');
const { stampFreshness } = require('./utilities/freshnessStamp.js');
const { hydrateDlmmLiveFees } = require('./utilities/dlmmLiveFeeHydration.js');
const {
    MAX_BIN_ARRAY_SIZE,
    DEFAULT_BIN_PER_POSITION,
    binIdToBinArrayIndex,
    getBinArrayLowerUpperBinId,
    getBinIdIndexInBinArray,
    getBinArraysRequiredByPositionRange,
    getBinRangeFromActiveId,
    getBinRangeFromIds,
    normalizeBinRange,
    normalizeBinArrays,
    normalizeBins,
    normalizeBinId,
    deriveBinArray,
} = require('./utilities/binArray_util.js');

// DLMM constants
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
function loadDlmmIdl() {
    const candidates = [
        () => require('@meteora-ag/dlmm').IDL,
        () => require('./SDK/meteora-dlmm-sdk-main/ts-client/src/dlmm/dlmm.json'),
        () => require('./SDK/meteora-dlmm-sdk-main/idls/dlmm.json'),
    ];
    for (const load of candidates) {
        try {
            const idl = load();
            if (idl && Array.isArray(idl.accounts)) return idl;
        } catch (_error) {
            // Try the next IDL source.
        }
    }
    throw new Error('DLMM IDL not found');
}
const DLMM_IDL = loadDlmmIdl();
const dlmmCoder = new BorshAccountsCoder(DLMM_IDL);

// Tunables. CONCURRENCY is the number of pools to enrich in parallel.
// Batch at 80 by default. Keep this below the common Solana getMultipleAccounts
// ceiling of 100 so CLMM/Whirlpool RPC work still has headroom.
const CONFIG = {
    CONCURRENCY: Math.min(100, Math.max(1, Number(process.env.ENRICHMENT_CONCURRENCY || 80))),
    WHIRLPOOL_TICK_ARRAY_OFFSETS: [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    CLMM_TICK_ARRAY_OFFSETS: [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    DLMM_BIN_ARRAY_OFFSETS: [-4, -3, -2, -1, 0, 1, 2, 3, 4],
    DLMM_LIVE_WALK_ARRAYS: Math.max(1, Number(process.env.DLMM_LIVE_WALK_ARRAYS || 24)),
    DLMM_LIVE_WALK_BATCH_SIZE: Math.max(1, Number(process.env.DLMM_LIVE_WALK_BATCH_SIZE || 6)),
    RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_AMM_STABLE: '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
    RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
};

/* -------------------------------------------------------------------------- */
/*                              Pure helpers                                  */
/* -------------------------------------------------------------------------- */

function resolvePoolType(pool = {}) {
    // Combine ALL identity fields so the most specific token wins.
    // pool.type can be broad, so combine identity fields before routing.
    const rawType = (
        String(pool.dexType || '') + '|' +
        String(pool.type || '') + '|' +
        String(pool.poolType || '') + '|' +
        String(pool.mathType || '') + '|' +
        String(pool.dex || '') + '|' +
        String(pool.protocol || '') + '|' +
        String(pool.source || '')
    ).toLowerCase();
    if (rawType.includes('whirlpool') || rawType.includes('orca')) return 'whirlpool';
    if (rawType.includes('goosefx')) return 'goosefx';
    if (rawType.includes('damm_v2') || rawType.includes('damm-v2') || rawType.includes('dammv2') || rawType.includes('meteora_damm') || rawType.includes('dynamic_amm_v2')) return 'damm_v2';
    if (rawType.includes('pumpswap') || rawType.includes('pump_swap') || rawType.includes('pump-swap')) return 'pumpswap';
    if (rawType.includes('pancakeswap') || rawType.includes('pancake')) {
        if (rawType.includes('clmm') || rawType.includes('amm_v3')) return 'amm';
        return 'amm';
    }
    if (rawType.includes('raydium_cpmm') || rawType.includes('cpmm')) return 'cpmm';
    if (rawType.includes('raydium_clmm') || rawType.includes('clmm') || rawType.includes('concentrated')) return 'clmm';
    if (rawType.includes('dlmm') || rawType.includes('meteora')) return 'dlmm';
    return 'unknown';
}

const DEFAULTS = {
    chunkSize: 100,     // getMultipleAccountsInfo hard limit
    maxRetries: 4,
    baseDelayMs: 250,
    maxDelayMs: 4000,
};

function isTransient(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    const code = err.code || err.statusCode || err.status;
    if (code === 429 || code === 502 || code === 503 || code === 504) return true;
    return (
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('rate limit') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('socket') ||
        msg.includes('econnreset') ||
        msg.includes('fetch failed') ||
        msg.includes('502') || msg.includes('503') || msg.includes('504') ||
        msg.includes('gateway')
    );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyOf(k) {
    return typeof k === 'string' ? k : k.toBase58();
}

function dedupeKeys(pubkeys) {
    const map = new Map(); // b58 -> original key object
    for (const k of pubkeys) {
        if (!k) continue;
        const b58 = keyOf(k);
        if (!map.has(b58)) map.set(b58, k);
    }
    return map;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function isPancakeSwapPool(pool = {}) {
    const rawType = (
        String(pool.dexType || '') + '|' +
        String(pool.type || '') + '|' +
        String(pool.poolType || '') + '|' +
        String(pool.mathType || '') + '|' +
        String(pool.dex || '') + '|' +
        String(pool.source || '')
    ).toLowerCase();
    return rawType.includes('pancakeswap') || rawType.includes('pancake');
}

function isPumpswapPool(pool = {}) {
    const rawType = (
        String(pool.dexType || '') + '|' +
        String(pool.type || '') + '|' +
        String(pool.mathType || '') + '|' +
        String(pool.dex || '') + '|' +
        String(pool.source || '') + '|' +
        String(pool.programId || '')
    ).toLowerCase();
    return rawType.includes('pumpswap') || rawType.includes('pump_swap') || rawType.includes('pump-swap') || rawType.includes('pammbay');
}

const RESERVES_ONLY_ADAPTERS = Object.freeze({
    damm_v2: { path: './math/Q_DAMM_V2.js', dexType: 'METEORA_DAMM_V2', hasFetchPool: false },
    pumpswap: { path: './math/Q_PUMPSWAP.js', dexType: 'PUMPSWAP_CPMM', hasFetchPool: false },
    pancakeswap: { path: './math/Q_PANCAKESWAP.js', dexType: 'PANCAKESWAP_AMM', hasFetchPool: false },
});

const _reservesAdapterCache = new Map();
function _getReservesAdapter(type) {
    if (_reservesAdapterCache.has(type)) return _reservesAdapterCache.get(type);
    const spec = RESERVES_ONLY_ADAPTERS[type];
    if (!spec) { _reservesAdapterCache.set(type, null); return null; }
    let mod = null;
    try { mod = require(spec.path); }
    catch (err) {
        console.warn(`[_enrichment] adapter ${type} (${spec.path}) failed: ${err.message}`);
    }
    _reservesAdapterCache.set(type, mod);
    return mod;
}

function _hasUsableReserves(pool) {
    const rx = pool?.reserves?.x ?? pool?.xReserve;
    const ry = pool?.reserves?.y ?? pool?.yReserve;
    if (rx == null || ry == null) return false;
    try { return BigInt(rx) > 0n && BigInt(ry) > 0n; }
    catch (_e) { return Number(rx) > 0 && Number(ry) > 0; }
}

async function enrichReservesOnly(pool, connection, type) {
    const spec = RESERVES_ONLY_ADAPTERS[type];
    if (!spec) return { enriched: false, hasReserves: false, reserveSource: 'no-spec' };

    // Fast path: if Q_PoolFetcher already gave us positive canonical reserves,
    // skip unnecessary refresh work.
    // AND we have no live connection, skip the optimistic adapter refresh
    // entirely. This keeps the pool execution-ready without burning an RPC
    // attempt that would fail anyway.
    const preHasReserves = _hasUsableReserves(pool);
    const shouldRefresh = spec.hasFetchPool && connection && !pool.skipLiveRefresh;

    let refreshed = null;
    if (shouldRefresh) {
        const adapter = _getReservesAdapter(type);
        const fetchPool = adapter?.fetchPool || adapter?.default?.fetchPool;
        if (typeof fetchPool === 'function') {
            const rpcUrl = (typeof connection?.nextRpcEndpoint === 'function' ? connection.nextRpcEndpoint() : null)
                || connection?.rpcEndpoint
                || process.env.RPC_URL || process.env.SOLANA_RPC_URL
                || process.env.HELIUS_ENDPOINT1 || process.env.HELIUS_ENDPOINT2
                || process.env.HELIUS_ENDPOINT3 || process.env.HELIUS_ENDPOINT;
            const req = {
                ...pool,
                address: pool.address || pool.poolAddress,
                poolAddress: pool.poolAddress || pool.address,
            };
            try { refreshed = await fetchPool(req, rpcUrl, { connection }); }
            catch (err) { pool.liveError = `${type}-fetchPool: ${err.message}`; }
        }
    }

    const merged = { ...pool };
    if (refreshed && typeof refreshed === 'object') {
        const rRx = refreshed.reserves?.x ?? refreshed.xReserve;
        const rRy = refreshed.reserves?.y ?? refreshed.yReserve;
        if (rRx != null && rRy != null && Number(rRx) > 0 && Number(rRy) > 0) {
            Object.assign(merged, refreshed);
            merged.reserves = { ...(pool.reserves || {}), ...(refreshed.reserves || {}) };
            merged.xReserve = rRx;
            merged.yReserve = rRy;
        }
        if (refreshed.bids) merged.bids = refreshed.bids;
        if (refreshed.asks) merged.asks = refreshed.asks;
        if (refreshed.midPrice != null) merged.midPrice = refreshed.midPrice;
    }

    merged.dexType = merged.dexType || spec.dexType;
    merged.fetchedAt = merged.fetchedAt || new Date().toISOString();

    const hasReserves = _hasUsableReserves(merged);
    const hasPrice = hasUsablePoolPrice(merged);
    const enriched = hasReserves || hasPrice;
    return {
        enriched,
        hasReserves,
        reserves: merged.reserves,
        xReserve: merged.reserves?.x,
        yReserve: merged.reserves?.y,
        midPrice: merged.midPrice,
        bids: merged.bids,
        asks: merged.asks,
        reserveSource: refreshed ? 'adapter-refresh' : 'canonical-q-fetcher',
        quoteSource: merged.quoteSource || (hasReserves ? 'native-reserves' : 'price-only'),
        isMathReady: enriched,
        dexType: merged.dexType,
    };
}

function isFreshCanonicalInput(pool = {}) {
    // Fast-path criterion: the pool already contains everything the simulator
    // needs to quote, regardless of which off-chain enricher produced it.
    // The old version also required pool.raw / pool.normalized, which made
    // every pre-enriched pool fall through the slow path even when it had
    // perfectly good live state.
    //
    // We now decide per pool type what "math-ready" actually means:
    //   CLMM / Whirlpool : sqrtPrice + liquidity + tickArrays
    //   DLMM             : binStep + activeBinId + bins or binArrays
    //   CPMM / reserves-only : positive reserves
    //
    // We do NOT require pool.raw / pool.normalized — those are nice-to-have
    // debug payloads, not execution-critical state.

    const type = String(pool.type || pool.dexType || '').toLowerCase();
    const hasReserves = Boolean(
        (pool.reserves && (pool.reserves.x || pool.reserves.y))
        || pool.xReserve || pool.yReserve
    );

    // Common: vault addresses (Kamino borrow/repay + swap builders need these)
    const hasVaults = Boolean(
        (pool.xVault || pool.vaults?.xVault)
        && (pool.yVault || pool.vaults?.yVault)
    );

    // Common: token identification
    const hasMints = Boolean(
        (pool.tokenXMint && pool.tokenYMint)
        || (pool.baseMint && pool.quoteMint)
        || (pool.mintA && pool.mintB)
    );

    if (!hasMints) return false;

    if (type.includes('clmm') || type.includes('whirlpool')) {
        const hasMath = Boolean(
            (pool.sqrtPrice || pool.sqrtPriceX64)
            && pool.liquidity
            && (pool.tickArrays?.length > 0 || pool.tickArrayCache)
        );
        return hasMath && hasVaults;
    }
    if (type.includes('dlmm') || type.includes('meteora')) {
        const hasMath = Boolean(
            pool.binStep != null
            && pool.activeBinId != null
            && (pool.bins || (pool.binArrays?.length > 0))
        );
        return hasMath && hasVaults;
    }
    // CPMM / reserves-only DEXes still need both vaults for executable swap
    // construction; reserves/price alone are only useful for diagnostics.
    return hasVaults && (hasReserves || hasUsablePoolPrice(pool));
}

function parseSplTokenAmount(data) {
    if (!data || !Buffer.isBuffer(data) || data.length < 72) return null;
    try {
        return data.readBigUInt64LE(64).toString();
    } catch (_e) {
        return null;
    }
}

function jsonReplacer(_key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
        if (value.constructor?.name === 'BN' && typeof value.toString === 'function') {
            return value.toString();
        }
        if (typeof value.toBase58 === 'function') {
            return value.toBase58();
        }
    }
    return value;
}

function safeStringify(value) {
    const ancestors = [];
    return JSON.stringify(value, (key, currentValue) => {
        const normalizedValue = jsonReplacer(key, currentValue);
        if (!normalizedValue || typeof normalizedValue !== 'object') {
            return normalizedValue;
        }

        // Drop true circular references, but preserve repeated references.
        // Hydrated route payloads intentionally reuse arrays/objects between
        // route legs and pool records; a global WeakSet erases whichever copy
        // appears later in the JSON, making hydration look broken on disk.
        while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
        }
        if (ancestors.includes(normalizedValue)) return undefined;
        ancestors.push(normalizedValue);
        return normalizedValue;
    }, 2);
}

function hasPositiveAtomic(value) {
    try {
        if (value === undefined || value === null || value === '') return false;
        return BigInt(String(value).split('.')[0] || '0') > 0n;
    } catch (_error) {
        return false;
    }
}

function hasPositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
}

function hasUsablePoolPrice(pool = {}, canonical = {}) {
    return hasPositiveNumber(
        pool.currentPrice ?? pool.midPrice ?? pool.price
        ?? canonical.currentPrice ?? canonical.midPrice ?? canonical.price,
    );
}

function countArray(value) {
    return Array.isArray(value) ? value.length : 0;
}

function decodedTickArrayCount(pool = {}) {
    const collections = [
        pool.tickArrayData,
        pool.aux?.clmm?.tickArrayData,
        pool.aux?.whirlpool?.tickArrayData,
        pool.aux?.whirlpool?.tickArrays,
        pool.tickArrays,
    ];
    let count = 0;
    for (const collection of collections) {
        if (!Array.isArray(collection)) continue;
        for (const entry of collection) {
            if (Array.isArray(entry?.ticks) || Array.isArray(entry?.data?.ticks)) count += 1;
        }
    }
    return count;
}

function hasDecodedTickState(pool = {}) {
    return decodedTickArrayCount(pool) > 0;
}

function getVaultAddress(pool = {}, side = 'x') {
    if (side === 'x') {
        return (
            pool.xVault || pool.vaults?.xVault || pool.vaults?.aVault
            || pool.tokenVaultA || pool.baseVault || pool.tokenVault0 || pool.vaultA
            || pool._raw?.reserve_x || pool.reserveX || null
        );
    }
    return (
        pool.yVault || pool.vaults?.yVault || pool.vaults?.bVault
        || pool.tokenVaultB || pool.quoteVault || pool.tokenVault1 || pool.vaultB
        || pool._raw?.reserve_y || pool.reserveY || null
    );
}

function asPublicKey(value) {
    if (!value) return null;
    if (value instanceof PublicKey) return value;
    try {
        return new PublicKey(typeof value.toBase58 === 'function' ? value.toBase58() : String(value));
    } catch (_e) {
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/*                          Canonical wire-up                                 */
/* -------------------------------------------------------------------------- */

function hasCanonicalReserves(pool = {}, canonical = {}) {
    return hasPositiveAtomic(canonical?.reserves?.x ?? pool?.xReserve ?? pool?.reserves?.x)
        && hasPositiveAtomic(canonical?.reserves?.y ?? pool?.yReserve ?? pool?.reserves?.y);
}

function wireCanonicalAndAux(pool = {}, enrichment = {}) {
    const merged = { ...pool, ...enrichment };

    if (enrichment.xVault !== undefined || enrichment.yVault !== undefined || enrichment.vaults) {
        merged.xVault = enrichment.xVault ?? merged.xVault ?? merged.vaults?.xVault;
        merged.yVault = enrichment.yVault ?? merged.yVault ?? merged.vaults?.yVault;
        merged.vaults = {
            ...(merged.vaults || {}),
            ...(enrichment.vaults || {}),
            ...(enrichment.xVault !== undefined ? { xVault: enrichment.xVault } : {}),
            ...(enrichment.yVault !== undefined ? { yVault: enrichment.yVault } : {}),
        };
    }
    if (enrichment.xReserve !== undefined || enrichment.yReserve !== undefined) {
        merged.xReserve = enrichment.xReserve ?? merged.xReserve;
        merged.yReserve = enrichment.yReserve ?? merged.yReserve;
        merged.reserves = {
            ...(merged.reserves || {}),
            ...(enrichment.xReserve !== undefined ? { x: enrichment.xReserve } : {}),
            ...(enrichment.yReserve !== undefined ? { y: enrichment.yReserve } : {}),
        };
    }

    const tokenXPriceUsd = enrichment.tokenXPriceUsd
        ?? enrichment.tokenA?.priceUsd ?? enrichment.basePriceUsd
        ?? pool.tokenXPriceUsd ?? pool.tokenA?.priceUsd ?? merged.tokenXPriceUsd;
    const tokenYPriceUsd = enrichment.tokenYPriceUsd
        ?? enrichment.tokenB?.priceUsd ?? enrichment.quotePriceUsd
        ?? pool.tokenYPriceUsd ?? pool.tokenB?.priceUsd ?? merged.tokenYPriceUsd;
    if (tokenXPriceUsd !== undefined) {
        merged.tokenXPriceUsd = tokenXPriceUsd;
        merged.basePriceUsd = tokenXPriceUsd;
    }
    if (tokenYPriceUsd !== undefined) {
        merged.tokenYPriceUsd = tokenYPriceUsd;
        merged.quotePriceUsd = tokenYPriceUsd;
    }

    const canonical = normalizePoolRecord(merged);
    if (!canonical) return merged;

    const validation = validateCanonicalPool(canonical);
    const builtAux = buildNormalizedAux({ ...merged, ...canonical });

    merged.address = merged.address || merged.poolAddress || merged.id || canonical.address;
    merged.poolAddress = merged.poolAddress || canonical.address || merged.address;
    merged.programId = merged.programId || merged._raw?.programId || canonical._raw?.programId || null;
    merged.dexType = canonical.dexType || merged.dexType;
    merged.dex = canonical.dex || merged.dex;
    merged.type = canonical.type || merged.type;

    merged.tokenXMint = canonical.tokenXMint;
    merged.tokenYMint = canonical.tokenYMint;
    merged.tokenXDecimals = canonical.tokenXDecimals;
    merged.tokenYDecimals = canonical.tokenYDecimals;

    merged.reserves = canonical.reserves;
    merged.vaults = canonical.vaults;
    merged.xVault = canonical.vaults?.xVault ?? merged.xVault ?? null;
    merged.yVault = canonical.vaults?.yVault ?? merged.yVault ?? null;
    merged.feeBps = canonical.feeBps;
    merged.feeBpsCanonical = canonical.feeBps;
    merged.feePctCanonical = Number((Number(canonical.feeBps || 0) / 100).toFixed(4));

    if (canonical.tickSpacing !== undefined) merged.tickSpacing = canonical.tickSpacing;
    if (canonical.tickCurrent !== undefined) merged.tickCurrent = canonical.tickCurrent;
    if (canonical.tickArrays !== undefined) merged.tickArrays = canonical.tickArrays;
    if (canonical.tvl !== undefined) merged.tvl = canonical.tvl;
    if (canonical.liquidity !== undefined) merged.liquidity = canonical.liquidity;
    if (canonical.sqrtPrice !== undefined) merged.sqrtPrice = canonical.sqrtPrice;
    if (enrichment.tickArrayData !== undefined) merged.tickArrayData = enrichment.tickArrayData;
    if (enrichment.remainingAccounts !== undefined) merged.remainingAccounts = enrichment.remainingAccounts;

    if (canonical.binStep !== undefined) merged.binStep = canonical.binStep;
    if (canonical.activeBinId !== undefined) merged.activeBinId = canonical.activeBinId;
    if (enrichment.bins !== undefined) merged.bins = enrichment.bins;
    else if (canonical.bins !== undefined) merged.bins = canonical.bins;
    if (enrichment.binArrays !== undefined) merged.binArrays = enrichment.binArrays;
    else if (canonical.binArrays !== undefined) merged.binArrays = canonical.binArrays;

    merged.aux = { ...(merged.aux || {}), ...(builtAux || {}) };
    merged.normalized = canonical;
    merged.normalization = validation;

    return merged;
}

/* -------------------------------------------------------------------------- */
/*                               Diagnostics                                  */
/* -------------------------------------------------------------------------- */

function collectExecutionBlockers(type, pool, canonical, validation) {
    const blockers = [];
    const reservesOk = hasCanonicalReserves(pool, canonical);
    const xVault = pool?.xVault ?? pool?.vaults?.xVault ?? canonical?.xVault ?? canonical?.vaults?.xVault;
    const yVault = pool?.yVault ?? pool?.vaults?.yVault ?? canonical?.yVault ?? canonical?.vaults?.yVault;
    const vaultsOk = Boolean(xVault && yVault);
    const tickArrays = countArray(pool?.tickArrays);
    const tickArrayData = countArray(pool?.tickArrayData) || countArray(pool?.aux?.whirlpool?.tickArrays);
    const decodedTickArrays = decodedTickArrayCount(pool);
    const decodedTickState = decodedTickArrays > 0;
    const ticks = countArray(pool?.ticks) || countArray(pool?.aux?.whirlpool?.ticks) || countArray(pool?.aux?.clmm?.ticks);
    const binArrays = countArray(pool?.binArrays) || countArray(pool?.aux?.dlmm?.binArrays);
    const bins = countArray(pool?.bins) || countArray(pool?.aux?.dlmm?.bins);
    const liquidityOk = hasPositiveAtomic(pool?.liquidity ?? canonical?.liquidity);
    const sqrtPriceOk = hasPositiveAtomic(pool?.sqrtPriceX64 ?? pool?.sqrtPrice ?? canonical?.sqrtPriceX64 ?? canonical?.sqrtPrice);
    const binStepOk = hasPositiveNumber(pool?.binStep ?? canonical?.binStep);
    const activeBinPresent = Number.isFinite(Number(pool?.activeBinId ?? canonical?.activeBinId));
    const priceOk = hasUsablePoolPrice(pool, canonical);
    const reserveOptional = (
        type === 'dlmm'
        || type === 'cpmm'
        || type === 'goosefx'
        || type === 'damm_v2'
        || type === 'pumpswap'
        || type === 'amm'
    );
    if (!validation.valid) {
        for (const error of validation.errors) {
            if (reserveOptional && error === 'Missing reserves' && (priceOk || type === 'dlmm')) continue;
            blockers.push(`canonical:${error}`);
        }
    }
    if (!pool?.enriched) blockers.push('enrichment:failed');
    if (pool?.error) blockers.push(`enrichment:${pool.error}`);
    // liveError is only fatal for types that NEED live RPC state to execute.
    // Reserves-only types execute off canonical reserves, so a failed optimistic
    // adapter refresh is just info.
    const liveRequired = ['whirlpool', 'clmm'];
    if (pool?.liveError && liveRequired.includes(type)) blockers.push(`live:${pool.liveError}`);
    if (!vaultsOk) blockers.push('state:missing-vaults');

    switch (type) {
        case 'cpmm':
            if (!reservesOk && !priceOk) blockers.push('state:missing-reserves-or-price');
            break;
        case 'clmm':
            if (!reservesOk) blockers.push('state:missing-reserves');
            if (!tickArrays) blockers.push('state:missing-tick-arrays');
            if (!decodedTickState) blockers.push('state:missing-decoded-tick-arrays');
            if (!ticks && !decodedTickState) blockers.push('state:missing-ticks');
            if (!liquidityOk) blockers.push('state:missing-liquidity');
            if (!sqrtPriceOk) blockers.push('state:missing-sqrt-price');
            break;
        case 'whirlpool':
            if (!reservesOk) blockers.push('state:missing-reserves');
            if (!tickArrays) blockers.push('state:missing-tick-arrays');
            if (!decodedTickState) blockers.push('state:missing-decoded-tick-arrays');
            if (!ticks && !decodedTickState) blockers.push('state:missing-ticks');
            if (!liquidityOk) blockers.push('state:missing-liquidity');
            if (!sqrtPriceOk) blockers.push('state:missing-sqrt-price');
            break;
        case 'dlmm':
            if (!binArrays) blockers.push('state:missing-bin-arrays');
            if (!bins) blockers.push('state:missing-bins');
            if (!binStepOk) blockers.push('state:missing-bin-step');
            if (!activeBinPresent) blockers.push('state:missing-active-bin');
            break;
        case 'goosefx':
        case 'damm_v2':
        case 'pumpswap':
        case 'amm':
            if (!reservesOk && !priceOk) blockers.push('state:missing-reserves-or-price');
            break;
        default:
            blockers.push(`type:unsupported-${type}`);
            break;
    }

    return Array.from(new Set(blockers));
}

function buildEnrichmentDiagnosticsEntry(pool = {}) {
    const canonical = normalizePoolRecord(pool);
    const validation = validateCanonicalPool(canonical);
    const type = resolvePoolType(pool);
    const blockers = collectExecutionBlockers(type, pool, canonical, validation);

    return {
        poolAddress: pool.address || pool.poolAddress || pool.id || null,
        dex: pool.dex || canonical?.dex || null,
        type,
        dexType: canonical?.dexType || pool.dexType || null,
        enriched: Boolean(pool.enriched),
        canonicalValid: validation.valid,
        canonicalErrors: validation.errors,
        reservesOk: hasCanonicalReserves(pool, canonical),
        vaultsOk: Boolean(
            (pool?.xVault ?? pool?.vaults?.xVault ?? canonical?.xVault ?? canonical?.vaults?.xVault)
            && (pool?.yVault ?? pool?.vaults?.yVault ?? canonical?.yVault ?? canonical?.vaults?.yVault)
        ),
        liquidityOk: hasPositiveAtomic(pool?.liquidity ?? canonical?.liquidity),
        sqrtPriceOk: hasPositiveAtomic(pool?.sqrtPriceX64 ?? pool?.sqrtPrice ?? canonical?.sqrtPriceX64 ?? canonical?.sqrtPrice),
        tickArrayCount: countArray(pool?.tickArrays),
        structuredTickArrayCount: decodedTickArrayCount(pool),
        tickCount: countArray(pool?.ticks) || countArray(pool?.aux?.whirlpool?.ticks) || countArray(pool?.aux?.clmm?.ticks),
        binArrayCount: countArray(pool?.binArrays) || countArray(pool?.aux?.dlmm?.binArrays),
        binCount: countArray(pool?.bins) || countArray(pool?.aux?.dlmm?.bins),
        tickStrategy: pool?.tickStrategy || null,
        feeBps: canonical?.feeBps,
        liveError: pool?.liveError || null,
        error: pool?.error || null,
        reserveSource: pool?.reserveSource || canonical?._raw?.reserveSource || null,
        remainingAccountCount: countArray(pool?.remainingAccounts),
        executionReady: blockers.length === 0,
        blockers,
    };
}

function buildEnrichmentDebugReport(pools = []) {
    const entries = pools.map(buildEnrichmentDiagnosticsEntry);
    const summary = {
        totalPools: entries.length,
        executionReadyPools: entries.filter((entry) => entry.executionReady).length,
        byType: {},
        topBlockers: {},
    };

    for (const entry of entries) {
        const bucket = summary.byType[entry.type] || {
            total: 0, enriched: 0, executionReady: 0, reservesOk: 0,
            canonicalInvalid: 0, tickArraysPresent: 0, structuredTickArraysPresent: 0,
            ticksPresent: 0, binArraysPresent: 0, binsPresent: 0,
            liquidityPresent: 0, sqrtPricePresent: 0,
        };
        bucket.total += 1;
        if (entry.enriched) bucket.enriched += 1;
        if (entry.executionReady) bucket.executionReady += 1;
        if (entry.reservesOk) bucket.reservesOk += 1;
        if (!entry.canonicalValid) bucket.canonicalInvalid += 1;
        if (entry.tickArrayCount > 0) bucket.tickArraysPresent += 1;
        if (entry.structuredTickArrayCount > 0) bucket.structuredTickArraysPresent += 1;
        if (entry.tickCount > 0) bucket.ticksPresent += 1;
        if (entry.binArrayCount > 0) bucket.binArraysPresent += 1;
        if (entry.binCount > 0) bucket.binsPresent += 1;
        if (entry.liquidityOk) bucket.liquidityPresent += 1;
        if (entry.sqrtPriceOk) bucket.sqrtPricePresent += 1;
        summary.byType[entry.type] = bucket;
        for (const blocker of entry.blockers) {
            summary.topBlockers[blocker] = (summary.topBlockers[blocker] || 0) + 1;
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        summary,
        pools: entries,
    };
}

function printEnrichmentDebugSummary(report) {
    if (!report?.summary) return;


    console.log('\n🔎 ENRICHMENT DIAGNOSTICS');
    console.log('───────────────────────────────────────────────────────────────────────────');
    console.log(`Execution-ready pools: ${report.summary.executionReadyPools}/${report.summary.totalPools}`);

    for (const [type, stats] of Object.entries(report.summary.byType)) {
        console.log(
            `  ${type}: ready=${stats.executionReady}/${stats.total} `
            + `reserves=${stats.reservesOk}/${stats.total} `
            + `tickArrays=${stats.tickArraysPresent}/${stats.total} `
            + `structured=${stats.structuredTickArraysPresent}/${stats.total} `
            + `ticks=${stats.ticksPresent}/${stats.total} `
            + `bins=${stats.binsPresent}/${stats.total}`,
        );
    }

    const topBlockers = Object.entries(report.summary.topBlockers)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8);

    if (topBlockers.length) {
        console.log('\nTop blockers:');
        for (const [blocker, count] of topBlockers) {
            console.log(`  ${blocker}: ${count}`);
        }
    }
}

function poolRecordKey(pool = {}) {
    return pool.poolAddress || pool.address || pool.id || null;
}

function routeLegs(route) {
    if (Array.isArray(route)) return route;
    if (Array.isArray(route?.legs)) return route.legs;
    if (Array.isArray(route?.route)) return route.route;
    if (Array.isArray(route?.pools)) return route.pools;
    return [];
}

function routeUsesOnlyKnownPools(route, allowedPoolKeys) {
    const legs = routeLegs(route);
    if (!legs.length) return true;
    return legs.every((leg) => {
        const key = poolRecordKey(leg?.pool || leg);
        return key && allowedPoolKeys.has(key);
    });
}

function refreshRouteWithReadyPools(route, readyPoolByKey) {
    const refreshLeg = (leg) => {
        const key = poolRecordKey(leg?.pool || leg);
        const fresh = key ? readyPoolByKey.get(key) : null;
        if (!fresh) return leg;
        return {
            ...fresh,
            ...leg,
            // Fresh execution state must win over stale route snapshots.
            reserves: fresh.reserves ?? leg.reserves,
            xReserve: fresh.xReserve ?? leg.xReserve,
            yReserve: fresh.yReserve ?? leg.yReserve,
            vaults: fresh.vaults ?? leg.vaults,
            xVault: fresh.xVault ?? leg.xVault,
            yVault: fresh.yVault ?? leg.yVault,
            sqrtPriceX64: fresh.sqrtPriceX64 ?? leg.sqrtPriceX64,
            sqrtPrice: fresh.sqrtPrice ?? leg.sqrtPrice,
            liquidity: fresh.liquidity ?? leg.liquidity,
            tickCurrent: fresh.tickCurrent ?? leg.tickCurrent,
            tickSpacing: fresh.tickSpacing ?? leg.tickSpacing,
            tickArrays: fresh.tickArrays ?? leg.tickArrays,
            tickArrayData: fresh.tickArrayData ?? leg.tickArrayData,
            ticks: fresh.ticks ?? leg.ticks,
            remainingAccounts: fresh.remainingAccounts ?? leg.remainingAccounts,
            binStep: fresh.binStep ?? leg.binStep,
            activeBinId: fresh.activeBinId ?? leg.activeBinId,
            bins: fresh.bins ?? leg.bins,
            binArrays: fresh.binArrays ?? leg.binArrays,
            hydratedAt: fresh.hydratedAt ?? leg.hydratedAt,
            hydratedAtIso: fresh.hydratedAtIso ?? leg.hydratedAtIso,
            hydratedSlot: fresh.hydratedSlot ?? leg.hydratedSlot,
            fetchedAt: fresh.fetchedAt ?? leg.fetchedAt,
            fetchedAtMs: fresh.fetchedAtMs ?? leg.fetchedAtMs,
            lastUpdated: fresh.lastUpdated ?? leg.lastUpdated,
            slot: fresh.slot ?? leg.slot,
        };
    };

    if (Array.isArray(route)) return route.map(refreshLeg);
    if (Array.isArray(route?.legs)) return { ...route, legs: route.legs.map(refreshLeg) };
    if (Array.isArray(route?.route)) return { ...route, route: route.route.map(refreshLeg) };
    if (Array.isArray(route?.pools)) return { ...route, pools: route.pools.map(refreshLeg) };
    return route;
}

function pruneRoutesForReadyPools(payload, allowedPoolKeys, readyPoolByKey = new Map()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

    const next = { ...payload };
    if (Array.isArray(next.chainRoutes)) {
        next.chainRoutes = next.chainRoutes
            .filter((route) => routeUsesOnlyKnownPools(route, allowedPoolKeys))
            .map((route) => refreshRouteWithReadyPools(route, readyPoolByKey));
        next.chainRouteCount = next.chainRoutes.length;
    }
    if (Array.isArray(next.triangles)) {
        next.triangles = next.triangles.map((triangle) => {
            if (!triangle || typeof triangle !== 'object') return triangle;
            const tri = { ...triangle };
            if (Array.isArray(tri.chainRoutes)) {
                tri.chainRoutes = tri.chainRoutes
                    .filter((route) => routeUsesOnlyKnownPools(route, allowedPoolKeys))
                    .map((route) => refreshRouteWithReadyPools(route, readyPoolByKey));
                tri.chainRouteCount = tri.chainRoutes.length;
            }
            return tri;
        }).filter((triangle) => !Array.isArray(triangle?.chainRoutes) || triangle.chainRoutes.length > 0);
    }
    next.routedPoolCount = allowedPoolKeys.size;
    return next;
}

function filterExecutionReadyPools(pools = []) {
    const ready = [];
    const dropped = [];
    for (const pool of pools) {
        const diagnostics = buildEnrichmentDiagnosticsEntry(pool);
        if (diagnostics.executionReady) ready.push(pool);
        else dropped.push({ diagnostics, pool });
    }
    return { ready, dropped };
}

function quarantineOutputPath(outputPath) {
    const ext = path.extname(outputPath);
    if (!ext) return `${outputPath}.quarantine.json`;
    return `${outputPath.slice(0, -ext.length)}.quarantine${ext}`;
}

/* -------------------------------------------------------------------------- */
/*                          Compaction helpers                                */
/* -------------------------------------------------------------------------- */

const QUOTE_KEEP_KEYS = [
    'dexType', 'poolAddress', 'swapForY', 'swapDirection', 'direction',
    'inAmountRaw', 'outAmountRaw', 'minOutAmountRaw',
    'tokenXMint', 'tokenYMint', 'tokenA', 'tokenB', 'mintA', 'mintB',
    'baseMint', 'quoteMint', 'tokenInMint', 'tokenOutMint', 'inputMint', 'outputMint',
    'inAmountDecimal', 'outAmountDecimal', 'minOutAmountDecimal',
    'inAmountHuman', 'outAmountHuman',
    'executionPrice', 'priceImpact', 'priceDiff', 'priceDiffBps',
    'tvl', 'toUsd', 'outputPriceUsd', 'priceSourceUsd',
    'fee', 'feeBps', 'slippageBps',
    'inDecimals', 'outDecimals', 'inputDecimals', 'outputDecimals',
    'success', 'error', 'quoteSource', 'tickStrategy',
    'tickArrays', 'remainingAccounts', 'binArrays', 'bins',
    'binStep', 'activeBinId',
    'sqrtPriceLimitX64', 'liquidity', 'feeAmount', 'sqrtPriceNext', 'tickNext', 'loopCount',
];

const POOL_KEEP_KEYS = [
    'poolAddress', 'address', 'programId',
    'dex', 'dexType', 'type',
    'pair', 'pairLabel',
    'pairCanonical', 'pairBaseMint', 'pairQuoteMint', 'pairBaseSymbol', 'pairQuoteSymbol',
    'pairOrientation',
    'pairMidPrice', 'pairMidExtractionSource', 'pairMidDeviationBps', 'pairMidOutlier',
    'pairSpreadPosition',
    'pairDivergenceBps', 'pairRawDivergenceBps', 'pairDivergenceComparable',
    'pairDivergenceUnsafeHeterogeneous', 'pairMedianMid', 'pairBestMid', 'pairWorstMid',
    'pairPeerCount', 'pairComparablePeerCount',
    'baseSymbol', 'quoteSymbol', 'tokenXSymbol', 'tokenYSymbol', 'tokenSymbol',
    'inputSymbol', 'outputSymbol',
    'baseMint', 'quoteMint', 'tokenXMint', 'tokenYMint', 'inputMint', 'outputMint', 'tokenInMint', 'tokenOutMint',
    'swapForY', 'aToB', 'swapDirection', 'direction',
    'baseDecimals', 'quoteDecimals', 'tokenXDecimals', 'tokenYDecimals', 'inputDecimals', 'outputDecimals',
    'inDecimals', 'outDecimals',
    'reserves', 'xReserve', 'yReserve', 'vaults', 'xVault', 'yVault',
    'feeBps', 'feeBpsCanonical', 'feePctCanonical', 'baseFeeBps', 'liveFeeBps', 'dlmmFeeError',
    'currentPrice', 'midPrice', 'price', 'quoteSource', 'currentPriceSource',
    'tickSpacing', 'tickCurrent', 'tickArrays', 'tickArrayData', 'ticks', 'remainingAccounts',
    'tvl', 'liquidity', 'sqrtPrice', 'sqrtPriceX64',
    'tokenXPriceUsd', 'tokenYPriceUsd', 'basePriceUsd', 'quotePriceUsd',
    'binStep', 'activeBinId', 'bins', 'binArrays',
    'reserveSource', 'tickStrategy', 'tickCount', 'binCount',
    'hasReserves', 'hasRealTicks', 'hasRealBins', 'isMathReady',
    'enriched', 'enrichmentDiagnostics',
    'hydratedAt', 'hydratedAtIso', 'hydratedSlot', 'fetchedAt', 'fetchedAtMs', 'lastUpdated', 'slot',
    'routeId', 'routePath', 'routeIndex', 'triangleIndex', 'legIndex', 'label',
    'routeScore', 'directionalEdgeBps', 'routeTotalFeeBps', '_divergenceMeta',
    'marketDepthAvailable', 'marketDepthReason', 'marketDepthSpotSource',
    'marketDepthSpotOutPerIn', 'marketDepthSpotOutAtomic',
    'marketDepthQuotedOutAtomic', 'marketDepthImpactBps', 'marketDepthSlippageBps',
];

function compactQuoteOutput(quote = {}) {
    if (!quote || typeof quote !== 'object') return quote;
    const compact = {};
    for (const key of QUOTE_KEEP_KEYS) {
        if (quote[key] !== undefined) compact[key] = quote[key];
    }
    return compact;
}

function compactPoolOutput(pool = {}) {
    if (!pool || typeof pool !== 'object') return pool;
    const compact = {};
    for (const key of POOL_KEEP_KEYS) {
        if (pool[key] !== undefined) compact[key] = pool[key];
    }
    if (pool.quote) compact.quote = compactQuoteOutput(pool.quote);
    if (pool.fastQuote) compact.fastQuote = compactQuoteOutput(pool.fastQuote);
    if (pool.exactQuote) compact.exactQuote = compactQuoteOutput(pool.exactQuote);
    return compact;
}

function compactPoolForEnrichedOutput(pool = {}) {
    const compact = compactPoolOutput(pool);
    if (compact.aux && typeof compact.aux === 'object') {
        const aux = { ...compact.aux };
        if (aux.whirlpool && typeof aux.whirlpool === 'object') {
            const { tickArrays, tickArrayData, ticks, ...rest } = aux.whirlpool;
            aux.whirlpool = rest;
        }
        if (aux.clmm && typeof aux.clmm === 'object') {
            const { tickArrays, tickArrayData, ticks, ...rest } = aux.clmm;
            aux.clmm = rest;
        }
        compact.aux = aux;
    }
    delete compact.normalized;
    delete compact.normalization;
    return compact;
}

function compactEnrichmentPayload(outputPayload) {
    if (Array.isArray(outputPayload)) return outputPayload.map(compactPoolForEnrichedOutput);
    if (!outputPayload || typeof outputPayload !== 'object') return outputPayload;
    return {
        source: outputPayload.source,
        generatedAt: outputPayload.generatedAt,
        refreshedAt: outputPayload.refreshedAt,
        freshness: outputPayload.freshness,
        pools: Array.isArray(outputPayload.pools) ? outputPayload.pools.map(compactPoolForEnrichedOutput) : outputPayload.pools,
        data: Array.isArray(outputPayload.data) ? outputPayload.data.map(compactPoolForEnrichedOutput) : outputPayload.data,
        poolShape: outputPayload.poolShape ? compactPoolForEnrichedOutput(outputPayload.poolShape) : outputPayload.poolShape,
    };
}

function compactRouteLegOutput(leg = {}) {
    return compactPoolOutput(leg);
}

function compactRouteOutput(route = {}) {
    if (Array.isArray(route)) return route.map(compactRouteLegOutput);
    if (!route || typeof route !== 'object') return route;
    return {
        ...route,
        legs: Array.isArray(route.legs) ? route.legs.map(compactRouteLegOutput) : route.legs,
    };
}

function compactRoutePrepOutput(routePrep = {}, compactPools = null) {
    if (!routePrep || typeof routePrep !== 'object') return routePrep;
    const pools = Array.isArray(compactPools)
        ? compactPools
        : (Array.isArray(routePrep.pools) ? routePrep.pools.map(compactPoolOutput) : routePrep.pools);
    return {
        ...routePrep,
        pools,
        chainRoutes: Array.isArray(routePrep.chainRoutes)
            ? routePrep.chainRoutes.map(compactRouteOutput)
            : routePrep.chainRoutes,
    };
}

/* -------------------------------------------------------------------------- */
/*                         Whirlpool enrichment                               */
/* -------------------------------------------------------------------------- */

function buildApproxWhirlpoolEnrichment(pool) {
    const sqrtPriceX64 = String(pool.sqrtPriceX64 || pool.sqrtPrice || '0');
    const xReserve = String(pool.xReserve || pool.reserves?.x || '0');
    const yReserve = String(pool.yReserve || pool.reserves?.y || '0');
    const tickArrays = Array.isArray(pool.tickArrays) ? pool.tickArrays : [];
    const tickArrayData = Array.isArray(pool.tickArrayData) ? pool.tickArrayData : [];

    return {
        sqrtPriceX64,
        sqrtPrice: sqrtPriceX64,
        tickCurrent: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? 0),
        tickSpacing: Number(pool.tickSpacing ?? 64),
        liquidity: String(pool.liquidity || '0'),
        tickArrays,
        tickArrayData,
        remainingAccounts: Array.isArray(pool.remainingAccounts) ? pool.remainingAccounts : tickArrays,
        ticks: Array.isArray(pool.ticks) ? pool.ticks : [],
        tickCount: Array.isArray(pool.ticks) ? pool.ticks.length : 0,
        hasRealTicks: false,
        tickStrategy: 'adapter-approximation',
        xReserve,
        yReserve,
        hasReserves: xReserve !== '0' && yReserve !== '0',
        aux: {
            whirlpool: {
                sqrtPriceX64,
                tickCurrent: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? 0),
                tickSpacing: Number(pool.tickSpacing ?? 64),
                liquidity: String(pool.liquidity || '0'),
                tickArrays: tickArrayData,
                remainingAccounts: Array.isArray(pool.remainingAccounts) ? pool.remainingAccounts : tickArrays,
                approximation: true,
            },
        },
        enriched: true,
    };
}

function buildStructuredTickArrayData(address, startTickIndex, rawTicks = []) {
    return normalizeStructuredTickArray({
        address,
        data: {
            startTickIndex,
            ticks: Array.isArray(rawTicks)
                ? rawTicks.map((tick = {}) => ({
                    initialized: tick.initialized !== undefined
                        ? Boolean(tick.initialized)
                        : ((tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0')) !== '0'),
                    liquidityNet: tick.liquidityNet?.toString?.() || String(tick.liquidityNet || '0'),
                    liquidityGross: tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0'),
                }))
                : [],
        },
    });
}

/* ============================================================================
 *  finalizeTickContract — THE single source-of-truth for pool execution state.
 * ----------------------------------------------------------------------------
 *  Root problem this solves (garbage-in-garbage-out): three tick-writing paths
 *  (enrichWhirlpool, hydrateWhirlpoolTickArrays, decode*TickArrays) each land
 *  decoded ticks in DIFFERENT fields depending on pool type / RPC timing / which
 *  path fired. So one pool set produces clean results (fields happen to align),
 *  another fails (ticks landed in a field the consumer doesn't read). "Bad
 *  results only on certain pools" is exactly this source inconsistency.
 *
 *  This runs ONCE, after all enrichment/decode, before the readiness gate. It
 *  converges EVERY whirlpool/clmm pool onto ONE canonical contract:
 *      pool.tickArrayData = [ {address, data:{startTickIndex, ticks:[...] }} ]  (structured)
 *      pool.tickArrays    = [ <address strings> ]                               (addresses only)
 *      pool.aux.whirlpool.tickArrays = tickArrayData  (mirror, for legacy readers)
 *  and DLMM onto:
 *      pool.binArrays / pool.bins preserved; aux.dlmm mirrors.
 *
 *  After this, EVERY consumer (simulator, gate, route builder) reads
 *  pool.tickArrayData and only that. No consumer needs to be "tolerant" of field
 *  placement. Any pool set flows through with one guaranteed shape — or is
 *  flagged (contractOk=false) so garbage is caught HERE, at the source, not
 *  downstream as a mysterious -9066bps.
 * ========================================================================== */
function finalizeTickContract(pools = [], opts = {}) {
    const debug = !!opts.debug;
    let normalized = 0, flagged = 0, skipped = 0;

    for (const pool of pools) {
        const type = resolvePoolType(pool);

        if (type === 'whirlpool' || type === 'clmm') {
            // gather structured ticks from EVERY field any path may have written
            const candidates = [
                pool.tickArrayData,
                pool.aux?.whirlpool?.tickArrays,
                pool.aux?.whirlpool?.tickArrayData,
                pool.aux?.clmm?.tickArrayData,
                pool.tickArrays,
            ];
            let structured = null;
            for (const c of candidates) {
                if (hasStructuredTicks(c)) { structured = c; break; }
            }

            if (structured) {
                // canonicalize each entry to {address, data:{startTickIndex, ticks[]}}
                const canonical = structured
                    .map((entry) => {
                        const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
                        const ticks = Array.isArray(data?.ticks) ? data.ticks
                            : (Array.isArray(entry?.ticks) ? entry.ticks : []);
                        if (!ticks.length) return null;
                        return buildStructuredTickArrayData(
                            entry?.address ?? entry?.pubkey ?? entry?.publicKey ?? data?.address ?? null,
                            Number(data?.startTickIndex ?? data?.start_index ?? entry?.startTickIndex ?? 0),
                            ticks,
                        );
                    })
                    .filter(Boolean);

                if (canonical.length) {
                    // ONE canonical field the sim reads:
                    pool.tickArrayData = canonical;
                    // addresses-only in tickArrays so no consumer mistakes it for structured.
                    // Prefer addresses from canonical entries; fall back to any existing
                    // address strings already on pool.tickArrays (don't lose them).
                    const canonAddrs = canonical
                        .map((e) => e?.address ?? e?.data?.address ?? null)
                        .filter(Boolean);
                    const existingAddrs = Array.isArray(pool.tickArrays)
                        ? pool.tickArrays.filter((v) => typeof v === 'string')
                        : [];
                    pool.tickArrays = canonAddrs.length ? canonAddrs : existingAddrs;
                    // mirror for any legacy reader:
                    pool.aux = {
                        ...(pool.aux || {}),
                        whirlpool: {
                            ...(pool.aux?.whirlpool || {}),
                            tickArrays: canonical,
                            tickArrayData: canonical,
                        },
                    };
                    pool.hasRealTicks = true;
                    pool.tickContractOk = true;
                    normalized += 1;
                    continue;
                }
            }
            // no structured ticks anywhere -> flag at the SOURCE (GIGO caught here)
            pool.hasRealTicks = false;
            pool.tickContractOk = false;
            flagged += 1;
            continue;
        }

        if (type === 'dlmm') {
            const bins = pool.bins || pool.aux?.dlmm?.bins;
            const binArrays = (Array.isArray(pool.binArrays) && pool.binArrays.length ? pool.binArrays : null)
                || (Array.isArray(pool.aux?.dlmm?.binArrays) && pool.aux.dlmm.binArrays.length ? pool.aux.dlmm.binArrays : null);
            if (bins || binArrays) {
                if (binArrays) pool.binArrays = binArrays;
                if (bins) pool.bins = bins;
                pool.aux = {
                    ...(pool.aux || {}),
                    dlmm: { ...(pool.aux?.dlmm || {}), bins: pool.bins, binArrays: pool.binArrays },
                };
                pool.hasRealBins = true;
                pool.binContractOk = true;
            } else {
                pool.hasRealBins = false;
                pool.binContractOk = false;
                flagged += 1;
            }
            continue;
        }

        // cpmm/amm/pancakeswap: reserves are the contract; leave as-is
        skipped += 1;
    }

    if (debug) {
        console.log(`  [tickContract] normalized=${normalized} flagged(no-state)=${flagged} skipped(reserve-type)=${skipped}`);
    }
    return { normalized, flagged, skipped };
}

function hasStructuredTicks(value) {
    return Array.isArray(value) && value.some((entry) => (
        entry && typeof entry === 'object' && (
            Array.isArray(entry.ticks) || Array.isArray(entry.data?.ticks)
        )
    ));
}

function hasDecodableWhirlpoolTickPayload(entry) {
    if (!entry) return false;
    if (entry && typeof entry === 'object') {
        if (Array.isArray(entry.ticks) || Array.isArray(entry.data?.ticks)) return true;
        return typeof entry.data === 'string' && entry.data.length > 256;
    }
    return typeof entry === 'string' && entry.length > 256;
}

function decodeWhirlpoolBase64TickArrays(pools = [], opts = {}) {
    const debug = !!opts.debug;
    let decodedPools = 0;
    let decodedArrays = 0;
    let failedPools = 0;

    for (const pool of pools) {
        if (resolvePoolType(pool) !== 'whirlpool') continue;
        if (hasStructuredTicks(pool.tickArrayData) || hasStructuredTicks(pool?.aux?.whirlpool?.tickArrays)) continue;

        const tickSpacing = Number(pool.tickSpacing || pool.tick_spacing || pool?.aux?.whirlpool?.tickSpacing || 1);
        const sources = [
            ...(Array.isArray(pool.tickArrayData) ? pool.tickArrayData : []),
            ...(Array.isArray(pool?.aux?.whirlpool?.tickArrays) ? pool.aux.whirlpool.tickArrays : []),
            ...(Array.isArray(pool.tickArrays) ? pool.tickArrays : []),
        ];
        if (!sources.length) continue;

        const structured = [];
        for (const entry of sources) {
            if (!hasDecodableWhirlpoolTickPayload(entry)) continue;
            const decoded = decodeWhirlpoolTickEntry(entry, tickSpacing);
            const data = decoded?.data && typeof decoded.data === 'object' ? decoded.data : decoded;
            if (!Array.isArray(data?.ticks) || data.ticks.length === 0) continue;

            structured.push(normalizeStructuredTickArray({
                address: entry?.address ?? entry?.pubkey ?? entry?.publicKey ?? decoded?.address ?? null,
                tickSpacing,
                data: {
                    startTickIndex: data.startTickIndex ?? data.start_index ?? entry?.startTickIndex ?? entry?.start_index ?? 0,
                    tickSpacing: data.tickSpacing ?? data.tick_spacing ?? tickSpacing,
                    ticks: data.ticks,
                },
            }));
        }

        if (!structured.length) {
            failedPools += 1;
            continue;
        }

        pool.tickArrayData = structured;
        pool.aux = {
            ...(pool.aux || {}),
            whirlpool: {
                ...(pool.aux?.whirlpool || {}),
                tickArrays: structured,
                tickArrayData: structured,
            },
        };
        decodedPools += 1;
        decodedArrays += structured.length;
    }

    if (debug && (decodedPools || failedPools)) {
        console.log(`  [tickdecode] whirlpool decoded=${decodedPools} pools/${decodedArrays} arrays, failed=${failedPools}`);
    }
    return { decodedPools, decodedArrays, failedPools };
}
class AccountPrefetcher {
    constructor(connection, opts = {}) {
        if (!connection || typeof connection.getMultipleAccountsInfo !== 'function') {
            throw new Error('AccountPrefetcher requires a connection with getMultipleAccountsInfo()');
        }
        this.connection = connection;
        this.cfg = { ...DEFAULTS, ...opts };
        this.cache = new Map(); // b58 -> AccountInfo|null
        this.stats = { rpcCalls: 0, keysRequested: 0, keysFetched: 0, cacheHits: 0, retries: 0 };
    }

    async _fetchChunkWithRetry(pubkeys) {
        const { maxRetries, baseDelayMs, maxDelayMs } = this.cfg;
        let attempt = 0;
        for (; ;) {
            try {
                this.stats.rpcCalls += 1;
                return await this.connection.getMultipleAccountsInfo(pubkeys);
            } catch (err) {
                attempt += 1;
                if (attempt > maxRetries || !isTransient(err)) throw err;
                this.stats.retries += 1;
                const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * (delay / 2));
                await sleep(delay + jitter);
            }
        }
    }

    /**
     * @param {Array} pubkeys  PublicKey-like objects (or base58 strings)
     * @returns {{accounts: Map<string, any|null>, failedKeys: Set<string>}}
     */
    async fetch(pubkeys) {
        const deduped = dedupeKeys(pubkeys);
        this.stats.keysRequested += deduped.size;
        const accounts = new Map();
        const failedKeys = new Set();

        const toFetch = [];
        for (const [b58, pk] of deduped) {
            if (this.cache.has(b58)) {
                accounts.set(b58, this.cache.get(b58));
                this.stats.cacheHits += 1;
            } else {
                toFetch.push([b58, pk]);
            }
        }

        for (const c of chunk(toFetch, this.cfg.chunkSize)) {
            const keys = c.map(([, pk]) => pk);
            let res;
            try {
                res = await this._fetchChunkWithRetry(keys);
            } catch (err) {
                // Retries exhausted or non-transient: mark EVERY key in this chunk failed.
                // We do NOT record them as null — that is the phantom bug we are killing.
                for (const [b58] of c) failedKeys.add(b58);
                continue;
            }
            for (let i = 0; i < c.length; i += 1) {
                const [b58] = c[i];
                const account = res ? res[i] : undefined;
                if (account === undefined) { failedKeys.add(b58); continue; } // unexpected gap = fail, not null
                accounts.set(b58, account); // null here = RPC ok, account absent (legitimate)
                this.cache.set(b58, account);
                this.stats.keysFetched += 1;
            }
        }
        return { accounts, failedKeys };
    }

    clearCache() { this.cache.clear(); }
}

/**
 * Prefetch all accounts required by a pool set, then split ready vs excluded.
 *
 * @param connection      rate-limited connection (your wrapConnection output)
 * @param pools           array of pool objects
 * @param getRequiredKeys (pool) => array of PublicKey-like keys that MUST be readable
 * @returns {{ready, excluded, accounts, prefetcher}}
 *          excluded = [{pool, reason, missingKey}] — feed these nowhere near routing.
 */
async function prefetchPoolAccounts(connection, pools, getRequiredKeys, opts = {}) {
    const prefetcher = opts.prefetcher || new AccountPrefetcher(connection, opts);
    const allKeys = [];
    const poolKeyB58 = new Map();
    for (const pool of pools) {
        const keys = (getRequiredKeys(pool) || []).filter(Boolean);
        poolKeyB58.set(pool, keys.map(keyOf));
        for (const k of keys) allKeys.push(k);
    }
    const { accounts, failedKeys } = await prefetcher.fetch(allKeys);

    const ready = [];
    const excluded = [];
    for (const pool of pools) {
        const missing = poolKeyB58.get(pool).find((b) => failedKeys.has(b));
        if (missing) excluded.push({ pool, reason: 'enrichment-incomplete', missingKey: missing });
        else ready.push(pool);
    }
    return { ready, excluded, accounts, prefetcher, stats: prefetcher.stats };
}

/**
 * Whirlpool enrichment in 2 round trips:
 *   RT1 — pool account
 *   RT2 — getMultipleAccountsInfo([vaultA, vaultB, ...7 tickArray PDAs])
 *
 * Was 1 + 7 + 2 = 10 RPCs (7 of them sequential).
 */
async function enrichWhirlpool(pool, connection) {
    if (!connection) return buildApproxWhirlpoolEnrichment(pool);

    try {
        const poolAddress = new PublicKey(pool.address || pool.poolAddress);

        // RT1: pool state.
        const poolAccount = await connection.getAccountInfo(poolAddress);
        if (!poolAccount) throw new Error(`Pool account not found: ${poolAddress.toBase58()}`);

        const poolState = ParsableWhirlpool.parse(poolAddress, poolAccount);
        if (!poolState) throw new Error('Failed to parse whirlpool account');

        const tickCurrent = poolState.tickCurrentIndex || poolState.currentTickIndex || 0;
        const tickSpacing = poolState.tickSpacing || Number(pool.tickSpacing ?? 1);
        const sqrtPriceX64 = (poolState.sqrtPrice || poolState.sqrtPriceX64 || '0').toString();
        const liquidity = (poolState.liquidity || '0').toString();

        const tokenVaultA = poolState.tokenVaultA || poolState.tokenVault0 || poolState.vaultA || getVaultAddress(pool, 'x');
        const tokenVaultB = poolState.tokenVaultB || poolState.tokenVault1 || poolState.vaultB || getVaultAddress(pool, 'y');
        const xVault = tokenVaultA?.toBase58?.() || tokenVaultA?.toString?.() || null;
        const yVault = tokenVaultB?.toBase58?.() || tokenVaultB?.toString?.() || null;

        // Build the tick-array PDA list.
        const tickArrayRefs = [];
        for (const offset of CONFIG.WHIRLPOOL_TICK_ARRAY_OFFSETS) {
            try {
                const startIndex = TickUtil.getStartTickIndex(tickCurrent, tickSpacing, offset);
                const pda = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, poolAddress, startIndex);
                tickArrayRefs.push({ startIndex, address: pda.publicKey });
            } catch (_e) {
                // out-of-range offset; ignore.
            }
        }

        // RT2: vaults + tick arrays in a single batch.
        const batchKeys = [];
        if (tokenVaultA) batchKeys.push(asPublicKey(tokenVaultA));
        if (tokenVaultB) batchKeys.push(asPublicKey(tokenVaultB));
        const tickArrayKeyOffset = batchKeys.length;
        for (const ref of tickArrayRefs) batchKeys.push(ref.address);

        const accounts = batchKeys.length
            ? await connection.getMultipleAccountsInfo(batchKeys)
            : [];

        let xReserve = '0';
        let yReserve = '0';
        if (tokenVaultA) {
            const vaultA = accounts[0];
            xReserve = vaultA ? (parseSplTokenAmount(vaultA.data) || '0') : '0';
        }
        if (tokenVaultB) {
            const vaultB = accounts[tokenVaultA ? 1 : 0];
            yReserve = vaultB ? (parseSplTokenAmount(vaultB.data) || '0') : '0';
        }

        const ticks = [];
        const tickArrays = [];
        const tickArrayData = [];
        for (let i = 0; i < tickArrayRefs.length; i += 1) {
            const tickArrayAccount = accounts[tickArrayKeyOffset + i];
            if (!tickArrayAccount) continue;
            try {
                const tickArrayAddress = tickArrayRefs[i].address.toBase58();
                const tickArrayParsed = ParsableTickArray.parse(tickArrayRefs[i].address, tickArrayAccount);
                if (!tickArrayParsed?.ticks) continue;
                tickArrays.push(tickArrayAddress);
                tickArrayData.push(buildStructuredTickArrayData(
                    tickArrayAddress,
                    tickArrayRefs[i].startIndex,
                    tickArrayParsed.ticks,
                ));

                for (let j = 0; j < tickArrayParsed.ticks.length; j += 1) {
                    const tick = tickArrayParsed.ticks[j];
                    if (!tick?.initialized || !tick.liquidityGross || tick.liquidityGross.lte(new BN(0))) continue;
                    ticks.push({
                        index: tickArrayRefs[i].startIndex + j,
                        initialized: true,
                        liquidityNet: tick.liquidityNet?.toString?.() || '0',
                        liquidityGross: tick.liquidityGross.toString(),
                    });
                }
            } catch (_error) {
                // Skip malformed tick array; keep going.
            }
        }
        ticks.sort((a, b) => a.index - b.index);

        return {
            sqrtPriceX64,
            sqrtPrice: sqrtPriceX64.toString(),
            tickCurrent,
            tickSpacing,
            liquidity,
            tickArrays,
            tickArrayData,
            remainingAccounts: tickArrays,
            ticks,
            tickCount: ticks.length,
            hasRealTicks: ticks.length > 0,
            tickStrategy: ticks.length > 0 ? 'rpc-live' : 'rpc-state-only',
            xVault,
            yVault,
            vaults: { xVault, yVault },
            xReserve,
            yReserve,
            hasReserves: xReserve !== '0' && yReserve !== '0',
            aux: {
                whirlpool: {
                    sqrtPriceX64,
                    tickCurrent,
                    tickSpacing,
                    liquidity,
                    tickArrays: tickArrayData,
                    ticks,
                },
            },
            enriched: true,
        };
    } catch (error) {
        return {
            ...buildApproxWhirlpoolEnrichment(pool),
            liveError: error.message,
        };
    }
}

/* -------------------------------------------------------------------------- */
/*                            CLMM enrichment                                 */
/* -------------------------------------------------------------------------- */

/**
 * CLMM enrichment in 3 round trips:
 *   RT1 — pool account
 *   RT2 — vaults batch
 *   RT3 — tick arrays batch
 *
 * Could be folded to 2 RTs by combining RT2+RT3 (same pattern as Whirlpool),
 * left at 3 because the order of vault addresses is determined from the pool
 * state, and combining adds one extra dependency on parsing the pool first.
 * The downstream concurrency already covers it.
 */
async function enrichCLMM(pool, connection) {
    if (!connection) {
        return { hasReserves: false, enriched: false, error: 'CLMM enrichment requires an RPC connection' };
    }

    try {
        const poolAddress = new PublicKey(pool.address || pool.poolAddress);

        const account = await connection.getAccountInfo(poolAddress);
        if (!account) throw new Error('Pool account not found');

        const raydiumClmmProgramId = account.owner;
        const poolState = RaydiumClmmPoolInfoLayout.decode(account.data);
        const sqrtPriceX64 = poolState.sqrtPriceX64?.toString?.() || String(poolState.sqrtPriceX64 || pool.sqrtPriceX64 || '0');
        const liquidity = poolState.liquidity?.toString?.() || String(poolState.liquidity || pool.liquidity || '0');
        const tickCurrent = Number(poolState.tickCurrent ?? pool.tickCurrent ?? 0);
        const tickSpacing = Number(poolState.tickSpacing ?? pool.tickSpacing ?? 1);

        let xReserve = String(pool.xReserve || pool.reserves?.x || '0');
        let yReserve = String(pool.yReserve || pool.reserves?.y || '0');
        const xVaultRaw = poolState.vaultA || getVaultAddress(pool, 'x');
        const yVaultRaw = poolState.vaultB || getVaultAddress(pool, 'y');
        const xVault = xVaultRaw?.toBase58?.() || xVaultRaw?.toString?.() || null;
        const yVault = yVaultRaw?.toBase58?.() || yVaultRaw?.toString?.() || null;

        // Build tick-array PDAs.
        const tickArraySpan = tickSpacing * 60;
        const currentStartIndex = RaydiumTickArrayUtil.getTickArrayStartIndex(tickCurrent, tickSpacing);
        const startIndexes = CONFIG.CLMM_TICK_ARRAY_OFFSETS.map((offset) => currentStartIndex + offset * tickArraySpan);
        const tickArrayRefs = startIndexes.map((startIndex) => ({
            startIndex,
            address: getRaydiumClmmTickArrayAddress(raydiumClmmProgramId, poolAddress, startIndex).publicKey,
        }));

        // Single combined batch: vaults + tick arrays.
        const batchKeys = [];
        if (xVault) batchKeys.push(new PublicKey(xVault));
        if (yVault) batchKeys.push(new PublicKey(yVault));
        const tickOffset = batchKeys.length;
        for (const ref of tickArrayRefs) batchKeys.push(ref.address);

        const accounts = batchKeys.length
            ? await connection.getMultipleAccountsInfo(batchKeys).catch(() => [])
            : [];

        if (xVault) {
            const vaultA = accounts[0];
            xReserve = vaultA ? (parseSplTokenAmount(vaultA.data) || xReserve) : xReserve;
        }
        if (yVault) {
            const vaultB = accounts[xVault ? 1 : 0];
            yReserve = vaultB ? (parseSplTokenAmount(vaultB.data) || yReserve) : yReserve;
        }

        const ticks = [];
        const tickArrays = [];
        const tickArrayData = [];
        for (let i = 0; i < tickArrayRefs.length; i += 1) {
            const accountInfo = accounts[tickOffset + i];
            if (!accountInfo) continue;
            try {
                const decoded = RaydiumClmmTickArrayLayout.decode(accountInfo.data);
                const tickArrayAddress = tickArrayRefs[i].address.toBase58();
                const startIndex = Number(decoded.startTickIndex ?? tickArrayRefs[i].startIndex);
                tickArrays.push(tickArrayAddress);
                tickArrayData.push(buildStructuredTickArrayData(tickArrayAddress, startIndex, decoded.ticks));

                for (let j = 0; j < decoded.ticks.length; j += 1) {
                    const tick = decoded.ticks[j];
                    const liquidityGross = tick?.liquidityGross?.toString?.() || String(tick?.liquidityGross || '0');
                    if (liquidityGross === '0') continue;
                    ticks.push({
                        tickIndex: Number(tick?.tick ?? (startIndex + (j * tickSpacing))),
                        index: Number(tick?.tick ?? (startIndex + (j * tickSpacing))),
                        liquidityNet: tick?.liquidityNet?.toString?.() || '0',
                        liquidityGross,
                        initialized: true,
                    });
                }
            } catch (_error) {
                // Skip malformed tick-array account.
            }
        }
        ticks.sort((left, right) => left.tickIndex - right.tickIndex);

        const hasReserves = xReserve !== '0' && yReserve !== '0';
        const hasRealTicks = ticks.length > 0;

        return {
            sqrtPriceX64,
            sqrtPrice: sqrtPriceX64,
            liquidity,
            tickCurrent,
            tickSpacing,
            tickArrays,
            tickArrayData,
            remainingAccounts: tickArrays,
            ticks,
            tickCount: ticks.length,
            hasRealTicks,
            tickStrategy: hasRealTicks ? 'rpc-live' : 'rpc-state-only',
            xVault,
            yVault,
            vaults: { xVault, yVault },
            xReserve,
            yReserve,
            hasReserves,
            aux: {
                clmm: {
                    sqrtPriceX64,
                    tickCurrent,
                    tickSpacing,
                    liquidity,
                    tickArrays,
                    tickArrayData,
                    ticks,
                },
            },
            enriched: true,
        };
    } catch (error) {
        return { hasReserves: false, enriched: false, error: error.message };
    }
}

/* -------------------------------------------------------------------------- */
/*                            DLMM enrichment                                 */
/* -------------------------------------------------------------------------- */

function getPriceFromBinId(binId, binStep) {
    // P = (1 + binStep/10000)^binId — DLMM canonical bin price formula.
    const base = 1 + binStep / 10000;
    return Math.pow(base, binId);
}

function priceToQ64(price) {
    const scale = 2n ** 64n;
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return '0';
    return BigInt(Math.floor(priceNum * Number(scale))).toString();
}

function normalizeDlmmBinForOutput(bin, fallbackFeeBps = 25) {
    const xAmount = String(bin.xAmount || bin.x_amount || bin.reserveA || bin.amount_x || '0');
    const yAmount = String(bin.yAmount || bin.y_amount || bin.reserveB || bin.amount_y || '0');
    const binId = Number(bin.binId ?? bin.bin_id ?? bin.id ?? 0);
    const fallbackPrice = bin.price ?? (
        Number.isFinite(bin.binStep) || Number.isFinite(bin.bin_step)
            ? getPriceFromBinId(binId, Number(bin.binStep ?? bin.bin_step ?? 0))
            : null
    );
    const fallbackPxQ64 = bin.priceAB_Q64 || bin.pxAB_Q64
        || (fallbackPrice != null ? priceToQ64(fallbackPrice) : null);

    return {
        binId,
        price: fallbackPrice,
        pxAB_Q64: fallbackPxQ64,
        priceAB_Q64: fallbackPxQ64,
        reserveA: xAmount,
        reserveB: yAmount,
        xAmount,
        yAmount,
        liquidity: String(bin.liquidity || (BigInt(xAmount) + BigInt(yAmount)).toString()),
        feeBps: Number(bin.feeBps || fallbackFeeBps),
    };
}

function deriveBinArrayPubkey(lbPair, index) {
    // Wrapper around binArray_util's deriveBinArray that returns just the key,
    // for parity with the previous local helper.
    const [pubkey] = deriveBinArray(lbPair, index, DLMM_PROGRAM_ID);
    return pubkey;
}

function buildDlmmWalkIndexes(activeArrayIndex, maxArrays = CONFIG.DLMM_LIVE_WALK_ARRAYS) {
    const out = [activeArrayIndex];
    for (let distance = 1; out.length < maxArrays; distance += 1) {
        out.push(activeArrayIndex + distance);
        if (out.length >= maxArrays) break;
        out.push(activeArrayIndex - distance);
    }
    return out;
}

function decodeDlmmBinArray(accountInfo, binArrayPubkey, binArrayIndex, binStep, fallbackFeeBps = 25) {
    if (!accountInfo?.data) return null;
    const decoded = dlmmCoder.decode('BinArray', accountInfo.data);
    const rawBins = decoded?.bins || [];
    const bins = [];

    for (let j = 0; j < rawBins.length; j += 1) {
        const bin = rawBins[j];
        const xAmount = bin?.amount_x?.toString?.() || bin?.xAmount?.toString?.() || '0';
        const yAmount = bin?.amount_y?.toString?.() || bin?.yAmount?.toString?.() || '0';
        if (xAmount === '0' && yAmount === '0') continue;
        const binId = (binArrayIndex * MAX_BIN_ARRAY_SIZE) + j;
        bins.push(normalizeDlmmBinForOutput({
            binId,
            xAmount,
            yAmount,
            liquidity: bin?.liquidity_supply?.toString?.()
                || bin?.liquidity?.toString?.()
                || (BigInt(xAmount) + BigInt(yAmount)).toString(),
            binStep,
            price: getPriceFromBinId(binId, binStep),
        }, fallbackFeeBps));
    }

    return {
        binArray: {
            address: binArrayPubkey.toBase58(),
            index: binArrayIndex,
            binStep,
            bins,
            live: true,
        },
        bins,
    };
}

async function walkDlmmLiveBinArrays(connection, poolAddress, activeBinId, binStep, feeBps = 25) {
    const activeArrayIndex = binIdToBinArrayIndex(activeBinId);
    const indexes = buildDlmmWalkIndexes(activeArrayIndex);
    const batchSize = CONFIG.DLMM_LIVE_WALK_BATCH_SIZE;
    const binArrays = [];
    const bins = [];
    const touchedIndexes = [];
    // Count POPULATED arrays strictly on each side of active. The old code used
    // foundLeft/foundRight booleans that the active array tripped on its own (<=/>=),
    // so the walk broke after the first batch (~6 arrays) no matter that 24 were
    // configured — starving the quote of book depth and under-filling the swap.
    const MIN_SIDE_ARRAYS = Math.max(1, Number(process.env.DLMM_MIN_SIDE_ARRAYS || 3));
    let leftPopulated = 0;
    let rightPopulated = 0;
    let activePopulated = false;

    for (let i = 0; i < indexes.length; i += batchSize) {
        const batchIndexes = indexes.slice(i, i + batchSize);
        const batchPubkeys = batchIndexes.map((idx) => deriveBinArrayPubkey(poolAddress, idx));
        const accounts = await connection.getMultipleAccountsInfo(batchPubkeys).catch(() => []);

        for (let j = 0; j < batchIndexes.length; j += 1) {
            const idx = batchIndexes[j];
            const pubkey = batchPubkeys[j];
            if (!pubkey) continue;
            touchedIndexes.push(idx);
            try {
                const decoded = decodeDlmmBinArray(accounts[j], pubkey, idx, binStep, feeBps);
                if (!decoded) continue;
                binArrays.push(decoded.binArray);
                bins.push(...decoded.bins);
                if (decoded.bins.length > 0) {
                    if (idx < activeArrayIndex) leftPopulated += 1;
                    else if (idx > activeArrayIndex) rightPopulated += 1;
                    else activePopulated = true;
                }
            } catch (_e) {
                // Missing or incompatible bin arrays are normal while walking outward.
            }
        }

        // Stop only once we have genuine depth on BOTH sides of active (or the loop
        // exhausts the configured maxArrays window). This is what actually bounds the
        // swap's price walk; the active array alone is not enough.
        if (bins.length > 0 && leftPopulated >= MIN_SIDE_ARRAYS && rightPopulated >= MIN_SIDE_ARRAYS) break;
    }

    return {
        activeArrayIndex,
        touchedIndexes,
        binArrays,
        bins: bins.sort((a, b) => a.binId - b.binId),
        foundLeft: leftPopulated > 0 || activePopulated,
        foundRight: rightPopulated > 0 || activePopulated,
        leftPopulated,
        rightPopulated,
    };
}

/**
 * DLMM enrichment:
 *   RT1 — pair account (active_id, bin_step)
 *   RT2+ — live-walk bin arrays around active_id, then fetch vaults
 */
async function enrichDLMM(pool, connection) {
    try {
        let activeBinId = Number(pool.activeBinId || pool.activeId || 0);
        let binStep = Number(pool.binStep || 0);
        let bins = [];
        let binArrays = [];
        let liveBinWalk = null;
        let xVault = getVaultAddress(pool, 'x');
        let yVault = getVaultAddress(pool, 'y');

        if (connection) {
            const poolAddress = new PublicKey(pool.address || pool.poolAddress);

            // RT1: pair account
            const pairAccount = await connection.getAccountInfo(poolAddress).catch(() => null);
            if (pairAccount && dlmmCoder) {
                try {
                    const lbPair = dlmmCoder.decode('LbPair', pairAccount.data);
                    if (lbPair) {
                        activeBinId = lbPair.active_id !== undefined ? Number(lbPair.active_id) : activeBinId;
                        binStep = lbPair.bin_step !== undefined ? Number(lbPair.bin_step) : binStep;
                        xVault = lbPair.reserve_x?.toBase58?.() || lbPair.reserve_x?.toString?.() || xVault;
                        yVault = lbPair.reserve_y?.toBase58?.() || lbPair.reserve_y?.toString?.() || yVault;
                    }
                } catch (_e) {
                    // Borsh decode failed — keep the input values and proceed.
                }
            }

            liveBinWalk = await walkDlmmLiveBinArrays(connection, poolAddress, activeBinId, binStep, pool.feeBps || 25);
            binArrays = liveBinWalk.binArrays;
            bins = liveBinWalk.bins;

            // Pull vault reserves.
            let xReserveLive = null;
            let yReserveLive = null;
            const vaultKeys = [xVault, yVault].filter(Boolean).map(asPublicKey);
            const vaultAccounts = vaultKeys.length
                ? await connection.getMultipleAccountsInfo(vaultKeys).catch(() => [])
                : [];
            if (xVault) xReserveLive = vaultAccounts[0] ? parseSplTokenAmount(vaultAccounts[0].data) : null;
            if (yVault) {
                const yIndex = xVault ? 1 : 0;
                yReserveLive = vaultAccounts[yIndex] ? parseSplTokenAmount(vaultAccounts[yIndex].data) : null;
            }

            // Stash for the assembler below.
            pool.__dlmmLiveReserveX = xReserveLive;
            pool.__dlmmLiveReserveY = yReserveLive;
        }

        const hasLiveBins = bins.length > 0;

        if (bins.length === 0) {
            // Use binArray_util.normalizeBins to populate from input data only.
            const normalizedRawBins = normalizeBins(pool.bins || [], binStep, activeBinId);
            bins = normalizedRawBins
                .map((bin) => normalizeDlmmBinForOutput(bin, pool.feeBps || 25))
                .sort((a, b) => a.binId - b.binId);
        }

        if (binArrays.length === 0) {
            const derivedBinRange = getBinRangeFromActiveId(activeBinId, binStep);
            const sourceBinArrays = Array.isArray(pool.binArrays)
                ? pool.binArrays
                : getBinArraysRequiredByPositionRange(
                    pool.address || pool.poolAddress || pool.id,
                    derivedBinRange.min,
                    derivedBinRange.max,
                    DLMM_PROGRAM_ID,
                );
            binArrays = normalizeBinArrays(sourceBinArrays, binStep, activeBinId);
        }

        const derivedBinRange = getBinRangeFromActiveId(activeBinId, binStep);

        const xReserve = pool.__dlmmLiveReserveX
            || String(pool.xReserve || pool.reserves?.x || '0');
        const yReserve = pool.__dlmmLiveReserveY
            || String(pool.yReserve || pool.reserves?.y || '0');
        delete pool.__dlmmLiveReserveX;
        delete pool.__dlmmLiveReserveY;

        const hasBins = bins.length > 0;
        const hasReserves = xReserve !== '0' && yReserve !== '0';
        const hasBinState = hasBins || binArrays.length > 0;

        return {
            bins,
            binCount: bins.length,
            hasRealBins: hasLiveBins,
            binSource: hasLiveBins ? 'rpc-live-walk' : (hasBins ? 'input-fallback' : 'none'),
            liveBinWalk,
            activeBinId,
            binStep,
            binArrays,
            binRange: derivedBinRange,

            xReserve,
            yReserve,
            hasReserves,
            xVault,
            yVault,
            vaults: { xVault, yVault },

            aux: {
                dlmm: {
                    bins,
                    binArrays,
                    binRange: derivedBinRange,
                    activeBinId,
                    binStep,
                },
            },

            quoteSource: hasLiveBins ? 'sdk' : (pool.quoteSource || 'sdk'),
            isMathReady: hasBinState,
            enriched: hasBinState,
        };
    } catch (error) {
        return {
            hasRealBins: false,
            hasReserves: false,
            enriched: false,
            error: error.message,
        };
    }
}

/* -------------------------------------------------------------------------- */
/*                            CPMM enrichment                                 */
/* -------------------------------------------------------------------------- */

/**
 * CPMM enrichment in 2 round trips when vaults are pre-known, 3 otherwise:
 *   RT1 — pool account (to discover programId + vaults if not already cached)
 *   RT2 — vaults batch
 */
async function enrichCPMM(pool, connection) {
    try {
        const pancakeSwap = isPancakeSwapPool(pool);
        let xReserve = String(pool.xReserve || pool.reserves?.x || '0');
        let yReserve = String(pool.yReserve || pool.reserves?.y || '0');
        let xVault = getVaultAddress(pool, 'x');
        let yVault = getVaultAddress(pool, 'y');
        let programId = String(pool.programId || pool._raw?.programId || '');
        let reserveSource = String(pool.reserveSource || (pancakeSwap ? 'bitquery_pool' : 'input-reserves'));
        let liveVaults = false;
        let stableAmm = programId === CONFIG.RAYDIUM_AMM_STABLE;

        if (connection) {
            const poolAddress = new PublicKey(pool.address || pool.poolAddress);
            const account = await connection.getAccountInfo(poolAddress).catch(() => null);
            if (account) {
                programId = account.owner?.toBase58?.() || account.owner?.toString?.() || programId;
                stableAmm = programId === CONFIG.RAYDIUM_AMM_STABLE;
                if (programId === CONFIG.RAYDIUM_AMM_V4) {
                    const poolState = liquidityStateV4Layout.decode(account.data);
                    xVault = poolState?.baseVault?.toBase58?.() || poolState?.baseVault?.toString?.() || xVault;
                    yVault = poolState?.quoteVault?.toBase58?.() || poolState?.quoteVault?.toString?.() || yVault;
                } else if (stableAmm) {
                    const poolState = liquidityStateV5Layout.decode(account.data);
                    xVault = poolState?.baseVault?.toBase58?.() || poolState?.baseVault?.toString?.() || xVault;
                    yVault = poolState?.quoteVault?.toBase58?.() || poolState?.quoteVault?.toString?.() || yVault;
                } else if (programId === CONFIG.RAYDIUM_CPMM) {
                    const poolState = CpmmPoolInfoLayout.decode(account.data);
                    xVault = poolState?.vaultA?.toBase58?.() || poolState?.vaultA?.toString?.() || xVault;
                    yVault = poolState?.vaultB?.toBase58?.() || poolState?.vaultB?.toString?.() || yVault;
                }
            }

            if (xVault && yVault) {
                // Single batched vault fetch instead of two parallel single calls.
                const vaults = await connection.getMultipleAccountsInfo(
                    [new PublicKey(xVault), new PublicKey(yVault)],
                ).catch(() => []);
                const nextXReserve = vaults[0] ? parseSplTokenAmount(vaults[0].data) : null;
                const nextYReserve = vaults[1] ? parseSplTokenAmount(vaults[1].data) : null;
                if (nextXReserve && nextYReserve) {
                    xReserve = nextXReserve;
                    yReserve = nextYReserve;
                    reserveSource = 'rpc-live-vaults';
                    liveVaults = true;
                }
            }
        }

        const hasReserves = xReserve !== '0' && yReserve !== '0';
        const hasPrice = hasUsablePoolPrice(pool);
        const enriched = liveVaults || hasReserves || hasPrice;

        return {
            xReserve,
            yReserve,
            reserves: { ...(pool.reserves || {}), x: xReserve, y: yReserve },
            xVault,
            yVault,
            vaults: { xVault, yVault },
            programId: programId || null,
            hasReserves,
            reserveSource,
            quoteSource: stableAmm ? 'raydium-stable-rpc-live' : (pancakeSwap ? 'native-reserves' : (pool.quoteSource || 'native-reserves')),
            currentPrice: pool.currentPrice,
            midPrice: pool.midPrice ?? pool.currentPrice,
            price: pool.price ?? pool.midPrice ?? pool.currentPrice,
            feeBps: pool.feeBps || 25,
            isMathReady: enriched,
            enriched,
        };
    } catch (error) {
        return { hasReserves: false, enriched: false, error: error.message };
    }
}

/* -------------------------------------------------------------------------- */
/*                              Orchestrator                                  */
/* -------------------------------------------------------------------------- */

const EMPTY_STATS = () => ({
    whirlpool: { total: 0, success: 0, reservesOk: 0, livePath: 0, approxPath: 0, realTicks: 0 },
    clmm: { total: 0, success: 0, reservesOk: 0, livePath: 0, approxPath: 0, realTicks: 0 },
    cpmm: { total: 0, success: 0, reservesOk: 0, raydiumTotal: 0 },
    dlmm: { total: 0, success: 0, reservesOk: 0, realBins: 0, approxPath: 0, },
    damm_v2: { total: 0, success: 0, reservesOk: 0, realBins: 0, approxPath: 0, },
    pumpswap: { total: 0, success: 0, reservesOk: 0, pumpswapTotal: 0, pumpswapSuccess: 0, pumpswapReservesOk: 0 },
    amm: { total: 0, success: 0, reservesOk: 0, pancakeTotal: 0, pancakeSuccess: 0, pancakeReservesOk: 0 },
});

function markTrustedCanonicalStats(stats, type, pool, diag) {
    if (!stats || !type || !stats[type]) return;
    const bucket = stats[type];
    bucket.total += 1;
    bucket.success += 1;
    if (diag?.reservesOk) bucket.reservesOk += 1;

    if (type === 'amm' && isPancakeSwapPool(pool)) {
        bucket.pancakeTotal += 1;
        bucket.pancakeSuccess += 1;
        if (diag?.reservesOk) bucket.pancakeReservesOk += 1;
    }
    if (type === 'pumpswap' && isPumpswapPool(pool)) {
        bucket.pumpswapTotal = (bucket.pumpswapTotal || 0) + 1;
        bucket.pumpswapSuccess = (bucket.pumpswapSuccess || 0) + 1;
        if (diag?.reservesOk) bucket.pumpswapReservesOk = (bucket.pumpswapReservesOk || 0) + 1;
    }
}

async function enrichOnePool(pool, connection, stats) {
    const type = resolvePoolType(pool);
    const poolId = pool.address || pool.poolAddress || pool.id || 'unknown';
    const shortPoolId = String(poolId).slice(0, 8);
    const dex = pool.dex || 'unknown-dex';

    // Fast path: trust pre-canonicalized input.
    if (isFreshCanonicalInput(pool) && pool.enriched === true) {
        const wired = wireCanonicalAndAux(pool, {});
        Object.assign(pool, wired);
        const diag = buildEnrichmentDiagnosticsEntry(pool);
        if (diag.executionReady) {
            markTrustedCanonicalStats(stats, type, pool, diag);
            console.log(`[skip] ${dex}/${type} ${shortPoolId} ↪ trusted canonical input, ready=YES`);
            return;
        }
    }

    let enrichment;
    try {
        switch (type) {
            case 'whirlpool':
                stats.whirlpool.total++;
                enrichment = await enrichWhirlpool(pool, connection);
                if (enrichment.enriched) {
                    stats.whirlpool.success++;
                    if (enrichment.hasReserves) stats.whirlpool.reservesOk++;
                    if (enrichment.hasRealTicks) stats.whirlpool.realTicks++;
                    if (enrichment.tickStrategy === 'adapter-approximation') stats.whirlpool.approxPath++;
                    else stats.whirlpool.livePath++;
                }

                break;
            case 'cpmm':
                stats.cpmm.total++;
                enrichment = await enrichCPMM(pool, connection);
                if (enrichment.enriched) {
                    stats.cpmm.success++;
                    if (enrichment.hasReserves) stats.cpmm.reservesOk++;
                }
                break;
            case 'clmm':
                stats.clmm.total++;
                enrichment = await enrichCLMM(pool, connection);
                if (enrichment.enriched) {
                    stats.clmm.success++;
                    if (enrichment.hasReserves) stats.clmm.reservesOk++;
                    if (enrichment.hasRealTicks) stats.clmm.realTicks++;
                    if (enrichment.tickStrategy === 'adapter-approximation') stats.clmm.approxPath++;
                    else stats.clmm.livePath++;
                }
                break;
            case 'dlmm':
                stats.dlmm.total++;
                enrichment = await enrichDLMM(pool, connection);
                if (enrichment.enriched) {
                    stats.dlmm.success++;
                    if (enrichment.hasReserves) stats.dlmm.reservesOk++;
                    if (enrichment.hasRealBins) stats.dlmm.realBins++;
                }
                break;
            case 'amm':
                stats.amm.total++;
                if (isPancakeSwapPool(pool)) stats.amm.pancakeTotal++;
                enrichment = await enrichReservesOnly(pool, connection, 'pancakeswap');
                if (enrichment.enriched) {
                    stats.amm.success++;
                    if (enrichment.hasReserves) stats.amm.reservesOk++;
                    if (isPancakeSwapPool(pool)) {
                        stats.amm.pancakeSuccess++;
                        if (enrichment.hasReserves) stats.amm.pancakeReservesOk++;
                    }
                }
                break;
            case 'goosefx':
            case 'damm_v2':
            case 'pumpswap': {
                stats[type] = stats[type] || { total: 0, success: 0, reservesOk: 0 };
                stats[type].total++;
                if (isPumpswapPool(pool)) stats.pumpswap.pumpswapTotal++;
                enrichment = await enrichReservesOnly(pool, connection, type);
                if (enrichment.enriched) {
                    stats[type].success++;
                    if (enrichment.hasReserves) stats[type].reservesOk++;
                    if (isPumpswapPool(pool)) {
                        stats.pumpswap.pumpswapSuccess = (stats.pumpswap.pumpswapSuccess || 0) + 1;
                        if (enrichment.hasReserves) stats.pumpswap.pumpswapReservesOk = (stats.pumpswap.pumpswapReservesOk || 0) + 1;
                    }
                }
                break;
            }
            default:
                console.log(`[skip] unknown pool type: ${type}`);
                return;
        }

        const wired = wireCanonicalAndAux(pool, enrichment);
        Object.assign(pool, wired);

        const diag = buildEnrichmentDiagnosticsEntry(pool);
        const blockersLabel = diag.blockers.length ? diag.blockers.join(', ') : 'none';
        const status = diag.executionReady ? '✓' : '·';
        console.log(
            `${status} ${dex}/${type} ${shortPoolId} `
            + `ready=${diag.executionReady ? 'YES' : 'NO'} `
            + `reserves=${diag.reservesOk ? 'OK' : 'MISS'} `
            + `tickArrays=${diag.tickArrayCount}/${diag.structuredTickArrayCount} `
            + `ticks=${diag.tickCount} bins=${diag.binCount} `
            + `blockers=${blockersLabel}`,
        );
    } catch (error) {
        console.log(`✗ ${dex}/${type} ${shortPoolId}: ${error.message}`);
        pool.error = error.message;
        pool.enriched = false;
    }
}


function enrichmentCacheKey(pool = {}) {
    const address = String(pool.address || pool.poolAddress || pool.id || '').trim();
    if (!address) return null;
    return `${resolvePoolType(pool) || 'unknown'}:${address}`;
}

function buildUniqueEnrichmentWorkset(pools = [], options = {}) {
    const dedupe = options.dedupe !== false;
    if (!dedupe) {
        return {
            uniquePools: pools,
            aliasesByKey: new Map(),
            dedupedCount: 0,
        };
    }

    const firstByKey = new Map();
    const aliasesByKey = new Map();
    const uniquePools = [];

    for (const pool of pools) {
        const key = enrichmentCacheKey(pool);
        if (!key) {
            uniquePools.push(pool);
            continue;
        }

        if (!firstByKey.has(key)) {
            firstByKey.set(key, pool);
            aliasesByKey.set(key, []);
            uniquePools.push(pool);
            continue;
        }

        aliasesByKey.get(key).push(pool);
    }

    return {
        uniquePools,
        aliasesByKey,
        dedupedCount: pools.length - uniquePools.length,
    };
}

function copyEnrichedAliases(uniquePools = [], aliasesByKey = new Map()) {
    for (const source of uniquePools) {
        const key = enrichmentCacheKey(source);
        if (!key || !aliasesByKey.has(key)) continue;

        for (const alias of aliasesByKey.get(key)) {
            const preserved = {
                routeId: alias.routeId,
                routePath: alias.routePath,
                routeIndex: alias.routeIndex,
                triangleIndex: alias.triangleIndex,
                legIndex: alias.legIndex,
                label: alias.label,
                pairLabel: alias.pairLabel,
            };
            Object.assign(alias, source, preserved);
        }
    }
}

function isConnectionLike(connection) {
    return Boolean(connection && typeof connection === 'object' && (
        typeof connection.getAccountInfo === 'function'
        || typeof connection.getMultipleAccountsInfo === 'function'
        || typeof connection.getProgramAccounts === 'function'
    ));
}

function normalizeEnrichmentArgs(connection, options = {}) {
    if (connection && !isConnectionLike(connection)) {
        return {
            connection: connection.connection && isConnectionLike(connection.connection)
                ? connection.connection
                : null,
            options: { ...connection, ...options },
        };
    }
    return { connection, options };
}

async function enrichAllPools(pools, connection, options = {}) {
    ({ connection, options } = normalizeEnrichmentArgs(connection, options));
    const concurrency = Math.max(1, Number(options.concurrency || CONFIG.CONCURRENCY));
    console.log(`\n🔄 Enriching ${pools.length} pools (concurrency=${concurrency})...\n`);

    const startedAt = Date.now();
    const stats = EMPTY_STATS();

    // Pre-canonicalize so the wire shape exists even before enrichment data arrives.
    for (let i = 0; i < pools.length; i += 1) {
        const item = pools[i];
        if (!item || typeof item !== 'object') continue;
        Object.assign(item, wireCanonicalAndAux(item, {}));
    }

    const { uniquePools, aliasesByKey, dedupedCount } = buildUniqueEnrichmentWorkset(pools, options);
    if (dedupedCount > 0) {
        console.log(`[dedupe] ${dedupedCount} repeated pool records will reuse enriched state from ${uniquePools.length} unique pools`);
    }

    await processInBatches(uniquePools, async (pool) => {
        await enrichOnePool(pool, connection, stats);
    }, {
        batchSize: concurrency,
        onBatchComplete: ({ batchEnd, total }) => {
            console.log(`[batch] enriched ${batchEnd}/${total} unique pools`);
        },
    });

    copyEnrichedAliases(uniquePools, aliasesByKey);

    const elapsedMs = Date.now() - startedAt;

    console.log('\n═══════════════════════════════════════════════════════════════════════════');
    console.log('📊 ENRICHMENT SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════════════');

    console.log('\nWhirlpool:');
    console.log(`  Total: ${stats.whirlpool.total}`);
    console.log(`  Processed: ${stats.whirlpool.success}`);
    console.log(`  Live path: ${stats.whirlpool.livePath}`);
    console.log(`  Approx path: ${stats.whirlpool.approxPath}`);
    console.log(`  Real ticks: ${stats.whirlpool.realTicks}`);
    console.log(`  Reserves OK: ${stats.whirlpool.reservesOk}`);

    console.log('\nCLMM:');
    console.log(`  Total: ${stats.clmm.total}`);
    console.log(`  Processed: ${stats.clmm.success}`);
    console.log(`  Live path: ${stats.clmm.livePath}`);
    console.log(`  Approx path: ${stats.clmm.approxPath}`);
    console.log(`  Real ticks: ${stats.clmm.realTicks}`);
    console.log(`  Reserves OK: ${stats.clmm.reservesOk}`);

    console.log('\nDLMM:');
    console.log(`  Total: ${stats.dlmm.total}`);
    console.log(`  Processed: ${stats.dlmm.success}`);
    console.log(`  Real bins: ${stats.dlmm.realBins}`);
    console.log(`  Reserves OK: ${stats.dlmm.reservesOk}`);

    console.log('\nCPMM:');
    console.log(`  Total: ${stats.cpmm.total}`);
    console.log(`  Processed: ${stats.cpmm.success}`);
    console.log(`  Reserves OK: ${stats.cpmm.reservesOk}`);
    console.log('\nPancakeSwap AMM:');
    console.log(`  Total: ${stats.amm.pancakeTotal}`);
    console.log(`  Processed: ${stats.amm.pancakeSuccess}`);
    console.log(`  Reserves OK: ${stats.amm.pancakeReservesOk}`);

    for (const t of ['goosefx', 'damm_v2', 'pumpswap']) {
        const s = stats[t];
        if (!s) continue;
        console.log(`\n${t.toUpperCase()}:`);
        console.log(`  Total: ${s.total}`);
        console.log(`  Processed: ${s.success}`);
        console.log(`  Reserves OK: ${s.reservesOk}`);
    }

    const totalSuccess = Object.values(stats).reduce((sum, s) => sum + s.success, 0);
    const totalPools = Object.values(stats).reduce((sum, s) => sum + s.total, 0);

    console.log(`\n✅ Total processed: ${totalSuccess}/${totalPools}  ·  elapsed: ${elapsedMs}ms`);
    console.log('═══════════════════════════════════════════════════════════════════════════\n');

    return pools;
}

/* -------------------------------------------------------------------------- */
/*                                 CLI                                        */
/* -------------------------------------------------------------------------- */

function parseCliArgs(argv) {
    const out = {
        inputPath: 'tradePool/_STABLE_HOP.curated.json', //'01_meta_PF.json',
        outputPath: 'pools/02_ENRICHED.json',
        debugReportPath: null,
        debugSummary: false,
        debugQuotes: false,
        concurrency: CONFIG.CONCURRENCY,
        dropIncomplete: true,
    };

    const positional = [];
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--in=') || arg.startsWith('--input=')) {
            out.inputPath = arg.slice(arg.indexOf('=') + 1);
            continue;
        }
        if (arg.startsWith('--out=') || arg.startsWith('--output=')) {
            out.outputPath = arg.slice(arg.indexOf('=') + 1);
            continue;
        }
        if (arg.startsWith('--debug-report=')) {
            out.debugReportPath = arg.slice('--debug-report='.length) || 'raw_enrichment_diagnostics.json';
            continue;
        }
        if (arg.startsWith('--concurrency=')) {
            out.concurrency = Number(arg.slice('--concurrency='.length)) || out.concurrency;
            continue;
        }
        if (arg === '--in' || arg === '--input') {
            out.inputPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : out.inputPath;
            continue;
        }
        if (arg === '--out' || arg === '--output') {
            out.outputPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : out.outputPath;
            continue;
        }
        if (arg === '--debug-report') {
            out.debugReportPath = argv[i + 1] && !argv[i + 1].startsWith('--')
                ? argv[++i]
                : 'raw_enrichment_diagnostics.json';
            continue;
        }
        if (arg === '--debug-summary') { out.debugSummary = true; continue; }
        if (arg === '--debug-quotes') { out.debugQuotes = true; continue; }
        if (arg === '--drop-incomplete') { out.dropIncomplete = true; continue; }
        if (arg === '--no-drop-incomplete') { out.dropIncomplete = false; continue; }
        if (arg === '--concurrency') {
            out.concurrency = Number(argv[i + 1]) || out.concurrency;
            i += 1;
            continue;
        }
        positional.push(arg);
    }

    if (positional[0]) out.inputPath = positional[0];
    if (positional[1]) out.outputPath = positional[1];
    if (!out.debugReportPath && process.env.ENRICHMENT_DEBUG_REPORT) {
        out.debugReportPath = process.env.ENRICHMENT_DEBUG_REPORT;
    }
    if (!out.debugSummary && process.env.ENRICHMENT_DEBUG_SUMMARY === '1') out.debugSummary = true;
    if (!out.debugQuotes && process.env.ENRICHMENT_DEBUG_QUOTES === '1') out.debugQuotes = true;
    if (process.env.ENRICH_DROP_INCOMPLETE === '1') out.dropIncomplete = true;
    if (process.env.ENRICH_DROP_INCOMPLETE === '0') out.dropIncomplete = false;

    return out;
}


function extractPoolsFromInput(rawInput) {
    if (Array.isArray(rawInput)) return rawInput;
    if (Array.isArray(rawInput?.runtime?.pools)) return rawInput.runtime.pools;
    if (Array.isArray(rawInput?.runtime?.chainPools)) return rawInput.runtime.chainPools;
    if (Array.isArray(rawInput?.runtime?.hotSet?.pools)) return rawInput.runtime.hotSet.pools;
    if (Array.isArray(rawInput?.hotSet?.pools)) return rawInput.hotSet.pools;
    if (Array.isArray(rawInput?.routePrep?.pools)) return rawInput.routePrep.pools;
    if (Array.isArray(rawInput?.routePrep?.chainPools)) return rawInput.routePrep.chainPools;
    if (Array.isArray(rawInput?.pools)) return rawInput.pools;
    if (Array.isArray(rawInput?.data)) return rawInput.data;
    // Support output from _diagnose_pools2.js which writes { summary, details, filteredPools }
    if (Array.isArray(rawInput?.filteredPools)) return rawInput.filteredPools;
    if (rawInput?.poolShape && typeof rawInput.poolShape === 'object') {
        return [{
            ...rawInput.poolShape,
            address: rawInput.poolShape.address || rawInput.poolShape.poolAddress || rawInput.poolAddress,
            poolAddress: rawInput.poolShape.poolAddress || rawInput.poolShape.address || rawInput.poolAddress,
        }];
    }
    if (rawInput && typeof rawInput === 'object' && (rawInput.address || rawInput.poolAddress || rawInput.id)) {
        return [rawInput];
    }
    return [];
}

function withFreshOutputStamp(payload = {}) {
    return {
        ...payload,
        generatedAt: new Date().toISOString(),
        enrichedAt: new Date().toISOString(),
    };
}

function normalizeRouteArray(route) {
    if (Array.isArray(route)) return route;
    if (Array.isArray(route?.legs)) return route.legs;
    if (Array.isArray(route?.route)) return route.route;
    if (Array.isArray(route?.pools)) return route.pools;
    return null;
}

function looksLikeHotRoute(route) {
    const legs = normalizeRouteArray(route);
    return Array.isArray(legs) && legs.length >= 2 && legs.every((leg) => (
        leg && typeof leg === 'object' && (leg.poolAddress || leg.address || leg.id)
    ));
}

function collectChainRoutesFromPayload(payload = {}) {
    const out = [];
    const seen = new Set();
    const addRoute = (route) => {
        const legs = normalizeRouteArray(route);
        if (!Array.isArray(legs) || legs.length < 2) return;
        const sig = legs.map((leg) => poolRecordKey(leg?.pool || leg) || '').join('>');
        if (!sig || seen.has(sig)) return;
        seen.add(sig);
        out.push(Array.isArray(route) ? route : legs);
    };

    [
        payload?.routePrep?.chainRoutes,
        payload?.chainRoutes,
        payload?.routes,
        payload?.ROUTES,
        payload?.runtime?.chainRoutes,
        payload?.runtime?.routes,
        payload?.runtime?.hotSet?.chainRoutes,
        payload?.hotSet?.chainRoutes,
    ].forEach((routes) => {
        if (Array.isArray(routes)) routes.forEach(addRoute);
    });

    const pools = extractPoolsFromInput(payload);
    const poolByKey = new Map(pools.map((pool) => [poolRecordKey(pool), pool]).filter(([key]) => key));
    const materializeTriangle = (triangle = {}) => {
        if (!triangle || typeof triangle !== 'object') return null;
        if (Array.isArray(triangle.chainRoutes) && triangle.chainRoutes.length) {
            triangle.chainRoutes.forEach(addRoute);
            return null;
        }
        if (looksLikeHotRoute(triangle.legs)) return triangle.legs;
        if (looksLikeHotRoute(triangle.route)) return triangle.route;
        if (looksLikeHotRoute(triangle.pools)) return triangle.pools;

        const tokenA = triangle.tokenA || triangle.base || triangle.path?.[0];
        const tokenB = triangle.tokenB || triangle.B || triangle.path?.[1];
        const tokenC = triangle.tokenC || triangle.C || triangle.path?.[2];
        const refs = [
            triangle.poolAB || triangle.leg1 || poolByKey.get(triangle.selectedPoolAB),
            triangle.poolBC || triangle.leg2 || poolByKey.get(triangle.selectedPoolBC),
            triangle.poolCA || triangle.leg3 || poolByKey.get(triangle.selectedPoolCA),
        ];
        if (!tokenA || !tokenB || !tokenC || refs.some((leg) => !leg || typeof leg !== 'object')) return null;
        return [
            { ...refs[0], legIndex: 1, tokenInMint: refs[0].tokenInMint || tokenA, tokenOutMint: refs[0].tokenOutMint || tokenB },
            { ...refs[1], legIndex: 2, tokenInMint: refs[1].tokenInMint || tokenB, tokenOutMint: refs[1].tokenOutMint || tokenC },
            { ...refs[2], legIndex: 3, tokenInMint: refs[2].tokenInMint || tokenC, tokenOutMint: refs[2].tokenOutMint || tokenA },
        ];
    };

    [
        payload?.routePrep?.triangles,
        payload?.triangles,
        payload?.runtime?.triangles,
        payload?.runtime?.hotSet?.triangles,
        payload?.hotSet?.triangles,
    ].forEach((triangles) => {
        if (!Array.isArray(triangles)) return;
        for (const triangle of triangles) {
            const route = materializeTriangle(triangle);
            if (route) addRoute(route);
        }
    });

    return out;
}

function collectTrianglesFromPayload(payload = {}) {
    const out = [];
    for (const triangles of [
        payload?.routePrep?.triangles,
        payload?.triangles,
        payload?.runtime?.triangles,
        payload?.runtime?.hotSet?.triangles,
        payload?.hotSet?.triangles,
    ]) {
        if (Array.isArray(triangles)) out.push(...triangles);
    }
    return out;
}

function attachHotSetHandoff(payload = {}, rawInput = {}, pools = []) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

    const chainRoutes = collectChainRoutesFromPayload(payload);
    const triangles = collectTrianglesFromPayload(payload);
    const next = { ...payload };

    if (chainRoutes.length) {
        next.chainRoutes = chainRoutes;
        next.chainRouteCount = chainRoutes.length;
    } else if (!Array.isArray(next.chainRoutes) && Array.isArray(rawInput?.chainRoutes)) {
        next.chainRoutes = rawInput.chainRoutes;
        next.chainRouteCount = rawInput.chainRoutes.length;
    }

    if (triangles.length) {
        next.triangles = triangles;
        next.triangleCount = triangles.length;
        next.candidateTriangleCount = next.candidateTriangleCount ?? triangles.length;
    }

    const routePrepSource = rawInput.routePrep && typeof rawInput.routePrep === 'object' ? rawInput.routePrep : {};
    const routePrep = {
        ...routePrepSource,
        ...(next.routePrep && typeof next.routePrep === 'object' ? next.routePrep : {}),
    };
    if (chainRoutes.length) {
        routePrep.chainRoutes = chainRoutes;
        routePrep.chainRouteCount = chainRoutes.length;
    } else if (Array.isArray(routePrep.chainRoutes)) {
        routePrep.chainRouteCount = routePrep.chainRoutes.length;
    }
    if (triangles.length) {
        routePrep.triangles = triangles;
        routePrep.triangleCount = routePrep.triangleCount ?? triangles.length;
        routePrep.candidateTriangleCount = routePrep.candidateTriangleCount ?? triangles.length;
    }
    routePrep.pools = pools;
    routePrep.routedPoolCount = pools.length;

    if (
        Array.isArray(routePrep.chainRoutes)
        || Array.isArray(routePrep.triangles)
        || Array.isArray(rawInput?.routePrep?.pools)
    ) {
        next.routePrep = routePrep;
    }

    return next;
}

function mergeOutputPayload(rawInput, pools, debugReport = null) {
    if (Array.isArray(rawInput)) return pools;
    if (Array.isArray(rawInput?.pools)) return withFreshOutputStamp({ ...rawInput, pools });
    if (Array.isArray(rawInput?.data)) return withFreshOutputStamp({ ...rawInput, data: pools });
    if (rawInput?.poolShape && typeof rawInput.poolShape === 'object') {
        return withFreshOutputStamp({
            ...rawInput,
            poolShape: pools[0] || rawInput.poolShape,
            enrichmentDiagnostics: debugReport?.pools?.[0] || null,
        });
    }
    if (rawInput && typeof rawInput === 'object' && (rawInput.address || rawInput.poolAddress || rawInput.id)) {
        return withFreshOutputStamp({ ...rawInput, ...(pools[0] || {}), enrichmentDiagnostics: debugReport?.pools?.[0] || null });
    }
    return withFreshOutputStamp({ ...rawInput, pools });
}


async function main() {
    const args = parseCliArgs(process.argv);
    const { inputPath, outputPath, debugReportPath, debugSummary, debugQuotes, concurrency, dropIncomplete } = args;

    console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
    console.log('║  UNIFIED POOL ENRICHMENT - All Types (refactored)                        ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════╝');

    console.log(`\n📦 Loading pools from: ${inputPath}`);
    const rawInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const pools = extractPoolsFromInput(rawInput);
    console.log(`   Loaded ${pools.length} pools`);

    const needsRpc = pools.some((pool) => {
        const type = resolvePoolType(pool);
        if (['clmm', 'whirlpool', 'dlmm'].includes(type)) return !isFreshCanonicalInput(pool);
        if (['damm_v2', 'pumpswap'].includes(type)) return !_hasUsableReserves(pool);
        return false;
    });
    let connection = null;

    if (needsRpc) {
        const rpcUrls = getConfiguredRpcUrls();
        const maxRpcConcurrency = Math.max(1, concurrency || CONFIG.CONCURRENCY);
        if (!rpcUrls.length) {
            console.error('❌ Enrichment requires HELIUS_ENDPOINT*/RPC_URL in .env for live pool data');
            process.exit(1);
        }
        console.log(`\n🔌 Connecting to RPC pool for live enrichment...`);
        console.log(`   Endpoints: ${rpcUrls.length}`);
        if (rpcUrls.length === 1) {
            console.log('   RPC rotation: single endpoint configured; add HELIUS_ENDPOINT2+ for failover/load spread');
        } else {
            console.log(`   RPC rotation: enabled across ${rpcUrls.length} endpoints`);
        }
        const rawConnection = createRpcConnection({ urls: rpcUrls, commitment: 'confirmed' });
        connection = wrapConnection(rawConnection, {
            tokensPerSecond: Math.max(80, maxRpcConcurrency),
            burstCapacity: Math.min(100, Math.max(80, maxRpcConcurrency)),
            maxConcurrent: maxRpcConcurrency,
            minConcurrent: Math.min(2, maxRpcConcurrency),
            onAdaptive: ({ concurrency: adaptiveConcurrency, recent429, reason }) =>
                console.log(`[rpc] concurrency=${adaptiveConcurrency} 429s=${recent429} reason=${reason}`),
        });
    } else {
        console.log(`\n🔌 No RPC-backed pools detected; skipping RPC connection`);
    }

    await enrichAllPools(pools, connection, { concurrency });
    if (connection && pools.some((pool) => resolvePoolType(pool) === 'dlmm')) {
        await hydrateDlmmLiveFees(pools, connection, { debug: debugSummary || debugReportPath });
    }
    if (connection) {
        const { hydrateWhirlpoolTickArrays } = require('./utilities/tickArrayHydration');
        const WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
        await hydrateWhirlpoolTickArrays(pools, connection, {
            debug: debugSummary || debugReportPath,
            programId: WHIRLPOOL_PROGRAM_ID,
        });
    }
    decodePoolTickArrays(pools, { debug: debugSummary || debugReportPath });
    decodeWhirlpoolBase64TickArrays(pools, { debug: debugSummary || debugReportPath });

    // SOURCE-OF-TRUTH: converge every pool onto ONE canonical tick/bin shape,
    // regardless of which enrichment/decode path populated which field. After
    // this, every downstream consumer reads pool.tickArrayData (structured) and
    // pool.tickArrays (addresses) with a guaranteed contract. Pools with no
    // real state are flagged (tickContractOk=false) so GIGO is caught HERE.
    finalizeTickContract(pools, { debug: debugSummary || debugReportPath });

    let outputPools = pools;
    if (dropIncomplete) {
        const filtered = filterExecutionReadyPools(pools);
        outputPools = filtered.ready;
        console.log(`\n🧹 Drop incomplete: kept ${outputPools.length}/${pools.length} execution-ready pools`);
        for (const dropped of filtered.dropped.slice(0, 12)) {
            const diag = dropped.diagnostics || dropped;
            const reasons = diag.blockers.length ? diag.blockers.join(', ') : 'unknown';
            console.log(`   - quarantine ${diag.type} ${String(diag.poolAddress || 'unknown').slice(0, 8)}: ${reasons}`);
        }
        if (filtered.dropped.length > 12) {
            console.log(`   ... ${filtered.dropped.length - 12} more quarantined`);
        }
        if (filtered.dropped.length > 0) {
            const quarantinePath = quarantineOutputPath(outputPath);
            const quarantinePayload = {
                generatedAt: new Date().toISOString(),
                sourceInput: inputPath,
                executableOutput: outputPath,
                reason: 'not execution-ready after enrichment; preserved for decoder/retry/debug',
                count: filtered.dropped.length,
                pools: filtered.dropped.map(({ diagnostics, pool }) => ({
                    diagnostics,
                    pool,
                })),
            };
            fs.writeFileSync(quarantinePath, safeStringify(quarantinePayload));
            console.log(`   ↳ Quarantine saved: ${quarantinePath}`);
        }
    }

    await stampFreshness(outputPools, connection);

    const debugReport = buildEnrichmentDebugReport(outputPools);
    if (debugSummary || debugReportPath) printEnrichmentDebugSummary(debugReport);
    if (debugReportPath) {
        fs.writeFileSync(debugReportPath, safeStringify(debugReport));
        console.log(`\n📝 Diagnostics report saved to: ${debugReportPath}`);
    }

    // Apply authoritative decimals — normalizer fallback can't see mint accounts,
    // so we stamp known tokens before compact/save to prevent 6-default regression.
    const KNOWN_DECIMALS_STAMP = {
        'So11111111111111111111111111111111111111112': 9,
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 6,
        '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': 6,
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 8,
        'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': 8,
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 9,
        'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 9,
        'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 9,
        'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v': 9,
        '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 9,
    };
    for (const pool of outputPools) {
        const xm = pool.tokenXMint || pool.baseMint;
        const ym = pool.tokenYMint || pool.quoteMint;
        if (xm && KNOWN_DECIMALS_STAMP[xm] !== undefined) {
            pool.tokenXDecimals = KNOWN_DECIMALS_STAMP[xm];
            pool.baseDecimals = KNOWN_DECIMALS_STAMP[xm];
        }
        if (ym && KNOWN_DECIMALS_STAMP[ym] !== undefined) {
            pool.tokenYDecimals = KNOWN_DECIMALS_STAMP[ym];
            pool.quoteDecimals = KNOWN_DECIMALS_STAMP[ym];
        }
    }

    console.log(`💾 Saving to: ${outputPath}`);
    const outputPayloadRaw = mergeOutputPayload(rawInput, outputPools, debugReport);
    const readyPoolByKey = new Map(outputPools.map((pool) => [poolRecordKey(pool), pool]).filter(([key]) => key));
    const outputPayload = dropIncomplete
        ? pruneRoutesForReadyPools(outputPayloadRaw, new Set(outputPools.map(poolRecordKey).filter(Boolean)), readyPoolByKey)
        : outputPayloadRaw;
    const compactPayload = compactEnrichmentPayload(outputPayload);
    fs.writeFileSync(outputPath, safeStringify(compactPayload));
    console.log(`   ✓ Saved ${outputPools.length} pools\n`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    });
}




module.exports = AccountPrefetcher;

/* ============================================================================
 *  LIVE ACCOUNT DECODER — Fast-path refresh from WebSocket notifications
 * ========================================================================== */

function decodePoolAccountUpdate(pool, pubkey, notification, role) {
    if (!notification?.data || !Array.isArray(notification.data)) return null;
    const base64 = notification.data[0];
    if (!base64) return null;

    let buffer;
    try { buffer = Buffer.from(base64, 'base64'); } catch { return null; }
    if (!buffer || buffer.length === 0) return null;

    const type = resolvePoolType(pool);
    const updates = { lastUpdated: Date.now(), slot: notification.slot || 0 };

    try {
        // ── VAULT (SPL Token account) ─────────────────────────────────────────
        if (role === 'vault_x' || role === 'vault_y') {
            const amount = parseSplTokenAmount(buffer);
            if (amount != null) {
                if (role === 'vault_x') {
                    updates.xReserve = amount;
                    updates.reserves = { ...(pool.reserves || {}), x: amount };
                } else {
                    updates.yReserve = amount;
                    updates.reserves = { ...(pool.reserves || {}), y: amount };
                }
            }
            return updates;
        }

        // ── POOL STATE ────────────────────────────────────────────────────────
        if (role === 'pool_state') {
            if (type === 'whirlpool') {
                const programId = new PublicKey(notification.owner || pool.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
                const addr = new PublicKey(pool.poolAddress || pubkey);
                const state = ParsableWhirlpool.parse(addr, { data: buffer, owner: programId });
                if (state) {
                    updates.sqrtPriceX64 = state.sqrtPrice?.toString?.() || state.sqrtPriceX64?.toString?.() || pool.sqrtPriceX64;
                    updates.sqrtPrice = updates.sqrtPriceX64;
                    updates.tickCurrent = state.tickCurrentIndex || state.currentTickIndex || pool.tickCurrent;
                    updates.tickSpacing = state.tickSpacing || pool.tickSpacing;
                    updates.liquidity = state.liquidity?.toString?.() || pool.liquidity;
                    const vaultA = state.tokenVaultA || state.tokenVault0 || state.vaultA;
                    const vaultB = state.tokenVaultB || state.tokenVault1 || state.vaultB;
                    if (vaultA) updates.xVault = vaultA.toBase58?.() || vaultA.toString?.() || pool.xVault;
                    if (vaultB) updates.yVault = vaultB.toBase58?.() || vaultB.toString?.() || pool.yVault;
                    updates.vaults = { xVault: updates.xVault || pool.xVault, yVault: updates.yVault || pool.yVault };
                }
            } else if (type === 'clmm') {
                const state = RaydiumClmmPoolInfoLayout.decode(buffer);
                if (state) {
                    updates.sqrtPriceX64 = state.sqrtPriceX64?.toString?.() || pool.sqrtPriceX64;
                    updates.sqrtPrice = updates.sqrtPriceX64;
                    updates.tickCurrent = Number(state.tickCurrent ?? pool.tickCurrent);
                    updates.tickSpacing = Number(state.tickSpacing ?? pool.tickSpacing);
                    updates.liquidity = state.liquidity?.toString?.() || pool.liquidity;
                    const vaultA = state.vaultA || state.tokenVaultA;
                    const vaultB = state.vaultB || state.tokenVaultB;
                    if (vaultA) updates.xVault = vaultA.toBase58?.() || vaultA.toString?.() || pool.xVault;
                    if (vaultB) updates.yVault = vaultB.toBase58?.() || vaultB.toString?.() || pool.yVault;
                    updates.vaults = { xVault: updates.xVault || pool.xVault, yVault: updates.yVault || pool.yVault };
                }
            } else if (type === 'dlmm') {
                const state = dlmmCoder.decode('LbPair', buffer);
                if (state) {
                    updates.activeBinId = state.active_id !== undefined ? Number(state.active_id) : pool.activeBinId;
                    updates.binStep = state.bin_step !== undefined ? Number(state.bin_step) : pool.binStep;
                    const reserveX = state.reserve_x || state.reserveX;
                    const reserveY = state.reserve_y || state.reserveY;
                    if (reserveX) updates.xVault = reserveX.toBase58?.() || reserveX.toString?.() || pool.xVault;
                    if (reserveY) updates.yVault = reserveY.toBase58?.() || reserveY.toString?.() || pool.yVault;
                    updates.vaults = { xVault: updates.xVault || pool.xVault, yVault: updates.yVault || pool.yVault };
                }
            } else if (type === 'cpmm') {
                const programId = pool.programId || '';
                if (programId === CONFIG.RAYDIUM_CPMM) {
                    const state = CpmmPoolInfoLayout.decode(buffer);
                    const vaultA = state.vaultA || state.tokenVaultA;
                    const vaultB = state.vaultB || state.tokenVaultB;
                    if (vaultA) updates.xVault = vaultA.toBase58?.() || vaultA.toString?.() || pool.xVault;
                    if (vaultB) updates.yVault = vaultB.toBase58?.() || vaultB.toString?.() || pool.yVault;
                    updates.vaults = { xVault: updates.xVault || pool.xVault, yVault: updates.yVault || pool.yVault };
                } else if (programId === CONFIG.RAYDIUM_AMM_V4) {
                    const state = liquidityStateV4Layout.decode(buffer);
                    const vaultA = state.baseVault || state.vaultA;
                    const vaultB = state.quoteVault || state.vaultB;
                    if (vaultA) updates.xVault = vaultA.toBase58?.() || vaultA.toString?.() || pool.xVault;
                    if (vaultB) updates.yVault = vaultB.toBase58?.() || vaultB.toString?.() || pool.yVault;
                    updates.vaults = { xVault: updates.xVault || pool.xVault, yVault: updates.yVault || pool.yVault };
                }
            }
            return updates;
        }

        // ── TICK ARRAY (Whirlpool / CLMM) ─────────────────────────────────────
        if (role === 'tick_array') {
            if (type === 'whirlpool') {
                const addr = new PublicKey(pubkey);
                const tickArray = ParsableTickArray.parse(addr, { data: buffer, owner: new PublicKey(notification.owner || pool.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc') });
                if (tickArray?.ticks) {
                    const startTickIndex = tickArray.startTickIndex ?? TickUtil.getTickArrayStartIndexByTick(tickArray.ticks[0]?.tick || pool.tickCurrent || 0, pool.tickSpacing || 64);
                    const entry = buildStructuredTickArrayData(pubkey, startTickIndex, tickArray.ticks.map(t => ({
                        initialized: t.initialized,
                        liquidityNet: t.liquidityNet?.toString?.() || '0',
                        liquidityGross: t.liquidityGross?.toString?.() || '0',
                    })));
                    const existing = Array.isArray(pool.tickArrayData) ? [...pool.tickArrayData] : [];
                    const idx = existing.findIndex(ta => (ta.data?.startTickIndex || ta.startTickIndex) === startTickIndex);
                    if (idx >= 0) existing[idx] = entry; else existing.push(entry);
                    updates.tickArrayData = existing;
                    updates.tickArrays = existing.map(e => e.address || e.data?.address || pubkey);
                    updates.remainingAccounts = updates.tickArrays;
                    updates.aux = { ...(pool.aux || {}), whirlpool: { ...(pool.aux?.whirlpool || {}), tickArrays: existing, tickArrayData: existing } };
                }
            } else if (type === 'clmm') {
                const tickArray = RaydiumClmmTickArrayLayout.decode(buffer);
                if (tickArray?.ticks) {
                    const startTickIndex = Number(tickArray.startTickIndex || 0);
                    const entry = buildStructuredTickArrayData(pubkey, startTickIndex, tickArray.ticks.map(t => ({
                        initialized: Boolean(t?.liquidityGross && String(t.liquidityGross) !== '0'),
                        liquidityNet: t.liquidityNet?.toString?.() || '0',
                        liquidityGross: t.liquidityGross?.toString?.() || '0',
                    })));
                    const existing = Array.isArray(pool.tickArrayData) ? [...pool.tickArrayData] : [];
                    const idx = existing.findIndex(ta => (ta.data?.startTickIndex || ta.startTickIndex) === startTickIndex);
                    if (idx >= 0) existing[idx] = entry; else existing.push(entry);
                    updates.tickArrayData = existing;
                    updates.tickArrays = existing.map(e => e.address || e.data?.address || pubkey);
                    updates.remainingAccounts = updates.tickArrays;
                    updates.aux = { ...(pool.aux || {}), clmm: { ...(pool.aux?.clmm || {}), tickArrayData: existing, tickArrays: existing } };
                }
            }
            return updates;
        }

        // ── BIN ARRAY (DLMM) ──────────────────────────────────────────────────
        if (role === 'bin_array') {
            if (type === 'dlmm') {
                const binArray = dlmmCoder.decode('BinArray', buffer);
                if (binArray?.bins) {
                    const bins = [];
                    for (let j = 0; j < binArray.bins.length; j++) {
                        const bin = binArray.bins[j];
                        const xAmount = bin?.amount_x?.toString?.() || '0';
                        const yAmount = bin?.amount_y?.toString?.() || '0';
                        if (xAmount === '0' && yAmount === '0') continue;
                        const binId = (Number(binArray.index || 0) * MAX_BIN_ARRAY_SIZE) + j;
                        bins.push(normalizeDlmmBinForOutput({
                            binId, xAmount, yAmount,
                            liquidity: bin?.liquidity_supply?.toString?.() || (BigInt(xAmount) + BigInt(yAmount)).toString(),
                            binStep: pool.binStep || 0,
                            price: getPriceFromBinId(binId, pool.binStep || 0),
                        }, pool.feeBps || 25));
                    }
                    const existing = Array.isArray(pool.bins) ? [...pool.bins] : [];
                    const binMap = new Map(existing.map(b => [b.binId, b]));
                    for (const b of bins) binMap.set(b.binId, b);
                    updates.bins = Array.from(binMap.values()).sort((a, b) => a.binId - b.binId);
                    updates.binCount = updates.bins.length;
                    updates.hasRealBins = true;
                    updates.aux = { ...(pool.aux || {}), dlmm: { ...(pool.aux?.dlmm || {}), bins: updates.bins } };
                }
            }
            return updates;
        }

    } catch (err) {
        if (process.env.WS_DECODE_DEBUG === 'true') {
            console.warn(`[WS-DECODE] ${pool.poolAddress} ${role}: ${err.message}`);
        }
        return null;
    }

    return null;
}

function refreshPoolFromAccountCache(pool, accountCache) {
    const deps = getPoolAccountDependencies(pool);
    let updated = null;

    for (const dep of deps) {
        const cached = accountCache.get(dep.pubkey);
        if (!cached) continue;
        const partial = decodePoolAccountUpdate(pool, dep.pubkey, cached, dep.role);
        if (partial) {
            updated = { ...(updated || pool), ...partial };
        }
    }

    if (updated) {
        updated.poolStateVersion = `${pool.poolAddress}:${updated.slot || pool.slot || 0}:${updated.lastUpdated || Date.now()}`;
        return updated;
    }
    return null;
}
module.exports = {
    prefetchPoolAccounts,
    isTransient,
    dedupeKeys,
    chunk,
    enrichAllPools,
    enrichWhirlpool,
    enrichCLMM,
    enrichDLMM,
    enrichCPMM,
    buildEnrichmentDebugReport,
    buildEnrichmentDiagnosticsEntry,
    printEnrichmentDebugSummary,
    parseCliArgs,
    extractPoolsFromInput,
    mergeOutputPayload,
    compactQuoteOutput,
    compactPoolOutput,
    compactRoutePrepOutput,
    safeStringify,
    // exposed for tests and external diagnostics
    isFreshCanonicalInput,
    resolvePoolType,
    enrichmentCacheKey,
    buildUniqueEnrichmentWorkset,
    // re-export from binArray_util for backward compatibility with old callers
    MAX_BIN_ARRAY_SIZE,
    DEFAULT_BIN_PER_POSITION,
    binIdToBinArrayIndex,
    getBinArrayLowerUpperBinId,
    getBinIdIndexInBinArray,
    getBinArraysRequiredByPositionRange,
    getBinRangeFromActiveId,
    getBinRangeFromIds,
    normalizeBinRange,
    normalizeBinArrays,
    normalizeBins,
    normalizeBinId,
    deriveBinArray,
    refreshPoolFromAccountCache,
    decodePoolAccountUpdate,
};
/*
node _enrichment.js --in pools/_merged_pancake_dammv2_pumpswap.json \
--out pools/cakePumpDamm.json --concurrency 8 --debug-report \
--debug-summary --debug-quotes
npm start


node triArb/engine/zen_enrichment.js 02_meta.json 03_enriched.json

 node triArb/fetcher/triArbAdapter.js 03_enriched.json --size 500

 node triArb/fetcher/triArbAdapter.js 03_enriched.json --size 500

 node triArb/fetcher/poolDeepseek.js 03_enriched.json --size 500

 node triArb/fetcher/poolFetcher.js 03_enriched.json --size 500





*/

/*
node _enrichment.js --in 00_RAWout.json --out 00_RAWout_E.json \
--concurrency 8 --debug-report \
--debug-summary --debug-quotes
npm start


node triArb/engine/zen_enrichment.js 02_meta.json 03_enriched.json

 node triArb/fetcher/triArbAdapter.js 03_enriched.json --size 500

 node triArb/fetcher/triArbAdapter.js 03_enriched.json --size 500

 node triArb/fetcher/poolDeepseek.js 03_enriched.json --size 500

 node _enrichment.js tradePool/LST_TWO_WAY.hydrated.json  \
 --out tradePool/LST_TWO_WAY.hydrated_E.json 





*/
