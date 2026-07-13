'use strict';
/**
 * routePreGate.js — cheap pre-sim culling for 3-leg triangular routes.
 *
 * Sits BETWEEN the divergence scanner and the size-aware quoter/simulator.
 * Its only job is to throw out routes that cannot profit, so simulate3LegChain
 * spends its budget on the handful that might. Nothing here submits, and
 * nothing here replaces the simulator.
 *
 * Two independent gates + a combined evaluator:
 *
 *   1) signalGate   — uses the divergence net the scanner ALREADY computed.
 *                     Cheap and OPTIMISTIC (mid-based, over-states edge). Its
 *                     only honest use is rejection: if even the over-stated net
 *                     can't beat the flash fee, the route is hopeless. Passing
 *                     it means "worth a closer look", never "profitable".
 *
 *   2) topPriceGate — the stronger check, and the one you asked for. It builds
 *                     each leg's EXECUTABLE marginal rate (the pool's spot price
 *                     at the active tick/bin, fee-adjusted and side-oriented) and
 *                     multiplies the three legs into an absolute round trip.
 *                     Unlike the mid, this has already paid the fee and picked
 *                     the side, so a route that fails here cannot profit even at
 *                     infinitesimal size — sim would only confirm the loss.
 *                     A route that PASSES here has marginal edge before impact;
 *                     sim then tells you whether your size keeps it.
 *
 * ADVISORY / FLOAT. This gate works in float price-ratios to cull cheaply. It
 * does NOT settle amounts. simulate3LegChain stays the atomic BigInt truth and
 * the only output you submit. The float here is fine because a round trip
 * returns to the same token, so per-leg decimal factors cancel.
 *
 * ── INTEGRATION SEAM ─────────────────────────────────────────────────────────
 * legExecRate() needs each leg's spot price as OUT-token per IN-token.
 * Cleanest wire-up (zero orientation guessing): in the scanner, where you
 * already compute the directional buyLow/sellHigh rate, stash it on the leg as
 *     leg.spotOutPerIn = <out tokens per 1 in token, fee-EXCLUSIVE>
 * and this gate is bulletproof. If you don't, it will try to DERIVE the rate
 * from leg.midPrice / leg.mid / leg.pairMidPrice, orienting by the in/out mints
 * against the pair's base/quote mints. If it cannot determine orientation it
 * returns null and the route is flagged 'top-uncomputable' — it never guesses a
 * price. Adapt deriveSpot() if your field names differ; it is the only place
 * field names matter.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BPS = 10000;

/* -------------------------------------------------------------------------- */
/*                               field helpers                                */
/* -------------------------------------------------------------------------- */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function legFeeBps(leg) {
  const f = num(leg.feeBps);
  return f == null ? null : f;
}

function legMints(leg) {
  return {
    inMint: String(leg.tokenInMint || leg.inputMint || leg.inMint || ''),
    outMint: String(leg.tokenOutMint || leg.outputMint || leg.outMint || ''),
  };
}

// The pair's canonical orientation, i.e. what a stored `mid` is denominated in.
// We look for an explicit base/quote, else token0/token1 (sorted-mint convention).
function pairBaseQuote(leg) {
  const base = String(leg.pairBaseMint || leg.baseMint || leg.token0Mint || leg.tokenXMint || '');
  const quote = String(leg.pairQuoteMint || leg.quoteMint || leg.token1Mint || leg.tokenYMint || '');
  if (base && quote) return { base, quote };
  return null;
}

/* -------------------------------------------------------------------------- */
/*                         spot / executable rate                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns { rate, source } where rate is OUT-per-IN spot (fee-EXCLUSIVE),
 * or { rate: null, reason } if it cannot be determined without guessing.
 */
function deriveSpot(leg) {
  // 1) Explicit directional spot — no orientation needed. Preferred.
  const explicit = num(leg.spotOutPerIn);
  if (explicit != null && explicit > 0) return { rate: explicit, source: 'spotOutPerIn' };

  // 2) Derive from a stored mid + orientation by mints.
  const mid = num(leg.midPrice ?? leg.mid ?? leg.pairMidPrice ?? leg.pairMid);
  if (mid == null || mid <= 0) return { rate: null, reason: 'no-spot-or-mid' };

  const { inMint, outMint } = legMints(leg);
  if (!inMint || !outMint) return { rate: null, reason: 'no-mints' };

  const bq = pairBaseQuote(leg);
  if (!bq) return { rate: null, reason: 'no-orientation-fields' };

  // Convention: mid is quote-per-base (OUT=quote per IN=base).
  if (inMint === bq.base && outMint === bq.quote) return { rate: mid, source: 'mid:base->quote' };
  if (inMint === bq.quote && outMint === bq.base) return { rate: 1 / mid, source: 'mid:quote->base' };

  // Mints don't line up with the stored base/quote — refuse rather than guess.
  return { rate: null, reason: 'orientation-mismatch' };
}

/**
 * Executable OUT-per-IN rate for the leg = spot * (1 - fee).
 * Returns { rate, source } or { rate: null, reason }.
 */
