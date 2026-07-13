'use strict';

/**
 * DLMM bin-array helpers shared by enrichment and aux builders.
 *
 * These helpers are intentionally permissive: pool fetchers in this repo emit
 * either account addresses, decoded bin-array objects, or already-normalized
 * bins. Normalizers should preserve that execution data instead of collapsing
 * it to numeric ids.
 */

const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

let dlmmSdk = null;
try {
    dlmmSdk = require('@meteora-ag/dlmm');
} catch (_e) {
    dlmmSdk = null;
}

let meteoraBinArray = null;
try {
    meteoraBinArray = require('../backUp_THRASH/meteora/src/dlmm/helpers/binArray.js');
} catch (_e) {
    meteoraBinArray = null;
}

const DEFAULT_BIN_PER_POSITION = Number(
    meteoraBinArray?.DEFAULT_BIN_PER_POSITION?.toString?.()
    || dlmmSdk?.DEFAULT_BIN_PER_POSITION?.toString?.()
    || dlmmSdk?.DEFAULT_BIN_PER_POSITION
    || 70,
);
const MAX_BIN_ARRAY_SIZE = Number(
    meteoraBinArray?.MAX_BIN_ARRAY_SIZE?.toString?.()
    || dlmmSdk?.MAX_BIN_ARRAY_SIZE?.toString?.()
    || dlmmSdk?.MAX_BIN_ARRAY_SIZE
    || 70,
);
const BIN_ARRAY_BITMAP_SIZE = meteoraBinArray?.BIN_ARRAY_BITMAP_SIZE || new BN(512);
const EXTENSION_BINARRAY_BITMAP_SIZE = meteoraBinArray?.EXTENSION_BINARRAY_BITMAP_SIZE || new BN(12);
const BitmapType = meteoraBinArray?.BitmapType || Object.freeze({ U1024: 'U1024', U512: 'U512' });
const SCALE_OFFSET = meteoraBinArray?.SCALE_OFFSET ?? 64;

function normalizeBinId(binId) {
    const n = Number(binId);
    if (!Number.isFinite(n)) return 0;
    return Math.trunc(n);
}

function binIdToBinArrayIndex(binId, binPerArray = MAX_BIN_ARRAY_SIZE) {
    if (meteoraBinArray?.binIdToBinArrayIndex && binPerArray === MAX_BIN_ARRAY_SIZE) {
        try { return Number(meteoraBinArray.binIdToBinArrayIndex(new BN(normalizeBinId(binId))).toString()); }
        catch (_e) { /* fallback below */ }
    }
    if (dlmmSdk?.binIdToBinArrayIndex && binPerArray === MAX_BIN_ARRAY_SIZE) {
        try { return Number(dlmmSdk.binIdToBinArrayIndex(new BN(normalizeBinId(binId))).toString()); }
        catch (_e) { /* fallback below */ }
    }
    const id = normalizeBinId(binId);
    const denom = binPerArray > 0 ? binPerArray : 1;
    return Math.floor(id / denom);
}

function getBinIdIndexInBinArray(binId, binPerArray = MAX_BIN_ARRAY_SIZE) {
    const id = normalizeBinId(binId);
    const denom = binPerArray > 0 ? binPerArray : 1;
    const mod = ((id % denom) + denom) % denom;
    return mod;
}

function getBinArrayLowerUpperBinId(binArrayIndex, binPerArray = MAX_BIN_ARRAY_SIZE) {
    if (meteoraBinArray?.getBinArrayLowerUpperBinId && binPerArray === MAX_BIN_ARRAY_SIZE) {
        try {
            const [lower, upper] = meteoraBinArray.getBinArrayLowerUpperBinId(new BN(normalizeBinId(binArrayIndex)));
            return { lower: Number(lower.toString()), upper: Number(upper.toString()) };
        } catch (_e) { /* fallback below */ }
    }
    if (dlmmSdk?.getBinArrayLowerUpperBinId && binPerArray === MAX_BIN_ARRAY_SIZE) {
        try {
            const [lower, upper] = dlmmSdk.getBinArrayLowerUpperBinId(new BN(normalizeBinId(binArrayIndex)));
            return { lower: Number(lower.toString()), upper: Number(upper.toString()) };
        } catch (_e) { /* fallback below */ }
    }
    const idx = normalizeBinId(binArrayIndex);
    const denom = binPerArray > 0 ? binPerArray : 1;
    const lower = idx * denom;
    const upper = lower + denom - 1;
    return { lower, upper };
}

