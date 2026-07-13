#!/usr/bin/env node
'use strict';

/**
 * Diagnose pool composition and per-math-type readiness.
 *
 * Usage:
 *   node utilities/_diagnose_pools2.js  tradePool/_JUP_JLP_E.json --maxFee 5 --log-tvl True tradePool/_JUP_JLP.curated.json
 *   node utilities/_diagnose_pools.js pools/00_POOLFETCH.json --minLiquidity 10000
 *   node utilities/_diagnose_pools.js pools/00_POOLFETCH.json --out pools/diagnose_pools.json
 */
/*

Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp SOL/JITOSOL whirlpool TVL=$0.00 fee=  1bps ready=true
FWQVofjFwoehj8vMmzT1njkmk3581EdM1SzUQfsadcJb SOL/JITOSOL whirlpool TVL=$0.00 fee=  5bps ready=true
6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd SOL/JLP whirlpool TVL=$0.00 fee=  4bps ready=true
DkVN7RKTNjSSER5oyurf3vddQU2ZneSCYwXvpErvTCFA JUP/SOL whirlpool TVL=$0.00 fee=  1bps ready=true
C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz JUP/SOL whirlpool TVL=$0.00 fee=  5bps ready=true


     node utilities/fix_pool_meta.js \
      --in poolTrade/_BTC.raw.json \
      --out tradePool/_BTC.meta.json

    node _enrichment.js utilities/_STABLE_HOP.curated-2bps.json \
    --out poolTrade/_STABLE_HOP_E.json

     node utilities/_diagnose_triangles.js poolTrade/_STABLE_HOP.lowFee.json \
     --out poolTrade/_STABLE_HOP.curated-2bps.json \
     --merge 
     

     node utilities/_diagnose_pools2.js pools/quality_2bps.json \
     --log-tvl True \
     --minLiquidity 100000 \
     --maxFee 3 \
     --out pools/01_START.json

      node utilities/_diagnose_triangles.js pools/01_START.json \
        --merge  poolTrade/_STABLES.SOL.json
        --min-liquidity 100000 \
        --out pools/03_CIRCUIT.json
        --routes-out  tradePool/01_START.route.json


pvoBUaq2EmgsR5DpsrqwXcq27Qh9zSqbM5VDkdrgWof SOL/PENGU whirlpool TVL=$0.00 fee= 16bps ready=true
8GsWExrRFeBj1Nh8gCuVQZo3f6yzd1YFofGbwebh7uFh SOL/PENGU whirlpool TVL=$0.00 fee= 16bps ready=true
5sgXhG1c9VBceg6aVQguK3NnbPfHinERZj86As6zW5Be SOL/RAY whirlpool TVL=$0.00 fee= 16bps ready=true




2dVgZYJSYHpNN9grM9EvjayadEUmJwim9KZ6vgBLt5ZP SOL/PENGU whirlpool TVL=$0.00 fee=  4bps ready=false
27ZbVdmoUhG639CfqG6kW8a4VXZeGBi8Dd4HUXjVDxeS SOL/RAY whirlpool TVL=$0.00 fee=  4bps ready=true
5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9 SOL/BONK whirlpool TVL=$0.00 fee=  5bps ready=true
2veBbCPv4uqpEzR6R3MKQJEaRdXNWNYPFmLx7DDYksbg SOL/PENGU whirlpool TVL=$0.00 fee=  2bps ready=true
4VG8VFNo3EXiTA75mhh48qv55S6m3VA2uTQCzEt8kczb SOL/BONK whirlpool TVL=$0.00 fee=  4bps ready=true

*/
const fs = require('fs');
const path = require('path');
const { getSymbolFromMint } = require('./symbolDisplay');
const {
  mergeCanonicalPool,
  validateRouteLegContract,
} = require('../math/poolContract');
const { ROUNDTRIP_POOLS, ROUNDTRIP_PAIRS } = require('./roundtripPoolRegistry.js');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYJc8rwxYLaidP';

const SYMBOL_TO_MINT = new Map(Object.entries({
  SOL,
  WSOL: SOL,
  USDC,
  USDT,
  BSOL: 'bSo13r4TkiE4i7NiZpXTXXd7XdTvAjA3VWkZ9z5gCDW',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  MSOL: 'mSoLzYCxHd97nZzJ9arLuhou8bM2N2bWy2Dk8y3BPRg',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eK1AUXGgWqjEicrdN9cvuBmS1nztz3jgj',
  BONK: 'DezXAZ8z7PnrnRJjz3WdUeowUQbgrVgpB4mfA4D4Mjpump',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL2623Er3gDg',
  TRUMP: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  CBBTC: 'cbbtci5XyTV8d4Ko8F6E2U3UXQG3QnQ5JGZYuQ1Xn4w',
  PUMP: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
}));

const POOL_TYPES = [
  'clmm',
  'cpmm',
  'dlmm',
  'whirlpool',
  'damm_v2',
  'pancakeswap',
  'pumpswap',
  'unknown',
];

