'use strict';
/**
 * fetch_pools_batch.js
 * 
 * EFFICIENT Pool Fetcher - Minimizes API calls
 * 
 * KEY IMPROVEMENTS:
 * 1. Single batch fetch per DEX (no individual token lookups)
 * 2. Uses API-provided data for prices/symbols (no extra calls)
 * 3. Filters by liquidity BEFORE enrichment
 * 4. Outputs ready-to-use pool file with prices
 * 
 * Usage:
 *   node fetch_pools_batch.js --out pools/01_POOLFETCH.json [--dammv2] [--pancakeswap] [--pumpswap]
 */

/*

node utilities/fetch_pools_batch.js \
--pool-selector=poolSet_1 \
--min-liquidity 100000 \
--out pools/_pool_SET_1.json \
--max-fee-bps 10 \
--selected-only \
--dropped_anchor_without_target false


*/

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { gql, GraphQLClient } = require('graphql-request');

let fetchPumpswapFromBitquery = null;
let fetchPancakeSwapFromBitquery = null;
let extractList = null;
let mapMeteoraRaw = null;
try {
    ({
        fetchPumpswapFromBitquery,
        fetchPancakeSwapFromBitquery,
        extractList,
        mapMeteoraRaw,
    } = require('./poolFetchCustom_raw.js'));
} catch (error) {
    console.warn(`[bootstrap] optional poolFetchCustom_raw.js not loaded: ${error.message}`);
}

let DEX_DIRECT_CONFIGS = { meteora: { config: { timeout: 60_000 } } };
try {
    ({ DEX_DIRECT_CONFIGS } = require('./DEX_DIRECT_ENDPOINTS.js'));
} catch (error) {
    console.warn(`[bootstrap] optional DEX_DIRECT_ENDPOINTS.js not loaded: ${error.message}`);
}

const { Connection, PublicKey } = require('@solana/web3.js');
const DEXSCREENER_SEARCH_URL = process.env.DEXSCREENER_SEARCH_URL || 'https://api.dexscreener.com/latest/dex/search?q=';
const SHYFT_API_KEY = (process.env.SHYFT_API_KEY || 'CTWEjbpgr490fp-M').replace(/^KEY=/i, '');
const SHYFT_GRAPHQL_ENDPOINT = `https://programs.shyft.to/v0/graphql?api_key=${SHYFT_API_KEY}`;
const shyftGraphqlClient = new GraphQLClient(SHYFT_GRAPHQL_ENDPOINT, {
    method: 'POST',
    jsonSerializer: { parse: JSON.parse, stringify: JSON.stringify },
});
// ============================================================================
// KNOWN TOKENS
// ============================================================================
//JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD
const KNOWN_TOKENS = {
    'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9 },
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9 },
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { symbol: 'JitoSOL', decimals: 9 },
    '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': { symbol: 'JLP', decimals: 6 },
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', decimals: 6 },
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', decimals: 6 },
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', decimals: 5 },
    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': { symbol: 'JTO', decimals: 9 },
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'WBTC', decimals: 8 },
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': { symbol: 'cbBTC', decimals: 8 },
    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH', decimals: 6 },
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { symbol: 'WIF', decimals: 6 },
    'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL': { symbol: 'MET', decimals: 6 },
    '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': { symbol: 'PENGU', decimals: 6 },
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'WETH', decimals: 8 },
    // TRUMP real mint — NOT the WBTC address (was copy-paste error)
    '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': { symbol: 'TRUMP', decimals: 6 },
    // PUMP token (not USDT)
    'PUMPkXUA3JTLM3AJNX4RuSEWQBmh7XfNMjCBpXB5vPe': { symbol: 'PUMP', decimals: 6 },
    'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA': { symbol: 'USDS', decimals: 6 },
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': { symbol: 'USD1', decimals: 6 },
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6 },
    'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD': { symbol: 'JUPUSD', decimals: 6 },
    // Add missing mints here when you confirm them; symbols still work in pair selectors meanwhile.
    ...(process.env.USDS_MINT ? { [process.env.USDS_MINT]: { symbol: 'USDS', decimals: Number(process.env.USDS_DECIMALS || 6) } } : {}),
    ...(process.env.HYPE_MINT ? { [process.env.HYPE_MINT]: { symbol: 'HYPE', decimals: Number(process.env.HYPE_DECIMALS || 6) } } : {}),
    ...(process.env.DODGE_MINT ? { [process.env.DODGE_MINT]: { symbol: 'DODGE', decimals: Number(process.env.DODGE_DECIMALS || 6) } } : {}),
};

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const cbBTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

const TOKEN_ALIASES = {
    sol: SOL,
    wsol: SOL,
    usdc: USDC,
    usdt: USDT,
    ray: RAY,
    bonk: BONK,
    wbtc: WBTC,
    cbbtc: cbBTC,
    cbBTC: cbBTC,
    jitosol: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    jlp: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',
    jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    met: 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL',
    pengu: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
    trump: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
    weth: WETH,
    usds: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
    usd1: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
    jupusd: 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD',
    pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};

const TOKEN_SYMBOL_ALIASES = {
    cbbtc: 'cbBTC',
    cbbtcsol: 'cbBTC',
    jitosol: 'JitoSOL',
    jlp: 'JLP',
    jup: 'JUP',
    usds: 'USDS',
    hype: 'HYPE',
    dodge: 'DODGE',
    trump: 'TRUMP',
    pengu: 'PENGU',
    met: 'MET',
    ray: 'RAY',
    bonk: 'BONK',
    sol: 'SOL',
    usdc: 'USDC',
    usdt: 'USDT',
};

// Pair-based presets (legacy — kept for backward compatibility).
// Prefer POOL_ADDRESS_PRESETS below for precise per-pool selection.
const POOL_SELECTOR_PRESETS = {
    poolSet_1: ['PYUSD/USDC',
        'PYUSD/USDT', 'PYUSD/USDC', 'PYUSD/SOL', 'PYUSD/PRIME', 'PRIME/USDC',
        'USDC/USDT', 'USD1/USDC', 'USD1/USDT', 'USDS/USDT', 'USDS/USDC',
        'JUPUSD/USDC', 'JUPUSD/SOL', 'SOL/USDT', 'USDS/USDT', 'SOL/USDC'

    ]


};