function getBinArraysRequiredByPositionRange(minBinId, maxBinId, binPerArray = MAX_BIN_ARRAY_SIZE) {
    if (minBinId instanceof PublicKey || (minBinId && typeof minBinId === 'object' && typeof minBinId.toBase58 === 'function')) {
        const pair = minBinId;
        const fromBinId = maxBinId;
        const toBinId = binPerArray;
        const programId = arguments[3];
        if (meteoraBinArray?.getBinArraysRequiredByPositionRange && programId) {
            try {
                const result = meteoraBinArray.getBinArraysRequiredByPositionRange(
                    pair,
                    new BN(normalizeBinId(fromBinId)),
                    new BN(normalizeBinId(toBinId)),
                    programId,
                );
                return Array.isArray(result) ? result : Object.values(result || {}).flat();
            } catch (_e) { return []; }
        }
        if (dlmmSdk?.getBinArraysRequiredByPositionRange && programId) {
            try {
                const result = dlmmSdk.getBinArraysRequiredByPositionRange(
                    pair,
                    new BN(normalizeBinId(fromBinId)),
                    new BN(normalizeBinId(toBinId)),
                    programId,
                );
                return Array.isArray(result) ? result : Object.values(result || {}).flat();
            } catch (_e) { return []; }
        }
        return [];
    }
    const min = normalizeBinId(minBinId);
    const max = normalizeBinId(maxBinId);
    if (min > max) return [];

    const start = binIdToBinArrayIndex(min, binPerArray);
    const end = binIdToBinArrayIndex(max, binPerArray);
    const out = [];
    for (let i = start; i <= end; i += 1) out.push(i);
    return out;
}

function getBinRangeFromActiveId(activeBinId, binStep, binArrays = 1, binPerArray = MAX_BIN_ARRAY_SIZE) {
    const active = normalizeBinId(activeBinId);
    const step = Number(binStep);
    const spanArrays = Math.max(0, Number(binArrays));
    const denom = binPerArray > 0 ? binPerArray : 1;

    // Placeholder: just convert arrays to a bin-span.
    const spanBins = spanArrays * denom;
    return { min: active - spanBins, max: active + spanBins, binStep: Number.isFinite(step) ? step : binStep };
}

function normalizeBinRange(range = {}) {
    const min = normalizeBinId(range.min ?? range.lower ?? 0);
    const max = normalizeBinId(range.max ?? range.upper ?? min);
    return { min: Math.min(min, max), max: Math.max(min, max) };
}

function stringAmount(value, fallback = '0') {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : fallback;
    if (value && typeof value.toString === 'function') return value.toString();
    return String(value);
}

function pubkeyString(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value;
    if (value && typeof value.toBase58 === 'function') return value.toBase58();
    if (value && typeof value.toString === 'function') {
        const text = value.toString();
        return text === '[object Object]' ? null : text;
    }
    return null;
}

