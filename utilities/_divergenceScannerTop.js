'use strict';

const fs = require('fs');
const path = require('path');
const Decimal = require('decimal.js');
Decimal.set({ precision: 60 });

const { mergeCanonicalPool, validateRouteLegContract } = require('../math/poolContract.js');
const {
    compactPoolOutput: baseCompactPoolOutput,
    compactRoutePrepOutput: baseCompactRoutePrepOutput,
    safeStringify,
} = require('../_enrichment.js');
const { rankPoolsByTurnover, printTurnoverTable } = require('./turnoverRanker');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const { getTokenSymbol: _defiTokSymbol } = require('./defiTok');



const ROUTE_EXPORT_OMIT_KEYS = new Set([
    // Execution-critical fields (binArrays, tickArrays, etc.) are intentionally
    // RETAINED so that downstream executers can re-quote the routed pool file.
]);

function stripExecutionStateForRouteExport(value) {
    if (Array.isArray(value)) return value.map(stripExecutionStateForRouteExport);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (ROUTE_EXPORT_OMIT_KEYS.has(key)) continue;
        out[key] = stripExecutionStateForRouteExport(entry);
    }
    return out;
}

function compactPoolOutput(pool = {}) {
    return stripExecutionStateForRouteExport(baseCompactPoolOutput(pool));
}

function compactRoutePrepOutput(routePrep = {}, compactPools = null) {
    return stripExecutionStateForRouteExport(baseCompactRoutePrepOutput(routePrep, compactPools));
}

const SYMBOL_MAP = new Map([
    [SOL, 'SOL'],
    [USDC, 'USDC'],
]);

/* -------------------------------------------------------------------------- */
/*                         Outlier quarantine I/O                             */
/* -------------------------------------------------------------------------- */

function loadQuarantine(file = 'pools/_quarantine.json') {
    try {
        const raw = fs.readFileSync(path.resolve(file), 'utf8');
        const data = JSON.parse(raw);
        const now = Date.now();
        const live = new Set();
        for (const [addr, expiresAt] of Object.entries(data.entries || {})) {
            if (Number(expiresAt) > now) live.add(addr);
        }
        return live;
    } catch {
        return new Set();
    }
}

function commitQuarantine(file = 'pools/_quarantine.json', addrs = [], options = {}) {
    const cooldownMs = Number(options.cooldownMs ?? 30000);
    const now = Date.now();
    let data = { entries: {} };
    try {
        data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) || { entries: {} };
        if (!data.entries) data.entries = {};
    } catch { /* fresh file */ }
    for (const [addr, expiresAt] of Object.entries(data.entries)) {
        if (Number(expiresAt) <= now) delete data.entries[addr];
    }
    for (const addr of addrs) {
        if (addr) data.entries[addr] = now + cooldownMs;
    }
    try {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(path.resolve(file), JSON.stringify(data, null, 2));
    } catch (e) {
        if (process.env.QUARANTINE_DEBUG === 'true') console.error('[quarantine] write failed:', e.message);
    }
    return data;
}

/* -------------------------------------------------------------------------- */
/*                              Pure helpers                                  */
/* -------------------------------------------------------------------------- */

function decimalOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
        const d = new Decimal(String(value));
        return d.isFinite() ? d : null;
    } catch (_e) {
        return null;
    }
}

function toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function shortMint(value) {
    if (!value) return '?';
    const s = String(value);
    return s.length > 12 ? `${s.slice(0, 6)}..${s.slice(-4)}` : s;
}

function getPoolAddress(pool = {}) {
    return String(pool.poolAddress || pool.address || pool.id || '').trim();
}

function looksLikeMint(value) {
    const s = String(value || '');
    return s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function symbolFor(mint, fallback) {
    if (!mint) return '?';
    const known = SYMBOL_MAP.get(mint);
    if (known) return known;
    const defiSym = _defiTokSymbol(mint);
    if (defiSym) return defiSym;
    if (fallback && fallback !== '?' && !looksLikeMint(fallback) && String(fallback).length <= 16) {
        return String(fallback);
    }
    return shortMint(mint);
}

function canonicalPairKey(mintA, mintB) {
    if (!mintA || !mintB) return null;
    const [base, quote] = [String(mintA), String(mintB)].sort();
    return { base, quote, key: `${base}|${quote}` };
}

function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? sorted[mid - 1].plus(sorted[mid]).div(2)
        : sorted[mid];
}

function spreadBps(min, max, center) {
    if (!min || !max || !center || !center.gt(0)) return 0;
    return Number(max.minus(min).div(center).mul(10000).toFixed(4));
}

function diffBps(a, b) {
    if (!a || !b || !a.gt(0) || !b.gt(0)) return Infinity;
    const center = a.plus(b).div(2);
    return Math.abs(Number(a.minus(b).div(center).mul(10000).toFixed(4)));
}

function currentPriceYperX(c, pool) {
    const cp = decimalOrNull(
        c.currentPrice ?? pool.currentPrice ??
        c.midPrice ?? pool.midPrice ??
        c.price ?? pool.price
    );
    return cp && cp.gt(0) ? cp : null;
}

function shouldPreferStatePrice(c, pool, reserveMid) {
    const type = String(c.type || pool.type || '').toLowerCase();
    const dexType = String(c.dexType || pool.dexType || '').toUpperCase();
    if (type.includes('damm') || dexType.includes('DAMM')) return true;
    const statePrice = currentPriceYperX(c, pool);
    if (!statePrice || !reserveMid) return false;
    return diffBps(statePrice, reserveMid) > 1000;
}

/**
 * FIX 1 (v3): largestCoherentCluster — returns null when no ≥2-member cluster
 * exists within maxSpreadBps. Does NOT fall back to all members.
 */
function largestCoherentCluster(members, maxSpreadBps = 250) {
    const withMid = members
        .filter((m) => m.mid && m.mid.gt(0))
        .sort((a, b) => (a.mid.lt(b.mid) ? -1 : a.mid.gt(b.mid) ? 1 : 0));

    if (withMid.length < 2) return null;

    let best = [];
    for (let start = 0; start < withMid.length; start += 1) {
        for (let end = start + 1; end < withMid.length; end += 1) {
            const slice = withMid.slice(start, end + 1);
            if (slice.length <= best.length) continue;
            const mids = slice.map((m) => m.mid);
            const med = median(mids);
            const bps = spreadBps(mids[0], mids[mids.length - 1], med);
            if (bps <= maxSpreadBps) best = slice;
        }
    }
    return best.length >= 2 ? best : null;
}

function getCanonical(pool) {
    return mergeCanonicalPool(pool || {});
}

/* -------------------------------------------------------------------------- */
/*                        FIX 7 — robust mint helpers                        */
/* -------------------------------------------------------------------------- */

/**
 * extractPoolMints — reads tokenXMint / tokenYMint from a pool object using
 * every known field alias, WITHOUT relying on mergeCanonicalPool.
 *
 * Why this exists: when a pool was not fully enriched (no sqrtPriceX64),
 * mergeCanonicalPool may return an empty tokenXMint, causing the pool to be
 * silently skipped in annotatePairDivergence.  This helper reads directly
 * from the original pool so partially-enriched pools are still annotated.
 */
function extractPoolMints(pool = {}) {
    const raw = pool;
    const c = (pool.__canonical) ? pool : null;  // avoid double-calling getCanonical here
    const xMint = String(
        (c && c.tokenXMint) || raw.tokenXMint || raw.baseMint || raw.mintA ||
        raw.tokenMintA || raw.token0?.mint || raw.tokenA?.mint || ''
    ).trim();
    const yMint = String(
        (c && c.tokenYMint) || raw.tokenYMint || raw.quoteMint || raw.mintB ||
        raw.tokenMintB || raw.token1?.mint || raw.tokenB?.mint || ''
    ).trim();
    return { xMint, yMint };
}

/**
 * resolvePoolMints — tries canonical first, then falls back to extractPoolMints.
 * Used inside getPoolMidCanonical and buildPairMap.
 */
function resolvePoolMints(pool = {}) {
    const c = getCanonical(pool);
    const cXMint = String(c.tokenXMint || '').trim();
    const cYMint = String(c.tokenYMint || '').trim();
    if (cXMint && cYMint) return { xMint: cXMint, yMint: cYMint, canonical: c };
    // FIX 7: canonical had empty mint — fall back to raw pool fields
    const { xMint, yMint } = extractPoolMints(pool);
    return { xMint, yMint, canonical: c };
}

/* -------------------------------------------------------------------------- */
/*                           Mid-price extraction                             */
/* -------------------------------------------------------------------------- */

function normalizeMidSourcePreference(value) {
    const s = String(value || '').trim().toLowerCase();
    if (['reserve', 'reserves', 'reserves-only', 'reserve-only'].includes(s)) return 'reserves';
    if (['reserves-first', 'reserve-first'].includes(s)) return 'reserves-first';
    if (['sqrt', 'sqrt-first'].includes(s)) return 'sqrt';
    return 'auto';
}

function getReserveMidYperX(c, xDec, yDec) {
    const rxRaw = decimalOrNull(c.reserves?.x ?? c.xReserve);
    const ryRaw = decimalOrNull(c.reserves?.y ?? c.yReserve);
    if (rxRaw && ryRaw && rxRaw.gt(0) && ryRaw.gt(0)) {
        const rxUi = rxRaw.div(new Decimal(10).pow(xDec));
        const ryUi = ryRaw.div(new Decimal(10).pow(yDec));
        if (rxUi.gt(0) && ryUi.gt(0)) return ryUi.div(rxUi);
    }
    return null;
}

function getPoolMidPriceYperX(pool, options = {}) {
    const c = getCanonical(pool);
    const xDec = Number(c.tokenXDecimals ?? c.baseDecimals ?? pool.tokenXDecimals ?? pool.baseDecimals ?? 0);
    const yDec = Number(c.tokenYDecimals ?? c.quoteDecimals ?? pool.tokenYDecimals ?? pool.quoteDecimals ?? 0);
    const midSourcePreference = normalizeMidSourcePreference(
        options.midSource || options.midSourcePreference || options.preferMidSource
    );

    if (midSourcePreference === 'reserves' || midSourcePreference === 'reserves-first') {
        const reserveMid = getReserveMidYperX(c, xDec, yDec);
        if (reserveMid) return { mid: reserveMid, source: 'reserves' };
        if (midSourcePreference === 'reserves') return { mid: null, source: 'none' };
    }

    // Path 1 — sqrtPriceX64 (CLMM / Whirlpool)
    const sqrtRaw = decimalOrNull(c.sqrtPriceX64 ?? c.sqrtPrice ?? pool.sqrtPriceX64 ?? pool.sqrtPrice);
    if (sqrtRaw && sqrtRaw.gt(0)) {
        const Q64 = new Decimal(2).pow(64);
        const decimalsAdj = new Decimal(10).pow(xDec - yDec);
        const mid = sqrtRaw.div(Q64).pow(2).mul(decimalsAdj);
        if (mid.isFinite() && mid.gt(0)) return { mid, source: 'sqrt' };
    }

    // Path 2 — DLMM bin formula
    // GUARD: the bin price needs xDec/yDec for 10^(xDec-yDec) scaling. If decimals
    // were NOT explicitly hydrated (e.g. the fee-only DLMM fetch that replaced
    // DLMM.create drops tokenX/YDecimals), xDec/yDec fall back to 0 at the top of
    // this function and the price comes out 10^N too small -> the USDC/USDS
    // 9.998e-4-vs-1.0001 phantom. Refuse to compute unless decimals are genuinely
    // present, so a half-hydrated DLMM returns null (excluded) not a phantom mid.
    const _xDecPresent = (c.tokenXDecimals ?? c.baseDecimals ?? pool.tokenXDecimals ?? pool.baseDecimals) != null;
    const _yDecPresent = (c.tokenYDecimals ?? c.quoteDecimals ?? pool.tokenYDecimals ?? pool.quoteDecimals) != null;
    const binStep = c.binStep ?? pool.binStep;
    const activeBinId = c.activeBinId ?? pool.activeBinId;
    if (binStep != null && activeBinId != null && _xDecPresent && _yDecPresent) {
        const bs = Number(binStep);
        const id = Number(activeBinId);
        if (Number.isFinite(bs) && Number.isFinite(id) && bs > 0) {
            const base = new Decimal(1).plus(new Decimal(bs).div(10000));
            const rawPrice = base.pow(id);
            const decimalsAdj = new Decimal(10).pow(xDec - yDec);
            const mid = rawPrice.mul(decimalsAdj);
            if (mid.isFinite() && mid.gt(0)) return { mid, source: 'bin' };
        }
    } else if (binStep != null && activeBinId != null && (!_xDecPresent || !_yDecPresent)) {
        // DLMM has bin data but missing decimals -> would be a phantom. Skip Path 2,
        // let it fall through (likely to null) rather than emit a 10^N-wrong mid.
        // (This is the fee-only-fetch regression guard.)
    }

    // Path 3 — state price for dynamic-liquidity pools
    const statePrice = currentPriceYperX(c, pool);
    const reserveMid = getReserveMidYperX(c, xDec, yDec);
    if (statePrice && shouldPreferStatePrice(c, pool, reserveMid)) {
        return { mid: statePrice, source: 'state-price' };
    }

    // Path 4 — reserve ratio (CPMM)
    if (reserveMid) return { mid: reserveMid, source: 'reserves' };

    // Path 5 — API-provided currentPrice (last resort)
    if (statePrice) return { mid: statePrice, source: 'currentPrice' };

    return { mid: null, source: 'none' };
}

