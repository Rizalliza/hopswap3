'use strict';
/**
 * freshnessGate.js — reject routes whose snapshot has drifted from live BEFORE
 * you spend a bundle-build / sim / RPC budget on them.
 *
 * The phantom profits (+144, +22.61) and the on-chain reverts (Custom:30 / 6036)
 * share one root cause: the route was ranked and the bundle's minOut was locked
 * from a pool snapshot that then aged. By the time the swap lands the pool has
 * moved, the min can't be met, and the whole atomic tx reverts. This gate
 * re-prices the winner's pools against FRESH state, measures how far each leg has
 * drifted, and skips the route if the drift is large enough that the snapshot can
 * no longer be trusted — before the build, not after a failed sim.
 *
 * Pure decision logic lives here and is fully tested. The fresh fetch is your
 * environment (RPC + adapters): wire fetchFreshLegOuts() to your existing
 * refreshPoolState.js + the same adapter quote you used for the snapshot. This
 * module never touches the network.
 *
 * Drift convention (per leg, re-quoted at the SAME input):
 *   driftBps = (freshOut - snapshotOut) / snapshotOut * 1e4
 *     driftBps < 0  -> pool now gives LESS than the snapshot promised (snapshot
 *                      OVER-quoted). The dangerous case: your minOut came from the
 *                      over-quote, so the swap reverts on-chain (your Custom:30).
 *     driftBps > 0  -> pool gives MORE now (snapshot under-quoted). Not dangerous
 *                      to execution, but still a staleness signal on the route.
 *
 * Amounts compared as BigInt (no precision loss); drift reported in bps. Advisory
 * gate, not settlement — simulate3LegChain stays the atomic truth.
 *
 * NOTE: re-quoting each leg at its snapshot input (per-leg drift) is the cheap,
 * sufficient staleness check and is what catches a +130 bps leg before the build.
 * A stronger variant re-chains (leg2 input = leg1 fresh out); you can upgrade
 * fetchFreshLegOuts to return a re-chained final later without touching this gate.
 * 
 *      utilities/freshnessGate.js, utilities/freshnessStamp.js,utilities/refreshPoolState.js
 */

/* -------------------------------------------------------------------------- */

function toBig(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || !Number.isInteger(x)) throw new Error(`non-integer amount: ${x}`);
    return BigInt(x);
  }
  if (typeof x === 'string' && /^-?\d+$/.test(x.trim())) return BigInt(x.trim());
  throw new Error(`unparseable amount: ${x}`);
}

/**
 * Signed drift in bps at 0.01 resolution, BigInt-safe. null if snapshot <= 0.
 */
function legDriftBps(snapshotOut, freshOut) {
  const s = toBig(snapshotOut);
  const f = toBig(freshOut);
  if (s <= 0n) return null;
  const scaled = ((f - s) * 1000000n) / s;   // signed, 1e6 scale
  return Number(scaled) / 100;                 // -> bps, 0.01 resolution
}

function snapshotLegOut(leg) {
  const v = leg.expectedOutputAmount
    ?? leg.expectedOutAtomic
    ?? leg.outAmountRaw
    ?? leg.amountOutRaw
    ?? leg.outAmount
    ?? leg.amountOut
    ?? leg.outputAmount;
  return v == null ? null : v;
}

/* -------------------------------------------------------------------------- */
/*                          single-route assessment                           */
/* -------------------------------------------------------------------------- */

/**
 * assessRoute(route, freshOuts, opts)
 *   freshOuts: array parallel to route.legs — each the fresh OUT amount for the
 *              SAME input (string|number|bigint), or null/undefined if the
 *              re-quote was unavailable for that leg.
 *   opts:
 *     maxDriftBps      default 25   reject if any leg's |drift| exceeds this
 *     adverseOnly      default false if true, only negative (over-quote) drift
 *                                    counts toward rejection; favorable ignored
 *     onMissing        'reject'|'pass'  default 'reject' — a leg we can't re-price
 *                                    fresh is exactly the one not to trust
 * Returns { keep, maxAbsDriftBps, worstAdverseBps, legs:[...], reasons:[...] }.
 */
