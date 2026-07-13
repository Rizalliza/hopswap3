/* ============================================================================
 *  WHIRLPOOL TICK ARRAY DECODER  —  base64 -> decoded ticks[] (the -9999 fix)
 * ============================================================================
 *
 *  CONFIRMED BY YOUR LIVE DIAGNOSTIC:
 *    [tickshape] {"tally":{"base64":10, "decoded":0, ...}}
 *  ALL pools are base64 shape. The tick account data IS fetched (no 429 issue —
 *  you were right), but it's sitting as base64 and NEVER decoded into ticks[].
 *  The simulator (Q_WHIRLPOOL normalizeWhirlpoolTickArrays) needs each entry as:
 *      { startTickIndex, ticks: [ {tick, initialized, liquidityNet, liquidityGross} ] }
 *  It gets { startTickIndex, address, data: "<base64>" } instead -> no .ticks[]
 *  -> "Whirlpool math state missing" -> -999999.
 *
 *  This decoder parses the Whirlpool TickArray account layout and rewrites each
 *  pool's tickArrays into the decoded shape. One pass, no RPC (data already
 *  fetched). After this, [tickshape] should read decoded:N.
 *
 *  WHIRLPOOL TICKARRAY ACCOUNT LAYOUT (Orca Whirlpool program):
 *    offset 0:  discriminator (8 bytes)
 *    offset 8:  startTickIndex (i32 LE, 4 bytes)
 *    offset 12: ticks[88], each 113 bytes:
 *                 initialized      (bool, 1 byte)
 *                 liquidityNet     (i128 LE, 16 bytes)
 *                 liquidityGross   (u128 LE, 16 bytes)
 *                 feeGrowthOutsideA (u128, 16) + feeGrowthOutsideB (u128, 16)
 *                 rewardGrowthsOutside (3 x u128 = 48)
 *  We only need tick index (derived), initialized, liquidityNet, liquidityGross.
 *
 *  WIRE-IN (in your hydrate step, AFTER tick arrays are fetched as base64,
 *  BEFORE the file is written / before sim):
 *      const { decodePoolTickArrays } = require('./whirlpoolTickDecoder');
 *      decodePoolTickArrays(pools, { debug: true });
 * ========================================================================== */

'use strict';

const TICK_ARRAY_SIZE = 88;
const TICK_STRIDE = 113;          // bytes per tick in the Orca Whirlpool account
const TICKS_START_OFFSET = 12;    // 8 discriminator + 4 startTickIndex

function readI128LE(buf, offset) {
    // little-endian signed 128-bit -> BigInt
    let lo = buf.readBigUInt64LE(offset);
    let hi = buf.readBigInt64LE(offset + 8);   // high word signed
    return (hi << 64n) | lo;
}
function readU128LE(buf, offset) {
    let lo = buf.readBigUInt64LE(offset);
    let hi = buf.readBigUInt64LE(offset + 8);
    return (hi << 64n) | lo;
}

/**
 * decodeTickArrayBuffer(buf, tickSpacing) -> { startTickIndex, ticks:[...] }
 * ticks carry {tick, initialized, liquidityNet, liquidityGross} as STRINGS
 * (the sim's toBN() accepts strings; strings survive JSON round-trips).
 */
function decodeTickArrayBuffer(buf, tickSpacing = 1) {
    if (!Buffer.isBuffer(buf) || buf.length < TICKS_START_OFFSET) return null;
    const startTickIndex = buf.readInt32LE(8);
    const ticks = [];
    for (let i = 0; i < TICK_ARRAY_SIZE; i += 1) {
        const base = TICKS_START_OFFSET + i * TICK_STRIDE;
        if (base + TICK_STRIDE > buf.length) break;
        const initialized = buf.readUInt8(base) === 1;
        const liquidityNet = readI128LE(buf, base + 1);
        const liquidityGross = readU128LE(buf, base + 1 + 16);
        ticks.push({
            tick: startTickIndex + i * Number(tickSpacing || 1),
            initialized,
            liquidityNet: liquidityNet.toString(),
            liquidityGross: liquidityGross.toString(),
        });
    }
    return { startTickIndex, ticks };
}

