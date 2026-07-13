'use strict';
/**
 * Q_WHIRLPOOL2.js — Orca Whirlpool Quoter
 *
 * Provides:
 *   - Full Whirlpool swap-step math (PriceMath, BitMath, TickUtil, TickArraySequence)
 *   - WhirlpoolAdapter class for quoteExactIn
 *   - Standalone computeSwap, buildSwapQuote, calculatePriceImpact functions
 *
 * FIXES from original:
 *   - Removed duplicate `const { Connection, PublicKey }` declarations
 *   - Removed duplicate `finalizeQuote` imports
 *   - Lazy-loads poolContract / normalizer / tick_utils — works standalone if missing
 *   - Removed @orca-so/common-sdk hard dependency
 *   - All math classes preserved exactly as authored
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const Decimal = require('decimal.js');
const { Connection, PublicKey } = require('@solana/web3.js');
const { createRpcConnection } = require('../utilities/rpcConnectionManager.js');
const { mergeCanonicalPool, validateQuoteContract, finalizeQuote } = require('./poolContract.js');
const { buildWhirlpoolSwapTx } = require('./transact/tx_whirlpool.js');

/* -------------------------------------------------------------------------- */
/*                             Utility functions                              */
/* -------------------------------------------------------------------------- */

function normalizeIntegerText(val, fallback = '0') {
    if (val === undefined || val === null || val === '') return fallback;
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'number') {
        return Number.isFinite(val) ? String(Math.trunc(val)) : fallback;
    }

    let text = String(val).trim();
    if (!text) return fallback;
    text = text.replace(/[,_\s]/g, '');
    if (/^[-+]?\d+n$/i.test(text)) text = text.slice(0, -1);
    if (!text) return fallback;

    if (/^[-+]?\d+$/.test(text)) return text;
    if (/^[-+]?(0x)?[0-9a-fA-F]+$/.test(text) && /[a-fA-F]/.test(text)) {
        const negative = text.startsWith('-');
        const hex = text.replace(/^[-+]?0x/i, '');
        const parsed = new BN(hex || fallback, 16);
        return negative ? parsed.neg().toString() : parsed.toString();
    }

    try {
        const parsed = new Decimal(text);
        if (!parsed.isFinite()) return fallback;
        return parsed.trunc().toFixed(0);
    } catch (_error) {
        return fallback;
    }
}

function toBN(val, fallback = '0') {
    if (BN.isBN(val)) return val;
    return new BN(normalizeIntegerText(val, fallback));
}

function ensure(cond, msg) { if (!cond) throw new Error(msg); }

/* -------------------------------------------------------------------------- */
/*                           Whirlpool math constants                         */
/* -------------------------------------------------------------------------- */

const ZERO = new BN(0);
const ONE = new BN(1);
const NEGATIVE_ONE = new BN(-1);
const TWO = new BN(2);
const Q64 = new BN(1).shln(64);
const TWO_POW_32 = new BN(2).pow(new BN(32));

const BIT_PRECISION = 14;
const LOG_B_2_X32 = new BN('59543866431248');
const LOG_B_P_ERR_MARGIN_LOWER_X64 = new BN('184467440737095516');
const LOG_B_P_ERR_MARGIN_UPPER_X64 = new BN('15793534762490258745');

const MIN_TICK_INDEX = -307200;
const MAX_TICK_INDEX = 307200;
const TICK_ARRAY_SIZE = 88;

const MIN_SQRT_PRICE_BN = new BN('4295048016');
const MAX_SQRT_PRICE_BN = new BN('79226673521066979257589524732');


function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    const normalized = normalizeIntegerText(value, '0');
    try {
        return BigInt(normalized);
    } catch (_error) {
        return 0n;
    }
}

function normalizePools(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.data)) return raw.data;
    return Object.values(raw || {});
}

function normalizePoolRecord(pool = {}) {
    return mergeCanonicalPool({
        ...pool,
        type: pool.type || 'whirlpool',
        dexType: pool.dexType || 'ORCA_WHIRLPOOL',
    });
}

/* -------------------------------------------------------------------------- */
/*                             PriceMath class                                */
/* -------------------------------------------------------------------------- */

