/* ============================================================================
 *  DLMM LIVE-FEE HYDRATION  —  makes the fee-spike signal actually work
 * ============================================================================
 *
 *  THE BUG (found by reading volatilityTrigger.js, not by you hitting it)
 *  --------------------------------------------------------------------
 *  Your fee-spike signal can NEVER fire, for two stacked reasons:
 *
 *  1. Your pool data carries only feeBps=1 (the BASE fee). The live variable
 *     fee that spikes to ~30bps lives in the DLMM's on-chain volatility
 *     accumulator and is NEVER fetched. (Confirmed: 06_RESULT_DATA.json DLMM
 *     legs have feeBps=1, no liveFeeBps, no dynamicFeeBps.)
 *
 *  2. In volatilityTrigger.js, `live = poolFeeBps(p)` and `base =
 *     dlmmBaseFeeBps(p)` both resolve to the SAME static 1 (live has no live
 *     field to read; base is inferred from binStep as ~1). So `live >= base*3`
 *     is `1 >= 3` → always false. The signal is structurally incapable of
 *     firing with the data you feed it.
 *
 *  So when you SAW the fee spike on-chain, your instrumentation was blind to it.
 *  Your experience was right; the data was missing the number.
 *
 *  THE FIX
 *  -------
 *  This module reads the LIVE DLMM fee from chain (via @meteora-ag/dlmm, which
 *  you already depend on — used in tradeExecute.js:732 and binArray_util.js) and
 *  stamps two explicit fields on each DLMM pool:
 *      p.baseFeeBps  = the pool's configured base fee (the floor)
 *      p.liveFeeBps  = base + current variable fee (what a swap pays RIGHT NOW)
 *  Then the trigger compares liveFeeBps vs baseFeeBps and the spike fires when
 *  the variable fee actually rises.
 *
 *  WIRE-IN: call hydrateDlmmLiveFees(pools, connection) in your hydrate step
 *  (buildLstSolPoolSet.js, right after hydrateTickState), BEFORE writing the
 *  pool file. Non-DLMM pools are untouched.
 *
 *  Then apply the small trigger patch at the bottom so poolFeeBps prefers
 *  liveFeeBps and dlmmBaseFeeBps prefers the stamped baseFeeBps.
 * ========================================================================== */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');

function loadDlmmIdl() {
    const candidates = [
        () => require('@meteora-ag/dlmm').IDL,
        () => require('../SDK/meteora-dlmm-sdk-main/ts-client/src/dlmm/dlmm.json'),
        () => require('../SDK/meteora-dlmm-sdk-main/idls/dlmm.json'),
    ];
    for (const load of candidates) {
        try {
            const idl = load();
            if (idl && Array.isArray(idl.accounts)) return idl;
        } catch (_error) {
            // Try the next IDL source.
        }
    }
    return null;
}

function isDlmm(p = {}) {
    return String(p.dexType || p.type || p.dex || '').toLowerCase().includes('dlmm');
}
function poolAddrOf(p = {}) {
    return String(p.poolAddress || p.address || p.id || p.pool || '').trim();
}

// FEE_PRECISION = 1e10 (Meteora DLMM constant)
// base_fee_rate = base_factor * bin_step * 10 * 10^base_fee_power_factor / FEE_PRECISION
// variable_fee_rate = variable_fee_control * (volatility_accumulator * bin_step)^2 / 1e24
// All returned as percentages (0.25 = 25bps).
function computeFeesPct(params, vParams, binStep) {
    const bfpf = Number(params.base_fee_power_factor ?? 0);
    const baseFeeRate = Number(params.base_factor) * Number(binStep) * 10 * Math.pow(10, bfpf) / 1e10;
    const basePct = baseFeeRate * 100;

    const va = Number(vParams.volatility_accumulator ?? 0);
    const squaredVfa = (va * Number(binStep)) ** 2;
    const varFeeRate = Number(params.variable_fee_control) * squaredVfa / 1e24;
    const varPct = varFeeRate * 100;

    return { basePct, varPct };
}

/**
 * hydrateDlmmLiveFees — stamp baseFeeBps + liveFeeBps on each DLMM pool by
 * reading current fee state from chain. Mutates pools in place.
 *
 * Uses a single batched getMultipleAccountsInfo + borsh decode instead of
 * DLMM.create() per pool. This avoids N serial heavy SDK calls (each of which
 * fetches multiple accounts internally) that compete with arbBot.js's own
 * DLMM.create() calls and cause 429s.
 *
 * Returns { hydrated, failed }.
 */
