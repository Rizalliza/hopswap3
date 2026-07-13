'use strict';
/**
 * poolFetchCustom_raw.js  (triangle-closure-aware)
 *
 * Goal of this rewrite
 * ====================
 * Previous selection ranked by activity score then deduped by per-pair count.
 * That funnels every run into deep stable-major pools (SOL/USDC/USDT/RAY) which
 * are saturated by HFT bots in milliseconds. Result: every triangle the engine
 * builds is some permutation of SOL→USDC→USDT→SOL, divergence is ~0.2 bps,
 * fees are ~4 bps, and net is always negative.
 *
 * The new selector is graph-aware and triangle-closure-driven:
 *
 *   1. Anchor hubs are SOL, USDC, USDT (mints any triangle must close back to).
 *   2. For every NON-anchor token T, we require either:
 *        (a) ≥2 distinct anchor connections (T↔SOL and T↔USDC), so the triangle
 *            SOL → T → USDC → SOL has all three legs available; OR
 *        (b) ≥2 pools to the SAME anchor (cross-DEX), so divergence is
 *            measurable on the T↔anchor pair (path SOL → T → SOL via two
 *            different DEXes is degenerate, but multi-pool same-anchor lets
 *            T↔anchor act as a divergent leg in a larger triangle).
 *   3. T must have ≥2 total pools across the candidate set, otherwise the
 *      divergenceScanner can't compute a comparable mid for it.
 *   4. Within each surviving T-bucket we pull the highest-activity pools but
 *      enforce FEE-TIER DIVERSITY (1 pool per fee bucket per T-anchor pair),
 *      so a 19 bps gross-edge route doesn't get killed because the only kept
 *      RAY/USDC pool is the 25 bps CPMM.
 *
 * The selector returns pools that are ALREADY SHAPED via the existing mappers
 * (mapRaydiumRaw/mapOrcaRaw/mapMeteoraRaw). It does NOT rebuild canonical
 * fields. Downstream consumers see exactly the same field set they did before
 * — divergenceScanner, zen_enrichment, myEngine all work unchanged.
 *
 * Backward compat
 * ---------------
 * `--quality` still works. The legacy `selectWithDiversity` is preserved and
 * available via `--select-mode legacy`. New default in quality mode is
 * `--select-mode triangle-closure`.
 *
 * `--quality 60` now correctly sets BOTH quality=true AND qualityCount=60
 * (was a CLI bug — the 60 was silently dropped).
 */
/**
 * poolFetchCustom_raw.js  (triangle-closure-aware)
 * CORRECTED: Fixed rate limiting on Cykura/Dradex, Invariant program ID check,
 * and added retry logic with exponential backoff for all on-chain fetches.
 */

const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const bs58Module = require('bs58');
const { Connection, PublicKey } = require('@solana/web3.js');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const { createRpcConnection, getConfiguredRpcUrls } = require('./rpcConnectionManager.js');
const { wrapConnection } = require('./rpcRateLimiter.js');
const {
    mergeCanonicalPool,
    validateRouteLegContract,
} = require('../math/poolContract');
const { ROUNDTRIP_POOLS, ROUNDTRIP_PAIRS } = require('./roundtripPoolRegistry.js');


let DEX_DIRECT_CONFIGS;
try {
    DEX_DIRECT_CONFIGS = require('./DEX_DIRECT_ENDPOINTS.js').DEX_DIRECT_CONFIGS;
} catch (_e) {
    DEX_DIRECT_CONFIGS = {
        raydium: {
            programIds: {
                clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
                cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
            }, config: { timeout: 60_000 }
        },
        orca: {
            programIds: { whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' },
            whirlpool: { endpoints: { list: 'https://api.mainnet.orca.so/v1/whirlpool/list' } }, config: { timeout: 60_000 }
        },
        meteora: { programIds: { dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' }, config: { timeout: 60_000 } },
    };
}

let selectByOpportunity, summarizeOpportunities;
try {
    ({ selectByOpportunity, summarizeOpportunities } = require('./opportunityPreSelector'));
} catch (_e) {
    selectByOpportunity = null;
}

let fetchBitqueryFrontendlessPools, getLastBitqueryFrontendlessReport;
try {
    ({ fetchBitqueryFrontendlessPools, getLastBitqueryFrontendlessReport } = require('./bitqueryFrontendlessFetcher'));
} catch (_e) {
    fetchBitqueryFrontendlessPools = null;
    getLastBitqueryFrontendlessReport = null;
}

const PROGRAM_IDS = {
    raydiumClmm: DEX_DIRECT_CONFIGS.raydium.programIds.clmm,
    raydiumCpmm: DEX_DIRECT_CONFIGS.raydium.programIds.cpmm,
    orca: DEX_DIRECT_CONFIGS.orca.programIds.whirlpool,
    meteoraDlmm: DEX_DIRECT_CONFIGS.meteora.programIds.dlmm,
    pancakeswapAmm: 'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq',
};

const PRICE_UNIT_Y_PER_X = 'tokenY_per_tokenX';
const bs58Encode = bs58Module.encode || bs58Module.default?.encode;
if (typeof bs58Encode !== 'function') {
    throw new Error('bs58 encoder unavailable');
}
const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PANCAKESWAP_PROGRAM_ID = 'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq';
const ANCHOR_POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
function loadOptionalAnchorCoder(idlPath, label) {
    try {
        return new BorshAccountsCoder(require(idlPath));
    } catch (error) {
        return { missing: true, label, idlPath, error: error.message };
    }
}
const DAMM_V2_CODER = loadOptionalAnchorCoder('../SDK/meteora-damm-v2-1/src/idl/cp_amm.json', 'Meteora DAMM v2');
const PUMPSWAP_CODER = loadOptionalAnchorCoder('../SDK/pump-swap-sdk-main/src/idl/pump_amm.json', 'PumpSwap');
const ALT_DEX_FALLBACK_FILES = [];
const DEFAULT_RAW_OUTPUT = 'tradePool/_MEME.tradeRAW.json';
const DEFAULT_OUTPUT = 'tradePool/_MEME.trade.json';
const DEFAULT_LIMIT = 10;

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const MSOL = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const BSOL = 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const TRUMP = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
const MET = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
const CBBTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const INF = '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm';
const PENGU = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
const HYPE = '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g';

const DEFAULT_ANCHOR_MINTS = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 'DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM', 'GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw', 'HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'];
const TARGET_MID_MINTS_DEFAULT = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 'DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM', 'GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw', 'HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'];//BSOL, JUP, RAY, BONK, WIF, MET, TRUMP
const MINT_SYMBOLS = new Map([
    [SOL, 'SOL'],
    [USDC, 'USDC'],
    [USDT, 'USDT'],
    [JITOSOL, 'JitoSOL'],
    [MSOL, 'mSOL'],
    [BSOL, 'bSOL'],
    [JUP, 'JUP'],
    [RAY, 'RAY'],
    [BONK, 'BONK'],
    [WIF, 'WIF'],
    [TRUMP, 'TRUMP'],
    [MET, 'MET'],
    [CBBTC, 'cbBTC'],
    [WETH, 'WETH'],
    [PUMP, 'PUMP'],
]);

const rejectPools = (
    "6WTbcDmtqDNwxxLe9YzHzpSSBKQ7AduZG7SmYWpRwjZZ"
)

const SYMBOL_MINTS = new Map(Array.from(MINT_SYMBOLS, ([mint, symbol]) => [String(symbol).toLowerCase(), mint]));

function resolveMintOrSymbol(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return SYMBOL_MINTS.get(raw.toLowerCase()) || raw;
}

function parseMintCsv(value) {
    return String(value || '').split(',').map(resolveMintOrSymbol).filter(Boolean);
}

function canonicalPairKey(a, b, sep = '|') {
    const left = resolveMintOrSymbol(a);
    const right = resolveMintOrSymbol(b);
    if (!left || !right) return '';
    return [left, right].sort().join(sep);
}

function parsePairSelectors(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const parts = entry.split(/[/:|-]/).map((part) => part.trim()).filter(Boolean);
            if (parts.length !== 2) return '';
            return canonicalPairKey(parts[0], parts[1]);
        })
        .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*                     NEW: Shared retry wrapper for RPC calls                */
/* -------------------------------------------------------------------------- */