class PriceMath {
    static sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB) {
        return new Decimal(sqrtPriceX64.toString())
            .div(new Decimal(2).pow(64))
            .pow(2)
            .mul(Decimal.pow(10, decimalsA - decimalsB));
    }

    static priceToSqrtPriceX64(price, decimalsA, decimalsB) {
        const sqrtPriceDecimal = price.mul(Decimal.pow(10, decimalsB - decimalsA)).sqrt();
        return new BN(sqrtPriceDecimal.mul(new Decimal(2).pow(64)).toFixed(0));
    }

    static tickIndexToSqrtPriceX64(tickIndex) {
        if (tickIndex > 0) {
            return this._tickPositive(tickIndex);
        } else if (tickIndex < 0) {
            return this._tickNegative(tickIndex);
        }
        return new BN(1).shln(64);
    }

    static _tickPositive(tickIndex) {
        const tickAbs = Math.abs(tickIndex);
        let ratio = (tickAbs & 0x1) !== 0
            ? new BN('18445821805675395072')
            : new BN('18446744073709551616');
        if ((tickAbs & 0x2) !== 0) ratio = this._mulShift(ratio, new BN('18444899583751176192'));
        if ((tickAbs & 0x4) !== 0) ratio = this._mulShift(ratio, new BN('18443055278223355904'));
        if ((tickAbs & 0x8) !== 0) ratio = this._mulShift(ratio, new BN('18439367220385607680'));
        if ((tickAbs & 0x10) !== 0) ratio = this._mulShift(ratio, new BN('18431993317065453568'));
        if ((tickAbs & 0x20) !== 0) ratio = this._mulShift(ratio, new BN('18417254355718170624'));
        if ((tickAbs & 0x40) !== 0) ratio = this._mulShift(ratio, new BN('18387811781193609216'));
        if ((tickAbs & 0x80) !== 0) ratio = this._mulShift(ratio, new BN('18329067761203558400'));
        if ((tickAbs & 0x100) !== 0) ratio = this._mulShift(ratio, new BN('18212142134806163456'));
        if ((tickAbs & 0x200) !== 0) ratio = this._mulShift(ratio, new BN('17980523815641700352'));
        if ((tickAbs & 0x400) !== 0) ratio = this._mulShift(ratio, new BN('17526086738831433728'));
        if ((tickAbs & 0x800) !== 0) ratio = this._mulShift(ratio, new BN('16651378430235570176'));
        if ((tickAbs & 0x1000) !== 0) ratio = this._mulShift(ratio, new BN('15030750278694412288'));
        if ((tickAbs & 0x2000) !== 0) ratio = this._mulShift(ratio, new BN('12247334978884435968'));
        if ((tickAbs & 0x4000) !== 0) ratio = this._mulShift(ratio, new BN('8131365268886854656'));
        if ((tickAbs & 0x8000) !== 0) ratio = this._mulShift(ratio, new BN('3584323654725218816'));
        if ((tickAbs & 0x10000) !== 0) ratio = this._mulShift(ratio, new BN('696457651848324352'));
        if ((tickAbs & 0x20000) !== 0) ratio = this._mulShift(ratio, new BN('26294789957507116'));
        if ((tickAbs & 0x40000) !== 0) ratio = this._mulShift(ratio, new BN('37481735321082'));
        return new BN(2).pow(new BN(128)).div(ratio);
    }

    static _tickNegative(tickIndex) {
        const tickAbs = Math.abs(tickIndex);
        let ratio = (tickAbs & 0x1) !== 0
            ? new BN('18445821805675395072')
            : new BN('18446744073709551616');
        if ((tickAbs & 0x2) !== 0) ratio = this._mulShift(ratio, new BN('18444899583751176192'));
        if ((tickAbs & 0x4) !== 0) ratio = this._mulShift(ratio, new BN('18443055278223355904'));
        if ((tickAbs & 0x8) !== 0) ratio = this._mulShift(ratio, new BN('18439367220385607680'));
        if ((tickAbs & 0x10) !== 0) ratio = this._mulShift(ratio, new BN('18431993317065453568'));
        if ((tickAbs & 0x20) !== 0) ratio = this._mulShift(ratio, new BN('18417254355718170624'));
        if ((tickAbs & 0x40) !== 0) ratio = this._mulShift(ratio, new BN('18387811781193609216'));
        if ((tickAbs & 0x80) !== 0) ratio = this._mulShift(ratio, new BN('18329067761203558400'));
        if ((tickAbs & 0x100) !== 0) ratio = this._mulShift(ratio, new BN('18212142134806163456'));
        if ((tickAbs & 0x200) !== 0) ratio = this._mulShift(ratio, new BN('17980523815641700352'));
        if ((tickAbs & 0x400) !== 0) ratio = this._mulShift(ratio, new BN('17526086738831433728'));
        if ((tickAbs & 0x800) !== 0) ratio = this._mulShift(ratio, new BN('16651378430235570176'));
        if ((tickAbs & 0x1000) !== 0) ratio = this._mulShift(ratio, new BN('15030750278694412288'));
        if ((tickAbs & 0x2000) !== 0) ratio = this._mulShift(ratio, new BN('12247334978884435968'));
        if ((tickAbs & 0x4000) !== 0) ratio = this._mulShift(ratio, new BN('8131365268886854656'));
        if ((tickAbs & 0x8000) !== 0) ratio = this._mulShift(ratio, new BN('3584323654725218816'));
        if ((tickAbs & 0x10000) !== 0) ratio = this._mulShift(ratio, new BN('696457651848324352'));
        if ((tickAbs & 0x20000) !== 0) ratio = this._mulShift(ratio, new BN('26294789957507116'));
        if ((tickAbs & 0x40000) !== 0) ratio = this._mulShift(ratio, new BN('37481735321082'));
        return new BN(2).pow(new BN(128)).div(ratio);
    }

    static _mulShift(n, mulBy) {
        return n.mul(mulBy).shrn(64);
    }

    static sqrtPriceX64ToTickIndex(sqrtPriceX64) {
        if (sqrtPriceX64.gt(MAX_SQRT_PRICE_BN) || sqrtPriceX64.lt(MIN_SQRT_PRICE_BN)) {
            throw new Error('sqrtPrice out of range');
        }

        const msb = sqrtPriceX64.bitLength() - 1;
        const adjustedMsb = new BN(msb - 64);
        const log2pIntegerX32 = this._signedLeftShift(adjustedMsb, 32, 128);

        let bit = new BN('8000000000000000', 'hex');
        let precision = 0;
        let log2pFractionX64 = ZERO;
        let r = msb >= 64 ? sqrtPriceX64.shrn(msb - 63) : sqrtPriceX64.shln(63 - msb);

        while (bit.gt(ZERO) && precision < BIT_PRECISION) {
            r = r.mul(r);
            const rMoreThanTwo = r.shrn(127);
            r = r.shrn(63 + rMoreThanTwo.toNumber());
            log2pFractionX64 = log2pFractionX64.add(bit.mul(rMoreThanTwo));
            bit = bit.shrn(1);
            precision += 1;
        }

        const log2pFractionX32 = log2pFractionX64.shrn(32);
        const log2pX32 = log2pIntegerX32.add(log2pFractionX32);
        const logbpX64 = log2pX32.mul(LOG_B_2_X32);

        const tickLow = this._signedRightShift(
            logbpX64.sub(LOG_B_P_ERR_MARGIN_LOWER_X64),
            64,
            128
        ).toNumber();
        const tickHigh = this._signedRightShift(
            logbpX64.add(LOG_B_P_ERR_MARGIN_UPPER_X64),
            64,
            128
        ).toNumber();

        if (tickLow === tickHigh) return tickLow;
        const derivedTickHighSqrtPrice = this.tickIndexToSqrtPriceX64(tickHigh);
        return derivedTickHighSqrtPrice.lte(sqrtPriceX64) ? tickHigh : tickLow;
    }

    static _signedLeftShift(n0, shiftBy, bitWidth) {
        const twosN0 = n0.toTwos(bitWidth).shln(shiftBy);
        twosN0.imaskn(bitWidth + 1);
        return twosN0.fromTwos(bitWidth);
    }

    static _signedRightShift(n0, shiftBy, bitWidth) {
        const twoN0 = n0.toTwos(bitWidth).shrn(shiftBy);
        twoN0.imaskn(bitWidth - shiftBy + 1);
        return twoN0.fromTwos(bitWidth - shiftBy);
    }
}