/**
 * FIX 7 applied: resolvePoolMints() is used instead of reading c.tokenXMint
 * directly, so pools with empty canonical mints are no longer skipped.
 */
function getPoolMidCanonical(pool, options = {}) {
    const { xMint, yMint, canonical: c } = resolvePoolMints(pool);
    const pair = canonicalPairKey(xMint, yMint);
    if (!pair) return { mid: null, pair: null, orientation: null, source: 'none' };

    const { mid: yPerX, source } = getPoolMidPriceYperX(pool, options);
    if (!yPerX || yPerX.lte(0)) return { mid: null, pair, orientation: null, source };

    if (xMint === pair.base) {
        return { mid: yPerX, pair, orientation: 'base-is-x', source };
    }
    return { mid: new Decimal(1).div(yPerX), pair, orientation: 'base-is-y', source };
}

/* -------------------------------------------------------------------------- */
/*                            Symbol resolution                               */
/* -------------------------------------------------------------------------- */

function getPoolSymbols(pool) {
    const c = getCanonical(pool);
    return {
        tokenXSymbol: symbolFor(c.tokenXMint, c.tokenXSymbol || c.baseSymbol),
        tokenYSymbol: symbolFor(c.tokenYMint, c.tokenYSymbol || c.quoteSymbol),
    };
}

function pairLabel(pair, members) {
    let baseSym = SYMBOL_MAP.get(pair.base) || null;
    let quoteSym = SYMBOL_MAP.get(pair.quote) || null;

    if (!baseSym || !quoteSym) {
        for (const { pool } of members) {
            const c = getCanonical(pool);
            let candidateBase, candidateQuote;
            if (c.tokenXMint === pair.base || pool.tokenXMint === pair.base || pool.baseMint === pair.base) {
                candidateBase = c.tokenXSymbol || c.baseSymbol || pool.baseSymbol;
                candidateQuote = c.tokenYSymbol || c.quoteSymbol || pool.quoteSymbol;
            } else if (c.tokenYMint === pair.base || pool.tokenYMint === pair.base || pool.quoteMint === pair.base) {
                candidateBase = c.tokenYSymbol || c.quoteSymbol || pool.quoteSymbol;
                candidateQuote = c.tokenXSymbol || c.baseSymbol || pool.baseSymbol;
            }
            if (!baseSym && candidateBase && !looksLikeMint(candidateBase)) baseSym = candidateBase;
            if (!quoteSym && candidateQuote && !looksLikeMint(candidateQuote)) quoteSym = candidateQuote;
            if (baseSym && quoteSym) break;
        }
    }
    return `${baseSym || shortMint(pair.base)}/${quoteSym || shortMint(pair.quote)}`;
}

/* -------------------------------------------------------------------------- */
/*                            Pair divergence                                 */
/* -------------------------------------------------------------------------- */

function annotatePairDivergence(pools = [], options = {}) {
    const poolList = sanitizePools(pools, { quiet: true });
    const diagnose = Boolean(options.diagnose);
    const maxCoreDivergenceBps = Number(options.maxCoreDivergenceBps ?? 250);
    const midSourcePreference = normalizeMidSourcePreference(
        options.midSource || options.midSourcePreference || options.preferMidSource
    );

    const groups = new Map();
    if (diagnose && poolList.length !== (Array.isArray(pools) ? pools.length : 0)) {
        console.log(`  [skip] ${Math.max(0, (Array.isArray(pools) ? pools.length : 0) - poolList.length)} invalid pool entr${(Array.isArray(pools) ? pools.length : 0) - poolList.length === 1 ? 'y' : 'ies'} — null/non-object`);
    }
    for (const pool of poolList) {
        const { mid, pair, orientation, source } = getPoolMidCanonical(pool, { midSource: midSourcePreference });
        if (!pair) {
            if (diagnose) {
                const c = getCanonical(pool);
                const { xMint, yMint } = extractPoolMints(pool);
                console.log(
                    `  [skip] ${shortMint(getPoolAddress(pool))} ${c.dex || pool.dex}/${c.type || pool.type}` +
                    ` — xMint=${shortMint(xMint) || 'MISSING'} yMint=${shortMint(yMint) || 'MISSING'}`
                );
            }
            continue;
        }
        if (!groups.has(pair.key)) groups.set(pair.key, { pair, members: [] });
        groups.get(pair.key).members.push({ pool, mid, orientation, source });
    }

    for (const { pair, members } of groups.values()) {
        const mids = members.map((m) => m.mid).filter((m) => m && m.gt(0));
        const label = pairLabel(pair, members);
        const [baseSymStr, quoteSymStr] = label.split('/');

        if (mids.length === 0) {
            for (const m of members) {
                _stampPool(m.pool, pair, label, baseSymStr, quoteSymStr, members.length,
                    null, null, null, null, null, 0, 0, false, false, m.source);
            }
            continue;
        }

        const COMPATIBLE = new Set(['sqrt', 'reserves', 'bin', 'state-price']);
        const sourceCounts = new Map();
        for (const m of members) {
            sourceCounts.set(m.source, (sourceCounts.get(m.source) || 0) + 1);
        }

        const compatibleMembers = members.filter((m) => COMPATIBLE.has(m.source));

        // FIX 1 (v3): largestCoherentCluster returns null; never falls back to all members.
        let comparable = compatibleMembers.length >= 2
            ? largestCoherentCluster(compatibleMembers, maxCoreDivergenceBps)
            : null;

        // FIX 5 (v3): track fallback usage.
        let usedFallback = false;

        if (!comparable) {
            let bestSource = null;
            let bestCount = 0;
            for (const [src, n] of sourceCounts.entries()) {
                if (n > bestCount) { bestSource = src; bestCount = n; }
            }
            if (bestCount >= 2) {
                const singleSourceMembers = members.filter((m) => m.source === bestSource);
                comparable = largestCoherentCluster(singleSourceMembers, maxCoreDivergenceBps);
                if (!comparable) usedFallback = true;
            }
        }

        const cmpMids = (comparable || []).map((m) => m.mid).filter((m) => m && m.gt(0));
        const rawMids = mids;
        const med = cmpMids.length ? median(cmpMids) : median(rawMids);
        const min = cmpMids.length ? cmpMids.reduce((a, b) => (a.lt(b) ? a : b)) : null;
        const max = cmpMids.length ? cmpMids.reduce((a, b) => (a.gt(b) ? a : b)) : null;
        const rawMin = rawMids.reduce((a, b) => (a.lt(b) ? a : b));
        const rawMax = rawMids.reduce((a, b) => (a.gt(b) ? a : b));
        const rawMed = median(rawMids);

        const distinctMidSources = new Set(
            members.filter((m) => m.mid && m.mid.gt(0)).map((m) => m.source).filter((s) => s && s !== 'none')
        );
        const unsafeHeterogeneous = (!comparable && distinctMidSources.size > 1) || usedFallback;

        const divergenceBps = (!comparable || !med || !med.gt(0) || !min || !max)
            ? 0
            : spreadBps(min, max, med);
        const rawDivergenceBps = rawMed && rawMed.gt(0) ? spreadBps(rawMin, rawMax, rawMed) : 0;

        for (const { pool, mid, orientation, source } of members) {
            _stampPool(
                pool, pair, label, baseSymStr, quoteSymStr, members.length,
                comparable, med, min, max, orientation,
                divergenceBps, rawDivergenceBps,
                Boolean(comparable), unsafeHeterogeneous,
                source, mid
            );
        }

        if (process.env.RANK_TURNOVER === 'true' || options.rankTurnover) {
            printTurnoverTable(rankPoolsByTurnover(poolList, {
                minTurnover: Number(process.env.MIN_TURNOVER ?? 0),
                minVolume24h: Number(process.env.MIN_VOLUME24H ?? 0),
            }));
        }
    }

    if (diagnose) _printDiagnosis(poolList, midSourcePreference);
    return pools;
}



/**
 * FIX 2 (v3): Lightweight re-annotation after enrichment.
 */
function annotatePostEnrichment(pools = [], options = {}) {
    for (const pool of pools) {
        if (!pool || typeof pool !== 'object') continue;
        const keys = Object.keys(pool).filter((k) => k.startsWith('pair'));
        for (const k of keys) delete pool[k];
    }
    return annotatePairDivergence(pools, options);
}

function _stampPool(
    pool, pair, label, baseSymStr, quoteSymStr, peerCount,
    comparable, med, min, max, orientation,
    divergenceBps, rawDivergenceBps,
    isComparable, unsafeHeterogeneous,
    source, mid
) {
    pool.pairCanonical = pair.key;
    pool.pairLabel = label;
    pool.pairBaseMint = pair.base;
    pool.pairQuoteMint = pair.quote;
    pool.pairBaseSymbol = baseSymStr;
    pool.pairQuoteSymbol = quoteSymStr;
    pool.pairOrientation = orientation || null;
    pool.pairPeerCount = peerCount;
    pool.pairComparablePeerCount = comparable ? comparable.length : 0;
    pool.pairMidPrice = mid && mid.gt ? Number(mid.toFixed(12)) : null;
    pool.pairMedianMid = med ? Number(med.toFixed(12)) : null;
    pool.pairBestMid = max ? Number(max.toFixed(12)) : null;
    pool.pairWorstMid = min ? Number(min.toFixed(12)) : null;
    pool.pairDivergenceBps = divergenceBps;
    pool.pairRawDivergenceBps = rawDivergenceBps;
    pool.pairDivergenceComparable = isComparable;
    pool.pairDivergenceUnsafeHeterogeneous = unsafeHeterogeneous;

    const inCompare = comparable && mid && comparable.some((m) => m.pool === pool);
    pool.pairMidOutlier = Boolean(mid && !inCompare && comparable);
    pool.pairMidDeviationBps = (!comparable || !inCompare || !mid || !med || !med.gt(0))
        ? 0
        : Number(mid.minus(med).div(med).mul(10000).toFixed(4));
    pool.pairSpreadPosition = (!comparable || !inCompare || !max || !min || !max.gt(min) || !mid)
        ? 0.5
        : Number(mid.minus(min).div(max.minus(min)).toFixed(4));
    pool.pairMidExtractionSource = source;
}