function normalizeBinRecord(bin, fallback = {}) {
    if (bin === null || bin === undefined) return null;
    if (typeof bin === 'number' || typeof bin === 'bigint' || typeof bin === 'string') {
        const binId = normalizeBinId(bin);
        return Number.isFinite(binId) ? { binId, id: binId } : null;
    }
    if (typeof bin !== 'object') return null;

    const binId = normalizeBinId(
        bin.binId ?? bin.bin_id ?? bin.id ?? bin.index ?? fallback.binId ?? fallback.id ?? 0,
    );
    const xAmount = stringAmount(
        bin.xAmount ?? bin.x_amount ?? bin.amountX ?? bin.amount_x ?? bin.reserveA ?? bin.reserveX ?? bin.amount_x_in ?? bin.amountXIn,
    );
    const yAmount = stringAmount(
        bin.yAmount ?? bin.y_amount ?? bin.amountY ?? bin.amount_y ?? bin.reserveB ?? bin.reserveY ?? bin.amount_y_in ?? bin.amountYIn,
    );
    const liquidity = stringAmount(
        bin.liquidity ?? bin.liquiditySupply ?? bin.liquidity_supply,
        (() => {
            try { return (BigInt(xAmount) + BigInt(yAmount)).toString(); }
            catch (_e) { return '0'; }
        })(),
    );

    return {
        ...bin,
        binId,
        id: bin.id ?? binId,
        index: bin.index ?? binId,
        xAmount,
        yAmount,
        amountX: stringAmount(bin.amountX ?? bin.amount_x ?? xAmount),
        amountY: stringAmount(bin.amountY ?? bin.amount_y ?? yAmount),
        reserveA: stringAmount(bin.reserveA ?? xAmount),
        reserveB: stringAmount(bin.reserveB ?? yAmount),
        liquidity,
        liquiditySupply: stringAmount(bin.liquiditySupply ?? bin.liquidity_supply ?? liquidity),
        price: stringAmount(bin.price ?? bin.pricePerToken ?? bin.price_per_token, undefined),
    };
}

function normalizeBins(bins = [], binStep = null, activeBinId = null) {
    if (!Array.isArray(bins)) return [];
    return bins
        .map((bin) => {
            const normalized = normalizeBinRecord(bin, { binStep, activeBinId });
            if (!normalized) return null;
            if (binStep !== null && binStep !== undefined && normalized.binStep === undefined) {
                normalized.binStep = Number(binStep);
            }
            if (activeBinId !== null && activeBinId !== undefined && normalized.activeBinId === undefined) {
                normalized.activeBinId = normalizeBinId(activeBinId);
            }
            return normalized;
        })
        .filter(Boolean);
}

function normalizeBinArrayRecord(binArray, binStep = null, activeBinId = null) {
    if (binArray === null || binArray === undefined) return null;
    if (typeof binArray === 'string') return binArray;
    if (typeof binArray === 'number' || typeof binArray === 'bigint') {
        const index = normalizeBinId(binArray);
        return Number.isFinite(index) ? { index, binArrayIndex: index } : null;
    }
    if (typeof binArray !== 'object') return null;

    const account = binArray.account && typeof binArray.account === 'object' ? binArray.account : binArray;
    const address = pubkeyString(
        binArray.address
        || binArray.pubkey
        || binArray.publicKey
        || binArray.key
        || binArray.pubKey
        || null,
    );
    const indexValue = account.index
        ?? account.binArrayIndex
        ?? account.arrayIndex
        ?? binArray.index
        ?? binArray.binArrayIndex
        ?? binArray.arrayIndex;
    const index = indexValue === undefined ? undefined : normalizeBinId(indexValue);
    const range = index === undefined ? null : getBinArrayLowerUpperBinId(index);
    const rawBins = Array.isArray(account.bins)
        ? normalizeBins(account.bins.map((bin, offset) => ({
            ...bin,
            binId: bin?.binId ?? bin?.id ?? (range ? range.lower + offset : offset),
        })), binStep, activeBinId)
        : undefined;
    const active = activeBinId === null || activeBinId === undefined ? null : normalizeBinId(activeBinId);

    return {
        ...binArray,
        ...(account !== binArray ? { account: { ...account, ...(rawBins !== undefined ? { bins: rawBins } : {}) } } : {}),
        ...(address ? { address: String(address) } : {}),
        ...(index !== undefined ? { index, binArrayIndex: index } : {}),
        ...(range ? { lowerBinId: range.lower, upperBinId: range.upper } : {}),
        ...(active !== null && range ? { containsActiveBin: active >= range.lower && active <= range.upper } : {}),
        ...(binStep !== null && binStep !== undefined && binArray.binStep === undefined ? { binStep: Number(binStep) } : {}),
        ...(rawBins !== undefined ? { bins: rawBins } : {}),
    };
}