async function withRetry(fn, maxRetries = 3, baseDelayMs = 2000) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const is429 = err?.message?.includes('429') || err?.response?.status === 429;
            const isRateLimit = err?.message?.includes('Too Many Requests') || is429;
            if (!isRateLimit && attempt < maxRetries) throw err; // Non-retryable error
            if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
                console.log(`    RPC retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function getRpcUrl() {
    return process.env.HELIUS_ENDPOINT1
        || process.env.RPC_URL
        || process.env.SOLANA_RPC_URL
        || 'https://api.mainnet-beta.solana.com';
}

function createFetchRpcConnection(options = {}) {
    const urls = getConfiguredRpcUrls();
    const raw = urls.length
        ? createRpcConnection({ urls, commitment: options.commitment || 'confirmed' })
        : new Connection(getRpcUrl(), { commitment: options.commitment || 'confirmed' });
    return wrapConnection(raw, {
        tokensPerSecond: Number(process.env.POOL_FETCH_RPC_TPS || options.tokensPerSecond || 6),
        burstCapacity: Number(process.env.POOL_FETCH_RPC_BURST || options.burstCapacity || 6),
        maxConcurrent: Number(process.env.POOL_FETCH_RPC_CONCURRENCY || options.maxConcurrent || 2),
    });
}

/* -------------------------------------------------------------------------- */
/*                                CLI parsing                                 */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
    const out = {
        out: DEFAULT_OUTPUT,
        rawOut: DEFAULT_RAW_OUTPUT,
        routesOut: '',
        routesMaxPerTriangle: 10,
        limit: DEFAULT_LIMIT,
        orca: true,
        raydiumClmm: true,
        raydiumCpmm: true,
        meteoraDlmm: true,
        meteoraDammV2: false,
        pumpSwap: false,
        pumpSwapScan: false,
        pancakeSwap: false,
        bitqueryLimit: Number(process.env.BITQUERY_FRONTENDLESS_LIMIT || 1000),
        bitqueryFamilies: 'PancakeSwap',
        bitqueryCredentialsFile: process.env.BITQUERY_CREDENTIALS_FILE || '',
        bitqueryTimeoutMs: Number(process.env.BITQUERY_FRONTENDLESS_TIMEOUT_MS || 15000),
        quality: true,
        qualityCount: 50,
        minLiquidity: 200_000,
        maxFeeBps: 5,
        altDexMinLiquidity: 250_000,
        altDexOut: '',
        maxPerPair: 4,
        maxPerDexType: 4,
        qualityMeta: true,
        localPools: true,

        overFetch: 6,
        rank: 'composite',
        minTurnover: 10000,
        minVolume24h: 2000,
        minTrades24h: 2000,
        minDivergence: 0,
        maxDivergence: 0,                 // 0 = off; >0 neutralizes pair divergence above this (bps)
        rejectDivergenceOutliers: true,   // use scanner's pairMidOutlier to stop boosting bad-mid pools
        divergenceWeight: 1,
        divergenceDiagnose: false,
        feeTierDiversity: false,
        ammScanMaxAccountsPerMint: 24,
        ammScanMaxAccountsTotal: 120,
        ammHydrateBatchSize: 50,
        ammHydrateBatchDelayMs: 250,
        ammScanTimeoutMs: 12_000,
        ammScanRetries: 0,
        opportunityFilter: false,
        opportunityMaxTriFee: 15,
        opportunityMaxPairFee: 15,
        opportunityMinCaptured: 1,
        opportunityMinTvl: 500000,
        opportunityMaxPools: 100,
        opportunityKeepDexWildcards: [],
        opportunityMaxDexWildcards: 40,
        includePairs: [],//WBTC, JLP, RAY, PRIME, CBBTC, JITOSOL, PYUSD, HYPE, WETH
        includeExactPairs: [],// 'SOL/BONK', 'SOL/RAY', 'SOL/PENGU'
        includeExactPairsExplicit: true,
        targetMids: [...TARGET_MID_MINTS_DEFAULT],
        onlyTargetAnchorPairs: false,
        targetAnchorMints: [SOL, USDC],
        excludeStableStable: false,
        rejectCpmmStableStable: true,
        excludePools: ['CdNGRJDzWpX8rWzoumvDkkVwHUczaxqEYT9iBJfBKRZ'],

        selectMode: true,//'triangle-closure',
        perDexQualityCount: 150,
        anchorMints: [...DEFAULT_ANCHOR_MINTS],
        minPoolsPerToken: 2,
        maxPoolsPerToken: 6,
        minPoolsPerTokenAnchor: 2,
        maxAnchorAnchorPools: 20,
        minSelectedPairPools: 2,
        maxSelectedPairPeerAdds: 60,
        requireTwoAnchorConnections: false,
        selectionDiagnose: false,
        selectionDiagnoseOut: 'pools/custom_raw_diagnostics.json',
        readyPoolInputs: ['pools/custom_raw.json'],                      // 'pools/_BQ_pools.diagnostic.json'
        bitqueryFamiliesExplicit: false,

    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--out' && next) { out.out = next; i += 1; }
        else if ((arg === '--routes-out' || arg === '--route-out' || arg === '--routed-out') && next) { out.routesOut = next; i += 1; }
        else if ((arg === '--routes-max-per-triangle' || arg === '--max-routes-per-triangle') && next) {
            out.routesMaxPerTriangle = Math.max(1, Number(next) || out.routesMaxPerTriangle);
            i += 1;
        }
        else if ((arg === '--raw' || arg === '--raw-out' || arg === '--raw-output') && next) { out.rawOut = next; i += 1; }
        else if (arg === '--limit' && next) { out.limit = Number(next) || DEFAULT_LIMIT; i += 1; }
        else if ((arg === '--quality-count' || arg === '--topN') && next) { out.qualityCount = Number(next) || out.qualityCount; i += 1; }
        else if (arg === '--min-liquidity' && next) { out.minLiquidity = Number(next) || 0; i += 1; }
        else if ((arg === '--max-fee-bps' || arg === '--max-fee') && next) { out.maxFeeBps = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--alt-dex-min-liquidity' && next) { out.altDexMinLiquidity = Number(next) || 0; i += 1; }
        else if (arg === '--alt-dex-out' && next) { out.altDexOut = next; i += 1; }
        else if (arg === '--max-per-pair' && next) { out.maxPerPair = Number(next) || out.maxPerPair; i += 1; }
        else if (arg === '--max-per-dex-type' && next) { out.maxPerDexType = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--quality-meta' && next) { out.qualityMeta = next; i += 1; }
        else if (arg === '--quality') {
            out.quality = true;
            const numericNext = Number(next);
            if (next && !next.startsWith('--') && Number.isFinite(numericNext) && numericNext > 0) {
                out.qualityCount = numericNext;
                i += 1;
            }
        }
        else if (arg === '--no-quality') out.quality = false;
        else if (arg === '--orca') out.orca = true;
        else if (arg === '--raydium-clmm') out.raydiumClmm = true;
        else if (arg === '--raydium-cpmm') out.raydiumCpmm = true;
        else if (arg === '--meteora') out.meteoraDlmm = true;
        else if (arg === '--damm-v2' || arg === '--meteora-damm-v2') out.meteoraDammV2 = true;
        else if (arg === '--no-damm-v2' || arg === '--no-meteora-damm-v2') out.meteoraDammV2 = false;
        else if (arg === '--pumpswap' || arg === '--pump-swap') out.pumpSwap = true;
        else if (arg === '--no-pumpswap' || arg === '--no-pump-swap') out.pumpSwap = false;
        else if (arg === '--pumpswap-scan' || arg === '--pump-swap-scan') {
            out.pumpSwap = true;
            out.pumpSwapScan = true;
        }
        else if (arg === '--no-pumpswap-scan' || arg === '--no-pump-swap-scan') out.pumpSwapScan = false;
        else if (arg === '--pancakeswap' || arg === '--pancake-swap' || arg === '--pancake') out.pancakeSwap = true;
        else if (arg === '--no-pancakeswap' || arg === '--no-pancake-swap' || arg === '--no-pancake') out.pancakeSwap = false;
        else if (arg === '--bitquery-limit' && next) { out.bitqueryLimit = Math.max(1, Number(next) || out.bitqueryLimit); i += 1; }
        else if ((arg === '--bitquery-families' || arg === '--bitquery-protocol-families') && next) {
            out.bitqueryFamilies = next;
            out.bitqueryFamiliesExplicit = true;
            i += 1;
        }
        else if ((arg === '--bitquery-credentials-file' || arg === '--bitquery-token-file') && next) { out.bitqueryCredentialsFile = next; i += 1; }
        else if (arg === '--bitquery-timeout-ms' && next) { out.bitqueryTimeoutMs = Math.max(3000, Number(next) || out.bitqueryTimeoutMs); i += 1; }
        else if (arg === '--raydium-only') {
            out.orca = false; out.raydiumClmm = true; out.raydiumCpmm = true; out.meteoraDlmm = true;
        }

        else if (arg === '--core-orderbooks-only') {
            out.orca = true;
            out.raydiumClmm = false;
            out.raydiumCpmm = false;
            out.meteoraDlmm = false;
            out.meteoraDammV2 = false;
            out.pumpSwap = false;
        }

        else if (arg === '--over-fetch' && next) { out.overFetch = Math.max(1, Number(next)); i += 1; }
        else if (arg === '--rank' && next) { out.rank = String(next).toLowerCase(); i += 1; }
        else if (arg === '--min-turnover' && next) { out.minTurnover = Number(next); i += 1; }
        else if (arg === '--min-volume24h' && next) { out.minVolume24h = Number(next); i += 1; }
        else if ((arg === '--min-trades24h' || arg === '--min-trades') && next) { out.minTrades24h = Number(next); i += 1; }
        else if ((arg === '--min-divergence' || arg === '--prescreen-min-bps' || arg === '--divergence-min-bps') && next) {
            out.minDivergence = Number(next);
            i += 1;
        }
        else if (arg === '--max-divergence' && next) { out.maxDivergence = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--reject-divergence-outliers') { out.rejectDivergenceOutliers = true; }
        else if (arg === '--no-reject-divergence-outliers') { out.rejectDivergenceOutliers = false; }
        else if (arg === '--divergence-weight' && next) { out.divergenceWeight = Number(next); i += 1; }
        else if (arg === '--divergence-diagnose') out.divergenceDiagnose = true;
        else if (arg === '--no-divergence-diagnose') out.divergenceDiagnose = false;
        else if (arg === '--no-fee-tier-diversity') out.feeTierDiversity = true;
        else if (arg === '--fee-tier-diversity') out.feeTierDiversity = true;
        else if (arg === '--include-pair' && next) { out.includePairs.push(next); i += 1; }
        else if ((arg === '--include-exact-pair' || arg === '--include-exact-pairs' || arg === '--pair-selector' || arg === '--pair-selectors') && next) {
            out.includeExactPairs.push(...parsePairSelectors(next));
            out.includeExactPairsExplicit = true;
            i += 1;
        }
        else if (arg === '--only-target-anchor-pairs') { out.onlyTargetAnchorPairs = true; }
        else if (arg === '--target-anchor-mints' && next) {
            out.targetAnchorMints = String(next).split(',').map((s) => s.trim()).filter(Boolean);
            i += 1;
        }
        else if (arg === '--exclude-stable-stable') { out.excludeStableStable = true; }
        else if (arg === '--allow-cpmm-stable-stable') { out.rejectCpmmStableStable = false; }
        else if (arg === '--reject-cpmm-stable-stable') { out.rejectCpmmStableStable = true; }
        else if ((arg === '--exclude-pool' || arg === '--exclude-pools' || arg === '--block-pool') && next) {
            out.excludePools.push(...String(next).split(',').map((s) => s.trim()).filter(Boolean));
            i += 1;
        }

        else if (arg === '--select-mode' && next) { out.selectMode = String(next).toLowerCase(); i += 1; }
        else if ((arg === '--per-dex-quality-count' || arg === '--per-dex-top' || arg === '--keep-per-dex') && next) {
            out.perDexQualityCount = Math.max(1, Number(next) || out.perDexQualityCount);
            i += 1;
        }
        else if (arg === '--anchor-mint' && next) { out.anchorMints.push(next); i += 1; }
        else if (arg === '--anchor-mints' && next) {
            out.anchorMints = parseMintCsv(next);
            i += 1;
        }
        else if (arg === '--min-pools-per-token' && next) { out.minPoolsPerToken = Math.max(2, Number(next)); i += 1; }
        else if (arg === '--max-pools-per-token' && next) { out.maxPoolsPerToken = Math.max(2, Number(next)); i += 1; }
        else if (arg === '--min-pools-per-token-anchor' && next) { out.minPoolsPerTokenAnchor = Math.max(1, Number(next)); i += 1; }
        else if (arg === '--max-anchor-anchor-pools' && next) { out.maxAnchorAnchorPools = Math.max(0, Number(next)); i += 1; }
        else if (arg === '--min-selected-pair-pools' && next) { out.minSelectedPairPools = Math.max(1, Number(next) || 1); i += 1; }
        else if (arg === '--no-selected-pair-peer-fill') { out.minSelectedPairPools = 1; }
        else if (arg === '--max-selected-pair-peer-adds' && next) { out.maxSelectedPairPeerAdds = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--require-two-anchor-connections') { out.requireTwoAnchorConnections = true; }

        else if (arg === '--no-opportunity') { out.opportunityFilter = false; }
        else if (arg === '--opp-max-tri-fee' && next) { out.opportunityMaxTriFee = Number(next); i += 1; }
        else if (arg === '--opp-max-pair-fee' && next) { out.opportunityMaxPairFee = Number(next); i += 1; }
        else if (arg === '--opp-min-captured' && next) { out.opportunityMinCaptured = Number(next); i += 1; }
        else if (arg === '--opp-min-tvl' && next) { out.opportunityMinTvl = Number(next); i += 1; }
        else if (arg === '--opp-max-pools' && next) { out.opportunityMaxPools = Number(next); i += 1; }
        else if (arg === '--opp-keep-dex-wildcards' && next) {
            out.opportunityKeepDexWildcards = String(next).split(',').map((s) => s.trim()).filter(Boolean);
            i += 1;
        }
        else if (arg === '--opp-max-dex-wildcards' && next) { out.opportunityMaxDexWildcards = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--target-mids' && next) {
            out.targetMids = parseMintCsv(next);
            i += 1;
        }
        else if (arg === '--no-target-mids') { out.targetMids = []; }
        else if (arg === '--amm-scan-max-per-mint' && next) { out.ammScanMaxAccountsPerMint = Math.max(1, Number(next) || out.ammScanMaxAccountsPerMint); i += 1; }
        else if (arg === '--amm-scan-max-total' && next) { out.ammScanMaxAccountsTotal = Math.max(1, Number(next) || out.ammScanMaxAccountsTotal); i += 1; }
        else if (arg === '--amm-hydrate-batch-size' && next) { out.ammHydrateBatchSize = Math.max(1, Number(next) || out.ammHydrateBatchSize); i += 1; }
        else if (arg === '--amm-hydrate-batch-delay-ms' && next) { out.ammHydrateBatchDelayMs = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--amm-scan-timeout-ms' && next) { out.ammScanTimeoutMs = Math.max(1000, Number(next) || out.ammScanTimeoutMs); i += 1; }
        else if (arg === '--amm-scan-retries' && next) { out.ammScanRetries = Math.max(0, Number(next) || 0); i += 1; }
        else if (arg === '--selection-diagnose' || arg === '--diagnose-selection') out.selectionDiagnose = true;
        else if ((arg === '--selection-diagnose-out' || arg === '--diagnose-selection-out') && next) {
            out.selectionDiagnose = true;
            out.selectionDiagnoseOut = next;
            i += 1;
        }
        else if ((arg === '--merge-ready' || arg === '--ready-pools' || arg === '--merge-pools') && next) {
            out.readyPoolInputs.push(...String(next).split(',').map((s) => s.trim()).filter(Boolean));
            i += 1;
        }
        else if (arg === '--localPools' || arg === '--local-pools' || arg === '--local-only') {
            out.localPools = true;
        }
        //  
        else if (arg === '--help' || arg === '-h') out.help = true;
    }

    out.anchorMints = Array.from(new Set(out.anchorMints || []));
    if (out.pancakeSwap && !out.bitqueryFamiliesExplicit) out.bitqueryFamilies = 'PancakeSwap';
    if (!['triangle-closure', 'legacy', 'per-dex'].includes(out.selectMode)) {
        console.warn(`Unknown --select-mode "${out.selectMode}", using triangle-closure`);
        out.selectMode = 'triangle-closure';
    }
    if (!['turnover', 'tvl', 'composite'].includes(out.rank)) {
        console.warn(`Unknown --rank "${out.rank}", using composite`);
        out.rank = 'composite';
    }
    if (!out.routesOut && /routed/i.test(path.basename(String(out.out || '')))) {
        console.warn(`--out ${out.out} looks like a routed file; using it as --routes-out and keeping pool output at ${DEFAULT_OUTPUT}`);
        out.routesOut = out.out;
        out.out = DEFAULT_OUTPUT;
    }
    if (out.localPools) {
        out.orca = true;
        out.raydiumClmm = true;
        out.raydiumCpmm = true;
        out.meteoraDlmm = true;
        out.meteoraDammV2 = false;
        out.pumpSwap = false;
        out.pumpSwapScan = false;
        out.pancakeSwap = false;
        out.targetMids = [];
        if (!out.includeExactPairsExplicit) out.includeExactPairs = [];
    }
    return out;
}

function extractReadyPools(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.data)) return raw.data;
    return [
        ...(Array.isArray(raw?.dammV2) ? raw.dammV2 : []),
        ...(Array.isArray(raw?.pumpSwap) ? raw.pumpSwap : []),
        ...(Array.isArray(raw?.dlmm) ? raw.dlmm : []),
    ];
}

async function loadReadyPools(paths = []) {
    const out = [];
    for (const file of paths) {
        try {
            const raw = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
            const pools = extractReadyPools(raw);
            for (const pool of pools) {
                if (!pool || typeof pool !== 'object') continue;
                const address = String(pool.poolAddress || pool.address || pool.id || '').trim();
                if (!address) continue;
                out.push({ ...pool, address, poolAddress: address, _readyPoolSource: file });
            }
            console.log(`  Ready merge ${file}: +${pools.length} pools`, summarizeAltDexPools(pools));
        } catch (error) {
            console.warn(`  Ready merge ${file} skipped: ${error.message}`);
        }
    }
    return out;
}

function existingFallbackPoolFiles() {
    return ALT_DEX_FALLBACK_FILES.filter((file) => {
        try {
            return require('fs').existsSync(path.resolve(file));
        } catch (_error) {
            return false;
        }
    });
}

function addReadyPoolInput(args, file, reason = '') {
    if (!file) return false;
    const resolved = path.resolve(file);
    const already = args.readyPoolInputs.some((entry) => path.resolve(entry) === resolved);
    if (already) return false;
    args.readyPoolInputs.push(file);
    console.log(`  Will merge ready pools from ${file}${reason ? ` (${reason})` : ''}`);
    return true;
}

function addAltDexFallbackInputs(args, reason = 'alt-DEX requested') {
    const files = existingFallbackPoolFiles();
    if (!files.length) {
        console.log('  No local alt-DEX fallback file found; use --merge-ready <file> to add cached Pancake/DAMM/Pump pools.');
        return 0;
    }
    let added = 0;
    for (const file of files) {
        if (addReadyPoolInput(args, file, reason)) added += 1;
    }
    return added;
}

function hasPositiveReserves(pool = {}) {
    const x = pool.reserves?.x ?? pool.xReserve;
    const y = pool.reserves?.y ?? pool.yReserve;
    try {
        return BigInt(String(x ?? 0).split('.')[0]) > 0n
            && BigInt(String(y ?? 0).split('.')[0]) > 0n;
    } catch (_error) {
        return Number(x) > 0 && Number(y) > 0;
    }
}

function mergeExtractedAndReadyPools(extracted = [], ready = []) {
    const byKey = new Map();
    const keyOf = (pool = {}) => `${pool.dexType || pool.type || 'unknown'}:${pool.poolAddress || pool.address || pool.id || ''}`;

    for (const pool of extracted) {
        if (!pool) continue;
        byKey.set(keyOf(pool), pool);
    }

    for (const pool of ready) {
        const key = keyOf(pool);
        const existing = byKey.get(key);
        if (!existing || (hasPositiveReserves(pool) && !hasPositiveReserves(existing))) {
            byKey.set(key, pool);
        }
    }

    return Array.from(byKey.values());
}

function summarizeAltDexPools(pools = []) {
    const out = { dammV2: 0, pancakeswap: 0, pumpswap: 0, raydiumCpmm: 0 };
    for (const pool of pools || []) {
        if (isDammV2Pool(pool)) out.dammV2 += 1;
        else if (isPancakePool(pool)) out.pancakeswap += 1;
        else if (isPumpSwapPool(pool)) out.pumpswap += 1;
        else if (isRaydiumCpmmPool(pool)) out.raydiumCpmm += 1;
    }
    return out;
}

function poolDexText(pool = {}) {
    return `${pool.dexType || ''}|${pool.dex || ''}|${pool.type || ''}|${pool.mathType || ''}`.toLowerCase();
}

function isDammV2Pool(pool = {}) {
    return poolDexText(pool).includes('damm');
}

function isPancakePool(pool = {}) {
    return poolDexText(pool).includes('pancake');
}

function isPumpSwapPool(pool = {}) {
    return poolDexText(pool).includes('pump');
}

function isRaydiumCpmmPool(pool = {}) {
    const raw = poolDexText(pool);
    return raw.includes('raydium_cpmm') || raw.includes('|cpmm');
}

function isAltDexCandidatePool(pool = {}) {
    return isDammV2Pool(pool) || isPancakePool(pool) || isPumpSwapPool(pool) || isRaydiumCpmmPool(pool);
}

function hasPositiveRawLiquidity(pool = {}) {
    const candidates = [
        pool.liquidity,
        pool.rawLiquidity,
        pool.sqrtPriceLiquidity,
        pool.state?.liquidity,
        pool.raw?.liquidity,
        pool.data?.liquidity,
    ];
    for (const value of candidates) {
        if (value == null) continue;
        try {
            if (BigInt(String(value).split('.')[0]) > 0n) return true;
        } catch (_error) {
            if (Number(value) > 0) return true;
        }
    }
    return false;
}

function hasAltDexLiquiditySignal(pool = {}) {
    return poolTvl(pool) > 0 || hasPositiveReserves(pool) || hasPositiveRawLiquidity(pool);
}

function poolIdOf(pool) {
    return String(pool?.poolAddress || pool?.address || pool?.id || pool?.poolId || '').trim();
}

const BLOCKED_POOLS = [
    'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', // poisonPool
];

const STABLE_MINTS = new Set([
    USDC, USDT,
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
    'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
]);

function isCpmmStableStable(pool) {
    const type = String(pool.type || pool.mathType || '').toLowerCase();
    if (type !== 'cpmm') return false;
    const mintA = pool.baseMint || pool.tokenXMint || '';
    const mintB = pool.quoteMint || pool.tokenYMint || '';
    return STABLE_MINTS.has(mintA) && STABLE_MINTS.has(mintB);
}

function applyPoolExclusions(pools, excludePools = []) {
    const excluded = new Set([...BLOCKED_POOLS, ...(excludePools || [])].map((addr) => String(addr || '').trim()).filter(Boolean));

    const kept = [];
    let removed = 0;
    let cpmmStableRemoved = 0;
    for (const pool of pools || []) {
        const poolId = poolIdOf(pool);
        if (poolId && excluded.has(poolId)) {
            removed += 1;
            continue;
        }
        if (isCpmmStableStable(pool)) {
            cpmmStableRemoved += 1;
            continue;
        }
        kept.push(pool);
    }

    if (removed > 0) {
        console.log(`  excluded pools: removed ${removed}/${pools.length}`);
    }
    if (cpmmStableRemoved > 0) {
        console.log(`  excluded CPMM stable-stable: removed ${cpmmStableRemoved}`);
    }
    return kept;
}

function removeBlockedOrderbookTaggedPools(pools = []) {
    const kept = [];
    let removed = 0;
    for (const pool of pools || []) {
        const text = JSON.stringify(pool || {}).toLowerCase();
        if (text.includes('openbook') || text.includes('phoenix')) {
            removed += 1;
            continue;
        }
        kept.push(pool);
    }
    if (removed > 0) {
        console.log(`  orderbook blocklist: removed ${removed}/${pools.length} openbook/phoenix-tagged pools`);
    }
    return kept;
}

function poolMints(pool = {}) {
    const x = String(pool.tokenXMint || pool.baseMint || pool.mintA || pool.tokenA?.mint || '').trim();
    const y = String(pool.tokenYMint || pool.quoteMint || pool.mintB || pool.tokenB?.mint || '').trim();
    return [x, y].filter(Boolean);
}

function filterStableStablePools(pools = []) {
    const stableSet = new Set([USDC, USDT]);
    const kept = [];
    let removed = 0;
    for (const pool of pools || []) {
        const [x, y] = poolMints(pool);
        if (x && y && stableSet.has(x) && stableSet.has(y)) {
            removed += 1;
            continue;
        }
        kept.push(pool);
    }
    if (removed > 0) console.log(`  stable-stable filter: removed ${removed}/${pools.length}`);
    return kept;
}

function isCpmmStableStablePool(pool = {}) {
    const stableSet = new Set([USDC, USDT]);
    const [x, y] = poolMints(pool);
    if (!x || !y || !stableSet.has(x) || !stableSet.has(y)) return false;
    const text = [
        pool.dexType,
        pool.type,
        pool.mathType,
        pool.poolType,
        pool.protocol,
        pool.dex,
        pool.source,
    ].map((value) => String(value || '').toLowerCase()).join('|');
    return text.includes('cpmm');
}

function filterCpmmStableStablePools(pools = []) {
    const kept = [];
    let removed = 0;
    for (const pool of pools || []) {
        if (isCpmmStableStablePool(pool)) {
            removed += 1;
            continue;
        }
        kept.push(pool);
    }
    if (removed > 0) console.log(`  cpmm stable-stable poison filter: removed ${removed}/${pools.length}`);
    return kept;
}

function filterOnlyTargetAnchorPairs(pools = [], options = {}) {
    const targetSet = new Set((options.targetMids || []).map(String).filter(Boolean));
    const anchorSet = new Set((options.targetAnchorMints || [SOL, USDC]).map(String).filter(Boolean));
    if (!targetSet.size || !anchorSet.size) return pools;

    const kept = [];
    let removed = 0;
    for (const pool of pools || []) {
        const [x, y] = poolMints(pool);
        const isTargetAnchor = (targetSet.has(x) && anchorSet.has(y)) || (targetSet.has(y) && anchorSet.has(x));
        const isAnchorCloser = anchorSet.has(x) && anchorSet.has(y);
        if (isTargetAnchor || isAnchorCloser) {
            kept.push(pool);
        } else {
            removed += 1;
        }
    }
    console.log(`  target-anchor filter: kept ${kept.length}/${pools.length} `
        + `(removed ${removed}; targets=${targetSet.size}, anchors=${anchorSet.size})`);
    return kept;
}
const KNOWN_MINT_DECIMALS = new Map([
    ['So11111111111111111111111111111111111111112', 9],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 5],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 6],
    ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 6],
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 9],
    ['jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', 9],
    ['bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', 9],
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 9],
    ['7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', 8],
    ['3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', 8],
    ['cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', 8],
]);

function decimalsForMint(mint, supplied) {
    const known = KNOWN_MINT_DECIMALS.get(String(mint || ''));
    if (known != null) return known;
    const n = Number(supplied);
    return Number.isFinite(n) && n >= 0 ? n : supplied;
}

function normalizeOrderbookLevels(levels) {
    if (!Array.isArray(levels)) return [];
    const out = [];
    for (const level of levels) {
        if (Array.isArray(level)) {
            const price = Number(level[0]);
            const size = Number(level[1]);
            if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) out.push({ price, size });
            continue;
        }
        if (isObject(level)) {
            const price = Number(level.price ?? level.px);
            const size = Number(level.size ?? level.qty ?? level.quantity);
            if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) out.push({ price, size });
        }
    }
    return out;
}

function resolveNear(baseFile, maybePath) {
    if (!maybePath) return '';
    return path.isAbsolute(maybePath) ? maybePath : path.resolve(path.dirname(baseFile), maybePath);
}

function countAnchorTouches(pool = {}, anchorSet = new Set()) {
    const x = String(pool.tokenXMint || pool.baseMint || '');
    const y = String(pool.tokenYMint || pool.quoteMint || '');
    return (anchorSet.has(x) ? 1 : 0) + (anchorSet.has(y) ? 1 : 0);
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function pick(obj, keys) {
    if (!isObject(obj)) return undefined;
    for (const key of keys) {
        const value = obj[key];
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

function getPathValue(obj, path_) {
    if (!isObject(obj) || !path_) return undefined;
    const parts = String(path_).split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function firstPositiveNumber(objects, paths) {
    for (const obj of objects || []) {
        if (!isObject(obj)) continue;
        for (const path_ of paths || []) {
            const value = toNumber(getPathValue(obj, path_), null);
            if (value !== null && value > 0) return value;
        }
    }
    return null;
}

function extractLiquidityMetadata(pool = {}, extraSources = []) {
    const sources = [
        pool,
        pool.normalized,
        pool.raw,
        pool._raw,
        pool.data,
        ...extraSources,
    ].filter(isObject);
    const tvl = firstPositiveNumber(sources, [
        'tvl',
        'tvlUsd',
        'liquidityUsd',
        'liquidity.liquidityUsd',
        'liquidity.totalLiquidityUsd',
        'liquidity.tvl',
        'liquidity.tvlUsd',
    ]);
    const volume24h = firstPositiveNumber(sources, [
        'volume24h',
        'volume24hUsd',
        'volumeUsd24h',
        'volumeUsd',
        'volume.day',
        'volume_24h',
        'volume.24h',
        'liquidity.volume24hUsd',
        'trade_volume_24h',
        'day.volume',
        'day.volumeUsd',
        'stats24h.volume',
        'stats24h.volumeUsd',
        'volume.h24',
    ]);
    let trades24h = firstPositiveNumber(sources, [
        'trades24h',
        'tradeCount24h',
        'txns24h',
        'transactions24h',
        'day.trades',
        'day.txns',
        'stats24h.trades',
        'stats24h.txns',
        'txns.h24',
        'txns.h24.total',
        'trade_count_24h',
    ]);
    if (trades24h === null) {
        for (const source of sources) {
            const buys = toNumber(getPathValue(source, 'txns.h24.buys'), null);
            const sells = toNumber(getPathValue(source, 'txns.h24.sells'), null);
            if (buys !== null || sells !== null) {
                trades24h = (buys || 0) + (sells || 0);
                break;
            }
        }
    }

    return {
        tvl: tvl ?? undefined,
        tvlUsd: tvl ?? undefined,
        liquidityUsd: tvl ?? undefined,
        volume24h: volume24h ?? undefined,
        volume24hUsd: volume24h ?? undefined,
        volumeUsd24h: volume24h ?? undefined,
        trades24h: trades24h ?? undefined,
        txns24h: trades24h ?? undefined,
    };
}

function extractList(payload) {
    if (Array.isArray(payload)) return payload;
    if (!isObject(payload)) return [];
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.pools)) return payload.pools;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.whirlpools)) return payload.whirlpools;
    if (Array.isArray(payload.pairs)) return payload.pairs;
    if (isObject(payload.data)) {
        if (Array.isArray(payload.data.data)) return payload.data.data;
        if (Array.isArray(payload.data.pools)) return payload.data.pools;
        if (Array.isArray(payload.data.whirlpools)) return payload.data.whirlpools;
    }
    return [];
}

function toNumber(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(String(value).replace(/[, _]/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function uiToAtomicString(value, decimals) {
    const num = toNumber(value, null);
    const dec = toNumber(decimals, null);
    if (num === null || dec === null) return undefined;
    return String(Math.round(num * Math.pow(10, dec)));
}

function deriveReservePriceYPerX(xReserve, yReserve, xDecimals, yDecimals) {
    const xRaw = toNumber(xReserve, null);
    const yRaw = toNumber(yReserve, null);
    const xDec = toNumber(xDecimals, null);
    const yDec = toNumber(yDecimals, null);
    if (xRaw === null || yRaw === null || xDec === null || yDec === null || xRaw <= 0 || yRaw <= 0) {
        return null;
    }
    const xUi = xRaw / Math.pow(10, xDec);
    const yUi = yRaw / Math.pow(10, yDec);
    if (!Number.isFinite(xUi) || !Number.isFinite(yUi) || xUi <= 0 || yUi <= 0) return null;
    return yUi / xUi;
}

function deriveBinPriceYPerX(binStep, activeBinId, xDecimals, yDecimals) {
    const step = toNumber(binStep, null);
    const activeId = toNumber(activeBinId, null);
    const xDec = toNumber(xDecimals, 0);
    const yDec = toNumber(yDecimals, 0);
    if (step === null || activeId === null || step <= 0) return null;

    const price = Math.pow(1 + (step / 10000), activeId) * Math.pow(10, xDec - yDec);
    return Number.isFinite(price) && price > 0 ? price : null;
}

function buildCurrentPriceFields({
    explicitPrice,
    xReserve,
    yReserve,
    xDecimals,
    yDecimals,
    binStep,
    activeBinId,
} = {}) {
    const explicit = toNumber(explicitPrice, null);
    if (explicit !== null && explicit > 0) {
        return {
            currentPrice: explicit,
            currentPriceSource: 'api',
            currentPriceUnit: PRICE_UNIT_Y_PER_X,
            currentPricePayload: '1_tokenX',
        };
    }

    const reservePrice = deriveReservePriceYPerX(xReserve, yReserve, xDecimals, yDecimals);
    if (reservePrice !== null) {
        return {
            currentPrice: reservePrice,
            currentPriceSource: 'reserves',
            currentPriceUnit: PRICE_UNIT_Y_PER_X,
            currentPricePayload: '1_tokenX',
        };
    }

    const binPrice = deriveBinPriceYPerX(binStep, activeBinId, xDecimals, yDecimals);
    if (binPrice !== null) {
        return {
            currentPrice: binPrice,
            currentPriceSource: 'bin',
            currentPriceUnit: PRICE_UNIT_Y_PER_X,
            currentPricePayload: '1_tokenX',
        };
    }

    return {
        currentPrice: null,
        currentPriceSource: 'unavailable',
        currentPriceUnit: PRICE_UNIT_Y_PER_X,
        currentPricePayload: '1_tokenX',
    };
}

function withSource(pool, source) {
    return {
        ...source,
        source: 'direct-dex-api',
        sourceUrl: source.endpoint,
        fetchedAt: new Date().toISOString(),
        _raw: pool,
    };
}

/* -------------------------------------------------------------------------- */
/*                            DEX-specific mappers                            */
/* -------------------------------------------------------------------------- */

function mapRaydiumRaw(pool, type, endpoint) {
    const mintA = pick(pool, ['mintA', 'mint0', 'tokenMint0']);
    const mintB = pick(pool, ['mintB', 'mint1', 'tokenMint1']);
    const liquidityMetadata = extractLiquidityMetadata(pool, [mintA, mintB]);
    const baseMint = pick(mintA, ['address', 'mint']) || mintA || null;
    const quoteMint = pick(mintB, ['address', 'mint']) || mintB || null;
    const baseDecimals = toNumber(pick(mintA, ['decimals']) ?? pool.mintDecimals0 ?? pool.decimalsA, null);
    const quoteDecimals = toNumber(pick(mintB, ['decimals']) ?? pool.mintDecimals1 ?? pool.decimalsB, null);
    const xReserve = uiToAtomicString(pick(pool, ['mintAmountA', 'amountA', 'reserveA', 'reserve_x']), baseDecimals);
    const yReserve = uiToAtomicString(pick(pool, ['mintAmountB', 'amountB', 'reserveB', 'reserve_y']), quoteDecimals);
    const address = pick(pool, ['id', 'address', 'poolAddress', 'poolId']);
    const currentPriceFields = buildCurrentPriceFields({
        explicitPrice: pool.price ?? pool.currentPrice,
        xReserve,
        yReserve,
        xDecimals: baseDecimals,
        yDecimals: quoteDecimals,
    });

    return withSource(pool, {
        endpoint,
        address,
        poolAddress: address,
        dex: 'raydium',
        dexType: type === 'clmm' ? 'RAYDIUM_CLMM' : 'RAYDIUM_CPMM',
        type,
        programId: type === 'clmm' ? PROGRAM_IDS.raydiumClmm : PROGRAM_IDS.raydiumCpmm,
        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        tokenXDecimals: baseDecimals,
        tokenYDecimals: quoteDecimals,
        baseSymbol: pick(mintA, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        quoteSymbol: pick(mintB, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        reserves: xReserve !== undefined || yReserve !== undefined ? { x: xReserve || '0', y: yReserve || '0' } : undefined,
        xReserve,
        yReserve,
        vaults: {
            xVault: pick(pool, ['vaultA', 'tokenVault0', 'tokenVaultA']) || null,
            yVault: pick(pool, ['vaultB', 'tokenVault1', 'tokenVaultB']) || null,
        },
        tickSpacing: toNumber(pool.tickSpacing ?? pool.config?.tickSpacing, undefined),
        tickCurrent: toNumber(pool.currentTickIndex ?? pool.tickCurrent ?? pool.tickCurrentIndex, undefined),
        sqrtPriceX64: pick(pool, ['sqrtPriceX64', 'sqrtPrice']) ?? null,
        liquidity: pool.liquidity ?? pool.minimumLiquidity ?? null,
        ...currentPriceFields,
        feeBps: toNumber(pool.feeRate, undefined) != null
            ? Math.round(toNumber(pool.feeRate, 0) * 10000)
            : (pool.tradeFeeRate != null ? Math.round(Number(pool.tradeFeeRate) * 10000) : undefined),
        ...liquidityMetadata,
    });
}

function mapOrcaRaw(pool, endpoint) {
    const tokenA = pool.tokenA || {};
    const tokenB = pool.tokenB || {};
    const liquidityMetadata = extractLiquidityMetadata(pool, [tokenA, tokenB]);
    const baseMint = pick(tokenA, ['mint', 'address']) || pick(pool, ['tokenMintA']) || null;
    const quoteMint = pick(tokenB, ['mint', 'address']) || pick(pool, ['tokenMintB']) || null;
    const baseDecimals = toNumber(tokenA.decimals ?? pool.tokenA?.decimals, null);
    const quoteDecimals = toNumber(tokenB.decimals ?? pool.tokenB?.decimals, null);
    //const xReserve = uiToAtomicString(pick(pool, ['xReserve','reserveA', 'liquidityA', 'amountA']), baseDecimals);
    //const yReserve = uiToAtomicString(pick(pool, ['yReserve','reserveB', 'liquidityB', 'amountB']), quoteDecimals);
    const xReserve = uiToAtomicString(pick(pool, ['xReserve', 'mintAmountA', 'amountA', 'reserveA', 'reserve_x']), baseDecimals);
    const yReserve = uiToAtomicString(pick(pool, ['yReserve', 'mintAmountB', 'amountB', 'reserveB', 'reserve_y']), quoteDecimals);
    const address = pick(pool, ['address', 'id', 'poolAddress']);
    const currentPriceFields = buildCurrentPriceFields({
        explicitPrice: pool.price ?? pool.currentPrice,
        xReserve,
        yReserve,
        xDecimals: baseDecimals,
        yDecimals: quoteDecimals,
    });

    return withSource(pool, {
        endpoint,
        address,
        poolAddress: address,
        dex: 'orca',
        dexType: 'ORCA_WHIRLPOOL',
        type: 'whirlpool',
        programId: PROGRAM_IDS.orca,
        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        tokenXDecimals: baseDecimals,
        tokenYDecimals: quoteDecimals,
        baseSymbol: pick(tokenA, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        quoteSymbol: pick(tokenB, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        feeRate: pick(pool, ['lpFeeRate', 'lpsFeeRate', 'feeRate', 'fee']),
        feeBps: toNumber(pick(pool, ['lpFeeRate', 'feeRate']), undefined) != null
            ? Math.round(toNumber(pick(pool, ['lpFeeRate', 'feeRate']), 0) * 10000)
            : undefined,
        reserves: xReserve !== undefined || yReserve !== undefined ? { x: xReserve || '0', y: yReserve || '0' } : undefined,
        xReserve: pick(pool, ['xReserve', 'mintAmountA', 'amountA', 'reserveA', 'reserve_x']),
        yReserve: pick(pool, ['yReserve', 'mintAmountB', 'amountB', 'reserveB', 'reserve_y']),
        vaults: {
            xVault: pick(pool, ['tokenVaultA', 'vaultA']) || null,
            yVault: pick(pool, ['tokenVaultB', 'vaultB']) || null,
        },
        tickSpacing: toNumber(pool.tickSpacing, undefined),
        tickCurrent: toNumber(pool.tickCurrentIndex ?? pool.currentTickIndex ?? pool.tickCurrent, undefined),
        sqrtPriceX64: pick(pool, ['sqrtPriceX64', 'sqrtPrice']) ?? null,
        liquidity: pool.liquidity ?? null,
        ...currentPriceFields,
        ...liquidityMetadata,
    });
}

function mapMeteoraRaw(pool, endpoint) {
    const tokenX = pool.token_x || pool.tokenX || {};
    const tokenY = pool.token_y || pool.tokenY || {};
    const liquidityMetadata = extractLiquidityMetadata(pool, [tokenX, tokenY]);
    const baseMint = pick(pool, ['mint_x', 'tokenXMint', 'baseMint']) || pick(tokenX, ['mint', 'address']) || null;
    const quoteMint = pick(pool, ['mint_y', 'tokenYMint', 'quoteMint']) || pick(tokenY, ['mint', 'address']) || null;
    const baseDecimals = toNumber(tokenX.decimals ?? pool.decimals_x ?? pool.tokenXDecimals, null);
    const quoteDecimals = toNumber(tokenY.decimals ?? pool.decimals_y ?? pool.tokenYDecimals, null);
    const address = pick(pool, ['address', 'id', 'poolAddress', 'pairAddress']);
    const xReserve = pool.reserve_x_amount !== undefined ? String(pool.reserve_x_amount) : uiToAtomicString(pool.token_x_amount, baseDecimals);
    const yReserve = pool.reserve_y_amount !== undefined ? String(pool.reserve_y_amount) : uiToAtomicString(pool.token_y_amount, quoteDecimals);
    const binStep = toNumber(pick(pool, ['bin_step', 'binStep', 'bin_step_size']) ?? pool.pool_config?.bin_step, undefined);
    // Prefer pool_config.base_fee_pct (static configured floor) over
    // base_fee_percentage (datapi live snapshot that spikes during volatility).
    const meteoraBaseFee = pool.pool_config?.base_fee_pct
        ?? pool.pool_config?.base_fee_percentage
        ?? pool.base_fee_percentage;
    const activeBinId = toNumber(pool.active_id ?? pool.activeId ?? pool.active_bin?.bin_id, undefined);
    const currentPriceFields = buildCurrentPriceFields({
        explicitPrice: pool.current_price ?? pool.price ?? pool.currentPrice,
        xReserve,
        yReserve,
        xDecimals: baseDecimals,
        yDecimals: quoteDecimals,
        binStep,
        activeBinId,
    });

    return withSource(pool, {
        endpoint,
        address,
        poolAddress: address,
        dex: 'meteora',
        dexType: 'METEORA_DLMM',
        type: 'dlmm',
        programId: PROGRAM_IDS.meteoraDlmm,
        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        tokenXDecimals: baseDecimals,
        tokenYDecimals: quoteDecimals,
        baseSymbol: pick(tokenX, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        quoteSymbol: pick(tokenY, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
        base_fee_percentage: meteoraBaseFee,
        feeRate: pool.feeRate,
        feeBps: toNumber(meteoraBaseFee, undefined) != null
            ? Math.round(toNumber(meteoraBaseFee, 0) * 100)
            : undefined,
        reserves: { x: xReserve || '0', y: yReserve || '0' },
        xReserve,
        yReserve,
        vaults: {
            xVault: pool.reserve_x || pick(pool, ['tokenVaultA', 'vaultA']) || null,
            yVault: pool.reserve_y || pick(pool, ['tokenVaultB', 'vaultB']) || null,
        },
        binStep,
        activeBinId,
        ...currentPriceFields,
        liquidity: pool.liquidity ?? null,
        ...liquidityMetadata,
        // Preserve the live dynamic fee snapshot for inspection; feeBps uses the static floor.
        dynamicFeePercentage: pool.base_fee_percentage ?? null,
        bins: Array.isArray(pool.bins) ? pool.bins : undefined,
        binArrays: Array.isArray(pool.binArrays) ? pool.binArrays : undefined,
    });
}

/* -------------------------------------------------------------------------- */
/*                     Invariant Protocol CLMM (on-chain)                    */
/* -------------------------------------------------------------------------- */

/**
 * Read a little-endian u128 from a Buffer at the given offset.
 * Returns a BigInt (JS does not have native u128).
 */
function readU128LE(buf, offset) {
    const lo = buf.readBigUInt64LE(offset);
    const hi = buf.readBigUInt64LE(offset + 8);
    return (hi << 64n) | lo;
}

function readSplTokenAmount(accountInfo) {
    if (!accountInfo?.data) return null;
    const buf = Array.isArray(accountInfo.data)
        ? Buffer.from(accountInfo.data[0], 'base64')
        : Buffer.from(accountInfo.data);
    if (buf.length < 72) return null;
    try {
        return buf.readBigUInt64LE(64).toString();
    } catch (_err) {
        return null;
    }
}

function readSplMintDecimals(accountInfo) {
    if (!accountInfo?.data) return null;
    const buf = Array.isArray(accountInfo.data)
        ? Buffer.from(accountInfo.data[0], 'base64')
        : Buffer.from(accountInfo.data);
    if (buf.length < 45) return null;
    const decimals = Number(buf[44]);
    return Number.isFinite(decimals) ? decimals : null;
}

function deriveSqrtPriceYPerX(sqrtPriceX64, xDecimals, yDecimals) {
    const raw = toNumber(sqrtPriceX64, null);
    const xDec = toNumber(xDecimals, null);
    const yDec = toNumber(yDecimals, null);
    if (raw === null || xDec === null || yDec === null || raw <= 0) return null;
    const q64 = 2 ** 64;
    const price = (raw / q64) ** 2 * Math.pow(10, xDec - yDec);
    return Number.isFinite(price) && price > 0 ? price : null;
}

function estimateTvlUsdFromReserves({ xReserve, yReserve, xDecimals, yDecimals, tokenXMint, tokenYMint, currentPrice } = {}) {
    const xRaw = toNumber(xReserve, null);
    const yRaw = toNumber(yReserve, null);
    const xDec = toNumber(xDecimals, null);
    const yDec = toNumber(yDecimals, null);
    if (xRaw === null || yRaw === null || xDec === null || yDec === null) return null;

    const xUi = xRaw / Math.pow(10, xDec);
    const yUi = yRaw / Math.pow(10, yDec);
    if (!Number.isFinite(xUi) || !Number.isFinite(yUi) || xUi < 0 || yUi < 0) return null;

    const solUsd = Number(process.env.SOL_PRICE_USD || ORDERBOOK_SOL_USD_FALLBACK);
    const priceYPerX = toNumber(currentPrice, null);
    const stable = ORDERBOOK_USD_MINTS;
    if (priceYPerX && priceYPerX > 0) {
        if (stable.has(String(tokenYMint))) return Number(((yUi || 0) + ((xUi || 0) * priceYPerX)).toFixed(2));
        if (stable.has(String(tokenXMint))) return Number(((xUi || 0) + ((yUi || 0) / priceYPerX)).toFixed(2));
        if (String(tokenYMint) === ORDERBOOK_SOL_MINT) {
            return Number(((((yUi || 0) + ((xUi || 0) * priceYPerX))) * solUsd).toFixed(2));
        }
        if (String(tokenXMint) === ORDERBOOK_SOL_MINT) {
            return Number(((((xUi || 0) + ((yUi || 0) / priceYPerX))) * solUsd).toFixed(2));
        }
    }
    if (stable.has(String(tokenXMint))) return xUi > 0 ? Number((xUi * 2).toFixed(2)) : null;
    if (stable.has(String(tokenYMint))) return yUi > 0 ? Number((yUi * 2).toFixed(2)) : null;
    if (String(tokenXMint) === ORDERBOOK_SOL_MINT) return xUi > 0 ? Number((xUi * solUsd * 2).toFixed(2)) : null;
    if (String(tokenYMint) === ORDERBOOK_SOL_MINT) return yUi > 0 ? Number((yUi * solUsd * 2).toFixed(2)) : null;
    return null;
}

function publicKeyString(value) {
    return value?.toBase58?.() || value?.toString?.() || null;
}

function bnString(value) {
    if (value === undefined || value === null) return null;
    return value?.toString?.() || String(value);
}

function decodeAnchorPool(coder, accountInfo) {
    const buf = Array.isArray(accountInfo.data)
        ? Buffer.from(accountInfo.data[0], 'base64')
        : Buffer.from(accountInfo.data);
    if (!buf.slice(0, 8).equals(ANCHOR_POOL_DISC)) return null;
    return coder.decode('Pool', buf);
}

function normalizeAnchorPoolAliases(pool) {
    const pairs = [
        ['tokenAMint', 'token_a_mint'],
        ['tokenBMint', 'token_b_mint'],
        ['tokenAVault', 'token_a_vault'],
        ['tokenBVault', 'token_b_vault'],
        ['baseMint', 'base_mint'],
        ['quoteMint', 'quote_mint'],
        ['poolBaseTokenAccount', 'pool_base_token_account'],
        ['poolQuoteTokenAccount', 'pool_quote_token_account'],
        ['lpSupply', 'lp_supply'],
        ['poolFees', 'pool_fees'],
        ['sqrtPrice', 'sqrt_price'],
        ['poolStatus', 'pool_status'],
        ['poolType', 'pool_type'],
    ];
    for (const [camel, snake] of pairs) {
        if (pool[camel] === undefined && pool[snake] !== undefined) pool[camel] = pool[snake];
        if (pool[snake] === undefined && pool[camel] !== undefined) pool[snake] = pool[camel];
    }
    return pool;
}

async function hydrateVaultsAndDecimals(connection, selected, vaultFields, mintFields, options = {}) {
    const batchSize = Math.max(1, Number(options.batchSize || 50));
    const delayMs = Math.max(0, Number(options.delayMs || 0));
    const sleepBetweenBatches = async (nextIndex, total) => {
        if (delayMs > 0 && nextIndex < total) await new Promise(r => setTimeout(r, delayMs));
    };
    const vaultKeys = selected.flatMap(pool => vaultFields.map(field => publicKeyString(pool[field])).filter(Boolean));
    const vaultInfos = [];
    for (let i = 0; i < vaultKeys.length; i += batchSize) {
        const chunk = vaultKeys.slice(i, i + batchSize);
        const infos = await withRetry(async () => connection.getMultipleAccountsInfo(chunk.map(v => new PublicKey(v)), 'confirmed'), 3, 2000);
        vaultInfos.push(...infos);
        await sleepBetweenBatches(i + batchSize, vaultKeys.length);
    }
    let vaultCursor = 0;
    for (const pool of selected) {
        for (const field of vaultFields) {
            const key = publicKeyString(pool[field]);
            pool[`${field}Amount`] = key ? readSplTokenAmount(vaultInfos[vaultCursor]) : null;
            if (key) vaultCursor += 1;
        }
    }

    const uniqueMints = Array.from(new Set(selected.flatMap(pool => mintFields.map(field => publicKeyString(pool[field])).filter(Boolean))));
    const mintInfos = [];
    for (let i = 0; i < uniqueMints.length; i += batchSize) {
        const chunk = uniqueMints.slice(i, i + batchSize);
        const infos = await withRetry(async () => connection.getMultipleAccountsInfo(chunk.map(v => new PublicKey(v)), 'confirmed'), 3, 2000);
        mintInfos.push(...infos);
        await sleepBetweenBatches(i + batchSize, uniqueMints.length);
    }
    const mintDecimals = new Map();
    uniqueMints.forEach((mint, i) => {
        const decoded = readSplMintDecimals(mintInfos[i]);
        if (decoded != null) mintDecimals.set(mint, decoded);
    });
    for (const pool of selected) {
        for (const field of mintFields) {
            const mint = publicKeyString(pool[field]);
            pool[`${field}Decimals`] = mintDecimals.get(mint) ?? decimalsForMint(mint, null);
        }
    }
}
function extractDammFeeBps(pool) {
    const feeNumerator = pool?.poolFees?.baseFee?.cliffFeeNumerator
        ?? pool?.pool_fees?.base_fee?.cliff_fee_numerator
        ?? null;
    const n = toNumber(bnString(feeNumerator), null);
    if (n === null) return 30;
    const bps = Math.round((n / 1_000_000_000) * 10_000);
    return Number.isFinite(bps) && bps >= 0 ? bps : 30;
}

function mapDammV2Pool(p) {
    const tokenAMint = p.tokenAMint ?? p.token_a_mint;
    const tokenBMint = p.tokenBMint ?? p.token_b_mint;
    const tokenAVault = p.tokenAVault ?? p.token_a_vault;
    const tokenBVault = p.tokenBVault ?? p.token_b_vault;
    const tokenXMint = publicKeyString(tokenAMint);
    const tokenYMint = publicKeyString(tokenBMint);
    const xVault = publicKeyString(tokenAVault);
    const yVault = publicKeyString(tokenBVault);
    const xReserve = bnString(p.tokenAVaultAmount ?? p.token_a_vaultAmount);
    const yReserve = bnString(p.tokenBVaultAmount ?? p.token_b_vaultAmount);
    const tokenXDecimals = toNumber(p.tokenAMintDecimals ?? p.token_a_mintDecimals, decimalsForMint(tokenXMint, null));
    const tokenYDecimals = toNumber(p.tokenBMintDecimals ?? p.token_b_mintDecimals, decimalsForMint(tokenYMint, null));
    const sqrtPriceRaw = bnString(p.sqrtPrice ?? p.sqrt_price);
    const sqrtPrice = deriveSqrtPriceYPerX(sqrtPriceRaw, tokenXDecimals, tokenYDecimals);
    const reservePrice = deriveReservePriceYPerX(xReserve, yReserve, tokenXDecimals, tokenYDecimals);
    const currentPrice = sqrtPrice ?? reservePrice ?? null;
    const tvlUsd = estimateTvlUsdFromReserves({
        xReserve, yReserve, xDecimals: tokenXDecimals, yDecimals: tokenYDecimals,
        tokenXMint, tokenYMint, currentPrice,
    });
    return {
        address: p.address, poolAddress: p.address,
        dex: 'meteora', dexType: 'METEORA_DAMM_V2', type: 'damm_v2',
        programId: DAMM_V2_PROGRAM_ID,
        tokenXMint, tokenYMint, baseMint: tokenXMint, quoteMint: tokenYMint, mintA: tokenXMint, mintB: tokenYMint,
        tokenXDecimals, tokenYDecimals, baseDecimals: tokenXDecimals, quoteDecimals: tokenYDecimals,
        vaults: { xVault, yVault }, xVault, yVault,
        reserves: { x: xReserve || '0', y: yReserve || '0' }, xReserve: xReserve || '0', yReserve: yReserve || '0',
        tvl: tvlUsd ?? undefined, tvlUsd: tvlUsd ?? undefined, liquidityUsd: tvlUsd ?? undefined,
        liquidity: bnString(p.liquidity),
        sqrtPrice: sqrtPriceRaw, sqrtPriceX64: sqrtPriceRaw,
        currentPrice, midPrice: currentPrice,
        currentPriceSource: currentPrice === sqrtPrice ? 'sqrt' : 'reserves',
        currentPriceUnit: PRICE_UNIT_Y_PER_X, currentPricePayload: '1_tokenX',
        feeBps: extractDammFeeBps(p),
        poolStatus: toNumber(p.poolStatus ?? p.pool_status, null),
        poolType: toNumber(p.poolType ?? p.pool_type, null),
        source: 'on-chain', sourceUrl: `getProgramAccounts(${DAMM_V2_PROGRAM_ID})`,
        fetchedAt: new Date().toISOString(),
    };
}

function mapPumpSwapPool(p) {
    const baseMint = p.baseMint ?? p.base_mint;
    const quoteMint = p.quoteMint ?? p.quote_mint;
    const baseVault = p.poolBaseTokenAccount ?? p.pool_base_token_account;
    const quoteVault = p.poolQuoteTokenAccount ?? p.pool_quote_token_account;
    const tokenXMint = publicKeyString(baseMint);
    const tokenYMint = publicKeyString(quoteMint);
    const xVault = publicKeyString(baseVault);
    const yVault = publicKeyString(quoteVault);
    const xReserve = bnString(p.poolBaseTokenAccountAmount ?? p.pool_base_token_accountAmount);
    const yReserve = bnString(p.poolQuoteTokenAccountAmount ?? p.pool_quote_token_accountAmount);
    const tokenXDecimals = toNumber(p.baseMintDecimals ?? p.base_mintDecimals, decimalsForMint(tokenXMint, null));
    const tokenYDecimals = toNumber(p.quoteMintDecimals ?? p.quote_mintDecimals, decimalsForMint(tokenYMint, null));
    const currentPrice = deriveReservePriceYPerX(xReserve, yReserve, tokenXDecimals, tokenYDecimals);
    const tvlUsd = estimateTvlUsdFromReserves({
        xReserve, yReserve, xDecimals: tokenXDecimals, yDecimals: tokenYDecimals,
        tokenXMint, tokenYMint, currentPrice,
    });
    return {
        address: p.address, poolAddress: p.address,
        dex: 'pumpswap', dexType: 'PUMPSWAP_AMM', type: 'pumpswap', mathType: 'pumpswap', poolType: 'amm',
        programId: PUMPSWAP_PROGRAM_ID,
        tokenXMint, tokenYMint, baseMint: tokenXMint, quoteMint: tokenYMint, mintA: tokenXMint, mintB: tokenYMint,
        tokenXDecimals, tokenYDecimals, baseDecimals: tokenXDecimals, quoteDecimals: tokenYDecimals,
        vaults: { xVault, yVault }, xVault, yVault,
        reserves: { x: xReserve || '0', y: yReserve || '0' }, xReserve: xReserve || '0', yReserve: yReserve || '0',
        tvl: tvlUsd ?? undefined, tvlUsd: tvlUsd ?? undefined, liquidityUsd: tvlUsd ?? undefined,
        liquidity: bnString(p.lpSupply ?? p.lp_supply),
        currentPrice, midPrice: currentPrice,
        currentPriceSource: 'reserves',
        currentPriceUnit: PRICE_UNIT_Y_PER_X, currentPricePayload: '1_tokenX',
        feeBps: 30,
        source: 'on-chain', sourceUrl: `getProgramAccounts(${PUMPSWAP_PROGRAM_ID})`,
        fetchedAt: new Date().toISOString(),
    };
}

async function fetchAnchorAmmPools({
    label,
    programId,
    coder,
    mapPool,
    limit,
    overFetchSize,
    vaultFields,
    mintFields,
    mintOffsets = [],
    targetMints = [],
    scanMaxAccountsPerMint = 24,
    scanMaxAccountsTotal = 120,
    hydrateBatchSize = 50,
    hydrateBatchDelayMs = 250,
    scanTimeoutMs = 12_000,
    scanRetries = 0,
}) {
    const fetchSize = overFetchSize || limit;
    try {
        if (!coder || coder.missing) {
            console.warn(`  ${label} skipped: optional IDL unavailable (${coder?.idlPath || 'unknown path'})`);
            return [];
        }
        console.log(`Fetching ${label} pools (Anchor IDL getProgramAccounts)...`);
        const connection = createFetchRpcConnection();
        let accounts = [];
        try {
            const hasTargetedScan = Array.isArray(targetMints) && targetMints.length > 0 && mintOffsets.length > 0;
            if (hasTargetedScan) {
                throw new Error('targeted-scan-requested');
            }
            accounts = await withRetry(async () => connection.getProgramAccounts(new PublicKey(programId), {
                filters: [{ memcmp: { offset: 0, bytes: bs58Encode(ANCHOR_POOL_DISC) } }],
                commitment: 'confirmed',
            }), 3, 2000);
        } catch (error) {
            const message = String(error.message || '');
            const canTarget = mintOffsets.length > 0 && Array.isArray(targetMints) && targetMints.length > 0;
            if (!canTarget || (!message.includes('scan results exceeded') && message !== 'targeted-scan-requested')) throw error;
            console.log(message === 'targeted-scan-requested'
                ? `  Using targeted ${label} mint scans`
                : `  Full ${label} scan exceeded RPC result limit; retrying targeted mint scans`);
            const byPubkey = new Map();
            const uniqueTargets = Array.from(new Set(targetMints.filter(Boolean)));
            for (const mint of uniqueTargets) {
                let perMint = 0;
                for (const offset of mintOffsets) {
                    try {
                        const batch = await withRetry(() => withTimeout(
                            connection.getProgramAccounts(new PublicKey(programId), {
                                filters: [
                                    { memcmp: { offset: 0, bytes: bs58Encode(ANCHOR_POOL_DISC) } },
                                    { memcmp: { offset, bytes: mint } },
                                ],
                                commitment: 'confirmed',
                            }),
                            scanTimeoutMs,
                            `${label} ${String(mint).slice(0, 8)} offset=${offset}`,
                        ), scanRetries, 750);
                        for (const item of batch) {
                            const key = item.pubkey.toBase58();
                            if (byPubkey.has(key)) continue;
                            byPubkey.set(key, item);
                            perMint += 1;
                            if (perMint >= scanMaxAccountsPerMint || byPubkey.size >= scanMaxAccountsTotal) break;
                        }
                        if (perMint >= scanMaxAccountsPerMint || byPubkey.size >= scanMaxAccountsTotal) break;
                    } catch (inner) {
                        console.log(`    ${String(mint).slice(0, 8)}.. offset=${offset} skipped: ${inner.message}`);
                    }
                }
                if (byPubkey.size >= scanMaxAccountsTotal) break;
            }
            accounts = Array.from(byPubkey.values());
        }
        console.log(`  Found ${accounts.length} ${label} pool accounts`);

        const decoded = [];
        for (const { pubkey, account } of accounts) {
            try {
                const decodedPool = decodeAnchorPool(coder, account);
                if (!decodedPool) continue;
                const pool = normalizeAnchorPoolAliases(decodedPool);
                pool.address = pubkey.toBase58();
                decoded.push(pool);
            } catch (_err) {
                // Keep scanning; malformed accounts should not kill discovery.
            }
        }

        if (decoded.length > scanMaxAccountsTotal) decoded.length = scanMaxAccountsTotal;
        await hydrateVaultsAndDecimals(connection, decoded, vaultFields, mintFields, {
            batchSize: hydrateBatchSize,
            delayMs: hydrateBatchDelayMs,
        });
        console.log(`  Hydrated ${decoded.length} ${label} accounts (batch=${hydrateBatchSize}, delay=${hydrateBatchDelayMs}ms)`);
        const selected = decoded.map(mapPool)
            .filter(pool => pool.tokenXMint && pool.tokenYMint && pool.xVault && pool.yVault)
            .sort((a, b) => toNumber(b.tvlUsd, 0) - toNumber(a.tvlUsd, 0))
            .slice(0, fetchSize);
        console.log(`  Using top ${selected.length} ${label} pools by TVL/reserves`);
        return selected;
    } catch (err) {
        console.error(`  ${label} failed:`, err.message);
        return [];
    }
}

function anchorAmmScanOptions(args = {}) {
    return {
        scanMaxAccountsPerMint: args.ammScanMaxAccountsPerMint,
        scanMaxAccountsTotal: args.ammScanMaxAccountsTotal,
        hydrateBatchSize: args.ammHydrateBatchSize,
        hydrateBatchDelayMs: args.ammHydrateBatchDelayMs,
        scanTimeoutMs: args.ammScanTimeoutMs,
        scanRetries: args.ammScanRetries,
    };
}
async function fetchMeteoraDammV2(limit, overFetchSize, targetMints = null, scanOptions = {}) {
    return fetchAnchorAmmPools({
        label: 'Meteora DAMM v2',
        programId: DAMM_V2_PROGRAM_ID,
        coder: DAMM_V2_CODER,
        mapPool: mapDammV2Pool,
        limit,
        overFetchSize,
        vaultFields: ['tokenAVault', 'tokenBVault'],
        mintFields: ['tokenAMint', 'tokenBMint'],
        mintOffsets: [168, 200],
        targetMints: Array.isArray(targetMints) && targetMints.length ? targetMints : undefined,
        ...scanOptions,
    });
}

async function fetchPumpSwapAmm(limit, overFetchSize, targetMints = null, scanOptions = {}) {
    return fetchAnchorAmmPools({
        label: 'PumpSwap AMM',
        programId: PUMPSWAP_PROGRAM_ID,
        coder: PUMPSWAP_CODER,
        mapPool: mapPumpSwapPool,
        limit,
        overFetchSize,
        vaultFields: ['poolBaseTokenAccount', 'poolQuoteTokenAccount'],
        mintFields: ['baseMint', 'quoteMint'],
        // Anchor discriminator is 8 bytes. Pool layout:
        // poolBump u8, index u16, creator pubkey, baseMint pubkey, quoteMint pubkey.
        mintOffsets: [43, 75],
        targetMints: Array.isArray(targetMints) && targetMints.length ? targetMints : undefined,
        ...scanOptions,
    });
}

function decodePumpSwapPoolReserves(data) {
    if (!Buffer.isBuffer(data) || data.length < 121) return { x: '0', y: '0' };
    try {
        return {
            x: data.readBigUInt64LE(105).toString(),
            y: data.readBigUInt64LE(113).toString(),
        };
    } catch (_error) {
        return { x: '0', y: '0' };
    }
}

function pumpSwapDexScreenerQueries(args = {}) {
    const queries = new Set(['pumpswap solana']);
    for (const mint of args.targetMids || []) {
        const symbol = MINT_SYMBOLS.get(String(mint));
        if (symbol) {
            queries.add(`${symbol} pumpswap solana`);
            queries.add(`${symbol} solana`);
        }
    }
    for (const mint of args.targetAnchorMints || args.anchorMints || []) {
        const symbol = MINT_SYMBOLS.get(String(mint));
        if (symbol) queries.add(`${symbol} pumpswap solana`);
    }
    return Array.from(queries);
}

async function fetchPumpSwapFromDexScreener(args = {}) {
    const queries = pumpSwapDexScreenerQueries(args);
    const byAddress = new Map();
    const limit = Math.max(1, Number(args.bitqueryLimit || 1000));

    console.log(`Fetching PumpSwap via DexScreener search (${queries.length} queries, limit=${limit})...`);
    for (const query of queries) {
        try {
            const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
            const { data } = await axios.get(url, { timeout: Math.max(3000, Number(args.bitqueryTimeoutMs || 15000)) });
            const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
            for (const pair of pairs) {
                if (String(pair?.chainId || '').toLowerCase() !== 'solana') continue;
                if (String(pair?.dexId || '').toLowerCase() !== 'pumpswap') continue;
                const address = String(pair?.pairAddress || '').trim();
                const baseMint = String(pair?.baseToken?.address || '').trim();
                const quoteMint = String(pair?.quoteToken?.address || '').trim();
                if (!address || !baseMint || !quoteMint) continue;
                byAddress.set(address, pair);
                if (byAddress.size >= limit) break;
            }
            if (byAddress.size >= limit) break;
        } catch (error) {
            console.warn(`  PumpSwap DexScreener query "${query}" skipped: ${error.message}`);
        }
    }

    const pairs = Array.from(byAddress.values());
    if (!pairs.length) {
        console.log('  PumpSwap DexScreener returned 0 pools');
        return [];
    }

    const reserveMap = new Map();
    try {
        const connection = createFetchRpcConnection({ commitment: 'confirmed' });
        const keys = pairs.map((pair) => new PublicKey(pair.pairAddress));
        const infos = await connection.getMultipleAccountsInfo(keys);
        for (let i = 0; i < pairs.length; i += 1) {
            reserveMap.set(pairs[i].pairAddress, decodePumpSwapPoolReserves(infos[i]?.data));
        }
    } catch (error) {
        console.warn(`  PumpSwap RPC reserve hydration skipped: ${error.message}`);
    }

    const pools = [];
    for (const pair of pairs) {
        const tokenXMint = String(pair.baseToken?.address || '').trim();
        const tokenYMint = String(pair.quoteToken?.address || '').trim();
        const tokenXDecimals = decimalsForMint(tokenXMint, 6);
        const tokenYDecimals = decimalsForMint(tokenYMint, 6);
        const reserves = reserveMap.get(pair.pairAddress) || { x: '0', y: '0' };
        const reservePrice = deriveReservePriceYPerX(reserves.x, reserves.y, tokenXDecimals, tokenYDecimals);
        const screenPrice = toNumber(pair.priceNative ?? pair.priceUsd, null);
        const currentPrice = reservePrice || screenPrice;
        const liquidityUsd = toNumber(pair.liquidity?.usd, 0);
        pools.push({
            address: pair.pairAddress,
            poolAddress: pair.pairAddress,
            dex: 'pumpswap',
            dexType: 'PUMPSWAP_AMM',
            type: 'pumpswap',
            mathType: 'pumpswap',
            poolType: 'amm',
            programId: PUMPSWAP_PROGRAM_ID,
            tokenXMint,
            tokenYMint,
            baseMint: tokenXMint,
            quoteMint: tokenYMint,
            mintA: tokenXMint,
            mintB: tokenYMint,
            tokenXSymbol: pair.baseToken?.symbol,
            tokenYSymbol: pair.quoteToken?.symbol,
            baseSymbol: pair.baseToken?.symbol,
            quoteSymbol: pair.quoteToken?.symbol,
            tokenXDecimals,
            tokenYDecimals,
            baseDecimals: tokenXDecimals,
            quoteDecimals: tokenYDecimals,
            reserves,
            xReserve: reserves.x,
            yReserve: reserves.y,
            tvl: liquidityUsd,
            tvlUsd: liquidityUsd,
            liquidityUsd,
            liquidity: liquidityUsd,
            volume24h: toNumber(pair.volume?.h24 ?? pair.volume?.['24h'], 0),
            volume24hUsd: toNumber(pair.volume?.h24 ?? pair.volume?.['24h'], 0),
            currentPrice,
            midPrice: currentPrice,
            currentPriceSource: reservePrice ? 'rpc-reserves' : 'dexscreener',
            currentPriceUnit: PRICE_UNIT_Y_PER_X,
            currentPricePayload: '1_tokenX',
            feeBps: toNumber(pair.feeBps, 30),
            feeRate: toNumber(pair.feeBps, 30) / 10_000,
            source: 'dexscreener',
            sourceUrl: `dexscreener:${pair.url || pair.pairAddress}`,
            reserveSource: reserves.x !== '0' && reserves.y !== '0' ? 'rpc-pool-account' : 'dexscreener',
            fetchedAt: new Date().toISOString(),
        });
    }

    console.log(`  Fetched ${pools.length} PumpSwap pools from DexScreener`);
    return pools;
}

async function fetchRaydiumByMint(mint, topN = 8) {
    const url = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${topN}&page=1`;
    try {
        const data = await fetchJson(url, DEX_DIRECT_CONFIGS.raydium.config.timeout);
        const list = extractList(data);
        return list.map((p) => {
            const type = p.type === 'Concentrated' || p.programId === PROGRAM_IDS.raydiumClmm ? 'clmm' : 'cpmm';
            return mapRaydiumRaw(p, type, url);
        }).filter(Boolean);
    } catch (err) {
        console.warn(`  Raydium by-mint (${mint.slice(0, 8)}..) failed: ${err.message}`);
        return [];
    }
}