function isWhirlpoolOrClmm(p = {}) {
    const t = String(p.type || p.dexType || p.dex || '').toLowerCase();
    return t.includes('whirl') || t.includes('clmm');
}

/**
 * decodeEntry — take one tickArray entry in ANY of the shapes we've seen and
 * return the decoded {startTickIndex, ticks[]} shape, or null if it can't.
 */
function decodeEntry(entry, tickSpacing) {
    if (!entry) return null;
    // already decoded?
    if (Array.isArray(entry.ticks)) return entry;
    if (entry.data && typeof entry.data === 'object' && Array.isArray(entry.data.ticks)) return entry.data;
    // base64 string in .data
    if (typeof entry.data === 'string') {
        const buf = Buffer.from(entry.data, 'base64');
        return decodeTickArrayBuffer(buf, tickSpacing);
    }
    // whole entry is a base64 string
    if (typeof entry === 'string') {
        const buf = Buffer.from(entry, 'base64');
        return decodeTickArrayBuffer(buf, tickSpacing);
    }
    return null;
}

/**
 * decodePoolTickArrays — rewrite each whirlpool/clmm pool's tickArrays into the
 * decoded shape the sim needs. Mutates in place. Returns a tally.
 */
function decodePoolTickArrays(pools = [], opts = {}) {
    const debug = !!opts.debug;
    let decoded = 0, skipped = 0, failed = 0;
    for (const p of pools) {
        if (!isWhirlpoolOrClmm(p)) { skipped++; continue; }
        const tickSpacing = Number(p.tickSpacing || 1);
        const collections = [
            p.tickArrayData,
            p.tickArrays,
            p?.aux?.whirlpool?.tickArrayData,
            p?.aux?.whirlpool?.tickArrays,
            p?.aux?.clmm?.tickArrayData,
            p?.aux?.clmm?.tickArrays,
        ].filter((value) => Array.isArray(value) && value.length);
        if (!collections.length) { failed++; if (debug) console.warn(`  [tickdecode] ${String(p.poolAddress||'').slice(0,8)} no tickArrays`); continue; }

        const byStart = new Map();
        for (const arr of collections) {
            for (const entry of arr) {
                const dec = decodeEntry(entry, tickSpacing);
                if (!dec || !Array.isArray(dec.ticks) || !dec.ticks.length) continue;
                const startTickIndex = Number(dec.startTickIndex ?? dec.start_index);
                if (!Number.isFinite(startTickIndex)) continue;
                byStart.set(startTickIndex, {
                    ...dec,
                    startTickIndex,
                    address: dec.address || entry?.address || entry?.pubkey || entry?.publicKey || null,
                });
            }
        }
        const out = Array.from(byStart.values()).sort((a, b) => a.startTickIndex - b.startTickIndex);
        if (out.length) {
            p.tickArrays = out;                 // canonical: decoded shape on pool.tickArrays
            p.tickArrayData = out;              // Q_WHIRLPOOL reads tickArrayData first
            if (p.aux?.whirlpool) {
                p.aux.whirlpool.tickArrays = out;  // keep aux in sync if present
                p.aux.whirlpool.tickArrayData = out;
            }
            if (p.aux?.clmm) {
                p.aux.clmm.tickArrays = out;
                p.aux.clmm.tickArrayData = out;
            }
            decoded++;
            if (debug) {
                const initCount = out.reduce((s, a) => s + a.ticks.filter((t) => t.initialized).length, 0);
                console.log(`  [tickdecode] ${String(p.poolAddress||'').slice(0,8)} decoded ${out.length} arrays, ${initCount} initialized ticks`);
            }
        } else {
            failed++;
            if (debug) console.warn(`  [tickdecode] ${String(p.poolAddress||'').slice(0,8)} decode produced no ticks`);
        }
    }
    if (debug) console.log(`  [tickdecode] decoded=${decoded} failed=${failed} skipped(non-clmm)=${skipped}`);
    return { decoded, failed, skipped };
}

module.exports = {
    decodePoolTickArrays,
    decodeTickArrayBuffer,
    decodeEntry,
    _internals: { readI128LE, readU128LE },
};