function _printDiagnosis(pools, midSourcePreference) {
    const sources = {};
    let withMid = 0; let withoutMid = 0; let heterogeneous = 0;
    const seenPairs = new Set();
    const poolList = sanitizePools(pools, { quiet: true });
    for (const p of poolList) {
        const s = p.pairMidExtractionSource || 'none';
        sources[s] = (sources[s] || 0) + 1;
        if (p.pairMidPrice != null) withMid += 1; else withoutMid += 1;
        if (p.pairCanonical && !seenPairs.has(p.pairCanonical)) {
            seenPairs.add(p.pairCanonical);
            if (p.pairDivergenceUnsafeHeterogeneous === true) heterogeneous += 1;
        }
    }
    console.log('\n  Mid-price extraction summary:');
    if (midSourcePreference !== 'auto') console.log(`    preference     ${midSourcePreference}`);
    for (const [s, n] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${s.padEnd(14)} ${n} pools`);
    }
    console.log(`  Pools with mid:    ${withMid}/${poolList.length}`);
    console.log(`  Pools without mid: ${withoutMid}/${poolList.length}`);
    if (heterogeneous > 0) {
        console.log(`  ⚠ Unsafe-heterogeneous pairs (divergence clamped to 0): ${heterogeneous}`);
    }
    if (withoutMid > pools.length / 2) {
        console.log(`  ⚠ More than half of pools have no mid — divergence unreliable.`);
        console.log(`    Run enrichment before scanning.`);
    }
}

/* -------------------------------------------------------------------------- */
/*                          Triangle / route scoring                          */
/* -------------------------------------------------------------------------- */

function scoreTriangleByDivergence(routeLegs = []) {
    if (!Array.isArray(routeLegs) || routeLegs.length === 0) {
        return { maxLegBps: 0, sumLegBps: 0, directionalEdgeBps: 0, flatLegs: 0, perLeg: [] };
    }

    const perLeg = routeLegs.map((leg) => {
        const pool = leg?.pool || leg;
        const c = getCanonical(pool);
        const divergenceBps = Number(pool?.pairDivergenceBps || 0);
        const peerCount = Number(pool?.pairPeerCount || 0);
        const comparablePeerCount = Number(pool?.pairComparablePeerCount || 0);
        const deviation = Number(pool?.pairMidDeviationBps || 0);

        let directionalBps = 0;
        const tokenIn = leg?.tokenInMint || leg?.inputMint;
        const baseMint = pool?.pairBaseMint;
        if (tokenIn && baseMint && comparablePeerCount >= 2) {
            const sellingBase = tokenIn === baseMint;
            directionalBps = sellingBase ? deviation : -deviation;
        }

        return {
            legIndex: leg?.legIndex ?? null,
            poolAddress: pool?.poolAddress || pool?.address || null,
            pairLabel: pool?.pairLabel || pool?.pairCanonical || null,
            dex: c.dex || pool?.dex || null,
            type: c.type || pool?.type || null,
            divergenceBps,
            peerCount,
            comparablePeerCount,
            deviationBps: deviation,
            directionalBps: Number(directionalBps.toFixed(4)),
            feeBps: Number(pool?.feeBps || 0),
        };
    });

    const maxLegBps = perLeg.reduce((m, l) => Math.max(m, l.divergenceBps), 0);
    const sumLegBps = perLeg.reduce((s, l) => s + l.divergenceBps, 0);
    const directionalEdgeBps = perLeg.reduce((s, l) => s + l.directionalBps, 0);
    const totalFeeBps = perLeg.reduce((s, l) => s + l.feeBps, 0);
    const flatLegs = perLeg.filter((l) => l.divergenceBps < 0.5).length;
    const zeroPeerLegs = perLeg.filter((l) => l.comparablePeerCount < 2).length;

    return {
        maxLegBps: Number(maxLegBps.toFixed(4)),
        sumLegBps: Number(sumLegBps.toFixed(4)),
        directionalEdgeBps: Number(directionalEdgeBps.toFixed(4)),
        totalFeeBps: Number(totalFeeBps.toFixed(4)),
        flatLegs,
        zeroPeerLegs,
        perLeg,
    };
}

/**
 * FIX 3+4 (v3): filterRoutesByDivergence with minComparablePeers + fee-floor guard.
 */
function filterRoutesByDivergence(routes = [], options = {}) {
    const minBps = Number(options.minBps ?? 5);
    const maxFlatLegs = Number(options.maxFlatLegs ?? 2);
    const minDirectionalBps = options.minDirectionalBps != null ? Number(options.minDirectionalBps) : null;
    const minComparablePeers = Number(options.minComparablePeers ?? 2);
    const requireFeeFloor = options.requireFeeFloor !== false;
    const maxZeroPeerLegs = Number(options.maxZeroPeerLegs ?? 0);

    return routes.filter((route) => {
        const score = route.score || scoreTriangleByDivergence(route.legs || route);

        if (score.maxLegBps < minBps) return false;
        if (score.flatLegs > maxFlatLegs) return false;
        if (minDirectionalBps !== null && score.directionalEdgeBps < minDirectionalBps) return false;
        if (score.zeroPeerLegs > maxZeroPeerLegs) return false;

        if (minComparablePeers > 0) {
            const hasUncomparable = (score.perLeg || []).some(
                (l) => l.comparablePeerCount < minComparablePeers
            );
            if (hasUncomparable) return false;
        }

        if (requireFeeFloor && score.totalFeeBps >= score.sumLegBps && score.sumLegBps > 0) {
            return false;
        }

        return true;
    });
}

/**
 * FIX 6 (v3): selectBestPoolPerLeg — falls back to lowest-fee pool when no
 * comparable peers exist.
 */
function selectBestPoolPerLeg(poolsPerLegInDirection = []) {
    return poolsPerLegInDirection.map((pools) => {
        if (!Array.isArray(pools) || pools.length === 0) return null;
        if (pools.length === 1) return pools[0];

        const withComparable = pools.filter((p) => {
            const pool = p.pool || p;
            return Number(pool.pairComparablePeerCount || 0) >= 2;
        });

        if (withComparable.length > 0) {
            let best = withComparable[0];
            let bestScore = -Infinity;
            for (const candidate of withComparable) {
                const pool = candidate.pool || candidate;
                const tokenIn = candidate.tokenInMint || candidate.inputMint;
                const baseMint = pool.pairBaseMint;
                const mid = Number(pool.pairMidPrice || 0);
                if (!mid || !tokenIn || !baseMint) continue;
                const score = (tokenIn === baseMint) ? mid : -mid;
                if (score > bestScore) { bestScore = score; best = candidate; }
            }
            return best;
        }

        return pools.reduce((best, candidate) => {
            const poolFee = Number((candidate.pool || candidate).feeBps || 0);
            const bestFee = Number((best.pool || best).feeBps || 0);
            return poolFee < bestFee ? candidate : best;
        });
    });
}

/* -------------------------------------------------------------------------- */
/*                     Divergence-aware 3-leg route builder                  */
/* -------------------------------------------------------------------------- */

function normalizeMathType(value) {
    const raw = String(value || '').toLowerCase();
    if (raw.includes('damm_v2') || raw.includes('damm-v2') || raw.includes('meteora_damm')) return 'damm_v2';
    if (raw.includes('pumpswap') || raw.includes('pump_swap') || raw.includes('pump-swap')) return 'pumpswap';
    if (raw.includes('amm_v3') || raw.includes('pancake')) return 'pancakeswap';
    if (raw.includes('dlmm')) return 'dlmm';
    if (raw.includes('whirlpool') || raw.includes('orca')) return 'whirlpool';
    if (raw.includes('clmm')) return 'clmm';
    if (raw.includes('cpmm') || raw.includes('constant_product') || raw.includes('amm')) return 'cpmm';
    return String(value || '').toLowerCase() || 'unknown';
}

function routeCanonicalPool(pool = {}) {
    const merged = mergeCanonicalPool(pool || {});
    const identity = [merged.mathType, merged.type, merged.poolType, merged.dexType, merged.dex, merged.source]
        .map((v) => String(v || ''))
        .join('|');
    const mathType = normalizeMathType(merged.mathType || identity);
    const address = getPoolAddress(merged) || getPoolAddress(pool);
    return {
        ...merged,
        mathType,
        type: mathType,
        poolAddress: address,
        address,
        dexType: String(merged.dexType || merged.protocol || merged.dex || merged.source || mathType || 'UNKNOWN')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'UNKNOWN',
    };
}

function routePoolMints(pool = {}) {
    const p = routeCanonicalPool(pool);
    // FIX 7 applied: fall back to raw pool fields if canonical is empty
    const xMint = String(p.tokenXMint || p.baseMint || p.mintA || pool.tokenXMint || pool.baseMint || pool.mintA || '');
    const yMint = String(p.tokenYMint || p.quoteMint || p.mintB || pool.tokenYMint || pool.quoteMint || pool.mintB || '');
    return { tokenXMint: xMint, tokenYMint: yMint };
}

function routePoolDecimals(pool = {}) {
    const p = routeCanonicalPool(pool);
    return {
        tokenXDecimals: toFiniteNumber(
            p.tokenXDecimals ?? p.baseDecimals ?? p.decimalsA ?? p.tokenA?.decimals ??
            pool.tokenXDecimals ?? pool.baseDecimals ?? 0,
            0
        ),
        tokenYDecimals: toFiniteNumber(
            p.tokenYDecimals ?? p.quoteDecimals ?? p.decimalsB ?? p.tokenB?.decimals ??
            pool.tokenYDecimals ?? pool.quoteDecimals ?? 0,
            0
        ),
    };
}

function routeFeeBps(pool = {}) {
    if (pool.feeBps != null) return toFiniteNumber(pool.feeBps, 0);
    if (pool.feeRateBps != null) return toFiniteNumber(pool.feeRateBps, 0);
    if (pool.feeRate != null) {
        const feeRate = toFiniteNumber(pool.feeRate, 0);
        return feeRate > 0 && feeRate < 1 ? Math.round(feeRate * 10000) : Math.round(feeRate);
    }
    return 0;
}

function directedPairKey(a, b) {
    return `${String(a || '')}-${String(b || '')}`;
}

/**
 * FIX 7 + FIX 8 applied:
 * - Mint extraction uses routePoolMints (which falls back to raw fields).
 * - Stored pool is { ...rawPool, ...c } so tickArrays, remainingAccounts,
 *   pair* annotations, and all simulation fields survive into route legs.
 */
function buildPairMap(pools = []) {
    const pairMap = new Map();
    const mintToSymbol = new Map();

    for (const rawPool of pools || []) {
        if (!rawPool || typeof rawPool !== 'object') continue;
        const c = routeCanonicalPool(rawPool);
        // FIX 8: merge canonical normalization ON TOP of the original pool so no
        // field is ever lost — pair* stamps, tickArrays, remainingAccounts, etc.
        const poolToStore = { ...rawPool, ...c };

        const { tokenXMint, tokenYMint } = routePoolMints(poolToStore);
        if (!tokenXMint || !tokenYMint) continue;

        if (poolToStore.tokenXSymbol || poolToStore.baseSymbol) mintToSymbol.set(tokenXMint, poolToStore.tokenXSymbol || poolToStore.baseSymbol);
        if (poolToStore.tokenYSymbol || poolToStore.quoteSymbol) mintToSymbol.set(tokenYMint, poolToStore.tokenYSymbol || poolToStore.quoteSymbol);

        for (const key of [directedPairKey(tokenXMint, tokenYMint), directedPairKey(tokenYMint, tokenXMint)]) {
            if (!pairMap.has(key)) pairMap.set(key, []);
            pairMap.get(key).push(poolToStore);
        }
    }

    return { pairMap, mintToSymbol };
}

function findConnectedMints(pairMap, mint) {
    const connected = new Set();
    for (const key of pairMap.keys()) {
        if (key.startsWith(`${mint}-`)) connected.add(key.slice(String(mint).length + 1));
    }
    return Array.from(connected);
}

function getPoolsForPair(pairMap, tokenIn, tokenOut) {
    return pairMap.get(directedPairKey(tokenIn, tokenOut)) || [];
}

function computeLegDirectionalEdge(pool = {}, tokenInMint) {
    const baseMint = pool.pairBaseMint || null;
    const quoteMint = pool.pairQuoteMint || null;
    const deviationBps = toFiniteNumber(pool.pairMidDeviationBps, 0);
    const divergenceBps = toFiniteNumber(pool.pairDivergenceBps, 0);
    const comparable = pool.pairDivergenceComparable !== false
        && toFiniteNumber(pool.pairComparablePeerCount, 0) >= 2;

    if (!baseMint || !quoteMint || !comparable || deviationBps === 0) {
        return {
            directionalBps: 0,
            deviationBps,
            divergenceBps,
            comparable,
            baseMint,
            quoteMint,
            sellingBase: false,
        };
    }

    const sellingBase = tokenInMint === baseMint;
    return {
        directionalBps: Number((sellingBase ? deviationBps : -deviationBps).toFixed(4)),
        deviationBps,
        divergenceBps,
        comparable,
        baseMint,
        quoteMint,
        sellingBase,
    };
}

/**
 * Stale-mid clamp. The route builder otherwise treats the pool whose mid is FURTHEST
 * from consensus as the best "buy low / sell high" leg — but a mid that far out is far
 * more likely a stale activeBinId / sqrtPrice than a real edge (see SOL/USDC: 19 pools
 * anchored by a $32M whirlpool cannot have a true 66bps spread). This caps the trusted
 * edge and flags/excludes outliers so the scanner stops proposing routes the engine
 * then has to reject.
 *
 * Options:
 *   maxTrustedDeviationBps (default 30)  edge beyond this is not rewarded (treated as stale)
 *   maxLegMidDeviationBps  (default 150) at/above this, or pairMidOutlier, leg is stale
 */
function clampDirectionalEdge(directional, pool = {}, options = {}) {
    const maxTrusted = toFiniteNumber(options.maxTrustedDeviationBps, 30);
    const maxLeg = toFiniteNumber(options.maxLegMidDeviationBps, 150);
    const isOutlier = pool.pairMidOutlier === true;
    const absDev = Math.abs(toFiniteNumber(pool.pairMidDeviationBps, 0));

    // depthStale is stamped by the (cached, out-of-band) depth probe — see depthProbe.js.
    const depthStale = pool.depthStale === true;
    const stale = isOutlier || absDev >= maxLeg || depthStale;
    const staleReason = stale
        ? (depthStale ? `depth-probe gap ${toFiniteNumber(pool.depthGapBps, 0).toFixed(1)}bps`
            : isOutlier ? 'mid-outlier (outside coherent cluster)'
                : `mid-deviation ${absDev.toFixed(1)}bps >= ${maxLeg}`)
        : null;

    // Cap the magnitude of the rewarded directional edge to what real markets sustain.
    const raw = toFiniteNumber(directional.directionalBps, 0);
    let trusted = raw;
    if (Math.abs(raw) > maxTrusted) {
        trusted = Math.sign(raw) * maxTrusted;
    }
    if (stale) trusted = 0; // never reward an outlier/stale pool's "edge"

    return {
        trustedDirectionalBps: Number(trusted.toFixed(4)),
        rawDirectionalBps: Number(raw.toFixed(4)),
        edgeCapped: Math.abs(raw) > maxTrusted,
        stale,
        staleReason,
    };
}


function scoreLegPool(pool = {}, tokenInMint, options = {}) {
    // Use pool as-is when it already carries canonical + pair* stamps; otherwise normalise.
    const p = (pool.pairCanonical && pool.mathType) ? pool : routeCanonicalPool(pool);
    const directional = computeLegDirectionalEdge(p, tokenInMint);
    const clamp = clampDirectionalEdge(directional, p, options);
    const _q = (options.__quarantine instanceof Set) ? options.__quarantine : null;
    const _addr = getPoolAddress(p);
    const quarantined = _q ? _q.has(_addr) : false;
    const isStale = clamp.stale || quarantined;

    const feeBps = routeFeeBps(p);
    const spreadPosition = toFiniteNumber(p.pairSpreadPosition, 0.5);
    const positionEdgeBps = (!isStale && directional.divergenceBps > 0)
        ? (directional.sellingBase ? (spreadPosition - 0.5) : (0.5 - spreadPosition)) * directional.divergenceBps
        : 0;

    const directionalWeight = toFiniteNumber(options.directionalWeight, 1);
    const feeWeight = toFiniteNumber(options.feeWeight, 2);
    const positionWeight = toFiniteNumber(options.positionWeight, 0.25);
    const liquidityWeight = toFiniteNumber(options.liquidityWeight, 0);
    const tvl = toFiniteNumber(p.tvl ?? p.tvlUsd ?? p.liquidityUsd, 0);
    const liquidityScore = tvl > 0 ? Math.log10(tvl + 1) * liquidityWeight : 0;

    return {
        pool: p,
        score: (isStale ? 0 : clamp.trustedDirectionalBps * directionalWeight)
            - (feeBps * feeWeight)
            + (isStale ? 0 : positionEdgeBps * positionWeight)
            + liquidityScore,
        feeBps,
        spreadPosition,
        positionEdgeBps: Number(positionEdgeBps.toFixed(4)),
        stale: isStale,
        staleReason: quarantined ? 'quarantined (recent reject)' : clamp.staleReason,
        edgeCapped: clamp.edgeCapped,
        trustedDirectionalBps: clamp.trustedDirectionalBps,
        ...directional,
    };
}

function routeSortScore(route = []) {
    const first = Array.isArray(route) ? route[0] : route?.legs?.[0];
    const meta = first?._divergenceMeta || {};
    const routeScore = toFiniteNumber(first?.routeScore ?? meta.routeScore, null);
    const directionalEdgeBps = toFiniteNumber(first?.directionalEdgeBps ?? meta.directionalEdgeBps, 0);
    const totalFeeBps = toFiniteNumber(first?.routeTotalFeeBps ?? meta.totalFeeBps, 0);
    if (routeScore !== null) return routeScore;
    return directionalEdgeBps - totalFeeBps;
}

function pickTopKForLeg(candidatePools, tokenInMint, k = 1, options = {}) {
    const dropStale = options.dropStaleLegs !== false; // default ON
    const dropOutliers = options.dropOutlierLegs !== false; // default ON
    const scored = (candidatePools || [])
        .map((pool) => scoreLegPool(pool, tokenInMint, options))
        .filter((entry) => entry.pool && getPoolAddress(entry.pool))
        .sort((a, b) => b.score - a.score);

    if (dropStale) {
        const fresh = scored.filter((entry) => (
            !entry.stale
            && (!dropOutliers || entry.pool?.pairMidOutlier !== true)
        ));
        if (fresh.length > 0) return fresh.slice(0, Math.max(1, Number(k) || 1));
        return [];
    }
    return scored.filter((entry) => !dropOutliers || entry.pool?.pairMidOutlier !== true)
        .slice(0, Math.max(1, Number(k) || 1));
}

/**
 * FIX 8 applied: leg preserves ALL fields from the original pool (simulation
 * arrays, pair* stamps) by spreading rawPool first, then the canonical layer.
 */
function fallbackBuildRouteLeg(pool, tokenInMint, tokenOutMint, meta = {}) {
    const p = routeCanonicalPool(pool);
    const { tokenXMint, tokenYMint } = routePoolMints(pool);
    const { tokenXDecimals, tokenYDecimals } = routePoolDecimals(pool);
    const aToB = tokenInMint === tokenXMint;
    const inputDecimals = aToB ? tokenXDecimals : tokenYDecimals;
    const outputDecimals = aToB ? tokenYDecimals : tokenXDecimals;

    // spotOutPerIn: this pool's executable spot as OUT-per-IN, fee-EXCLUSIVE, for
    // routePreGate's top-price round trip. pairMidPrice is always quote-per-base
    // (getPoolMidCanonical), so selling base => mid, selling quote => 1/mid — the
    // same sellingBase test computeLegDirectionalEdge uses. Left undefined if the
    // pool has no usable mid; the gate then reports top-uncomputable, never guesses.
    const _pairBase = p.pairBaseMint ?? pool.pairBaseMint ?? null;
    const _midQpB = Number(p.pairMidPrice ?? pool.pairMidPrice);
    let _spotOutPerIn;
    if (_pairBase && Number.isFinite(_midQpB) && _midQpB > 0) {
        _spotOutPerIn = (tokenInMint === _pairBase) ? _midQpB : (1 / _midQpB);
    }

    const leg = {
        // FIX 8: spread original pool FIRST so tickArrays/remainingAccounts survive
        ...pool,
        // then canonical normalisation overrides type/mathType/dexType correctly
        ...p,
        // explicit routing fields last (highest priority)
        poolAddress: getPoolAddress(p) || getPoolAddress(pool),
        address: getPoolAddress(p) || getPoolAddress(pool),
        tokenInMint,
        tokenOutMint,
        inputMint: tokenInMint,
        outputMint: tokenOutMint,
        spotOutPerIn: _spotOutPerIn,
        swapForY: aToB,
        aToB,
        swapDirection: aToB ? 'A_TO_B' : 'B_TO_A',
        direction: aToB ? 'A_TO_B' : 'B_TO_A',
        inputDecimals,
        outputDecimals,
        inDecimals: inputDecimals,
        outDecimals: outputDecimals,
        routeId: meta.routeId || null,
        routePath: meta.routePath || null,
        routeIndex: meta.routeIndex ?? null,
        triangleIndex: meta.triangleIndex ?? null,
        routeTotalFeeBps: meta.routeTotalFeeBps ?? 0,
        legIndex: meta.legIndex ?? null,
        label: meta.label || null,
        routeScore: meta.routeScore ?? null,
        directionalEdgeBps: meta.directionalEdgeBps ?? null,
        _divergenceMeta: meta.divergenceMeta || null,
    };

    const contract = validateRouteLegContract(leg);
    if (!contract.valid) leg.routeLegContractWarning = contract.missing;
    return leg;
}

/**
 * FIX 9: minRouteScore + minNetSignalBps pre-filter options added.
 *
 * New options:
 *   minRouteScore       (default -Infinity)  Reject route if combined leg score < this.
 *   minNetSignalBps     (default null)        Reject if (directionalEdge - totalFee) < this.
 */
function buildDivergenceAwareRoutes(poolsAB, poolsBC, poolsCA, meta = {}) {
    const tokenA = String(meta.tokenA || SOL);
    const tokenB = String(meta.tokenB || '');
    const tokenC = String(meta.tokenC || '');
    if (!tokenB || !tokenC) throw new Error('buildDivergenceAwareRoutes requires tokenB and tokenC');

    const maxRoutesPerTriangle = Math.max(1, Number(meta.maxRoutesPerTriangle || 3));
    const topKPerLeg = Math.max(1, Number(meta.topKPerLeg || maxRoutesPerTriangle));
    const scoringOptions = meta.scoringOptions || {};
    const triangleIndex = Number(meta.triangleIndex || 0);
    const routePath = meta.routePath || `${shortMint(tokenA)} -> ${shortMint(tokenB)} -> ${shortMint(tokenC)} -> ${shortMint(tokenA)}`;

    // FIX 9: profitability thresholds
    const minRouteScore = toFiniteNumber(meta.minRouteScore, -Infinity);
    const minNetSignalBps = meta.minNetSignalBps != null ? Number(meta.minNetSignalBps) : null;

    const topAB = pickTopKForLeg(poolsAB, tokenA, topKPerLeg, scoringOptions);
    const topBC = pickTopKForLeg(poolsBC, tokenB, topKPerLeg, scoringOptions);
    const topCA = pickTopKForLeg(poolsCA, tokenC, topKPerLeg, scoringOptions);
    if (!topAB.length || !topBC.length || !topCA.length) return [];

    const candidates = [];
    for (const ab of topAB) {
        for (const bc of topBC) {
            for (const ca of topCA) {
                const directionalEdgeBps = Number((ab.directionalBps + bc.directionalBps + ca.directionalBps).toFixed(4));
                const totalFeeBps = Number((ab.feeBps + bc.feeBps + ca.feeBps).toFixed(4));
                const routeScore = Number((ab.score + bc.score + ca.score).toFixed(4));
                const netSignalBps = Number((directionalEdgeBps - totalFeeBps).toFixed(4));

                // FIX 9: reject before collecting if below thresholds
                if (routeScore < minRouteScore) continue;
                if (minNetSignalBps !== null && netSignalBps < minNetSignalBps) continue;

                candidates.push({ ab, bc, ca, routeScore, directionalEdgeBps, totalFeeBps, netSignalBps });
            }
        }
    }

    candidates.sort((a, b) => b.routeScore - a.routeScore || a.totalFeeBps - b.totalFeeBps);

    const seen = new Set();
    const out = [];
    for (const entry of candidates) {
        const key = [entry.ab, entry.bc, entry.ca].map((x) => getPoolAddress(x.pool)).join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        const routeIndex = out.length + 1;
        const routeId = `tri-${triangleIndex || 0}-${routeIndex}`;
        const divergenceMeta = {
            routeScore: entry.routeScore,
            directionalEdgeBps: entry.directionalEdgeBps,
            totalFeeBps: entry.totalFeeBps,
            netSignalBps: entry.netSignalBps,
            legs: [entry.ab, entry.bc, entry.ca].map((x, i) => ({
                legIndex: i + 1,
                poolAddress: getPoolAddress(x.pool),
                score: Number(x.score.toFixed(4)),
                directionalBps: x.directionalBps,
                deviationBps: x.deviationBps,
                divergenceBps: x.divergenceBps,
                feeBps: x.feeBps,
                comparable: x.comparable,
            })),
        };

        const mkMeta = (legIndex, label) => ({
            routeId,
            routePath,
            routeIndex,
            triangleIndex,
            routeTotalFeeBps: entry.totalFeeBps,
            legIndex,
            label,
            routeScore: entry.routeScore,
            directionalEdgeBps: entry.directionalEdgeBps,
            divergenceMeta,
        });

        out.push([
            fallbackBuildRouteLeg(entry.ab.pool, tokenA, tokenB, mkMeta(1, 'A-B')),
            fallbackBuildRouteLeg(entry.bc.pool, tokenB, tokenC, mkMeta(2, 'B-C')),
            fallbackBuildRouteLeg(entry.ca.pool, tokenC, tokenA, mkMeta(3, 'C-A')),
        ]);

        if (out.length >= maxRoutesPerTriangle) break;
    }

    return out;
}

/**
 * Authoritative route builder for divergenceScanner.js / 03_ROUTED.json.
 *
 * Keep this path separate from utilities/divergenceAwareRouteBuilder.js. That
 * standalone module is only used by poolFetchCustom_raw.js as an optional
 * pool-selection triangle verifier; this built-in path preserves scanner
 * metadata, min-net filters, stale-mid clamps, and execution-ready leg fields.
 *
 * FIX 9 options forwarded: minRouteScore + minNetSignalBps.
 */

function buildAllDivergenceAwareRoutesForGraph(pools = [], options = {}) {
    if (options.enableQuarantine) {
        options = { ...options, __quarantine: loadQuarantine(options.quarantineFile) };
    }
    const tokenA = String(options.tokenA || SOL);
    const { pairMap, mintToSymbol } = buildPairMap(pools);
    const targets = Array.isArray(options.targets) && options.targets.length
        ? new Set(options.targets.map(String))
        : null;
    const tokenBs = targets ? Array.from(targets) : findConnectedMints(pairMap, tokenA);
    const triangles = [];
    const chainRoutes = [];
    let candidateTriangleCount = 0;
    const sym = (mint) => mintToSymbol.get(mint) || symbolFor(mint);

    for (const tokenB of tokenBs) {
        for (const tokenC of findConnectedMints(pairMap, tokenB)) {
            if (!tokenC || tokenC === tokenA || tokenC === tokenB) continue;
            const poolsAB = getPoolsForPair(pairMap, tokenA, tokenB);
            const poolsBC = getPoolsForPair(pairMap, tokenB, tokenC);
            const poolsCA = getPoolsForPair(pairMap, tokenC, tokenA);
            if (!poolsAB.length || !poolsBC.length || !poolsCA.length) continue;
            candidateTriangleCount++;

            const routePath = `${sym(tokenA)} -> ${sym(tokenB)} -> ${sym(tokenC)} -> ${sym(tokenA)}`;
            const routes = buildDivergenceAwareRoutes(poolsAB, poolsBC, poolsCA, {
                ...options,
                tokenA,
                tokenB,
                tokenC,
                routePath,
                triangleIndex: triangles.length + 1,
            });
            if (!routes.length) continue;

            triangles.push({
                path: routePath,
                tokenA,
                tokenB,
                tokenC,
                poolsAB: poolsAB.length,
                poolsBC: poolsBC.length,
                poolsCA: poolsCA.length,
                chainRouteCount: routes.length,
            });
            chainRoutes.push(...routes);
        }
    }
    if (options.enableTwoLeg) {
        const twoLeg = buildTwoLegRoundTripsForGraph(pools, options);
        chainRoutes.push(...twoLeg.chainRoutes);
        triangles.push(...twoLeg.triangles);
    }

    chainRoutes.sort((a, b) => routeSortScore(b) - routeSortScore(a));

    return {
        tokenA,
        candidateTriangleCount,
        triangleCount: triangles.length,
        chainRouteCount: chainRoutes.length,
        triangles,
        chainRoutes,
    };
}

function buildTwoLegRoundTripsForGraph(pools = [], options = {}) {
    const tokenA = String(options.tokenA || (typeof SOL !== 'undefined' ? SOL : 'So11111111111111111111111111111111111111112'));
    const { pairMap, mintToSymbol } = buildPairMap(pools);
    const sym = (mint) => mintToSymbol.get(mint) || symbolFor(mint);

    // optional restriction to a target set (same semantics as the 3-leg builder)
    const targets = Array.isArray(options.targets) && options.targets.length
        ? new Set(options.targets.map(String))
        : null;
    const tokenBs = targets ? Array.from(targets) : findConnectedMints(pairMap, tokenA);

    const scoringOptions = options.scoringOptions || {};
    const topKPerLeg = Math.max(2, Number(options.twoLegTopK || options.topKPerLeg || 4));
    const minNetSignalBps = options.twoLegMinNetSignalBps != null
        ? Number(options.twoLegMinNetSignalBps)
        : (options.minNetSignalBps != null ? Number(options.minNetSignalBps) : null);

    const triangles = [];
    const chainRoutes = [];
    let pairIndex = 0;

    for (const tokenB of tokenBs) {
        if (!tokenB || tokenB === tokenA) continue;

        // All pools that trade tokenA<->tokenB, scored & sorted by leg quality.
        // pickTopKForLeg drops stale pools and orders best-first, identical to
        // the 3-leg path, so 2-leg legs are held to the same freshness bar.
        const poolsAB = getPoolsForPair(pairMap, tokenA, tokenB);
        if (!poolsAB || poolsAB.length < 2) continue; // need >= 2 venues to round-trip

        const buyLeg = pickTopKForLeg(poolsAB, tokenA, topKPerLeg, scoringOptions);   // tokenA -> tokenB
        const sellPoolsBA = getPoolsForPair(pairMap, tokenB, tokenA);
        const sellLeg = pickTopKForLeg(sellPoolsBA, tokenB, topKPerLeg, scoringOptions); // tokenB -> tokenA
        if (!buyLeg.length || !sellLeg.length) continue;

        pairIndex++;
        const routePath = `${sym(tokenA)} -> ${sym(tokenB)} -> ${sym(tokenA)}`;

        const candidates = [];
        for (const buy of buyLeg) {
            for (const sell of sellLeg) {
                // Must be two DIFFERENT pools — same pool round-trip is just a
                // wash that pays 2x fee for zero displacement.
                if (getPoolAddress(buy.pool) === getPoolAddress(sell.pool)) continue;

                // directionalBps already encodes buy-low / sell-high sign per leg
                // (computeLegDirectionalEdge). Summed, it's the captured spread.
                const directionalEdgeBps = Number((buy.directionalBps + sell.directionalBps).toFixed(4));
                const totalFeeBps = Number((buy.feeBps + sell.feeBps).toFixed(4));
                const routeScore = Number((buy.score + sell.score).toFixed(4));
                const netSignalBps = Number((directionalEdgeBps - totalFeeBps).toFixed(4));

                if (minNetSignalBps !== null && netSignalBps < minNetSignalBps) continue;

                candidates.push({ buy, sell, routeScore, directionalEdgeBps, totalFeeBps, netSignalBps });
            }
        }
        if (!candidates.length) continue;

        // best spread first, then cheapest fee as tiebreak (mirror 3-leg sort)
        candidates.sort((a, b) => b.routeScore - a.routeScore || a.totalFeeBps - b.totalFeeBps);

        const maxPerPair = Math.max(1, Number(options.twoLegMaxPerPair || options.maxRoutesPerTriangle || 3));
        const seen = new Set();
        let emitted = 0;

        for (const entry of candidates) {
            const key = `${getPoolAddress(entry.buy.pool)}|${getPoolAddress(entry.sell.pool)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const routeIndex = emitted + 1;
            const routeId = `rt2-${pairIndex}-${routeIndex}`;

            const divergenceMeta = {
                routeScore: entry.routeScore,
                directionalEdgeBps: entry.directionalEdgeBps,
                totalFeeBps: entry.totalFeeBps,
                netSignalBps: entry.netSignalBps,
                roundTrip: true,
                legs: [entry.buy, entry.sell].map((x, i) => ({
                    legIndex: i + 1,
                    poolAddress: getPoolAddress(x.pool),
                    score: Number(x.score.toFixed(4)),
                    directionalBps: x.directionalBps,
                    deviationBps: x.deviationBps,
                    divergenceBps: x.divergenceBps,
                    feeBps: x.feeBps,
                    comparable: x.comparable,
                })),
            };

            const mkMeta = (legIndex, label) => ({
                routeId,
                routePath,
                routeIndex,
                triangleIndex: pairIndex,
                routeKind: 'two-leg',          // tag so reports can distinguish
                roundTrip: true,
                routeTotalFeeBps: entry.totalFeeBps,
                legIndex,
                label,
                routeScore: entry.routeScore,
                directionalEdgeBps: entry.directionalEdgeBps,
                divergenceMeta,
            });

            // SAME builder the 3-leg path uses — guarantees identical leg shape
            // (decimals, swapForY, spotOutPerIn, tickArrays, pair* stamps, etc.)
            chainRoutes.push([
                fallbackBuildRouteLeg(entry.buy.pool, tokenA, tokenB, mkMeta(1, 'BUY')),
                fallbackBuildRouteLeg(entry.sell.pool, tokenB, tokenA, mkMeta(2, 'SELL')),
            ]);

            emitted++;
            if (emitted >= maxPerPair) break;
        }

        if (emitted > 0) {
            triangles.push({
                path: routePath,
                kind: 'two-leg',
                tokenA,
                tokenB,
                tokenC: null,
                poolsAB: poolsAB.length,
                chainRouteCount: emitted,
            });
        }
    }

    return {
        tokenA,
        candidateTriangleCount: pairIndex,
        triangleCount: triangles.length,
        chainRouteCount: chainRoutes.length,
        triangles,
        chainRoutes,
    };
}

