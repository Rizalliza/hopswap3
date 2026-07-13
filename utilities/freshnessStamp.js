/* ============================================================================
 *  FRESHNESS STAMP  —  fixes "0/0 fresh enough to build"
 * ============================================================================
 *
 *  WHAT I GOT WRONG EARLIER, AND THE REAL CAUSE
 *  --------------------------------------------
 *  I first blamed the arbBot freshness gate. Reading the code: that gate is
 *  `enabled: envBool('FRESHNESS_GATE', false)` — OFF by default. So it is NOT
 *  what rejected you. The "0/0 fresh enough to build" comes from a PRE-BUILD
 *  freshness check, and the real root cause is simpler and it is in code I wrote:
 *
 *  NONE of the hydration scripts (buildLstSolPoolSet.js, build_MEME_PoolSet.js,
 *  mergePoolsForVolatility.js) stamp a freshness marker on the pools. grep for
 *  hydratedAt / fetchedAt / slot / Date.now in them returns NOTHING. So after
 *  hydration, a pool has tick state but no "when" — and any freshness check has
 *  no timestamp to read, so it treats every pool as unverifiable/stale -> 0/0.
 *
 *  Compounded by SKIP_FETCH=1: the pools are never re-hydrated, so even the tick
 *  state can go stale, and there is still no timestamp. Result: nothing builds.
 *
 *  THE FIX
 *  -------
 *  Stamp each pool with hydratedAt (ms) and optionally the current slot at the
 *  moment of hydration. Call stampFreshness(pools, connection) at the END of
 *  each hydrate step, right after hydrateTickState + hydrateDlmmLiveFees.
 *
 *  WIRE-IN (build_MEME_PoolSet.js / buildLstSolPoolSet.js, in the `if (args.hydrate)`
 *  block, AFTER the existing hydrate calls):
 *
 *      const { stampFreshness } = require('./freshnessStamp');
 *      await hydrateTickState(pools, conn, { debug: args.debug });
 *      await hydrateDlmmLiveFees(pools, conn, { debug: args.debug });
 *      await stampFreshness(pools, conn);     // <-- add this
 *
 *  Then run with SKIP_FETCH=0 FETCH_EVERY=1 so hydration (and the stamp) refresh
 *  every cycle. The pre-build freshness check then sees a current hydratedAt and
 *  the routes build.
 *
 *  Also set, if your build check reads it:  FRESHNESS_ON_MISSING=allow
 *  (arbBot defaults onMissing='reject' — a pool with no freshness field is
 *   rejected. Until every pool is stamped, 'reject' nukes everything. Stamp them
 *   AND/OR set allow while you verify.)
 * ========================================================================== */

'use strict';

/**
 * stampFreshness — mark each pool with the time (and slot, if a connection is
 * given) it was hydrated, so downstream freshness checks have something to read.
 * Mutates pools in place. Safe to call without a connection (slot omitted).
 */
async function stampFreshness(pools = [], connection = null, opts = {}) {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    let slot = null;
    if (connection && typeof connection.getSlot === 'function') {
        try { slot = await connection.getSlot(opts.commitment || 'confirmed'); }
        catch { slot = null; }
    }
    for (const p of pools) {
        p.hydratedAt = now;
        p.fetchedAt = p.fetchedAt ?? now; // preserve ISO strings from API fetchers
        p.fetchedAtMs = now;
        p.lastUpdated = now;        // alias
        p.hydratedAtIso = iso;
        if (slot != null) {
            p.hydratedSlot = slot;
            p.slot = p.slot ?? slot; // don't clobber a pool-specific slot if present
        }
    }
    return { stamped: pools.length, at: now, slot };
}

/**
 * isFresh — helper a build check can use: pool is fresh if hydratedAt is within
 * maxAgeMs. Pools with no stamp are stale (caller decides reject vs allow).
 */
function isFresh(pool = {}, maxAgeMs = 30000) {
    const raw = pool.hydratedAt ?? pool.fetchedAtMs ?? pool.fetchedAt ?? pool.lastUpdated ?? 0;
    let t = Number(raw);
    if (!Number.isFinite(t) && typeof raw === 'string') {
        t = Date.parse(raw);
    }
    if (!t) return false;
    return (Date.now() - t) <= maxAgeMs;
}

module.exports = { stampFreshness, isFresh };