async function fetchJson(url, timeout = 60_000) {
    const response = await axios.get(url, {
        timeout,
        headers: { 'User-Agent': 'Solana-Arbitrage-Bot/1.0.0' },
    });
    return response.data;
}

/* -------------------------------------------------------------------------- */
/*                       Wider fetches (3-5x of limit)                        */
/* -------------------------------------------------------------------------- */

async function fetchRaydium(limit, includeClmm, includeCpmm, overFetchSize) {
    const fetchSize = overFetchSize || limit;
    const endpoints = [];
    if (includeClmm) {
        endpoints.push({
            type: 'clmm',
            url: `https://api-v3.raydium.io/pools/info/list-v2?poolType=Concentrated&hasReward=false&sortField=liquidity&sortType=desc&size=${fetchSize}`,
        });
    }
    if (includeCpmm) {
        endpoints.push({
            type: 'cpmm',
            url: `https://api-v3.raydium.io/pools/info/list-v2?poolType=Standard&sortField=liquidity&sortType=desc&size=${fetchSize}`,
        });
    }

    const out = [];
    for (const { type, url } of endpoints) {
        try {
            console.log(`Fetching Raydium ${type.toUpperCase()} (size=${fetchSize})...`);
            const data = await fetchJson(url, DEX_DIRECT_CONFIGS.raydium.config.timeout);
            const selected = extractList(data);
            out.push(...selected.map((pool) => mapRaydiumRaw(pool, type, url)).filter(Boolean));
            console.log(`  Fetched ${selected.length} pools`);
        } catch (error) {
            console.error(`  Raydium ${type} failed:`, error.message);
        }
    }
    return out;
}