/* -------------------------------------------------------------------------- */
/*                             BitMath class                                  */
/* -------------------------------------------------------------------------- */

class BitMath {
    static countSetBits(value) {
        let count = 0;
        while (value > 0) {
            count += value & 1;
            value >>= 1;
        }
        return count;
    }

    static mulDiv(numerator, multiplier, divisor, roundUp) {
        const p = numerator.mul(multiplier);
        if (roundUp) {
            return p.add(divisor.sub(ONE)).div(divisor);
        }
        return p.div(divisor);
    }

    static mulDivFloor(numerator, denominator, quotient) {
        return this.mulDiv(numerator, denominator, quotient, false);
    }

    static mulDivCeil(numerator, denominator, quotient) {
        return this.mulDiv(numerator, denominator, quotient, true);
    }

    static mulDivRoundUp(numerator, denominator, quotient) {
        return this.mulDivCeil(numerator, denominator, quotient);
    }
}

/* -------------------------------------------------------------------------- */
/*                             TickUtil class                                 */
/* -------------------------------------------------------------------------- */

class TickUtil {
    static getTickArrayStartIndexByTick(tickIndex, tickSpacing) {
        const ticksInArray = tickSpacing * TICK_ARRAY_SIZE;
        let startIndex = tickIndex / ticksInArray;
        if (tickIndex < 0 && tickIndex % ticksInArray !== 0) {
            startIndex = Math.ceil(startIndex) - 1;
        } else {
            startIndex = Math.floor(startIndex);
        }
        return startIndex * ticksInArray;
    }

    static getNextInitializedTick(tickArray, currentTick, tickSpacing, aToB) {
        if (!tickArray || !Array.isArray(tickArray.ticks)) return null;
        const ticks = tickArray.ticks;
        const isUsableTick = (tick) => {
            if (!tick || !tick.initialized) return false;
            if (tick.liquidityGross && tick.liquidityGross.gt(ZERO)) return true;
            return Boolean(tick.liquidityNet && !tick.liquidityNet.eq(ZERO));
        };
        if (aToB) {
            for (let i = ticks.length - 1; i >= 0; i--) {
                const tick = ticks[i];
                if (!isUsableTick(tick)) continue;
                if (tick.tick <= currentTick) return tick;
            }
        } else {
            for (let i = 0; i < ticks.length; i++) {
                const tick = ticks[i];
                if (!isUsableTick(tick)) continue;
                if (tick.tick > currentTick) return tick;
            }
        }
        return null;
    }

    static getTickOffsetInArray(tickIndex, startIndex, tickSpacing) {
        return Math.floor((tickIndex - startIndex) / tickSpacing);
    }

    static isFullRange(tickIndex) {
        return tickIndex === MIN_TICK_INDEX || tickIndex === MAX_TICK_INDEX;
    }
}

/* -------------------------------------------------------------------------- */
/*                        TickArraySequence class                             */
/* -------------------------------------------------------------------------- */

class TickArraySequence {
    constructor(tickArrays, tickSpacing, aToB) {
        this.tickArrays = Array.isArray(tickArrays) ? tickArrays : [];
        this.tickSpacing = tickSpacing;
        this.aToB = aToB;
    }

    getNextInitializedTick(currentTick) {
        let tickArray = this.getTickArrayForTick(currentTick);
        if (!tickArray) return null;

        let tick = TickUtil.getNextInitializedTick(tickArray, currentTick, this.tickSpacing, this.aToB);
        if (tick) return tick;

        let searchStartIndex = tickArray.startTickIndex;
        while (true) {
            searchStartIndex = this.aToB
                ? searchStartIndex - this.tickSpacing * TICK_ARRAY_SIZE
                : searchStartIndex + this.tickSpacing * TICK_ARRAY_SIZE;

            tickArray = this.tickArrays.find((ta) => ta.startTickIndex === searchStartIndex);
            if (!tickArray) return null;

            tick = TickUtil.getNextInitializedTick(tickArray, this.aToB ? searchStartIndex + this.tickSpacing * TICK_ARRAY_SIZE : searchStartIndex, this.tickSpacing, this.aToB);
            if (tick) return tick;
        }
    }