function short(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : (text || '?');
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveBigInt(value) {
  try {
    const text = String(value ?? '0').trim();
    const whole = text.includes('.') ? text.split('.')[0] : text;
    return BigInt(whole || '0') > 0n;
  } catch (_) {
    return false;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function cleanSymbol(value) {
  const text = String(value || '').trim();
  return text && text !== 'null' && text !== 'undefined' ? text : null;
}

function mintValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return String(
      value.mint
      || value.address
      || value.pubkey
      || value.id
      || value.tokenMint
      || '',
    ).trim();
  }
  return String(value || '').trim();
}

function arrayLength(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function poolAddress(pool = {}) {
  return String(pool.poolAddress || pool.address || pool.pubkey || pool.id || '').trim();
}

function baseMint(pool = {}) {
  return mintValue(pool.baseMint || pool.tokenXMint || pool.mintA || pool.tokenAMint || pool.tokenA);
}

function quoteMint(pool = {}) {
  return mintValue(pool.quoteMint || pool.tokenYMint || pool.mintB || pool.tokenBMint || pool.tokenB);
}

function normalizePool(pool = {}) {
  return mergeCanonicalPool(pool || {});
}

function baseSymbol(pool = {}) {
  return cleanSymbol(firstDefined(
    pool.baseSymbol,
    pool.tokenXSymbol,
    pool.tokenASymbol,
    pool.tokenA?.symbol,
    pool.mintA?.symbol,
    getSymbolFromMint(baseMint(pool)),
  ));
}

function quoteSymbol(pool = {}) {
  return cleanSymbol(firstDefined(
    pool.quoteSymbol,
    pool.tokenYSymbol,
    pool.tokenBSymbol,
    pool.tokenB?.symbol,
    pool.mintB?.symbol,
    getSymbolFromMint(quoteMint(pool)),
  ));
}

function pairSymbol(pool = {}) {
  const base = baseSymbol(pool) || short(baseMint(pool));
  const quote = quoteSymbol(pool) || short(quoteMint(pool));
  return `${base}/${quote}`;
}

function tvlUsd(pool = {}) {
  return toNumber(pool.tvlUsd ?? pool.tvl ?? pool.liquidityUsd ?? pool.liquidity ?? pool.totalLiquidityUsd, 0);
}

function hasSol(pool = {}) {
  return baseMint(pool) === SOL || quoteMint(pool) === SOL;
}

function hasUsdc(pool = {}) {
  return baseMint(pool) === USDC || quoteMint(pool) === USDC;
}

function isSolUsdc(pool = {}) {
  const a = baseMint(pool);
  const b = quoteMint(pool);
  return (a === SOL && b === USDC) || (a === USDC && b === SOL);
}

function hasPositiveReserves(pool = {}) {
  const x = firstDefined(
    pool.xReserve,
    pool.reserveX,
    pool.baseReserve,
    pool.reserve0,
    pool.reserves?.x,
    pool.reserve_x_amount,
    pool.tokenAAmount,
  );
  const y = firstDefined(
    pool.yReserve,
    pool.reserveY,
    pool.quoteReserve,
    pool.reserve1,
    pool.reserves?.y,
    pool.reserve_y_amount,
    pool.tokenBAmount,
  );
  return toPositiveBigInt(x) && toPositiveBigInt(y);
}

function hasPriceSignal(pool = {}) {
  return toNumber(firstDefined(pool.currentPrice, pool.price, pool.midPrice), 0) > 0
    || toNumber(firstDefined(pool.sqrtPriceX64, pool.sqrtPrice), 0) > 0;
}

function hasTick(pool = {}) {
  return firstDefined(
    pool.tickCurrent,
    pool.currentTick,
    pool.currentTickIndex,
    pool.tickCurrentIndex,
    pool.tick,
    pool?.state?.tickCurrent,
  ) !== undefined;
}

function tickArrayCount(pool = {}) {
  return arrayLength(
    pool.tickArrays,
    pool.tickArrayData,
    pool.remainingAccounts,
    pool?.aux?.clmm?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrays,
  );
}

function binArrayCount(pool = {}) {
  return arrayLength(pool.binArrays, pool.binArrayData, pool?.aux?.dlmm?.binArrays);
}

function binCount(pool = {}) {
  return arrayLength(pool.bins, pool?.aux?.dlmm?.bins);
}

function hasBinStep(pool = {}) {
  return toNumber(firstDefined(pool.binStep, pool.bin_step, pool?.aux?.dlmm?.binStep), 0) > 0;
}

function normalizeType(pool = {}) {
  const dex = String(pool.dex || pool.source || pool.protocol || '').toLowerCase();
  const dexType = String(pool.dexType || pool.poolType || '').toLowerCase();
  const type = String(pool.type || pool.mathType || '').toLowerCase();
  const combined = `${dex} ${dexType} ${type}`;

  if (combined.includes('pancake')) return 'pancakeswap';
  if (combined.includes('pump')) return 'pumpswap';
  if (combined.includes('damm_v2') || combined.includes('dammv2') || combined.includes('damm v2')) return 'damm_v2';
  if (combined.includes('dlmm')) return 'dlmm';
  if (combined.includes('whirlpool') || combined.includes('orca')) return 'whirlpool';
  if (combined.includes('clmm') || combined.includes('concentrated')) return 'clmm';
  if (combined.includes('cpmm') || combined.includes('amm') || dex.includes('raydium')) return 'cpmm';
  return 'unknown';
}

function readinessForPool(pool = {}) {
  const type = normalizeType(pool);
  const missing = [];
  const warnings = [];

  if (!poolAddress(pool)) missing.push('poolAddress');
  if (!baseMint(pool)) missing.push('baseMint/tokenXMint');
  if (!quoteMint(pool)) missing.push('quoteMint/tokenYMint');

  if (type === 'dlmm') {
    if (!hasBinStep(pool)) missing.push('binStep');
    if (binCount(pool) === 0 && binArrayCount(pool) === 0) missing.push('bins/binArrays');
    if (firstDefined(pool.activeBinId, pool.activeId, pool.active_bin_id) === undefined) warnings.push('missing activeBinId');
  } else if (type === 'clmm') {
    if (!hasTick(pool)) missing.push('tick/currentTick');
    if (tickArrayCount(pool) === 0) missing.push('tickArrays/tickArrayData');
    if (!hasPriceSignal(pool)) warnings.push('missing sqrtPriceX64/currentPrice');
  } else if (type === 'whirlpool') {
    if (!hasTick(pool)) missing.push('tick/currentTick');
    if (tickArrayCount(pool) === 0) missing.push('tickArrays');
    if (!hasPriceSignal(pool)) warnings.push('missing sqrtPriceX64/currentPrice');
  } else if (type === 'cpmm' || type === 'pancakeswap' || type === 'pumpswap') {
    if (!hasPositiveReserves(pool)) missing.push('xReserve/yReserve');
    if (!hasPriceSignal(pool)) warnings.push('missing price signal; reserve math can still quote');
  } else if (type === 'damm_v2') {
    if (!hasPositiveReserves(pool) && !hasPriceSignal(pool)) missing.push('reserves or sqrt/currentPrice');
    if (hasPositiveReserves(pool) && !hasPriceSignal(pool)) warnings.push('reserve-only DAMM v2 quote is diagnostic');
  } else {
    if (!hasPositiveReserves(pool) && !hasPriceSignal(pool)) missing.push('reserves or price signal');
  }

  return {
    type,
    mathReady: missing.length === 0,
    missing,
    warnings,
    facts: {
      tvlUsd: tvlUsd(pool),
      hasReserves: hasPositiveReserves(pool),
      hasTick: hasTick(pool),
      tickArrayCount: tickArrayCount(pool),
      hasBinStep: hasBinStep(pool),
      binCount: binCount(pool),
      binArrayCount: binArrayCount(pool),
      hasPriceSignal: hasPriceSignal(pool),
    },
  };
}

function parseArgs(argv) {
  const args = {
    filePath: '',
    outPath: '',
    minLiquidity: 0,
    targetMids: [],
    targetAnchorMints: [SOL],
    onlyTargetAnchorPairs: false,
    mathReadyOnly: false,
    maxPerPair: 3,
    maxPools: 0,
    logTvl: true,
    sampleSize: 3,
    maxFeeBps: 5,
  };

  const setValue = (key, value) => {
    const k = String(key || '').replace(/^--?/, '').toLowerCase();
    if (['out', 'output', 'json', 'save'].includes(k)) args.outPath = value;
    else if (['minliquidity', 'min-liquidity', 'minliquidity(pool)', 'min-liquidity(pool)', 'mintvl', 'min-tvl'].includes(k)) {
      args.minLiquidity = Math.max(0, Number(value || 0));
    } else if (['logtvl', 'log-tvl'].includes(k)) {
      args.logTvl = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
    } else if (['samples', 'sample-size'].includes(k)) {
      args.sampleSize = Math.max(0, Number(value || args.sampleSize));
    } else if (['target-mids', 'targetmids'].includes(k)) {
      args.targetMids = parseMintCsv(value);
    } else if (['target-anchor-mints', 'targetanchors', 'anchors', 'anchor-mints'].includes(k)) {
      args.targetAnchorMints = parseMintCsv(value);
    } else if (['only-target-anchor-pairs', 'target-anchor-only'].includes(k)) {
      args.onlyTargetAnchorPairs = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
    } else if (['math-ready-only', 'ready-only'].includes(k)) {
      args.mathReadyOnly = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
    } else if (['max-per-pair', 'maxperpair'].includes(k)) {
      args.maxPerPair = Math.max(0, Number(value || 0));
    } else if (['max-pools', 'limit'].includes(k)) {
      args.maxPools = Math.max(0, Number(value || 0));
    } else if (['maxfee', 'max-fee', 'maxfeebps', 'max-fee-bps'].includes(k)) {
      args.maxFeeBps = Math.max(0, Number(value || 0));
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.split('=');
      setValue(key, rest.join('='));
    } else if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        setValue(arg, next);
        i += 1;
      } else {
        setValue(arg, 'true');
      }
    } else if (!args.filePath) {
      args.filePath = arg;
    }
  }

  if (!args.outPath && args.filePath) {
    const parsed = path.parse(args.filePath);
    args.outPath = path.join(parsed.dir || '.', `${parsed.name}.diagnostic.json`);
  }

  return args;
}