/* Exported only so a standalone unit test can require() and exercise the pure
 * scoring logic with mocked helpers. The scanner itself uses the pasted copy. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildTwoLegRoundTripsForGraph };
}

function buildRoutePrepForOutput(pools, options = {}) {
    if (!options.buildRoutes) return null;

    let routePrep = buildAllDivergenceAwareRoutesForGraph(pools, {
        tokenA: options.tokenA,
        targets: options.targets,
        maxRoutesPerTriangle: options.maxRoutesPerTriangle,
        topKPerLeg: options.topKPerLeg,
        minRouteScore: options.minRouteScore,    // FIX 9
        minNetSignalBps: options.minNetSignalBps,  // FIX 9
        scoringOptions: options.scoringOptions || {}, // stale-mid clamp options
    });

    const hasExplicitRouteSignalFilter = options.minRouteScore != null || options.minNetSignalBps != null;
    const shouldFallbackToConnectedRoutes = routePrep.chainRouteCount === 0
        && Number(routePrep.candidateTriangleCount || 0) > 0
        && !hasExplicitRouteSignalFilter
        && options.allowRouteFallback !== false;

    if (shouldFallbackToConnectedRoutes) {
        const fallbackScoringOptions = {
            ...(options.scoringOptions || {}),
            directionalWeight: 0,
            positionWeight: 0,
            liquidityWeight: toFiniteNumber(options.scoringOptions?.liquidityWeight, 1),
        };
        const fallbackRoutePrep = buildAllDivergenceAwareRoutesForGraph(pools, {
            tokenA: options.tokenA,
            targets: options.targets,
            maxRoutesPerTriangle: options.maxRoutesPerTriangle,
            topKPerLeg: options.topKPerLeg,
            minRouteScore: null,
            minNetSignalBps: null,
            scoringOptions: fallbackScoringOptions,
        });

        if (fallbackRoutePrep.chainRouteCount > 0) {
            routePrep = {
                ...fallbackRoutePrep,
                routeFilterFallback: {
                    reason: 'connected routes exported after signal filters produced zero routes',
                    filteredCandidateTriangleCount: routePrep.candidateTriangleCount,
                    filteredTriangleCount: routePrep.triangleCount,
                    filteredChainRouteCount: routePrep.chainRouteCount,
                    originalMinRouteScore: options.minRouteScore ?? null,
                    originalMinNetSignalBps: options.minNetSignalBps ?? null,
                },
            };
        }
    }

    return {
        source: options.input || null,
        generatedAt: new Date().toISOString(),
        tokenA: options.tokenA,
        targets: Array.isArray(options.targets) ? options.targets : [],
        candidateTriangleCount: routePrep.candidateTriangleCount,
        triangleCount: routePrep.triangleCount,
        chainRouteCount: routePrep.chainRouteCount,
        triangles: routePrep.triangles,
        chainRoutes: routePrep.chainRoutes,
        routeFilterFallback: routePrep.routeFilterFallback || null,
        pools,
    };
}

/* -------------------------------------------------------------------------- */
/*                   FIX 10 — Route quality diagnosis                        */
/* -------------------------------------------------------------------------- */