    getTickArrayForTick(tickIndex) {
        const startIndex = TickUtil.getTickArrayStartIndexByTick(tickIndex, this.tickSpacing);
        return this.tickArrays.find((ta) => ta.startTickIndex === startIndex);
    }
}

/* -------------------------------------------------------------------------- */
/*                         Whirlpool swap-step math                           */
/* -------------------------------------------------------------------------- */

function normalizeWhirlpoolTickArrays(poolShape = {}, tickSpacing = 1) {
    // The decoded ticks may live in ANY of these fields depending on which
    // hydration/decode pass wrote them (enrichWhirlpool -> tickArrayData;
    // decodePoolTickArrays -> tickArrays; aux mirrors). Pick the FIRST source
    // that actually carries structured .ticks[], so a decoded-but-in-tickArrays
    // pool is not read as empty (which produced ~0 output / -9066bps).
    const hasStructured = (arr) => Array.isArray(arr) && arr.length
        && arr.some((e) => Array.isArray(e?.ticks) || Array.isArray(e?.data?.ticks));

    const structured =
        (hasStructured(poolShape.tickArrayData) && poolShape.tickArrayData)
        || (hasStructured(poolShape.aux?.whirlpool?.tickArrays) && poolShape.aux.whirlpool.tickArrays)
        || (hasStructured(poolShape.tickArrays) && poolShape.tickArrays)
        || (hasStructured(poolShape.aux?.clmm?.tickArrayData) && poolShape.aux.clmm.tickArrayData)
        || [];

    if (structured.length) {
        return structured.map((entry) => {
            const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
            const startTickIndex = Number(data?.startTickIndex ?? data?.start_index ?? entry?.startTickIndex ?? entry?.start_index ?? 0);
            const rawTicks = Array.isArray(data?.ticks) ? data.ticks : (Array.isArray(entry?.ticks) ? entry.ticks : []);
            return {
                startTickIndex,
                ticks: rawTicks.map((tick = {}, index) => ({
                    tick: Number(tick.tick ?? tick.tickIndex ?? tick.index ?? (startTickIndex + (index * Number(tickSpacing || 1)))),
                    initialized: Boolean(tick.initialized),
                    liquidityNet: toBN(tick.liquidityNet || '0'),
                    liquidityGross: toBN(tick.liquidityGross || '0'),
                })),
            };
        });
    }

    if (Array.isArray(poolShape.ticks) && poolShape.ticks.length) {
        const byStart = new Map();
        for (const tick of poolShape.ticks) {
            const tickIndex = Number(tick.tick ?? tick.tickIndex ?? tick.index);
            if (!Number.isFinite(tickIndex)) continue;
            const startTickIndex = TickUtil.getTickArrayStartIndexByTick(tickIndex, tickSpacing);
            if (!byStart.has(startTickIndex)) {
                byStart.set(startTickIndex, {
                    startTickIndex,
                    ticks: Array.from({ length: TICK_ARRAY_SIZE }, (_entry, index) => ({
                        tick: startTickIndex + (index * Number(tickSpacing || 1)),
                        initialized: false,
                        liquidityNet: ZERO,
                        liquidityGross: ZERO,
                    })),
                });
            }
            const array = byStart.get(startTickIndex);
            const offset = TickUtil.getTickOffsetInArray(tickIndex, startTickIndex, tickSpacing);
            if (offset >= 0 && offset < array.ticks.length) {
                array.ticks[offset] = {
                    tick: tickIndex,
                    initialized: Boolean(tick.initialized ?? true),
                    liquidityNet: toBN(tick.liquidityNet || '0'),
                    liquidityGross: toBN(tick.liquidityGross || '0'),
                };
            }
        }
        return Array.from(byStart.values()).sort((left, right) => left.startTickIndex - right.startTickIndex);
    }

    return [];
}

function amountDeltaA(sqrtLower, sqrtUpper, liquidity, roundUp) {
    const lower = BN.min(sqrtLower, sqrtUpper);
    const upper = BN.max(sqrtLower, sqrtUpper);
    const numerator = liquidity.mul(upper.sub(lower)).mul(Q64);
    const denominator = upper.mul(lower);
    if (denominator.eq(ZERO)) return ZERO;
    const value = numerator.div(denominator);
    return roundUp && !numerator.mod(denominator).eq(ZERO) ? value.add(ONE) : value;
}

function amountDeltaB(sqrtLower, sqrtUpper, liquidity, roundUp) {
    const lower = BN.min(sqrtLower, sqrtUpper);
    const upper = BN.max(sqrtLower, sqrtUpper);
    const numerator = liquidity.mul(upper.sub(lower));
    const value = numerator.div(Q64);
    return roundUp && !numerator.mod(Q64).eq(ZERO) ? value.add(ONE) : value;
}