async function fetchOrca(limit, overFetchSize) {
    const fetchSize = overFetchSize || limit;
    const url = DEX_DIRECT_CONFIGS.orca.whirlpool.endpoints.list;
    try {
        console.log(`Fetching Orca Whirlpools...`);
        const data = await fetchJson(url, DEX_DIRECT_CONFIGS.orca.config.timeout);
        const selected = extractList(data)
            .slice()
            .sort((a, b) => Number(b?.tvl || 0) - Number(a?.tvl || 0))
            .slice(0, fetchSize);
        console.log(`  Fetched ${selected.length} pools`);
        return selected.map((pool) => mapOrcaRaw(pool, url)).filter(Boolean);
    } catch (error) {
        console.error('  Orca failed:', error.message);
        return [];
    }
}

async function fetchMeteora(limit, overFetchSize) {
    const fetchSize = overFetchSize || limit;
    const pageSize = Math.max(1, Math.min(Number(fetchSize) || 1, 1000));
    const baseUrl = 'https://dlmm.datapi.meteora.ag/pools';
    const url = `${baseUrl}?page_size=${pageSize}&sort_by=tvl:desc`;
    try {
        console.log(`Fetching Meteora DLMM (size=${pageSize})...`);
        const data = await fetchJson(url, DEX_DIRECT_CONFIGS.meteora.config?.timeout || 60_000);
        const selected = extractList(data)
            .slice()
            .sort((a, b) => Number(b?.liquidity || b?.tvl || 0) - Number(a?.liquidity || a?.tvl || 0))
            .slice(0, fetchSize);
        console.log(`  Fetched ${selected.length} pools`);
        return selected.map((pool) => mapMeteoraRaw(pool, url)).filter(Boolean);
    } catch (error) {
        console.error('  Meteora failed:', error.message);
        return [];
    }
}

async function fetchPancakeSwapFromBitquery(args = {}) {
    if (!fetchBitqueryFrontendlessPools) {
        console.warn('  PancakeSwap skipped: bitqueryFrontendlessFetcher unavailable');
        return [];
    }

    const minTvlUsd = Math.max(0, Number(args.minLiquidity || 0));
    console.log(`Fetching PancakeSwap via Bitquery (limit=${args.bitqueryLimit}, minTvl=${minTvlUsd})...`);
    const pools = await fetchBitqueryFrontendlessPools({
        enabled: true,
        protocolFamilies: args.bitqueryFamilies || 'PancakeSwap',
        limit: args.bitqueryLimit,
        minTvlUsd,
        tokenMints: [],
        tokenMatchMode: 'any',
        credentialsFile: args.bitqueryCredentialsFile,
        timeoutMs: args.bitqueryTimeoutMs,
    });
    const report = getLastBitqueryFrontendlessReport ? getLastBitqueryFrontendlessReport() : null;
    if (report?.skipped) {
        console.warn(`  PancakeSwap skipped: ${report.reason || 'Bitquery fetch skipped'}`);
    } else if (report?.error) {
        console.warn(`  PancakeSwap failed: ${report.error}`);
    }
    console.log(`  Fetched ${pools.length} PancakeSwap pools`);
    return pools;
}

async function fetchPumpswapFromBitquery(args = {}) {
    if (!fetchBitqueryFrontendlessPools) {
        console.warn('  Pumpswap skipped: bitqueryFrontendlessFetcher unavailable');
        return [];
    }

    const minTvlUsd = Math.max(0, Number(args.minLiquidity || 0));
    console.log(`Fetching Pumpswap via Bitquery (limit=${args.bitqueryLimit}, minTvl=${minTvlUsd})...`);
    const pools = await fetchBitqueryFrontendlessPools({
        enabled: true,
        protocolFamilies: args.bitqueryFamilies || 'Pumpswap',
        limit: args.bitqueryLimit,
        minTvlUsd,
        tokenMints: [],
        tokenMatchMode: 'any',
        credentialsFile: args.bitqueryCredentialsFile,
        timeoutMs: args.bitqueryTimeoutMs,
    });
    const report = getLastBitqueryFrontendlessReport ? getLastBitqueryFrontendlessReport() : null;
    if (report?.skipped) {
        console.warn(`  Pumpswap skipped: ${report.reason || 'Bitquery fetch skipped'}`);
    } else if (report?.error) {
        console.warn(`  Pumpswap failed: ${report.error}`);
    }
    console.log(`  Fetched ${pools.length} Pumpswap pools`);
    return pools;
}

