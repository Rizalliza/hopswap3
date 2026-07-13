/* ============================================================================
 *  ON-CHAIN TICK-STATE HYDRATION  —  for fetch_pools_batch.with_pool_selector.js
 * ============================================================================
 *
 *  THE GAP (confirmed)
 *  -------------------
 *  Your fetcher discovers pools via Raydium/Orca REST APIs. That gives price, TVL,
 *  fee, tickSpacing — but NOT the on-chain CLMM/Whirlpool math state. So CLMM and
 *  Whirlpool legs reach the quoter without:
 *      sqrtPriceX64  (current price)   and   tickArrays  (initialized tick accts)
 *  and the quote fails: "CLMM/Whirlpool math state missing".
 *
 *  (The REST 'liquidity' field is USD TVL, not the CLMM liquidity scalar — same
 *  name, different thing. That's why your check showed liquidity=present but the
 *  pool still couldn't quote.)
 *
 *  THE FIX
 *  -------
 *  A second pass: AFTER REST discovery, batch-read the kept pools' on-chain
 *  accounts (one getMultipleAccountsInfo — the same call your PumpSwap enrichment
 *  already uses at ~line 1924) and decode the real state. Discovery stays REST
 *  (fast); only kept pools get the on-chain read (cheap, batched).
 *
 *  This module is SELF-CONTAINED. It re-derives tick arrays with the Raydium SDK
 *  the same way tx_clmm.js does (TickArrayUtil + getPdaTickArrayAddress) and
 *  decodes Whirlpool via the Orca layout. Pass in the SDK objects you already
 *  import in the fetcher so there's no duplicate dependency.
 *
 *  ── WIRE-IN (in fetch_pools_batch.with_pool_selector.js) ────────────────────
 *  After you assemble the final kept pool list (just before writing the json),
 *  add:
 *
 *      const { hydrateTickState } = require('./onchainTickHydration');
 *      const conn = new Connection(nextRpc(), 'confirmed');
 *      await hydrateTickState(allKeptPools, conn, {
 *          RaydiumSdkV2,          // the SDK you already require for PoolInfoLayout
 *          OrcaWhirlpool,         // your Whirlpool decode (Q_WHIRLPOOL/tx_whirlpool dep)
 *          debug: process.env.HYDRATE_DEBUG === 'true',
 *      });
 *
 *  Pools that fail to hydrate are MARKED (tickStateError) and remain in the list
 *  with a flag, so your execution gate can skip them with a clear reason instead
 *  of failing mysteriously at quote time. Set HYDRATE_DROP_UNHYDRATED=true to
 *  drop them from the written file entirely.
 * ========================================================================== */

'use strict';

const { PublicKey } = require('@solana/web3.js');

function lazyRequire(id) {
    try { return require(id); } catch (_e) { return null; }
}

function loadRaydiumSdkV2(explicit) {
    return explicit || lazyRequire('@raydium-io/raydium-sdk-v2');
}

function loadOrcaWhirlpool(explicit) {
    if (explicit) return explicit;
    const sdk = lazyRequire('@orca-so/whirlpools-sdk');
    if (!sdk) return null;
    return {
        sdk,
        decode(data, address, account) {
            return sdk.ParsableWhirlpool?.parse?.(address, account || { data });
        },
        decodeTickArray(data, address, account) {
            return sdk.ParsableTickArray?.parse?.(address, account || { data });
        },
        deriveTickArrays(programId, poolAddress, tickCurrent, tickSpacing) {
            const poolPk = new PublicKey(poolAddress);
            return [-1, 0, 1].map((offset) => {
                const pda = sdk.PDAUtil.getTickArrayFromTickIndex(
                    Number(tickCurrent),
                    Number(tickSpacing),
                    poolPk,
                    programId,
                    offset,
                );
                return pda.publicKey.toBase58();
            });
        },
    };
}

function isClmm(p) {
    const t = String(p.type || p.dexType || p.dex || '').toLowerCase();
    return t.includes('clmm');
}
function isWhirlpool(p) {
    const t = String(p.type || p.dexType || p.dex || '').toLowerCase();
    return t.includes('whirlpool');
}

function isClmmOrWhirlpool(p) {
    return isClmm(p) || isWhirlpool(p);
}

/**
 * Derive current + neighbour tick-array addresses for a Raydium CLMM pool, the
 * same method tx_clmm.js uses. Returns base58 address strings.
 */