/**
 * diagnoseRouteQuality — counts single-pool / zero-comparable legs across all
 * chainRoutes and returns a quality summary.
 *
 * @param {Array} chainRoutes   Array of 3-leg route arrays from buildRoutePrepForOutput.
 * @returns {Object}  { totalRoutes, totalLegs, singlePoolLegs, singlePoolPct,
 *                      neutralRoutes, posRoutes, negRoutes,
 *                      pairsNeedingMorePools }
 */
function diagnoseRouteQuality(chainRoutes = []) {
    let totalLegs = 0;
    let singlePoolLegs = 0;
    const neutralRoutes = [];
    const posRoutes = [];
    const negRoutes = [];
    const pairCoverage = new Map();   // pair label → max peer count seen

    for (const route of chainRoutes) {
        const legs = Array.isArray(route) ? route : (Array.isArray(route?.legs) ? route.legs : []);
        let routeNeutral = true;

        for (const leg of legs) {
            totalLegs++;
            const cmp = Number(leg.pairComparablePeerCount || 0);
            if (cmp < 2) singlePoolLegs++;

            const peerCount = Number(leg.pairPeerCount || 0);
            const rawLabel = leg.pairLabel || leg.pairCanonical || '?';
            const label = rawLabel.includes('|')
                ? rawLabel.split('|').map((m) => symbolFor(m)).join('/')
                : rawLabel;
            if (!pairCoverage.has(label) || pairCoverage.get(label) < peerCount) {
                pairCoverage.set(label, peerCount);
            }
            if (cmp >= 2) routeNeutral = false;
        }

        const first = legs[0] || {};
        const meta = first._divergenceMeta || {};
        const net = meta.netSignalBps != null
            ? toFiniteNumber(meta.netSignalBps, 0)
            : toFiniteNumber(meta.directionalEdgeBps ?? first.directionalEdgeBps, 0) -
            toFiniteNumber(meta.totalFeeBps ?? first.routeTotalFeeBps, 0);

        const entry = { routeId: first.routeId || '?', routePath: first.routePath || '?', net };
        if (routeNeutral) neutralRoutes.push(entry);
        else if (net > 0) posRoutes.push(entry);
        else negRoutes.push(entry);
    }

    const pairsNeedingMorePools = Array.from(pairCoverage.entries())
        .filter(([, cnt]) => cnt < 2)
        .map(([label]) => label)
        .sort();

    return {
        totalRoutes: chainRoutes.length,
        totalLegs,
        singlePoolLegs,
        singlePoolPct: totalLegs > 0 ? Number((singlePoolLegs / totalLegs * 100).toFixed(1)) : 0,
        neutralRoutes: neutralRoutes.length,
        posRoutes: posRoutes.length,
        negRoutes: negRoutes.length,
        pairsNeedingMorePools,
        topPositiveRoutes: posRoutes.sort((a, b) => b.net - a.net).slice(0, 5),
    };
}

/**
 * printRouteQualityWarning — prints a concise quality summary to stdout.
 * Called automatically from the CLI before the route analysis table.
 */
function printRouteQualityWarning(chainRoutes = [], options = {}) {
    const q = diagnoseRouteQuality(chainRoutes);
    const quiet = Boolean(options.quiet);

    console.log('\n📊 ROUTE QUALITY SUMMARY');
    console.log(`   Total routes : ${q.totalRoutes}  (positive netSignal: ${q.posRoutes}, negative: ${q.negRoutes}, fully neutral: ${q.neutralRoutes})`);
    console.log(`   Neutral legs : ${q.singlePoolLegs}/${q.totalLegs} (${q.singlePoolPct}%) — only 1 pool per pair, no divergence measurable`);

    if (q.pairsNeedingMorePools.length > 0 && !quiet) {
        console.log(`\n   ⚠  The following ${q.pairsNeedingMorePools.length} pairs have < 2 pools — add more sources to enable divergence scoring:`);
        for (const label of q.pairsNeedingMorePools.slice(0, 20)) {
            console.log(`      • ${label}`);
        }
        if (q.pairsNeedingMorePools.length > 20) {
            console.log(`      … and ${q.pairsNeedingMorePools.length - 20} more`);
        }
    }

    if (q.posRoutes > 0) {
        console.log('\n   ✅ Top positive divergence-signal routes (netSignalBps, not simulated profit):');
        for (const r of q.topPositiveRoutes) {
            console.log(`      ${r.routeId}  ${r.routePath}  net=${r.net.toFixed(2)}b`);
        }
    } else {
        console.log('\n   ⚠  No routes with positive netSignalBps — divergence signal is insufficient to cover fees.');
        console.log('      Tip: expand pool universe or lower fee tiers for non-USDC legs.');
    }
}

/* -------------------------------------------------------------------------- */
/*                          Reporting / CLI helpers                           */
/* -------------------------------------------------------------------------- */