function normalizeBinArrays(binArrays = [], binStep = null, activeBinId = null) {
    if (!Array.isArray(binArrays)) return [];
    return binArrays
        .map((binArray) => normalizeBinArrayRecord(binArray, binStep, activeBinId))
        .filter(Boolean);
}

/**
 * Placeholder deriveBinArray.
 * For PDA seeds, DLMM implementations may vary; this is a best-effort shim.
 * It’s not expected to run during --skip-enrich mode.
 */
function deriveBinArray(lbPair, binArrayIndex, programId) {
    const pair = lbPair instanceof PublicKey ? lbPair : (lbPair ? new PublicKey(String(lbPair)) : null);
    const program = programId instanceof PublicKey ? programId : (programId ? new PublicKey(String(programId)) : null);

    if (!pair || !program) {
        // Return a shape that matches destructuring usage: [pubkey, bump]
        return [null, 0];
    }

    const idx = normalizeBinId(binArrayIndex);
    if (meteoraBinArray?.deriveBinArray) {
        try {
            return meteoraBinArray.deriveBinArray(pair, new BN(idx), program);
        } catch (_e) {
            // Fall through to SDK/local PDA.
        }
    }
    if (dlmmSdk?.deriveBinArray) {
        try {
            return dlmmSdk.deriveBinArray(pair, new BN(idx), program);
        } catch (_e) {
            // Fall through to the local best-effort PDA below.
        }
    }

    const seedA = Buffer.from('bin_array');
    const seedB = pair.toBuffer();
    // Meteora seeds the index as a signed i64 LE. BN(neg).toArrayLike silently encodes
    // the ABSOLUTE value (e.g. -96 -> 0x60), deriving the wrong PDA for any negative
    // bin-array index — which is the common SOL/USDC case. toTwos(64) fixes the sign.
    const seedC = new BN(idx).toTwos(64).toArrayLike(Buffer, 'le', 8);

    // Use findProgramAddress if possible; otherwise return null.
    try {
        // Note: bump is returned as well but callers may ignore.
        return PublicKey.findProgramAddressSync([seedA, seedB, seedC], program);
    } catch (_e) {
        return [null, 0];
    }
}

function callMeteoraHelper(name, args, fallback = null) {
    if (meteoraBinArray && typeof meteoraBinArray[name] === 'function') {
        try {
            return meteoraBinArray[name](...args);
        } catch (_e) {
            return fallback;
        }
    }
    return fallback;
}

function deriveReserve(token, lbPair, programId) {
    return callMeteoraHelper('deriveReserve', [token, lbPair, programId], [null, 0]);
}

function getPositionCount(minBinId, maxBinId) {
    return callMeteoraHelper(
        'getPositionCount',
        [BN.isBN(minBinId) ? minBinId : new BN(normalizeBinId(minBinId)), BN.isBN(maxBinId) ? maxBinId : new BN(normalizeBinId(maxBinId))],
        new BN(normalizeBinId(maxBinId)).sub(new BN(normalizeBinId(minBinId))).div(new BN(DEFAULT_BIN_PER_POSITION)).add(new BN(1)),
    );
}

function deriveBinArrayBitmapExtension(lbPair, programId) {
    return callMeteoraHelper('deriveBinArrayBitmapExtension', [lbPair, programId], [null, 0]);
}

function internalBitmapRange() {
    return callMeteoraHelper('internalBitmapRange', [], [
        BIN_ARRAY_BITMAP_SIZE.neg(),
        BIN_ARRAY_BITMAP_SIZE.sub(new BN(1)),
    ]);
}

function extensionBitmapRange() {
    return callMeteoraHelper('extensionBitmapRange', [], [
        BIN_ARRAY_BITMAP_SIZE.neg().mul(EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1))),
        BIN_ARRAY_BITMAP_SIZE.mul(EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1))).sub(new BN(1)),
    ]);
}

function buildBitmapFromU64Arrays(u64Arrays = []) {
    return callMeteoraHelper('buildBitmapFromU64Arrays', [u64Arrays], new BN(0));
}

function bitmapTypeDetail(type) {
    return callMeteoraHelper('bitmapTypeDetail', [type], { bits: 512, bytes: 64 });
}