/* -------------------------------------------------------------------------- */
/*                         Activity-aware ranking                             */
/* -------------------------------------------------------------------------- */

function activityScore(pool) {
    const tvl = poolTvl(pool);
    const vol = poolVolume24h(pool);
    const trades = poolTrades24h(pool);
    const fee = Number(pool.feeBps || 30);

    if (tvl <= 0) return 0;

    const turnover = vol > 0 ? vol / tvl : 0;
    const tvlScore = Math.log10(Math.max(tvl, 100));
    const turnoverScore = turnover > 0
        ? Math.log10(1 + turnover * 10)
        : 0;
    const tradeScore = trades > 0 ? Math.log10(1 + trades) * 0.15 : 0;
    const feePenalty = 1 / (1 + Math.log10(1 + fee / 10));

    if (turnover > 0) {
        return (turnoverScore * tvlScore * feePenalty) + tradeScore;
    }
    return (tvlScore * feePenalty * 0.3) + tradeScore;
}

function tvlScoreFn(pool) {
    return Math.log10(Math.max(poolTvl(pool), 100));
}

function turnoverOnly(pool) {
    const tvl = poolTvl(pool);
    const vol = poolVolume24h(pool);
    if (tvl <= 0 || vol <= 0) return 0;
    return vol / tvl;
}

function poolTvl(pool = {}) {
    return toNumber(pool.tvl ?? pool.tvlUsd ?? pool.liquidityUsd ?? pool.liquidity?.liquidityUsd, 0) || 0;
}

function poolVolume24h(pool = {}) {
    return toNumber(pool.volume24h ?? pool.volume24hUsd ?? pool.volumeUsd24h ?? pool.volumeUsd, 0) || 0;
}

function poolTrades24h(pool = {}) {
    const direct = toNumber(pool.trades24h ?? pool.txns24h ?? pool.tradeCount24h ?? pool.transactions24h, null);
    if (direct !== null) return direct;
    const buys = toNumber(getPathValue(pool, 'txns.h24.buys'), null);
    const sells = toNumber(getPathValue(pool, 'txns.h24.sells'), null);
    if (buys !== null || sells !== null) return (buys || 0) + (sells || 0);
    return 0;
}

function isOrderbookPool(pool = {}) {
    const raw = `${pool.dexType || ''}|${pool.dex || ''}|${pool.type || ''}|${pool.source || ''}`.toLowerCase();
    return raw.includes('openbook') || raw.includes('phoenix') || raw.includes('orderbook');
}

function getRankFn(rankMode) {
    if (rankMode === 'tvl') return tvlScoreFn;
    if (rankMode === 'turnover') return turnoverOnly;
    return activityScore;
}

function loadDivergenceScanner() {
    const candidates = [
        './divergenceScanner',
        './_divergenceScanner',
        '../divergenceScanner',
        '../_divergenceScanner',
    ];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (_e) {
            // Try the next known location. This file usually runs from utilities/
            // while local worktrees may name the scanner _divergenceScanner.js.
        }
    }
    return null;
}

function loadRouteBuilder() {
    // Pool fetch uses the standalone route builder only as a selection-time
    // triangle/connectivity verifier. Routed output for execution is built by
    // utilities/_divergenceScanner.js, so do not mix the two for 03_ROUTED.json.
    try {
        return require('./divergenceAwareRouteBuilder');
    } catch (_e) {
        return null;
    }
}

function buildPairMap(pools) {
    const map = new Map();
    for (const pool of pools) {
        const x = String(pool.tokenXMint || pool.baseMint || '');
        const y = String(pool.tokenYMint || pool.quoteMint || '');
        if (!x || !y) continue;
        for (const key of [`${x}-${y}`, `${y}-${x}`]) {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(pool);
        }
    }
    return map;
}

function getPoolsForDirectedPair(pairMap, tokenInMint, tokenOutMint) {
    return pairMap.get(`${tokenInMint}-${tokenOutMint}`) || [];
}

function inferRouteLeg(pool, tokenInMint, tokenOutMint, meta = {}) {
    const normalized = mergeCanonicalPool(pool || {});
    const poolAddress = poolAddressOf(normalized);
    const tokenXMint = String(normalized.tokenXMint || normalized.baseMint || normalized.mintA || '');
    const tokenYMint = String(normalized.tokenYMint || normalized.quoteMint || normalized.mintB || '');
    const inMint = String(tokenInMint || '');
    const outMint = String(tokenOutMint || '');
    const aToB = inMint === tokenXMint && outMint === tokenYMint;
    const bToA = inMint === tokenYMint && outMint === tokenXMint;

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
        valid: contract.valid && Boolean(poolAddress) && Boolean(inMint) && Boolean(outMint) && (aToB || bToA),
        missing: contract.missing,
    };
}

function symbolForMintFromPools(pools = [], mint) {
    for (const pool of pools) {
        const normalized = mergeCanonicalPool(pool || {});
        if (String(normalized.tokenXMint || normalized.baseMint || '') === mint) {
            return normalized.tokenXSymbol || normalized.baseSymbol || String(mint).slice(0, 6);
        }
        if (String(normalized.tokenYMint || normalized.quoteMint || '') === mint) {
            return normalized.tokenYSymbol || normalized.quoteSymbol || String(mint).slice(0, 6);
        }
    }
    return String(mint || '').slice(0, 6);
}

function buildRoutedChainPayload(pools = [], options = {}) {
    const normalizedPools = pools.map((pool) => mergeCanonicalPool(pool || {}));
    const pairMap = buildPairMap(normalizedPools);
    const tokenA = String(options.tokenA || options.anchorMints?.[0] || SOL);
    const maxPerTriangle = Math.max(1, Number(options.routesMaxPerTriangle || 10));
    const connectedToA = new Set();

    for (const key of pairMap.keys()) {
        const [left, right] = key.split('-');
        if (left === tokenA && right && right !== tokenA) connectedToA.add(right);
    }

    const chainRoutes = [];
    const triangles = [];
    const usedPoolAddresses = new Set();
    let triangleIndex = 0;

    for (const tokenB of connectedToA) {
        const connectedToB = new Set();
        for (const key of pairMap.keys()) {
            const [left, right] = key.split('-');
            if (left === tokenB && right && right !== tokenA && right !== tokenB) connectedToB.add(right);
        }

        for (const tokenC of connectedToB) {
            const poolsAB = getPoolsForDirectedPair(pairMap, tokenA, tokenB);
            const poolsBC = getPoolsForDirectedPair(pairMap, tokenB, tokenC);
            const poolsCA = getPoolsForDirectedPair(pairMap, tokenC, tokenA);
            if (!poolsAB.length || !poolsBC.length || !poolsCA.length) continue;

            triangleIndex += 1;
            const routePath = [
                symbolForMintFromPools(normalizedPools, tokenA),
                symbolForMintFromPools(normalizedPools, tokenB),
                symbolForMintFromPools(normalizedPools, tokenC),
                symbolForMintFromPools(normalizedPools, tokenA),
            ].join(' -> ');
            let routesForTriangle = 0;

            outer:
            for (const poolAB of poolsAB) {
                for (const poolBC of poolsBC) {
                    for (const poolCA of poolsCA) {
                        const routeId = `tri-${triangleIndex}-${routesForTriangle + 1}`;
                        const leg1 = inferRouteLeg(poolAB, tokenA, tokenB, { legIndex: 1, routeId, routePath });
                        const leg2 = inferRouteLeg(poolBC, tokenB, tokenC, { legIndex: 2, routeId, routePath });
                        const leg3 = inferRouteLeg(poolCA, tokenC, tokenA, { legIndex: 3, routeId, routePath });
                        if (!leg1.valid || !leg2.valid || !leg3.valid) continue;

                        const route = [leg1.leg, leg2.leg, leg3.leg];
                        chainRoutes.push(route);
                        for (const leg of route) usedPoolAddresses.add(poolAddressOf(leg));
                        routesForTriangle += 1;
                        if (routesForTriangle >= maxPerTriangle) break outer;
                    }
                }
            }

            if (routesForTriangle > 0) {
                triangles.push({
                    routePath,
                    tokenA,
                    tokenB,
                    tokenC,
                    poolsAB: poolsAB.length,
                    poolsBC: poolsBC.length,
                    poolsCA: poolsCA.length,
                    chainRouteCount: routesForTriangle,
                });
            }
        }
    }

    const routedPools = normalizedPools.filter((pool) => usedPoolAddresses.has(poolAddressOf(pool)));
    return {
        source: 'poolFetchCustom_raw',
        generatedAt: new Date().toISOString(),
        tokenA,
        triangleCount: triangles.length,
        chainRouteCount: chainRoutes.length,
        routesMaxPerTriangle: maxPerTriangle,
        triangles,
        chainRoutes,
        pools: routedPools,
        routedPoolCount: routedPools.length,
        orphanPoolCount: normalizedPools.length - routedPools.length,
    };
}

function pairHasClearDivergence(pool, minBps = 0) {
    const peerCount = Number(pool?.pairPeerCount || 0);
    const comparablePeers = Number(pool?.pairComparablePeerCount || 0);
    const divergenceBps = Number(pool?.pairDivergenceBps || 0);
    const comparable = pool?.pairDivergenceComparable !== false && comparablePeers >= 2;
    return peerCount >= 2 && comparable && divergenceBps >= Number(minBps || 0);
}

function annotateDivergenceSignals(pools, options = {}) {
    const scanner = loadDivergenceScanner();
    if (!scanner?.annotatePairDivergence) {
        console.warn('  divergenceScanner not available — ranking without divergence boost');
        return {
            available: true,
            clearPairs: 0,
            clearPools: 0,
            comparablePools: 0,
            maxDivergenceBps: 0,
        };
    }

    scanner.annotatePairDivergence(pools, { diagnose: Boolean(options.divergenceDiagnose) });

    const minBps = Number(options.minDivergence || 0);
    const seenClearPairs = new Set();
    let clearPools = 0;
    let comparablePools = 0;
    let maxDivergenceBps = 0;

    const maxDivergence = Number(options.maxDivergence || 0);
    const rejectOutliers = options.rejectDivergenceOutliers !== false;
    let rejectedOutliers = 0;
    let rejectedCeiling = 0;

    for (const pool of pools) {
        const divergenceBps = Number(pool.pairDivergenceBps || 0);
        const comparable = pool.pairDivergenceComparable !== false && Number(pool.pairComparablePeerCount || 0) >= 2;

        // Neutralize suspect divergence so it can't boost a pool to candidate:
        // the scanner already tags the bad-mid pool (pairMidOutlier), and a divergence
        // above the ceiling on a liquid pair is almost always a stale/mispriced mid,
        // not a tradeable edge. Zero its score (no rank boost) and fail its clear gate.
        const isOutlier = rejectOutliers && pool.pairMidOutlier === true;
        const overCeiling = maxDivergence > 0 && divergenceBps > maxDivergence;
        const suspect = isOutlier || overCeiling;
        if (isOutlier) rejectedOutliers += 1;
        else if (overCeiling) rejectedCeiling += 1;

        const clear = !suspect && pairHasClearDivergence(pool, minBps > 0 ? minBps : 0.0001);

        pool._divergenceScoreBps = suspect ? 0 : (Number.isFinite(divergenceBps) ? divergenceBps : 0);
        pool._divergenceComparable = comparable;
        pool._divergenceClear = clear;
        pool._divergenceSuspect = suspect;
        pool._divergenceSuspectReason = suspect
            ? (isOutlier ? 'pair-mid-outlier' : `divergence>${maxDivergence}bps`)
            : null;

        if (comparable) comparablePools += 1;
        if (clear) {
            clearPools += 1;
            if (pool.pairCanonical) seenClearPairs.add(pool.pairCanonical);
        }
        if (Number.isFinite(divergenceBps) && divergenceBps > maxDivergenceBps) {
            maxDivergenceBps = divergenceBps;
        }
    }

    return {
        available: true,
        clearPairs: seenClearPairs.size,
        clearPools,
        comparablePools,
        maxDivergenceBps: Number(maxDivergenceBps.toFixed(4)),
        rejectedOutliers,
        rejectedCeiling,
    };
}

/* -------------------------------------------------------------------------- */
/*                       Pair-aware selection logic                           */
/* -------------------------------------------------------------------------- */

function pairKey(pool) {
    const x = String(pool.tokenXMint || pool.baseMint || '');
    const y = String(pool.tokenYMint || pool.quoteMint || '');
    if (!x || !y) return null;
    return [x, y].sort().join('|');
}

function poolExactPairKey(pool = {}) {
    const x = String(pool.tokenXMint || pool.baseMint || pool.mintA || '');
    const y = String(pool.tokenYMint || pool.quoteMint || pool.mintB || '');
    if (!x || !y) return '';
    return canonicalPairKey(x, y);
}

function filterExactPairs(pools = [], exactPairs = []) {
    const wanted = new Set(exactPairs || []);
    if (!wanted.size) return pools;
    return pools.filter((pool) => wanted.has(poolExactPairKey(pool)));
}

function feeTierBucket(feeBps) {
    if (feeBps == null) return 'unknown';
    const n = Number(feeBps);
    if (n <= 5) return 'ultralow';
    if (n <= 15) return 'low';
    if (n <= 30) return 'mid';
    return 'high';
}

function exactFeeBucket(pool = {}) {
    const n = Number(pool.feeBps ?? pool.feeRateBps);
    return Number.isFinite(n) ? `${n}bps` : (pool._feeTier || 'unknown');
}

function rankAndAnnotate(pools, options) {
    const rankFn = getRankFn(options.rank);
    const minLiquidity = Number(options.minLiquidity || 0);
    const maxFeeBps = Number(options.maxFeeBps || 0);
    const minTurnover = Number(options.minTurnover || 0);
    const minVolume = Number(options.minVolume24h || 0);
    const minTrades = Number(options.minTrades24h || 0);
    const divergenceWeight = Number.isFinite(Number(options.divergenceWeight))
        ? Number(options.divergenceWeight)
        : 50;

    const divergenceSummary = annotateDivergenceSignals(pools, options);
    if (divergenceSummary.available) {
        console.log(`  Divergence signal: ${divergenceSummary.clearPools} pools across ${divergenceSummary.clearPairs} clear pairs `
            + `(max=${divergenceSummary.maxDivergenceBps} bps, comparable=${divergenceSummary.comparablePools}/${pools.length})`);
    }

    const pairCounts = new Map();
    for (const pool of pools) {
        const k = pairKey(pool);
        if (!k) continue;
        pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
    }

    for (const pool of pools) {
        const baseScore = rankFn(pool);
        const k = pairKey(pool);
        const peerCount = k ? pairCounts.get(k) || 1 : 1;
        const multiplicityBonus = peerCount >= 2 ? 1.3 : 1.0;
        const turnover = turnoverOnly(pool);
        const tvl = poolTvl(pool);
        const volume24h = poolVolume24h(pool);
        const trades24h = poolTrades24h(pool);
        const divergenceBps = Number(pool._divergenceScoreBps || 0);
        const divergenceComparable = pool._divergenceComparable === true;
        const divergenceBoost = divergenceComparable && divergenceBps > 0
            ? Math.log10(1 + divergenceBps) * divergenceWeight
            : 0;

        pool._activityScore = (baseScore * multiplicityBonus) + divergenceBoost;
        pool._baseActivityScore = baseScore;
        pool._divergenceRankBoost = divergenceBoost;
        pool._turnover = turnover;
        pool._qualityScore = pool._activityScore;
        pool.qualityScore = pool._activityScore;
        pool.tvl = pool.tvl ?? tvl;
        pool.tvlUsd = pool.tvlUsd ?? tvl;
        pool.liquidityUsd = pool.liquidityUsd ?? tvl;
        pool.volume24h = pool.volume24h ?? volume24h;
        pool.volume24hUsd = pool.volume24hUsd ?? volume24h;
        pool.trades24h = pool.trades24h ?? trades24h;
        pool.txns24h = pool.txns24h ?? trades24h;
        pool._pairPeerCount = peerCount;
        pool._feeTier = feeTierBucket(pool.feeBps);
        pool._pairKey = k;
    }

    let missingVolCount = 0;

    const ranked = pools
        .filter((pool) => {
            const tvl = poolTvl(pool);
            const vol = poolVolume24h(pool);
            const trades = poolTrades24h(pool);
            const orderbookCandidate = isOrderbookPool(pool)
                && (hasOrderbookDepth(pool) || pool.phoenixMarketSpec || pool.orderbook || pool.market || pool.marketAddress);
            const altDexWithLiquidity = isAltDexCandidatePool(pool) && hasAltDexLiquiditySignal(pool);
            const feeBps = Number(pool.feeBps ?? pool.feeRateBps ?? 0);

            if (vol <= 0) missingVolCount += 1;
            if (maxFeeBps > 0 && Number.isFinite(feeBps) && feeBps > maxFeeBps) return false;
            const effectiveMinLiq = pool._altDexMinLiq != null ? pool._altDexMinLiq : minLiquidity;
            if (!orderbookCandidate && effectiveMinLiq > 0 && tvl < effectiveMinLiq) return false;
            if (!altDexWithLiquidity && vol > 0 && minVolume > 0 && vol < minVolume) return false;
            if (!altDexWithLiquidity && pool._turnover > 0 && minTurnover > 0 && pool._turnover < minTurnover) return false;
            if (!altDexWithLiquidity && trades > 0 && minTrades > 0 && trades < minTrades) return false;
            if (!orderbookCandidate && tvl <= 0 && !altDexWithLiquidity) return false;
            return true;
        })
        .sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));

    if (missingVolCount > 0) {
        console.log(`  Activity data: ${missingVolCount}/${pools.length} pools missing volume24h; missing volume is not treated as a hard drop`);
    }

    return ranked;
}

/**
 * LEGACY selector (kept for `--select-mode legacy`). Same behaviour as the
 * previous version: rank-ordered, per-pair cap, optional fee-tier diversity.
 */
function selectWithDiversity(rankedPools, options) {
    const topN = Number(options.qualityCount || 40);
    const maxPerPair = Number(options.maxPerPair || 2);
    const maxPerDexType = Number(options.maxPerDexType || 0);
    const includeMints = new Set(options.includePairs || []);
    const enforceDiversity = options.feeTierDiversity !== false;

    const selected = [];
    const perPair = new Map();
    const perPairFeeTiers = new Map();
    const perDexType = new Map();

    if (includeMints.size) {
        for (const pool of rankedPools) {
            const x = String(pool.tokenXMint || '');
            const y = String(pool.tokenYMint || '');
            if (includeMints.has(x) || includeMints.has(y)) {
                if (!selected.includes(pool)) {
                    selected.push(pool);
                    const k = pool._pairKey;
                    if (k) {
                        perPair.set(k, (perPair.get(k) || 0) + 1);
                        if (!perPairFeeTiers.has(k)) perPairFeeTiers.set(k, new Set());
                        perPairFeeTiers.get(k).add(pool._feeTier);
                    }
                    const dt = pool.dexType || 'unknown';
                    perDexType.set(dt, (perDexType.get(dt) || 0) + 1);
                }
            }
        }
    }

    for (const pool of rankedPools) {
        if (selected.length >= topN) break;
        if (selected.includes(pool)) continue;

        const k = pool._pairKey;
        const dt = pool.dexType || 'unknown';
        const pairCount = k ? perPair.get(k) || 0 : 0;
        const dexCount = perDexType.get(dt) || 0;

        if (k && pairCount >= maxPerPair) {
            if (enforceDiversity) {
                const tiers = perPairFeeTiers.get(k) || new Set();
                if (!tiers.has(pool._feeTier) && pairCount < maxPerPair + 1) {
                    // diversity exception
                } else {
                    continue;
                }
            } else {
                continue;
            }
        }
        if (maxPerDexType > 0 && dexCount >= maxPerDexType) continue;

        selected.push(pool);
        if (k) {
            perPair.set(k, (perPair.get(k) || 0) + 1);
            if (!perPairFeeTiers.has(k)) perPairFeeTiers.set(k, new Set());
            perPairFeeTiers.get(k).add(pool._feeTier);
        }
        perDexType.set(dt, dexCount + 1);
    }

    return selected;
}

function qualityDexFamily(pool = {}) {
    const raw = `${pool.dexType || ''}|${pool.dex || ''}|${pool.type || ''}`.toUpperCase();
    if (raw.includes('RAYDIUM_CLMM') || raw.includes('|CLMM')) return 'raydium_clmm';
    if (raw.includes('RAYDIUM_CPMM') || raw.includes('|CPMM')) return 'raydium_cpmm';
    if (raw.includes('METEORA_DLMM') || raw.includes('|DLMM')) return 'meteora_dlmm';
    if (raw.includes('ORCA_WHIRLPOOL') || raw.includes('|WHIRLPOOL')) return 'orca_whirlpool';
    return null;
}

function poolDexFamily(pool = {}) {
    return qualityDexFamily(pool)
        || String(pool.dexType || pool.dex || pool.type || 'unknown').toLowerCase();
}