function resolveMint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return SYMBOL_TO_MINT.get(text.toUpperCase()) || text;
}

function parseMintCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => resolveMint(item))
    .filter(Boolean);
}

function samePathMaybe(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function inferRouteLeg(pool, tokenInMint, tokenOutMint, routeMeta = {}) {
  const normalized = normalizePool(pool || {});
  const address = poolAddress(normalized);
  const tokenXMint = baseMint(normalized);
  const tokenYMint = quoteMint(normalized);
  const inMint = mintValue(tokenInMint || normalized.tokenInMint || normalized.inputMint);
  const outMint = mintValue(tokenOutMint || normalized.tokenOutMint || normalized.outputMint);
  const aToB = inMint && inMint === tokenXMint;
  const bToA = inMint && inMint === tokenYMint;

  const leg = {
    ...normalized,
    poolAddress: address,
    address,
    legIndex: routeMeta.legIndex,
    routeId: routeMeta.routeId || normalized.routeId || null,
    routePath: routeMeta.routePath || normalized.routePath || null,
    tokenInMint: inMint,
    tokenOutMint: outMint,
    inputMint: inMint,
    outputMint: outMint,
    swapDirection: normalized.swapDirection || (aToB ? 'A_TO_B' : (bToA ? 'B_TO_A' : null)),
    swapForY: normalized.swapForY ?? (aToB ? true : (bToA ? false : null)),
    inputDecimals: normalized.inputDecimals ?? (aToB ? normalized.tokenXDecimals : (bToA ? normalized.tokenYDecimals : null)),
    outputDecimals: normalized.outputDecimals ?? (aToB ? normalized.tokenYDecimals : (bToA ? normalized.tokenXDecimals : null)),
  };

  const contract = validateRouteLegContract(leg);
  return {
    leg,
    valid: contract.valid && Boolean(address) && Boolean(inMint) && Boolean(outMint),
    missing: contract.missing,
  };
}

function routePathMintsFromArray(route = []) {
  if (!Array.isArray(route) || route.length !== 3) return null;
  const firstIn = mintValue(route[0]?.tokenInMint || route[0]?.inputMint || route[0]?.tokenA || route[0]?.baseMint || route[0]?.tokenXMint);
  const firstOut = mintValue(route[0]?.tokenOutMint || route[0]?.outputMint);
  const secondOut = mintValue(route[1]?.tokenOutMint || route[1]?.outputMint);
  const thirdOut = mintValue(route[2]?.tokenOutMint || route[2]?.outputMint);
  if (firstIn && firstOut && secondOut && thirdOut) return [firstIn, firstOut, secondOut, thirdOut];
  return null;
}

function normalizeRoute(route, routeIndex = 0) {
  if (!route || typeof route !== 'object') return null;

  const rawLegs = Array.isArray(route)
    ? route
    : (
      Array.isArray(route.legs) ? route.legs
        : Array.isArray(route.route) ? route.route
          : Array.isArray(route.hops) ? route.hops
            : (route.leg1 && route.leg2 && route.leg3) ? [route.leg1, route.leg2, route.leg3]
              : null
    );
  if (!Array.isArray(rawLegs) || rawLegs.length !== 3) return null;

  const explicitMints = routePathMintsFromArray(rawLegs);
  const routeId = route.routeId || rawLegs[0]?.routeId || `diag-${routeIndex + 1}`;
  const routePath = route.routePath || rawLegs[0]?.routePath || null;
  const normalized = [];
  const missing = [];

  for (let i = 0; i < rawLegs.length; i += 1) {
    const raw = rawLegs[i] || {};
    const embeddedPool = raw.pool || raw.poolMeta || raw.poolInfo || raw.poolData || raw;
    const tokenIn = mintValue(raw.tokenInMint || raw.inputMint || explicitMints?.[i]);
    const tokenOut = mintValue(raw.tokenOutMint || raw.outputMint || explicitMints?.[i + 1]);
    const result = inferRouteLeg(embeddedPool, tokenIn, tokenOut, {
      legIndex: i + 1,
      routeId,
      routePath,
    });
    if (!result.valid) missing.push({ legIndex: i + 1, missing: result.missing });
    normalized.push(result.leg);
  }

  if (missing.length) return { valid: false, route: normalized, missing };
  return { valid: true, route: normalized, missing: [] };
}

function normalizeRoutesFromContainer(raw) {
  const out = [];
  const rejected = [];
  const containers = [
    raw,
    raw?.routePrep,
    raw?.runtime,
  ].filter(Boolean);

  for (const container of containers) {
    for (const key of ['chainRoutes', 'routes', 'submissionCandidates', 'candidates']) {
      const routes = container[key];
      if (!Array.isArray(routes)) continue;
      routes.forEach((route, index) => {
        const normalized = normalizeRoute(route, index);
        if (normalized?.valid) out.push(normalized.route);
        else if (normalized) rejected.push({ key, index, missing: normalized.missing });
      });
    }
  }

  if (Array.isArray(raw)) {
    const looksLikeRoutes = raw.some((item) => item && typeof item === 'object' && (
      Array.isArray(item)
      || Array.isArray(item.legs)
      || Array.isArray(item.route)
      || Array.isArray(item.hops)
      || (item.leg1 && item.leg2 && item.leg3)
    ));
    if (looksLikeRoutes) {
      raw.forEach((route, index) => {
        const normalized = normalizeRoute(route, index);
        if (normalized?.valid) out.push(normalized.route);
        else if (normalized) rejected.push({ key: 'root', index, missing: normalized.missing });
      });
    }
  }

  const seen = new Set();
  const unique = out.filter((route) => {
    const key = route.map((leg) => poolAddress(leg)).join('>');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { chainRoutes: unique, rejectedRoutes: rejected };
}

function routeLegPools(route) {
  const out = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const normalized = normalizePool(value);
    if (poolAddress(normalized) && baseMint(normalized) && quoteMint(normalized)) {
      out.push(normalized);
      return;
    }
    const maybePool = value.pool || value.poolMeta || value.poolInfo || value.poolData;
    if (maybePool && typeof maybePool === 'object') visit(maybePool);
  };

  if (Array.isArray(route)) {
    for (const leg of route) visit(leg);
    return out;
  }

  for (const key of ['legs', 'route', 'path', 'hops', 'instructions']) {
    const legs = route?.[key];
    if (Array.isArray(legs)) {
      for (const leg of legs) visit(leg);
    }
  }
  return out;
}

function extractPoolsFromRouteContainer(raw) {
  const out = [];
  const containers = [
    raw,
    raw?.routePrep,
    raw?.runtime,
  ].filter(Boolean);

  for (const container of containers) {
    for (const key of ['pools', 'data', 'filteredPools', 'exportPools']) {
      if (Array.isArray(container[key])) out.push(...container[key]);
    }
    for (const key of ['routes', 'chainRoutes', 'triangles', 'submissionCandidates', 'candidates']) {
      const routes = container[key];
      if (!Array.isArray(routes)) continue;
      for (const route of routes) out.push(...routeLegPools(route));
    }
  }

  if (Array.isArray(raw)) {
    const looksLikeRoutes = raw.some((item) => item && typeof item === 'object' && (
      Array.isArray(item)
      || Array.isArray(item.legs)
      || Array.isArray(item.route)
      || Array.isArray(item.path)
      || Array.isArray(item.hops)
    ));
    if (looksLikeRoutes) {
      for (const route of raw) out.push(...routeLegPools(route));
    } else {
      out.push(...raw);
    }
  }

  const seen = new Set();
  return out.filter((pool) => {
    if (!pool || typeof pool !== 'object') return false;
    const address = poolAddress(pool);
    if (!address) return false;
    const key = `${normalizeType(pool)}:${address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadPools(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return extractPoolsFromRouteContainer(raw).map((pool) => normalizePool(pool));
}

function loadRoutePayload(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    raw,
    pools: extractPoolsFromRouteContainer(raw).map((pool) => normalizePool(pool)),
    routes: normalizeRoutesFromContainer(raw),
  };
}

function summarizeGroup(rows) {
  const ready = rows.filter((row) => row.readiness.mathReady);
  return {
    count: rows.length,
    mathReady: ready.length,
    notReady: rows.length - ready.length,
    withSol: rows.filter((row) => hasSol(row.pool)).length,
    withUsdc: rows.filter((row) => hasUsdc(row.pool)).length,
    solUsdcDirect: rows.filter((row) => isSolUsdc(row.pool)).length,
    totalTvlUsd: rows.reduce((sum, row) => sum + row.tvlUsd, 0),
  };
}

function diagnose(filePath, options = {}) {
  const loaded = loadRoutePayload(filePath);
  const pools = loaded.pools;
  const chainRoutes = loaded.routes.chainRoutes;
  const feeRate = options.feeRate;
  const routeUsedAddresses = new Set(chainRoutes.flatMap((route) => route.map((leg) => poolAddress(leg)).filter(Boolean)));
  const minLiquidity = options.minLiquidity;
  const targetSet = new Set(options.targetMids || []);
  const anchorSet = new Set(options.targetAnchorMints || []);
  const rows = pools.map((pool, index) => {
    const readiness = readinessForPool(pool);
    return {
      index,
      type: readiness.type,
      pool,
      address: poolAddress(pool),
      baseMint: baseMint(pool),
      quoteMint: quoteMint(pool),
      baseSymbol: baseSymbol(pool),
      quoteSymbol: quoteSymbol(pool),
      pairSymbol: pairSymbol(pool),
      tvlUsd: tvlUsd(pool),
      readiness,
    };
  });

  let filteredRows = minLiquidity === null || minLiquidity === undefined
    ? rows
    : rows.filter((row) => row.tvlUsd >= minLiquidity);
  const afterLiquidity = filteredRows.length;
  const maxFeeBps = options.maxFeeBps;
  if (maxFeeBps > 0) {
    filteredRows = filteredRows.filter((row) => {
      const fee = Number(row.pool.feeBps ?? (row.pool.feeRate != null ? Math.round(row.pool.feeRate * 10000) : 0));
      return fee <= maxFeeBps;
    });
  }
  const afterMaxFee = filteredRows.length;

  const beforeMathReady = filteredRows.length;
  if (options.mathReadyOnly) {
    filteredRows = filteredRows.filter((row) => row.readiness.mathReady);
  }

  const beforeTargetAnchor = filteredRows.length;
  if (options.onlyTargetAnchorPairs && targetSet.size && anchorSet.size) {
    filteredRows = filteredRows.filter((row) => {
      const a = row.baseMint;
      const b = row.quoteMint;
      return (targetSet.has(a) && anchorSet.has(b))
        || (targetSet.has(b) && anchorSet.has(a))
        || (anchorSet.has(a) && anchorSet.has(b));
    });
  }

  const beforeCaps = filteredRows.length;
  filteredRows = [...filteredRows].sort((a, b) => b.tvlUsd - a.tvlUsd);
  if (options.maxPerPair > 0) {
    const counts = new Map();
    filteredRows = filteredRows.filter((row) => {
      const key = [row.baseMint, row.quoteMint].sort().join('/');
      const count = counts.get(key) || 0;
      if (count >= options.maxPerPair) return false;
      counts.set(key, count + 1);
      return true;
    });
  }
  if (options.maxPools > 0) {
    filteredRows = filteredRows.slice(0, options.maxPools);
  }

  const byType = Object.fromEntries(POOL_TYPES.map((type) => [type, []]));
  for (const row of filteredRows) byType[row.type].push(row);

  const summary = {
    source: path.resolve(filePath),
    generatedAt: new Date().toISOString(),
    totalPools: pools.length,
    maxFeeBps,
    minLiquidity,
    targetMids: [...targetSet],
    targetAnchorMints: [...anchorSet],
    onlyTargetAnchorPairs: Boolean(options.onlyTargetAnchorPairs),
    mathReadyOnly: Boolean(options.mathReadyOnly),
    maxPerPair: options.maxPerPair || 0,
    maxPools: options.maxPools || 0,
    filteredPools: filteredRows.length,
    droppedByMinLiquidity: rows.length - afterLiquidity,
    droppedByMaxFee: afterLiquidity - afterMaxFee,
    droppedByMathReady: beforeMathReady - (options.mathReadyOnly ? beforeTargetAnchor : beforeMathReady),
    droppedByTargetAnchor: beforeTargetAnchor - beforeCaps,
    droppedByCaps: beforeCaps - filteredRows.length,
    byType: Object.fromEntries(Object.entries(byType).map(([type, group]) => [type, summarizeGroup(group)])),
  };

  const details = filteredRows.map((row) => ({
    index: row.index,
    poolAddress: row.address,
    type: row.type,
    dex: row.pool.dex || row.pool.source || null,
    dexType: row.pool.dexType || null,
    baseMint: row.baseMint || null,
    quoteMint: row.quoteMint || null,
    baseSymbol: row.baseSymbol || null,
    quoteSymbol: row.quoteSymbol || null,
    pairSymbol: row.pairSymbol,
    tvlUsd: row.tvlUsd,
    feeBps: Number(row.pool.feeBps ?? (row.pool.feeRate != null ? Math.round(row.pool.feeRate * 10000) : 0)),
    mathReady: row.readiness.mathReady,
    missing: row.readiness.missing,
    warnings: row.readiness.warnings,
    facts: row.readiness.facts,
  }));

  let filteredPools = filteredRows.map((row) => row.pool);
  const beforeOrphanDrop = filteredPools.length;
  if (chainRoutes.length) {
    filteredPools = filteredPools.filter((pool) => routeUsedAddresses.has(poolAddress(pool)));
  }
  const droppedOrphanPools = beforeOrphanDrop - filteredPools.length;

  summary.chainRouteCount = chainRoutes.length;
  summary.rejectedRouteCount = loaded.routes.rejectedRoutes.length;
  summary.routedPoolCount = routeUsedAddresses.size;
  summary.droppedOrphanPools = droppedOrphanPools;

  // 'pools' key makes this output directly pipeable into _enrichment.js / other pipeline tools.
  // 'filteredPools' is kept for backward compatibility with existing readers.
  return {
    summary,
    details,
    chainRoutes,
    rejectedRoutes: loaded.routes.rejectedRoutes,
    pools: filteredPools,
    filteredPools,
  };
}

function printReport(report, options = {}) {
  console.log('='.repeat(76));
  console.log('POOL COMPOSITION DIAGNOSTIC');
  console.log('='.repeat(76));
  console.log(`Source: ${report.summary.source}`);
  console.log(`Loaded: ${report.summary.totalPools}`);
  if (report.summary.chainRouteCount || report.summary.rejectedRouteCount) {
    console.log(
      `Routes: accepted=${report.summary.chainRouteCount} `
      + `rejected=${report.summary.rejectedRouteCount} `
      + `routedPools=${report.summary.routedPoolCount} `
      + `orphansDropped=${report.summary.droppedOrphanPools}`,
    );
  }
  if (report.summary.minLiquidity !== null && report.summary.minLiquidity !== undefined) {
    console.log(`Min liquidity filter: $${report.summary.minLiquidity}`);
    console.log(`After all filters: ${report.summary.filteredPools} pools`);
    console.log(`Dropped by liquidity: ${report.summary.droppedByMinLiquidity}`);
    if (Number(report.summary.maxFeeBps || 0) > 0) {
      console.log(`Max fee filter: ${report.summary.maxFeeBps} bps`);
      console.log(`Dropped by max fee: ${report.summary.droppedByMaxFee}`);
    }
    if (report.summary.mathReadyOnly) console.log(`Dropped by math readiness: ${report.summary.droppedByMathReady}`);
    if (report.summary.onlyTargetAnchorPairs) console.log(`Dropped by target/anchor pair filter: ${report.summary.droppedByTargetAnchor}`);
    if (report.summary.maxPerPair || report.summary.maxPools) console.log(`Dropped by caps: ${report.summary.droppedByCaps}`);
  }

  console.log('\n[1] Pool Count And Math Readiness');
  console.log('-'.repeat(76));
  for (const [type, group] of Object.entries(report.summary.byType)) {
    if (group.count === 0) continue;
    console.log(
      `${type.padEnd(12)} count=${String(group.count).padStart(4)} `
      + `ready=${String(group.mathReady).padStart(4)} `
      + `notReady=${String(group.notReady).padStart(4)} `
      + `SOL=${String(group.withSol).padStart(4)} `
      + `USDC=${String(group.withUsdc).padStart(4)} `
      + `SOL/USDC=${String(group.solUsdcDirect).padStart(3)} `
      + `TVL=$${group.totalTvlUsd.toFixed(2)}`,
    );
  }

  console.log('\n[2] Not Ready Reasons');
  console.log('-'.repeat(76));
  const notReady = report.details.filter((row) => !row.mathReady);
  if (notReady.length === 0) {
    console.log('All filtered pools are math-ready for their pool type.');
  } else {
    const reasonCounts = new Map();
    for (const row of notReady) {
      const key = `${row.type}: ${row.missing.join(', ')}`;
      reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
    }
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(count).padStart(4)}  ${reason}`);
    }
  }

  console.log('\n[3] Sample Pools');
  console.log('-'.repeat(76));
  for (const type of POOL_TYPES) {
    const samples = report.details.filter((row) => row.type === type).slice(0, options.sampleSize ?? 3);
    if (!samples.length) continue;
    console.log(`\n${type.toUpperCase()}`);
    for (const row of samples) {
      const missing = row.missing.length ? ` missing=${row.missing.join('|')}` : '';
      console.log(`  ${short(row.poolAddress)} ${row.pairSymbol} TVL=$${row.tvlUsd.toFixed(2)} ready=${row.mathReady}${missing}`);
    }
  }

  if (options.logTvl) {
    console.log('\n[4] TVL By Pool Address');
    console.log('-'.repeat(76));
    for (const row of [...report.details].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
      console.log(`${row.poolAddress || '?'} ${row.pairSymbol} ${row.type} TVL=$${row.tvlUsd.toFixed(2)} fee=${String(row.feeBps ?? 0).padStart(3)}bps ready=${row.mathReady}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    console.log('Usage: node utilities/_diagnose_pools2.js <pools.json> [--minLiquidity N] [--target-mids CSV] [--only-target-anchor-pairs] [--max-per-pair N] [--out file.json]');
    process.exit(1);
  }
  if (samePathMaybe(args.filePath, args.outPath)) {
    console.error('Refusing to write diagnostic JSON over the input pool file.');
    console.error(`Input:  ${path.resolve(args.filePath)}`);
    console.error(`Output: ${path.resolve(args.outPath)}`);
    process.exit(1);
  }

  const report = diagnose(args.filePath, args);
  printReport(report, args);

  fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(report, null, 2));
  console.log(`\nSaved diagnostic JSON: ${path.resolve(args.outPath)}`);
}

module.exports = {
  diagnose,
  readinessForPool,
  normalizeType,
};

if (require.main === module) {
  main();
}
/*

    node utilities/_diagnose_2Way.js pools/03_CIRCUIT.json
        --out pools/03_CIRCUIT_E.json

    node utilities/fix_pool_meta.js poolTrade/_STABLE.raw.json
    --out poolTrade/_STABLE.meta.json

    node _enrichment.js pools/03_CIRCUIT.json \

node utilities/_diagnose_pools2.js pools/_custom_FETCH.json \
    --minLiquidity 500000 \
    --samples 3 \
    --maxFee 5 \
    --log-tvl true \
    --out pools/01_START.json

  More focused version:
 --merge poolTrade/_STABLES_HOP.curated.json \

 node _enrichment pools/03_CIRCUIT_E.json
 --out 02_ENRICHED.json

  node utilities/_diagnose_pools2.js poolTrade/_STABLES_HOP.curated.json \
    --maxFee 5 \
    --max-per-pair 4 \
    --log-tvl true \
    --out pools/03_CIRCUIT_E.json

  Target anchor pairs only:

  node utilities/_diagnose_pools2.js pools/all_quality_pools.json \
    --target-mids SOL,USDC,JLP \
    --only-target-anchor-pairs \
    --minLiquidity 1000000 \
    --out reports/diagnose_target_pairs.json

  2. Diagnose Triangles And Export Routed Pools
  Use this to scan for 3-leg chains and export chainRoutes:

  node utilities/_diagnose_triangles.js pools/01_START.json  \
    --routes-out tradePool/_STABLE_HOP.curated.json \
    --max-routes-per-triangle 2 \
    --out pools/01_START.json

  With merge pools:

  node utilities/_diagnose_pools2.js poolTrade/_STABLE_HOP.fetch.json  \
    --out tradePool/_STABLE_HOP._Ejson  \
     --log-tvl true \
     --maxFee 5

=======================================================
=======================================================    
    
    node config/getPool_shyft.js --preset stables \
    --minLiquidity 200000 --max-fee 3 \
    --preset stables  \
    --out poolSelection/_STABLE_HOP.fetch.lowfees.json

    node _enrichmentFetch.js --in poolSelection/_STABLE_HOP.fetch.lowfees.json\
    --out poolSelection/A_FETCH_GATED.json

    node _enrichment.js poolSelection/A_FETCH_GATED.json \
    --out poolSelection/B_PROCESS.json

    node utilities/_diagnose_pools2.js  poolSelection/B_PROCESS.json \
    --out tradePool/_STABLE_HOP.curated.json \
    --log-tvl true \
    --max-fee 3 \
    --max-routes-per-triangle 2

     node utilities/_diagnose_2Way.js poolSelection/B_PROCESS.json  \
    --out poolSelection/_STABLE_HOP_2Way.json

    node utilities/_diagnose_triangles.js tradePool/_STABLE_HOP.curated.json \
    --out poolSelection/_STABLE_HOP_routed.json  \
    --minLiquidity 200000 \
    --max-routes-per-triangle 2

=======================================================

    node _enrichmentFetch.js pools/03_CIRCUIT.json \
    --out pools/03_CIRCUIT_E.json

    node _enrichment.js poolSelection/A_FETCH_GATED.json \
    --out poolSelection/B_PROCESS.json

    node utilities/_diagnose_pools2.js  pools/03_CIRCUIT_E.json \
    --out pools/03_CIRCUIT.json \
    minLiquidity 200000 \
    --log-tvl true \
    --maxFees 5 \
    --max-routes-per-triangle 4

     node utilities/_diagnose_2Way.js poolSelection/B_PROCESS.json  \
    --out poolSelection/_STABLE_HOP_2Way.json

    node utilities/_diagnose_triangles.js poolTrade/_STABLES.SOL.json \
    --merge pools/03_CIRCUIT.json,pools/raw_quality_stableHop.json,pools/raw_quality_stablePairs.json,tradePool/_STABLE_HOP_E.json \
    --out pools/03_CIRCUIT_E.json \
    --minLiquidity 200000 \
    --max-routes-per-triangle 8

       node utilities/_diagnose_pools2.js pools/raw_quality_candidates.json \
            --log-tvl True \
            --minLiquidity 200000 \
             --maxFees 5 \
            --out pools/01_START.json
=======================================================  

    node _enrichment.js tradePool/_STABLE_HOP._Ejson  \
    --out poolTrade/_STABLE_BTC.fetch_E.json 


    node utilities/_diagnose_pools2.js pools/_pool_SET_1.json \
    --out pools/03_CIRCUIT.json \
     --log-tvl true \
     --max-fee 5 \
    --max-routes-per-triangle 4


  With multiple merge files:

  node utilities/_diagnose_triangles.js pools/raw_quality_stableHop.json\
  --merge pools/03_CIRCUIT_E.json 
    --out pools/03_CIRCUIT.json \
    --minLiquidity 200000 \
    --max-routes-per-triangle 3

  Keep orphans instead of dropping non-routed pools:

  node utilities/_diagnose_triangles.js pools/raw_quality_candidates.json \
    --merge pools/all_quality_pools.json,pools/_BQ_pools.json \
    --routes-out pools/03_ROUTED_FULL.json \
    --max-routes-per-triangle 2 \
    --keep-orphans

 hit a good scan


AS5MV3ear4NZPMWXbCsEz3AdbCaXEnq4ChdaWsvLgkcM USDS/USDC clmm TVL=$37203282.80 fee=  1bps ready=false
3CiG1JsPHfwQFwbVPSArgvGH1soZy7ikef5m4gBcvxvE PRIME/CASH clmm TVL=$10106980.14 fee=  1bps ready=false
BCDdHonby65iduz3Ev3c9v5XjNkzyu5e56KRFHpBM4T9 USD1/USDC clmm TVL=$9887777.05 fee=  1bps ready=false
7riFsDxbskTqDtCSjev2jN9hyAJqeKmbWqgfiWD6ikUC USDY/USDC whirlpool TVL=$6570602.44 fee=  1bps ready=false
3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv WSOL/USDC clmm TVL=$6190237.82 fee=  4bps ready=false
9tXiuRRw7kbejLhZXtxDxYs2REe43uH2e7k1kocgdM9B PYUSD/USDC whirlpool TVL=$5372196.75 fee=  1bps ready=false
68soqftZg4HL1Dcis5hMgkLKU9qyC8qbn5JzLhrxhgi9 FDUSD/USDT whirlpool TVL=$5276534.94 fee=  1bps ready=false
BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU USDC/USDT clmm TVL=$4348575.66 fee=  1bps ready=false
DZ2vZJMLKt1cExzyFeyoGV3panTJufRFMiLXJKSa2mPP JupUSD/USDC dlmm TVL=$4011129.92 fee=  1bps ready=false
EUGzX8kKvbLB55idiETEdXm6NZzB3Dz7c1ui6wGhcviR JupUSD/USDC clmm TVL=$3993908.51 fee=  1bps ready=false
7Vuuo154V3gQRNSrXKtZoFuS5qW4x18piiHcGbMS5P9D EURC/USDT clmm TVL=$2711082.50 fee=  1bps ready=false
8hcwA1hr1bLGLHXBCadXWDgxsc1BTe4hAKPcQgTVNXL4 USDCet/USDC whirlpool TVL=$2025304.85 fee=  1bps ready=false
c84u6RqYAFEzv4zRDGYfev28zmJXqxswjishqKebtyS USDC/eUSD clmm TVL=$2000000.03 fee=  1bps ready=false
4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4 USDC/USDT whirlpool TVL=$1223791.60 fee=  1bps ready=false
BLTitxeaGZNpmGKqabx8Vo6tSaXj1vr7Gmucrg2M1TFy PYUSD/USDD clmm TVL=$994490.74 fee=  1bps ready=false
GEkienhw5Hdm7T2MugwtrzXAipSLNcRurfvgQdAVPSF USDC/USDC whirlpool TVL=$700087.68 fee=  1bps ready=false
spAPmogS9kn7YFp5VcrwP4JBKFkwj4TyX1ens4pMpQJ USDC/USDC whirlpool TVL=$699853.77 fee=  1bps ready=false
2EXiumdi14E9b8Fy62QcA5Uh6WdHS2b38wtSxp72Mibj USDT/USDC cpmm TVL=$556151.74 fee=  2bps ready=true


node utilities/poolFetchCustom_raw.js \
    --local-pools \
    --merge-ready pools/raw_quality_stableHop.json \
    --max-fee-bps 5 \
    --min-liquidity 200000 \
    --min-volume24h 0 \
    --min-trades24h 0 \
    --min-turnover 0 \
   --target-anchor-mints 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 'DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM', 'GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw', 'HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
    --target-mids 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 'DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM', 'GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw', 'HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
    --anchor-mints 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 'DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM', 'GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw', 'HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
    --only-target-anchor-pairs \
    --no-quality \
    --out pools/04_STABLES.json \
    --raw pools/04_STABLES_raw.json



*/