async function hydrateDlmmLiveFees(pools = [], connection, opts = {}) {
    const debug = !!opts.debug;

    let dlmmCoder;
    try {
        const DLMM_IDL = loadDlmmIdl();
        if (!DLMM_IDL) throw new Error('DLMM IDL not found');
        dlmmCoder = new BorshAccountsCoder(DLMM_IDL);
    } catch (e) {
        if (debug) console.warn(`  [dlmm-fee] IDL not available: ${e.message}`);
        return { hydrated: 0, failed: 0, skipped: pools.filter(isDlmm).length };
    }

    const targets = pools.filter(isDlmm);
    if (!targets.length) return { hydrated: 0, failed: 0, skipped: 0 };

    // Single batched fetch for all LbPair accounts — one RPC call regardless of N.
    const pubkeys = targets.map((p) => new PublicKey(poolAddrOf(p)));
    let accounts;
    try {
        accounts = await connection.getMultipleAccountsInfo(pubkeys);
    } catch (e) {
        if (debug) console.warn(`  [dlmm-fee] batch fetch failed: ${e.message}`);
        return { hydrated: 0, failed: targets.length };
    }

    let hydrated = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        const addr = poolAddrOf(p);
        const account = accounts[i];
        if (!account?.data) {
            p.dlmmFeeError = 'account not found';
            failed++;
            if (debug) console.warn(`  [dlmm-fee] ${addr.slice(0, 6)} FAILED: no account`);
            continue;
        }
        try {
            const lbPair = dlmmCoder.decode('LbPair', account.data);
            if (!lbPair?.parameters) {
                p.dlmmFeeError = 'LbPair decode missing parameters';
                failed++;
                continue;
            }

            const binStep = Number(lbPair.bin_step ?? 0);
            const { basePct, varPct } = computeFeesPct(lbPair.parameters, lbPair.v_parameters ?? {}, binStep);
            const baseBps = basePct * 100;
            const varBps = varPct * 100;

            p.baseFeeBps = baseBps;
            // live = base + variable; guard against SDK versions that already include base in var
            p.liveFeeBps = (varBps >= baseBps) ? varBps : (baseBps + varBps);
            delete p.dlmmFeeError;
            hydrated++;
            if (debug) console.log(`  [dlmm-fee] ${addr.slice(0, 6)} base=${baseBps.toFixed(2)} live=${p.liveFeeBps.toFixed(2)}bps`);
        } catch (e) {
            p.dlmmFeeError = e.message;
            failed++;
            if (debug) console.warn(`  [dlmm-fee] ${addr.slice(0, 6)} FAILED: ${e.message}`);
        }
    }

    if (debug) console.log(`  [dlmm-fee] hydrated=${hydrated} failed=${failed}`);
    return { hydrated, failed };
}

module.exports = { hydrateDlmmLiveFees, _internals: { isDlmm } };

/* ============================================================================
 *  TRIGGER PATCH (volatilityTrigger.js) — make it USE the live fee
 *  --------------------------------------------------------------
 *  Two tiny edits so the spike compares live vs true base:
 *
 *  (A) poolFeeBps() already prefers p.liveFeeBps (line 184) — GOOD, no change.
 *      Once hydrateDlmmLiveFees stamps liveFeeBps, `live` becomes the real
 *      current fee automatically.
 *
 *  (B) dlmmBaseFeeBps() must prefer the STAMPED base, not the binStep guess.
 *      It already checks p.baseFeeBps FIRST (line 259) — GOOD. Once we stamp
 *      p.baseFeeBps, the circular binStep inference is bypassed.
 *
 *  So with this hydration in place, NO trigger code change is strictly needed —
 *  poolFeeBps picks up liveFeeBps, dlmmBaseFeeBps picks up baseFeeBps, and
 *  `live (30) >= base (1) * 3` finally evaluates TRUE. The spike fires.
 *
 *  VERIFY: after wiring, in a cycle where the DLMM fee is elevated you should see
 *      dlmmFeeSpike > 0  and  reason "dlmm-fee-spike xNN" in the log.
 *  If liveFeeBps == baseFeeBps every cycle, the pair genuinely isn't spiking
 *  right then (calm) — run during a known-volatile moment to confirm.
 * ========================================================================== */
