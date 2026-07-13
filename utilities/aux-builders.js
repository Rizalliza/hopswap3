'use strict';

/**
 * utilities/aux-builders.js
 *
 * Aux builder used by engine/zen_enrichment.js.
 * The pipeline expects `merged.aux` to exist, and math adapters look for:
 *   - pool.aux.whirlpool.tickArrays (structured tick arrays)
 *   - pool.aux.clmm.tickArrayData
 *   - pool.aux.dlmm.binArrays / pool.aux.dlmm.bins
 *   - pool.aux.crema.ticks / pool.aux.cykura.ticks
 */

const {
    flattenInitializedTicks,
    normalizeTickArrayCollection,
} = require('./whirlpool_tick_utils.js');
const {
    binIdToBinArrayIndex,
    getBinRangeFromActiveId,
    getBinArraysRequiredByPositionRange,
    normalizeBinArrays,
    normalizeBins,
} = require('./binArray_util.js');

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function firstArray(...values) {
    for (const value of values) {
        if (Array.isArray(value) && value.length) return value;
    }
    return [];
}

function asNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function flattenBinsFromBinArrays(binArrays) {
    const out = [];
    for (const binArray of asArray(binArrays)) {
        const bins = Array.isArray(binArray?.bins)
            ? binArray.bins
            : (Array.isArray(binArray?.account?.bins) ? binArray.account.bins : []);
        out.push(...bins);
    }
    return out.sort((left, right) => asNumber(left?.binId ?? left?.id, 0) - asNumber(right?.binId ?? right?.id, 0));
}

function buildDlmmAux(pool = {}) {
    const existingDlmm = pool?.aux?.dlmm && typeof pool.aux.dlmm === 'object' ? pool.aux.dlmm : {};
    const existingDlmmV2 = pool?.aux?.dlmmV2 && typeof pool.aux.dlmmV2 === 'object'
        ? pool.aux.dlmmV2
        : (pool?.aux?.dlmm_v2 && typeof pool.aux.dlmm_v2 === 'object' ? pool.aux.dlmm_v2 : {});

    const activeBinId = asNumber(
        pool.activeBinId
        ?? pool.activeId
        ?? pool.lbPair?.activeId
        ?? existingDlmmV2.activeBinId
        ?? existingDlmmV2.activeId
        ?? existingDlmm.activeBinId
        ?? existingDlmm.activeId,
        0,
    );
    const binStep = asNumber(
        pool.binStep
        ?? pool.lbPair?.binStep
        ?? existingDlmmV2.binStep
        ?? existingDlmm.binStep,
        0,
    );
    const rawBinArrays = firstArray(
        pool.binArrays,
        pool.binArrayData,
        pool.binArrayAccounts,
        existingDlmmV2.binArrays,
        existingDlmmV2.binArrayData,
        existingDlmm.binArrays,
        existingDlmm.binArrayData,
    );
    const binArrays = normalizeBinArrays(rawBinArrays, binStep, activeBinId);
    const bins = normalizeBins(firstArray(
        pool.bins,
        existingDlmmV2.bins,
        existingDlmm.bins,
        flattenBinsFromBinArrays(binArrays),
    ), binStep, activeBinId);
    const activeBinArrayIndex = binIdToBinArrayIndex(activeBinId);
    const binArrayIndexes = binArrays
        .map((binArray) => binArray?.binArrayIndex ?? binArray?.index)
        .filter((value) => Number.isFinite(Number(value)))
        .map((value) => asNumber(value, 0));
    const binRange = pool.binRange
        || existingDlmmV2.binRange
        || existingDlmm.binRange
        || (Number.isFinite(activeBinId) ? getBinRangeFromActiveId(activeBinId, binStep || 0, Math.max(1, binArrays.length || 1)) : null);
    const requiredBinArrayIndexes = binRange
        ? getBinArraysRequiredByPositionRange(binRange.min, binRange.max)
        : [];

    return {
        ...existingDlmm,
        ...existingDlmmV2,
        binArrays,
        binArrayData: binArrays,
        bins,
        binRange,
        activeBinId,
        activeId: activeBinId,
        activeBinArrayIndex,
        binArrayIndexes,
        requiredBinArrayIndexes,
        binStep,
        lbPair: pool.lbPair ?? existingDlmmV2.lbPair ?? existingDlmm.lbPair,
        binArrayBitmap: pool.binArrayBitmap ?? pool.lbPair?.binArrayBitmap ?? existingDlmmV2.binArrayBitmap ?? existingDlmm.binArrayBitmap,
        binArrayBitmapExtension: pool.binArrayBitmapExtension ?? existingDlmmV2.binArrayBitmapExtension ?? existingDlmm.binArrayBitmapExtension,
    };
}