function buildDivergenceReport(pools = []) {
    const groups = new Map();
    for (const pool of pools) {
        const key = pool.pairCanonical;
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pool);
    }

    const rows = Array.from(groups.entries()).map(([key, members]) => {
        const first = members[0];
        return {
            pair: key,
            pairLabel: first.pairLabel || key,
            base: first.pairBaseMint,
            quote: first.pairQuoteMint,
            baseSymbol: first.pairBaseSymbol,
            quoteSymbol: first.pairQuoteSymbol,
            poolCount: members.length,
            comparablePoolCount: first.pairComparablePeerCount,
            divergenceBps: first.pairDivergenceBps,
            rawDivergenceBps: first.pairRawDivergenceBps,
            unsafeHeterogeneous: first.pairDivergenceUnsafeHeterogeneous,
            medianMid: first.pairMedianMid,
            bestMid: first.pairBestMid,
            worstMid: first.pairWorstMid,
            pools: members.map((p) => {
                const c = getCanonical(p);
                return {
                    addr: shortMint(p.poolAddress || p.address),
                    dex: c.dex || p.dex || p.dexType,
                    type: c.type || p.type,
                    feeBps: c.feeBps != null ? c.feeBps : p.feeBps,
                    mid: p.pairMidPrice,
                    deviationBps: p.pairMidDeviationBps,
                    outlier: p.pairMidOutlier === true,
                    midSource: p.pairMidExtractionSource,
                    comparable: p.pairDivergenceComparable,
                };
            }),
        };
    });

    rows.sort((a, b) => b.divergenceBps - a.divergenceBps);
    return rows;
}