function selectPerDexQuality(rankedPools, options) {
    const limit = Math.max(1, Number(options.perDexQualityCount || options.qualityCount || 150));
    const families = ['raydium_clmm', 'raydium_cpmm', 'meteora_dlmm', 'orca_whirlpool'];
    const groups = new Map(families.map((family) => [family, []]));

    for (const pool of rankedPools) {
        const family = qualityDexFamily(pool);
        if (!family || !groups.has(family)) continue;
        groups.get(family).push(pool);
    }

    const selected = [];
    const summary = {};
    for (const family of families) {
        const picked = groups.get(family)
            .slice()
            .sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0))
            .slice(0, limit);
        summary[family] = {
            candidates: groups.get(family).length,
            selected: picked.length,
            minTvlUsd: picked.length ? Math.min(...picked.map(poolTvl)) : 0,
            maxTvlUsd: picked.length ? Math.max(...picked.map(poolTvl)) : 0,
            maxVolume24hUsd: picked.length ? Math.max(...picked.map(poolVolume24h)) : 0,
            maxTrades24h: picked.length ? Math.max(...picked.map(poolTrades24h)) : 0,
        };
        selected.push(...picked);
    }

    selected._selection = {
        mode: 'per-dex',
        limitPerDex: limit,
        families: summary,
        totalSelected: selected.length,
    };
    return selected;
}

/* -------------------------------------------------------------------------- */
/*                  NEW: Triangle-closure-aware selector                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a graph view of the pool universe.
 *
 * Returns:
 *   tokenPools:     mint -> array of pools touching this mint
 *   tokenAnchors:   mint -> Set<anchorMint> the token connects to
 *   anchorPairs:    Set of "anchor|anchor" pair keys (canonical)
 *
 * Only tokens that pass the canonical {tokenXMint, tokenYMint} check enter
 * the graph. Anchor mints are treated as ordinary mints in tokenPools so they
 * naturally accumulate their cross-anchor pools.
 */
function buildTokenGraph(pools, anchorMints) {
    const anchorSet = new Set(anchorMints);
    const tokenPools = new Map();
    const tokenAnchors = new Map();
    const anchorPairs = new Set();

    const add = (token, pool) => {
        if (!tokenPools.has(token)) tokenPools.set(token, []);
        tokenPools.get(token).push(pool);
    };

    for (const pool of pools) {
        const x = String(pool.tokenXMint || pool.baseMint || '');
        const y = String(pool.tokenYMint || pool.quoteMint || '');
        if (!x || !y) continue;

        add(x, pool);
        add(y, pool);

        const xIsAnchor = anchorSet.has(x);
        const yIsAnchor = anchorSet.has(y);

        if (!xIsAnchor && yIsAnchor) {
            if (!tokenAnchors.has(x)) tokenAnchors.set(x, new Set());
            tokenAnchors.get(x).add(y);
        }
        if (!yIsAnchor && xIsAnchor) {
            if (!tokenAnchors.has(y)) tokenAnchors.set(y, new Set());
            tokenAnchors.get(y).add(x);
        }
        if (xIsAnchor && yIsAnchor) {
            const k = pairKey(pool);
            if (k) anchorPairs.add(k);
        }
    }

    return { tokenPools, tokenAnchors, anchorPairs, anchorSet };
}

/**
 * Decide whether a non-anchor token T can participate in a closable triangle
 * given the ranked candidate pools.
 *
 * A token is closable if EITHER:
 *   (a) it touches ≥2 different anchors (path SOL → T → USDC → SOL closes),
 *       AND has ≥1 pool to each (so both legs exist); OR
 *   (b) it has ≥2 cross-DEX pools to the SAME anchor, so the T↔anchor pair
 *       has measurable divergence and can serve as a leg in a larger
 *       SOL → T → anchor → SOL triangle (degenerate when anchor=SOL, but if
 *       anchor=USDC the closing SOL↔USDC leg comes from anchor-anchor pools).
 *
 * Mode (a) is strictly preferred. Mode (b) is enabled only when (a) yields
 * too few tokens, which is detected by the caller.
 *
 * Returns { closable, reason, anchorCounts, totalPools }.
 */
function classifyTokenClosure(token, pools, anchorSet) {
    const anchorCounts = new Map();
    let totalAnchorPools = 0;
    for (const pool of pools) {
        const x = String(pool.tokenXMint || '');
        const y = String(pool.tokenYMint || '');
        const other = x === token ? y : (y === token ? x : null);
        if (!other) continue;
        if (anchorSet.has(other)) {
            anchorCounts.set(other, (anchorCounts.get(other) || 0) + 1);
            totalAnchorPools += 1;
        }
    }

    const distinctAnchors = anchorCounts.size;
    const hasMultiAnchor = distinctAnchors >= 2;
    const hasMultiSameAnchor = Array.from(anchorCounts.values()).some((c) => c >= 2);

    if (hasMultiAnchor) {
        return {
            closable: true,
            mode: 'multi-anchor',
            anchorCounts,
            totalPools: pools.length,
            reason: `connects to ${distinctAnchors} anchors`,
        };
    }
    if (hasMultiSameAnchor) {
        return {
            closable: true,
            mode: 'cross-dex-same-anchor',
            anchorCounts,
            totalPools: pools.length,
            reason: `≥2 pools to same anchor (cross-DEX divergence available)`,
        };
    }

    return {
        closable: false,
        mode: 'orphan',
        anchorCounts,
        totalPools: pools.length,
        reason: distinctAnchors === 0
            ? 'no anchor connection'
            : `only 1 pool to ${distinctAnchors} anchor(s)`,
    };
}

/**
 * Pick the best pools for one (token, anchor) bucket, enforcing fee-tier
 * diversity. Always includes the highest-activity pool, then adds one pool
 * per additional fee tier present, then fills with rank order until the
 * per-anchor cap is reached.
 */
function pickPoolsForTokenAnchor(pools, options) {
    const cap = Math.max(1, Number(options.cap || 3));
    const minKeep = Math.min(cap, Math.max(1, Number(options.minKeep || 1)));
    const enforceDiversity = options.feeTierDiversity !== false;

    const sorted = pools.slice().sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));
    const picked = [];
    const dexesSeen = new Set();
    const feeRatesSeen = new Set();
    const pickedAddresses = new Set();

    const pick = (pool) => {
        const addr = pool.poolAddress || pool.address || pool.id;
        if (addr && pickedAddresses.has(addr)) return false;
        picked.push(pool);
        if (addr) pickedAddresses.add(addr);
        dexesSeen.add(poolDexFamily(pool));
        feeRatesSeen.add(exactFeeBucket(pool));
        return true;
    };

    for (const pool of sorted) {
        if (picked.length >= minKeep) break;
        if (picked.length === 0 || !dexesSeen.has(poolDexFamily(pool)) || !feeRatesSeen.has(exactFeeBucket(pool))) {
            pick(pool);
        }
    }

    for (const pool of sorted) {
        if (picked.length >= minKeep) break;
        pick(pool);
    }

    for (const pool of sorted) {
        if (picked.length >= cap) break;
        if (pickedAddresses.has(pool.poolAddress || pool.address || pool.id)) continue;
        const feeRate = exactFeeBucket(pool);

        if (enforceDiversity) {
            // Prefer exact fee-rate diversity, not broad buckets like "mid" that
            // collapse 20/25/30 bps pools into one class.
            if (!feeRatesSeen.has(feeRate) || !dexesSeen.has(poolDexFamily(pool))) {
                pick(pool);
                continue;
            }

            const remaining = sorted.slice(sorted.indexOf(pool) + 1);
            const hasFreshVariant = remaining.some((p) =>
                !feeRatesSeen.has(exactFeeBucket(p)) || !dexesSeen.has(poolDexFamily(p))
            );
            if (!hasFreshVariant) {
                pick(pool);
            }
        } else {
            pick(pool);
        }
    }

    return picked;
}

/**
 * Triangle-closure-aware selector.
 *
 * Algorithm:
 *   1. Build token graph from ranked pools.
 *   2. Force-include any pool touching --include-pair mints (unconditional).
 *   3. Classify every non-anchor token as closable / orphan.
 *   4. Sort closable tokens by aggregate activity (sum of pool _activityScore).
 *   5. For each token in rank order, pull its pools partitioned by anchor:
 *        - For each anchor connection, run pickPoolsForTokenAnchor.
 *        - Honour --max-pools-per-token globally per token.
 *   6. Add anchor-anchor pools (SOL/USDC, etc.) up to --max-anchor-anchor-pools.
 *   7. Stop when total selected reaches --quality-count, but never below the
 *      "minimum executable" floor of 2 pools per kept token.
 *
 * Returns a single array of pools (no dedup needed; we track by addr Set).
 *
 * The diagnostic counters are stamped on the returned object via a side-band
 * `_selection` field that the caller can read for the summary.
 */
function selectTriangleClosable(rankedPools, options) {
    const topN = Number(options.qualityCount || 40);
    const minPoolsPerToken = Math.max(2, Number(options.minPoolsPerToken || 2));
    const maxPoolsPerToken = Math.max(minPoolsPerToken, Number(options.maxPoolsPerToken || 6));
    const minPoolsPerTokenAnchor = Math.min(maxPoolsPerToken, Math.max(1, Number(options.minPoolsPerTokenAnchor || 2)));
    const maxAnchorAnchorPools = Math.max(0, Number(options.maxAnchorAnchorPools || 8));
    const maxPerDexType = Math.max(0, Number(options.maxPerDexType || 0));
    const requireTwoAnchors = Boolean(options.requireTwoAnchorConnections);
    const includeMints = new Set(options.includePairs || []);
    const anchorMints = options.anchorMints && options.anchorMints.length
        ? options.anchorMints
        : DEFAULT_ANCHOR_MINTS;

    const graph = buildTokenGraph(rankedPools, anchorMints);
    const { tokenPools, anchorSet } = graph;

    const selected = new Set();
    const selectedAddresses = new Set();
    const perDexType = new Map();
    const counts = {
        forcedIncluded: 0,
        closableTokens: 0,
        orphanTokens: 0,
        multiAnchorTokens: 0,
        crossDexSameAnchorTokens: 0,
        rejectedTokens: 0,
        anchorAnchorPools: 0,
        rejectionReasons: new Map(),
    };

    const pushPool = (pool, pushOptions = {}) => {
        const addr = String(pool.poolAddress || pool.address || '');
        if (!addr || selectedAddresses.has(addr)) return false;
        const dexType = String(pool.dexType || pool.type || pool.dex || 'unknown');
        const dexCount = perDexType.get(dexType) || 0;
        if (!pushOptions.ignoreDexCap && maxPerDexType > 0 && dexCount >= maxPerDexType) return false;
        selectedAddresses.add(addr);
        selected.add(pool);
        perDexType.set(dexType, dexCount + 1);
        return true;
    };

    // Step 1: Forced includes via --include-pair.
    if (includeMints.size) {
        for (const pool of rankedPools) {
            const x = String(pool.tokenXMint || '');
            const y = String(pool.tokenYMint || '');
            if (includeMints.has(x) || includeMints.has(y)) {
                if (pushPool(pool, { ignoreDexCap: true })) counts.forcedIncluded += 1;
            }
        }
    }

    // Step 2: Classify non-anchor tokens by closure mode and rank by aggregate activity.
    const tokenClassifications = new Map();
    for (const [token, pools] of tokenPools.entries()) {
        if (anchorSet.has(token)) continue;
        if (pools.length < minPoolsPerToken) {
            counts.orphanTokens += 1;
            const reason = `<${minPoolsPerToken} pools (has ${pools.length})`;
            counts.rejectionReasons.set(reason, (counts.rejectionReasons.get(reason) || 0) + 1);
            continue;
        }
        const classification = classifyTokenClosure(token, pools, anchorSet);
        if (!classification.closable) {
            counts.orphanTokens += 1;
            counts.rejectionReasons.set(classification.reason, (counts.rejectionReasons.get(classification.reason) || 0) + 1);
            continue;
        }
        if (requireTwoAnchors && classification.mode !== 'multi-anchor') {
            counts.rejectedTokens += 1;
            const reason = 'requires two-anchor connection';
            counts.rejectionReasons.set(reason, (counts.rejectionReasons.get(reason) || 0) + 3);
            continue;
        }
        if (classification.mode === 'multi-anchor') counts.multiAnchorTokens += 1;
        if (classification.mode === 'cross-dex-same-anchor') counts.crossDexSameAnchorTokens += 1;
        counts.closableTokens += 1;

        const aggregateActivity = pools.reduce((sum, p) => sum + (Number(p._activityScore) || 0), 0);
        tokenClassifications.set(token, {
            classification,
            pools,
            aggregateActivity,
        });
    }

    const rankedTokens = Array.from(tokenClassifications.entries()).sort(
        (a, b) => b[1].aggregateActivity - a[1].aggregateActivity,
    );

    // Step 3: Walk ranked tokens, pulling fee-diverse pools per (token, anchor) bucket.
    for (const [token, info] of rankedTokens) {
        if (selected.size >= topN) break;
        const { pools } = info;

        // Bucket pools by which anchor they connect to (or 'non-anchor' if pool is
        // T↔T2 where neither is anchor — those are useful as bridge legs for
        // deeper triangles but we handle them only if explicitly enabled).
        const byAnchor = new Map();
        const nonAnchorBucket = [];
        for (const pool of pools) {
            const x = String(pool.tokenXMint || '');
            const y = String(pool.tokenYMint || '');
            const other = x === token ? y : x;
            if (anchorSet.has(other)) {
                if (!byAnchor.has(other)) byAnchor.set(other, []);
                byAnchor.get(other).push(pool);
            } else {
                nonAnchorBucket.push(pool);
            }
        }

        // Per-token cap: split between anchor buckets. Each bucket gets up to
        // ceil(cap / numBuckets), but at least 1.
        const buckets = byAnchor.size;
        if (buckets === 0) continue;
        const perBucketCap = Math.max(1, Math.ceil(maxPoolsPerToken / buckets));

        let pickedForToken = 0;
        for (const [anchor, anchorPools] of byAnchor.entries()) {
            if (pickedForToken >= maxPoolsPerToken) break;
            const remaining = maxPoolsPerToken - pickedForToken;
            const cap = Math.min(perBucketCap, remaining);
            const chosen = pickPoolsForTokenAnchor(anchorPools, {
                cap,
                minKeep: Math.min(minPoolsPerTokenAnchor, remaining),
                feeTierDiversity: options.feeTierDiversity,
            });
            for (const pool of chosen) {
                if (selected.size >= topN) break;
                if (pushPool(pool)) pickedForToken += 1;
            }
        }
    }

    // Step 4: Anchor-anchor pools (SOL/USDC, SOL/USDT, USDC/USDT). Triangles
    // need at least one of these as the closing leg whenever the route uses two
    // distinct anchors. We pull cross-DEX pools to enable divergence on these
    // legs too.
    const anchorAnchorPools = rankedPools.filter((pool) => {
        const x = String(pool.tokenXMint || '');
        const y = String(pool.tokenYMint || '');
        return anchorSet.has(x) && anchorSet.has(y);
    });
    // Group by canonical anchor pair, take fee-diverse top picks per group.
    const aaByPair = new Map();
    for (const pool of anchorAnchorPools) {
        const k = pairKey(pool);
        if (!k) continue;
        if (!aaByPair.has(k)) aaByPair.set(k, []);
        aaByPair.get(k).push(pool);
    }
    for (const [, group] of aaByPair) {
        const cap = Math.max(2, Math.ceil(maxAnchorAnchorPools / Math.max(1, aaByPair.size)));
        const chosen = pickPoolsForTokenAnchor(group, {
            cap,
            feeTierDiversity: options.feeTierDiversity,
        });
        for (const pool of chosen) {
            if (counts.anchorAnchorPools >= maxAnchorAnchorPools) break;
            if (pushPool(pool)) counts.anchorAnchorPools += 1;
        }
    }

    // Result, with a side-band selection summary stored on the array itself.
    const result = Array.from(selected);
    result._selection = {
        mode: 'triangle-closure',
        anchorMints,
        minPoolsPerToken,
        maxPoolsPerToken,
        minPoolsPerTokenAnchor,
        maxAnchorAnchorPools,
        maxPerDexType,
        closableTokens: counts.closableTokens,
        multiAnchorTokens: counts.multiAnchorTokens,
        crossDexSameAnchorTokens: counts.crossDexSameAnchorTokens,
        orphanTokens: counts.orphanTokens,
        forcedIncluded: counts.forcedIncluded,
        anchorAnchorPools: counts.anchorAnchorPools,
        rejectedTokens: counts.rejectedTokens,
        totalSelected: result.length,
        rejectionReasons: Object.fromEntries(counts.rejectionReasons),
    };
    return result;
}

function fillSelectedPairPeers(selectedPools = [], candidatePools = [], options = {}) {
    const minPairPools = Math.max(1, Number(options.minSelectedPairPools || 1));
    const maxAdds = Math.max(0, Number(options.maxSelectedPairPeerAdds || 0));
    if (minPairPools <= 1 || maxAdds <= 0 || !selectedPools.length || !candidatePools.length) {
        return {
            pools: selectedPools,
            added: 0,
            pairsFilled: 0,
            pairsStillShort: 0,
            details: [],
        };
    }

    const selectedByAddr = new Set(selectedPools.map(poolAddressOf).filter(Boolean));
    const selectedByPair = new Map();
    const candidatesByPair = new Map();

    for (const pool of selectedPools) {
        const k = pairKey(pool);
        if (!k) continue;
        if (!selectedByPair.has(k)) selectedByPair.set(k, []);
        selectedByPair.get(k).push(pool);
    }

    for (const pool of candidatePools) {
        const k = pairKey(pool);
        if (!k) continue;
        if (!candidatesByPair.has(k)) candidatesByPair.set(k, []);
        candidatesByPair.get(k).push(pool);
    }

    const out = selectedPools.slice();
    const details = [];
    let added = 0;
    let pairsFilled = 0;
    let pairsStillShort = 0;

    const selectedPairs = Array.from(selectedByPair.entries())
        .sort((a, b) => a[0].localeCompare(b[0]));

    for (const [k, selectedForPair] of selectedPairs) {
        const selectedCount = selectedForPair.length;
        if (selectedCount >= minPairPools) continue;

        const candidates = (candidatesByPair.get(k) || [])
            .filter((pool) => !selectedByAddr.has(poolAddressOf(pool)))
            .sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));
        const available = selectedCount + candidates.length;
        if (available < minPairPools) {
            pairsStillShort += 1;
            details.push({ pair: k, selected: selectedCount, available, added: 0, status: 'insufficient-candidates' });
            continue;
        }

        let addedForPair = 0;
        for (const pool of candidates) {
            if (selectedCount + addedForPair >= minPairPools) break;
            if (added >= maxAdds) break;
            const addr = poolAddressOf(pool);
            if (!addr || selectedByAddr.has(addr)) continue;
            selectedByAddr.add(addr);
            out.push(pool);
            added += 1;
            addedForPair += 1;
        }

        if (selectedCount + addedForPair >= minPairPools) {
            pairsFilled += 1;
            details.push({ pair: k, selected: selectedCount, available, added: addedForPair, status: 'filled' });
        } else {
            pairsStillShort += 1;
            details.push({
                pair: k,
                selected: selectedCount,
                available,
                added: addedForPair,
                status: added >= maxAdds ? 'max-adds-reached' : 'still-short',
            });
        }

        if (added >= maxAdds) break;
    }

    out._selection = {
        ...(selectedPools._selection || {}),
        pairPeerFill: {
            minPairPools,
            maxAdds,
            added,
            pairsFilled,
            pairsStillShort,
            details,
        },
    };

    return { pools: out, added, pairsFilled, pairsStillShort, details };
}

/* -------------------------------------------------------------------------- */
/*                   Optional divergence pre-screen                           */
/* -------------------------------------------------------------------------- */

function applyDivergenceScreen(pools, minBps) {
    if (!minBps || minBps <= 0) return pools;

    const scanner = loadDivergenceScanner();
    if (!scanner?.annotatePairDivergence) {
        console.warn('  divergenceScanner not available — skipping divergence screen');
        return pools;
    }

    scanner.annotatePairDivergence(pools);

    const kept = pools.filter((p) => {
        const peerCount = Number(p.pairPeerCount || 0);
        const comparablePeers = Number(p.pairComparablePeerCount || 0);
        if (peerCount < 2) return true;
        if (comparablePeers < 2 || p.pairDivergenceComparable === false) return true;
        return pairHasClearDivergence(p, minBps);
    });

    const clearKept = kept.filter((p) => pairHasClearDivergence(p, minBps)).length;
    console.log(`  divergence screen: kept ${kept.length}/${pools.length} pools `
        + `(${clearKept} clear >=${minBps} bps; singletons/unmeasurable pass to enrichment)`);
    return kept;
}

function poolAddressOf(pool = {}) {
    return String(pool.poolAddress || pool.address || pool.id || pool.marketAddress || pool.market || '');
}

function poolDiagnosticShape(pool = {}, reason = 'unknown', extra = {}) {
    return {
        reason,
        poolAddress: poolAddressOf(pool) || null,
        dex: pool.dex || null,
        dexType: pool.dexType || null,
        type: pool.type || null,
        tokenXMint: pool.tokenXMint || pool.baseMint || null,
        tokenYMint: pool.tokenYMint || pool.quoteMint || null,
        pairKey: pool._pairKey || pairKey(pool),
        tvl: pool.tvl ?? pool.tvlUsd ?? pool.liquidityUsd ?? null,
        volume24h: pool.volume24h ?? pool.volume24hUsd ?? null,
        feeBps: pool.feeBps ?? pool.feeRateBps ?? null,
        currentPrice: pool.currentPrice ?? pool.midPrice ?? null,
        activityScore: pool._activityScore ?? null,
        pairPeerCount: pool._pairPeerCount ?? pool.pairPeerCount ?? null,
        pairComparablePeerCount: pool.pairComparablePeerCount ?? null,
        pairDivergenceBps: pool.pairDivergenceBps ?? null,
        ...extra,
    };
}

