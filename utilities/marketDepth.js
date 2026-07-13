'use strict';
/* marketDepth.js — per-leg depth/impact instrument + dynamic slippage.
 * No new RPC and no new dependency: it reuses the spot price you already
 * have (the scanner's `mid`, or sqrtPriceX64) and the quote you already run.
 * BigInt for the atomic diff; Number only for the bps ratio. */

/** No-impact spot from sqrtPriceX64. NOTE: Number() loses precision above 2^53,
 *  so prefer feeding estimateImpactBps the scanner's already-precise `mid`.
 *  This is a convenience only. price(B per A) = (sqrtX64/2^64)^2, decimal-adjusted. */
function spotOutPerInFromSqrtX64(sqrtPriceX64, decIn, decOut, aToB) {
  const raw = Number(sqrtPriceX64) / 2 ** 64;
  const priceBperA = raw * raw;
  const decAdj = Math.pow(10, decIn - decOut);
  return aToB ? priceBperA * decAdj : (1 / priceBperA) * decAdj;
}

/** Impact = how far the realized quote sits below the no-impact spot, in bps.
 *  spotOut and quotedOut must be SAME units (atomic or human, just consistent).
 *  +ve = normal impact (got less than spot). -ve = quote ABOVE spot => over-quote/suspect. */
function estimateImpactBps(spotOut, quotedOut) {
  if (!Number.isFinite(Number(spotOut)) || !Number.isFinite(Number(quotedOut))) return null;
  const s = BigInt(Math.round(Number(spotOut)));
  const q = BigInt(Math.round(Number(quotedOut)));
  if (s <= 0n) return null;
  return Number((s - q) * 1_000_000n / s) / 100;
}

/** Replace the flat 20 with a per-leg, pool-aware tolerance.
 *  Computable part scales with the leg's own impact (thin pools impact AND drift more).
 *  driftFloor is the part you CANNOT derive from the curve — buffer for price movement
 *  between quote and on-chain landing; raise it from recent volatility if you have it. */
function dynamicSlippageBps(impactBps, opts = {}) {
  const k = opts.k ?? 1.5, driftFloor = opts.driftFloor ?? 4;
  const min = opts.min ?? 5, max = opts.max ?? 80;
  const raw = Math.abs(Number(impactBps) || 0) * k + driftFloor;
  return Math.max(min, Math.min(max, Math.round(raw * 100) / 100));
}

/** Whole-route convenience: per-leg impact + tolerance, plus compounded route impact. */
function routeDepthProfile(legs, opts = {}) {
  const perLeg = legs.map((leg, i) => {
    const impactBps = estimateImpactBps(leg.spotOut, leg.quotedOut);
    return { leg: i + 1, impactBps, slippageBps: dynamicSlippageBps(impactBps, opts) };
  });
  const routeImpactBps = perLeg.reduce((a, l) => a + (Number(l.impactBps) || 0), 0);
  return { perLeg, routeImpactBps: Math.round(routeImpactBps * 100) / 100 };
}

module.exports = { spotOutPerInFromSqrtX64, estimateImpactBps, dynamicSlippageBps, routeDepthProfile };