function printDivergenceReport(pools = [], options = {}) {
    const limit = Number(options.limit || 50);
    const minBps = Number(options.minBps || 0);
    const rows = buildDivergenceReport(pools).filter((r) => r.divergenceBps >= minBps);

    // Also report unannotated pools
    const unannotated = pools.filter((p) => !p.pairCanonical);
    if (unannotated.length > 0) {
        console.log(`\n  ⚠  ${unannotated.length} pool(s) have no pairCanonical — annotation was skipped:`);
        for (const p of unannotated.slice(0, 10)) {
            const { xMint, yMint } = extractPoolMints(p);
            console.log(`     ${shortMint(getPoolAddress(p))}  ${p.dex || '?'}/${p.type || '?'}  xMint=${shortMint(xMint) || 'MISSING'}  yMint=${shortMint(yMint) || 'MISSING'}`);
        }
        if (unannotated.length > 10) console.log(`     … and ${unannotated.length - 10} more`);
    }

    console.log('\n📐 PAIR DIVERGENCE REPORT');
    console.log('───────────────────────────────────────────────────────────────────────────');
    console.log(`${rows.length} pairs with divergence >= ${minBps} bps (showing top ${limit})\n`);
    console.log('PAIR                            | POOLS | CMP | DIVERGE | MEDIAN MID | FLAGS');
    console.log('────────────────────────────────┼───────┼─────┼─────────┼────────────┼──────');

    for (const row of rows.slice(0, limit)) {
        const label = row.pairLabel.length > 30 ? `${row.pairLabel.slice(0, 27)}..` : row.pairLabel;
        const divLabel = `${row.divergenceBps.toFixed(2).padStart(6)}b`;
        const midLabel = row.medianMid ? Number(row.medianMid).toExponential(4) : 'n/a';
        const flags = row.unsafeHeterogeneous ? ' ⚠UNSAFE' : '';
        console.log(`${label.padEnd(32)}|${String(row.poolCount).padStart(6)} |${String(row.comparablePoolCount).padStart(4)} | ${divLabel} | ${midLabel}${flags}`);
        if (options.verbose) {
            for (const p of row.pools) {
                const dev = p.deviationBps != null
                    ? `${p.deviationBps > 0 ? '+' : ''}${p.deviationBps.toFixed(2)}b`
                    : 'n/a';
                const mid = p.mid != null ? Number(p.mid).toExponential(4) : 'n/a';
                console.log(
                    `    ${p.addr.padEnd(14)} ${(p.dex || '').padEnd(8)} ${(p.type || '').padEnd(10)} ` +
                    `fee=${String(p.feeBps).padStart(3)}b mid=${mid} dev=${dev} via=${p.midSource}` +
                    `${p.outlier ? ' OUTLIER' : ''}${p.comparable ? '' : ' NO-COMP'}`
                );
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                    Divergence breakdown explain helpers                    */
/* -------------------------------------------------------------------------- */

function _fmt(n, dp = 4) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    return Number(n).toFixed(dp);
}
function _exp(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    return Number(n).toExponential(6);
}
function _shortAddr(a) {
    const s = String(a || '');
    return s.length > 12 ? `${s.slice(0, 6)}..${s.slice(-4)}` : s;
}

function explainPoolDeviation(pools = []) {
    const byPair = new Map();
    for (const p of pools) {
        const key = p.pairCanonical || p.pairLabel;
        if (!key) continue;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(p);
    }

    console.log('\n══════════════════════════════════════════════════════════════════════════');
    console.log('DIVERGENCE BREAKDOWN — PER-POOL DEVIATION TRACE');
    console.log('  devBps = (mid - median) / median * 10000   [signed; 0 if a guard fires]');
    console.log('══════════════════════════════════════════════════════════════════════════');

    for (const [key, group] of byPair.entries()) {
        if (group.length < 2) continue;
        const label = group[0].pairLabel || key;
        const median = group[0].pairMedianMid;
        console.log(`\nPAIR ${label}   median=${_exp(median)}   venues=${group.length}   comparablePeers=${group[0].pairComparablePeerCount}`);
        console.log('  pool           src        mid             mid-med          /med           *1e4=devBps   cmp inC out  stamped');
        for (const p of group) {
            const mid = p.pairMidPrice;
            const med = p.pairMedianMid;
            const diff = (mid != null && med != null) ? (mid - med) : null;
            const ratio = (diff != null && med) ? diff / med : null;
            const handDev = (ratio != null) ? ratio * 10000 : null;
            const stamped = p.pairMidDeviationBps;
            const cmp = p.pairDivergenceComparable ? 'Y' : 'n';
            const out = p.pairMidOutlier ? 'Y' : 'n';
            const inC = (!p.pairMidOutlier && p.pairDivergenceComparable) ? 'Y' : 'n';

            let note = '';
            if (stamped !== 0 && handDev != null && Math.abs(handDev - stamped) > 0.5) {
                note = '  <-- MISMATCH hand vs stamped!';
            } else if (stamped === 0 && handDev != null && Math.abs(handDev) > 0.5) {
                const why = !p.pairDivergenceComparable ? 'not-comparable'
                    : p.pairMidOutlier ? 'outlier(out-of-cluster)'
                        : (med == null || !(med > 0)) ? 'no-median'
                            : 'in-compare?';
                note = `  <-- zeroed: ${why} (raw devBps≈${_fmt(handDev, 2)})`;
            }

            console.log(
                `  ${_shortAddr(p.poolAddress || p.address).padEnd(13)} ` +
                `${String(p.pairMidExtractionSource || '?').padEnd(9)} ` +
                `${_exp(mid).padEnd(15)} ${(diff != null ? _exp(diff) : 'n/a').padEnd(16)} ` +
                `${(ratio != null ? _fmt(ratio, 8) : 'n/a').padEnd(14)} ${_fmt(handDev, 2).padStart(10)}   ` +
                `${cmp}   ${inC}   ${out}   ${_fmt(stamped, 2).padStart(8)}${note}`
            );
        }
    }
    console.log('');
}

function explainRouteSignal(route) {
    const legs = Array.isArray(route) ? route : (route.legs || []);
    if (!legs.length) return;

    const meta = (Array.isArray(route) ? route[0]?._divergenceMeta : route._divergenceMeta) || {};
    const routePath = legs.map((l, i) =>
        i === 0 ? `${l.inSym || symbolFor(l.tokenInMint)}->${l.outSym || symbolFor(l.tokenOutMint)}`
            : `${l.outSym || symbolFor(l.tokenOutMint)}`
    ).join(' ');

    console.log('\n── ROUTE SIGNAL TRACE ──────────────────────────────────────────────────');
    console.log(`   ${meta.routeId || route.routeId || '(route)'}  ${routePath}  kind=${meta.routeKind || (legs.length === 2 ? 'two-leg' : 'triangle')}`);

    let sumDirectional = 0;
    let sumFee = 0;
    let sumImpact = 0;
    let allNeutral = true;
    let signSuspect = false;

    legs.forEach((leg, i) => {
        const dev = Number(leg.deviationBps ?? leg._divergenceMeta?.deviationBps ?? 0);
        const dir = Number(leg.directionalBps ?? leg.edgeBps ?? 0);
        const fee = Number(leg.feeBps ?? 0);
        const impact = Number(leg.marketDepthImpactBps ?? leg.impactBps ?? 0);
        const sellingBase = leg.sellingBase ?? (dir !== 0 && dev !== 0 ? (Math.sign(dir) === Math.sign(dev)) : null);

        if (dir !== 0) allNeutral = false;
        if (dev !== 0 && dir !== 0) {
            const expectSign = sellingBase ? Math.sign(dev) : -Math.sign(dev);
            if (Math.sign(dir) !== expectSign) signSuspect = true;
        }

        sumDirectional += dir;
        sumFee += fee;
        sumImpact += Number.isFinite(impact) ? impact : 0;

        const action = dir === 0 ? 'neutral' : (dir > 0 ? (sellingBase ? 'sellHigh' : 'buyLow') : (sellingBase ? 'sellLow' : 'buyHigh'));
        console.log(
            `   leg${i + 1} ${(leg.dex || leg.dexType || '?').toString().padEnd(9)} ` +
            `dev=${_fmt(dev, 2).padStart(8)}  sellingBase=${String(sellingBase).padEnd(5)}  ` +
            `-> directional=${_fmt(dir, 2).padStart(8)} (${action})  fee=${_fmt(fee, 2)}  impact=${_fmt(impact, 2)}`
        );
    });

    const directionalEdge = Number(sumDirectional.toFixed(4));
    const net = Number((directionalEdge - sumFee).toFixed(4));
    const captured = Number((directionalEdge - sumFee - sumImpact).toFixed(4));

    let verdict;
    if (signSuspect) verdict = 'SIGN-SUSPECT (directional opposes deviation sign — check sellingBase)';
    else if (allNeutral) verdict = 'all-legs-neutral (no second venue / NO-COMP) — 0 is CORRECT, not a bug';
    else if (net > 0) verdict = 'positive-edge';
    else verdict = 'edge-below-fees (real divergence, but fees exceed it)';

    console.log(`   ───`);
    console.log(`   sum directional = ${_fmt(directionalEdge, 2)}   - fees ${_fmt(sumFee, 2)} = netSignal ${_fmt(net, 2)}   - impact ${_fmt(sumImpact, 2)} = captured ${_fmt(captured, 2)}`);
    console.log(`   stamped: netSignalBps=${_fmt(meta.netSignalBps, 2)}  directionalEdgeBps=${_fmt(meta.directionalEdgeBps, 2)}  totalFeeBps=${_fmt(meta.totalFeeBps, 2)}`);
    if (meta.netSignalBps != null && Math.abs(Number(meta.netSignalBps) - net) > 0.5) {
        console.log(`   <-- MISMATCH: recomputed net ${_fmt(net, 2)} != stamped ${_fmt(meta.netSignalBps, 2)}  (calc drift — investigate)`);
    }
    console.log(`   VERDICT: ${verdict}`);
}

/* -------------------------------------------------------------------------- */
/*                         Route analysis table helpers                       */
/* -------------------------------------------------------------------------- */

function csvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatBps(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toFixed(Math.abs(n) >= 100 ? 1 : 2);
}

function legSymbolForMint(leg = {}, mint) {
    const text = String(mint || '');
    if (!text) return '?';
    if (text === String(leg.tokenXMint || leg.baseMint || leg.mintA || '')) {
        return symbolFor(text, leg.tokenXSymbol || leg.baseSymbol);
    }
    if (text === String(leg.tokenYMint || leg.quoteMint || leg.mintB || '')) {
        return symbolFor(text, leg.tokenYSymbol || leg.quoteSymbol);
    }
    return symbolFor(text, leg.inputSymbol || leg.outputSymbol);
}

function legPairLabel(leg = {}) {
    const inSym = legSymbolForMint(leg, leg.tokenInMint || leg.inputMint);
    const outSym = legSymbolForMint(leg, leg.tokenOutMint || leg.outputMint);
    return `${inSym}/${outSym}`;
}

function legActionLabel(leg = {}, directional = null) {
    const d = directional || computeLegDirectionalEdge(leg, leg.tokenInMint || leg.inputMint);
    if (!d.comparable || d.directionalBps === 0) return 'neutral';
    if (d.sellingBase) return d.directionalBps > 0 ? 'sellHigh' : 'sellLow';
    return d.directionalBps > 0 ? 'buyLow' : 'buyHigh';
}

function compactLegSummary(leg = {}) {
    const directional = computeLegDirectionalEdge(leg, leg.tokenInMint || leg.inputMint);
    const score = scoreLegPool(leg, leg.tokenInMint || leg.inputMint);
    const type = String(leg.mathType || leg.type || 'unknown').toUpperCase();
    const pair = legPairLabel(leg);
    const action = legActionLabel(leg, directional);
    return `${type} ${pair} ${action} edge=${formatBps(directional.directionalBps)}b div=${formatBps(directional.divergenceBps)}b fee=${formatBps(score.feeBps)}b`;
}

function buildRouteAnalysisRows(routePrep = {}, options = {}) {
    const routes = Array.isArray(routePrep.chainRoutes) ? routePrep.chainRoutes : [];
    const rows = routes.map((route, index) => {
        const legs = Array.isArray(route) ? route : (Array.isArray(route?.legs) ? route.legs : []);
        const first = legs[0] || {};
        const meta = first._divergenceMeta || {};

        const legDetails = [0, 1, 2].map((i) => {
            const leg = legs[i] || {};
            const directional = computeLegDirectionalEdge(leg, leg.tokenInMint || leg.inputMint);
            const score = scoreLegPool(leg, leg.tokenInMint || leg.inputMint);
            return {
                legIndex: i + 1,
                type: String(leg.mathType || leg.type || 'unknown').toUpperCase(),
                pair: legPairLabel(leg),
                action: legActionLabel(leg, directional),
                edgeBps: Number(directional.directionalBps || 0),
                divergenceBps: Number(directional.divergenceBps || 0),
                deviationBps: Number(directional.deviationBps || 0),
                feeBps: Number(score.feeBps || 0),
                score: Number(score.score || 0),
                comparable: Boolean(directional.comparable),
                peerCount: Number(leg.pairPeerCount || 0),
                comparablePeerCount: Number(leg.pairComparablePeerCount || 0),
                summary: compactLegSummary(leg),
            };
        });

        const routeScore = toFiniteNumber(first.routeScore ?? meta.routeScore, routeSortScore(legs));
        const directionalEdgeBps = toFiniteNumber(first.directionalEdgeBps ?? meta.directionalEdgeBps, legDetails.reduce((s, l) => s + l.edgeBps, 0));
        const totalFeeBps = toFiniteNumber(first.routeTotalFeeBps ?? meta.totalFeeBps, legDetails.reduce((s, l) => s + l.feeBps, 0));
        const netSignalBps = Number((directionalEdgeBps - totalFeeBps).toFixed(4));

        return {
            rank: index + 1,
            routeId: first.routeId || `route-${index + 1}`,
            routePath: first.routePath || legs.map((l) => symbolFor(l.tokenInMint || l.inputMint)).join(' -> '),
            routeScore,
            directionalEdgeBps,
            totalFeeBps,
            netSignalBps,
            legs: legDetails,
        };
    });

    rows.sort((a, b) => b.routeScore - a.routeScore || b.netSignalBps - a.netSignalBps);
    const limit = Number(options.limit || options.routeAnalysisLimit || 0);
    return limit > 0 ? rows.slice(0, limit) : rows;
}

function printRouteAnalysisTable(routePrep = {}, options = {}) {
    const rows = buildRouteAnalysisRows(routePrep, options);
    if (!rows.length) {
        console.log('\nNo divergence-aware 3-leg routes to analyze.');
        return rows;
    }

    console.log('\nDIVERGENCE ROUTE SELECTION TABLE');
    console.log('Sorted by score. score is a weighted selection score; netSignal = directional edge - pool fees. Neither is simulated profit.');
    console.log('---------------------------------------------------------------------------------------------------------------------------');
    console.log('        LEG1                                      LEG2                                      LEG3');
    console.log('---------------------------------------------------------------------------------------------------------------------------');
    for (const row of rows) {
        const legText = row.legs.map((leg) => leg.summary.padEnd(40)).join('|  ');
        console.log(`${String(row.rank).padStart(2)} | ${legText} | score=${formatBps(row.routeScore)}b netSignal=${formatBps(row.netSignalBps)}b`);
    }
    return rows;
}

function writeRouteAnalysisJson(routePrep = {}, outputPath, options = {}) {
    if (!outputPath) return null;
    const routes = buildRouteAnalysisRows(routePrep, options);
    const quality = diagnoseRouteQuality(routePrep.chainRoutes || []);
    const payload = {
        generatedAt: new Date().toISOString(),
        note: 'Divergence scanner report only. netSignalBps is directional edge minus pool fees; routeScore is weighted selection score; neither is simulated execution profit.',
        input: options.input || null,
        circuitOutput: options.output || null,
        routesOutput: options.routesOutput || null,
        minNetSignalBps: options.minNetSignalBps ?? null,
        minRouteScore: options.minRouteScore ?? null,
        routeCount: routePrep.chainRouteCount || routes.length,
        triangleCount: routePrep.triangleCount || 0,
        candidateTriangleCount: routePrep.candidateTriangleCount || 0,
        quality,
        pairs: buildDivergenceReport(routePrep.pools || []),
        routes,
    };
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, safeStringify(payload));
    return payload;
}

function writeRouteAnalysisCsv(routePrep = {}, outputPath, options = {}) {
    if (!outputPath) return null;
    const rows = buildRouteAnalysisRows(routePrep, options);
    const headers = [
        'rank', 'routeId', 'routePath', 'routeScoreBps', 'directionalEdgeBps', 'totalFeeBps', 'netSignalBps',
        'leg1', 'leg1Type', 'leg1Pair', 'leg1Action', 'leg1EdgeBps', 'leg1DivergenceBps', 'leg1FeeBps', 'leg1Comparable', 'leg1PeerCount', 'leg1ComparablePeers',
        'leg2', 'leg2Type', 'leg2Pair', 'leg2Action', 'leg2EdgeBps', 'leg2DivergenceBps', 'leg2FeeBps', 'leg2Comparable', 'leg2PeerCount', 'leg2ComparablePeers',
        'leg3', 'leg3Type', 'leg3Pair', 'leg3Action', 'leg3EdgeBps', 'leg3DivergenceBps', 'leg3FeeBps', 'leg3Comparable', 'leg3PeerCount', 'leg3ComparablePeers',
    ];
    const lines = [headers.join(',')];
    for (const row of rows) {
        const values = [
            row.rank, row.routeId, row.routePath,
            row.routeScore, row.directionalEdgeBps, row.totalFeeBps, row.netSignalBps,
        ];
        for (const leg of row.legs) {
            values.push(
                leg.summary, leg.type, leg.pair, leg.action,
                leg.edgeBps, leg.divergenceBps, leg.feeBps, leg.comparable,
                leg.peerCount, leg.comparablePeerCount,
            );
        }
        lines.push(values.map(csvEscape).join(','));
    }
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
    return rows;
}

/* -------------------------------------------------------------------------- */
/*                                   CLI                                      */
/* -------------------------------------------------------------------------- */

function parseCliArgs(argv) {
    const out = {
        input: 'pools/02_ENRICHED.json',
        output: 'pools/03_CIRCUIT.json',
        minBps: 0,
        limit: 50,
        verbose: true,
        diagnose: true,
        postEnrichment: true,
        buildRoutes: true,
        routesOutput: 'pools/03_ROUTED.json',
        tokenA: SOL,
        targets: [],
        maxRoutesPerTriangle: 3,
        topKPerLeg: null,
        routeAnalysis: true,
        routeAnalysisLimit: 25,
        routeAnalysisCsv: null,
        routeAnalysisJson: null,
        minRouteScore: null,   // FIX 9
        minNetSignalBps: null,   // FIX 9
        qualityReport: true,   // FIX 10
        depthProfile: null,    // path to depth_profile.json (cached probe output)
        explainDivergence: process.env.EXPLAIN_DIVERGENCE === 'true',
        enableQuarantine: process.env.ENABLE_QUARANTINE === 'true',
        quarantineFile: process.env.QUARANTINE_FILE || '',
        enableTwoLeg: process.env.ENABLE_TWO_LEG === 'true' || args.twoLeg === true,
        twoLegMinNetSignalBps: Number(process.env.TWO_LEG_MIN_NET_BPS ?? -Infinity),
        scoringOptions: {
            maxTrustedDeviationBps: 30,
            maxLegMidDeviationBps: Number(process.env.MAX_LEG_MID_DEV_BPS ?? 40),
            feeWeight: 2,
        },    // stale-mid clamp options forwarded to leg selection
        enumerateOnly: true,  // emit routes by connectivity; let the engine rank by sim profit
    };
    const positional = [];
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const valueAfterEquals = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
        if (arg.startsWith('--in=') || arg.startsWith('--input=')) { out.input = valueAfterEquals; continue; }
        if (arg.startsWith('--out=') || arg.startsWith('--output=')) { out.output = valueAfterEquals; continue; }
        if (arg.startsWith('--min-bps=')) { out.minBps = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--limit=')) { out.limit = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--max-core-divergence-bps=')) { out.maxCoreDivergenceBps = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--routes-out=') || arg.startsWith('--routes-output=')) { out.routesOutput = valueAfterEquals; continue; }
        if (arg.startsWith('--token-a=') || arg.startsWith('--tokenA=') || arg.startsWith('--start-mint=')) { out.tokenA = valueAfterEquals; continue; }

        if (arg.startsWith('--targets=')) {
            out.targets = String(valueAfterEquals || '').split(',').map((s) => s.trim()).filter(Boolean);
            continue;
        }
        if (arg.startsWith('--max-routes-per-triangle=')) { out.maxRoutesPerTriangle = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--top-k-per-leg=')) { out.topKPerLeg = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--route-analysis-limit=')) { out.routeAnalysisLimit = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--route-analysis-csv=') || arg.startsWith('--routes-csv=')) { out.routeAnalysisCsv = valueAfterEquals; continue; }
        if (arg.startsWith('--route-analysis-json=') || arg.startsWith('--scan-report=') || arg.startsWith('--routes-json=')) { out.routeAnalysisJson = valueAfterEquals; continue; }
        if (arg.startsWith('--min-route-score=')) { out.minRouteScore = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--min-net-signal-bps=')) { out.minNetSignalBps = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--depth-profile=')) { out.depthProfile = valueAfterEquals; continue; }
        if (arg.startsWith('--enable-quarantine=')) { out.enableQuarantine = /^(1|true|yes|on)$/i.test(String(valueAfterEquals)); continue; }
        if (arg.startsWith('--quarantine-file=')) { out.quarantineFile = valueAfterEquals; continue; }
        if (arg.startsWith('--max-trusted-deviation-bps=')) { out.scoringOptions.maxTrustedDeviationBps = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--max-leg-mid-deviation-bps=')) { out.scoringOptions.maxLegMidDeviationBps = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--fee-weight=')) { out.scoringOptions.feeWeight = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--directional-weight=')) { out.scoringOptions.directionalWeight = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--position-weight=')) { out.scoringOptions.positionWeight = Number(valueAfterEquals); continue; }
        if (arg.startsWith('--liquidity-weight=')) { out.scoringOptions.liquidityWeight = Number(valueAfterEquals); continue; }
        if (arg === '--in' || arg === '--input') { out.input = argv[++i]; continue; }
        if (arg === '--out' || arg === '--output') { out.output = argv[++i]; continue; }
        if (arg === '--min-bps') { out.minBps = Number(argv[++i]); continue; }
        if (arg === '--limit') { out.limit = Number(argv[++i]); continue; }
        if (arg === '--max-core-divergence-bps') { out.maxCoreDivergenceBps = Number(argv[++i]); continue; }
        if (arg === '--verbose' || arg === '-v') { out.verbose = true; continue; }
        if (arg === '--diagnose') { out.diagnose = true; continue; }
        if (arg === '--no-diagnose') { out.diagnose = false; continue; }
        if (arg === '--post-enrichment') { out.postEnrichment = true; continue; }
        if (arg === '--routes' || arg === '--build-routes') { out.buildRoutes = true; continue; }
        if (arg === '--no-routes') { out.buildRoutes = false; continue; }
        if (arg === '--routes-out' || arg === '--routes-output') { out.routesOutput = argv[++i]; continue; }
        if (arg === '--token-a' || arg === '--tokenA' || arg === '--start-mint') { out.tokenA = argv[++i]; continue; }
        if (arg === '--targets') {
            out.targets = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
            continue;
        }
        if (arg === '--max-routes-per-triangle') { out.maxRoutesPerTriangle = Number(argv[++i]); continue; }
        if (arg === '--top-k-per-leg') { out.topKPerLeg = Number(argv[++i]); continue; }
        if (arg === '--route-analysis') { out.routeAnalysis = true; continue; }
        if (arg === '--no-route-analysis') { out.routeAnalysis = false; continue; }
        if (arg === '--route-analysis-limit') { out.routeAnalysisLimit = Number(argv[++i]); continue; }
        if (arg === '--route-analysis-csv' || arg === '--routes-csv') { out.routeAnalysisCsv = argv[++i]; continue; }
        if (arg === '--route-analysis-json' || arg === '--scan-report' || arg === '--routes-json') { out.routeAnalysisJson = argv[++i]; continue; }
        if (arg === '--min-route-score') { out.minRouteScore = Number(argv[++i]); continue; }   // FIX 9
        if (arg === '--min-net-signal-bps') { out.minNetSignalBps = Number(argv[++i]); continue; }   // FIX 9
        if (arg === '--no-quality-report') { out.qualityReport = false; continue; }                // FIX 10
        if (arg === '--depth-profile') { out.depthProfile = argv[++i]; continue; }
        if (arg === '--enable-quarantine') { out.enableQuarantine = true; continue; }
        if (arg === '--explain-divergence') { out.explainDivergence = true; continue; }
        if (arg === '--no-quarantine') { out.enableQuarantine = false; continue; }
        if (arg === '--quarantine-file') { out.quarantineFile = argv[++i]; continue; }
        if (arg === '--max-trusted-deviation-bps') { out.scoringOptions.maxTrustedDeviationBps = Number(argv[++i]); continue; }
        if (arg === '--max-leg-mid-deviation-bps') { out.scoringOptions.maxLegMidDeviationBps = Number(argv[++i]); continue; }
        if (arg === '--fee-weight') { out.scoringOptions.feeWeight = Number(argv[++i]); continue; }
        if (arg === '--directional-weight') { out.scoringOptions.directionalWeight = Number(argv[++i]); continue; }
        if (arg === '--position-weight') { out.scoringOptions.positionWeight = Number(argv[++i]); continue; }
        if (arg === '--liquidity-weight') { out.scoringOptions.liquidityWeight = Number(argv[++i]); continue; }
        if (arg === '--no-drop-stale') { out.scoringOptions.dropStaleLegs = false; continue; }
        if (arg === '--enumerate-only') {
            // Don't let divergence edge drive selection — pick legs by fee/liquidity and
            // emit everything connected; the engine ranks by simulated profitBpsVerified.
            out.enumerateOnly = true;
            out.scoringOptions.directionalWeight = 0;
            out.scoringOptions.positionWeight = 0;
            out.scoringOptions.liquidityWeight = 1;
            out.minNetSignalBps = null;
            out.minRouteScore = null;
            continue;
        }
        positional.push(arg);
    }
    if (positional[0]) out.input = positional[0];
    if (positional[1]) out.output = positional[1];
    return out;
}