// ============================================================================
// ADDRESS-BASED POOL PRESETS
// Each entry is a set of specific pool addresses to include when the named
// preset is passed to --pool-selector.  Deduplicated per group.
// Usage: node fetch_pools_batch.js --pool-selector triarb_1
// ============================================================================
const POOL_ADDRESS_PRESETS = {
    stable_hop_low_tvl: [
        'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q', // SOL/USDC whirlpool 2bps
        '4HppGTweoGQ8ZZ6UcCgwJKfi5mJD9Dqwy6htCpnbfBLW', // SOL/USDC whirlpool 4bps
        'HcoJqG325TTifs6jyWvRJ9ET4pDu12Xrt2EQKZGFmuKX', // SOL/USDT whirlpool 4bps
        '4naspcryb7VX6vdQVRt9hg852JfJL1LQuQ3oqteNZYPr', // SOL/USDT whirlpool 4bps
        '2TAuCRGtJRFUbygJHBUTMKnq5cVGGpwsmzWdoZbNusf9', // USDS/SOL dlmm 3bps
        '7sbikz4U1FRfLxvkWeLChSiE4NTCLBAacBASSBbfQhds', // JUPUSD/SOL dlmm 2bps
        '9WSSJzkkY2eK5aqx84JmHiNNh9NDjaQztgmxrmXt7o7W', // PYUSD/USDC whirlpool 2bps
        'FPPHjpjBk98pd5Z3xXQuDcrZdUdqfraCRJU8yvdT1ZKR', // USDC/USDT whirlpool 2bps
        'AxqAWNZqozhTn2pkDPgpf5kc5DeBuhLKKNWnt3dLrxdi', // USDS/USDC whirlpool 1bps
        'FqJcuLfVqhdXTT4gGFPWSNPA7NqFmb3QBDsgLjmivTXo', // USDS/USDC dlmm 1bps
        'F9SNVFmT1qxGrMnMDBp6xZNTC6AbXYzvXV4b8tez3NfN', // USD1/USDC whirlpool 1bps
        '6K2RdnHGUSAqkF1NM6xMg7pAWPHN5ufQ1uTH8N8W1EGP', // USDS/USDT dlmm 2bps
        'AGbqXEi8E5cVCxAbkKcfKXPmR9VZvsE5EKJMhNz92iR9', // USDS/USDT dlmm 0bps
        '4qpDaAUb5oUrFH7EomqoEvvTjQeh9D4svZ48sUk7JVrk', // USD1/USDT whirlpool 1bps
        '4uSa88EhUxQWT3dSd6sNL8e54GPd9J7FD5Go5t2Y8Sf', // JUPUSD/USDT dlmm 1bps
        '39GrsozbzM9Sg1U7EDnEtQ69fsVF3pmVtmV2DGDAQQJ5', // PYUSD/USDT whirlpool 1bps
        '4A7ti9gtBZEpSqyQT6MxZLd7d6sKb99tVAfV98YhfZJB', // JUPUSD/USD1 dlmm 0bps
        '8don5VCPRLUkbSBd87PwE9geQFno5v2Uwv3fY1BxLTH3', // USD1/PYUSD dlmm 0bps
        '5kpAuVbptv8YpDjfJwSgDkjiCfYY6UnJKNhvdf69cize', // SOL/PYUSD whirlpool 5bps
        '9Vh6fqJjDkqSTZ8bDXseVxGb2yQEMkEhhtte2anQCHSf', // SOL/PYUSD whirlpool 4bps

    ],
    // SOL/USDC ↔ USDC/USDT ↔ stable triangles + anchor pairs
    triarb_1: [
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc',  // WSOL/JitoSOL  clmm  triarb_4: [.8M
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U',  // JitoSOL/SOL   dlmm  
        '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc',  // WSOL/JitoSOL  clmm  $1.8M
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U',  // JitoSOL/SOL   dlmm  $2.3M
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp',  // SOL/JitoSOL   whirl $31.4M
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp',  // SOL/JitoSOL   whirl ],1.4M
        '7t6W34PAyQ8mZWtUpNBUR3pMYTQsvjsXeWy9523V5yfe', // JitoSOL/SOL     damm_v2 1bps
        '7VbZgGnf3xYnQ6Vejh5to4fm83vrbt1Sy9qVPbv9V6qu', // mSOL/SOL        damm_v2 4bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'So13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // SOL/bSOL         WHIRLPOOK 1bps
    ],
    // BONK, HYPE, PENGU vs SOL/USDC
    triarb_2: [
        'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q', // SOL/USDC whirlpool 2bps
        '2TAuCRGtJRFUbygJHBUTMKnq5cVGGpwsmzWdoZbNusf9', // USDS/SOL dlmm 3bps
        '5kpAuVbptv8YpDjfJwSgDkjiCfYY6UnJKNhvdf69cize', // SOL/PYUSD whirlpool 5bps
        '9Vh6fqJjDkqSTZ8bDXseVxGb2yQEMkEhhtte2anQCHSf', // SOL/PYUSD whirlpool 4bps
        '9WSSJzkkY2eK5aqx84JmHiNNh9NDjaQztgmxrmXt7o7W', // PYUSD/USDC whirlpool 2bps
        'FPPHjpjBk98pd5Z3xXQuDcrZdUdqfraCRJU8yvdT1ZKR', // USDC/USDT whirlpool 2bps
        'AxqAWNZqozhTn2pkDPgpf5kc5DeBuhLKKNWnt3dLrxdi', // USDS/USDC whirlpool 1bps
        '9WSSJzkkY2eK5aqx84JmHiNNh9NDjaQztgmxrmXt7o7W', // PYUSD/USDC whirlpool 2bps
        '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1',  // SOL/BONK   whirl   triarb_2: [.1M
        '81GpCm4d13y8TozYtThabuSCLQN2o3bbrvDogXFPn8sA',  // HYPE/SOL   dlmm    triarb_2: [.5M
        '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1',  // SOL/BONK   whirl   $1.1M
        '81GpCm4d13y8TozYtThabuSCLQN2o3bbrvDogXFPn8sA',  // HYPE/SOL   dlmm    $1.5M
        '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',  // WSOL/RAY   clmm    triarb_3: [.2M
        '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',  // RAY/USDC   cpmm    ],.6M
        'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',  // RAY/WSOL   cpmm    $2.3M
        'GmBaW4ARThT3uVZamYx7xqz6PLcduAZgLQ6EJsbYTXZX', // RAY/SOL         dlmm   0bps
        '27ZbVdmoUhG639CfqG6kW8a4VXZeGBi8Dd4HUXjVDxeS', // SOL/RAY         whirl  4bps
        '8w2Qb9ywKpR9Pkk1zQMnBNVwZTh3sx61FAbZUB8QWJE5', // BONK/SOL        dlmm   0bps
        '4VG8VFNo3EXiTA75mhh48qv55S6m3VA2uTQCzEt8kczb', // SOL/BONK        whirl  4bps
    ],




    // cbBTC, WBTC, RAY triangles
    triarb_3: [
        'CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN',  // SOL/cbBTC  whirl   triarb_3: [0.5M
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM',  // cbBTC/USDC whirl   $5.8M
        '7ubS3GccjhQY99AYNKXjNJqnXjaokEdfdV915xnCb96r',   // cbBTC/USDC dlmm    triarb_3: [.2M
        '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72',  // cbBTC/WBTC whirl   triarb_3: [.3M
        'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA',   // SOL/WBTC   whirl   $5.3M

        '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',  // RAY/USDC   cpmm    ],.6M
        'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',  // RAY/WSOL   cpmm    
        'CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN',  // SOL/cbBTC  whirl   $10.5M
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM',  // cbBTC/USDC whirl   $5.8M
        '7ubS3GccjhQY99AYNKXjNJqnXjaokEdfdV915xnCb96r',   // cbBTC/USDC dlmm    $1.2M
        '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72',  // cbBTC/WBTC whirl   $1.3M
        'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA',   // SOL/WBTC   whirl   $5.3M
        '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',  // WSOL/RAY   clmm    $1.2M
        '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',  // RAY/USDC   cpmm    $3.6M
        'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',  // RAY/WSOL   cpmm    $2.3M
        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    $10M
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    $3.3M
        'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    $1.9M

        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    triarb_3: [0M
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    ],.3M
        'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    triarb_3: [.9M
        '92R37PPY8phqxEk4YJrZ4U5nbcbv8P5EsCgK5j5HREfG', // cbBTC/WBTC      damm_v2 1bps
        '5NQTw1WqVEt6wP1LmohsrYDyJp2NDipdv6eULVNByXMb', // USDC/WBTC       damm_v2 4bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    ],
    // JitoSOL, MPLX, JLP triangles
    triarb_4: [
        '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc',  // WSOL/JitoSOL  clmm  triarb_4: [.8M
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U',  // JitoSOL/SOL   dlmm  
        '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc',  // WSOL/JitoSOL  clmm  $1.8M
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U',  // JitoSOL/SOL   dlmm  $2.3M
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp',  // SOL/JitoSOL   whirl $31.4M
        '5hWJUNTtEtKmKgDXpthJXXRRmJrz5vJ7uJzrUNVdrwLg',  // USDC/JitoSOL  whirl $1.2M
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb',  // JLP/USDC       whirl $10.2M
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd',  // SOL/JLP        whirl $3.7M
        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    $10M
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    $3.3M
        'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    $1.9M 
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp',  // SOL/JitoSOL   whirl ],1.4M
        '5hWJUNTtEtKmKgDXpthJXXRRmJrz5vJ7uJzrUNVdrwLg',  // USDC/JitoSOL  whirl triarb_4: [.2M
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb',  // JLP/USDC       whirl triarb_4: [0.2M
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd',  // SOL/JLP        whirl ],.7M
        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    triarb_4: [0M
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    ],.3M
        'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    triarb_4: [.9M
        '7t6W34PAyQ8mZWtUpNBUR3pMYTQsvjsXeWy9523V5yfe', // JitoSOL/SOL     damm_v2 1bps
        'GL5ZUM7K8RQur1GD8bbsWb41cytCdBDN76xeqwPqsQAN', // JitoSOL/USDC    damm_v2 1bps
        '7fCwnvNEP2frZrmQDZRUWnfGxtryLgxNHbQ3hB3wDKL9', // JLP/USDC        damm_v2 1bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
        '7VbZgGnf3xYnQ6Vejh5to4fm83vrbt1Sy9qVPbv9V6qu', // mSOL/SOL        damm_v2 4bps
    ],
    triarb_5: [
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp',     //'SOL/JitoSOL'
        '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc',     //'SOL/JitoSOL'
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U',      //'SOL/JitoSOL'
        'BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU',     // 'USDC/USDT'
        '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4',     // 'USDC/USDT'
        '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF',     //SOL/USDT
        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    triarb_5: [0M
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    ],.3M
        'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    triarb_5: [.9M
        '32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG', // USDC/USDT       damm_v2 1bps
        '7t6W34PAyQ8mZWtUpNBUR3pMYTQsvjsXeWy9523V5yfe', // JitoSOL/SOL     damm_v2 1bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    ],
    triarb_6: [
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM',        //cbBTC/USDC
        'CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN',  // SOL/cbBTC  whirl   triarb_6: [0.5M
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM',  // cbBTC/USDC whirl   $5.8M
        '7ubS3GccjhQY99AYNKXjNJqnXjaokEdfdV915xnCb96r',   // cbBTC/USDC dlmm    triarb_6: [.2M
        '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72',  // cbBTC/WBTC whirl   triarb_6: [.3M
        'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA',   // SOL/WBTC   whirl   $5.3M
        '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',         //SOL/USDC
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',         //SOL/USDC
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',          //SOL/USDC
        '92R37PPY8phqxEk4YJrZ4U5nbcbv8P5EsCgK5j5HREfG', // cbBTC/WBTC      damm_v2 1bps
        '5NQTw1WqVEt6wP1LmohsrYDyJp2NDipdv6eULVNByXMb', // USDC/WBTC       damm_v2 4bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    ],
    // SOL/RAY, SOL/BONK, SOL/JLP, SOL/cbBTC + USDC anchors — lowest fee per pair
    triarb_7: [
        'GmBaW4ARThT3uVZamYx7xqz6PLcduAZgLQ6EJsbYTXZX', // RAY/SOL         dlmm   0bps
        '27ZbVdmoUhG639CfqG6kW8a4VXZeGBi8Dd4HUXjVDxeS', // SOL/RAY         whirl  4bps
        '8w2Qb9ywKpR9Pkk1zQMnBNVwZTh3sx61FAbZUB8QWJE5', // BONK/SOL        dlmm   0bps
        '4VG8VFNo3EXiTA75mhh48qv55S6m3VA2uTQCzEt8kczb', // SOL/BONK        whirl  4bps
        'G7ixPyiyNeggVf1VanSetFMNbVuVCPtimJmd9axfQqng',  // JLP/SOL         dlmm   0bps
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd', // SOL/JLP         whirl  4bps
        '9myDy5TqPkfuQHPJ39ExWjYNUHwn1bxw7AmAWmzVZpeq', // SOL/cbBTC       dlmm   0bps
        'B4bn8eSGUWsETHdKj2uXUHDLW2s2zeRWrKZofBWxCMAm', // SOL/cbBTC       whirl  1bps
        'ANqNJVfye2XTRCvk58BnrqwUaV3uLvrCVifXdQCu7Sip', // RAY/USDC        dlmm   2bps
        '4N5yKVvzKB7KHRr22ugwMEMeiRSH8ATJwPb1FDWh8Xjw', // RAY/USDC        whirl  5bps
        'DbTk2SNKWxu9TJbPzmK9HcQCAmraBCFb5VMo8Svwh34z', // JLP/USDC        dlmm   0bps
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb', // JLP/USDC        whirl  2bps
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', // cbBTC/USDC      whirl  4bps
        'ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq', // USDC/USDT       dlmm   0bps
        '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4', // USDC/USDT       whirl  1bps
        '73YvegLbkjjQaKWKPzvZTXuHyUAE8Wz95HaYUCW4Ehev', // USDC/SOL        dlmm   0bps
        '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d', // SOL/USDC        whirl  1bps
        'D2oBwUqn2yJ4ubVCYCBea5XqHAAPGh1R2Mru9qoZ5hbB', // USDT/SOL        dlmm   0bps
        'BmXVhzBHTawt5stWKBtFdjM8n33G5RoUDECE5FrRvayq', // SOL/USDT        whirl  1bps
        '32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG', // USDC/USDT       damm_v2 1bps
        'BBopn8DL1waSgvnHqgoYEnfiu7FajsPUro9yE9tUSxQh', // BONK/USDC       damm_v2 1bps
        '7fCwnvNEP2frZrmQDZRUWnfGxtryLgxNHbQ3hB3wDKL9', // JLP/USDC        damm_v2 1bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    ],
    // SOL/JLP, SOL/JitoSOL, SOL/JUP, cbBTC — lowest fee per pair
    triarb_8: [
        'G7ixPyiyNeggVf1VanSetFMNbVuVCPtimJmd9axfQqng',  // JLP/SOL         dlmm   0bps
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd', // SOL/JLP         whirl  4bps
        'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U', // JitoSOL/SOL     dlmm   0bps
        'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp', // SOL/JitoSOL     whirl  1bps
        'FpjYwNjCStVE2Rvk9yVZsV46YwgNTFjp7ktJUDcZdyyk', // JUP/SOL         dlmm   0bps
        'DkVN7RKTNjSSER5oyurf3vddQU2ZneSCYwXvpErvTCFA', // JUP/SOL         whirl  1bps
        '6aMDsfmuQ71xFM983Lu8pTDiaw7NUXEhKxnnzi1RPML4', // JitoSOL/USDC    dlmm   0bps
        '2JZuSCbeVDmkVi4RLADTKAaZG8CGkXNKiQwQHmk56rFX', // USDC/JitoSOL    whirl  4bps
        'HMCXMLDoNFky1PgqiyU47D7J3TRNyqeynhBX8fupp4Q8', // JUP/USDC        whirl  0bps
        '7HR1ouGwPsCyPScUCx4WJCPyktXMoLitrGkLczd7Vabx', // JUP/USDC        dlmm   0bps
        'DbTk2SNKWxu9TJbPzmK9HcQCAmraBCFb5VMo8Svwh34z', // JLP/USDC        dlmm   0bps
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb', // JLP/USDC        whirl  2bps
        '73YvegLbkjjQaKWKPzvZTXuHyUAE8Wz95HaYUCW4Ehev', // USDC/SOL        dlmm   0bps
        '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d', // SOL/USDC        whirl  1bps
        '9myDy5TqPkfuQHPJ39ExWjYNUHwn1bxw7AmAWmzVZpeq', // SOL/cbBTC       dlmm   0bps
        'B4bn8eSGUWsETHdKj2uXUHDLW2s2zeRWrKZofBWxCMAm', // SOL/cbBTC       whirl  1bps
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', // cbBTC/USDC      whirl  4bps
        'D2oBwUqn2yJ4ubVCYCBea5XqHAAPGh1R2Mru9qoZ5hbB', // USDT/SOL        dlmm   0bps
        'BmXVhzBHTawt5stWKBtFdjM8n33G5RoUDECE5FrRvayq', // SOL/USDT        whirl  1bps
        '32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG', // USDC/USDT       damm_v2 1bps
        '7t6W34PAyQ8mZWtUpNBUR3pMYTQsvjsXeWy9523V5yfe', // JitoSOL/SOL     damm_v2 1bps
        'GL5ZUM7K8RQur1GD8bbsWb41cytCdBDN76xeqwPqsQAN', // JitoSOL/USDC    damm_v2 1bps
        '7fCwnvNEP2frZrmQDZRUWnfGxtryLgxNHbQ3hB3wDKL9', // JLP/USDC        damm_v2 1bps
        '8ruDME2JQX19m8wX6DHxhYA5qg5davvNpYmBJDCDo6i5', // JUP/SOL         damm_v2 1bps
        'EhiFf6RLKEzB1BFB2V1UDpaz1UR4YVpKNcuonKdbvJJf', // JUP/USDC        damm_v2 4bps
        'GD7LRGJeGWhbV1623vkonepmgmckKyokKBsY4dJpSivE', // JitoSOL/JUP     damm_v2 4bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    ],
    // SOL/PENGU, INF, TRUMP, HYPE, PUMP — lowest fee per pair (PUMP missing: needs PumpSwap DEX)
    triarb_9: [
        'FcDW6XqdEtruoBscYdCWdiwGkr7FXByLobLp13MEMiXm', // PENGU/SOL       dlmm   0bps
        '2veBbCPv4uqpEzR6R3MKQJEaRdXNWNYPFmLx7DDYksbg', // SOL/PENGU       whirl  2bps
        '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm   0bps
        'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl  2bps
        'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm   0bps
        'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl  1bps
        'A8JJYd441do7SUDMWJPM2YSpvex9weXLr2YBuUnD9Cqg',  // TRUMP/SOL       dlmm   0bps
        'Ckp1kwZqosaLU1h3zWtuaMBubyWM7LX3cxYezRVin7p2', // SOL/TRUMP       whirl  5bps
        '9RrL3knuK8WCVnt2dBYDXGkLFN8ei6Uk6PbdLpq1FU1b', // USDC/TRUMP      dlmm   0bps
        '3F5onEzLdRdbT3F7gdSh8AnTBmtyxiRHvjxYcbtBRDTe', // TRUMP/USDC      whirl  8bps
        '6T5xtoGv62GuYRdGPPiEszt8E7PnqC8bH5wLSFedJczi', // HYPE/SOL        dlmm   1bps
        'FJXwta8NxkZDfeYL6DdkiKXbRs15FLwC4ZXpUPMy3eur', // SOL/HYPE        whirl  16bps
        'CuHKEQzD6J8i9Ruqn95WCugzyZo7gPSr6sEGKhC1x75A', // HYPE/USDC       dlmm   0bps
        '5azLWnTEGdETPwjiXb55x6MUuqpK9QQAazNqihCxtcgq', // HYPE/USDC       whirl  16bps
        '3AJriMfHP8m8Eox8skUpobdC2FG6ZEFrrRXWbvXEMZ8U',  // PENGU/USDC      dlmm   0bps
        '8fPTq5Qqb2bu6UWvEXEAh4gt8BvmbpR6becn6w8QC6sn', // PENGU/USDC        //    
        '73YvegLbkjjQaKWKPzvZTXuHyUAE8Wz95HaYUCW4Ehev', // USDC/SOL        dlmm   0bps
        '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d', // SOL/USDC       whirl  1bps
        '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
        '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    ],.3M
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
    ],
    // DAMM v2 low-fee pools (<=10bps) across token universe — 3rd venue for divergence
    dammv2_low: [
        '32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG', // USDC/USDT       damm_v2 1bps
        'BBopn8DL1waSgvnHqgoYEnfiu7FajsPUro9yE9tUSxQh', // BONK/USDC       damm_v2 1bps
        '7t6W34PAyQ8mZWtUpNBUR3pMYTQsvjsXeWy9523V5yfe', // JitoSOL/SOL     damm_v2 1bps
        'GL5ZUM7K8RQur1GD8bbsWb41cytCdBDN76xeqwPqsQAN', // JitoSOL/USDC    damm_v2 1bps
        '7fCwnvNEP2frZrmQDZRUWnfGxtryLgxNHbQ3hB3wDKL9', // JLP/USDC        damm_v2 1bps
        '8ruDME2JQX19m8wX6DHxhYA5qg5davvNpYmBJDCDo6i5', // JUP/SOL         damm_v2 1bps
        '92R37PPY8phqxEk4YJrZ4U5nbcbv8P5EsCgK5j5HREfG', // cbBTC/WBTC      damm_v2 1bps
        'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
        'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
        '5NQTw1WqVEt6wP1LmohsrYDyJp2NDipdv6eULVNByXMb', // USDC/WBTC       damm_v2 4bps
        'GD7LRGJeGWhbV1623vkonepmgmckKyokKBsY4dJpSivE', // JitoSOL/JUP     damm_v2 4bps
        '4LvKWPL4r6mScJrJZk7kzJGCb4AgiJpnpoHY9tafbt3x', // JLP/USDC        damm_v2 4bps
        'EhiFf6RLKEzB1BFB2V1UDpaz1UR4YVpKNcuonKdbvJJf', // JUP/USDC        damm_v2 4bps
        '7VbZgGnf3xYnQ6Vejh5to4fm83vrbt1Sy9qVPbv9V6qu', // mSOL/SOL        damm_v2 4bps
        'BYZwJbrPWHCbaN6ju6RJTwCtA7cYQVjY57HCtxv1PgfH', // INF/SOL         damm_v2 4bps
        'DHYg5pkguVSwhA3DuktMwCFq3Q1ZydAMLAunNioYqhQ2', // INF/USDC        damm_v2 4bps
        '8jMdhEx1Ex1Lmx9HckvBHdQMLD9aRaHjqZg9hvuFf4Dy', // MET/JUP         damm_v2 4bps
        'DTo6aFe8rFcAi6gXPwnmu2HV6wgsKJDzYGuRvLkQDtrP', // SOL/JUP         damm_v2 10bps
    ],
};
POOL_ADDRESS_PRESETS.stable_hop = POOL_ADDRESS_PRESETS.stable_hop_low_tvl;
/*
    'DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU',  // PENGU/USDC dlmm    ],.1M
    '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // WSOL/USDC  cpmm    triarb_2: [0M
    '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // WSOL/USDC  clmm    $4.9M
    '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',  // SOL/USDC   dlmm    ],.3M
    'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', // SOL/USDC   dlmm    triarb_2: [.9M
    'BBopn8DL1waSgvnHqgoYEnfiu7FajsPUro9yE9tUSxQh', // BONK/USDC       damm_v2 1bps
    'Ep1bDQjMuEhqkz5JBBBWTmbhm79WiPAH3fdH7tRARJ37', // INF/SOL         dlmm    0bps
    '7TjyzAkGojG4ChmpQCouov7ei7LeSXQT5GgnUfANFApV', // INF/USDC        dlmm    0bps
    'DxD41srN8Xk9QfYjdNXF9tTnP6qQxeF2bZF8s1eN62Pe', // SOL/INF         whirl   1bps
    'E1Ddo9fV2Jwu6wadhDYZV6gAf8hhywTojVfBto3EJtVQ', // INF/USDC        whirl   2bps
    'AaQWUw1vgQu3dfSjiSNEBJNmfWbxohFH5A1xxhdMyoGP', // INF/SOL         damm_v2 1bps
    'FtpMhdF3h4D3o2D3mUruqLQPXm5BbSiuHoLeDUpfcBzh', // INF/USDC        damm_v2 1bps
    */

const QUALITY_CONFIG = {
    MIN_TVL_USD: Math.max(0, Number(process.env.QUALITY_MIN_TVL_USD || 200000)),
    MAX_FEE_BPS: Math.max(1, Number(process.env.QUALITY_MAX_FEE_BPS || 5)),
    REQUIRE_PRICE_OR_RESERVES: !['0', 'false', 'no', 'off'].includes(String(process.env.QUALITY_REQUIRE_PRICE_OR_RESERVES || 'true').toLowerCase()),
    REQUIRE_KNOWN_DEX: !['0', 'false', 'no', 'off'].includes(String(process.env.QUALITY_REQUIRE_KNOWN_DEX || 'true').toLowerCase()),
};

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
    MAX_POOLS_PER_DEX: 300,     // Max pools per DEX type
    // Filtering
    MIN_LIQUIDITY_USD: 200000,  // $1000k minimum
    POOLS_PER_TYPE: 50,         // Max pools per DEX type
    REQUIRE_SOL_OR_USDC: true,  // Filter for triangle potential
    TIMEOUT: 30000,
    DLMM_BIN_WALK: 4,            // Default bins to walk when quoting
    outputFile: './poolSelection/_RAW.set.json',
    DAMM_V2_MIN_LIQUIDITY_USD: Math.max(30, Number(process.env.DAMM_V2_MIN_LIQUIDITY_USD || 300_000)),
    DAMM_V2_PAGE_SIZE: 30,
    // Keep Pancake/Pump defaults permissive at fetch time; downstream route
    // scoring can reject thin pools after we know the graph shape.
    PANCAKESWAP_MIN_LIQUIDITY_USD: Math.max(30, Number(process.env.PANCAKESWAP_MIN_LIQUIDITY_USD || 300_000)),
    PANCAKESWAP_LIMIT: Math.max(30, Number(process.env.PANCAKESWAP_BITQUERY_LIMIT || 30)),
    PANCAKE_SAMPLE_FILES: (process.env.PANCAKE_SAMPLE_FILES || 'pools/pancake_pairs.json,pools/merged_pancake.json,pools/bitquery_pancake_selected.json')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    // PumpSwap pools are often small/new; default to discovery mode.
    PUMPSWAP_MIN_LIQUIDITY_USD: Math.max(0, Number(process.env.PUMPSWAP_MIN_LIQUIDITY_USD || 300_000)),
    PUMPSWAP_LIMIT: Math.max(100, Number(process.env.PUMPSWAP_BITQUERY_LIMIT || 1000)),
};

// ============================================================================
// RPC ROTATOR  (used by any on-chain enrichment step added later)
// ============================================================================

const RPC_ENDPOINTS = (
    process.env.RPC_ENDPOINTS ||
    process.env.SOLANA_RPC_URLS ||
    process.env.SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com'
)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

let _rpcIndex = 0;
function nextRpc() {
    const url = RPC_ENDPOINTS[_rpcIndex % RPC_ENDPOINTS.length];
    _rpcIndex += 1;
    return url;
}

// Wrap any async fetch with a wall-clock deadline so one slow DEX
// cannot block the entire parallel fetch.
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}



const short = (s) => s ? `${s.slice(0, 6)}..${s.slice(-4)}` : '?';

function getSymbol(mint) {
    return KNOWN_TOKENS[mint]?.symbol || short(mint);
}

function getDecimals(mint, fallback = 6) {
    return KNOWN_TOKENS[mint]?.decimals || fallback;
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function amountToAtomic(value, decimals) {
    if (value === null || value === undefined || value === '') return '0';
    const text = String(value).trim();
    if (!text) return '0';
    if (!text.includes('.') && text.length > Math.max(8, Number(decimals || 0) + 3)) return text;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(Math.floor(n * Math.pow(10, Number(decimals || 0))));
}

function poolTvlUsd(pool = {}) {
    return toNumber(pool.tvlUsd ?? pool.tvl ?? pool.liquidityUsd ?? pool.liquidity, 0);
}

function hasPositiveReserves(pool = {}) {
    try {
        return BigInt(String(pool.xReserve || pool.reserves?.x || '0').split('.')[0] || '0') > 0n
            && BigInt(String(pool.yReserve || pool.reserves?.y || '0').split('.')[0] || '0') > 0n;
    } catch {
        return false;
    }
}

function parseCsvList(value) {
    if (Array.isArray(value)) return value.flatMap(parseCsvList);
    return String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}


function safeExtractList(data) {
    if (typeof extractList === 'function') return extractList(data);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.data?.data)) return data.data.data;
    if (Array.isArray(data?.pools)) return data.pools;
    if (Array.isArray(data?.pairs)) return data.pairs;
    if (Array.isArray(data?.results)) return data.results;
    return [];
}

function inferSymbol(symbol, mint, fallbackField) {
    return symbol || fallbackField || getSymbol(mint);
}

function inferDecimals(value, mint, fallback = 6) {
    return Number(value ?? getDecimals(mint, fallback));
}

function fallbackMapMeteoraRaw(pool = {}, sourceUrl = '') {
    if (typeof mapMeteoraRaw === 'function') return mapMeteoraRaw(pool, sourceUrl);

    const baseMint = pool.token_x_mint || pool.tokenXMint || pool.baseMint || pool.mint_x || pool.mintX || pool.mintA || pool.token_x?.mint || pool.token_x?.address;
    const quoteMint = pool.token_y_mint || pool.tokenYMint || pool.quoteMint || pool.mint_y || pool.mintY || pool.mintB || pool.token_y?.mint || pool.token_y?.address;
    if (!baseMint || !quoteMint) return null;

    const baseDecimals = inferDecimals(pool.token_x_decimal || pool.tokenXDecimals || pool.baseDecimals || pool.token_x?.decimals, baseMint, 9);
    const quoteDecimals = inferDecimals(pool.token_y_decimal || pool.tokenYDecimals || pool.quoteDecimals || pool.token_y?.decimals, quoteMint, 6);
    const tvlUsd = toNumber(pool.tvl ?? pool.liquidity ?? pool.tvlUsd ?? pool.liquidityUsd, 0);
    const feeBps = Number(pool.trade_fee_bps ?? pool.fee_bps ?? pool.feeBps ?? 30);

    return {
        poolAddress: pool.address || pool.poolAddress || pool.id,
        address: pool.address || pool.poolAddress || pool.id,
        dex: 'meteora',
        type: 'dlmm',
        mathType: 'dlmm',
        dexType: 'METEORA_DLMM',
        baseMint,
        quoteMint,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        baseDecimals,
        quoteDecimals,
        tokenXDecimals: baseDecimals,
        tokenYDecimals: quoteDecimals,
        baseSymbol: inferSymbol(pool.baseSymbol, baseMint, pool.token_x_symbol || pool.tokenXSymbol || pool.token_x?.symbol || pool.name?.split('-')?.[0]),
        quoteSymbol: inferSymbol(pool.quoteSymbol, quoteMint, pool.token_y_symbol || pool.tokenYSymbol || pool.token_y?.symbol || pool.name?.split('-')?.[1]),
        xReserve: String(pool.reserve_x ?? pool.xReserve ?? pool.reserves?.x ?? '0'),
        yReserve: String(pool.reserve_y ?? pool.yReserve ?? pool.reserves?.y ?? '0'),
        reserves: {
            x: String(pool.reserve_x ?? pool.xReserve ?? pool.reserves?.x ?? '0'),
            y: String(pool.reserve_y ?? pool.yReserve ?? pool.reserves?.y ?? '0'),
        },
        currentPrice: toNumber(pool.current_price ?? pool.currentPrice ?? pool.mid_price ?? pool.midPrice ?? pool.price, 0),
        midPrice: toNumber(pool.mid_price ?? pool.midPrice ?? pool.current_price ?? pool.currentPrice ?? pool.price, 0),
        price: toNumber(pool.price ?? pool.mid_price ?? pool.midPrice ?? pool.current_price ?? pool.currentPrice, 0),
        liquidity: tvlUsd,
        tvl: tvlUsd,
        tvlUsd,
        liquidityUsd: tvlUsd,
        feeBps,
        feeRate: Number(pool.feeRate ?? (feeBps / 10_000)),
        quoteSource: pool.quoteSource || 'api',
        reserveSource: pool.reserveSource || sourceUrl || 'meteora-dlmm-api',
    };
}

function readPoolSelectorFile(file) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(payload)) return payload.map((item) => String(item || '').trim()).filter(Boolean);
    if (Array.isArray(payload.pairs)) return payload.pairs.map((item) => String(item || '').trim()).filter(Boolean);
    if (Array.isArray(payload.poolSelector)) return payload.poolSelector.map((item) => String(item || '').trim()).filter(Boolean);
    if (typeof payload.poolSelector === 'string') return parseCsvList(payload.poolSelector);
    if (typeof payload.csv === 'string') return parseCsvList(payload.csv);
    return [];
}

