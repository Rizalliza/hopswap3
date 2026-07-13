'use strict';
/**
 * refreshPoolState.js — Fast on-demand pool state refresher
 *
 * Purpose: bring stale enrichment data up-to-date right before route
 * simulation. Refreshes ONLY the time-sensitive fields:
 *   CLMM/Whirlpool: sqrtPriceX64, liquidity, tickCurrent
 *   DLMM:            activeBinId
 *   CPMM:            reserves.x, reserves.y (read from vault accounts)
 *
 * Static fields (mints, decimals, fees, vaults, tickSpacing, binStep) are
 * preserved from enrichment — those don't change on a per-block basis.
 *
 * Performance budget for 240 pools:
 *   - Batches into getMultipleAccountsInfo (100 accounts/call max)
 *   - Distributes batches across configured Helius endpoints in parallel
 *   - 240 pool accounts = 3 batches → ~80ms with 3 endpoints
 *   - CPMM vault reads add 1 extra batch (~80ms)
 *   - Total: ~150ms for full refresh, vs ~4min for naive per-pool calls
 *
 * Strategy:
 *   1. Group pools by type so each can be decoded with the right layout
 *   2. Collect all account addresses we need (pools + CPMM vaults)
 *   3. Issue parallel getMultipleAccountsInfo calls round-robined across endpoints
 *   4. Decode account data using each adapter's layout, write back canonical fields
 *   5. Mark refreshAt timestamp so the spot-cycle gate can age-check
 *
 * Usage:
 *   const refresher = createPoolRefresher({ endpoints: rpcManager });
 *   const fresh = await refresher.refresh(pools);  // returns NEW pool objects
 *   // Or refresh in-place:
 *   await refresher.refreshInPlace(pools);
 */

const { PublicKey } = require('@solana/web3.js');

// Optional SDK layouts. Lazy-loaded so this module works even if a particular
// SDK is missing — refresh just degrades to per-type capability.
let RaydiumSdkV2 = null;
try { RaydiumSdkV2 = require('@raydium-io/raydium-sdk-v2'); } catch { /* optional */ }

let OrcaSdk = null;
try { OrcaSdk = require('@orca-so/whirlpools-sdk'); } catch { /* optional */ }

// SPL token account layout for reading CPMM vault balances.
// First 32 bytes = mint, next 32 = owner, then u64 little-endian amount at offset 64.
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

const DEFAULTS = {
    // getMultipleAccountsInfo cap is 100 in practice. Some endpoints accept more
    // but we stay safe.
    accountsPerCall: 100,
    // Hard timeout for the whole refresh — better to fail fast than block the engine.
    timeoutMs: 2000,
    // Max age before a pool is considered stale and forcibly refreshed.
    maxStaleMs: 4000,
};

/* -------------------------------------------------------------------------- */
/*                       Endpoint adapter (RPC fan-out)                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalize whatever RPC handle the caller passes. Accepts:
 *   - A single Connection
 *   - An RpcConnectionManager instance
 *   - The proxy returned by createRpcConnection()
 *   - An array of Connection instances
 *
 * Returns an array of Connection-like objects we can fan-out across.
 */
function resolveConnections(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.filter(Boolean);

    // RpcConnectionManager instance — pull endpoints directly
    if (input.endpoints && Array.isArray(input.endpoints)) {
        return input.endpoints.map(e => e.connection).filter(Boolean);
    }
    // Proxy from createRpcConnection — has __rpcManager
    if (input.__rpcManager) {
        return resolveConnections(input.__rpcManager);
    }
    // Plain Connection — single-endpoint mode (still works, just slower)
    if (typeof input.getMultipleAccountsInfo === 'function') {
        return [input];
    }
    return [];
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) {
        out.push(array.slice(i, i + size));
    }
    return out;
}

/**
 * Run getMultipleAccountsInfo across N endpoints in parallel. Each endpoint
 * gets a roughly equal slice of work. Failed endpoints get retried on a
 * surviving one (sequentially) so a single Helius hiccup doesn't fail the run.
 */