function assessRoute(route, freshOuts = [], opts = {}) {
  const maxDriftBps = Number(opts.maxDriftBps ?? 25);
  const adverseOnly = Boolean(opts.adverseOnly);
  const onMissing = opts.onMissing || 'reject';

  const legs = route.legs || [];
  const out = [];
  const reasons = [];
  let maxAbsDriftBps = 0;
  let worstAdverseBps = 0;     // most-negative drift seen
  let keep = true;

  for (let i = 0; i < legs.length; i++) {
    const snap = snapshotLegOut(legs[i]);
    const fresh = freshOuts[i];

    if (snap == null) {
      out.push({ i: i + 1, status: 'no-snapshot', driftBps: null });
      reasons.push(`leg${i + 1}:no-snapshot-out`);
      if (onMissing === 'reject') keep = false;
      continue;
    }
    if (fresh == null) {
      out.push({ i: i + 1, status: 'fresh-unavailable', driftBps: null, snapOut: String(snap) });
      reasons.push(`leg${i + 1}:fresh-unavailable`);
      if (onMissing === 'reject') keep = false;
      continue;
    }

    let driftBps;
    try { driftBps = legDriftBps(snap, fresh); }
    catch (e) {
      out.push({ i: i + 1, status: 'parse-error', driftBps: null });
      reasons.push(`leg${i + 1}:${e.message}`);
      if (onMissing === 'reject') keep = false;
      continue;
    }
    if (driftBps == null) {
      out.push({ i: i + 1, status: 'snapshot-zero', driftBps: null });
      reasons.push(`leg${i + 1}:snapshot-zero`);
      if (onMissing === 'reject') keep = false;
      continue;
    }

    const absD = Math.abs(driftBps);
    if (absD > maxAbsDriftBps) maxAbsDriftBps = absD;
    if (driftBps < worstAdverseBps) worstAdverseBps = driftBps;

    let status = 'ok';
    const considered = adverseOnly ? Math.max(0, -driftBps) : absD;
    if (driftBps < 0 && absD > maxDriftBps) status = 'adverse-stale';
    else if (driftBps > 0 && absD > maxDriftBps) status = 'favorable-stale';
    else if (driftBps < 0) status = 'adverse';
    else if (driftBps > 0) status = 'favorable';

    if (considered > maxDriftBps) {
      keep = false;
      reasons.push(`leg${i + 1}:drift=${driftBps.toFixed(1)}bps>${maxDriftBps}`);
    }

    out.push({ i: i + 1, status, driftBps: Number(driftBps.toFixed(2)), snapOut: String(snap), freshOut: String(fresh) });
  }

  return {
    keep,
    maxAbsDriftBps: Number(maxAbsDriftBps.toFixed(2)),
    worstAdverseBps: Number(worstAdverseBps.toFixed(2)),
    legs: out,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/*                       batch filter (async, pluggable)                       */
/* -------------------------------------------------------------------------- */

/**
 * filterRoutesByFreshness(routes, fetchFreshLegOuts, opts)
 *
 *   fetchFreshLegOuts(route) => Promise<Array<string|number|bigint|null>>
 *     Return the fresh OUT amount per leg (same order as route.legs), re-priced
 *     on freshly-fetched pool state. Return null for a leg whose re-quote failed
 *     — the gate then treats it per opts.onMissing (default reject).
 *
 *   Runs sequentially by default to stay gentle on RPC; set opts.concurrency > 1
 *   to parallelise winners if your limiter allows.
 *
 * Returns { kept, rejected, ledger }.
 */
async function filterRoutesByFreshness(routes = [], fetchFreshLegOuts, opts = {}) {
  if (typeof fetchFreshLegOuts !== 'function') {
    throw new Error('filterRoutesByFreshness: fetchFreshLegOuts(route) function is required');
  }
  const kept = [], rejected = [];
  const byReason = {};

  const assessOne = async (route) => {
    let fresh;
    try { fresh = await fetchFreshLegOuts(route); }
    catch (e) { fresh = (route.legs || []).map(() => null); route._freshFetchError = e.message; }
    const a = assessRoute(route, fresh || [], opts);
    const tagged = { ...route, _freshness: { keep: a.keep, maxAbsDriftBps: a.maxAbsDriftBps, worstAdverseBps: a.worstAdverseBps, legs: a.legs, reasons: a.reasons } };
    if (a.keep) kept.push(tagged);
    else { rejected.push(tagged); for (const r of a.reasons) byReason[r] = (byReason[r] || 0) + 1; }
  };

  const concurrency = Math.max(1, Number(opts.concurrency || 1));
  if (concurrency === 1) {
    for (const r of routes) await assessOne(r);
  } else {
    for (let i = 0; i < routes.length; i += concurrency) {
      await Promise.all(routes.slice(i, i + concurrency).map(assessOne));
    }
  }

  return { kept, rejected, ledger: { in: routes.length, kept: kept.length, rejected: rejected.length, byReason } };
}

function formatLedger(ledger) {
  if (!ledger || Number(ledger.in || 0) === 0) {
    return '  freshness: not evaluated (0 quote-complete route(s) reached freshness gate)';
  }
  const lines = [`  freshness: ${ledger.kept}/${ledger.in} fresh enough to build, ${ledger.rejected} stale/skip`];
  for (const [reason, n] of Object.entries(ledger.byReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`     - ${String(n).padStart(4)}  ${reason}`);
  }
  return lines.join('\n');
}

module.exports = {
  toBig,
  legDriftBps,
  snapshotLegOut,
  assessRoute,
  filterRoutesByFreshness,
  formatLedger,
};

/* ── how to wire, right after ranking and BEFORE the bundle build ─────────────
 *
 *   const { filterRoutesByFreshness, formatLedger } = require('./freshnessGate');
 *
 *   // Re-price each leg of the route on FRESH state using machinery you already
 *   // have. Return one fresh OUT per leg (same order); null if a leg can't quote.
 *   async function fetchFreshLegOuts(route) {
 *     const pools = route.legs.map(l => l.pool || l.poolAddress);
 *     const fresh = await refreshPoolState(pools);            // your batched refetch
 *     return route.legs.map((leg, i) => {
 *       const q = quoteLegOnPool(fresh[i], leg.tokenInMint, leg.inAmountRaw, leg); // your adapter quote
 *       return (q && q.success) ? q.outAmountRaw : null;      // null => gate rejects this route
 *     });
 *   }
 *
 *   const { kept, ledger } = await filterRoutesByFreshness(rankedRoutes, fetchFreshLegOuts, {
 *     maxDriftBps: 25,        // matches your Jupiter verifier threshold
 *     onMissing: 'reject',    // a leg you can't re-price fresh is one you don't trust
 *   });
 *   console.log(formatLedger(ledger));
 *   // build / sim only `kept` — the +134 bps RAY leg never reaches the builder.
 * ───────────────────────────────────────────────────────────────────────────── */