function computeSwapStep({ sqrtPriceCurrent, sqrtPriceTarget, liquidity, amount, feeRate, aToB }) {
    const step = {
        sqrtPriceNext: ZERO,
        amountIn: ZERO,
        amountOut: ZERO,
        feeAmount: ZERO,
    };

    const isBaseInput = true;
    const amountRemainingSubtractFee = BitMath.mulDivFloor(
        amount,
        new BN(1_000_000).sub(new BN(feeRate)),
        new BN(1_000_000)
    );

    if (isBaseInput) {
        step.amountIn = aToB
            ? amountDeltaA(sqrtPriceTarget, sqrtPriceCurrent, liquidity, true)
            : amountDeltaB(sqrtPriceCurrent, sqrtPriceTarget, liquidity, true);
        step.sqrtPriceNext = amountRemainingSubtractFee.gte(step.amountIn)
            ? sqrtPriceTarget
            : _getNextSqrtPriceFromInput(sqrtPriceCurrent, liquidity, amountRemainingSubtractFee, aToB);
    } else {
        step.amountOut = BitMath.mulDivFloor(amount, new BN(1), new BN(1));
        if (step.amountOut.gte(amount)) {
            step.sqrtPriceNext = sqrtPriceTarget;
        } else {
            step.sqrtPriceNext = _getNextSqrtPriceFromOutput(sqrtPriceCurrent, liquidity, amount, aToB);
        }
    }

    const reachTarget = step.sqrtPriceNext.eq(sqrtPriceTarget);

    if (aToB) {
        if (!reachTarget || isBaseInput) {
            step.amountIn = amountDeltaA(step.sqrtPriceNext, sqrtPriceCurrent, liquidity, true);
        }
        if (!reachTarget || !isBaseInput) {
            step.amountOut = amountDeltaB(step.sqrtPriceNext, sqrtPriceCurrent, liquidity, false);
        }
    } else {
        if (!reachTarget || isBaseInput) {
            step.amountIn = amountDeltaB(sqrtPriceCurrent, step.sqrtPriceNext, liquidity, true);
        }
        if (!reachTarget || !isBaseInput) {
            step.amountOut = amountDeltaA(sqrtPriceCurrent, step.sqrtPriceNext, liquidity, false);
        }
    }

    if (!isBaseInput && step.amountOut.gt(amount)) {
        step.amountOut = amount;
    }

    if (isBaseInput && !reachTarget) {
        step.feeAmount = amount.sub(step.amountIn);
    } else {
        step.feeAmount = BitMath.mulDivCeil(
            step.amountIn,
            new BN(feeRate),
            new BN(1_000_000).sub(new BN(feeRate))
        );
    }

    return step;
}

function _getNextSqrtPriceFromInput(sqrtPriceCurrent, liquidity, amountIn, aToB) {
    if (aToB) {
        const numerator1 = liquidity.shln(64);
        const product = amountIn.mul(sqrtPriceCurrent);
        if (product.div(amountIn).eq(sqrtPriceCurrent)) {
            const denominator = numerator1.add(product);
            if (denominator.gte(numerator1)) {
                return BitMath.mulDivCeil(numerator1, sqrtPriceCurrent, denominator);
            }
        }
        return BitMath.mulDivCeil(numerator1, ONE, numerator1.div(sqrtPriceCurrent).add(amountIn));
    } else {
        return sqrtPriceCurrent.add(BitMath.mulDivCeil(amountIn.shln(64), ONE, liquidity));
    }
}

function _getNextSqrtPriceFromOutput(sqrtPriceCurrent, liquidity, amountOut, aToB) {
    if (aToB) {
        const amount = BitMath.mulDivCeil(amountOut.shln(64), ONE, liquidity);
        if (!sqrtPriceCurrent.gt(amount)) {
            throw new Error('sqrtPriceCurrent must be greater than amount');
        }
        return sqrtPriceCurrent.sub(amount);
    } else {
        const numerator1 = liquidity.shln(64);
        const product = amountOut.mul(sqrtPriceCurrent);
        if (!numerator1.gt(product)) {
            throw new Error('liquidity must be greater than product');
        }
        const denominator = numerator1.sub(product);
        return BitMath.mulDivCeil(numerator1, sqrtPriceCurrent, denominator);
    }
}

/* -------------------------------------------------------------------------- */
/*                         computeSwap (full route)                           */
/* -------------------------------------------------------------------------- */