function buildNormalizedAux(pool = {}) {
    const tickSpacing = asNumber(pool.tickSpacing, 1);
    const clmmTickArrayData = normalizeTickArrayCollection(firstArray(
        pool.tickArrayData,
        pool?.aux?.clmm?.tickArrayData,
        pool?.aux?.whirlpool?.tickArrays,
    ), tickSpacing);
    const whirlpoolTickArrays = normalizeTickArrayCollection(firstArray(
        pool.tickArrayData,
        pool?.aux?.whirlpool?.tickArrays,
        pool?.aux?.clmm?.tickArrayData,
    ), tickSpacing);
    const ticks = firstArray(
        pool.ticks,
        pool?.aux?.clmm?.ticks,
        pool?.aux?.whirlpool?.ticks,
        pool?.aux?.crema?.ticks,
        pool?.aux?.cykura?.ticks,
        flattenInitializedTicks(clmmTickArrayData, tickSpacing),
        flattenInitializedTicks(whirlpoolTickArrays, tickSpacing),
    );

    const dlmmAux = buildDlmmAux(pool);

    return {
        ...(pool?.aux && typeof pool.aux === 'object' ? pool.aux : {}),
        whirlpool: {
            ...(pool?.aux?.whirlpool && typeof pool.aux.whirlpool === 'object' ? pool.aux.whirlpool : {}),
            tickArrays: whirlpoolTickArrays,
            // keep these keys permissive; downstream code checks existence/length
            tickArrayData: whirlpoolTickArrays,
            ticks,
            remainingAccounts: asArray(pool?.remainingAccounts),
            sqrtPriceX64: pool.sqrtPriceX64 ?? pool.sqrtPrice ?? pool?.aux?.whirlpool?.sqrtPriceX64,
            tickCurrent: pool.tickCurrent ?? pool.tickCurrentIndex ?? pool?.aux?.whirlpool?.tickCurrent,
            tickSpacing,
            liquidity: pool.liquidity ?? pool?.aux?.whirlpool?.liquidity,
        },
        clmm: {
            ...(pool?.aux?.clmm && typeof pool.aux.clmm === 'object' ? pool.aux.clmm : {}),
            tickArrayData: clmmTickArrayData,
            tickArrays: clmmTickArrayData,
            ticks,
            sqrtPriceX64: pool.sqrtPriceX64 ?? pool.sqrtPrice ?? pool?.aux?.clmm?.sqrtPriceX64,
            tickCurrent: pool.tickCurrent ?? pool.tickCurrentIndex ?? pool?.aux?.clmm?.tickCurrent,
            tickSpacing,
            liquidity: pool.liquidity ?? pool?.aux?.clmm?.liquidity,
        },
        crema: {
            ...(pool?.aux?.crema && typeof pool.aux.crema === 'object' ? pool.aux.crema : {}),
            ticks,
            sqrtPrice: pool.sqrtPrice ?? pool.sqrtPriceX64 ?? pool?.aux?.crema?.sqrtPrice,
            tickCurrent: pool.tickCurrent ?? pool.tickCurrentIndex ?? pool?.aux?.crema?.tickCurrent,
            tickSpacing,
            liquidity: pool.liquidity ?? pool?.aux?.crema?.liquidity,
        },
        cykura: {
            ...(pool?.aux?.cykura && typeof pool.aux.cykura === 'object' ? pool.aux.cykura : {}),
            ticks,
            sqrtPrice: pool.sqrtPrice ?? pool.sqrtPriceX32 ?? pool.sqrtPriceX64 ?? pool?.aux?.cykura?.sqrtPrice,
            tickCurrent: pool.tickCurrent ?? pool.tickCurrentIndex ?? pool?.aux?.cykura?.tickCurrent,
            tickSpacing,
            liquidity: pool.liquidity ?? pool?.aux?.cykura?.liquidity,
        },
        dlmm: {
            ...(pool?.aux?.dlmm && typeof pool.aux.dlmm === 'object' ? pool.aux.dlmm : {}),
            ...dlmmAux,
        },
        dlmmV2: dlmmAux,
        dlmm_v2: dlmmAux,
    };
}

module.exports = {
    buildNormalizedAux,
    buildDlmmAux,
};
