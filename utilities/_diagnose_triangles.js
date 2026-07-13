'use strict';
/**
 * diagnose_triangles.js
 * 
 * Diagnoses why no triangle candidates are being found.
 * Logs detailed information about:
 *   1. Available pairs for tokenA (SOL)
 *   2. Potential intermediate tokens (tokenB)
 *   3. Potential third tokens (tokenC) 
 *   4. Why each triangle might be rejected
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Connection } = require('@solana/web3.js');
const {
    mergeCanonicalPool,
    validateRouteLegContract,
} = require('../math/poolContract');
const {
    classifyPool,
    getPoolAddress: getCanonicalPoolAddress,
} = require('./poolHelpers');
// const { ROUNDTRIP_POOLS, ROUNDTRIP_PAIRS } = require('./utilities/roundtripPoolRegistry.js');

// ============================================================================
// CONFIG
// ============================================================================

const RPC_URL = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const short = (s) => s ? `${s.slice(0, 6)}..${s.slice(-4)}` : '?';

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function getFeeBpsFromPool(pool) {
    if (!pool) return 0;
    if (pool.feeBps != null) return Number(pool.feeBps) || 0;
    if (pool.feeRate != null) return Math.round(Number(pool.feeRate) * 10000) || 0;
    return 0;
}

function minFeeBpsForPools(pools) {
    if (!pools || pools.length === 0) return 0;
    let min = Number.POSITIVE_INFINITY;
    for (const p of pools) {
        const fee = getFeeBpsFromPool(p);
        if (fee < min) min = fee;
    }
    return Number.isFinite(min) ? min : 0;
}

function loadPools(poolsPath) {
    const resolved = path.isAbsolute(poolsPath)
        ? poolsPath
        : path.resolve(poolsPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }

    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return extractPoolsFromInput(raw);
}

function poolAddressKey(pool = {}) {
    return String(pool.poolAddress || pool.address || pool.id || pool.pubkey || '').trim();
}

function mergePoolsByAddress(...poolLists) {
    const merged = [];
    const seen = new Set();
    for (const list of poolLists) {
        for (const pool of list || []) {
            if (!pool || typeof pool !== 'object') continue;
            const address = poolAddressKey(pool);
            if (!address || seen.has(address)) continue;
            seen.add(address);
            merged.push(pool);
        }
    }
    return merged;
}

function loadMergePoolFiles(files = []) {
    const pools = [];
    const loaded = [];
    const skipped = [];
    for (const file of files) {
        if (!file) continue;
        if (!fs.existsSync(file)) {
            console.warn(`Merge input not found: ${file}`);
            skipped.push({ path: file, reason: 'not_found' });
            continue;
        }
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const extracted = extractPoolsFromInput(raw);
        if (!extracted.length) {
            console.warn(`Merge input has no pools: ${file}`);
            skipped.push({ path: file, reason: 'no_pools' });
            continue;
        }
        pools.push(...extracted);
        loaded.push({ path: file, pools: extracted.length });
    }
    return { pools, loaded, skipped };
}

function extractRouteLegPools(route) {
    const out = [];
    const legs = Array.isArray(route)
        ? route
        : (
            Array.isArray(route?.legs) ? route.legs
                : Array.isArray(route?.route) ? route.route
                    : Array.isArray(route?.hops) ? route.hops
                        : (route?.leg1 && route?.leg2 && route?.leg3) ? [route.leg1, route.leg2, route.leg3]
                            : []
        );
    for (const leg of legs) {
        const pool = leg?.pool || leg?.poolMeta || leg?.poolInfo || leg?.poolData || leg;
        if (pool && typeof pool === 'object' && getPoolAddress(pool)) out.push(pool);
    }
    return out;
}

function extractPoolsFromInput(raw) {
    const out = [];
    const containers = [raw, raw?.routePrep, raw?.runtime].filter(Boolean);
    for (const container of containers) {
        for (const key of ['pools', 'data', 'filteredPools', 'exportPools']) {
            if (Array.isArray(container[key])) out.push(...container[key]);
        }
        for (const key of ['chainRoutes', 'routes', 'submissionCandidates', 'candidates']) {
            if (!Array.isArray(container[key])) continue;
            for (const route of container[key]) out.push(...extractRouteLegPools(route));
        }
    }
    if (Array.isArray(raw)) {
        const looksLikeRoutes = raw.some((item) => Array.isArray(item) || Array.isArray(item?.legs) || (item?.leg1 && item?.leg2 && item?.leg3));
        if (looksLikeRoutes) {
            for (const route of raw) out.push(...extractRouteLegPools(route));
        } else {
            out.push(...raw);
        }
    }

    const seen = new Set();
    return out.filter((pool) => {
        const address = getPoolAddress(pool);
        if (!address || seen.has(address)) return false;
        seen.add(address);
        return true;
    });
}

function getPoolMints(pool) {
    const normalized = mergeCanonicalPool(pool || {});
    const base = normalized.baseMint || normalized.tokenXMint || normalized.mintA || normalized.tokenMintA;
    const quote = normalized.quoteMint || normalized.tokenYMint || normalized.mintB || normalized.tokenMintB;
    return { base, quote };
}

function buildPairMap(pools) {
    const pairMap = new Map(); // "mintA-mintB" -> [pools]
    const mintToSymbol = new Map();

    for (const pool of pools) {
        const { base, quote } = getPoolMints(pool);
        if (!base || !quote) continue;

        // Store symbol mappings
        if (pool.baseSymbol) mintToSymbol.set(base, pool.baseSymbol);
        if (pool.quoteSymbol) mintToSymbol.set(quote, pool.quoteSymbol);

        // Store both directions
        const key1 = `${base}-${quote}`;
        const key2 = `${quote}-${base}`;

        if (!pairMap.has(key1)) pairMap.set(key1, []);
        if (!pairMap.has(key2)) pairMap.set(key2, []);

        pairMap.get(key1).push(pool);
        pairMap.get(key2).push(pool);
    }

    return { pairMap, mintToSymbol };
}

function findConnectedMints(pairMap, mint) {
    const connected = new Set();
    for (const [key, pools] of pairMap.entries()) {
        if (key.startsWith(mint + '-')) {
            const other = key.split('-')[1];
            connected.add(other);
        }
    }
    return Array.from(connected);
}

function canFormTriangle(pairMap, tokenA, tokenB, tokenC) {
    const hasAB = pairMap.has(`${tokenA}-${tokenB}`) || pairMap.has(`${tokenB}-${tokenA}`);
    const hasBC = pairMap.has(`${tokenB}-${tokenC}`) || pairMap.has(`${tokenC}-${tokenB}`);
    const hasCA = pairMap.has(`${tokenC}-${tokenA}`) || pairMap.has(`${tokenA}-${tokenC}`);
    return { hasAB, hasBC, hasCA, valid: hasAB && hasBC && hasCA };
}

function getPoolsForPair(pairMap, mintA, mintB) {
    return pairMap.get(`${mintA}-${mintB}`) || pairMap.get(`${mintB}-${mintA}`) || [];
}

function getPoolAddress(pool) {
    return getCanonicalPoolAddress(pool || {})
        || pool?.pubkey
        || pool?.publicKey
        || pool?.pool
        || null;
}

function getPoolType(pool) {
    return classifyPool(pool || {}).mathType || 'unknown';
}

function getPoolDexType(pool) {
    return classifyPool(pool || {}).dexType || pool?.dexType || 'UNKNOWN';
}

function getPoolDex(pool) {
    return classifyPool(pool || {}).dex || pool?.dex || 'unknown';
}

function inferRouteLeg(pool, tokenInMint, tokenOutMint, meta = {}) {
    const normalized = mergeCanonicalPool(pool || {});
    const poolAddress = getPoolAddress(normalized);
    const tokenXMint = String(normalized.tokenXMint || normalized.baseMint || normalized.mintA || '');
    const tokenYMint = String(normalized.tokenYMint || normalized.quoteMint || normalized.mintB || '');
    const inMint = String(tokenInMint || '');
    const outMint = String(tokenOutMint || '');
    const aToB = inMint === tokenXMint;
    const bToA = inMint === tokenYMint;

    const leg = {
        ...normalized,
        poolAddress,
        address: poolAddress,
        legIndex: meta.legIndex,
        routeId: meta.routeId,
        routePath: meta.routePath,
        tokenInMint: inMint,
        tokenOutMint: outMint,
        inputMint: inMint,
        outputMint: outMint,
        swapDirection: aToB ? 'A_TO_B' : (bToA ? 'B_TO_A' : normalized.swapDirection),
        swapForY: aToB ? true : (bToA ? false : normalized.swapForY),
        inputDecimals: aToB
            ? normalized.tokenXDecimals
            : (bToA ? normalized.tokenYDecimals : normalized.inputDecimals),
        outputDecimals: aToB
            ? normalized.tokenYDecimals
            : (bToA ? normalized.tokenXDecimals : normalized.outputDecimals),
    };

    const contract = validateRouteLegContract(leg);
    return {
        leg,
        valid: contract.valid && Boolean(poolAddress) && Boolean(inMint) && Boolean(outMint),
        missing: contract.missing,
    };
}

function summarizePool(pool, pairLabel = '') {
    const normalized = mergeCanonicalPool(pool || {});
    const { base, quote } = getPoolMints(normalized);
    return {
        pair: pairLabel || null,
        poolAddress: getPoolAddress(normalized),
        dex: getPoolDex(normalized),
        dexType: getPoolDexType(normalized),
        type: getPoolType(normalized),
        baseMint: base || null,
        quoteMint: quote || null,
        baseSymbol: normalized?.baseSymbol || normalized?.tokenXSymbol || null,
        quoteSymbol: normalized?.quoteSymbol || normalized?.tokenYSymbol || null,
        feeBps: getFeeBpsFromPool(normalized),
    };
}

function stripHeavyPoolState(value, seen = new WeakSet()) {
    if (Array.isArray(value)) {
        return value.map((entry) => stripHeavyPoolState(entry, seen));
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const heavyKeys = new Set([
        'tickArrays',
        'tickArrayData',
        'ticks',
        'binArrays',
        'binArrayData',
        'bins',
        'activeBins',
        'bitmap',
        'bitmapExtension',
    ]);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (heavyKeys.has(key)) {
            out[`${key}Count`] = Array.isArray(entry) ? entry.length : (entry ? 1 : 0);
            continue;
        }
        out[key] = stripHeavyPoolState(entry, seen);
    }
    return out;
}

function compactRouteLeg(leg = {}) {
    const normalized = mergeCanonicalPool(leg || {});
    const out = {
        legIndex: leg.legIndex || null,
        routeId: leg.routeId || null,
        routePath: leg.routePath || null,
        poolAddress: getPoolAddress(normalized),
        address: getPoolAddress(normalized),
        dex: getPoolDex(normalized),
        dexType: getPoolDexType(normalized),
        type: getPoolType(normalized),
        mathType: getPoolType(normalized),
        tokenInMint: leg.tokenInMint || leg.inputMint || null,
        tokenOutMint: leg.tokenOutMint || leg.outputMint || null,
        inputMint: leg.tokenInMint || leg.inputMint || null,
        outputMint: leg.tokenOutMint || leg.outputMint || null,
        tokenXMint: normalized.tokenXMint || normalized.baseMint || normalized.mintA || null,
        tokenYMint: normalized.tokenYMint || normalized.quoteMint || normalized.mintB || null,
        baseMint: normalized.baseMint || normalized.tokenXMint || normalized.mintA || null,
        quoteMint: normalized.quoteMint || normalized.tokenYMint || normalized.mintB || null,
        tokenXDecimals: normalized.tokenXDecimals ?? normalized.baseDecimals ?? null,
        tokenYDecimals: normalized.tokenYDecimals ?? normalized.quoteDecimals ?? null,
        inputDecimals: leg.inputDecimals ?? null,
        outputDecimals: leg.outputDecimals ?? null,
        swapDirection: leg.swapDirection || null,
        swapForY: leg.swapForY ?? null,
        feeBps: getFeeBpsFromPool(normalized),
    };
    if (Array.isArray(leg.tickArrays)) out.tickArraysCount = leg.tickArrays.length;
    if (Array.isArray(leg.tickArrayData)) out.tickArrayDataCount = leg.tickArrayData.length;
    if (Array.isArray(leg.binArrays)) out.binArraysCount = leg.binArrays.length;
    if (Array.isArray(leg.bins)) out.binsCount = leg.bins.length;
    return out;
}

function compactChainRoute(route = []) {
    const compact = (Array.isArray(route) ? route : []).map(compactRouteLeg);
    compact.routeId = route.routeId || compact[0]?.routeId || null;
    compact.routePath = route.routePath || compact[0]?.routePath || null;
    compact.tokenA = route.tokenA || null;
    compact.tokenB = route.tokenB || null;
    compact.tokenC = route.tokenC || null;
    compact.totalFeeBps = route.totalFeeBps ?? compact.reduce((sum, leg) => sum + (Number(leg.feeBps) || 0), 0);
    return compact;
}

function compactTriangle(tri = {}) {
    return {
        ...tri,
        chainRoutes: (tri.chainRoutes || []).map(compactChainRoute),
    };
}

function buildChainRoutes(poolsAB, poolsBC, poolsCA, meta = {}) {
    const routePath = meta.routePath || '';
    const maxRoutesPerTriangle = Number(meta.maxRoutesPerTriangle) > 0
        ? Number(meta.maxRoutesPerTriangle)
        : 10;

    const chainRoutes = [];
    let routeIndex = 0;

    outer:
    for (const poolAB of poolsAB || []) {
        for (const poolBC of poolsBC || []) {
            for (const poolCA of poolsCA || []) {
                routeIndex += 1;

                const routeId = `tri-${meta.triangleIndex || 0}-${routeIndex}`;
                const leg1Summary = summarizePool(poolAB, 'A-B');
                const leg2Summary = summarizePool(poolBC, 'B-C');
                const leg3Summary = summarizePool(poolCA, 'C-A');
                const leg1 = inferRouteLeg(poolAB, meta.tokenA, meta.tokenB, { legIndex: 1, routeId, routePath });
                const leg2 = inferRouteLeg(poolBC, meta.tokenB, meta.tokenC, { legIndex: 2, routeId, routePath });
                const leg3 = inferRouteLeg(poolCA, meta.tokenC, meta.tokenA, { legIndex: 3, routeId, routePath });

                if (!leg1.valid || !leg2.valid || !leg3.valid) {
                    continue;
                }

                const route = [leg1.leg, leg2.leg, leg3.leg];
                route.routeId = routeId;
                route.routePath = routePath;
                route.tokenA = meta.tokenA || null;
                route.tokenB = meta.tokenB || null;
                route.tokenC = meta.tokenC || null;
                route.totalFeeBps = leg1Summary.feeBps + leg2Summary.feeBps + leg3Summary.feeBps;
                chainRoutes.push(route);

                if (chainRoutes.length >= maxRoutesPerTriangle) {
                    break outer;
                }
            }
        }
    }

    return chainRoutes;
}

function usedPoolAddressSet(chainRoutes = []) {
    const used = new Set();
    for (const route of chainRoutes) {
        if (!Array.isArray(route)) continue;
        for (const leg of route) {
            const address = getPoolAddress(leg);
            if (address) used.add(address);
        }
    }
    return used;
}

function pruneOrphanPools(pools = [], chainRoutes = []) {
    const used = usedPoolAddressSet(chainRoutes);
    if (!used.size) return [];

    const out = [];
    const seen = new Set();
    for (const pool of pools) {
        const normalized = mergeCanonicalPool(pool || {});
        const address = getPoolAddress(normalized);
        if (!address || !used.has(address) || seen.has(address)) continue;
        seen.add(address);
        out.push(normalized);
    }
    return out;
}

// ============================================================================
// MAIN DIAGNOSTIC
// ============================================================================

async function diagnose(poolsPath, tokenAMint = SOL, meta = {}) {
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    const keepOrphans = Boolean(meta.keepOrphans);
    const mergePools = Array.isArray(meta.mergePools) ? meta.mergePools : [];
    const maxRoutesPerTriangle = Number(meta.maxRoutesPerTriangle) > 0
        ? Number(meta.maxRoutesPerTriangle)
        : Infinity;
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TRIANGLE CANDIDATE DIAGNOSTIC');
    console.log('═══════════════════════════════════════════════════════════════');
    if (sources.length) {
        console.log(`Pool file(s): ${sources.join(', ')}`);
    } else {
        console.log(`Pool file: ${Array.isArray(poolsPath) ? '[in-memory pools]' : poolsPath}`);
    }
    console.log(`Token A: ${short(tokenAMint)}`);
    console.log('');

    // Load pools
    const basePools = Array.isArray(poolsPath) ? poolsPath : loadPools(poolsPath);
    const pools = mergePoolsByAddress(basePools, mergePools)
        .map((pool) => mergeCanonicalPool(pool || {}));
    console.log(`📦 Loaded ${pools.length} pools`);
    if (mergePools.length) {
        console.log(`   Merge pools supplied: ${mergePools.length}; unique after merge: ${pools.length}`);
    }

    // Build pair map
    const { pairMap, mintToSymbol } = buildPairMap(pools);
    console.log(`🔗 Found ${pairMap.size / 2} unique pairs`);
    console.log('');

    // Helper to get symbol
    const sym = (mint) => mintToSymbol.get(mint) || short(mint);

    // Step 1: Find all tokens connected to tokenA
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`STEP 1: Tokens connected to ${sym(tokenAMint)} (potential tokenB)`);
    console.log('───────────────────────────────────────────────────────────────');

    const tokenBs = findConnectedMints(pairMap, tokenAMint);
    console.log(`Found ${tokenBs.length} tokens connected to ${sym(tokenAMint)}:`);

    if (tokenBs.length === 0) {
        console.log('❌ NO TOKENS CONNECTED TO SOL!');
        console.log('   This means no pools have SOL as base or quote mint.');
        console.log('');
        console.log('   Checking pool structure...');

        // Debug: show what mints ARE in the pools
        const allMints = new Set();
        for (const pool of pools.slice(0, 5)) {
            console.log(`   Pool: ${JSON.stringify({
                baseMint: pool.baseMint?.slice(0, 10),
                quoteMint: pool.quoteMint?.slice(0, 10),
                mintA: pool.mintA?.slice(0, 10),
                mintB: pool.mintB?.slice(0, 10),
                type: pool.type || pool.poolType
            })}`);
        }
        return;
    }

    for (const tokenB of tokenBs) {
        const poolCount = getPoolsForPair(pairMap, tokenAMint, tokenB).length;
        console.log(`  ${sym(tokenB)} (${poolCount} pools)`);
    }
    console.log('');

    // Step 2: For each tokenB, find potential tokenCs
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 2: Finding triangle candidates');
    console.log('───────────────────────────────────────────────────────────────');

    const triangles = [];
    const allChainRoutes = [];

    for (const tokenB of tokenBs) {
        // Find tokens connected to tokenB (potential tokenC)
        const tokenCs = findConnectedMints(pairMap, tokenB);

        for (const tokenC of tokenCs) {
            // Skip if tokenC is tokenA or tokenB
            if (tokenC === tokenAMint || tokenC === tokenB) continue;

            // Check if we can complete the triangle back to tokenA
            const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);

            if (check.valid) {
                const poolsAB = getPoolsForPair(pairMap, tokenAMint, tokenB);
                const poolsBC = getPoolsForPair(pairMap, tokenB, tokenC);
                const poolsCA = getPoolsForPair(pairMap, tokenC, tokenAMint);
                const minFeeBpsAB = minFeeBpsForPools(poolsAB);
                const minFeeBpsBC = minFeeBpsForPools(poolsBC);
                const minFeeBpsCA = minFeeBpsForPools(poolsCA);
                const minTotalFeeBps = minFeeBpsAB + minFeeBpsBC + minFeeBpsCA;

                const routePath = `${sym(tokenAMint)} → ${sym(tokenB)} → ${sym(tokenC)} → ${sym(tokenAMint)}`;
                const totalCombinations = poolsAB.length * poolsBC.length * poolsCA.length;
                const chainRoutes = buildChainRoutes(poolsAB, poolsBC, poolsCA, {
                    triangleIndex: triangles.length + 1,
                    routePath,
                    tokenA: tokenAMint,
                    tokenB,
                    tokenC,
                    maxRoutesPerTriangle
                });

                triangles.push({
                    path: routePath,
                    tokenA: tokenAMint,
                    tokenB,
                    tokenC,
                    poolsAB: poolsAB.length,
                    poolsBC: poolsBC.length,
                    poolsCA: poolsCA.length,
                    totalCombinations,
                    minFeeBpsAB,
                    minFeeBpsBC,
                    minFeeBpsCA,
                    minTotalFeeBps,
                    chainRouteCount: chainRoutes.length,
                    chainRoutes
                });

                allChainRoutes.push(...chainRoutes);
            }
        }
    }

    console.log(`Found ${triangles.length} valid triangles:`);
    console.log('');

    if (triangles.length === 0) {
        console.log('❌ NO VALID TRIANGLES FOUND');
        console.log('');
        console.log('Debugging why...');

        // Show what's missing
        for (const tokenB of tokenBs.slice(0, 5)) {
            console.log(`\n  Checking ${sym(tokenB)}:`);
            const tokenCs = findConnectedMints(pairMap, tokenB);
            console.log(`    Connected to ${tokenCs.length} other tokens`);

            for (const tokenC of tokenCs.slice(0, 3)) {
                if (tokenC === tokenAMint || tokenC === tokenB) continue;
                const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);
                console.log(`    ${sym(tokenC)}: AB=${check.hasAB}, BC=${check.hasBC}, CA=${check.hasCA}`);
                if (!check.hasCA) {
                    console.log(`      ⚠️ Missing ${sym(tokenC)} → ${sym(tokenAMint)} pool!`);
                }
            }
        }
    } else {
        // Sort by lowest min total fee, then by combinations
        triangles.sort((a, b) => {
            if (a.minTotalFeeBps !== b.minTotalFeeBps) return a.minTotalFeeBps - b.minTotalFeeBps;
            return b.totalCombinations - a.totalCombinations;
        });

        for (const tri of triangles.slice(0, 20)) {
            console.log(`  ✓ ${tri.path}`);
            console.log(`    Pools: AB=${tri.poolsAB}, BC=${tri.poolsBC}, CA=${tri.poolsCA}`);
            console.log(`    Combinations: ${tri.totalCombinations}`);
            console.log(`    Saved chain routes: ${tri.chainRouteCount}`);
            console.log(`    Min fee bps: AB=${tri.minFeeBpsAB}, BC=${tri.minFeeBpsBC}, CA=${tri.minFeeBpsCA}, total=${tri.minTotalFeeBps}`);
        }

        console.log('');
        console.log(`Saved ${allChainRoutes.length} total chain routes across ${triangles.length} triangles`);

        if (triangles.length > 20) {
            console.log(`  ... and ${triangles.length - 20} more`);
        }
    }

    console.log('');

    // Step 3: Show pool types breakdown
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 3: Pool types in file');
    console.log('───────────────────────────────────────────────────────────────');

    const typeCount = {};
    const dexCount = {};

    for (const pool of pools) {
        const type = getPoolType(pool);
        const dex = getPoolDex(pool);
        typeCount[type] = (typeCount[type] || 0) + 1;
        dexCount[dex] = (dexCount[dex] || 0) + 1;
    }

    console.log('By type:');
    for (const [type, count] of Object.entries(typeCount)) {
        console.log(`  ${type}: ${count}`);
    }

    console.log('\nBy dex:');
    for (const [dex, count] of Object.entries(dexCount)) {
        console.log(`  ${dex}: ${count}`);
    }

    console.log('');

    // Step 4: Check SOL specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 4: SOL pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const solPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === SOL || quote === SOL;
    });

    console.log(`Pools with SOL: ${solPools.length}`);

    for (const pool of solPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = getPoolType(pool);
        const other = base === SOL ? quote : base;
        console.log(`  ${sym(SOL)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO SOL POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
    }



    // Step 5: Check USDC specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 5: USDC pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const usdcPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === USDC || quote === USDC;
    });

    console.log(`Pools with USDC: ${usdcPools.length}`);

    for (const pool of usdcPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = getPoolType(pool);
        const other = base === USDC ? quote : base;
        console.log(`  ${sym(USDC)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO USDC POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('DIAGNOSTIC COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');

    const routedPools = pruneOrphanPools(pools, allChainRoutes);
    const orphanPoolCount = allChainRoutes.length ? pools.length - routedPools.length : 0;
    const exportPools = keepOrphans || !routedPools.length ? pools : routedPools;
    const compactExportPools = exportPools.map((pool) => stripHeavyPoolState(pool));
    const compactSolPools = solPools.map((pool) => stripHeavyPoolState(pool));
    const compactUsdcPools = usdcPools.map((pool) => stripHeavyPoolState(pool));

    if (allChainRoutes.length) {
        console.log(`Routed pool export: ${exportPools.length}/${pools.length} pools kept, `
            + `${keepOrphans ? 0 : orphanPoolCount} orphan(s) dropped`
            + `${keepOrphans ? ' (keep-orphans enabled)' : ''}`);
    }

    const compactTriangles = triangles.map(compactTriangle);
    const compactChainRoutes = allChainRoutes.map(compactChainRoute);

    return {
        source: 'diagnose_triangles',
        generatedAt: new Date().toISOString(),
        triangles: compactTriangles,
        chainRoutes: compactChainRoutes,
        chainRouteCount: allChainRoutes.length,
        pools: compactExportPools,
        routedPoolCount: routedPools.length,
        orphanPoolCount: keepOrphans ? 0 : orphanPoolCount,
        orphanPoolCountAvailable: orphanPoolCount,
        keepOrphans,
        mergeSources: meta.mergeSources || [],
        tokenBs,
        solPools: compactSolPools,
        usdcPools: compactUsdcPools,
        sources
    };
}



// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
    const parseArgs = (argv) => {
        const out = {
            inputs: [],
            mergeInputs: [],
            tokenA: null,
            output: null,
            maxRoutesPerTriangle: null,
            keepOrphans: false,
        };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (!a) continue;
            const kv = a.match(/^([a-zA-Z][\\w-]*)=(.*)$/);
            if (kv) {
                let val = kv[2];
                if (val === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) val = argv[++i];
                const key = kv[1].toLowerCase();
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'merge' || key === 'merge-pools' || key === 'mergeinputs' || key === 'merge-inputs') {
                    out.mergeInputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                }
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out' || key === 'routes-out' || key === 'routesout') out.output = val;
                if (key === 'maxroutespertriangle' || key === 'max-routes-per-triangle' || key === 'routes-max-per-triangle' || key === 'maxroutes') out.maxRoutesPerTriangle = val;
                if (key === 'keep-orphans' || key === 'keeporphans' || key === 'no-drop-orphans') {
                    out.keepOrphans = !['0', 'false', 'no', 'off'].includes(String(val || 'true').toLowerCase());
                }
                continue;
            }
            if (a.startsWith('--')) {
                const key = a.replace(/^--?/, '').toLowerCase();
                let val = argv[i + 1];
                if (val && val.startsWith('--')) val = '';
                if (val !== '' && val != null && !val.startsWith('--')) i++;
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'merge' || key === 'merge-pools' || key === 'merge-inputs') {
                    out.mergeInputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                }
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out' || key === 'routes-out' || key === 'routesout') out.output = val;
                if (key === 'maxroutespertriangle' || key === 'max-routes-per-triangle' || key === 'routes-max-per-triangle' || key === 'maxroutes') out.maxRoutesPerTriangle = val;
                if (key === 'keep-orphans' || key === 'keeporphans' || key === 'no-drop-orphans') out.keepOrphans = false;
                continue;
            }
            out.inputs.push(a);
        }
        return out;
    };

    const parsed = parseArgs(process.argv.slice(2));
    const inputs = parsed.inputs.length ? parsed.inputs : ['']; // 'pools/_BQ_pools.json'
    const tokenA = parsed.tokenA || SOL;

    const mergedPools = []; //'pools/_BQ_pools.json,pools/01_raw_.json,pools/01_FILTERED.json,pools/01_FILTERED_1.json,pools/raw_quality_candidates.json'
    const loadedSources = [''];
    const skippedSources = [];
    for (const p of inputs) {
        if (!p) continue;
        if (!fs.existsSync(p)) {
            console.warn(`Input not found: ${p}`);
            skippedSources.push({ path: p, reason: 'not_found' });
            continue;
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const extractedPools = extractPoolsFromInput(raw);
        if (extractedPools.length) {
            mergedPools.push(...extractedPools);
            loadedSources.push(p);
            continue;
        }
        if (raw?.fastQuote || raw?.exactQuote) {
            console.warn(`Skipping quote-only file (no pools): ${p}`);
            skippedSources.push({ path: p, reason: 'quote_only' });
            continue;
        }
        console.warn(`Unrecognized input shape: ${p}`);
        skippedSources.push({ path: p, reason: 'unrecognized_shape' });
    }

    if (!mergedPools.length) {
        console.error('No pools loaded from inputs. Aborting.');
        process.exit(1);
    }

    const mergeLoad = loadMergePoolFiles(parsed.mergeInputs);

    diagnose(mergedPools, tokenA, {
        sources: loadedSources,
        skippedSources,
        maxRoutesPerTriangle: parsed.maxRoutesPerTriangle,
        mergePools: mergeLoad.pools,
        mergeSources: mergeLoad.loaded,
        skippedMergeSources: mergeLoad.skipped,
        keepOrphans: parsed.keepOrphans,
    }).then((result) => {
        if (parsed.output) {
            fs.writeFileSync(parsed.output, JSON.stringify(result, null, 2));
            console.log(`Output saved: ${parsed.output}`);
        }
    }).catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}

module.exports = { diagnose, loadPools, buildPairMap, findConnectedMints, canFormTriangle };


/*

    node config/getPool_token_address.js \
    --preset triarb_2 \
    --max-fee-bps 5 \

    node utilities/_diagnose_pools2.js tradePool/_MEME.json \
    --min-liquidity 300000 \
    --max-per-pair N \
    --math-ready-only \
    --max-per-pair 3 \
    --out tradePool/_MEME.json

    pools/raw_quality_candidates.json output/_batch_set_01.json,

            node utilities/poolFetchCustom_raw.js \
            --include-exact-pairs \
            --include-exact-pair SOL/BONK, SOL/RAY, SOL/PENGU \
            --rank composite \
            --no-target-mids \
            --no-fee-tier-diversity \
            --max-fee-bps 5 \
            --max-pools-per-token 3 \
            --out tradePool/_MEME.raw.json
   

            node utilities/fetch_pools_batch.with_pool_selector.js \
            pools/raw_quality_candidates.json output/_batch_set_01.json, pools/01_FILTERED.json \
            --selected-pools BONK,RAY, \
            --against sol \
            --out  pools/01_FILTERED.json  

        node utilities/_diagnose_pools2.js tradePoo/_MEME.json\
        --minLiquidity 300000 \
         --log-tvl True \
        --routes-max-per-triangle 3 \
        --out pools/03_ROUTED.json

        node utilities/_diagnose_triangles.js pools/raw_quality_candidates.json \
         --routes-max-per-triangle 3 \
        --out pools/03_ROUTED.json

        node utilities/_diagnose_triangles.js tradePool/_triArb_9.json \
         --min-liquidity 500000 \
         --routes-max-per-triangle 2 \
        --out  tradePool/_triArb_9.json  

          node utilities/_diagnose_pools2.js tradePool/_LST.raw.json \
         --out  pools/01_FILTERED.json  

        node utilities/fetch_pools_batch.with_pool_selector.js \
            --pool-selector triarb_1 \
            --minLiquidity 300000 \
            --quality-min-tvl \
            --maxfeebps 5
            --out tradePool/_triArb_1.json
       
             

             node utilities/fetch_pools_batch.js
            --selectedSet triarb_1 \
            --dammv2    \
            --minLiquidity 1000000 \
            --out  pools/01_FILTERED.json

             node utilities/_diagnose_triangles.js pools/raw_quality_candidates.json \
            --routes-max-per-triangle 4 \
            --out pools/01_START.json 

            node utilities/_diagnose_triangles.js  tradePool/_MEME.curated_E.json \
            --routes-max-per-triangle 2 \
            --outtradePool/_preview.json

            node utilities/_diagnose_pools2.js pools/raw_quality_candidates.json \
            --log-tvl True \
            --minLiquidity 200000 \
            --masFee 5 \
            --out pools/01_START.json

             tradePool/_sol_usdc.json tradePool/_sol_Usdc_bonk.json      

            --merge  tradePool/_bonk.json,tradePool/_BONK_SOL_USDC.json,tradePool/_sol_usdc.json \

        node utilities/_diagnose_pools.js tradePool/_lst_sol_shyft_lowfee.json \
        --out tradePool/_LST_lowFees.json
            ======================================================
            node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_9 \
            --maxFeeBps 100 \
            --minLiquidity 200000 \
            --out tradePool/_BONK_SOL_USDC.json

             node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_1 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_1.json

            node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_2 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_2.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_3 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_3.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_4 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_4.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_5 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_5.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_6 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_6.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_7 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_7.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_8 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_8.json

              node utilities/fetch_pools_batch.with_pool_selector.js \
            --selectedSet triarb_9 \
            --minLiquidity 400000 \
            --out tradePool/_triArb_9.json

            =======================================================

            node utilities/_diagnose_pools2.js tradePool/_BONK_lowfee.json \
            --log-tvl True \
            --out tradePool/_BONK.json


 --merge pools/01_raw_.json,pools/backUpPools/_PANCAKESWAP.json,pools/backUpPools/_merged_pancake_dammv2_pumpswap.diagnostic.json \
 --out pools/_QP1.json

triarb_1

58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2 WSOL / USDC cpmm TVL = $9995085.40 ready = true
BCDdHonby65iduz3Ev3c9v5XjNkzyu5e56KRFHpBM4T9 USD1/USDC clmm TVL=$9889464.20 ready=false
3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv WSOL/USDC clmm TVL=$4919315.51 ready=false
5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6 SOL / USDC dlmm TVL = $3333440.58 ready = false
AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS WSOL / USD1 clmm TVL = $3948810.10 ready = false
Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE SOL / USDC whirlpool TVL = $32526289.16 ready = false
BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU USDC/USDT clmm TVL=$4234398.74 ready=false
AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS WSOL/USD1 clmm TVL=$3968991.06 ready=false
3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF WSOL/USDT clmm TVL=$1273112.22 ready=false
4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4 USDC/USDT whirlpool TVL=$1223791.60 ready=false
AS5MV3ear4NZPMWXbCsEz3AdbCaXEnq4ChdaWsvLgkcM USDS / USDC clmm TVL = $38244363.81 ready = false
BCDdHonby65iduz3Ev3c9v5XjNkzyu5e56KRFHpBM4T9 USD1 / USDC clmm TVL = $9889454.46 ready = false
3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv WSOL / USDC clmm TVL = $4906012.37 ready = false

BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh SOL / USDC dlmm TVL = $1894170.69 ready = false
BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y SOL / USDC dlmm TVL = $2712271.27 ready = false


triarb_2
3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1 SOL/BONK whirlpool TVL=$1142141.64 ready=false
8QaXeHBrShJTdtN1rWCccBxpSVvKksQ2PCu5nufb2zbk BONK/USDC whirlpool TVL=$1107994.51 ready=false
3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1 SOL / BONK whirlpool TVL = $1142141.64 ready = false
8QaXeHBrShJTdtN1rWCccBxpSVvKksQ2PCu5nufb2zbk BONK / USDC whirlpool TVL = $1107994.51 ready = false
81GpCm4d13y8TozYtThabuSCLQN2o3bbrvDogXFPn8sA HYPE/SOL dlmm TVL=$1450006.98 ready=false
ANCx141SujgVdbKz9NTEH8F38qWsnyyXsVju64aU3qLB HYPE/USDC dlmm TVL=$5330206.66 ready=false
ANCx141SujgVdbKz9NTEH8F38qWsnyyXsVju64aU3qLB HYPE / USDC dlmm TVL = $5281511.83 ready = false
DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU PENGU/USDC dlmm TVL=$3065023.88 ready=false
FAqh648xeeaTqL7du49sztp9nfj5PjRQrfvaMccyd9cz SOL/PENGU whirlpool TVL=$2454615.37 ready=false

triarb_3
CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN SOL/cbBTC whirlpool TVL=$10487327.11 ready=false
HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM cbBTC/USDC whirlpool TVL=$5809601.22 ready=false
4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72 cbBTC/WBTC whirlpool TVL=$1290583.32 ready=false
B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA SOL/WBTC whirlpool TVL=$5319196.55 ready=false
B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA SOL / WBTC whirlpool TVL = $5319196.55 ready = false
7ubS3GccjhQY99AYNKXjNJqnXjaokEdfdV915xnCb96r cbBTC/USDC dlmm TVL=$1225114.07 ready=false
HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM cbBTC / USDC whirlpool TVL = $5809601.22 ready = false
4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72 cbBTC / WBTC whirlpool TVL = $1290583.32 ready = false
CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN SOL / cbBTC whirlpool TVL = $10487327.11 ready = false
2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2 WSOL/RAY clmm TVL=$1177081.65 ready=false
6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg RAY / USDC cpmm TVL = $3600014.21 ready = true
2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2 WSOL / RAY clmm TVL = $1170915.60 ready = false
6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg RAY/USDC cpmm TVL=$3609370.22 ready=true
AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA RAY/WSOL cpmm TVL=$2292897.35 ready=true

triarb_4
2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc WSOL/JitoSOL clmm TVL=$1762137.20 ready=false
BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U JitoSOL/SOL dlmm TVL=$2299816.97 ready=false
BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U JitoSOL / SOL dlmm TVL = $2290347.19 ready = false
Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp SOL / JitoSOL whirlpool TVL = $31439173.85 ready = false
5hWJUNTtEtKmKgDXpthJXXRRmJrz5vJ7uJzrUNVdrwLg USDC/JitoSOL whirlpool TVL=$1162384.01 ready=false
5hWJUNTtEtKmKgDXpthJXXRRmJrz5vJ7uJzrUNVdrwLg USDC / JitoSOL whirlpool TVL = $1162384.01 ready = false
2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc WSOL / JitoSOL clmm TVL = $1748973.70 ready = false
GExy9FLjGXMLRxNr4MMYFKG6dwXbepidB7oELNpopcRD MPLX/JitoSOL whirlpool TVL=$4875746.27 ready=false
BxRhW4q1wTRwJkJ1C4NR4yJCRL2uusoju4g1bVenspZK MPLX/WSOL clmm TVL=$1255008.11 ready=false
GExy9FLjGXMLRxNr4MMYFKG6dwXbepidB7oELNpopcRD MPLX / JitoSOL whirlpool TVL = $4875746.27 ready = false
BxRhW4q1wTRwJkJ1C4NR4yJCRL2uusoju4g1bVenspZK MPLX / WSOL clmm TVL = $1245640.30 ready = false
6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb JLP/USDC whirlpool TVL=$10178145.56 ready=false
6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb JLP / USDC whirlpool TVL = $10178145.56 ready = false
6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd SOL/JLP whirlpool TVL=$3709271.50 ready=false
6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd SOL / JLP whirlpool TVL = $3709271.50 ready = false


*/

/*










*/