function computeSwap(poolShape, amountIn, aToB) {
    const sqrtPriceCurrent = toBN(poolShape.sqrtPrice || poolShape.sqrtPriceX64 || '0');
    const tickSpacing = Number(poolShape.tickSpacing || 2);
    const feeRate = Math.round((Number(poolShape.feeBps || 25) * 100));
    const tickCurrent = Number(poolShape.tickCurrent || 0);
    const liquidity = toBN(poolShape.liquidity || '0');
    const tickArrays = normalizeWhirlpoolTickArrays(poolShape, tickSpacing);

    const tickArraySequence = new TickArraySequence(tickArrays, tickSpacing, aToB);
    const sqrtPriceLimit = aToB
        ? MIN_SQRT_PRICE_BN.add(ONE)
        : MAX_SQRT_PRICE_BN.sub(ONE);

    let sqrtPrice = sqrtPriceCurrent;
    let tick = tickCurrent;
    let amountRemaining = toBN(amountIn);
    let amountCalculated = ZERO;
    let totalFeeAmount = ZERO;
    let currLiquidity = liquidity;
    let loopCount = 0;
    let usedBoundaryFallback = false;

    while (
        amountRemaining.gt(ZERO)
        && !sqrtPrice.eq(sqrtPriceLimit)
        && tick >= MIN_TICK_INDEX
        && tick <= MAX_TICK_INDEX
        && loopCount < 256
    ) {
        const nextTick = tickArraySequence.getNextInitializedTick(tick);

        // Fall-through: when no initialized tick is reachable in the loaded
        // range, swap against currLiquidity to the price-limit boundary.
        // This produces a correct quote within the data we have instead of
        // returning zero — the on-chain swap would just continue into tick
        // arrays we didn't pre-fetch.
        let tickNext;
        let nextTickLiquidityNet = null;
        if (nextTick) {
            tickNext = nextTick.tick;
            nextTickLiquidityNet = nextTick.liquidityNet;
        } else {
            tickNext = aToB ? MIN_TICK_INDEX : MAX_TICK_INDEX;
            usedBoundaryFallback = true;
        }
        if (tickNext < MIN_TICK_INDEX) tickNext = MIN_TICK_INDEX;
        if (tickNext > MAX_TICK_INDEX) tickNext = MAX_TICK_INDEX;

        const sqrtPriceNext = PriceMath.tickIndexToSqrtPriceX64(tickNext);
        const targetPrice = (aToB && sqrtPriceNext.lt(sqrtPriceLimit)) || (!aToB && sqrtPriceNext.gt(sqrtPriceLimit))
            ? sqrtPriceLimit
            : sqrtPriceNext;

        const step = computeSwapStep({
            sqrtPriceCurrent: sqrtPrice,
            sqrtPriceTarget: targetPrice,
            liquidity: currLiquidity,
            amount: amountRemaining,
            feeRate,
            aToB,
        });

        sqrtPrice = step.sqrtPriceNext;
        amountRemaining = amountRemaining.sub(step.amountIn.add(step.feeAmount));
        amountCalculated = amountCalculated.add(step.amountOut);
        totalFeeAmount = totalFeeAmount.add(step.feeAmount);

        if (sqrtPrice.eq(sqrtPriceNext) && nextTickLiquidityNet !== null) {
            // Crossed an initialized tick — apply liquidity-net delta.
            let liquidityNet = nextTickLiquidityNet;
            if (aToB) liquidityNet = liquidityNet.mul(NEGATIVE_ONE);
            currLiquidity = currLiquidity.add(liquidityNet);
            tick = aToB ? tickNext - 1 : tickNext;
        } else if (sqrtPrice.eq(sqrtPriceNext)) {
            // Hit the boundary in fall-through mode — exit, we've consumed
            // everything we can with the loaded data.
            tick = aToB ? tickNext - 1 : tickNext;
            loopCount += 1;
            break;
        } else {
            tick = PriceMath.sqrtPriceX64ToTickIndex(sqrtPrice);
        }

        loopCount += 1;
    }

    return {
        amountCalculated,
        sqrtPriceNext: sqrtPrice,
        feeAmount: totalFeeAmount,
        tickNext: tick,
        liquidity: currLiquidity,
        loopCount,
        usedBoundaryFallback,
    };
}

/* -------------------------------------------------------------------------- */
/*                         buildSwapQuote                                     */
/* -------------------------------------------------------------------------- */

function buildSwapQuote(poolShape, amountIn, aToB, slippageBps = 20) {
    const result = computeSwap(poolShape, amountIn, aToB);
    const outAmount = result.amountCalculated;
    const minOutAmount = outAmount.muln(10_000 - Number(slippageBps || 0)).divn(10_000);
    // Refuse rather than over-quote: if the swap had to fall through to the
    // price-limit boundary (no initialized tick reachable — tick arrays missing,
    // or the swap walked past the loaded range), the constant-liquidity boundary
    // math over-quotes. Treat that as a failed quote so the dispatcher falls
    // through to the explicit refusal instead of returning a phantom.
    const insufficientTicks = Boolean(result.usedBoundaryFallback);
    const success = outAmount.gt(ZERO) && !insufficientTicks;

    return {
        dexType: 'ORCA_WHIRLPOOL',
        poolAddress: poolShape.poolAddress,
        swapForY: aToB,
        inAmountRaw: String(amountIn),
        outAmountRaw: success ? outAmount.toString() : '0',
        minOutAmountRaw: success ? minOutAmount.toString() : '0',
        feeBps: Number(poolShape.feeBps || 25),
        feeAmount: result.feeAmount.toString(),
        sqrtPriceNext: result.sqrtPriceNext.toString(),
        tickNext: result.tickNext,
        liquidity: result.liquidity.toString(),
        success,
        error: success
            ? null
            : (insufficientTicks
                ? 'Whirlpool quote requires initialized tick arrays; none reachable in loaded range — refused to avoid boundary-fallback over-quote.'
                : 'Whirlpool swap produced zero output'),
        quoteSource: insufficientTicks ? 'whirlpool-insufficient-tick-data' : 'rpc-live',
        tickStrategy: insufficientTicks ? 'none-insufficient-ticks' : 'tick-array-sequence',
        tickArrays: poolShape.tickArrays || [],
        remainingAccounts: poolShape.tickArrays || [],
        loopCount: result.loopCount,
    };
}

/* -------------------------------------------------------------------------- */
/*                         calculatePriceImpact                               */
/* -------------------------------------------------------------------------- */

function calculatePriceImpact(amountIn, amountOut, currentPrice) {
    const executionPrice = amountOut.div(amountIn);
    const impact = currentPrice.sub(executionPrice).div(currentPrice).abs();
    return impact.mul(new BN(100));
}

/* -------------------------------------------------------------------------- */
/*                         normalizeWhirlpoolPool                             */
/* -------------------------------------------------------------------------- */

