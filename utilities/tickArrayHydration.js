/* ============================================================================
 *  TICK ARRAY HYDRATION (429-resilient)  —  fixes non-deterministic
 *  "state:missing-ticks" / "-9999 sim: need sqrtPriceX64 + liquidity + tickArrays"
 * ============================================================================
 *
 *  THE BUG (from your log + poolHelpers gate)
 *  ------------------------------------------
 *  checkHydrationCompleteness (poolHelpers.js) requires, for whirlpool/clmm:
 *      - non-empty tickArrays
 *      - a price signal (sqrtPriceX64 / currentPrice)
 *  Your pools HAVE the price signal (divergence works, via=sqrt) but tickArrays
 *  come back EMPTY, so the gate correctly demotes them to non-executable ->
 *  simulation returns -9999 and you get 0 routes.
 *
 *  WHY IT'S NON-DETERMINISTIC (different pools each run): the tickArray fetch
 *  does several getMultipleAccountsInfo calls per pool. Under load these hit 429
 *  rate limits. Whichever pools get throttled THIS run come back with empty
 *  tickArrays and get dropped. Next run, a different subset is throttled. So the
 *  "missing bins/ticks" moves around — that's the signature of throttling, not
 *  broken pools.
 *
 *  THE FIX
 *  -------
 *  Fetch tick arrays with 429 backoff + retry, batched, and NEVER stamp a pool
 *  as hydrated with an empty/partial tickArray set — either it gets its arrays
 *  or it's left clearly un-hydrated (so the gate demotes it honestly rather than
 *  it flapping run to run). Deterministic: same pools succeed every run.
 *
 *  WIRE-IN (in your enrichment, replacing/ wrapping the current tick fetch):
 *      const { hydrateWhirlpoolTickArrays } = require('./tickArrayHydration');
 *      await hydrateWhirlpoolTickArrays(pools, connection, { debug:true });
 *  Then the execution-ready gate sees non-empty tickArrays and keeps the pool.
 * ========================================================================== */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { ParsableTickArray } = require('@orca-so/whirlpools-sdk');
const {
    flattenInitializedTicks,
    normalizeStructuredTickArray,
} = require('./whirlpool_tick_utils');

const TICK_ARRAY_SIZE = 88;          // Whirlpool ticks per array
const DEFAULT_ARRAYS_EACH_SIDE = 3;  // fetch current +/- 3 arrays for swap range

function is429(err) {
    const m = String(err?.message || err || '');
    return m.includes('429') || m.includes('Too Many Requests') || err?.code === 429;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isWhirlpoolOrClmm(p = {}) {
    const t = String(p.type || p.dexType || p.dex || '').toLowerCase();
    return t.includes('whirl') || t.includes('clmm');
}
function poolAddr(p = {}) {
    return String(p.poolAddress || p.address || p.id || '').trim();
}

/**
 * getMultipleAccountsInfo with 429 backoff. Retries the WHOLE batch on 429 with
 * exponential backoff. Returns array aligned to pubkeys (null for genuinely
 * missing accounts, but throws if it can't get a non-429 answer after retries).
 */
async function getAccountsWithBackoff(connection, pubkeys, opts = {}) {
    const maxRetries = opts.maxRetries ?? 5;
    const baseDelay = opts.baseDelayMs ?? 400;
    let attempt = 0;
    for (;;) {
        try {
            return await connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
        } catch (err) {
            attempt += 1;
            if (!is429(err) || attempt > maxRetries) throw err;
            const delay = baseDelay * Math.pow(2, attempt - 1); // 400,800,1600,3200,6400
            if (opts.debug) console.warn(`  [ticks] 429 backoff attempt ${attempt}, waiting ${delay}ms`);
            await sleep(delay);
        }
    }
}

/**
 * Derive the tick array start indices around the current tick.
 * startIndex = floor(tick / (tickSpacing*88)) * (tickSpacing*88), plus N each side.
 */
function tickArrayStartIndices(currentTick, tickSpacing, eachSide = DEFAULT_ARRAYS_EACH_SIDE) {
    const span = tickSpacing * TICK_ARRAY_SIZE;
    const current = Math.floor(currentTick / span) * span;
    const starts = [];
    for (let i = -eachSide; i <= eachSide; i += 1) starts.push(current + i * span);
    return starts;
}

/**
 * Derive a Whirlpool tick-array PDA. programId + whirlpool + startIndex.
 * (Orca Whirlpool: seeds ["tick_array", whirlpool, startIndexStr])
 */
function deriveTickArrayPda(programId, whirlpool, startIndex) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('tick_array'), new PublicKey(whirlpool).toBuffer(), Buffer.from(String(startIndex))],
        new PublicKey(programId),
    )[0];
}