function summarizeDiagnosticReasons(entries = []) {
    return entries.reduce((acc, entry) => {
        const reason = entry.reason || 'unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
    }, {});
}

function diagnoseActivityFloorDrop(pool, options = {}) {
    const minLiquidity = Number(options.minLiquidity || 0);
    const maxFeeBps = Number(options.maxFeeBps || 0);
    const minTurnover = Number(options.minTurnover || 0);
    const minVolume = Number(options.minVolume24h || 0);
    const tvl = Number(pool.tvl || 0);
    const vol = Number(pool.volume24h || 0);
    const turnover = Number(pool._turnover || 0);
    const feeBps = Number(pool.feeBps ?? pool.feeRateBps ?? 0);

    if (maxFeeBps > 0 && Number.isFinite(feeBps) && feeBps > maxFeeBps) return `activity:fee-too-high:${feeBps}>${maxFeeBps}`;
    const effectiveMinLiq = pool._altDexMinLiq != null ? pool._altDexMinLiq : minLiquidity;
    if (effectiveMinLiq > 0 && tvl < effectiveMinLiq) return `activity:low-liquidity`;
    if (minVolume > 0 && vol < minVolume) return `activity:${vol < minVolume ? 'low-volume' : 'ok'}`;
    if (minTurnover > 0 && turnover < minTurnover) return `activity:${turnover < minTurnover ? 'low-turnover' : 'ok'}`;
    return 'activity:ok';
}

function diagnoseDivergenceDrop(pool, minBps = 0) {
    const peerCount = Number(pool.pairPeerCount || pool._pairPeerCount || 0);
    const comparablePeers = Number(pool.pairComparablePeerCount || 0);
    if (peerCount < 2) return 'divergence:singleton';
    if (comparablePeers < 2 || pool.pairDivergenceComparable === false) return 'divergence:not-comparable';
    return `divergence:below-min:${Number(pool.pairDivergenceBps || 0)}<${Number(minBps || 0)}`;
}

function compareStageDrops(stage, before = [], after = [], reasonFn = () => 'unknown') {
    const afterSet = new Set(after.map(poolAddressOf).filter(Boolean));
    const dropped = [];
    for (const pool of before) {
        const addr = poolAddressOf(pool);
        if (!addr || afterSet.has(addr)) continue;
        let reason = 'unknown';
        let extra = {};
        try {
            const diagnosed = reasonFn(pool);
            if (typeof diagnosed === 'string') reason = diagnosed;
            else if (diagnosed && typeof diagnosed === 'object') {
                reason = diagnosed.reason || reason;
                extra = diagnosed.extra || {};
            }
        } catch (err) {
            reason = `diagnostic-error:${err.message}`;
        }
        dropped.push(poolDiagnosticShape(pool, reason, extra));
    }
    return {
        stage,
        before: before.length,
        after: after.length,
        dropped: dropped.length,
        reasons: summarizeDiagnosticReasons(dropped),
        samples: dropped.slice(0, 100),
    };
}

function diagnoseTriangleDrop(pool, rankedPools, selectedPools, options = {}) {
    const selectedSet = new Set(selectedPools.map(poolAddressOf).filter(Boolean));
    if (selectedSet.has(poolAddressOf(pool))) return null;

    const anchorMints = options.anchorMints && options.anchorMints.length ? options.anchorMints : DEFAULT_ANCHOR_MINTS;
    const graph = buildTokenGraph(rankedPools, anchorMints);
    const minPoolsPerToken = Math.max(2, Number(options.minPoolsPerToken || 2));
    const x = String(pool.tokenXMint || pool.baseMint || '');
    const y = String(pool.tokenYMint || pool.quoteMint || '');
    const tokens = [x, y].filter(Boolean);
    const nonAnchors = tokens.filter((token) => !graph.anchorSet.has(token));

    if (!tokens.length) return { reason: 'triangle:missing-mints' };
    if (!nonAnchors.length) return { reason: 'triangle:anchor-anchor-cap-or-rank' };

    const reasons = [];
    for (const token of nonAnchors) {
        const poolsForToken = graph.tokenPools.get(token) || [];
        if (poolsForToken.length < minPoolsPerToken) {
            reasons.push(`<${minPoolsPerToken} pools (has ${poolsForToken.length})`);
            continue;
        }
        const cls = classifyTokenClosure(token, poolsForToken, graph.anchorSet);
        if (!cls.closable) {
            reasons.push(cls.reason);
            continue;
        }
        if (options.requireTwoAnchorConnections && cls.mode !== 'multi-anchor') {
            reasons.push('requires two-anchor connection');
            continue;
        }
        reasons.push(`closable-but-not-selected:${cls.mode}`);
    }

    const reason = reasons.some((r) => r.startsWith('closable-but-not-selected'))
        ? 'triangle:cap-rank-or-per-token-limit'
        : `triangle:${Array.from(new Set(reasons)).join('; ')}`;
    return { reason, extra: { tokenReasons: reasons } };
}

/* -------------------------------------------------------------------------- */
/*                              CLI / main                                    */
/* -------------------------------------------------------------------------- */