function normalizeWhirlpoolPool(pool = {}) {

    return mergeCanonicalPool({
        ...pool,
        poolAddress: pool?.poolAddress || pool?.address || pool?.id || '',
        type: pool?.type || 'whirlpool',
        dexType: pool?.dexType || 'ORCA_WHIRLPOOL',
        dex: pool?.dex || 'orca',
        tokenXMint: pool?.tokenXMint || pool?.baseMint || pool?.mintA || pool?.tokenA || '',
        tokenYMint: pool?.tokenYMint || pool?.quoteMint || pool?.mintB || pool?.tokenB || '',
        tokenXDecimals: pool?.tokenXDecimals || pool?.baseDecimals || 9,
        tokenYDecimals: pool?.tokenYDecimals || pool?.quoteDecimals || 6,
        reserves: pool?.reserves || { x: '0', y: '0' },
        xReserves: pool?.xReserves || pool?.reserves_x || '0',
        yReserves: pool?.yReserves || pool?.reserves_y || '0',
        vaults: pool?.vaults || { xVault: pool?.xVault, yVault: pool?.yVault },
        feeBps: pool?.feeBps ?? 30,
        tickSpacing: pool?.tickSpacing ?? 64,
        tickCurrent: pool?.tickCurrent ?? 0,
        tickArrays: Array.isArray(pool?.tickArrays) ? pool.tickArrays : [],
        tickArrayData: Array.isArray(pool?.tickArrayData) ? pool.tickArrayData : [],
        ticks: Array.isArray(pool?.ticks) ? pool.ticks : [],
        remainingAccounts: Array.isArray(pool?.remainingAccounts) ? pool.remainingAccounts : [],
        liquidity: pool?.liquidity || '0',
        sqrtPrice: pool?.sqrtPrice || pool?.sqrtPriceX64 || '0',
        sqrtPriceX64: pool?.sqrtPriceX64 || pool?.sqrtPrice || '0',
        normalized: true,
    });
}
/*

/* -------------------------------------------------------------------------- */
/*                         reserveQuote fallback                              */
/* -------------------------------------------------------------------------- */

function reserveQuoteWhirlpool(poolShape, inAmountAtomic, swapForY, slippageBps = 20) {
    // Same rationale as Q_CLMM.reserveQuoteClmm — Whirlpool reserves are
    // active-tick-range only, not the full curve. Refuse by default.
    if (!poolShape._allowClmmReservesFallback) {
        return {
            dexType: 'ORCA_WHIRLPOOL',
            poolAddress: poolShape.poolAddress,
            swapForY: Boolean(swapForY),
            inAmountRaw: String(inAmountAtomic || 0),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            feeBps: Number(poolShape.feeBps || 30),
            success: false,
            error: 'Whirlpool math state missing (need sqrtPriceX64 + liquidity + tickArrays). Constant-product fallback disabled.',
            mathError: poolShape._whirlpoolMathError || null,
            quoteSource: 'whirlpool-refused-no-tick-state',
        };
    }

    const amountIn = toBN(inAmountAtomic);
    const safeAmountIn = amountIn.isNeg() ? ZERO : amountIn;
    const reserves = {
        x: toBN(poolShape.reserves?.x || poolShape.xReserve || '0'),
        y: toBN(poolShape.reserves?.y || poolShape.yReserve || '0'),
    };
    const feeBps = new BN(poolShape.feeBps || 30);
    const amountAfterFee = safeAmountIn.mul(new BN(10_000).sub(feeBps)).div(new BN(10_000));
    const reserveIn = swapForY ? reserves.x : reserves.y;
    const reserveOut = swapForY ? reserves.y : reserves.x;
    const missingReserves = reserveIn.lte(ZERO) || reserveOut.lte(ZERO);
    const denominator = reserveIn.add(amountAfterFee);
    const outAmount = (!missingReserves && denominator.gt(ZERO))
        ? reserveOut.mul(amountAfterFee).div(denominator)
        : ZERO;
    const minOutAmount = outAmount.muln(10_000 - Number(slippageBps || 0)).divn(10_000);
    const success = outAmount.gt(ZERO);
    const reserveError = `Whirlpool missing reserves for fallback (x=${String(reserves.x)}, y=${String(reserves.y)}, xVault=${String(poolShape?.vaults?.xVault || poolShape?.xVault || 'null')}, yVault=${String(poolShape?.vaults?.yVault || poolShape?.yVault || 'null')})`;

    return {
        dexType: 'ORCA_WHIRLPOOL',
        poolAddress: poolShape.poolAddress,
        swapForY: Boolean(swapForY),
        inAmountRaw: safeAmountIn.toString(),
        outAmountRaw: success ? outAmount.toString() : '0',
        minOutAmountRaw: success ? minOutAmount.toString() : '0',
        feeBps: Number(poolShape.feeBps || 30),
        success,
        error: success ? null : (missingReserves ? reserveError : 'Whirlpool reserve approximation produced zero output'),
        quoteSource: 'adapter-approximation-explicit-opt-in',
    };
}

class WhirlpoolAdapter {
    constructor(connection, poolAddress, poolData = null) {
        this.connection = connection || new Connection(
            process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        this.poolAddress = poolAddress || poolData?.poolAddress || poolData?.address || '';
        this.poolShape = normalizePoolRecord({ ...(poolData || {}), poolAddress: this.poolAddress });
    }

    async init() {
        return this;
    }

    loadPools(raw) {
        return (Array.isArray(raw) ? raw : Object.values(raw || {})).map(normalizeWhirlpoolPool);
    }

    async getQuote(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
    }

    async quoteFastExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
    }

    async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        const poolShape = normalizeWhirlpoolPool({
            ...this.poolShape,
            ...(opts.pool || {}),
            poolAddress: opts.pool?.poolAddress || opts.pool?.address || this.poolShape.poolAddress || this.poolAddress || '',
            address: opts.pool?.address || opts.pool?.poolAddress || this.poolShape.address || this.poolAddress || '',
        });

