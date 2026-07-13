/* ============================================================================
 *  REHYDRATE  —  refresh live state of a CURATED pool set, nothing else
 * ============================================================================
 *
 *  THE NEED (your operational point, correct)
 *  ------------------------------------------
 *  Discovery re-fetches hundreds of pools, is slow, costs RPC, and ADDS pools
 *  back into your hand-curated set. You don't want that every cycle.
 *
 *  But SKIP_FETCH=1 skipped hydration too, so the curated pools went stale and
 *  the freshness check rejected everything (0/0).
 *
 *  What you actually want: a cheap step that takes your curated file, refreshes
 *  ONLY those pools' live on-chain state (tick state, DLMM live fee), re-stamps
 *  freshness, and writes the SAME set back — no discovery, no additions, no
 *  re-filtering. That's this file.
 *
 *  COST: one batched getMultipleAccountsInfo over your curated addresses (~your
 *  27 pools), per cycle. Tiny vs re-discovering hundreds. Your curation is
 *  preserved exactly — same pools in, same pools out, only their live state
 *  updated.
 *
 *  USAGE (in the loop, REPLACES the fetch/build step):
 *     node utilities/rehydrate.js --pools tradePool/_MEME.trade.json
 *  Reads the curated file, refreshes it in place, writes it back. Done.
 *
 *  CURATION (run ONCE, by hand, when you change your pool set):
 *     node utilities/build_MEME_PoolSet.js --fetch --out tradePool/_MEME.trade.json --hydrate
 *  That discovers + filters + hydrates the initial curated set. After that, the
 *  loop only ever calls rehydrate.js — never re-discovers.
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { Connection } = require('@solana/web3.js');
const { hydrateTickState } = require('./onchainTickHydration.js');
const { hydrateDlmmLiveFees } = require('./dlmmLiveFeeHydration.js');
const { stampFreshness } = require('./freshnessStamp.js');

function rpcUrl() {
    return process.env.RPC_URL
        || process.env.HELIUS_ENDPOINT2
        || process.env.HELIUS_ENDPOINT3
        || 'https://api.mainnet-beta.solana.com';
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = { pools: 'tradePool/_MEME.curated_E.json', debug: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i], next = argv[i + 1];
        if (a === '--pools' && next) { args.pools = next; i += 1; }
        else if (a === '--debug') args.debug = true;
    }
    return args;
}

async function rehydrate(poolFile, opts = {}) {
    const debug = !!opts.debug;
    const resolved = path.resolve(poolFile);

    // read the CURATED set — exactly as-is, no filtering, no additions
    let pools;
    try {
        pools = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
        throw new Error(`cannot read curated pool file ${poolFile}: ${e.message}`);
    }
    if (!Array.isArray(pools)) {
        // tolerate {pools:[...]} shape but write back the same shape we read
        if (Array.isArray(pools.pools)) {
            const wrapped = pools;
            const inner = pools.pools;
            await refreshInPlace(inner, debug);
            fs.writeFileSync(resolved, `${JSON.stringify(wrapped, null, 2)}\n`);
            return { count: inner.length };
        }
        throw new Error(`curated pool file is not an array: ${poolFile}`);
    }

    const before = pools.length;
    await refreshInPlace(pools, debug);

    // write back the SAME set — count must be unchanged (no additions)
    fs.writeFileSync(resolved, `${JSON.stringify(pools, null, 2)}\n`);
    if (pools.length !== before) {
        console.warn(`[rehydrate] WARNING: pool count changed ${before} -> ${pools.length} (should be equal)`);
    }
    return { count: pools.length };
}

async function refreshInPlace(pools, debug) {
    const conn = new Connection(rpcUrl(), 'confirmed');
    // refresh live on-chain state of the EXISTING pools only
    await hydrateTickState(pools, conn, { debug });        // sqrtPriceX64 + tickArrays
    await hydrateDlmmLiveFees(pools, conn, { debug });      // liveFeeBps (the spike signal)
    await stampFreshness(pools, conn, { debug });           // hydratedAt (clears 0/0)
    if (debug) {
        const stamped = pools.filter((p) => p.hydratedAt).length;
        console.log(`[rehydrate] refreshed ${pools.length} curated pools, ${stamped} stamped fresh`);
    }
}

async function main() {
    const args = parseArgs();
    const res = await rehydrate(args.pools, { debug: args.debug });
    console.log(`[rehydrate] ${args.pools} -> ${res.count} pools refreshed in place (no discovery, no additions)`);
}

module.exports = { rehydrate };

if (require.main === module) {
    main().catch((e) => {
        console.error(`rehydrate failed: ${e.stack || e.message}`);
        process.exit(1);
    });
}
