'use strict';
/**
 * cpmmCalibrate.js — pin down WHY a Raydium constant-product quote disagrees with
 * the on-chain swap, by decomposing the output across the reserve-composition terms
 * that AMM v4 prices against but a raw-vault quote ignores.
 *
 * Context: Q_CPMM's live path dispatches on the pool account owner.
 *   - CPMM (CPMMoo8L...) branch is correct: reserve = vault - protocol/fund/creator fees.
 *   - AMM v4 (675kPX9M...) branch uses RAW VAULT balances. That is not the v4 reserve.
 *
 * Raydium AMM v4 prices against:
 *     reserve = vault_balance + open_orders_total - need_take_pnl
 *   Omitting open_orders under-states reserve (under-quote); omitting need_take_pnl
 *   over-states it (over-quote). Post-OpenBook pools usually have ~0 in open orders
 *   but a nonzero need_take_pnl, so a raw-vault quote reads HIGH — the +130 you see.
 *
 * This tool takes the raw components for both sides plus the on-chain actual output,
 * and shows how each correction moves the number and which model matches the chain.
 * BigInt throughout (no precision loss); bps reported as floats for reading.
 */

const { toBig, curveOut, v4Reserve, bps } = require('./helpers/cpmm');

/**
 * decompose({ inSide:{vault,openOrders,needTakePnl}, outSide:{...},
 *             amountIn, feeBps, onchainOut })
 * Returns the output under three reserve models + which one matches the chain.
 */
function decompose(params) {
  const { inSide, outSide, amountIn, feeBps } = params;
  const onchainOut = params.onchainOut != null ? toBig(params.onchainOut) : null;

  // in/out reserves under each progressive correction
  const inRaw = toBig(inSide.vault);
  const outRaw = toBig(outSide.vault);
  const inPlusOO = inRaw + toBig(inSide.openOrders || 0);
  const outPlusOO = outRaw + toBig(outSide.openOrders || 0);
  const inV4 = v4Reserve(inSide);
  const outV4 = v4Reserve(outSide);

  const models = {
    rawVault:   curveOut(inRaw,    outRaw,    amountIn, feeBps),  // what your v4 branch does now
    plusOpenOrders: curveOut(inPlusOO, outPlusOO, amountIn, feeBps),
    v4Correct:  curveOut(inV4,     outV4,     amountIn, feeBps),  // vault + OO - needTakePnl
  };

  const out = { models: {}, amountIn: String(toBig(amountIn)), feeBps, onchainOut: onchainOut != null ? String(onchainOut) : null };
  for (const [name, v] of Object.entries(models)) {
    out.models[name] = {
      out: String(v),
      vsOnchainBps: onchainOut != null ? bps(v, onchainOut) : null,
    };
  }

  // term contributions (how many bps each correction moves the output)
  out.contributions = {
    openOrdersBps: bps(models.plusOpenOrders, models.rawVault),   // adding OO (usually >=0)
    needTakePnlBps: bps(models.v4Correct, models.plusOpenOrders), // subtracting pnl (usually <=0)
    netCorrectionBps: bps(models.v4Correct, models.rawVault),     // raw -> corrected
  };

  if (onchainOut != null) {
    // which model is closest to the chain
    let best = null, bestAbs = Infinity;
    for (const [name, v] of Object.entries(models)) {
      const g = Math.abs(bps(v, onchainOut));
      if (g < bestAbs) { bestAbs = g; best = name; }
    }
    out.matchesChain = best;
    out.matchAbsBps = Number(bestAbs.toFixed(2));
    out.verdict =
      best === 'v4Correct' ? 'v4 reserve formula (vault + openOrders - needTakePnl) reproduces the chain — fix the v4 branch to use it.'
      : best === 'rawVault' ? 'raw vault already matches — the gap is elsewhere (fee, decimals, or pool is not v4).'
      : 'openOrders alone matches — needTakePnl is ~0 here; add the openOrders term.';
  }
  return out;
}

function format(d) {
  const lines = [`  amountIn=${d.amountIn} feeBps=${d.feeBps}` + (d.onchainOut ? ` onchain=${d.onchainOut}` : '')];
  for (const [name, m] of Object.entries(d.models)) {
    lines.push(`   ${name.padEnd(15)} out=${m.out}` + (m.vsOnchainBps != null ? `  (${m.vsOnchainBps >= 0 ? '+' : ''}${m.vsOnchainBps} bps vs chain)` : ''));
  }
  lines.push(`   contributions: openOrders ${d.contributions.openOrdersBps} bps | needTakePnl ${d.contributions.needTakePnlBps} bps | net ${d.contributions.netCorrectionBps} bps`);
  if (d.matchesChain) lines.push(`   => matches chain: ${d.matchesChain} (±${d.matchAbsBps} bps) — ${d.verdict}`);
  return lines.join('\n');
}

module.exports = { toBig, curveOut, v4Reserve, bps, decompose, format };