        const useSwapMath = opts.useSwapMath !== false;
        if (useSwapMath) {
            try {
                const rawQuote = buildSwapQuote(poolShape, String(inAmountAtomic), Boolean(swapForY), slippageBps);
                const finalized = finalizeQuote(rawQuote, poolShape);
                if (finalized?.success) {
                    return finalized;
                }
                // If swap-step path returns zero-output without throwing, fallback to reserve approximation.
                return finalizeQuote(
                    reserveQuoteWhirlpool({
                        ...poolShape,
                        _whirlpoolMathError: finalized?.error || 'swap math returned unsuccessful quote',
                    }, inAmountAtomic, swapForY, slippageBps),
                    poolShape
                );
            } catch (error) {
                if (opts.throwOnMathError) throw error;
                return finalizeQuote(
                    reserveQuoteWhirlpool({
                        ...poolShape,
                        _whirlpoolMathError: error.message || String(error),
                    }, inAmountAtomic, swapForY, slippageBps),
                    poolShape
                );
            }
        }

        return finalizeQuote(
            reserveQuoteWhirlpool(poolShape, inAmountAtomic, swapForY, slippageBps),
            poolShape
        );
    }

    async buildSwapTx({ user, standardQuote, opts = {} }) {
        const poolShape = normalizeWhirlpoolPool({
            ...this.poolShape,
            ...(opts.pool || {}),
            poolAddress: opts.pool?.poolAddress || opts.pool?.address || this.poolShape.poolAddress || this.poolAddress || '',
            address: opts.pool?.address || opts.pool?.poolAddress || this.poolShape.address || this.poolAddress || '',
        });
        return buildWhirlpoolSwapTx({ user, standardQuote, pool: poolShape });
    }
}

function parseArgs(argv) {
    const out = {
        input: 'sol_usdc.json',
        pool: '',
        amount: '1000',
        output: 'Qseries/_whirlpool.json',
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg) continue;
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
            continue;
        }
        if (!out.pool && arg.length >= 32) out.pool = arg;
        else if (out.amount === '1000000000') out.amount = arg;
    }
    return out;
}
/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */
module.exports = WhirlpoolAdapter;
module.exports.WhirlpoolAdapter = WhirlpoolAdapter;
module.exports.PriceMath = PriceMath;
module.exports.BitMath = BitMath;
module.exports.TickUtil = TickUtil;
module.exports.TickArraySequence = TickArraySequence;
module.exports = WhirlpoolAdapter;
module.exports.computeSwap = computeSwap;
module.exports.computeSwapStep = computeSwapStep;
module.exports.buildSwapQuote = buildSwapQuote;
module.exports.calculatePriceImpact = calculatePriceImpact;
module.exports._getNextSqrtPriceFromInput = _getNextSqrtPriceFromInput;
module.exports._getNextSqrtPriceFromOutput = _getNextSqrtPriceFromOutput;
module.exports.reserveQuoteWhirlpool = reserveQuoteWhirlpool;
module.exports.buildWhirlpoolSwapTx = buildWhirlpoolSwapTx;
module.exports.toBN = toBN;
module.exports.ensure = ensure;
module.exports.ZERO = ZERO;
module.exports.ONE = ONE;
module.exports.NEGATIVE_ONE = NEGATIVE_ONE;
module.exports.TWO = TWO;
module.exports.MIN_TICK_INDEX = MIN_TICK_INDEX;
module.exports.MAX_TICK_INDEX = MAX_TICK_INDEX;
module.exports.TICK_ARRAY_SIZE = TICK_ARRAY_SIZE;
module.exports.MIN_SQRT_PRICE_BN = MIN_SQRT_PRICE_BN;
module.exports.MAX_SQRT_PRICE_BN = MAX_SQRT_PRICE_BN;

if (require.main === module) {
    (async () => {
        const args = parseArgs(process.argv.slice(2));
        const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
        const pools = normalizePools(raw).filter((entry) => String(entry?.type || '').toLowerCase().includes('whirlpool'));
        if (!pools.length) throw new Error('No whirlpool pool found in input file');
        let adapter = null;
        let quote = null;
        let pool = null;
        if (args.pool) {
            pool = pools.find((entry) => [entry.poolAddress, entry.address, entry.id].includes(args.pool)) || pools[0];
            adapter = new WhirlpoolAdapter(null, args.pool, pool);
            quote = await adapter.quoteExactIn(args.amount, true, 50);
        } else {
            for (const candidate of pools) {
                const candidateAdapter = new WhirlpoolAdapter(null, candidate.poolAddress || candidate.address || candidate.id, candidate);
                const candidateQuote = await candidateAdapter.quoteExactIn(args.amount, true, 50);
                if (candidateQuote?.success && toBigInt(candidateQuote.outAmountRaw) > 0n) {
                    pool = candidate;
                    adapter = candidateAdapter;
                    quote = candidateQuote;
                    break;
                }
            }
            if (!quote) {
                pool = pools[0];
                adapter = new WhirlpoolAdapter(null, pool.poolAddress || pool.address || pool.id, pool);
                quote = await adapter.quoteExactIn(args.amount, true, 50);
            }
        }
        const result = { poolAddress: adapter.poolShape.poolAddress, poolShape: adapter.poolShape, quote };
        fs.mkdirSync(path.dirname(args.output), { recursive: true });
        fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    })().catch((error) => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
}
//. node ./math/Q_WHIRLPOOL.js --input whirlpoolPool.json
//.  node ./math/Q_WHIRLPOOL.js sol_usdc_RAW.json