function deriveRaydiumTickArrays(RaydiumSdkV2, programId, poolPk, tickCurrent, tickSpacing) {
    if (!RaydiumSdkV2 || !RaydiumSdkV2.TickArrayUtil || typeof RaydiumSdkV2.getPdaTickArrayAddress !== 'function') {
        return [];
    }
    const tickCount = RaydiumSdkV2.TickArrayUtil.tickCount(Number(tickSpacing));
    const currentStart = RaydiumSdkV2.TickArrayUtil.getTickArrayStartIndex(Number(tickCurrent), Number(tickSpacing));
    const starts = [currentStart, currentStart - tickCount, currentStart + tickCount];
    const out = [];
    for (const s of starts) {
        try {
            const pda = RaydiumSdkV2.getPdaTickArrayAddress(programId, poolPk, s);
            const pk = pda?.publicKey || pda;
            if (pk) out.push(pk.toBase58 ? pk.toBase58() : String(pk));
        } catch { /* skip uninitialized start index */ }
    }
    return out;
}

function chunked(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

async function fetchAccountMap(connection, addresses) {
    const unique = [...new Set(addresses.filter(Boolean))];
    const out = new Map();
    for (const chunk of chunked(unique, 100)) {
        const keys = chunk.map((addr) => new PublicKey(addr));
        const accounts = await connection.getMultipleAccountsInfo(keys);
        for (let i = 0; i < chunk.length; i++) {
            if (accounts[i]) out.set(chunk[i], accounts[i]);
        }
    }
    return out;
}

async function hydrateTickArrayData(targets, connection, RaydiumSdkV2, OrcaWhirlpool) {
    const allTickArrayAddresses = [];
    for (const p of targets) {
        if (Array.isArray(p.tickArrays)) allTickArrayAddresses.push(...p.tickArrays);
    }
    if (!allTickArrayAddresses.length) return;

    const accountMap = await fetchAccountMap(connection, allTickArrayAddresses);
    const raydiumTickLayout = RaydiumSdkV2 && RaydiumSdkV2.TickArrayLayout;

    for (const p of targets) {
        const addresses = Array.isArray(p.tickArrays) ? p.tickArrays : [];
        const decoded = [];
        for (const address of addresses) {
            const account = accountMap.get(address);
            if (!account?.data) continue;
            try {
                if (isClmm(p) && raydiumTickLayout && typeof raydiumTickLayout.decode === 'function') {
                    decoded.push({ address, data: raydiumTickLayout.decode(account.data) });
                } else if (isWhirlpool(p) && OrcaWhirlpool && typeof OrcaWhirlpool.decodeTickArray === 'function') {
                    const parsed = OrcaWhirlpool.decodeTickArray(account.data, new PublicKey(address), account);
                    if (parsed) decoded.push({ address, data: parsed });
                }
            } catch (_e) {
                // Missing or uninitialized neighbour arrays are common; keep the
                // pool state and let the quote guard decide whether data is enough.
            }
        }
        if (decoded.length) {
            p.tickArrayData = decoded;
            p.remainingAccounts = addresses;
        }
    }
}

/**
 * hydrateTickState — populate sqrtPriceX64 / clmmLiquidity / tickCurrent /
 * tickArrays on CLMM and Whirlpool pools by reading their on-chain accounts.
 * Mutates pools in place; returns { hydrated, failed }.
 */
async function hydrateTickState(pools = [], connection, opts = {}) {
    const RaydiumSdkV2 = loadRaydiumSdkV2(opts.RaydiumSdkV2);
    const OrcaWhirlpool = loadOrcaWhirlpool(opts.OrcaWhirlpool);
    const { debug = false } = opts;
    const dropUnhydrated = String(process.env.HYDRATE_DROP_UNHYDRATED || '').toLowerCase() === 'true';

    const targets = pools.filter((p) => isClmm(p) || isWhirlpool(p));
    if (!targets.length) return { hydrated: 0, failed: 0, dropped: 0 };

    const addrs = targets.map((p) => {
        try { return new PublicKey(p.poolAddress || p.address || p.id); }
        catch { return null; }
    });

    // batch read — same pattern as the existing PumpSwap enrichment
    let accounts = [];
    try {
        // chunk to stay under getMultipleAccountsInfo's 100-account limit
        const CHUNK = 100;
        for (let i = 0; i < addrs.length; i += CHUNK) {
            const slice = addrs.slice(i, i + CHUNK).filter(Boolean);
            const got = slice.length ? await connection.getMultipleAccountsInfo(slice) : [];
            accounts = accounts.concat(got);
        }
    } catch (e) {
        if (debug) console.warn(`  tick hydration RPC failed: ${e.message}`);
        return { hydrated: 0, failed: targets.length, dropped: 0 };
    }

    let hydrated = 0, failed = 0;
    const layout = RaydiumSdkV2 && (RaydiumSdkV2.PoolInfoLayout || RaydiumSdkV2.ClmmPoolInfoLayout);

    for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        const acc = accounts[i];
        if (!acc || !acc.data) { p.tickStateError = 'no account data'; failed++; continue; }

        try {
            if (isClmm(p) && layout && typeof layout.decode === 'function') {
                const st = layout.decode(acc.data);
                p.sqrtPriceX64 = st.sqrtPriceX64 != null ? String(st.sqrtPriceX64) : null;
                p.clmmLiquidity = st.liquidity != null ? String(st.liquidity) : null;
                p.liquidity = p.clmmLiquidity || p.liquidity;
                p.tickCurrent = st.tickCurrent != null ? Number(st.tickCurrent) : null;
                p.tickSpacing = st.tickSpacing != null ? Number(st.tickSpacing) : p.tickSpacing;
                if (st.observationId) p.observationId = st.observationId.toBase58?.() || String(st.observationId);
                p.tickArrays = deriveRaydiumTickArrays(
                    RaydiumSdkV2, acc.owner, new PublicKey(p.poolAddress),
                    p.tickCurrent, p.tickSpacing
                );
                if (p.sqrtPriceX64 && p.tickArrays.length) { hydrated++; delete p.tickStateError; }
                else { p.tickStateError = 'clmm decode incomplete'; failed++; }
            } else if (isWhirlpool(p) && OrcaWhirlpool && typeof OrcaWhirlpool.decode === 'function') {
                // Orca Whirlpool layout: sqrtPrice, liquidity, tickCurrentIndex, tickSpacing
                const w = OrcaWhirlpool.decode(acc.data, new PublicKey(p.poolAddress), acc);
                p.sqrtPriceX64 = w.sqrtPrice != null ? String(w.sqrtPrice) : null;
                p.clmmLiquidity = w.liquidity != null ? String(w.liquidity) : null;
                p.liquidity = p.clmmLiquidity || p.liquidity;
                p.tickCurrent = w.tickCurrentIndex != null ? Number(w.tickCurrentIndex) : null;
                p.tickSpacing = w.tickSpacing != null ? Number(w.tickSpacing) : p.tickSpacing;
                // Whirlpool tick arrays derive via Orca's getTickArrayPDA(programId, whirlpool, startTick)
                p.tickArrays = (typeof OrcaWhirlpool.deriveTickArrays === 'function')
                    ? OrcaWhirlpool.deriveTickArrays(acc.owner, p.poolAddress, p.tickCurrent, p.tickSpacing)
                    : [];
                if (p.sqrtPriceX64) { hydrated++; delete p.tickStateError; }
                else { p.tickStateError = 'whirlpool decode incomplete'; failed++; }
            } else {
                p.tickStateError = 'no decoder available for type';
                failed++;
            }
        } catch (e) {
            p.tickStateError = `decode threw: ${e.message}`;
            failed++;
        }
    }

    try {
        await hydrateTickArrayData(targets, connection, RaydiumSdkV2, OrcaWhirlpool);
    } catch (e) {
        if (debug) console.warn(`  tick-array hydration failed: ${e.message}`);
    }

    hydrated = 0;
    failed = 0;
    for (const p of targets) {
        if (p.sqrtPriceX64 && p.liquidity && Array.isArray(p.tickArrayData) && p.tickArrayData.length) {
            delete p.tickStateError;
            hydrated++;
        } else {
            p.tickStateError = p.tickStateError || 'tick array data missing';
            if (isClmmOrWhirlpool(p) && (!p.tickArrays || p.tickArrays.length === 0)) {
                p.executionReady = false;
                p.skipReason = 'missing_tick_arrays';
            }
            failed++;
        }
    }

    let dropped = 0;
    if (dropUnhydrated) {
        for (let i = pools.length - 1; i >= 0; i--) {
            if (pools[i].tickStateError) { pools.splice(i, 1); dropped++; }
        }
    }

    if (debug) {
        console.log(`  tick hydration: ${hydrated} hydrated, ${failed} failed${dropUnhydrated ? `, ${dropped} dropped` : ''}`);
        for (const p of targets) {
            if (p.tickStateError) console.log(`    ✗ ${String(p.poolAddress).slice(0, 8)} ${p.type}: ${p.tickStateError}`);
        }
    }

    return { hydrated, failed, dropped };
}

module.exports = { hydrateTickState, deriveRaydiumTickArrays, _internals: { isClmm, isWhirlpool } };