function mostSignificantBit(number, bitLength) {
    return callMeteoraHelper('mostSignificantBit', [BN.isBN(number) ? number : new BN(String(number || 0)), bitLength], null);
}

function leastSignificantBit(number, bitLength) {
    return callMeteoraHelper('leastSignificantBit', [BN.isBN(number) ? number : new BN(String(number || 0)), bitLength], null);
}

function findSetBit(startIndex, endIndex, binArrayBitmapExtension) {
    return callMeteoraHelper('findSetBit', [startIndex, endIndex, binArrayBitmapExtension], null);
}

function isOverflowDefaultBinArrayBitmap(binArrayIndex) {
    return Boolean(callMeteoraHelper('isOverflowDefaultBinArrayBitmap', [BN.isBN(binArrayIndex) ? binArrayIndex : new BN(normalizeBinId(binArrayIndex))], false));
}

function getBinFromBinArray(binId, binArray) {
    return callMeteoraHelper('getBinFromBinArray', [binId, binArray], null);
}

function isBinIdWithinBinArray(activeId, binArrayIndex) {
    return Boolean(callMeteoraHelper(
        'isBinIdWithinBinArray',
        [BN.isBN(activeId) ? activeId : new BN(normalizeBinId(activeId)), BN.isBN(binArrayIndex) ? binArrayIndex : new BN(normalizeBinId(binArrayIndex))],
        (() => {
            const range = getBinArrayLowerUpperBinId(normalizeBinId(binArrayIndex));
            const id = normalizeBinId(activeId);
            return id >= range.lower && id <= range.upper;
        })(),
    ));
}

function findNextBinArrayIndexWithLiquidity(swapForY, activeId, lbPairState, binArrayBitmapExtension = null) {
    return callMeteoraHelper(
        'findNextBinArrayIndexWithLiquidity',
        [swapForY, BN.isBN(activeId) ? activeId : new BN(normalizeBinId(activeId)), lbPairState, binArrayBitmapExtension],
        null,
    );
}

function findNextBinArrayWithLiquidity(swapForY, activeBinId, lbPairState, binArrayBitmapExtension, binArrays = []) {
    return callMeteoraHelper(
        'findNextBinArrayWithLiquidity',
        [swapForY, BN.isBN(activeBinId) ? activeBinId : new BN(normalizeBinId(activeBinId)), lbPairState, binArrayBitmapExtension, binArrays],
        null,
    );
}

function updateBinArray(activeId, clock, allRewardInfos, binArray) {
    return callMeteoraHelper(
        'updateBinArray',
        [BN.isBN(activeId) ? activeId : new BN(normalizeBinId(activeId)), clock, allRewardInfos, binArray],
        binArray,
    );
}

module.exports = {
    MAX_BIN_ARRAY_SIZE,
    DEFAULT_BIN_PER_POSITION,
    BIN_ARRAY_BITMAP_SIZE,
    EXTENSION_BINARRAY_BITMAP_SIZE,
    BitmapType,
    SCALE_OFFSET,
    binIdToBinArrayIndex,
    bitmapTypeDetail,
    buildBitmapFromU64Arrays,
    deriveBinArray,
    deriveBinArrayBitmapExtension,
    deriveReserve,
    extensionBitmapRange,
    findNextBinArrayIndexWithLiquidity,
    findNextBinArrayWithLiquidity,
    findSetBit,
    getBinArrayLowerUpperBinId,
    getBinIdIndexInBinArray,
    getBinArraysRequiredByPositionRange,
    getBinRangeFromActiveId,
    getBinRangeFromIds: getBinArraysRequiredByPositionRange, // placeholder alias
    getBinFromBinArray,
    internalBitmapRange,
    isBinIdWithinBinArray,
    isOverflowDefaultBinArrayBitmap,
    leastSignificantBit,
    mostSignificantBit,
    normalizeBinRange,
    normalizeBinRecord,
    getPositionCount,
    normalizeBinArrays,
    normalizeBinArrayRecord,
    normalizeBins,
    normalizeBinId,
    pubkeyString,
    updateBinArray,
};