function decodeWhirlpoolTickArray(address, accountInfo, startTickIndex, tickSpacing) {
    const parsed = ParsableTickArray.parse(new PublicKey(address), accountInfo);
    if (!parsed?.ticks) return null;
    return normalizeStructuredTickArray({
        address,
        tickSpacing,
        data: {
            startTickIndex,
            tickSpacing,
            ticks: parsed.ticks.map((tick = {}) => ({
                initialized: tick.initialized !== undefined
                    ? Boolean(tick.initialized)
                    : ((tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0')) !== '0'),
                liquidityNet: tick.liquidityNet?.toString?.() || String(tick.liquidityNet || '0'),
                liquidityGross: tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0'),
            })),
        },
    });
}

/**
 * hydrateWhirlpoolTickArrays — for each whirlpool/clmm pool, fetch the tick
 * arrays around current tick with 429 backoff, and stamp pool.tickArrays.
 * Only stamps if it got at least the current array (non-empty) — otherwise
 * leaves tickArrays unset so the gate demotes honestly (no flapping).
 *
 * Requires each pool to already have: tickCurrentIndex (or tickCurrent),
 * tickSpacing, and the whirlpool program id (pool.programId or a known default).
 */
async function hydrateWhirlpoolTickArrays(pools = [], connection, opts = {}) {
    const debug = !!opts.debug;
    const eachSide = opts.arraysEachSide ?? DEFAULT_ARRAYS_EACH_SIDE;
    const targets = pools.filter(isWhirlpoolOrClmm);
    if (!targets.length) return { hydrated: 0, failed: 0 };
    if (!connection || typeof connection.getMultipleAccountsInfo !== 'function') {
        if (debug) console.warn(`  [ticks] skipped: missing RPC connection`);
        return { hydrated: 0, failed: 0, skipped: targets.length };
    }

    let hydrated = 0, failed = 0;
    for (const p of targets) {
        const addr = poolAddr(p);
        const tickCurrent = Number(p.tickCurrentIndex ?? p.tickCurrent ?? p.currentTickIndex);
        const tickSpacing = Number(p.tickSpacing);
        const programId = p.programId || p.whirlpoolProgramId || opts.programId;

        if (!Number.isFinite(tickCurrent) || !Number.isFinite(tickSpacing) || tickSpacing <= 0 || !programId) {
            // can't derive arrays without these — leave un-hydrated, gate will demote
            p._tickHydrationError = 'missing tickCurrent/tickSpacing/programId';
            failed++;
            if (debug) console.warn(`  [ticks] ${addr.slice(0, 6)} skip: ${p._tickHydrationError}`);
            continue;
        }

        try {
            const starts = tickArrayStartIndices(tickCurrent, tickSpacing, eachSide);
            const pdas = starts.map((s) => deriveTickArrayPda(programId, addr, s));
            const infos = await getAccountsWithBackoff(connection, pdas, opts);

            const arrays = [];
            const tickArrayData = [];
            for (let i = 0; i < infos.length; i += 1) {
                const info = infos[i];
                if (info && info.data) {
                    const address = pdas[i].toBase58();
                    arrays.push({
                        startTickIndex: starts[i],
                        address,
                        data: info.data.toString('base64'),
                    });
                    try {
                        const decoded = decodeWhirlpoolTickArray(address, info, starts[i], tickSpacing);
                        if (decoded) tickArrayData.push(decoded);
                    } catch (_error) {
                        // Keep the base64 account for diagnostics, but do not
                        // mark it as decoded execution state.
                    }
                }
            }

            // require at least the CURRENT array (the middle one) to be present
            const hasCurrent = arrays.some((a) => a.startTickIndex === tickArrayStartIndices(tickCurrent, tickSpacing, 0)[0]);
            const hasDecodedCurrent = tickArrayData.some((a) => a?.data?.startTickIndex === tickArrayStartIndices(tickCurrent, tickSpacing, 0)[0]);
            if (arrays.length > 0 && hasCurrent && tickArrayData.length > 0 && hasDecodedCurrent) {
                const ticks = flattenInitializedTicks(tickArrayData, tickSpacing);
                p.tickArrays = arrays;
                p.tickArrayData = tickArrayData;
                p.ticks = ticks;
                p.tickCount = ticks.length;
                p.remainingAccounts = arrays.map((a) => a.address);
                p.aux = {
                    ...(p.aux || {}),
                    whirlpool: {
                        ...(p.aux?.whirlpool || {}),
                        tickArrays: tickArrayData,
                        tickArrayData,
                        ticks,
                    },
                };
                delete p._tickHydrationError;
                hydrated++;
                if (debug) console.log(`  [ticks] ${addr.slice(0, 6)} hydrated ${arrays.length} arrays (${tickArrayData.length} decoded, ${ticks.length} ticks)`);
            } else {
                p._tickHydrationError = `incomplete arrays (got ${arrays.length}, decoded ${tickArrayData.length}, current=${hasCurrent}, decodedCurrent=${hasDecodedCurrent})`;
                failed++;
                if (debug) console.warn(`  [ticks] ${addr.slice(0, 6)} ${p._tickHydrationError}`);
            }
        } catch (err) {
            p._tickHydrationError = is429(err) ? '429 after retries' : err.message;
            failed++;
            if (debug) console.warn(`  [ticks] ${addr.slice(0, 6)} FAILED: ${p._tickHydrationError}`);
        }
    }

    if (debug) console.log(`  [ticks] hydrated=${hydrated} failed=${failed} of ${targets.length} whirlpool/clmm`);
    return { hydrated, failed };
}

module.exports = {
    hydrateWhirlpoolTickArrays,
    getAccountsWithBackoff,
    tickArrayStartIndices,
    _internals: { is429, isWhirlpoolOrClmm },
};