function legExecRate(leg) {
  const spot = deriveSpot(leg);
  if (spot.rate == null) return { rate: null, reason: spot.reason };

  const feeBps = legFeeBps(leg);
  if (feeBps == null) return { rate: null, reason: 'no-fee' };       // fail loud — never assume 0 fee
  if (feeBps < 0 || feeBps >= BPS) return { rate: null, reason: 'fee-out-of-range' };

  const rate = spot.rate * (1 - feeBps / BPS);
  return { rate, source: spot.source, feeBps };
}

/* -------------------------------------------------------------------------- */
/*                          impact (depth) penalty                            */
/* -------------------------------------------------------------------------- */

/**
 * Sum the per-leg depth impact the quoter already estimated but selection ignores.
 * Reads marketDepthImpactBps first (the depth model), then impactBps/impactBpsRaw.
 * Impact is always a cost, so it is summed as a positive penalty. Returns
 * { impactBps, haveAny } — impactBps is null when no leg reported a usable value
 * (so we never fabricate a penalty out of missing data).
 */
function routeImpactBps(route) {
  const legs = route.legs || [];
  let sum = 0, haveAny = false;
  for (const leg of legs) {
    const imp = num(leg.marketDepthImpactBps ?? leg.impactBps ?? leg.impactBpsRaw);
    if (imp != null) { sum += Math.abs(imp); haveAny = true; }
  }
  return { impactBps: haveAny ? round4(sum) : null, haveAny };
}

/* -------------------------------------------------------------------------- */
/*                            gate 2: top-price                               */
/* -------------------------------------------------------------------------- */

/**
 * Multiplies the three legs' executable rates into an absolute round trip.
 *   grossRtBps = (r1*r2*r3 - 1) * 1e4         (already net of pool fees)
 *   netRtBps   = grossRtBps - flashBps
 * Returns { computable, netRtBps, grossRtBps, ok, reason, legSources }.
 * If any leg's rate can't be derived, computable=false (never fabricated).
 */
function topPriceRoundTrip(route, opts = {}) {
  const flashBps = num(opts.flashBps) ?? 5;
  const minTopBps = num(opts.minTopBps) ?? 0;
  const applyImpact = opts.applyImpact !== false;
  const legs = route.legs || [];
  if (legs.length !== 3) {
    return { computable: false, netRtBps: null, grossRtBps: null, ok: false, reason: `legs!=3 (${legs.length})`, legSources: [] };
  }

  let product = 1;
  const legSources = [];
  for (let i = 0; i < 3; i++) {
    const er = legExecRate(legs[i]);
    if (er.rate == null) {
      return { computable: false, netRtBps: null, grossRtBps: null, ok: false, reason: `leg${i + 1}:${er.reason}`, legSources };
    }
    product *= er.rate;
    legSources.push(er.source);
  }

  const { impactBps } = routeImpactBps(route);
  const impactPenalty = (applyImpact && impactBps != null) ? impactBps : 0;
  const grossRtBps = (product - 1) * BPS;
  const netBeforeImpact = grossRtBps - flashBps;
  const netRtBps = netBeforeImpact - impactPenalty;
  return {
    computable: true,
    grossRtBps: round4(grossRtBps),
    netRtBps: round4(netRtBps),
    netBeforeImpactBps: round4(netBeforeImpact),
    impactBps: impactBps ?? null,
    ok: netRtBps >= minTopBps,
    okBeforeImpact: netBeforeImpact >= minTopBps,
    reason: null,
    legSources,
  };
}

/* -------------------------------------------------------------------------- */
/*                            gate 1: signal                                  */
/* -------------------------------------------------------------------------- */

function legEdgeBps(leg) {
  return num(leg.netSignalBps ?? leg.legNetSignal ?? leg.edgeBps ?? leg.signalBps ?? leg.edge);
}

/**
 * Optimistic mid-based net the scanner already produced. Prefer the route-level
 * value; fall back to summing per-leg edges minus per-leg fees.
 * Returns { signalNetBps, ok, source }.
 */
function signalGate(route, opts = {}) {
  const flashBps = num(opts.flashBps) ?? 5;
  const signalMarginBps = num(opts.signalMarginBps) ?? 0; // extra headroom above flash
  const applyImpact = opts.applyImpact !== false;

  let signalNetBps = num(route.netSignalBps ?? route.netSignal ?? route.net);
  let source = 'route.netSignalBps';

  if (signalNetBps == null) {
    const legs = route.legs || [];
    let edgeSum = 0, feeSum = 0, haveAny = false;
    for (const leg of legs) {
      const e = legEdgeBps(leg); const f = legFeeBps(leg);
      if (e != null) { edgeSum += e; haveAny = true; }
      if (f != null) feeSum += f;
    }
    if (!haveAny) return { signalNetBps: null, ok: false, source: 'none', reason: 'no-signal-fields' };
    signalNetBps = edgeSum - feeSum;
    source = 'sum(legEdges)-sum(legFees)';
  }

  const { impactBps } = routeImpactBps(route);
  const impactPenalty = (applyImpact && impactBps != null) ? impactBps : 0;
  const okBeforeImpact = (signalNetBps - flashBps) >= signalMarginBps;
  const effectiveNetBps = signalNetBps - flashBps - impactPenalty;
  const ok = effectiveNetBps >= signalMarginBps;
  return {
    signalNetBps: round4(signalNetBps),
    impactBps: impactBps ?? null,
    effectiveNetBps: round4(effectiveNetBps),
    okBeforeImpact,
    ok,
    source,
  };
}