function buildDexScreenerSearchQueries(options = {}) {
    const queries = new Set(['pumpswap solana']);
    for (const pair of options.pairSelectors || []) {
        if (pair?.base?.label && pair?.quote?.label) {
            queries.add(`${pair.base.label} ${pair.quote.label} solana`);
            queries.add(`${pair.base.label}/${pair.quote.label} solana`);
        }
    }
    for (const mint of options.selectedPools || []) {
        const symbol = getSymbol(mint);
        if (symbol && symbol !== short(mint)) queries.add(`${symbol} solana`);
    }
    for (const mint of options.against || []) {
        const symbol = getSymbol(mint);
        if (symbol && symbol !== short(mint)) queries.add(`${symbol} solana`);
    }
    return Array.from(queries).slice(0, 12);
}

function resolveMintSelector(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    return TOKEN_ALIASES[text.toLowerCase()] || text;
}

function parseSelectedSet(value) {
    const [targets = '', anchors = ''] = String(value || '').split(':');
    return {
        selectedPools: parseCsvList(targets).map(resolveMintSelector).filter(Boolean),
        against: parseCsvList(anchors).map(resolveMintSelector).filter(Boolean),
    };
}

function readSelectedPoolsFile(file) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(payload)) return payload.map(resolveMintSelector).filter(Boolean);
    if (Array.isArray(payload.selectedTargets)) {
        return payload.selectedTargets
            .map((row) => resolveMintSelector(row?.mint || row?.address || row))
            .filter(Boolean);
    }
    if (Array.isArray(payload.selectedPools)) return payload.selectedPools.map(resolveMintSelector).filter(Boolean);
    if (typeof payload.selectedCsv === 'string') return parseCsvList(payload.selectedCsv).map(resolveMintSelector).filter(Boolean);
    if (typeof payload.csv === 'string') return parseCsvList(payload.csv).map(resolveMintSelector).filter(Boolean);
    return [];
}

function poolIdOf(pool = {}) {
    return String(pool.poolAddress || pool.address || pool.id || '').trim();
}

const BLOCKED_POOLS = [
    'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    'CdNGRJDzWpX8rWzoumvDkkVwHUczaxqEYT9iBJfBKRZ'
]; // poisonPool

const STABLE_MINTS = new Set([
    USDC, USDT,
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',   // USD1
    'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',  // pyUSD
    'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', // JUP/USD
    '2o4g6Z7k1v5x3X8y9L1m2N3P4Q5R6S7T8U9V0W1X2Y3Z', // Example stable mint
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


function normalizeTokenLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const alias = TOKEN_SYMBOL_ALIASES[raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()];
    if (alias) return alias;
    return raw;
}

function resolveTokenSelector(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const mint = TOKEN_ALIASES[raw.toLowerCase()];
    if (mint) return { type: 'mint', value: mint, label: getSymbol(mint) };
    const normalized = normalizeTokenLabel(raw);
    const normalizedMint = TOKEN_ALIASES[normalized.toLowerCase()];
    if (normalizedMint) return { type: 'mint', value: normalizedMint, label: getSymbol(normalizedMint) };
    return { type: 'symbol', value: normalized.toUpperCase(), label: normalized };
}

function parsePairSpec(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const cleaned = raw.replace(/\s+/g, '');
    const slashPair = cleaned.includes('/') ? cleaned : cleaned.replace(/^(USDT)(SOL)$/i, '$1/$2');
    const [left, right] = slashPair.split('/');
    if (!left || !right) return null;
    const base = resolveTokenSelector(left);
    const quote = resolveTokenSelector(right);
    if (!base || !quote) return null;
    return {
        key: `${base.label}/${quote.label}`.toUpperCase(),
        raw,
        base,
        quote,
    };
}

// Returns true if a string looks like a Solana base58 pool address (32–44 chars)
function looksLikePoolAddress(s) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || '').trim());
}

function expandPoolSelectorInput(value) {
    const requested = parseCsvList(value).map((item) => String(item || '').trim()).filter(Boolean);
    const selectors = [];
    for (const item of requested) {
        // Address presets take priority (new system)
        const addrPreset = POOL_ADDRESS_PRESETS[item];
        if (addrPreset) {
            for (const addr of addrPreset) {
                selectors.push({ type: 'address', value: addr.trim(), raw: item });
            }
            continue;
        }
        // Legacy pair presets
        const pairPreset = POOL_SELECTOR_PRESETS[item];
        if (pairPreset) {
            for (const spec of pairPreset) {
                const parsed = parsePairSpec(spec);
                if (parsed) selectors.push(parsed);
            }
            continue;
        }
        // Bare pool address passed directly on CLI
        if (looksLikePoolAddress(item)) {
            selectors.push({ type: 'address', value: item, raw: item });
            continue;
        }
        // Fall through: treat as a pair spec
        const parsed = parsePairSpec(item);
        if (parsed) selectors.push(parsed);
    }
    return selectors;
}