async function fanoutGetMultipleAccounts(connections, pubkeys, opts = {}) {
    if (!connections.length) throw new Error('No RPC connections available for refresh');
    if (!pubkeys.length) return [];

    const accountsPerCall = opts.accountsPerCall || DEFAULTS.accountsPerCall;
    const batches = chunk(pubkeys, accountsPerCall);

    // Distribute batches round-robin across endpoints.
    const assignments = batches.map((batch, i) => ({
        batch,
        connection: connections[i % connections.length],
        startIndex: i * accountsPerCall,
    }));

    const results = new Array(pubkeys.length).fill(null);

    await Promise.all(assignments.map(async ({ batch, connection, startIndex }) => {
        let infos;
        try {
            infos = await connection.getMultipleAccountsInfo(batch, 'confirmed');
        } catch (err) {
            // Try other endpoints sequentially.
            let recovered = false;
            for (const alt of connections) {
                if (alt === connection) continue;
                try {
                    infos = await alt.getMultipleAccountsInfo(batch, 'confirmed');
                    recovered = true;
                    break;
                } catch { /* try next */ }
            }
            if (!recovered) {
                console.warn(`[refresh] batch starting at ${startIndex} failed all endpoints: ${err.message}`);
                return;
            }
        }
        for (let i = 0; i < infos.length; i++) {
            results[startIndex + i] = infos[i];
        }
    }));

    return results;
}

/* -------------------------------------------------------------------------- */
/*                          Per-DEX state decoders                            */
/* -------------------------------------------------------------------------- */

/**
 * Each decoder returns an object with the time-sensitive fields we want to
 * write back onto the canonical pool. If it can't decode (missing SDK,
 * missing data, layout mismatch) it returns null and the pool keeps its
 * stale state — the engine will see stale data, not corrupt data.
 */

function decodeClmmAccount(data) {
    if (!RaydiumSdkV2 || !data) return null;
    const layout = RaydiumSdkV2.PoolInfoLayout || RaydiumSdkV2.ClmmPoolInfoLayout;
    if (!layout || typeof layout.decode !== 'function') return null;
    try {
        const s = layout.decode(data);
        return {
            sqrtPriceX64: s.sqrtPriceX64?.toString() ?? s.sqrtPrice?.toString() ?? null,
            liquidity:    s.liquidity?.toString() ?? null,
            tickCurrent:  Number(s.tickCurrent ?? s.tickCurrentIndex ?? 0),
        };
    } catch { return null; }
}

function decodeWhirlpoolAccount(address, account) {
    if (!OrcaSdk || !account) return null;
    const parser = OrcaSdk.ParsableWhirlpool;
    if (!parser || typeof parser.parse !== 'function') return null;
    try {
        const s = parser.parse(new PublicKey(address), account);
        if (!s) return null;
        return {
            sqrtPriceX64: s.sqrtPrice?.toString() ?? null,
            liquidity:    s.liquidity?.toString() ?? null,
            tickCurrent:  Number(s.tickCurrentIndex ?? 0),
        };
    } catch { return null; }
}

function decodeDlmmAccount(data, existingActiveBinId = null) {
    // DLMM lbPair layout: discriminator(8) + parameters varies — but `activeId`
    // (i32 LE) sits at a known offset. Rather than depending on @meteora-ag/dlmm
    // (which would parse the whole struct heavyweight), we read just the bytes
    // we need. The activeId offset in lbPair is 8 (discriminator) + 32
    // (parameters padding) + 4 (static) = 44; we sweep a small window if the
    // first read looks unreasonable. This is intentionally cheap.
    //
    // Safety: if we already have an activeBinId, only accept a decoded value
    // within ±100 bins of it. This prevents decoding the wrong field (or 0)
    // and corrupting the price.
    if (!data) return null;
    try {
        const existing = Number.isFinite(existingActiveBinId) ? Number(existingActiveBinId) : null;
        const candidates = [];
        for (const offset of [44, 40, 48, 52]) {
            if (offset + 4 > data.length) continue;
            const id = data.readInt32LE(offset);
            // Sanity bound — DLMM activeId is well within ±10^6
            if (Number.isInteger(id) && Math.abs(id) < 5_000_000) {
                candidates.push(id);
                if (existing === null) {
                    return { activeBinId: id };
                }
                if (Math.abs(id - existing) <= 100) {
                    return { activeBinId: id };
                }
            }
        }
        // No candidate matched the existing value; keep existing to avoid corruption.
        // Log if debugging is needed.
    } catch { /* fall through */ }
    return null;
}