/* -------------------------------------------------------------------------- */
/*                          combined evaluator                                */
/* -------------------------------------------------------------------------- */

/**
 * opts:
 *   gateMode          'both' (default) | 'signal' | 'top'
 *   unknownTopPolicy  'sim'  (default) | 'drop'   — what to do when top-price
 *                     is uncomputable for a route (missing/ambiguous spot).
 *                     'sim' lets it through to the simulator on the signal gate
 *                     alone (don't hide a route just because we lack its spot);
 *                     'drop' culls it.
 *   flashBps          default 5
 *   minTopBps         default 0   (top-price net round trip must clear this)
 *   signalMarginBps   default 0   (signal net must clear flash + this)
 *
 * Returns { keep, signal, top, reasons }.
 */
function evaluateRoute(route, opts = {}) {
  const gateMode = opts.gateMode || 'both';
  const unknownTopPolicy = opts.unknownTopPolicy || 'sim';

  const signal = signalGate(route, opts);
  const top = topPriceRoundTrip(route, opts);
  const reasons = [];

  const signalReason = () => (signal.okBeforeImpact ? 'impact-exceeds-edge' : 'signal-below-flash');
  const topReason = () => (top.okBeforeImpact ? 'impact-exceeds-edge(top)' : 'top-roundtrip-negative');

  let keep;
  if (gateMode === 'signal') {
    keep = signal.ok;
    if (!signal.ok) reasons.push(signalReason());
  } else if (gateMode === 'top') {
    if (top.computable) {
      keep = top.ok;
      if (!top.ok) reasons.push(topReason());
    } else {
      keep = unknownTopPolicy === 'sim';
      reasons.push(`top-uncomputable:${top.reason}`);
    }
  } else { // 'both'
    if (!signal.ok) { keep = false; reasons.push(signalReason()); }
    else if (top.computable) {
      keep = top.ok;
      if (!top.ok) reasons.push(topReason());
    } else {
      keep = unknownTopPolicy === 'sim';
      reasons.push(`top-uncomputable:${top.reason}`);
    }
  }

  return { keep, signal, top, reasons };
}

/**
 * Filter a route array. Returns { kept, rejected, ledger }.
 * ledger: { in, kept, rejected, byReason: {reason: count} }.
 */
function filterRoutes(routes = [], opts = {}) {
  const kept = [], rejected = [];
  const byReason = {};
  for (const route of routes) {
    const ev = evaluateRoute(route, opts);
    const tagged = { ...route, _preGate: { keep: ev.keep, signalNetBps: ev.signal.signalNetBps, topNetRtBps: ev.top.netRtBps, topComputable: ev.top.computable, reasons: ev.reasons } };
    if (ev.keep) kept.push(tagged);
    else {
      rejected.push(tagged);
      for (const r of ev.reasons) byReason[r] = (byReason[r] || 0) + 1;
    }
  }
  return { kept, rejected, ledger: { in: routes.length, kept: kept.length, rejected: rejected.length, byReason } };
}

function formatLedger(ledger) {
  const lines = [`  pre-gate: ${ledger.kept}/${ledger.in} kept for sim, ${ledger.rejected} culled`];
  for (const [reason, n] of Object.entries(ledger.byReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`     - ${n.toString().padStart(4)}  ${reason}`);
  }
  return lines.join('\n');
}

function round4(x) { return Number.isFinite(x) ? Number(x.toFixed(4)) : x; }

module.exports = {
  deriveSpot,
  legExecRate,
  routeImpactBps,
  topPriceRoundTrip,
  signalGate,
  evaluateRoute,
  filterRoutes,
  formatLedger,
};

/* ── how to wire into arbBot, before the quote loop ───────────────────────────
 *
 *   const { filterRoutes, formatLedger } = require('./routePreGate');
 *   const { kept, ledger } = filterRoutes(routes, {
 *     flashBps: 5,
 *     gateMode: 'both',          // signal cull + top-price confirm
 *     unknownTopPolicy: 'sim',   // until you annotate leg.spotOutPerIn
 *   });
 *   console.log(formatLedger(ledger));
 *   // ...then quote/simulate only `kept` instead of all `routes`.
 *
 * Best top-price accuracy: in the scanner, set leg.spotOutPerIn to the directional
 * out-per-in rate you already derive for buyLow/sellHigh. Then gateMode:'top'
 * (or 'both') runs with zero orientation ambiguity.
 * ───────────────────────────────────────────────────────────────────────────── */

//. node utilities/test_preGateImpact.js