function tokenSelectorMatches(selector, mint, symbol) {
    if (!selector) return false;
    if (selector.type === 'mint') return mint === selector.value;
    return String(symbol || '').trim().toUpperCase() === String(selector.value || '').trim().toUpperCase();
}

function poolMatchesPairSelector(pool = {}, pairSelectors = []) {
    if (!pairSelectors.length) return true;
    const poolAddr = String(pool.poolAddress || pool.address || '').trim();
    const baseMint = pool.baseMint || pool.tokenXMint;
    const quoteMint = pool.quoteMint || pool.tokenYMint;
    const baseSymbol = pool.baseSymbol || getSymbol(baseMint);
    const quoteSymbol = pool.quoteSymbol || getSymbol(quoteMint);

    return pairSelectors.some((sel) => {
        // Address-type: exact pool address match
        if (sel.type === 'address') return poolAddr === sel.value;
        // Pair-type: bidirectional token pair match
        return (
            tokenSelectorMatches(sel.base, baseMint, baseSymbol)
            && tokenSelectorMatches(sel.quote, quoteMint, quoteSymbol)
        ) || (
                tokenSelectorMatches(sel.base, quoteMint, quoteSymbol)
                && tokenSelectorMatches(sel.quote, baseMint, baseSymbol)
            );
    });
}

function qualityReasons(pool = {}, options = {}) {
    const reasons = [];
    const minTvlUsd = Math.max(0, Number(options.minTvlUsd ?? QUALITY_CONFIG.MIN_TVL_USD));
    const maxFeeBps = Math.max(1, Number(options.maxFeeBps ?? QUALITY_CONFIG.MAX_FEE_BPS));
    const requirePriceOrReserves = options.requirePriceOrReserves ?? QUALITY_CONFIG.REQUIRE_PRICE_OR_RESERVES;
    const requireKnownDex = options.requireKnownDex ?? QUALITY_CONFIG.REQUIRE_KNOWN_DEX;

    const poolId = String(pool.poolAddress || pool.address || '').trim();
    const tvlUsd = poolTvlUsd(pool);
    const feeBps = Number(pool.feeBps ?? 0);
    const price = toNumber(pool.currentPrice ?? pool.midPrice ?? pool.price, 0);
    const reservesOk = hasPositiveReserves(pool);
    const dexLabel = poolDexLabel(pool);

    if (!poolId) reasons.push('missing_pool_address');
    if (!(pool.baseMint || pool.tokenXMint || pool.baseSymbol) || !(pool.quoteMint || pool.tokenYMint || pool.quoteSymbol)) {
        reasons.push('missing_pair_tokens');
    }
    if (tvlUsd < minTvlUsd) reasons.push('low_tvl');
    if (requirePriceOrReserves && !reservesOk && price <= 0) reasons.push('no_price_or_reserves');
    if (feeBps > 0 && feeBps > maxFeeBps) reasons.push('fee_too_high');
    if (requireKnownDex && (!dexLabel || dexLabel === 'unknown')) reasons.push('unknown_dex');

    return reasons;
}

function scorePoolQuality(pool = {}) {
    const tvlUsd = poolTvlUsd(pool);
    const reservesBoost = hasPositiveReserves(pool) ? 50 : 0;
    const priceBoost = toNumber(pool.currentPrice ?? pool.midPrice ?? pool.price, 0) > 0 ? 20 : 0;
    const feePenalty = Math.min(40, Math.max(0, Number(pool.feeBps ?? 0) - 30) / 5);
    return Math.log10(Math.max(1, tvlUsd)) * 20 + reservesBoost + priceBoost - feePenalty;
}

function filterQualityPools(pools = [], options = {}) {
    return (pools || [])
        .filter((pool) => qualityReasons(pool, options).length === 0)
        .sort((a, b) => scorePoolQuality(b) - scorePoolQuality(a));
}