function extractPoolsFromAny(raw) {
    try {
        const { normalizePoolsArray } = require('./normalizer.js');
        const normalized = normalizePoolsArray(raw);
        if (normalized.length > 0) return normalized;
    } catch (_e) {
        // Fall through to legacy extraction below; this utility is also used in
        // lightweight diagnostic contexts where the normalizer may not load.
    }

    // Path order mirrors extractPoolsFromPayload in the engine so both tools
    // agree on where to find pools regardless of which file format is used.
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.runtime?.pools)) return raw.runtime.pools;
    if (Array.isArray(raw?.runtime?.chainPools)) return raw.runtime.chainPools;
    if (Array.isArray(raw?.runtime?.hotSet?.pools)) return raw.runtime.hotSet.pools;
    if (Array.isArray(raw?.hotSet?.pools)) return raw.hotSet.pools;
    if (Array.isArray(raw?.routePrep?.pools)) return raw.routePrep.pools;
    if (Array.isArray(raw?.routePrep?.chainPools)) return raw.routePrep.chainPools;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.chainPools)) return raw.chainPools;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.selected)) return raw.selected;
    if (Array.isArray(raw?.selectedPools)) return raw.selectedPools;
    if (Array.isArray(raw?.enrichedPools)) return raw.enrichedPools;
    return [];
}

function sanitizePools(pools = [], options = {}) {
    if (!Array.isArray(pools)) return [];
    const out = [];
    let dropped = 0;
    for (const pool of pools) {
        if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
            dropped++;
            continue;
        }
        out.push(pool);
    }
    if (dropped > 0 && !options.quiet) {
        console.warn(`[warn] skipped ${dropped} null/non-object pool entr${dropped === 1 ? 'y' : 'ies'}`);
    }
    return out;
}

function reseatPools(rawInput, pools, routePrep = null) {
    // Always produce a canonical CIRCUIT.json structure that both the engine and
    // any downstream tool can read without guessing the input's original shape.
    //
    // Output contract (regardless of input structure):
    //   raw.pools        — annotated pool array (always present)
    //   raw.routePrep    — { chainRoutes, triangles, pools, ... } (only when routePrep != null)
    //
    // The engine's extractPoolsFromPayload checks raw.routePrep.pools first,
    // then raw.pools.  extractChainRoutesFromPayload checks raw.routePrep.chainRoutes.
    // Both are guaranteed to find their data with this canonical layout.
    //
    // Non-pool metadata fields from the original input (generatedAt, source, etc.)
    // are preserved via spread so provenance is never lost.
    const base = (!Array.isArray(rawInput) && rawInput && typeof rawInput === 'object')
        ? { ...rawInput }
        : {};

    // Remove any old pool/route locations that might confuse extraction order.
    // Downstream extraction checks nested runtime/routePrep locations before root
    // pools, so preserving stale nested arrays can mask the freshly annotated pools.
    delete base.data;
    delete base.selected;
    delete base.selectedPools;
    delete base.enrichedPools;
    delete base.chainPools;
    delete base.routePrep;
    delete base.chainRoutes;
    delete base.routes;

    if (base.runtime && typeof base.runtime === 'object') {
        base.runtime = { ...base.runtime };
        delete base.runtime.pools;
        delete base.runtime.chainPools;
        delete base.runtime.chainRoutes;
        delete base.runtime.chainRouteExports;
        delete base.runtime.routes;
        if (base.runtime.hotSet && typeof base.runtime.hotSet === 'object') {
            base.runtime.hotSet = { ...base.runtime.hotSet };
            delete base.runtime.hotSet.pools;
            delete base.runtime.hotSet.chainRoutes;
        }
    }

    if (base.hotSet && typeof base.hotSet === 'object') {
        base.hotSet = { ...base.hotSet };
        delete base.hotSet.pools;
        delete base.hotSet.chainRoutes;
    }

    const compactPools = pools.map(compactPoolOutput);
    const out = { ...base, pools: compactPools };
    if (routePrep) out.routePrep = compactRoutePrepOutput({ ...routePrep, pools }, compactPools);
    return out;
}

function countAnnotatedPools(pools = []) {
    return Array.isArray(pools) ? pools.filter((pool) => pool?.pairCanonical).length : 0;
}

function main(argv = process.argv) {
    const args = parseCliArgs(argv);
    if (!args.input) {
        console.error('Usage: node divergenceScanner.js --in cli/*ENRICHED.json --out cli/*DIVERGENCE.json');
        console.error('       [--min-bps 5] [--limit 30] [--verbose] [--diagnose] [--post-enrichment]');
        console.error('       [--routes] [--max-routes-per-triangle 3] [--min-route-score <bps>] [--min-net-signal-bps <bps>]');
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    const pools = sanitizePools(extractPoolsFromAny(raw), { quiet: !args.diagnose && !args.verbose });
    console.log(`Loaded ${pools.length} pools from ${args.input}`);

    // Stale-mid / thin-depth pre-filter from the cached probe (out-of-band; free here).
    if (args.depthProfile) {
        try {
            const { loadDepthProfile, applyDepthProfileToPools } = require('./depthProbe.js');
            const profile = loadDepthProfile(args.depthProfile);
            const stamped = applyDepthProfileToPools(pools, profile);
            console.log(`[depthProfile] ${args.depthProfile}: marked ${stamped.poolsStaleMarked}/${stamped.total} pools depthStale`);
        } catch (e) {
            console.warn(`[depthProfile] could not apply ${args.depthProfile}: ${e.message}`);
        }
    }

    if (args.diagnose) console.log('\n🔍 Per-pool extraction (--diagnose):');

    const annotateFn = args.postEnrichment ? annotatePostEnrichment : annotatePairDivergence;
    annotateFn(pools, {
        diagnose: args.diagnose,
        maxCoreDivergenceBps: args.maxCoreDivergenceBps,
    });

    printDivergenceReport(pools, { minBps: args.minBps, limit: args.limit, verbose: args.verbose });

    if (args.explainDivergence) {
        explainPoolDeviation(pools);
    }
    const { diagnoseTickArrays } = require('./tickArrayShapeReconciler');
    console.log('[tickshape]', JSON.stringify(diagnoseTickArrays(pools)));

    const { decodePoolTickArrays } = require('./whirlpoolTickDecoder');
    decodePoolTickArrays(pools, { debug: true });

    const routePrep = buildRoutePrepForOutput(pools, args);
    if (routePrep) {
        console.log(`\nBuilt ${routePrep.chainRouteCount} routed 3-leg candidates across ${routePrep.triangleCount} triangles`);
        if (routePrep.chainRouteCount === 0 && Number(routePrep.candidateTriangleCount || 0) > 0) {
            console.warn(
                `[warn] ${routePrep.candidateTriangleCount} connected triangle(s) existed, but route filters removed all candidates. ` +
                'Relax --min-net-signal-bps/--min-route-score or omit those flags to emit routes for runtime simulation.'
            );
        }

        // FIX 10: print quality warning before route table
        if (args.qualityReport) {
            printRouteQualityWarning(routePrep.chainRoutes);
        }

        if (args.routeAnalysis) {
            printRouteAnalysisTable(routePrep, { limit: args.routeAnalysisLimit });
        }

        if (args.explainDivergence) {
            for (const route of (routePrep.chainRoutes || [])) explainRouteSignal(route);
        }
        if (args.routeAnalysisCsv) {
            writeRouteAnalysisCsv(routePrep, args.routeAnalysisCsv);
            console.log(`Wrote route analysis CSV to ${args.routeAnalysisCsv}`);
        }
        if (args.routeAnalysisJson) {
            writeRouteAnalysisJson(routePrep, args.routeAnalysisJson, args);
            console.log(`Wrote divergence scan report to ${args.routeAnalysisJson}`);
        }
        if (args.routesOutput) {
            fs.mkdirSync(path.dirname(path.resolve(args.routesOutput)), { recursive: true });
            fs.writeFileSync(args.routesOutput, safeStringify(compactRoutePrepOutput(routePrep)));
            console.log(`Wrote route prep to ${args.routesOutput}`);
        }

        if (args.enableQuarantine) {
            const staleAddrs = [];
            for (const route of routePrep.chainRoutes || []) {
                const legs = Array.isArray(route) ? route : route.legs || [];
                for (const leg of legs) {
                    if (leg && leg.__legStale && (leg.poolAddress || leg.address)) {
                        staleAddrs.push(leg.poolAddress || leg.address);
                    }
                }
            }
            commitQuarantine(args.quarantineFile, staleAddrs, {
                cooldownMs: Number(process.env.QUARANTINE_COOLDOWN_MS ?? 30000),
            });
        }
        function atomicWriteFileSync(file, data) {
            const tmp = `${file}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, file);   // atomic: readers see old file or new file, never a torn one
        }
    }

    if (args.output) {
        const payload = reseatPools(raw, pools, routePrep);
        const annotatedInMemory = countAnnotatedPools(pools);
        const annotatedInPayload = countAnnotatedPools(payload.pools);
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, safeStringify(stripExecutionStateForRouteExport(payload)));
        console.log(`\nWrote annotated pools to ${args.output}`);
        console.log(`Output annotation check: ${annotatedInPayload}/${payload.pools.length} pools carry pairCanonical`);
        if (annotatedInPayload !== annotatedInMemory) {
            console.warn(`[warn] annotation count changed during output compaction: memory=${annotatedInMemory}, payload=${annotatedInPayload}`);
        }
    }
}

if (require.main === module) {
    main(process.argv);
}

module.exports = {
    main,
    parseCliArgs,
    largestCoherentCluster,
    annotatePairDivergence,
    annotatePostEnrichment,
    scoreTriangleByDivergence,
    filterRoutesByDivergence,
    selectBestPoolPerLeg,
    normalizeMathType,
    routeCanonicalPool,
    buildPairMap,
    findConnectedMints,
    getPoolsForPair,
    computeLegDirectionalEdge,
    scoreLegPool,
    pickTopKForLeg,
    fallbackBuildRouteLeg,
    buildDivergenceAwareRoutes,
    buildAllDivergenceAwareRoutesForGraph,
    buildRoutePrepForOutput,
    buildRouteAnalysisRows,
    printRouteAnalysisTable,
    writeRouteAnalysisCsv,
    buildDivergenceReport,
    printDivergenceReport,
    getPoolMidPriceYperX,
    getPoolMidCanonical,
    normalizeMidSourcePreference,
    getPoolSymbols,
    canonicalPairKey,
    symbolFor,
    // FIX 10 — new exports
    diagnoseRouteQuality,
    printRouteQualityWarning,
    explainPoolDeviation,
    explainRouteSignal,
    extractPoolMints,       // useful for callers debugging their own pool structs
    resolvePoolMints,
    sanitizePools,
    extractPoolsFromAny,
    clampDirectionalEdge,
    routePoolMints,
    routePoolDecimals,
    routeFeeBps,
    getPoolAddress,
    shortMint,
    toFiniteNumber,
    loadQuarantine,
    commitQuarantine
};

/*
 * Runtime sequence (unchanged from v3):
 *
 *   node _enrichment.js --in pools/00_POOLFETCH.json \
 *     --selected-pools wbtc,ray,... \
 *     --out 02_ENRICHED.json
 *
   
node utilities/poolFetchCustom_raw.js \
  --quality 50 \
  --select-mode triangle-closure \
  --over-fetch 8 \
  --min-liquidity 300000 \
  --min-volume24h 200000 \
  --min-turnover 0.3 \
  --rank composite \
  --divergence-weight 80 \
  --min-divergence 0.2 \
  --fee-tier-diversity \
  --max-pools-per-token 4 \
  --target-mids BSOL,JUP,RAY,BONK,WIF,PUMP,TRUMP,cbBTC \
  --out pools/01_meta.json

node utilities/_divergenceScannerTop.js \
  --in pools/02_ENRICHED.json \
  --out pools/03_CIRCUIT.json \
  --routes-out pools/03_ROUTED.json \
  --min-net-signal-bps 0.5 \
  --max-trusted-deviation-bps 30 \
  --fee-weight 2 \
  --post-enrichment

*/