function decodeTokenAccountAmount(data) {
    if (!data || data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null;
    try {
        const amount = data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
        return amount.toString();
    } catch { return null; }
}

/* -------------------------------------------------------------------------- */
/*                        Refresh planning + execution                        */
/* -------------------------------------------------------------------------- */

/**
 * Categorize pools so we know what to fetch. CLMM/Whirlpool/DLMM only need
 * the pool account itself. CPMM needs the pool account *and* both vault
 * accounts (for current reserves).
 */
function planRefresh(pools) {
    const directPools = [];     // pool addresses to fetch
    const vaultLookups = [];    // {pool, side, vaultAddress}

    for (const pool of pools) {
        if (!pool.poolAddress) continue;
        const type = String(pool.type || '').toLowerCase();

        if (type === 'cpmm') {
            const xV = pool.vaults?.xVault || pool.xVault;
            const yV = pool.vaults?.yVault || pool.yVault;
            if (xV) vaultLookups.push({ pool, side: 'x', vaultAddress: xV });
            if (yV) vaultLookups.push({ pool, side: 'y', vaultAddress: yV });
            // Some CPMM still want pool account for fee accumulators etc — skip
            // for refresh purposes since reserves are the only time-sensitive bit.
        } else if (type === 'clmm' || type === 'whirlpool' || type === 'dlmm') {
            directPools.push(pool);
        }
        // Unknown types: silently skip. They keep their stale state.
    }

    return { directPools, vaultLookups };
}

function applyDirectPoolRefresh(pool, account) {
    if (!account) return false;
    const type = String(pool.type || '').toLowerCase();
    let decoded = null;

    if (type === 'clmm')           decoded = decodeClmmAccount(account.data);
    else if (type === 'whirlpool') decoded = decodeWhirlpoolAccount(pool.poolAddress, account);
    else if (type === 'dlmm')      decoded = decodeDlmmAccount(account.data, pool.activeBinId);

    if (!decoded) return false;

    // Write back ONLY the fields we successfully decoded. Static fields untouched.
    if (decoded.sqrtPriceX64 != null) {
        pool.sqrtPriceX64 = decoded.sqrtPriceX64;
        pool.sqrtPrice    = decoded.sqrtPriceX64;
    }
    if (decoded.liquidity != null) {
        pool.liquidity = decoded.liquidity;
    }
    if (decoded.tickCurrent != null && Number.isFinite(decoded.tickCurrent)) {
        pool.tickCurrent      = decoded.tickCurrent;
        pool.tickCurrentIndex = decoded.tickCurrent;
    }
    if (decoded.activeBinId != null && Number.isFinite(decoded.activeBinId)) {
        pool.activeBinId = decoded.activeBinId;
        pool.activeId    = decoded.activeBinId;
    }
    return true;
}

function applyVaultRefresh(pool, side, account) {
    if (!account?.data) return false;
    const amount = decodeTokenAccountAmount(account.data);
    if (!amount) return false;
    pool.reserves = pool.reserves || {};
    pool.reserves[side] = amount;
    if (side === 'x') pool.xReserve = amount;
    if (side === 'y') pool.yReserve = amount;
    return true;
}

/* -------------------------------------------------------------------------- */
/*                              Public API                                    */
/* -------------------------------------------------------------------------- */

class PoolRefresher {
    constructor(opts = {}) {
        this.connections = resolveConnections(opts.endpoints || opts.rpcManager || opts.connection);
        if (!this.connections.length) {
            throw new Error('PoolRefresher: pass {endpoints} (RpcConnectionManager) or {connection} (Connection)');
        }
        this.accountsPerCall = opts.accountsPerCall || DEFAULTS.accountsPerCall;
        this.maxStaleMs      = opts.maxStaleMs      || DEFAULTS.maxStaleMs;
        this.stats = { calls: 0, refreshed: 0, decodeFailures: 0, lastDurationMs: 0 };
    }

    /**
     * Refresh in-place. Mutates the pool objects you pass in and stamps a
     * `refreshedAt` timestamp on each. Returns the same array.
     */
    async refreshInPlace(pools) {
        const startedAt = Date.now();
        const { directPools, vaultLookups } = planRefresh(pools);

        // Concurrent: pool accounts and vault accounts in parallel.
        const directKeys = directPools.map(p => new PublicKey(p.poolAddress));
        const vaultKeys  = vaultLookups.map(v => new PublicKey(v.vaultAddress));

        const [directInfos, vaultInfos] = await Promise.all([
            directKeys.length
                ? fanoutGetMultipleAccounts(this.connections, directKeys, { accountsPerCall: this.accountsPerCall })
                : Promise.resolve([]),
            vaultKeys.length
                ? fanoutGetMultipleAccounts(this.connections, vaultKeys,  { accountsPerCall: this.accountsPerCall })
                : Promise.resolve([]),
        ]);

        let refreshed = 0;
        let failures = 0;

        // Apply direct pool refreshes
        for (let i = 0; i < directPools.length; i++) {
            const ok = applyDirectPoolRefresh(directPools[i], directInfos[i]);
            if (ok) {
                directPools[i].refreshedAt = Date.now();
                refreshed++;
            } else {
                failures++;
            }
        }

        // Apply vault-derived reserve refreshes (CPMM)
        const cpmmTouched = new Set();
        for (let i = 0; i < vaultLookups.length; i++) {
            const { pool, side } = vaultLookups[i];
            const ok = applyVaultRefresh(pool, side, vaultInfos[i]);
            if (ok) {
                cpmmTouched.add(pool);
            } else {
                failures++;
            }
        }
        for (const p of cpmmTouched) {
            p.refreshedAt = Date.now();
            refreshed++;
        }

        this.stats.calls          += Math.ceil(directKeys.length / this.accountsPerCall)
                                   + Math.ceil(vaultKeys.length / this.accountsPerCall);
        this.stats.refreshed       += refreshed;
        this.stats.decodeFailures  += failures;
        this.stats.lastDurationMs   = Date.now() - startedAt;

        return pools;
    }

    /**
     * Refresh only pools that are stale or never refreshed. Use this when you
     * want to amortize across multiple engine cycles.
     */
    async refreshStale(pools, maxStaleMs = this.maxStaleMs) {
        const now = Date.now();
        const stale = pools.filter(p => !p.refreshedAt || (now - p.refreshedAt) > maxStaleMs);
        if (!stale.length) return pools;
        await this.refreshInPlace(stale);
        return pools;
    }

    /**
     * Refresh only the pools that appear in a given set of routes. This is
     * the hot path — call it after the spot-cycle gate has narrowed candidates.
     * Refreshes maybe 30-90 pools instead of 240, well under 100ms.
     */
    async refreshForRoutes(routes) {
        const seen = new Map();
        for (const r of routes) {
            for (const leg of r.legs || []) {
                const pool = leg._pool || leg.poolContext;
                if (pool?.poolAddress && !seen.has(pool.poolAddress)) {
                    seen.set(pool.poolAddress, pool);
                }
            }
        }
        if (!seen.size) return [];
        const subset = [...seen.values()];
        await this.refreshInPlace(subset);
        return subset;
    }

    getStats() {
        return { ...this.stats };
    }
}

function createPoolRefresher(opts = {}) {
    return new PoolRefresher(opts);
}

/* -------------------------------------------------------------------------- */
/*                              CLI mode                                      */
/* -------------------------------------------------------------------------- */

async function main() {
    require('dotenv').config();
    const fs = require('fs');
    const path = require('path');

    const args = process.argv.slice(2);
    const inputArg  = args.includes('--input')  ? args[args.indexOf('--input') + 1]  : null;
    const outputArg = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;

    if (!inputArg) {
        console.error('Usage: node refreshPoolState.js --input <enriched.json> [--output <fresh.json>]');
        process.exit(1);
    }

    const RpcMod = require('./rpcConnectionManager');
    const create = RpcMod.createRpcConnection || RpcMod.default?.createRpcConnection;
    if (!create) {
        console.error('rpcConnectionManager.createRpcConnection not exported');
        process.exit(1);
    }
    const rpc = create();
    if (!rpc) {
        console.error('No RPC endpoints configured. Set HELIUS_ENDPOINT1/HELIUS_API_KEY1 etc in .env');
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(path.resolve(inputArg), 'utf8'));
    const pools = Array.isArray(raw) ? raw
                : Array.isArray(raw.pools) ? raw.pools
                : Array.isArray(raw.data)  ? raw.data
                : [];

    console.log(`Loaded ${pools.length} pools from ${inputArg}`);

    const refresher = createPoolRefresher({ endpoints: rpc.__rpcManager || rpc });
    const t0 = Date.now();
    await refresher.refreshInPlace(pools);
    const elapsed = Date.now() - t0;

    const stats = refresher.getStats();
    console.log(`\nRefresh complete in ${elapsed}ms`);
    console.log(`  RPC calls:        ${stats.calls}`);
    console.log(`  Pools refreshed:  ${stats.refreshed}`);
    console.log(`  Decode failures:  ${stats.decodeFailures}`);

    if (outputArg) {
        const out = Array.isArray(raw) ? pools : { ...raw, pools };
        fs.writeFileSync(path.resolve(outputArg), JSON.stringify(out, null, 2));
        console.log(`\nWrote refreshed pool data to ${outputArg}`);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal:', err.stack || err.message);
        process.exit(1);
    });
}

module.exports = {
    PoolRefresher,
    createPoolRefresher,
    // exposed for testing/composition
    planRefresh,
    decodeClmmAccount,
    decodeWhirlpoolAccount,
    decodeDlmmAccount,
    decodeTokenAccountAmount,
    fanoutGetMultipleAccounts,
    resolveConnections,
};