function parseCliArgs(argv = []) {
    const out = {
        outputFile: CONFIG.outputFile,
        outputFileExplicit: true,
        selectedPools: [],
        against: [],
        selectedOnly: true,
        diagnosticsOut: '',
        includeDammV2: false,
        includePancakeswap: false,
        includePumpswap: false,
        excludePools: [],
        poolSelector: 'pool_set_1',
        pairSelectors: [],
        pairSelectorOnly: false,
        qualityOnly: true,
        qualityMinLiquidity: QUALITY_CONFIG.MIN_TVL_USD,
        qualityMaxFeeBps: QUALITY_CONFIG.MAX_FEE_BPS,
        planOnly: false,
        routeSpeedTest: false,
        speedRoutesFile: 'reports/06_RESULT_DATA.json',
        speedPoolSource: 'pools/03_CIRCUIT.json',
        speedTopRoutes: 10,
        speedMaxPools: 10,
        qualityOnlyExplicit: true,
    };

    const blankValues = new Set(['', 'true', 'undefined', 'null']);
    const hasFlagValue = (value) => !blankValues.has(String(value ?? '').trim().toLowerCase());
    const warnBlank = (key) => console.warn(`[args] Ignoring ${key}: missing value; keeping existing/default value.`);

    const setValue = (key, value) => {
        const normalized = String(key || '').replace(/^--?/, '').toLowerCase();
        if (['out', 'output'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            out.outputFile = value;
            out.outputFileExplicit = true;
        }
        else if (['selectedpools', 'selected-pools', 'targets', 'targetmints', 'target-mints'].includes(normalized)) {
            out.selectedPools = parseCsvList(value).map(resolveMintSelector).filter(Boolean);
            out.selectedOnly = out.selectedPools.length > 0;
        } else if (['selectedpoolsfile', 'selected-pools-file', 'targets-file', 'target-mints-file'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            out.selectedPools = readSelectedPoolsFile(value);
            out.selectedOnly = out.selectedPools.length > 0;
        } else if (['against', 'anchors', 'anchor-mints', 'anchormints'].includes(normalized)) {
            out.against = parseCsvList(value).map(resolveMintSelector).filter(Boolean);
        } else if (['selectedset', 'selected-set', 'poolset', 'pool-set'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            const items = parseCsvList(value);
            const hasPreset = items.some(item => POOL_ADDRESS_PRESETS[item]);
            if (hasPreset) {
                out.poolSelector = String(value).trim();
                out.pairSelectors = expandPoolSelectorInput(value);
                out.pairSelectorOnly = out.pairSelectors.length > 0;
            } else {
                const parsed = parseSelectedSet(value);
                out.selectedPools = parsed.selectedPools;
                out.against = parsed.against;
                out.selectedOnly = out.selectedPools.length > 0;
            }
        } else if (['selectedonly', 'selected-only'].includes(normalized)) {
            out.selectedOnly = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['diagnosticsout', 'diagnostics-out', 'diagnose-out', 'drop-report', 'dropreport'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            out.diagnosticsOut = value;
        } else if (['minliquidity', 'min-liquidity'].includes(normalized)) {
            CONFIG.MIN_LIQUIDITY_USD = Math.max(0, Number(value || 0));
        } else if (['maxpools', 'max-pools', 'maxpoolsperdex', 'max-pools-per-dex'].includes(normalized)) {
            CONFIG.MAX_POOLS_PER_DEX = Math.max(1, Number(value || CONFIG.MAX_POOLS_PER_DEX));
        } else if (['solusdc', 'require-sol-usdc'].includes(normalized)) {
            CONFIG.REQUIRE_SOL_OR_USDC = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['pancakeswap', 'include-pancakeswap'].includes(normalized)) {
            out.includePancakeswap = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['no-pancakeswap', 'nopancakeswap', 'skip-pancakeswap'].includes(normalized)) {
            out.includePancakeswap = false;
        } else if (['dammv2', 'damm-v2', 'meteora-dammv2', 'meteora-damm-v2', 'include-dammv2', 'include-damm-v2'].includes(normalized)) {
            out.includeDammV2 = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['no-dammv2', 'no-damm-v2', 'skip-dammv2', 'skip-damm-v2'].includes(normalized)) {
            out.includeDammV2 = false;
        } else if (['pumpswap', 'include-pumpswap'].includes(normalized)) {
            out.includePumpswap = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['no-pumpswap', 'nopumpswap', 'skip-pumpswap'].includes(normalized)) {
            out.includePumpswap = false;
        } else if (['poolselector', 'pool-selector', 'pairselector', 'pair-selector', 'pairset', 'pair-set', 'triangle-set', 'triangleset'].includes(normalized)) {
            out.poolSelector = String(value || '').trim();
            out.pairSelectors = expandPoolSelectorInput(value);
            out.pairSelectorOnly = out.pairSelectors.length > 0;
        } else if (['poolselectorfile', 'pool-selector-file', 'pairselectorfile', 'pair-selector-file'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            const fileEntries = readPoolSelectorFile(value);
            out.poolSelector = value;
            out.pairSelectors = expandPoolSelectorInput(fileEntries);
            out.pairSelectorOnly = out.pairSelectors.length > 0;
        } else if (['qualityonly', 'quality-only'].includes(normalized)) {
            out.qualityOnly = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
            out.qualityOnlyExplicit = true;
        } else if (['qualityminliquidity', 'quality-min-liquidity', 'qualitymintvl', 'quality-min-tvl'].includes(normalized)) {
            out.qualityMinLiquidity = Math.max(0, Number(value || QUALITY_CONFIG.MIN_TVL_USD));
        } else if (['qualitymaxfeebps', 'quality-max-fee-bps'].includes(normalized)) {
            out.qualityMaxFeeBps = Math.max(1, Number(value || QUALITY_CONFIG.MAX_FEE_BPS));
        } else if (['excludepool', 'exclude-pool', 'exclude-pools', 'block-pool'].includes(normalized)) {
            out.excludePools.push(...parseCsvList(value));
        } else if (['dry-run', 'dryrun', 'plan-only', 'planonly', 'print-plan'].includes(normalized)) {
            out.planOnly = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['route-speed-test', 'routespeedtest', 'speed-test-routes', 'speedtestroutes'].includes(normalized)) {
            out.routeSpeedTest = !['0', 'false', 'no', 'off'].includes(String(value || 'true').toLowerCase());
        } else if (['speed-routes', 'speed-routes-file', 'route-report', 'routes-report'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            out.speedRoutesFile = value;
            out.routeSpeedTest = true;
        } else if (['speed-pool-source', 'speed-pools-source', 'route-pool-source'].includes(normalized)) {
            if (!hasFlagValue(value)) return warnBlank(key);
            out.speedPoolSource = value;
        } else if (['top-routes', 'speed-top-routes'].includes(normalized)) {
            out.speedTopRoutes = Math.max(1, Number(value || out.speedTopRoutes));
        } else if (['max-speed-pools', 'speed-max-pools', 'speed-pools'].includes(normalized)) {
            out.speedMaxPools = Math.max(1, Number(value || out.speedMaxPools));
        }
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg) continue;

        if (arg.startsWith('--') && arg.includes('=')) {
            const [key, ...rest] = arg.split('=');
            setValue(key, rest.join('='));
            continue;
        }

        if (arg.startsWith('--')) {
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                setValue(arg, next);
                i += 1;
            } else {
                setValue(arg, 'true');
            }
            continue;
        }

        if (i === 0 && !out.outputFileExplicit) {
            out.outputFile = arg;
        }
    }

    if (out.selectedOnly && out.against.length === 0) {
        out.against = [USDT, USDC, SOL];
    }
    if (out.pairSelectorOnly && !out.qualityOnlyExplicit && out.pairSelectors.some((selector) => selector.type === 'address')) {
        out.qualityOnly = false;
    }

    return out;
}

function poolMatchesSelectedSet(pool = {}, selectedPools = [], against = []) {
    if (!selectedPools.length) return true;
    const baseMint = pool.baseMint || pool.tokenXMint;
    const quoteMint = pool.quoteMint || pool.tokenYMint;
    if (!baseMint || !quoteMint) return false;

    const targetSet = new Set(selectedPools);
    const anchorSet = new Set(against);
    const baseIsTarget = targetSet.has(baseMint);
    const quoteIsTarget = targetSet.has(quoteMint);
    const baseIsAnchor = anchorSet.has(baseMint);
    const quoteIsAnchor = anchorSet.has(quoteMint);

    // Keep requested target/anchor pairs plus anchor/anchor pools needed to close triangles.
    return (baseIsTarget && quoteIsAnchor)
        || (quoteIsTarget && baseIsAnchor)
        || (baseIsAnchor && quoteIsAnchor);
}

function selectedSetDropReason(pool = {}, selectedPools = [], against = []) {
    if (!selectedPools.length) return 'kept_no_selected_filter';
    const base = pool.baseMint || pool.tokenXMint;
    const quote = pool.quoteMint || pool.tokenYMint;
    if (!base || !quote) return 'missing_mints';

    const targetSet = new Set(selectedPools);
    const anchorSet = new Set(against);
    const baseIsTarget = targetSet.has(base);
    const quoteIsTarget = targetSet.has(quote);
    const baseIsAnchor = anchorSet.has(base);
    const quoteIsAnchor = anchorSet.has(quote);

    if ((baseIsTarget && quoteIsAnchor) || (quoteIsTarget && baseIsAnchor)) return 'kept_target_anchor';
    if (baseIsAnchor && quoteIsAnchor) return 'kept_anchor_anchor';
    if (baseIsTarget || quoteIsTarget) return 'dropped_target_without_anchor';
    if (baseIsAnchor || quoteIsAnchor) return 'dropped_anchor_without_target';
    return 'dropped_no_selected_token';
}

function poolDexLabel(pool = {}) {
    const dex = String(pool.dex || pool.source || pool.protocol || 'unknown').toLowerCase();
    const dexType = String(pool.dexType || '').toLowerCase();
    if (dex.includes('pancakeswap') || dexType.includes('pancakeswap_amm_v3')) return 'pancakeswap';
    if (dex.includes('pump') || dexType.includes('pump')) return 'pumpswap';
    if (dex.includes('orca') || dexType.includes('whirlpool')) return 'orca';
    if (dex.includes('raydium')) return dexType.includes('clmm') || String(pool.type || '').toLowerCase().includes('clmm') ? 'raydiumClmm' : 'raydiumCpmm';
    if (dex.includes('meteora')) return dexType.includes('damm') || String(pool.type || '').toLowerCase().includes('damm') ? 'dammV2' : 'meteoraDlmm';
    return dex;
}

function poolPairLabel(pool = {}) {
    return `${pool.baseSymbol || getSymbol(pool.baseMint || pool.tokenXMint)}/${pool.quoteSymbol || getSymbol(pool.quoteMint || pool.tokenYMint)}`;
}

function buildSelectionDiagnostics(fetchedPools = [], selectedPools = [], args = {}) {
    const selectedAddresses = new Set(selectedPools.map((pool) => String(pool.poolAddress || pool.address || '').trim()).filter(Boolean));
    const rows = fetchedPools.map((pool) => {
        const address = String(pool.poolAddress || pool.address || '').trim();
        const kept = address ? selectedAddresses.has(address) : selectedPools.includes(pool);
        return {
            kept,
            reason: kept
                ? selectedSetDropReason(pool, args.selectedPools, args.against)
                : selectedSetDropReason(pool, args.selectedPools, args.against),
            poolAddress: address || null,
            dex: poolDexLabel(pool),
            type: pool.type || pool.mathType || null,
            dexType: pool.dexType || null,
            pair: poolPairLabel(pool),
            baseMint: pool.baseMint || pool.tokenXMint || null,
            quoteMint: pool.quoteMint || pool.tokenYMint || null,
            tvlUsd: poolTvlUsd(pool),
        };
    });

    const countBy = (items, keyFn) => items.reduce((acc, item) => {
        const key = keyFn(item);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const dropped = rows.filter((row) => !row.kept);
    const kept = rows.filter((row) => row.kept);
    return {
        generatedAt: new Date().toISOString(),
        selectedFilterEnabled: Boolean(args.selectedOnly),
        selectedPools: args.selectedPools || [],
        against: args.against || [],
        totals: {
            fetched: fetchedPools.length,
            kept: kept.length,
            dropped: dropped.length,
        },
        keptByDex: countBy(kept, (row) => row.dex),
        droppedByDex: countBy(dropped, (row) => row.dex),
        droppedByReason: countBy(dropped, (row) => row.reason),
        kept,
        dropped,
    };
}

function readJsonIfExists(file) {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function poolAddressOf(value = {}) {
    return String(value.poolAddress || value.address || value.id || value.pool || '').trim();
}

function routeProfitBps(route = {}) {
    const value = Number(route.netProfitBps ?? route.profitBps ?? route.profitBpsVerified ?? route.routeScore ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function extractRoutesForSpeedTest(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        if (Array.isArray(raw[0])) return raw;
        return [];
    }
    const buckets = [
        raw.ROUTES,
        raw.routes,
        raw.topRoutes,
        raw.executionEligibleTopRoutes,
        raw.submissionCandidates,
        raw.routePrep?.chainRoutes,
        raw.chainRoutes,
    ];
    for (const bucket of buckets) {
        if (Array.isArray(bucket) && bucket.length > 0) return bucket;
    }
    return [];
}

function routeLegsForSpeedTest(route) {
    if (Array.isArray(route)) return route;
    if (Array.isArray(route?.legs)) return route.legs;
    if (route?.leg1 || route?.leg2 || route?.leg3) return [route.leg1, route.leg2, route.leg3].filter(Boolean);
    return [];
}

function appendPoolsToIndex(value, index) {
    if (!value) return;
    if (Array.isArray(value)) {
        for (const item of value) appendPoolsToIndex(item, index);
        return;
    }
    if (typeof value !== 'object') return;
    const address = poolAddressOf(value);
    if (address) index.set(address, value);
}

function buildSpeedPoolIndex(...payloads) {
    const index = new Map();
    for (const raw of payloads) {
        if (!raw) continue;
        if (Array.isArray(raw)) appendPoolsToIndex(raw, index);
        appendPoolsToIndex(raw.pools, index);
        appendPoolsToIndex(raw.routePrep?.pools, index);
        appendPoolsToIndex(raw.runtime?.pools, index);
        appendPoolsToIndex(raw.runtime?.hotSet?.pools, index);
        appendPoolsToIndex(raw.hotSet?.pools, index);
        appendPoolsToIndex(raw.chainRoutes, index);
        appendPoolsToIndex(raw.routePrep?.chainRoutes, index);
    }
    return index;
}

function buildRouteSpeedTestPools(options = {}) {
    const routesRaw = readJsonIfExists(options.routesFile);
    if (!routesRaw) throw new Error(`Route/report file not found: ${options.routesFile}`);

    const poolPayloads = [
        routesRaw,
        readJsonIfExists(options.poolSource),
        readJsonIfExists('pools/03_ROUTED.json'),
        readJsonIfExists('pools/02_ENRICHED.json'),
    ];
    const poolIndex = buildSpeedPoolIndex(...poolPayloads);
    const routes = extractRoutesForSpeedTest(routesRaw)
        .map((route, index) => ({ route, index, profitBps: routeProfitBps(route) }))
        .sort((a, b) => b.profitBps - a.profitBps || a.index - b.index)
        .slice(0, Math.max(1, Number(options.topRoutes || 10)));

    const selected = [];
    const seen = new Set();
    const routeRows = [];
    for (const entry of routes) {
        const routeId = entry.route?.routeId || entry.route?.id || `route-${entry.index}`;
        const pathLabel = entry.route?.path || entry.route?.routePath || entry.route?.routePathSymbols || '';
        const routeAddresses = [];
        for (const leg of routeLegsForSpeedTest(entry.route)) {
            const address = poolAddressOf(leg);
            if (!address) continue;
            routeAddresses.push(address);
            if (seen.has(address)) continue;
            const pool = poolIndex.get(address) || leg;
            selected.push({
                ...pool,
                poolAddress: poolAddressOf(pool) || address,
                address: poolAddressOf(pool) || address,
                _speedTest: {
                    sourceRouteId: routeId,
                    sourceRoutePath: pathLabel,
                    sourceProfitBps: entry.profitBps,
                },
            });
            seen.add(address);
            if (selected.length >= Math.max(1, Number(options.maxPools || 10))) break;
        }
        routeRows.push({ routeId, path: pathLabel, profitBps: entry.profitBps, pools: routeAddresses });
        if (selected.length >= Math.max(1, Number(options.maxPools || 10))) break;
    }

    return {
        pools: selected,
        diagnostics: {
            generatedAt: new Date().toISOString(),
            mode: 'route-speed-test',
            routesFile: options.routesFile,
            poolSource: options.poolSource || null,
            topRoutes: routes.length,
            maxPools: Math.max(1, Number(options.maxPools || 10)),
            selectedPools: selected.length,
            routes: routeRows,
        },
    };
}

function normalizePancakeSamplePool(pool = {}) {
    const baseMint = pool.baseMint || pool.tokenXMint || pool.mintA || pool.baseToken?.address;
    const quoteMint = pool.quoteMint || pool.tokenYMint || pool.mintB || pool.quoteToken?.address;
    if (!baseMint || !quoteMint) return null;
    return {
        ...pool,
        poolAddress: pool.poolAddress || pool.address || pool.id || pool.pairAddress,
        address: pool.address || pool.poolAddress || pool.id || pool.pairAddress,
        dex: 'pancakeswap',
        type: 'amm_v3',
        dexType: 'PANCAKESWAP_AMM_V3',
        baseMint,
        quoteMint,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        baseDecimals: Number(pool.baseDecimals ?? pool.tokenXDecimals ?? pool.baseToken?.decimals ?? getDecimals(baseMint)),
        quoteDecimals: Number(pool.quoteDecimals ?? pool.tokenYDecimals ?? pool.quoteToken?.decimals ?? getDecimals(quoteMint)),
        tokenXDecimals: Number(pool.tokenXDecimals ?? pool.baseDecimals ?? pool.baseToken?.decimals ?? getDecimals(baseMint)),
        tokenYDecimals: Number(pool.tokenYDecimals ?? pool.quoteDecimals ?? pool.quoteToken?.decimals ?? getDecimals(quoteMint)),
        baseSymbol: pool.baseSymbol || pool.tokenXSymbol || pool.baseToken?.symbol || getSymbol(baseMint),
        quoteSymbol: pool.quoteSymbol || pool.tokenYSymbol || pool.quoteToken?.symbol || getSymbol(quoteMint),
        reserves: {
            x: String(pool.xReserve || pool.reserves?.x || '0'),
            y: String(pool.yReserve || pool.reserves?.y || '0'),
        },
        xReserve: String(pool.xReserve || pool.reserves?.x || '0'),
        yReserve: String(pool.yReserve || pool.reserves?.y || '0'),
        feeBps: Number(pool.feeBps ?? pool.feeBpsCanonical ?? 25),
        feeRate: Number(pool.feeRate ?? ((Number(pool.feeBps ?? pool.feeBpsCanonical ?? 25)) / 10000)),
        quoteSource: pool.quoteSource || 'native-reserves',
        reserveSource: pool.reserveSource || 'pancake-sample',
        currentPrice: toNumber(pool.currentPrice ?? pool.midPrice ?? pool.price ?? pool.priceNative, 0),
        midPrice: toNumber(pool.midPrice ?? pool.currentPrice ?? pool.price ?? pool.priceNative, 0),
        price: toNumber(pool.price ?? pool.midPrice ?? pool.currentPrice ?? pool.priceNative, 0),
        tvl: poolTvlUsd(pool),
        tvlUsd: poolTvlUsd(pool),
        liquidityUsd: poolTvlUsd(pool),
        hasReserves: true,
        isMathReady: true,
        enriched: true,
    };
}

function normalizePancakeswapPool(pool = {}) {
    const normalized = normalizePancakeSamplePool(pool);
    if (!normalized) return null;
    return {
        ...normalized,
        dex: 'pancakeswap',
        type: 'amm',
        mathType: 'amm',
        dexType: 'PANCAKESWAP_AMM',
        reserveSource: pool.reserveSource || normalized.reserveSource || 'bitquery-pancakeswap',
        sourceProvider: pool.sourceProvider || normalized.sourceProvider || 'bitquery',
    };
}

function normalizePumpswapPool(pool = {}) {
    const baseMint = pool.baseMint || pool.tokenXMint || pool.mintA;
    const quoteMint = pool.quoteMint || pool.tokenYMint || pool.mintB;
    if (!baseMint || !quoteMint) return null;
    const tvl = poolTvlUsd(pool);
    const feeBps = Number(pool.feeBps ?? pool.feeBpsCanonical ?? 30);
    return {
        ...pool,
        poolAddress: pool.poolAddress || pool.address || pool.id,
        address: pool.address || pool.poolAddress || pool.id,
        dex: 'pumpswap',
        // Label contract — keep in sync with bitqueryFrontendlessFetcher and classifyPool().
        type: 'pumpswap',          // internal adapter key consumed by classifyPool()
        mathType: 'pumpswap',
        dexType: 'PUMPSWAP_AMM',   // PumpSwap's on-chain program/IDL is pump_amm
        baseMint,
        quoteMint,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        baseDecimals: Number(pool.baseDecimals ?? pool.tokenXDecimals ?? getDecimals(baseMint)),
        quoteDecimals: Number(pool.quoteDecimals ?? pool.tokenYDecimals ?? getDecimals(quoteMint)),
        tokenXDecimals: Number(pool.tokenXDecimals ?? pool.baseDecimals ?? getDecimals(baseMint)),
        tokenYDecimals: Number(pool.tokenYDecimals ?? pool.quoteDecimals ?? getDecimals(quoteMint)),
        baseSymbol: pool.baseSymbol || pool.tokenXSymbol || getSymbol(baseMint),
        quoteSymbol: pool.quoteSymbol || pool.tokenYSymbol || getSymbol(quoteMint),
        reserves: {
            x: String(pool.xReserve || pool.reserves?.x || '0'),
            y: String(pool.yReserve || pool.reserves?.y || '0'),
        },
        xReserve: String(pool.xReserve || pool.reserves?.x || '0'),
        yReserve: String(pool.yReserve || pool.reserves?.y || '0'),
        feeBps,
        feeRate: Number(pool.feeRate ?? (feeBps / 10000)),
        quoteSource: pool.quoteSource || 'native-reserves',
        reserveSource: pool.reserveSource || 'bitquery-pumpswap',
        currentPrice: toNumber(pool.currentPrice ?? pool.midPrice ?? pool.price, 0),
        midPrice: toNumber(pool.midPrice ?? pool.currentPrice ?? pool.price, 0),
        price: toNumber(pool.price ?? pool.midPrice ?? pool.currentPrice, 0),
        tvl,
        tvlUsd: tvl,
        liquidity: tvl,
        liquidityUsd: tvl,
        hasReserves: true,
        isMathReady: true,
        enriched: true,
    };
}

function loadPancakeswapSamplePools() {
    const out = [];
    for (const file of CONFIG.PANCAKE_SAMPLE_FILES) {
        try {
            if (!fs.existsSync(file)) continue;
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const rows = Array.isArray(raw) ? raw : (raw.pools || raw.data || []);
            for (const row of rows) {
                const pool = normalizePancakeSamplePool(row);
                if (!pool?.poolAddress || !hasPositiveReserves(pool)) continue;
                out.push(pool);
            }
        } catch (error) {
            console.warn(`  Pancake sample skipped ${file}: ${error.message}`);
        }
    }
    return out;
}

function mergeUniquePools(...groups) {
    const byAddress = new Map();
    for (const group of groups) {
        for (const pool of group || []) {
            const address = String(pool.poolAddress || pool.address || '').trim();
            if (!address) continue;
            const prev = byAddress.get(address);
            if (!prev) {
                byAddress.set(address, pool);
                continue;
            }
            const preferred = poolTvlUsd(pool) >= poolTvlUsd(prev) ? pool : prev;
            const fallback = preferred === pool ? prev : pool;
            byAddress.set(address, {
                ...fallback,
                ...preferred,
                reserves: {
                    ...(fallback.reserves || {}),
                    ...(preferred.reserves || {}),
                },
                xReserve: preferred.xReserve || fallback.xReserve || preferred.reserves?.x || fallback.reserves?.x || '0',
                yReserve: preferred.yReserve || fallback.yReserve || preferred.reserves?.y || fallback.reserves?.y || '0',
                vaults: {
                    ...(fallback.vaults || {}),
                    ...(preferred.vaults || {}),
                },
                xVault: preferred.xVault || fallback.xVault || preferred.vaults?.xVault || fallback.vaults?.xVault || null,
                yVault: preferred.yVault || fallback.yVault || preferred.vaults?.yVault || fallback.vaults?.yVault || null,
            });
        }
    }
    return Array.from(byAddress.values());
}

function hasSolOrUsdc(baseMint, quoteMint) {
    return baseMint === SOL || quoteMint === SOL ||
        baseMint === USDC || quoteMint === USDC;
}

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        // For plain HTTPS API calls we rotate the RPC on each retry so a
        // saturated node doesn't block us — the URL itself stays fixed for
        // non-RPC endpoints; nextRpc() is used explicitly for RPC calls below.
        try {
            console.log(`  Fetching ${url.substring(0, 80)}...`);
            const response = await axios.get(url, {
                timeout: CONFIG.TIMEOUT,
                headers: { 'User-Agent': 'Solana-Arbitrage-Bot/2.0' },
            });
            return response.data;
        } catch (error) {
            if (error.response?.status === 429) {
                const delay = Math.min(2000 * (i + 1), 10_000);
                console.warn(`  Rate limited, waiting ${delay}ms...`);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            console.warn(`  Attempt ${i + 1}/${retries} failed: ${error.message}`);
            if (i === retries - 1) throw error;
            await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
    }
}

async function fetchJson(url, timeout = 30_000) {
    const response = await axios.get(url, {
        timeout,
        headers: { 'User-Agent': 'Solana-Arbitrage-Bot/2.0' },
    });
    return response.data;
}

// RPC POST helper — rotates through RPC_ENDPOINTS automatically.
async function rpcPost(body, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        const rpc = nextRpc();
        try {
            const { data } = await axios.post(rpc, body, {
                timeout: 10_000,
                headers: { 'Content-Type': 'application/json' },
            });
            return data;
        } catch (err) {
            lastErr = err;
            console.warn(`  RPC ${rpc.slice(0, 40)}... attempt ${i + 1} failed: ${err.message}`);
            await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
    }
    throw lastErr;
}


// ============================================================================
// ORCA WHIRLPOOLS - Best liquidity source!
// ============================================================================

async function fetchOrcaWhirlpools() {
    console.log('\n[ORCA] Fetching Whirlpools...');

    try {
        const data = await fetchWithRetry('https://api.mainnet.orca.so/v1/whirlpool/list');
        const whirlpools = data.whirlpools || [];
        console.log(`  Found ${whirlpools.length} total pools`);

        // Filter and map
        const pools = [];
        for (const pool of whirlpools) {
            const tvl = parseFloat(pool.tvl) || 0;
            if (tvl < CONFIG.MIN_LIQUIDITY_USD) continue;

            const baseMint = pool.tokenA?.mint;
            const quoteMint = pool.tokenB?.mint;
            if (!baseMint || !quoteMint) continue;

            if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) continue;

            pools.push({
                poolAddress: pool.address,
                dex: 'orca',
                type: 'whirlpool',

                baseMint,
                quoteMint,
                baseDecimals: pool.tokenA.decimals || getDecimals(baseMint),
                quoteDecimals: pool.tokenB.decimals || getDecimals(quoteMint),
                baseSymbol: pool.tokenA.symbol || getSymbol(baseMint),
                quoteSymbol: pool.tokenB.symbol || getSymbol(quoteMint),

                // Price from Orca API
                price: pool.price || 0,

                // Liquidity
                liquidity: tvl,
                tvl,

                // Fee info
                feeRate: pool.lpFeeRate || 0.003,
                feeBps: Math.round((pool.lpFeeRate || 0.003) * 10000),
                tickSpacing: pool.tickSpacing || 64,
            });
        }

        // Sort by liquidity
        pools.sort((a, b) => b.liquidity - a.liquidity);

        console.log(`  Kept ${pools.length} pools (>$${CONFIG.MIN_LIQUIDITY_USD / 1000}k, SOL/USDC pairs)`);
        return pools.slice(0, CONFIG.MAX_POOLS_PER_DEX);

    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}

// ============================================================================
// RAYDIUM CLMM
// ============================================================================

async function fetchRaydiumCLMM() {
    console.log('\n[RAYDIUM] Fetching CLMM pools...');

    try {
        const url = 'https://api-v3.raydium.io/pools/info/list-v2?poolType=Concentrated&hasReward=false&sortField=liquidity&sortType=desc&size=100';
        const data = await fetchWithRetry(url);
        const rawPools = data.data?.data || data.data || [];
        console.log(`  Found ${rawPools.length} pools`);

        const pools = [];
        for (const pool of rawPools) {
            const tvl = pool.tvl || pool.liquidity || 0;
            if (tvl < CONFIG.MIN_LIQUIDITY_USD) continue;

            const baseMint = pool.mintA?.address || pool.mintA;
            const quoteMint = pool.mintB?.address || pool.mintB;
            if (!baseMint || !quoteMint) continue;

            if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) continue;

            // Calculate price from reserves or use provided
            let price = pool.price || 0;
            if (!price && pool.mintAmountA && pool.mintAmountB) {
                const baseDec = pool.mintA?.decimals || getDecimals(baseMint);
                const quoteDec = pool.mintB?.decimals || getDecimals(quoteMint);
                price = pool.mintAmountB / pool.mintAmountA;
            }

            pools.push({
                poolAddress: pool.id,
                dex: 'raydium',
                type: 'clmm',

                baseMint,
                quoteMint,
                baseDecimals: pool.mintA?.decimals || getDecimals(baseMint),
                quoteDecimals: pool.mintB?.decimals || getDecimals(quoteMint),
                baseSymbol: pool.mintA?.symbol || getSymbol(baseMint),
                quoteSymbol: pool.mintB?.symbol || getSymbol(quoteMint),

                price,
                liquidity: tvl,
                tvl,

                feeRate: pool.config?.tradeFeeRate ? pool.config.tradeFeeRate / 1000000 : 0.0025,
                feeBps: pool.config?.tradeFeeRate ? pool.config.tradeFeeRate / 100 : 25,
                tickSpacing: pool.config?.tickSpacing || 1,

                // Reserves for math simulation
                xReserve: pool.mintAmountA ? String(Math.floor(pool.mintAmountA * Math.pow(10, pool.mintA?.decimals || 9))) : '0',
                yReserve: pool.mintAmountB ? String(Math.floor(pool.mintAmountB * Math.pow(10, pool.mintB?.decimals || 6))) : '0',
            });
        }

        pools.sort((a, b) => b.liquidity - a.liquidity);
        console.log(`  Kept ${pools.length} pools`);
        return pools.slice(0, CONFIG.MAX_POOLS_PER_DEX);

    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}

// ============================================================================
// RAYDIUM CPMM (Standard AMM)
// ============================================================================

async function fetchRaydiumCPMM() {
    console.log('\n[RAYDIUM] Fetching CPMM pools...');

    try {
        const url = 'https://api-v3.raydium.io/pools/info/list-v2?poolType=Standard&sortField=liquidity&sortType=desc&size=100';
        const data = await fetchWithRetry(url);
        const rawPools = data.data?.data || data.data || [];
        console.log(`  Found ${rawPools.length} pools`);

        const pools = [];
        for (const pool of rawPools) {
            const tvl = pool.tvl || pool.liquidity || 0;
            if (tvl < CONFIG.MIN_LIQUIDITY_USD) continue;

            const baseMint = pool.mintA?.address || pool.mintA;
            const quoteMint = pool.mintB?.address || pool.mintB;
            if (!baseMint || !quoteMint) continue;

            if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) continue;

            const baseDec = pool.mintA?.decimals || getDecimals(baseMint);
            const quoteDec = pool.mintB?.decimals || getDecimals(quoteMint);

            let price = pool.price || 0;
            if (!price && pool.mintAmountA && pool.mintAmountB) {
                price = pool.mintAmountB / pool.mintAmountA;
            }

            pools.push({
                poolAddress: pool.id,
                dex: 'raydium',
                type: 'cpmm',

                baseMint,
                quoteMint,
                baseDecimals: baseDec,
                quoteDecimals: quoteDec,
                baseSymbol: pool.mintA?.symbol || getSymbol(baseMint),
                quoteSymbol: pool.mintB?.symbol || getSymbol(quoteMint),

                price,
                liquidity: tvl,
                tvl,

                feeRate: pool.feeRate || 0.0025,
                feeBps: Math.round((pool.feeRate || 0.0025) * 10000),

                // Reserves for CPMM math
                xReserve: pool.mintAmountA ? String(Math.floor(pool.mintAmountA * Math.pow(10, baseDec))) : '0',
                yReserve: pool.mintAmountB ? String(Math.floor(pool.mintAmountB * Math.pow(10, quoteDec))) : '0',
            });
        }

        pools.sort((a, b) => b.liquidity - a.liquidity);
        console.log(`  Kept ${pools.length} pools`);
        return pools.slice(0, CONFIG.MAX_POOLS_PER_DEX);

    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}

// ============================================================================
// METEORA DLMM
// ============================================================================

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


async function fetchMeteoraDLMM(limit, overFetchSize) {
    const fetchSize = Number(overFetchSize || limit || CONFIG.POOLS_PER_TYPE || CONFIG.MAX_POOLS_PER_DEX);
    const pageSize = Math.max(1, Math.min(Number(fetchSize) || 1, 1000));
    const baseUrl = 'https://dlmm.datapi.meteora.ag/pools';
    const url = `${baseUrl}?page_size=${pageSize}&sort_by=tvl:desc`;

    try {
        console.log(`Fetching Meteora DLMM (size=${pageSize})...`);
        const data = await fetchJson(url, DEX_DIRECT_CONFIGS.meteora?.config?.timeout || 60_000);
        const selected = safeExtractList(data)
            .slice()
            .sort((a, b) => Number(b?.liquidity || b?.tvl || 0) - Number(a?.liquidity || a?.tvl || 0))
            .slice(0, fetchSize);

        console.log(`  Found ${selected.length} raw pools`);

        const pools = [];
        for (const rawPool of selected) {
            const mapped = fallbackMapMeteoraRaw(rawPool, url);
            if (!mapped) continue;

            const liq = poolTvlUsd(mapped) || toNumber(mapped.liquidity, 0);
            if (liq < CONFIG.MIN_LIQUIDITY_USD) continue;

            const baseMint = mapped.baseMint || mapped.tokenXMint;
            const quoteMint = mapped.quoteMint || mapped.tokenYMint;
            if (!baseMint || !quoteMint) continue;
            if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) continue;

            pools.push({
                ...mapped,
                poolAddress: mapped.poolAddress || mapped.address,
                address: mapped.address || mapped.poolAddress,
                dex: 'meteora',
                type: 'dlmm',
                mathType: mapped.mathType || 'dlmm',
                dexType: 'METEORA_DLMM',
                baseMint,
                quoteMint,
                tokenXMint: baseMint,
                tokenYMint: quoteMint,
                baseDecimals: Number(mapped.baseDecimals ?? mapped.tokenXDecimals ?? getDecimals(baseMint, 9)),
                quoteDecimals: Number(mapped.quoteDecimals ?? mapped.tokenYDecimals ?? getDecimals(quoteMint, 6)),
                tokenXDecimals: Number(mapped.tokenXDecimals ?? mapped.baseDecimals ?? getDecimals(baseMint, 9)),
                tokenYDecimals: Number(mapped.tokenYDecimals ?? mapped.quoteDecimals ?? getDecimals(quoteMint, 6)),
                baseSymbol: mapped.baseSymbol || getSymbol(baseMint),
                quoteSymbol: mapped.quoteSymbol || getSymbol(quoteMint),
                xVault: mapped.xVault || mapped.vaults?.xVault || null,
                yVault: mapped.yVault || mapped.vaults?.yVault || null,
                xReserve: mapped.xReserve || mapped.reserves?.x || '0',
                yReserve: mapped.yReserve || mapped.reserves?.y || '0',
                reserves: {
                    x: mapped.xReserve || mapped.reserves?.x || '0',
                    y: mapped.yReserve || mapped.reserves?.y || '0',
                },
                price: toNumber(mapped.price ?? mapped.currentPrice ?? mapped.midPrice, 0),
                currentPrice: toNumber(mapped.currentPrice ?? mapped.price ?? mapped.midPrice, 0),
                midPrice: toNumber(mapped.midPrice ?? mapped.currentPrice ?? mapped.price, 0),
                currentPriceSource: mapped.currentPriceSource || 'meteora-dlmm-api',
                liquidity: liq,
                tvl: liq,
                tvlUsd: liq,
                liquidityUsd: liq,
                feeBps: Number(mapped.feeBps ?? 30),
                feeRate: Number(mapped.feeRate ?? ((Number(mapped.feeBps ?? 30)) / 10000)),
                binWalk: CONFIG.DLMM_BIN_WALK,
                quoteSource: mapped.quoteSource || 'api',
                reserveSource: mapped.reserveSource || 'meteora-dlmm-api',
            });
        }

        pools.sort((a, b) => b.liquidity - a.liquidity);
        console.log(`  Kept ${pools.length} pools`);
        return pools.slice(0, CONFIG.MAX_POOLS_PER_DEX);
    } catch (error) {
        console.error('  Meteora failed:', error.message);
        return [];
    }
}

// ============================================================================
// METEORA DAMM v2
// ============================================================================

async function fetchMeteoraDAMMV2() {
    console.log('\n[METEORA] Fetching DAMM v2 pools...');

    try {
        const params = new URLSearchParams({
            page: '1',
            page_size: String(CONFIG.DAMM_V2_PAGE_SIZE),
            sort_by: 'tvl:desc',
            filter_by: `tvl>=${CONFIG.DAMM_V2_MIN_LIQUIDITY_USD} && is_blacklisted=false`,
        });
        const url = `https://damm-v2.datapi.meteora.ag/pools?${params.toString()}`;
        const data = await fetchWithRetry(url);
        const rawPools = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        console.log(`  Found ${rawPools.length} pools`);

        const pools = [];
        for (const pool of rawPools) {
            const tvl = toNumber(pool.tvl, 0);
            if (tvl < CONFIG.MIN_LIQUIDITY_USD) continue;
            if (pool.is_blacklisted) continue;

            const baseMint = pool.token_x?.address || pool.tokenXMint || pool.baseMint;
            const quoteMint = pool.token_y?.address || pool.tokenYMint || pool.quoteMint;
            if (!baseMint || !quoteMint) continue;
            if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) continue;

            const baseDec = Number(pool.token_x?.decimals ?? getDecimals(baseMint, 6));
            const quoteDec = Number(pool.token_y?.decimals ?? getDecimals(quoteMint, 6));
            const xReserve = amountToAtomic(pool.token_x_amount, baseDec);
            const yReserve = amountToAtomic(pool.token_y_amount, quoteDec);
            const feePct = toNumber(pool.pool_config?.base_fee_pct ?? pool.fee_pct, 0.3);

            pools.push({
                poolAddress: pool.address,
                address: pool.address,
                dex: 'meteora',
                type: 'damm_v2',
                dexType: 'METEORA_DAMM_V2',

                baseMint,
                quoteMint,
                tokenXMint: baseMint,
                tokenYMint: quoteMint,
                baseDecimals: baseDec,
                quoteDecimals: quoteDec,
                tokenXDecimals: baseDec,
                tokenYDecimals: quoteDec,
                baseSymbol: pool.token_x?.symbol || pool.name?.split('-')[0] || getSymbol(baseMint),
                quoteSymbol: pool.token_y?.symbol || pool.name?.split('-')[1] || getSymbol(quoteMint),

                vaults: { xVault: pool.vault_x || null, yVault: pool.vault_y || null },
                xVault: pool.vault_x || null,
                yVault: pool.vault_y || null,
                reserves: { x: xReserve, y: yReserve },
                xReserve,
                yReserve,

                price: toNumber(pool.current_price, 0),
                currentPrice: toNumber(pool.current_price, 0),
                midPrice: toNumber(pool.current_price, 0),
                currentPriceSource: 'meteora-damm-v2-api',
                liquidity: tvl,
                tvl,
                volume24h: toNumber(pool.volume?.['24h'], 0),
                volume24hUsd: toNumber(pool.volume?.['24h'], 0),
                feeRate: feePct / 100,
                feeBps: Math.round(feePct * 100),
                quoteSource: 'native-reserves',
                reserveSource: 'meteora-damm-v2-api',
            });
        }

        pools.sort((a, b) => b.tvl - a.tvl);
        console.log(`  Kept ${pools.length} pools`);
        return pools.slice(0, CONFIG.MAX_POOLS_PER_DEX);
    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}

function addressSelectors(args = {}) {
    return Array.from(new Set((args.pairSelectors || [])
        .filter((selector) => selector.type === 'address')
        .map((selector) => String(selector.value || '').trim())
        .filter(Boolean)));
}

function isAddressOnlySelector(args = {}) {
    return Boolean(args.pairSelectorOnly)
        && (args.pairSelectors || []).length > 0
        && (args.pairSelectors || []).every((selector) => selector.type === 'address');
}

function mergePoolsByAddress(...groups) {
    const byAddress = new Map();
    for (const group of groups) {
        for (const pool of group || []) {
            const address = String(pool.poolAddress || pool.address || '').trim();
            if (!address) continue;
            byAddress.set(address, { ...(byAddress.get(address) || {}), ...pool });
        }
    }
    return Array.from(byAddress.values());
}

function normalizeShyftOrcaPool(pool = {}) {
    const baseMint = pool.tokenMintA;
    const quoteMint = pool.tokenMintB;
    if (!pool.pubkey || !baseMint || !quoteMint) return null;
    const feeBps = Math.round(Number(pool.feeRate || 0) / 100);
    return {
        poolAddress: pool.pubkey,
        address: pool.pubkey,
        dex: 'orca',
        type: 'whirlpool',
        mathType: 'whirlpool',
        dexType: 'ORCA_WHIRLPOOL',
        baseMint,
        quoteMint,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        baseDecimals: getDecimals(baseMint),
        quoteDecimals: getDecimals(quoteMint),
        tokenXDecimals: getDecimals(baseMint),
        tokenYDecimals: getDecimals(quoteMint),
        baseSymbol: getSymbol(baseMint),
        quoteSymbol: getSymbol(quoteMint),
        tokenXSymbol: getSymbol(baseMint),
        tokenYSymbol: getSymbol(quoteMint),
        xVault: pool.tokenVaultA,
        yVault: pool.tokenVaultB,
        vaults: { xVault: pool.tokenVaultA, yVault: pool.tokenVaultB },
        liquidity: Number(pool.liquidity || 0),
        tvl: 0,
        tvlUsd: 0,
        tickCurrent: pool.tickCurrentIndex,
        tickSpacing: pool.tickSpacing,
        sqrtPriceX64: pool.sqrtPrice ? String(pool.sqrtPrice) : null,
        feeBps,
        feeRate: feeBps / 10_000,
        source: 'shyft-direct',
    };
}

function normalizeShyftDlmmPool(pool = {}) {
    const baseMint = pool.tokenXMint;
    const quoteMint = pool.tokenYMint;
    if (!pool.pubkey || !baseMint || !quoteMint) return null;
    const feeBps = Math.round(Number(pool.binStep || 1) * 0.3);
    return {
        poolAddress: pool.pubkey,
        address: pool.pubkey,
        dex: 'meteora',
        type: 'dlmm',
        mathType: 'dlmm',
        dexType: 'METEORA_DLMM',
        baseMint,
        quoteMint,
        tokenXMint: baseMint,
        tokenYMint: quoteMint,
        baseDecimals: getDecimals(baseMint),
        quoteDecimals: getDecimals(quoteMint),
        tokenXDecimals: getDecimals(baseMint),
        tokenYDecimals: getDecimals(quoteMint),
        baseSymbol: getSymbol(baseMint),
        quoteSymbol: getSymbol(quoteMint),
        tokenXSymbol: getSymbol(baseMint),
        tokenYSymbol: getSymbol(quoteMint),
        liquidity: Number(pool.liquidity || 0),
        tvl: 0,
        tvlUsd: 0,
        activeId: pool.activeId,
        binStep: pool.binStep,
        feeBps,
        feeRate: feeBps / 10_000,
        binWalk: CONFIG.DLMM_BIN_WALK,
        quoteSource: 'shyft-direct',
        reserveSource: 'shyft-direct',
        source: 'shyft-direct',
    };
}

async function fetchSelectedPoolsByAddress(addresses = []) {
    const requested = Array.from(new Set(addresses.map((addr) => String(addr || '').trim()).filter(Boolean)));
    if (!requested.length) return [];

    console.log(`\n[DIRECT] Fetching ${requested.length} selected pool addresses via Shyft GraphQL...`);
    const query = gql`
      query($addresses: [String!]!) {
        orca: ORCA_WHIRLPOOLS_whirlpool(where: { pubkey: { _in: $addresses } }) {
          pubkey tokenMintA tokenMintB tokenVaultA tokenVaultB liquidity tickCurrentIndex tickSpacing sqrtPrice feeRate
        }
        dlmm: meteora_dlmm_LbPair(where: { pubkey: { _in: $addresses } }) {
          pubkey tokenXMint tokenYMint activeId binStep
        }
      }
    `;
    const result = await shyftGraphqlClient.request(query, { addresses: requested });
    const pools = [
        ...(result.orca || []).map(normalizeShyftOrcaPool),
        ...(result.dlmm || []).map(normalizeShyftDlmmPool),
    ].filter(Boolean);
    const found = new Set(pools.map((pool) => pool.poolAddress));
    const missing = requested.filter((address) => !found.has(address));
    console.log(`  Direct fetched ${pools.length}/${requested.length} pools${missing.length ? `; missing ${missing.length}` : ''}`);
    if (missing.length) {
        console.log(`  Missing: ${missing.map(short).join(', ')}`);
    }
    return pools;
}

// ============================================================================
// PANCAKESWAP AMM V3
// ============================================================================

async function fetchPancakeswapAMM() {
    console.log('\n[PANCAKESWAP] Fetching AMM pools...');
    try {
        const samplePools = loadPancakeswapSamplePools();
        if (samplePools.length) {
            console.log(`  Loaded ${samplePools.length} Pancake sample pools from local files`);
        }

        let rawPools = [];
        if (typeof fetchPancakeSwapFromBitquery === 'function') {
            rawPools = await fetchPancakeSwapFromBitquery({
                minLiquidity: CONFIG.PANCAKESWAP_MIN_LIQUIDITY_USD,
                bitqueryLimit: CONFIG.PANCAKESWAP_LIMIT,
                bitqueryFamilies: 'Pancakeswap',
                bitqueryCredentialsFile: process.env.BITQUERY_CREDENTIALS_FILE || 'utilities/bitQuery.js',
                bitqueryTimeoutMs: CONFIG.TIMEOUT,
            });
        } else {
            console.warn('  Bitquery Pancake adapter unavailable, using sample pools only');
        }

        const pools = (rawPools || []).map(normalizePancakeswapPool).filter(Boolean);
        const merged = mergeUniquePools(pools, samplePools);
        const filtered = merged
            .filter((pool) => {
                const baseMint = pool.baseMint || pool.tokenXMint;
                const quoteMint = pool.quoteMint || pool.tokenYMint;
                return !CONFIG.REQUIRE_SOL_OR_USDC || hasSolOrUsdc(baseMint, quoteMint);
            })
            .filter((pool) => poolTvlUsd(pool) >= CONFIG.PANCAKESWAP_MIN_LIQUIDITY_USD)
            .slice(0, CONFIG.MAX_POOLS_PER_DEX);

        console.log(`  Kept ${filtered.length} pools (Bitquery=${pools.length}, sample=${samplePools.length})`);
        return filtered;
    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}


// ============================================================================
// Pumpswap 
// ============================================================================
const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

function decodePumpswapPoolAccount(data) {
    if (!Buffer.isBuffer(data) || data.length < 121) {
        return { reserveX: 0n, reserveY: 0n };
    }
    try {
        const reserveX = data.readBigUInt64LE(105);
        const reserveY = data.readBigUInt64LE(113);
        return { reserveX, reserveY };
    } catch {
        return { reserveX: 0n, reserveY: 0n };
    }
}

async function fetchPumpSwapPairsFromDexScreener(options = {}) {
    const queries = buildDexScreenerSearchQueries(options);
    const byAddress = new Map();

    for (const query of queries) {
        try {
            const dexData = await fetchJson(`${DEXSCREENER_SEARCH_URL}${encodeURIComponent(query)}`, CONFIG.TIMEOUT);
            const pairs = Array.isArray(dexData?.pairs) ? dexData.pairs : [];
            for (const pair of pairs) {
                if (String(pair?.chainId || '').toLowerCase() !== 'solana') continue;
                if (String(pair?.dexId || '').toLowerCase() !== 'pumpswap') continue;
                const address = String(pair?.pairAddress || '').trim();
                if (!address) continue;
                byAddress.set(address, pair);
            }
        } catch (error) {
            console.warn(`  DexScreener search failed for "${query}": ${error.message}`);
        }
    }

    return Array.from(byAddress.values());
}

async function enrichPumpSwapReservesFromRpc(pairs = []) {
    if (!pairs.length) return new Map();

    const poolAddresses = [];
    const validPairs = [];
    for (const pair of pairs) {
        try {
            poolAddresses.push(new PublicKey(pair.pairAddress));
            validPairs.push(pair);
        } catch {
            // skip invalid address
        }
    }
    if (!poolAddresses.length) return new Map();

    try {
        const connection = new Connection(nextRpc(), 'confirmed');
        const accountInfos = await connection.getMultipleAccountsInfo(poolAddresses);
        const out = new Map();
        for (let i = 0; i < validPairs.length; i += 1) {
            const info = accountInfos[i];
            if (!info?.data) continue;
            out.set(validPairs[i].pairAddress, decodePumpswapPoolAccount(info.data));
        }
        return out;
    } catch (error) {
        console.warn(`  PumpSwap RPC reserve enrichment skipped: ${error.message}`);
        return new Map();
    }
}

async function fetchPumpswapPools(options = {}) {
    console.log('\n[PUMPSWAP] Fetching pools...');
    try {
        let rawPools = [];

        if (typeof fetchPumpswapFromBitquery === 'function') {
            rawPools = await fetchPumpswapFromBitquery({
                minLiquidity: CONFIG.PUMPSWAP_MIN_LIQUIDITY_USD,
                bitqueryLimit: CONFIG.PUMPSWAP_LIMIT,
                bitqueryFamilies: 'PumpSwap',
                bitqueryCredentialsFile: process.env.BITQUERY_CREDENTIALS_FILE || 'utilities/bitQuery.js',
                bitqueryTimeoutMs: CONFIG.TIMEOUT,
            });
        }

        let normalized = (rawPools || []).map(normalizePumpswapPool).filter(Boolean);

        if (!normalized.length) {
            const pairs = await fetchPumpSwapPairsFromDexScreener(options);
            const reserveMap = await enrichPumpSwapReservesFromRpc(pairs);

            normalized = pairs.map((pair) => {
                const baseMint = pair.baseToken?.address;
                const quoteMint = pair.quoteToken?.address;
                if (!baseMint || !quoteMint) return null;

                const reserves = reserveMap.get(pair.pairAddress) || { reserveX: 0n, reserveY: 0n };
                const liquidityUsd = toNumber(pair.liquidity?.usd, 0);
                const feeBps = Number(pair.feeBps ?? 30);

                return normalizePumpswapPool({
                    poolAddress: pair.pairAddress,
                    address: pair.pairAddress,
                    baseMint,
                    quoteMint,
                    baseDecimals: getDecimals(baseMint, 6),
                    quoteDecimals: getDecimals(quoteMint, 6),
                    baseSymbol: pair.baseToken?.symbol || getSymbol(baseMint),
                    quoteSymbol: pair.quoteToken?.symbol || getSymbol(quoteMint),
                    price: toNumber(pair.priceNative ?? pair.priceUsd ?? 0, 0),
                    currentPrice: toNumber(pair.priceNative ?? pair.priceUsd ?? 0, 0),
                    midPrice: toNumber(pair.priceNative ?? pair.priceUsd ?? 0, 0),
                    liquidity: liquidityUsd,
                    tvl: liquidityUsd,
                    tvlUsd: liquidityUsd,
                    liquidityUsd,
                    volume24h: toNumber(pair.volume?.h24 ?? pair.volume?.['24h'], 0),
                    volume24hUsd: toNumber(pair.volume?.h24 ?? pair.volume?.['24h'], 0),
                    feeBps,
                    feeRate: feeBps / 10_000,
                    reserveSource: reserves.reserveX > 0n && reserves.reserveY > 0n ? 'pumpswap-rpc' : 'dexscreener',
                    quoteSource: 'dexscreener',
                    reserves: {
                        x: reserves.reserveX.toString(),
                        y: reserves.reserveY.toString(),
                    },
                });
            }).filter(Boolean);
        }

        const filtered = normalized
            .filter((pool) => {
                const baseMint = pool.baseMint || pool.tokenXMint;
                const quoteMint = pool.quoteMint || pool.tokenYMint;
                if (!baseMint || !quoteMint) return false;
                if (poolTvlUsd(pool) < CONFIG.PUMPSWAP_MIN_LIQUIDITY_USD) return false;
                if (CONFIG.REQUIRE_SOL_OR_USDC && !hasSolOrUsdc(baseMint, quoteMint)) return false;
                return true;
            })
            .slice(0, CONFIG.MAX_POOLS_PER_DEX);

        console.log(`  Kept ${filtered.length} pools`);
        return filtered;
    } catch (error) {
        console.error('  Failed:', error.message);
        return [];
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = parseCliArgs(process.argv.slice(2));
    const outputFile = args.outputFile;
    const directAddressOnly = isAddressOnlySelector(args);

    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log('BATCH POOL FETCHER - Efficient API Usage');
    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log(`Min Liquidity: $${(CONFIG.MIN_LIQUIDITY_USD / 1000).toFixed(0)}k`);
    console.log(`Pancake Min Liquidity: $${(CONFIG.PANCAKESWAP_MIN_LIQUIDITY_USD / 1000).toFixed(0)}k`);
    console.log(`PumpSwap Min Liquidity: $${(CONFIG.PUMPSWAP_MIN_LIQUIDITY_USD / 1000).toFixed(0)}k`);
    console.log(`DammV2 Min Liquidity: $${(CONFIG.DAMM_V2_MIN_LIQUIDITY_USD / 1000).toFixed(0)}k`);
    console.log(`Max Pools Per DEX: ${CONFIG.MAX_POOLS_PER_DEX}`);
    console.log(`SOL or USDC: ${CONFIG.REQUIRE_SOL_OR_USDC}`);
    console.log(`Filter: SOL/USDC pairs only`);
    console.log(`Meteora DAMM v2 fetch: ${args.includeDammV2 ? 'on' : 'off'}`);
    console.log(`PancakeSwap fetch: ${args.includePancakeswap ? 'on' : 'off'}`);
    console.log(`PumpSwap fetch: ${args.includePumpswap ? 'on' : 'off'}`);
    if (args.selectedOnly) {
        console.log(`Selected set: ${args.selectedPools.map(getSymbol).join(', ')} against ${args.against.map(getSymbol).join(', ')}`);
    }
    if (args.pairSelectorOnly) {
        const selectorLabels = args.pairSelectors.map((selector) => selector.type === 'address' ? short(selector.value) : selector.key);
        console.log(`Pool selector: ${args.poolSelector || 'custom'} => ${selectorLabels.join(', ')}`);
    }
    console.log(`Quality only: ${args.qualityOnly} (minTvl=$${Number(args.qualityMinLiquidity).toLocaleString()}, maxFee=${args.qualityMaxFeeBps}bps)`);
    console.log(`Output: ${outputFile}`);
    const diagnosticsOut = args.diagnosticsOut || outputFile.replace(/\.json$/i, '.selection_diagnostic.json');
    console.log(`Diagnostics: ${diagnosticsOut}`);

    if (args.routeSpeedTest) {
        console.log('\nRoute speed-test mode: no remote DEX fetches will run.');
        console.log(`  Routes/report: ${args.speedRoutesFile}`);
        console.log(`  Pool source:    ${args.speedPoolSource}`);
        console.log(`  Top routes:     ${args.speedTopRoutes}`);
        console.log(`  Max pools:      ${args.speedMaxPools}`);

        const { pools, diagnostics } = buildRouteSpeedTestPools({
            routesFile: args.speedRoutesFile,
            poolSource: args.speedPoolSource,
            topRoutes: args.speedTopRoutes,
            maxPools: args.speedMaxPools,
        });

        fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(pools, null, 2));
        fs.mkdirSync(path.dirname(path.resolve(diagnosticsOut)), { recursive: true });
        fs.writeFileSync(diagnosticsOut, JSON.stringify(diagnostics, null, 2));

        console.log(`\n✓ Saved ${pools.length} speed-test pools to ${outputFile}`);
        console.log(`✓ Saved speed-test diagnostics to ${diagnosticsOut}`);
        for (const pool of pools) {
            const label = `${pool.baseSymbol || pool.tokenXSymbol || short(pool.baseMint || pool.tokenXMint)}/${pool.quoteSymbol || pool.tokenYSymbol || short(pool.quoteMint || pool.tokenYMint)}`;
            console.log(`  ${pool.dexType || pool.type || pool.dex || 'UNKNOWN'} ${label} pool=${short(poolAddressOf(pool))}`);
        }
        return;
    }

    const stats = { orca: 0, raydiumClmm: 0, raydiumCpmm: 0, meteoraDlmm: 0, dammV2: 0, pancakeswapAmm: 0, pumpswap: 0 };
    const fetchPlan = directAddressOnly ? ['Direct selected addresses'] : [
        'Orca',
        'Raydium CLMM',
        'Raydium CPMM',
        'Meteora DLMM',
        args.includeDammV2 ? 'Meteora DAMM v2' : null,
        args.includePancakeswap ? 'PancakeSwap AMM' : null,
        args.includePumpswap ? 'PumpSwap' : null,
    ].filter(Boolean);
    console.log(`Fetch plan: ${fetchPlan.join(', ')}`);
    if (args.planOnly) {
        console.log('\nPlan-only mode: no fetches run and no files written.');
        return;
    }

    // ── Parallel fetch with individual timeouts ──────────────────────────────
    // Promise.allSettled means a single DEX failure or timeout never kills the
    // entire run. Each fetch gets its own 25-second deadline (well inside the
    // 30-second CONFIG.TIMEOUT) so the whole batch resolves in < 30 s.
    const FETCH_TIMEOUT_MS = 25_000;
    console.log('\nFetching enabled DEXes in parallel (individual 25 s timeouts)...');

    const settled = await Promise.allSettled([
        directAddressOnly ? Promise.resolve([]) : withTimeout(fetchOrcaWhirlpools(), FETCH_TIMEOUT_MS, 'Orca'),
        directAddressOnly ? Promise.resolve([]) : withTimeout(fetchRaydiumCLMM(), FETCH_TIMEOUT_MS, 'Raydium CLMM'),
        directAddressOnly ? Promise.resolve([]) : withTimeout(fetchRaydiumCPMM(), FETCH_TIMEOUT_MS, 'Raydium CPMM'),
        directAddressOnly ? Promise.resolve([]) : withTimeout(fetchMeteoraDLMM(), FETCH_TIMEOUT_MS, 'Meteora DLMM'),
        !directAddressOnly && args.includeDammV2
            ? withTimeout(fetchMeteoraDAMMV2(), FETCH_TIMEOUT_MS, 'Meteora DAMM v2')
            : Promise.resolve([]),
        !directAddressOnly && args.includePancakeswap
            ? withTimeout(fetchPancakeswapAMM(), FETCH_TIMEOUT_MS, 'PancakeSwap AMM')
            : Promise.resolve([]),
        !directAddressOnly && args.includePumpswap
            ? withTimeout(fetchPumpswapPools(args), FETCH_TIMEOUT_MS, 'Pumpswap')
            : Promise.resolve([]),
    ]);

    const [
        orcaResult, raydiumClmmResult, raydiumCpmmResult,
        meteoraDlmmResult, dammV2Result, pancakeResult, pumpswapResult,
    ] = settled;

    function unwrap(result, label) {
        if (result.status === 'fulfilled') return result.value || [];
        console.error(`  [WARN] ${label} fetch failed: ${result.reason?.message || result.reason}`);
        return [];
    }

    const orcaPools = unwrap(orcaResult, 'Orca');
    const raydiumClmmPools = unwrap(raydiumClmmResult, 'Raydium CLMM');
    const raydiumCpmmPools = unwrap(raydiumCpmmResult, 'Raydium CPMM');
    const meteoraDlmmPools = unwrap(meteoraDlmmResult, 'Meteora DLMM');
    const dammV2Pools = unwrap(dammV2Result, 'Meteora DAMM v2');
    const pancakeswapAmmPools = unwrap(pancakeResult, 'PancakeSwap AMM');
    const pumpswapPools = unwrap(pumpswapResult, 'Pumpswap');
    let directAddressPools = [];
    const directAddresses = addressSelectors(args);
    if (directAddresses.length) {
        try {
            directAddressPools = await fetchSelectedPoolsByAddress(directAddresses);
        } catch (error) {
            console.warn(`  [WARN] Direct selected-address fetch failed: ${error.message}`);
        }
    }

    stats.orca = orcaPools.length;
    stats.raydiumClmm = raydiumClmmPools.length;
    stats.raydiumCpmm = raydiumCpmmPools.length;
    stats.meteoraDlmm = meteoraDlmmPools.length;
    stats.dammV2 = dammV2Pools.length;
    stats.pancakeswapAmm = pancakeswapAmmPools.length;
    stats.pumpswap = pumpswapPools.length;

    // Combine all pools
    const fetchedPools = mergePoolsByAddress(
        directAddressPools,
        orcaPools,
        raydiumClmmPools,
        raydiumCpmmPools,
        meteoraDlmmPools,
        dammV2Pools,
        pancakeswapAmmPools,
        pumpswapPools,
    );

    let allPools = [...fetchedPools];
    if (args.selectedOnly) {
        allPools = allPools.filter((pool) => poolMatchesSelectedSet(pool, args.selectedPools, args.against));
    }
    if (args.pairSelectorOnly) {
        allPools = allPools.filter((pool) => poolMatchesPairSelector(pool, args.pairSelectors));
    }
    allPools = applyPoolExclusions(allPools, args.excludePools);
    if (args.qualityOnly) {
        allPools = filterQualityPools(allPools, {
            minTvlUsd: args.qualityMinLiquidity,
            maxFeeBps: args.qualityMaxFeeBps,
        });
    }

    const selectionDiagnostics = buildSelectionDiagnostics(fetchedPools, allPools, args);

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log(`  Orca Whirlpools: ${stats.orca}`);
    console.log(`  Raydium CLMM:    ${stats.raydiumClmm}`);
    console.log(`  Raydium CPMM:    ${stats.raydiumCpmm}`);
    console.log(`  Meteora DLMM:    ${stats.meteoraDlmm}`);
    console.log(`  Meteora DAMM v2: ${stats.dammV2}`);
    console.log(`  PancakeSwap AMM:     ${stats.pancakeswapAmm}`);
    console.log(`  Pumpswap:     ${stats.pumpswap}`);
    console.log(`Total selectedPools: ${allPools.length}`);
    if (args.selectedOnly) {
        console.log(`Selected-set filter dropped: ${selectionDiagnostics.totals.dropped}/${selectionDiagnostics.totals.fetched}`);
        console.log(`Dropped by reason: ${JSON.stringify(selectionDiagnostics.droppedByReason)}`);
        console.log(`Dropped by dex: ${JSON.stringify(selectionDiagnostics.droppedByDex)}`);
    }

    // Triangle readiness check
    const solPools = allPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const usdcPools = allPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const solUsdcDirect = allPools.filter(p =>
        (p.baseMint === SOL && p.quoteMint === USDC) ||
        (p.baseMint === USDC && p.quoteMint === SOL)
    );

    console.log(`\nTriangle readiness:`);
    console.log(`  Pools with SOL:  ${solPools.length}`);
    console.log(`  Pools with USDC: ${usdcPools.length}`);
    console.log(`  SOL/USDC direct: ${solUsdcDirect.length}`);

    // Show top pools
    console.log(`\nTop 50 pools by liquidity:`);
    const sorted = [...allPools].sort((a, b) => poolTvlUsd(b) - poolTvlUsd(a));
    for (const p of sorted.slice(0, 70)) {
        console.log(`  $${(poolTvlUsd(p) / 1e6).toFixed(2)}M | ${p.baseSymbol}/${p.quoteSymbol} [${p.type}] @ ${p.dex}`);
    }

    // Save
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(allPools, null, 2));
    console.log(`\n✓ Saved ${allPools.length} pools to ${outputFile}`);
    fs.mkdirSync(path.dirname(path.resolve(diagnosticsOut)), { recursive: true });
    fs.writeFileSync(diagnosticsOut, JSON.stringify(selectionDiagnostics, null, 2));
    console.log(`✓ Saved selection diagnostics to ${diagnosticsOut}`);
    const logicalFetches = directAddressOnly ? 1 : 4 + (args.includeDammV2 ? 1 : 0) + (args.includePancakeswap ? 1 : 0) + (args.includePumpswap ? 1 : 0);
    const altNotes = [];
    if (args.includeDammV2) altNotes.push('DAMM v2');
    if (args.includePancakeswap) altNotes.push('PancakeSwap');
    if (args.includePumpswap) altNotes.push('PumpSwap');
    console.log(`\nAPI calls made: ${logicalFetches} logical fetches${altNotes.length ? ` (enabled alt DEX: ${altNotes.join(', ')})` : ' (alt DEX disabled)'}`);
}

module.exports = {
    fetchWithRetry,
    fetchOrcaWhirlpools,
    fetchRaydiumCLMM,
    fetchRaydiumCPMM,
    fetchMeteoraDLMM,
    fetchMeteoraDAMMV2,
    fetchPancakeswapAMM,
    fetchPumpswapPools,
    parseCliArgs,
    expandPoolSelectorInput,
    readPoolSelectorFile,
    poolMatchesPairSelector,
    looksLikePoolAddress,
    qualityReasons,
    filterQualityPools,
    poolMatchesSelectedSet,
    buildSelectionDiagnostics,
    POOL_ADDRESS_PRESETS,
    POOL_SELECTOR_PRESETS,
    main
};

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
// Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE = poisonPool 

// 

/*
 node utilities/fetch_pools_batch.js \
    --pool-selector stable_hop \
    --out tradePool/_STABLE_HOP.raw.json \
    --maxFee 5

  node _enrichment.js \
    --in tradePool/_STABLE_HOP.raw.json \
    --out tradePool/_STABLE_HOP_E.json \
    --concurrency 8 \
    --debug-summary \
    --debug-report reports/stable_hop_enrichment.json

    =============================================

 - --selectedSet triarb_1 → resolves all 12 pool addresses from the preset, routes through address-based matching
  - --selectedSet triarb_1,triarb_2 → combines both presets (18 addresses)
  - --selectedSet cbBTC,JUP:usdc,sol → legacy token-based path still works as before

  Your usage will be exactly as you described:
  node utilities/fetch_pools_batch.js \
    --selectedSet triarb_2 \
    --minLiquidity 100000 \
    --maxFee 2 \
    --against usdt,usdc,sol \
    --selected-pools pyUSD,RAY,WBTC,JLP,cbBTC \
     --require-sol-usdc=true \
    --out poolTrade/_SET_1.json

    --pool-selector=triarb_1 

  And you can combine presets: --selectedSet triarb_1,triarb_3,triarb_6 

     --against usdt,usdc,sol
    --selected-pools cbbtc,ray, \
    pools/raw_quality_candidates.json \
     --require-sol-usdc=true \
     --pool-selector=triarb_1 \

        node utilities/fetch_pools_batch.js \
        --selected-pools USDC/SOL
        --min-liquidity 300000 \
         --max-per-pair 4 \
         --max-fee-bps 3 \
        --out tradePool/_SOL_USDC.raw.json

          node utilities/_diagnose_triangles.js tradePool/_LST.raw_B.json \
            --routes-max-per-triangle 4 \
            --out tradePool/_LST.raw_B.json

            node utilities/_diagnose_pools2.js tradePool/_LST.raw_B.json \
            --merge tradePool/_LST.raw.json \
            --log-tvl True \
            --out tradePool/_LST.raw.json

        node utilities/fetch_pools_batch.js \
        --min-liquidity 8000000 \
        --selected-pools JUP,jitoSOL,JLP,cbBTC,bonk,pengu,met


    --selected-pools wbtc,ray,trump,cbBTC,bonk,pengu,met,popcat,jlp,jup,jitoSol \
    --against usdc,sol










    

    */