function summarize(pools) {
    return pools.reduce((acc, pool) => {
        const key = `${pool.dex || 'unknown'}:${pool.type || 'unknown'}`;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}

function summarizeActivity(pools) {
    const tiers = { ultralow: 0, low: 0, mid: 0, high: 0, unknown: 0 };
    let withVol = 0; let withoutVol = 0;
    let totalTurnover = 0; let countTurnover = 0;
    for (const p of pools) {
        tiers[feeTierBucket(p.feeBps)] = (tiers[feeTierBucket(p.feeBps)] || 0) + 1;
        if (Number(p.volume24h || 0) > 0) {
            withVol += 1;
            const t = turnoverOnly(p);
            if (t > 0) { totalTurnover += t; countTurnover += 1; }
        } else {
            withoutVol += 1;
        }
    }
    return {
        feeTiers: tiers,
        coverage: { withVolumeData: withVol, withoutVolumeData: withoutVol },
        avgTurnover: countTurnover > 0 ? Number((totalTurnover / countTurnover).toFixed(3)) : 0,
    };
}

function summarizeTriangleCoverage(pools, anchorMints) {
    const graph = buildTokenGraph(pools, anchorMints);
    const tokenList = [];
    let triangleClosable = 0;
    let multiAnchor = 0;
    for (const [token, pools_] of graph.tokenPools.entries()) {
        if (graph.anchorSet.has(token)) continue;
        if (pools_.length < 2) continue;
        const cls = classifyTokenClosure(token, pools_, graph.anchorSet);
        if (cls.closable) {
            triangleClosable += 1;
            if (cls.mode === 'multi-anchor') multiAnchor += 1;
            tokenList.push({
                token,
                symbol: pools_.find((p) => p.tokenXMint === token)?.baseSymbol
                    || pools_.find((p) => p.tokenYMint === token)?.quoteSymbol
                    || token.slice(0, 6) + '..' + token.slice(-4),
                poolCount: pools_.length,
                anchorConnections: Array.from(cls.anchorCounts.entries()).map(([a, n]) => ({ anchor: a, pools: n })),
                mode: cls.mode,
            });
        }
    }
    return {
        triangleClosableTokens: triangleClosable,
        multiAnchorTokens: multiAnchor,
        anchorAnchorPairs: graph.anchorPairs.size,
        closableTokenList: tokenList.slice(0, 30),
    };
}

async function main() {
    const args = parseArgs(process.argv);
    const selectionDiagnostics = {
        generatedAt: new Date().toISOString(),
        settings: {
            selectMode: args.selectMode,
            qualityCount: args.qualityCount,
            minLiquidity: args.minLiquidity,
            maxFeeBps: args.maxFeeBps,
            minTurnover: args.minTurnover,
            minVolume24h: args.minVolume24h,
            minTrades24h: args.minTrades24h,
            minDivergence: args.minDivergence,
            minPoolsPerToken: args.minPoolsPerToken,
            maxPoolsPerToken: args.maxPoolsPerToken,
            maxAnchorAnchorPools: args.maxAnchorAnchorPools,
            minSelectedPairPools: args.minSelectedPairPools,
            maxSelectedPairPeerAdds: args.maxSelectedPairPeerAdds,
            opportunityFilter: args.opportunityFilter,
            includeExactPairs: args.includeExactPairs,
        },
        stages: [],
    };
    if (args.help) {
        console.log(`Usage:
  node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json \\
       --quality 60 --over-fetch 5 --max-per-dex-type 20

Selection mode:
  --select-mode triangle-closure   New default — graph-aware (recommended)
  --select-mode legacy             Old behaviour (rank+pair-cap)
  --select-mode per-dex            Keep top pools per CLMM/CPMM/DLMM/Whirlpool family
  --keep-per-dex N                 Per-family cap for --select-mode per-dex (default 150)
  --no-quality                     Write all ranked candidates after hard exclusions

Triangle-closure tunables:
  --anchor-mints A,B,C             Which mints triangles must close back to
                                   (default SOL,USDC,USDT)
  --min-pools-per-token N          Drop tokens with <N total pools (default 2)
  --min-pools-per-token-anchor N   Keep at least N pools per token-anchor bucket when available (default 2)
  --max-pools-per-token N          Cap pools per non-anchor token (default 6)
  --max-anchor-anchor-pools N      Cap on SOL/USDC etc combined (default 8)
  --min-selected-pair-pools N      Keep at least N pools for selected pairs when candidates exist (default 2)
  --max-selected-pair-peer-adds N  Cap extra pair-peer pools added after selection (default 60)
  --no-selected-pair-peer-fill     Disable selected-pair peer preservation
  --require-two-anchor-connections Only keep tokens connecting to ≥2 anchors

Activity ranking:
  --rank turnover|tvl|composite    Primary signal (default composite)
  --over-fetch N                   Fetch N x limit per DEX (default 4)
  --min-liquidity $                Drop pools with TVL < amount (default 1500000)
  --max-fee-bps N                  Drop pools with feeBps > N (0 disables)
  --alt-dex-min-liquidity $        TVL floor for CPMM/DAMM-v2/PumpSwap/PancakeSwap (default 200000)
  --alt-dex-out FILE               Save alt-DEX surviving pools to a separate JSON file
  --min-turnover N                 Drop pools with vol/TVL < N (default 0)
  --min-volume24h $                Drop pools with known $vol < amount (default 0)
  --min-trades24h N                Drop pools with known 24h trades below N
  --min-divergence N               Drop comparable multi-pool pairs below N bps (default 0);
                                   singletons/unmeasurable pairs pass through
  --divergence-weight N            Rank boost for clear divergence (default 50)
  --no-divergence-diagnose         Suppress divergence mismatch diagnostics

Other:
	  --quality N                      Enable quality/triangle selection, topN=N (default off)
	  --routes-out FILE                Export engine-readable { chainRoutes, pools } routed payload
	  --max-routes-per-triangle N      Cap routed combinations per triangle for --routes-out (default 10)
	  --max-per-pair N                 Per-pair cap (legacy mode only)
  --max-per-dex-type N             Per-dexType cap during selection (default off)
  --include-pair MINT              Force-include any pool touching MINT
  --include-exact-pairs A/B,C/D    Keep only these exact token pairs; order-insensitive
  --only-target-anchor-pairs       Keep target-mids ↔ target-anchor-mints plus anchor closers
  --target-anchor-mints A,B        Anchors for target-pair filter (default SOL,USDC)
  --exclude-stable-stable          Drop USDC/USDT pools
  --damm-v2                        Deprecated here; use --merge-ready with DAMM v2 fetch output
  --pumpswap                       Fetch PumpSwap AMM pools via on-chain Anchor account scan
  --pancakeswap                    Fetch PancakeSwap pools via Bitquery and merge into this run
  --bitquery-limit N               Bitquery row limit for PancakeSwap (default 1000)
  --bitquery-token-file FILE       Bitquery credential file
  --bitquery-families LIST         Bitquery ProtocolFamily list (default PancakeSwap)
  --merge-ready A.json,B.json      Merge already-shaped ready pool files into fetched pools
  --localPools                     Use only --merge-ready/--ready-pools files; skip API/RPC/Bitquery fetches
  --target-mids A,B,C              Mints to target for Raydium targeted fetches
  --amm-scan-max-per-mint N        PumpSwap targeted scan cap per mint
  --amm-scan-max-total N           PumpSwap targeted scan cap total
  --amm-hydrate-batch-size N       Batch size for vault/mint hydration RPC
  --amm-hydrate-batch-delay-ms N   Delay between hydration batches
  --amm-scan-timeout-ms N          Timeout per targeted mint scan
  --amm-scan-retries N             Retries per targeted mint scan
  --no-fee-tier-diversity          Disable fee-tier diversity (default ON)
`);
        process.exit(0);
    }

    if (args.targetMids && args.targetMids.length) {
        args.includePairs = Array.from(new Set([...args.includePairs, ...args.targetMids]));
    }

    console.log('Custom raw pool fetcher (triangle-closure-aware)');
    console.log(`Output:        ${args.out}`);
    if (args.routesOut) console.log(`Routes output: ${args.routesOut}`);
    if (args.rawOut) console.log(`Raw snapshot:  ${args.rawOut}`);
    if (args.openbook || args.phoenix) {
        console.log(`Orderbooks:    openbook=${args.openbook} phoenix=${args.phoenix} source=${args.orderbookSource || 'none'}`);
    }
    if (!args.invariant && !args.crema && !args.cykura && !args.dradex) {
        console.log('Extra DEXes:   disabled (use --extra-dexes to include invariant/crema/cykura/dradex)');
    }
    console.log(`Limit per DEX: ${args.limit}  ·  over-fetch x${args.overFetch}`);
    if (args.pancakeSwap) {
        console.log(`PancakeSwap:   Bitquery families=${args.bitqueryFamilies} limit=${args.bitqueryLimit}`);
    }
    if (args.localPools) {
        console.log(`Local pools:   only (${args.readyPoolInputs.length} ready input file${args.readyPoolInputs.length === 1 ? '' : 's'})`);
        if (!args.readyPoolInputs.length) {
            console.error('ERROR: --localPools needs at least one --merge-ready/--ready-pools file.');
            process.exit(1);
        }
    }
    console.log(`Ranking:       ${args.rank}  min-liquidity=${args.minLiquidity} `
        + `max-fee-bps=${args.maxFeeBps || 'off'} min-turnover=${args.minTurnover} min-volume=${args.minVolume24h} min-trades=${args.minTrades24h}`);
    if (args.includeExactPairs.length) {
        console.log(`Pair filter:   ${args.includeExactPairs.map((p) => p.split('|').map((m) => MINT_SYMBOLS.get(m) || m.slice(0, 6)).join('/')).join(', ')}`);
    }
    console.log(`Divergence:    min=${args.minDivergence}bps weight=${args.divergenceWeight}`);
    console.log(`Selection:     mode=${args.selectMode} topN=${args.qualityCount} `
        + `feeTierDiversity=${args.feeTierDiversity}`);
    if (args.selectMode === 'triangle-closure') {
        console.log(`               anchors=${args.anchorMints.length} `
            + `minPoolsPerToken=${args.minPoolsPerToken} maxPoolsPerToken=${args.maxPoolsPerToken} `
            + `maxAnchorAnchor=${args.maxAnchorAnchorPools} maxPerDexType=${args.maxPerDexType}`);
    } else if (args.selectMode === 'per-dex') {
        console.log(`               perDexQualityCount=${args.perDexQualityCount}`);
    }

    const overFetchSize = args.limit * args.overFetch;
    const pools = [];
    const ammScanOptions = anchorAmmScanOptions(args);

    if (args.localPools) {
        console.log('\nSkipping live fetches because --localPools is set.');
    } else {
        // Fetch in sequence with delays between on-chain calls to avoid 429
        if (args.raydiumClmm || args.raydiumCpmm) {
            pools.push(...await fetchRaydium(args.limit, args.raydiumClmm, args.raydiumCpmm, overFetchSize));
        }
        if (args.orca) pools.push(...await fetchOrca(args.limit, overFetchSize));
        if (args.meteoraDlmm) pools.push(...await fetchMeteora(args.limit, overFetchSize));
        const wantsAltDexFallback = args.meteoraDammV2 || args.pumpSwap || args.pancakeSwap;
        if (wantsAltDexFallback) {
            addAltDexFallbackInputs(args, 'requested alt DEX fallback');
        }

        if (args.meteoraDammV2) {
            const live = await fetchMeteoraDammV2(args.limit, overFetchSize, args.targetMids, ammScanOptions);
            pools.push(...live);
            if (live.length === 0) {
                console.log('  DAMM v2 live fetch returned 0; relying on ready-pool fallback if available.');
            }
        }
        if (args.pumpSwap) {
            let live = await fetchPumpswapFromBitquery({ ...args, bitqueryFamilies: 'PumpSwap' });
            if (args.pumpSwapScan) {
                const scanned = await fetchPumpSwapAmm(args.limit, overFetchSize, args.targetMids, ammScanOptions);
                live = mergeExtractedAndReadyPools(live, scanned);
            } else {
                console.log('  PumpSwap on-chain scan skipped by default; pass --pumpswap-scan to enable slow RPC scan.');
            }
            if (live.length === 0) {
                const screened = await fetchPumpSwapFromDexScreener(args);
                live = mergeExtractedAndReadyPools(live, screened);
            }
            pools.push(...live);
            if (live.length === 0) {
                console.log('  PumpSwap fetch returned 0; add a PumpSwap ready-pool file via --merge-ready or try --pumpswap-scan with a fast RPC.');
            }
        }
        if (args.pancakeSwap) {
            const live = await fetchPancakeSwapFromBitquery(args);
            pools.push(...live);
            if (live.length === 0) {
                console.log('  PancakeSwap Bitquery returned 0; relying on ready-pool fallback if available.');
            }
        }

        if (args.targetMids && args.targetMids.length && (args.raydiumClmm || args.raydiumCpmm)) {
            console.log(`\nTargeted Raydium fetches for ${args.targetMids.length} mid/LST mints...`);
            for (const mint of args.targetMids) {
                const mintPools = await fetchRaydiumByMint(mint);
                if (mintPools.length) {
                    console.log(`  ${mint.slice(0, 8)}..: +${mintPools.length} pools`);
                    pools.push(...mintPools);
                }
            }
        }
    }

    if (args.readyPoolInputs.length) {
        console.log(`\nMerging ready pool files...`);
        const readyPools = await loadReadyPools(args.readyPoolInputs);
        const beforeMerge = pools.length;
        const merged = mergeExtractedAndReadyPools(pools, readyPools);
        pools.length = 0;
        pools.push(...merged);
        console.log(`  Ready merge result: ${beforeMerge} extracted + ${readyPools.length} ready -> ${pools.length} unique pools`);
        console.log('  Counts:', summarize(pools));
    }

    // Tag alt-DEX pools with their own lower liquidity floor so rankAndAnnotate
    // uses it instead of the main minLiquidity threshold.
    const ALT_DEX_TYPES = new Set(['METEORA_DAMM_V2', 'PUMPSWAP_AMM', 'PANCAKESWAP_AMM', 'RAYDIUM_CPMM']);
    if (args.altDexMinLiquidity >= 0) {
        let altTagged = 0;
        for (const p of pools) {
            const dt = String(p.dexType || p.type || '').toUpperCase();
            if (ALT_DEX_TYPES.has(dt)) {
                p._altDexMinLiq = args.altDexMinLiquidity;
                altTagged += 1;
            }
        }
        if (altTagged > 0) {
            console.log(`  Alt-DEX min-liquidity override: ${altTagged} pools tagged with floor ${args.altDexMinLiquidity.toLocaleString()}`);
        }
    }

    console.log(`\nTotal raw fetched: ${pools.length}`);
    console.log('  Counts:', summarize(pools));
    console.log('  Alt-DEX counts:', summarizeAltDexPools(pools));

    let candidatePools = applyPoolExclusions(pools, args.excludePools);
    candidatePools = removeBlockedOrderbookTaggedPools(candidatePools);
    if (args.rejectCpmmStableStable) candidatePools = filterCpmmStableStablePools(candidatePools);
    if (args.excludeStableStable) candidatePools = filterStableStablePools(candidatePools);
    if (args.onlyTargetAnchorPairs) candidatePools = filterOnlyTargetAnchorPairs(candidatePools, args);
    if (args.includeExactPairs.length) candidatePools = filterExactPairs(candidatePools, args.includeExactPairs);
    if (candidatePools.length !== pools.length) {
        console.log(`  Filtered raw snapshot: ${candidatePools.length}/${pools.length}`);
        console.log('  Filtered counts:', summarize(candidatePools));
        console.log('  Filtered alt-DEX counts:', summarizeAltDexPools(candidatePools));
    }

    if (args.rawOut) {
        await fs.mkdir(path.dirname(path.resolve(args.rawOut)), { recursive: true });
        await fs.writeFile(args.rawOut, JSON.stringify(candidatePools, null, 2));
        console.log(`  Saved raw snapshot to ${path.resolve(args.rawOut)}`);
    }
    if (args.selectionDiagnose && candidatePools.length !== pools.length) {
        selectionDiagnostics.stages.push(compareStageDrops(
            'excluded-pools',
            pools,
            candidatePools,
            () => 'configured-exclude-pool',
        ));
    }

    console.log(`\nRanking by ${args.rank} score...`);
    let ranked = rankAndAnnotate(candidatePools, args);
    let pairPeerCandidatePools = candidatePools;
    if (args.selectionDiagnose) {
        selectionDiagnostics.stages.push(compareStageDrops(
            'activity-floor',
            candidatePools,
            ranked,
            (pool) => diagnoseActivityFloorDrop(pool, args),
        ));
    }
    console.log(`  After activity floor: ${ranked.length}/${candidatePools.length}`);
    console.log('  Ranked alt-DEX counts:', summarizeAltDexPools(ranked));
    const activitySummary = summarizeActivity(ranked);
    console.log(`  Volume coverage: ${activitySummary.coverage.withVolumeData}/${ranked.length} pools have volume24h`);
    console.log(`  Avg turnover (vol/TVL):`, activitySummary.avgTurnover);
    console.log(`  Fee tiers:`, activitySummary.feeTiers);

    if (args.minDivergence > 0) {
        const beforeDivergence = ranked;
        ranked = applyDivergenceScreen(ranked, args.minDivergence);
        if (args.selectionDiagnose) {
            selectionDiagnostics.stages.push(compareStageDrops(
                'divergence-screen',
                beforeDivergence,
                ranked,
                (pool) => diagnoseDivergenceDrop(pool, args.minDivergence),
            ));
        }
    }

    // Pre-selection diagnostic.
    const preCoverage = summarizeTriangleCoverage(ranked, args.anchorMints);
    console.log(`\nPre-selection triangle coverage:`);
    console.log(`  Triangle-closable tokens: ${preCoverage.triangleClosableTokens}`);
    console.log(`  Multi-anchor tokens: ${preCoverage.multiAnchorTokens}`);
    console.log(`  Anchor-anchor pairs: ${preCoverage.anchorAnchorPairs}`);

    let outputPools;
    if (args.quality) {
        const beforeQuality = ranked;
        if (args.selectMode === 'legacy') {
            outputPools = selectWithDiversity(ranked, args);
            console.log(`\nLegacy quality selection: ${outputPools.length}/${ranked.length}`);
            if (args.selectionDiagnose) {
                selectionDiagnostics.stages.push(compareStageDrops(
                    'legacy-quality-selection',
                    beforeQuality,
                    outputPools,
                    () => 'legacy:pair-cap-rank-or-dex-cap',
                ));
            }
        } else if (args.selectMode === 'per-dex') {
            outputPools = selectPerDexQuality(ranked, args);
            const sel = outputPools._selection || {};
            console.log(`\nPer-DEX quality selection: ${outputPools.length}/${ranked.length}`);
            for (const [family, stats] of Object.entries(sel.families || {})) {
                console.log(`  ${family}: selected=${stats.selected}/${stats.candidates} `
                    + `maxTVL=${Math.round(stats.maxTvlUsd || 0)} maxVol24h=${Math.round(stats.maxVolume24hUsd || 0)} `
                    + `maxTrades24h=${Math.round(stats.maxTrades24h || 0)}`);
            }
            if (args.selectionDiagnose) {
                selectionDiagnostics.stages.push(compareStageDrops(
                    'per-dex-quality-selection',
                    beforeQuality,
                    outputPools,
                    () => 'per-dex:family-cap-rank-or-unsupported-family',
                ));
            }
        } else {
            outputPools = selectTriangleClosable(ranked, args);
            const sel = outputPools._selection || {};
            console.log(`\nTriangle-closure selection: ${outputPools.length}/${ranked.length}`);
            console.log(`  Closable tokens kept: ${sel.closableTokens || 0} `
                + `(multi-anchor=${sel.multiAnchorTokens || 0}, cross-dex=${sel.crossDexSameAnchorTokens || 0})`);
            console.log(`  Anchor-anchor pools: ${sel.anchorAnchorPools || 0}`);
            console.log(`  Forced includes: ${sel.forcedIncluded || 0}`);
            if (sel.orphanTokens) {
                console.log(`  Orphan tokens dropped: ${sel.orphanTokens}`);
                const top = Object.entries(sel.rejectionReasons || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);
                for (const [reason, n] of top) {
                    console.log(`     · ${reason}: ${n}`);
                }
            }
            if (args.selectionDiagnose) {
                selectionDiagnostics.stages.push(compareStageDrops(
                    'triangle-closure-selection',
                    beforeQuality,
                    outputPools,
                    (pool) => diagnoseTriangleDrop(pool, beforeQuality, outputPools, args),
                ));
            }
        }
        console.log('  Counts:', summarize(outputPools));

        const peerFill = fillSelectedPairPeers(outputPools, pairPeerCandidatePools, args);
        if (peerFill.added > 0 || peerFill.pairsStillShort > 0) {
            outputPools = peerFill.pools;
            console.log(`  Pair peer fill: +${peerFill.added} pools `
                + `(filled=${peerFill.pairsFilled}, stillShort=${peerFill.pairsStillShort}, min=${args.minSelectedPairPools})`);
            const filledExamples = peerFill.details
                .filter((entry) => entry.added > 0)
                .slice(0, 8)
                .map((entry) => `${entry.pair.split('|').map((x) => x.slice(0, 4)).join('/')} +${entry.added}`);
            if (filledExamples.length) console.log(`     · ${filledExamples.join(', ')}`);
            console.log('  Counts after pair peer fill:', summarize(outputPools));
        }

        // ──────────────────────────────────────────────────────────────────────────
        // OPPORTUNITY PRE-SELECTOR — drop pools that don't appear in capturable
        // routes given current spot prices. Cuts enrichment+simulation time
        // proportionally to how many pools survive.
        // ──────────────────────────────────────────────────────────────────────────
        if (args.opportunityFilter && selectByOpportunity && outputPools.length) {
            console.log('\nApplying buyLow/sellHigh opportunity filter...');
            const beforeOpportunity = outputPools;
            const oppResult = selectByOpportunity(outputPools, {
                anchorMints: args.anchorMints,
                maxTriFeeBps: args.opportunityMaxTriFee,
                maxPairFeeBps: args.opportunityMaxPairFee,
                minCapturedBps: args.opportunityMinCaptured,
                minTvlUsd: args.opportunityMinTvl,
                maxOutputPools: args.opportunityMaxPools,
                keepOrderbookWildcards: true,
                maxOrderbookWildcards: args.maxOrderbookPools,
                keepDexWildcards: args.opportunityKeepDexWildcards,
                maxDexWildcards: args.opportunityMaxDexWildcards,
            });

            // Symbol resolver for log output — anchors are well-known, others fall back
            // to the pool's own baseSymbol/quoteSymbol or truncated mint.
            const symMap = new Map([
                ['So11111111111111111111111111111111111111112', 'SOL'],
                ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
                ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
            ]);
            for (const p of outputPools) {
                if (p.tokenXMint && p.baseSymbol && !symMap.has(p.tokenXMint)) symMap.set(p.tokenXMint, p.baseSymbol);
                if (p.tokenYMint && p.quoteSymbol && !symMap.has(p.tokenYMint)) symMap.set(p.tokenYMint, p.quoteSymbol);
            }
            const symOf = (m) => symMap.get(m) || String(m).slice(0, 6);

            console.log(summarizeOpportunities(oppResult, symOf));

            if (oppResult.selected.length) {
                // Replace outputPools with the opportunity-filtered set. Order is by
                // route-rank: pools that appear in higher-captured routes come first,
                // which keeps downstream displays meaningful.
                outputPools = oppResult.selected;
                if (args.selectionDiagnose) {
                    selectionDiagnostics.stages.push(compareStageDrops(
                        'opportunity-filter',
                        beforeOpportunity,
                        outputPools,
                        (pool) => {
                            const tvl = Number(pool.tvlUsd ?? pool.tvl ?? pool.liquidityUsd ?? 0);
                            if (
                                (!pool.currentPrice || !Number.isFinite(Number(pool.currentPrice)))
                                && !hasUsableReserves(pool)
                            ) return 'opportunity:missing-current-price-or-reserves';
                            if (tvl < Number(args.opportunityMinTvl || 0)) return `opportunity:tvl-below-min:${tvl}<${args.opportunityMinTvl}`;
                            return 'opportunity:not-in-capturable-route';
                        },
                    ));
                }
            } else {
                console.warn('  ⚠ No routes pass the opportunity filter at current spot prices.');
                console.warn('    Keeping the triangle-closable set so enrichment can attempt later.');
                console.warn('    Lower --opp-min-captured or raise --opp-max-tri-fee to diagnose.');
            }
        }
    } else {
        outputPools = ranked;
        console.log(`\nNo --quality flag: writing all ${outputPools.length} ranked pools`);
    }

    // Post-selection coverage.
    const postCoverage = summarizeTriangleCoverage(outputPools, args.anchorMints);
    console.log(`\nPost-selection triangle coverage:`);
    console.log(`  Triangle-closable tokens: ${postCoverage.triangleClosableTokens}`);
    console.log(`  Multi-anchor tokens: ${postCoverage.multiAnchorTokens}`);
    console.log(`  Anchor-anchor pairs: ${postCoverage.anchorAnchorPairs}`);
    if (postCoverage.closableTokenList.length) {
        console.log(`  Top closable tokens (showing ${Math.min(postCoverage.closableTokenList.length, 10)}):`);
        for (const t of postCoverage.closableTokenList.slice(0, 10)) {
            const anchors = t.anchorConnections.map((c) => `${c.anchor.slice(0, 4)}..×${c.pools}`).join(' ');
            console.log(`     ${t.symbol.padEnd(10)} pools=${t.poolCount} anchors=[${anchors}] mode=${t.mode}`);
        }
    }

    // Triangle verification via divergenceAwareRouteBuilder.
    const rb = loadRouteBuilder();
    if (rb?.buildAllDivergenceAwareRoutesForGraph && outputPools.length) {
        try {
            const pairMap = buildPairMap(outputPools);
            const { triangles, chainRouteCount } = rb.buildAllDivergenceAwareRoutesForGraph(pairMap, {
                tokenA: args.anchorMints[0] || SOL,
                maxRoutesPerTriangle: 1,
            });
            const inTriangle = new Set(triangles.flatMap((t) => [t.tokenA, t.tokenB, t.tokenC]));
            console.log(`\nTriangle verification (route builder):`);
            console.log(`  Confirmed triangles: ${triangles.length}  chainRoutes: ${chainRouteCount}`);
            console.log(`  Tokens in actual closed triangles: ${inTriangle.size}`);
        } catch (err) {
            console.warn('  Triangle verification failed:', err.message);
        }
    }

    // Strip internal annotations from output.
    const cleanedOutput = outputPools.map((p) => {
        const cleaned = { ...p };
        delete cleaned._activityScore;
        delete cleaned._baseActivityScore;
        delete cleaned._turnover;
        delete cleaned._pairPeerCount;
        delete cleaned._feeTier;
        delete cleaned._pairKey;
        delete cleaned._divergenceScoreBps;
        delete cleaned._divergenceComparable;
        delete cleaned._divergenceClear;
        delete cleaned._divergenceRankBoost;
        delete cleaned._qualityScore;
        delete cleaned._altDexMinLiq;
        return cleaned;
    });

    await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fs.writeFile(args.out, JSON.stringify(cleanedOutput, null, 2));
    console.log(`\nSaved raw pools to ${path.resolve(args.out)}`);

    if (args.routesOut) {
        const routePayload = buildRoutedChainPayload(cleanedOutput, args);
        await fs.mkdir(path.dirname(path.resolve(args.routesOut)), { recursive: true });
        await fs.writeFile(args.routesOut, JSON.stringify(routePayload, null, 2));
        console.log(`Saved routed chain payload to ${path.resolve(args.routesOut)}`);
        console.log(`  chainRoutes=${routePayload.chainRouteCount} triangles=${routePayload.triangleCount} `
            + `routedPools=${routePayload.routedPoolCount}/${cleanedOutput.length} orphanDropped=${routePayload.orphanPoolCount}`);
        if (routePayload.chainRouteCount === 0) {
            console.warn('  ⚠ No 3-leg routed chains were built from the selected pool set.');
        }
    }

    if (args.altDexOut) {
        const altDexSet = new Set(['METEORA_DAMM_V2', 'PUMPSWAP_AMM', 'PANCAKESWAP_AMM', 'RAYDIUM_CPMM']);
        const altDexPools = cleanedOutput.filter((p) => altDexSet.has(String(p.dexType || p.type || '').toUpperCase()));
        if (altDexPools.length) {
            await fs.mkdir(path.dirname(path.resolve(args.altDexOut)), { recursive: true });
            await fs.writeFile(args.altDexOut, JSON.stringify(altDexPools, null, 2));
            console.log(`Saved ${altDexPools.length} alt-DEX pools to ${path.resolve(args.altDexOut)}`);
        } else {
            console.log('  No alt-DEX pools survived quality selection — skipping alt-dex-out write');
        }
    }

    if (args.selectionDiagnose) {
        selectionDiagnostics.final = {
            fetched: pools.length,
            candidates: candidatePools.length,
            output: outputPools.length,
            outputCounts: summarize(outputPools),
        };
        await fs.mkdir(path.dirname(path.resolve(args.selectionDiagnoseOut)), { recursive: true });
        await fs.writeFile(args.selectionDiagnoseOut, JSON.stringify(selectionDiagnostics, null, 2));
        console.log(`Selection diagnostics saved to ${path.resolve(args.selectionDiagnoseOut)}`);
    }

    if (args.quality && args.qualityMeta) {
        const qualityOutput = buildQualityOutput({
            source: 'zenPools/00_raw.js (triangle-closure)',
            selected: cleanedOutput,
            ranked: ranked.slice(0, 200),
            triangleFamilies: postCoverage.closableTokenList,
            options: {
                topN: args.qualityCount,
                minLiquidity: args.minLiquidity,
                rank: args.rank,
                minTurnover: args.minTurnover,
                minVolume24h: args.minVolume24h,
                minTrades24h: args.minTrades24h,
                minDivergence: args.minDivergence,
                divergenceWeight: args.divergenceWeight,
                divergenceDiagnose: args.divergenceDiagnose,
                feeTierDiversity, //: args.feeTierDiversity,
                excludePools: args.excludePools,
                selectMode: args.selectMode,
                perDexQualityCount: args.perDexQualityCount,
                anchorMints: args.anchorMints,
                minPoolsPerToken: args.minPoolsPerToken,
                maxPoolsPerToken: args.maxPoolsPerToken,
                maxAnchorAnchorPools: args.maxAnchorAnchorPools,
                minSelectedPairPools: args.minSelectedPairPools,
                maxSelectedPairPeerAdds: args.maxSelectedPairPeerAdds,
                activitySummary,
                triangleCoverage,//: postCoverage,
                selectionDiagnostics: outputPools._selection || null,
            },
            mode: args.selectMode === 'legacy' ? 'direct-api-activity-select' : 'direct-api-triangle-closure',
        });
        await fs.writeFile(args.qualityMeta, JSON.stringify(qualityOutput, null, 2));
        console.log(`Saved quality metadata to ${path.resolve(args.qualityMeta)}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = {
    main,
    parseArgs,
    extractList,
    mapRaydiumRaw,
    mapOrcaRaw,
    mapMeteoraRaw,
    fetchRaydium,
    fetchOrca,
    fetchMeteora,
    fetchPancakeSwapFromBitquery,
    fetchPumpswapFromBitquery,
    fetchPumpSwapAmm,
    fetchRaydiumByMint,
    rankAndAnnotate,
    selectWithDiversity,
    selectPerDexQuality,
    qualityDexFamily,
    selectTriangleClosable,
    buildTokenGraph,
    classifyTokenClosure,
    buildRoutedChainPayload,
    pickPoolsForTokenAnchor,
    summarizeTriangleCoverage,
    activityScore,
    poolTvl,
    poolVolume24h,
    poolTrades24h,
    turnoverOnly,
    pairKey,
    feeTierBucket,
    applyDivergenceScreen,
    annotateDivergenceSignals,
    pairHasClearDivergence,
    buildCurrentPriceFields,
    deriveReservePriceYPerX,
    applyPoolExclusions,
    poolIdOf,
    DEFAULT_ANCHOR_MINTS,
};

/*
 * =============================================================================
 *  RUN MODES
 * =============================================================================
 *
 * 
 * Default (filter on):
# 1. Fetch pools
node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 01_raw.json --quality 80 [other flags...]

# 2. Run divergence scanner to annotate pairDivergenceComparable
node utilities/divergenceScanner.js --in 01_meta.json --out 02_scanned.json --diagnose

# 3. NOW run opportunity filter — it will use the comparable flags
node utilities/opportunityPreSelector.js --input 02_scanned.json --output 03_filtered.json --minCaptured 1 --maxTriFee 50

# 4. Enrich only the filtered pools
node engine/zen_enrichment.js --in 03_filtered.json --out 04_enriched.json

# 5. Run engine
node engine/myEngine.js --in 04_enriched.json --out 05_results.json

Additional tweaks if you’re still not profitable
Increase --min-divergence to 0.5 or 1.0 bps.

Set --opp-min-captured to 1.0 bps.

Run with --opportunity-filter alone first (no --quality), just to see how many routes pass.

Use --selection-diagnose to identify which tokens are most often dropped – you may need to add a --include-pair for a specific mid‑token.

   --include-exact-pairs HYPE/SOL, USDC/HYPE, JLP/SOL, USDC/JLP, SOL/WBTC, USDC/WBTC, TRUMP/SOL, TRUMP/USDC, SOL/cbBTC, cbBTC/USDC

========================================
=========================================
 --diagnose-selection-out pools/_diagnose_enrichedPools.json \ \
--local-only \
--selectMode=triangle-closure \

    node utilities/poolFetchCustom_raw.js \
    --merge-ready pools/raw_quality_candidates.json,poolTrade/_SHYFT.raw.json \
    --includePairs WBTC, JLP, RAY, PRIME, CBBTC, JITOSOL, PYUSD, HYPE, WETH \
    --out poolTrade/_FETCHED.raw2.json \
    --over-fetch 6 \
    --max-fee-bps 5 \
    --pools/raw_quality_candidates.json \
    --min-liquidity 500000 \              
    --quality 50        
    --amm-hydrate-batch-delay-ms 150 \
    --amm-scan-timeout-ms 250 
   
             


    -
    --merge-ready \
    --divergence-weight 80 \  
    --min-turnover 0.3 \
    --rank composite \        
    --min-divergence 0.2 \  
    --max-pools-per-token 4 \
    --max-anchor-anchor-pools 6 \
    --quality N \                 
    --topN=N \
    --select-mode triangle-closure \
      --alt-dex-min-liquidity 100000 \ 
    --include-exact-pairs mSOL/SOL,bSOL/SOL,jitoSOL/SOL,jupSOL/SOL,INF/SOL\


      node utilities/poolFetchCustom_raw.js \
        --quality 50 \
         --readyPoolInputs tradePool/_LST.json \ \
        --select-mode triangle-closure \
        --over-fetch 8 \
       pools/_liveCycle_RAW.json
//    --in tradePool/_LST.raw.json \

    --local-pool-only
    node utilities/poolFetchCustom_raw.js \

     
   
    node utilities/poolFetchCustom_raw.js \
    --local-only-pools \
     --in pools/raw_quality_stablePairs.json \
    --merge-ready tradePool/_pyUSD.curated.json,tradePools/raw_quality_candidates.json \
    --out pools/_custom_FETCH.json \
    --raw poolTrade/_XXX.fetch.json \
    --limit 300 \
    --over-fetch 5 \
    --max-fee 5 \
    --min-liquidity 500000 \
    --anchor-mints SOL 
    --include-exact-pairs SOL/JLP,SOL/RAY,JLP/USDC,RAY/USDC,USDC/USDT,USDC/SOL,USDT/SOL,USDC/USDT,pyUSD/USDC,SOL/pyUSD \
    -

    //. 


    2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc
    8dxebMPEZjYJvE5JfC9iicZt9pkATBLW1PFgRHi5wGGv
    8EzbUfvcRT1Q6RL462ekGkgqbxsPmwC5FMLQZhSPMjJ3
    uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc
    8dxebMPEZjYJvE5JfC9iicZt9pkATBLW1PFgRHi5wGGv
    HQcY5n2zP6rW74fyFEhWeBd3LnJpBcZechkvJpmdb8cx
    p53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp
    8dxebMPEZjYJvE5JfC9iicZt9pkATBLW1PFgRHi5wGGv
    8EzbUfvcRT1Q6RL462ekGkgqbxsPmwC5FMLQZhSPMjJ3
    FBy1oPG2HTDgtdp783wh6f32tMgYS656w2MgAEvq2JVB
    FBy1oPG2HTDgtdp783wh6f32tMgYS656w2MgAEvq2JVB
    8phK65jxmTPEN158xLgSr4oZvssw9SyTErpNZj3g7px4
    cvcHrD2uh2CXhmZnMHsTVWJW1qtyikVaN3MCJNaCKMh
    5cvcHrD2uh2CXhmZnMHsTVWJW1qtyikVaN3MCJNaCKMh
    5xfKkFmhzNhHKTFUkh4PJmHSWB6LpRvhJcUMKzPP6md2
    xfKkFmhzNhHKTFUkh4PJmHSWB6LpRvhJcUMKzPP6md2
*/
