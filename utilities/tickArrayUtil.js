'use strict';

const BN = require('bn.js');
const Decimal = require('decimal.js');

const Q64 = new BN(1).shln(64);
const BN_ZERO = new BN(0);
const BN_ONE = new BN(1);
const FEE_RATE_DENOMINATOR_VALUE = new BN(1_000_000);
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const MIN_SQRT_PRICE_X64 = new BN('4295048016');
const MAX_SQRT_PRICE_X64 = new BN('79226673521066979257578248091');
const LOG_B_2_X32 = new BN('59543866431248');
const LOG_B_P_ERR_MARGIN_LOWER_X64 = new BN('184467440737095516');
const LOG_B_P_ERR_MARGIN_UPPER_X64 = new BN('15793534762490258745');
const BIT_PRECISION = 16;
const TICK_ARRAY_BITMAP_SIZE = 512;
const TICK_ARRAY_SIZE = 60;
const EXTENSION_TICKARRAY_BITMAP_SIZE = 14;
const POOL_TICK_ARRAY_BITMAP_SEED = Buffer.from('pool_tick_array_bitmap_extension', 'utf8');
const TICK_ARRAY_SEED = Buffer.from('tick_array', 'utf8');
const TICK_TO_SQRT_PRICE_FACTORS = [
  { bit: 0, factor: new BN('fffcb933bd6fb800', 16) },
  { bit: 1, factor: new BN('fff97272373d4000', 16) },
  { bit: 2, factor: new BN('fff2e50f5f657000', 16) },
  { bit: 3, factor: new BN('ffe5caca7e10f000', 16) },
  { bit: 4, factor: new BN('ffcb9843d60f7000', 16) },
  { bit: 5, factor: new BN('ff973b41fa98e800', 16) },
  { bit: 6, factor: new BN('ff2ea16466c9b000', 16) },
  { bit: 7, factor: new BN('fe5dee046a9a3800', 16) },
  { bit: 8, factor: new BN('fcbe86c7900bb000', 16) },
  { bit: 9, factor: new BN('f987a7253ac65800', 16) },
  { bit: 10, factor: new BN('f3392b0822bb6000', 16) },
  { bit: 11, factor: new BN('e7159475a2caf000', 16) },
  { bit: 12, factor: new BN('d097f3bdfd2f2000', 16) },
  { bit: 13, factor: new BN('a9f746462d9f8000', 16) },
  { bit: 14, factor: new BN('70d869a156f31c00', 16) },
  { bit: 15, factor: new BN('31be135f97ed3200', 16) },
  { bit: 16, factor: new BN('9aa508b5b85a500', 16) },
  { bit: 17, factor: new BN('5d6af8dedc582c', 16) },
  { bit: 18, factor: new BN('2216e584f5fa', 16) },
];

function mulDivFloor(a, b, denominator) {
  if (denominator.isZero()) throw new Error('Division by zero');
  return a.mul(b).div(denominator);
}

function mulDivCeil(a, b, denominator) {
  if (denominator.isZero()) throw new Error('Division by zero');
  const product = a.mul(b);
  const quotient = product.div(denominator);
  return product.mod(denominator).isZero() ? quotient : quotient.addn(1);
}

function mostSignificantBit(n) {
  return n.isZero() ? -1 : n.bitLength() - 1;
}

function i32ToBytesBE(num) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(num, 0);
  return buffer;
}

function findProgramAddress(seeds, programId) {
  const { PublicKey } = require('@solana/web3.js');
  const [publicKey, nonce] = PublicKey.findProgramAddressSync(seeds, programId);
  return { publicKey, nonce };
}

function getPdaTickArrayAddress(programId, poolId, startIndex) {
  return findProgramAddress([TICK_ARRAY_SEED, poolId.toBuffer(), i32ToBytesBE(startIndex)], programId);
}

function getPdaExBitmapAccount(programId, poolId) {
  return findProgramAddress([POOL_TICK_ARRAY_BITMAP_SEED, poolId.toBuffer()], programId);
}

class TickArrayBitmapUtil {
  static scanLinearBitmap({ bitmap, tickSpacing, offset, checkInfo }) {
    const result = [];
    const totalBits = bitmap.length * 8;
    let startBit = 0;
    let endBit = totalBits - 1;

    if (checkInfo) {
      const threshold = checkInfo.tick / (tickSpacing * TICK_ARRAY_SIZE) - offset;
      if (checkInfo.valueType === 'gte') startBit = Math.max(0, Math.ceil(threshold));
      else endBit = Math.min(totalBits - 1, Math.floor(threshold));
    }

    if (startBit > endBit) return result;

    const startByte = Math.floor(startBit / 8);
    const endByte = Math.floor(endBit / 8);

    for (let i = startByte; i <= endByte; i++) {
      if (!bitmap[i]) continue;

      const jStart = i === startByte ? startBit % 8 : 0;
      const jEnd = i === endByte ? endBit % 8 : 7;
      for (let j = jStart; j <= jEnd; j++) {
        if (bitmap[i] & (1 << j)) {
          result.push((i * 8 + j + offset) * tickSpacing * TICK_ARRAY_SIZE);
        }
      }
    }
    return result;
  }

  static findPoolBitmap({ bitmap, tickSpacing, checkInfo }) {
    if (checkInfo) {
      const i = Math.floor(checkInfo.tick / TICK_ARRAY_SIZE / tickSpacing);
      if (checkInfo.valueType === 'lte' && i < -512) return [];
      if (checkInfo.valueType === 'gte' && i > 512) return [];
    }
    return this.scanLinearBitmap({ bitmap, tickSpacing, offset: -TICK_ARRAY_BITMAP_SIZE, checkInfo });
  }

  static findPositiveTickArrayBitmap({ bitmap, tickSpacing, checkInfo }) {
    if (checkInfo) {
      const i = Math.floor(checkInfo.tick / TICK_ARRAY_SIZE / tickSpacing);
      if (checkInfo.valueType === 'lte' && i < 512) return [];
    }
    return this.scanLinearBitmap({ bitmap, tickSpacing, offset: TICK_ARRAY_BITMAP_SIZE, checkInfo });
  }

  static findNegativeTickArrayBitmap({ bitmap, tickSpacing, count, checkInfo }) {
    const result = [];

    if (checkInfo) {
      const i = Math.floor(checkInfo.tick / TICK_ARRAY_SIZE / tickSpacing);
      if (checkInfo.valueType === 'gte' && i >= -512) return result;
    }

    const maxFlatIndex =
      checkInfo?.valueType === 'lte' ? Math.floor(checkInfo.tick / (TICK_ARRAY_SIZE * tickSpacing)) + 7680 : Infinity;
    const minFlatIndex =
      checkInfo?.valueType === 'gte' ? Math.ceil(checkInfo.tick / (TICK_ARRAY_SIZE * tickSpacing)) + 7680 : 0;

    outer: for (let arrayIndex = 0; arrayIndex < EXTENSION_TICKARRAY_BITMAP_SIZE; arrayIndex++) {
      const reversedIndex = EXTENSION_TICKARRAY_BITMAP_SIZE - 1 - arrayIndex;
      for (let searchIndex = 0; searchIndex < 512; searchIndex++) {
        const flatIndex = arrayIndex * 512 + searchIndex;

        if (flatIndex > maxFlatIndex) break outer;
        if (flatIndex < minFlatIndex) continue;

        const byteOffset = reversedIndex * 64 + Math.floor(searchIndex / 8);
        if (!bitmap[byteOffset]) {
          searchIndex = Math.floor(searchIndex / 8) * 8 + 7;
          continue;
        }
        if (bitmap[byteOffset] & (1 << (searchIndex % 8))) {
          result.push((arrayIndex * 512 + searchIndex - 7680) * TICK_ARRAY_SIZE * tickSpacing);
          if (count !== undefined && result.length >= count) break outer;
        }
      }
    }
    return result;
  }

  static findTickArrayStartIndex({ tickSpacing, poolBitmap, tickArrayBitmap, findInfo }) {
    if (findInfo.type === 'all') {
      return [
        ...this.findNegativeTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.negativeTickArrayBitmap }),
        ...this.findPoolBitmap({ tickSpacing, bitmap: poolBitmap }),
        ...this.findPositiveTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.positiveTickArrayBitmap }),
      ];
    }

    const tickStart = TickArrayUtil.getTickArrayStartIndex(findInfo.tickArrayCurrent, tickSpacing);
    const { count } = findInfo;

    if (findInfo.type === 'oneForZero') {
      const checkInfo = { tick: tickStart, valueType: 'gte' };
      return this.collectUntil([
        () => this.findNegativeTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.negativeTickArrayBitmap, checkInfo }),
        () => this.findPoolBitmap({ tickSpacing, bitmap: poolBitmap, checkInfo }),
        () => this.findPositiveTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.positiveTickArrayBitmap, checkInfo }),
      ], count);
    }

    if (findInfo.type === 'zeroForOne') {
      const checkInfo = { tick: tickStart, valueType: 'lte' };
      return this.collectUntil([
        () => this.findPositiveTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.positiveTickArrayBitmap, checkInfo }).sort((a, b) => b - a),
        () => this.findPoolBitmap({ tickSpacing, bitmap: poolBitmap, checkInfo }).sort((a, b) => b - a),
        () => this.findNegativeTickArrayBitmap({ tickSpacing, bitmap: tickArrayBitmap.negativeTickArrayBitmap, checkInfo }).sort((a, b) => b - a),
      ], count);
    }

    throw new Error('find info type check error');
  }

  static collectUntil(finders, count) {
    const collected = [];
    for (const finder of finders) {
      if (count !== undefined && collected.length >= count) break;
      collected.push(...finder());
    }
    return collected.slice(0, count);
  }

  static findTickArrayAddress(params) {
    return this.findTickArrayStartIndex(params).map(
      (i) => getPdaTickArrayAddress(params.programId, params.poolId, i).publicKey,
    );
  }

  static maxTickInTickarrayBitmap(tickSpacing) {
    return tickSpacing * TICK_ARRAY_SIZE * TICK_ARRAY_BITMAP_SIZE;
  }
}

class TickArrayUtil {
  static firstinitializedTick({ data, zeroForOne }) {
    if (zeroForOne) {
      for (let i = data.ticks.length - 1; i >= 0; i--) {
        if (TickUtil.isInitialized({ data: data.ticks[i] })) return data.ticks[i];
      }
    } else {
      for (let i = 0; i < data.ticks.length; i++) {
        if (TickUtil.isInitialized({ data: data.ticks[i] })) return data.ticks[i];
      }
    }
    return undefined;
  }

  static nextInitalizedTick({ data, currentTickIndex, tickSpacing, zeroForOne }) {
    const currentTickArrayStartIndex = this.getTickArrayStartIndex(currentTickIndex, tickSpacing);
    if (currentTickArrayStartIndex !== data.startTickIndex) return undefined;
    const offsetInArray = Math.floor((currentTickIndex - data.startTickIndex) / tickSpacing);

    if (zeroForOne) {
      for (let i = offsetInArray; i >= 0; i--) {
        if (TickUtil.isInitialized({ data: data.ticks[i] })) return data.ticks[i];
      }
    } else {
      for (let i = offsetInArray + 1; i < TICK_ARRAY_SIZE; i++) {
        if (TickUtil.isInitialized({ data: data.ticks[i] })) return data.ticks[i];
      }
    }
    return undefined;
  }

  static getTickArrayStartIndex(tickIndex, tickSpacing) {
    const ticksInArray = this.tickCount(tickSpacing);
    const start = Math.floor(tickIndex / ticksInArray);
    return start * ticksInArray;
  }

  static getTickOffsetInArray(tick, tickSpacing) {
    if (tick % tickSpacing !== 0) throw new Error('tickIndex % tickSpacing not equal 0');
    const startIndex = this.getTickArrayStartIndex(tick, tickSpacing);
    return Math.floor((tick - startIndex) / tickSpacing);
  }

  static tickCount(tickSpacing) {
    return TICK_ARRAY_SIZE * tickSpacing;
  }

  static getMinTick(tickSpacing) {
    return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  }

  static getMaxTick(tickSpacing) {
    return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  }
}

class TickUtil {
  static isInitialized({ data }) {
    return this.hasLiquidity({ data }) || this.hasLimitOrders({ data });
  }

  static hasLimitOrders({ data }) {
    return !data.ordersAmount.isZero() || !data.partFilledOrdersRemaining.isZero();
  }

  static hasLiquidity({ data }) {
    return !data.liquidityGross.isZero();
  }

  static isValidTick(tick) {
    return tick >= MIN_TICK && tick <= MAX_TICK;
  }

  static checkTick(tick) {
    if (!this.isValidTick(tick)) throw new Error(`Tick ${tick} is out of range [${MIN_TICK}, ${MAX_TICK}]`);
  }

  static getSqrtPriceAtTick(tick) {
    this.checkTick(tick);
    const absTick = Math.abs(tick);
    let ratio = Q64.clone();

    for (const { bit, factor } of TICK_TO_SQRT_PRICE_FACTORS) {
      if ((absTick & (1 << bit)) !== 0) ratio = mulDivFloor(ratio, factor, Q64);
    }

    if (tick > 0) ratio = mulDivFloor(Q64, Q64, ratio);
    return ratio;
  }

  static getLimitOrderOutput({ amountIn, tick, zeroForOne }) {
    if (zeroForOne) return mulDivFloor(amountIn, TickUtil.getPriceAtTick(tick, false), Q64);
    return mulDivFloor(amountIn, Q64, TickUtil.getPriceAtTick(tick, true));
  }

  static getLimitOrderInput({ amountOut, tick, zeroForOne }) {
    if (zeroForOne) return mulDivCeil(amountOut, TickUtil.getPriceAtTick(tick, true), Q64);
    return mulDivCeil(amountOut, Q64, TickUtil.getPriceAtTick(tick, false));
  }

  static limitOrderUnfilledAmount({ tick }) {
    return tick.ordersAmount.add(tick.partFilledOrdersRemaining);
  }

  static matchLimitOrder({ tick, swapAmount, swapDirectionZeroForOne, isBaseInput, feeRate, isFeeOnInput }) {
    const result = { amountIn: BN_ZERO, amountOut: BN_ZERO, ammFeeAmount: BN_ZERO };
    const totalUnfilledAmount = this.limitOrderUnfilledAmount({ tick });
    if (swapAmount.isZero() || totalUnfilledAmount.isZero()) return result;

    if (isBaseInput) {
      if (isFeeOnInput) {
        result.ammFeeAmount = mulDivCeil(swapAmount, new BN(feeRate), FEE_RATE_DENOMINATOR_VALUE);
        result.amountIn = swapAmount.sub(result.ammFeeAmount);
      } else {
        result.amountIn = swapAmount;
      }

      result.amountOut = this.getLimitOrderOutput({
        amountIn: result.amountIn,
        tick: tick.tick,
        zeroForOne: swapDirectionZeroForOne,
      });

      if (result.amountOut.gt(totalUnfilledAmount)) {
        result.amountOut = totalUnfilledAmount;
        result.amountIn = this.getLimitOrderInput({
          amountOut: totalUnfilledAmount,
          tick: tick.tick,
          zeroForOne: !swapDirectionZeroForOne,
        });

        if (isFeeOnInput) {
          result.ammFeeAmount = mulDivCeil(
            result.amountIn,
            new BN(feeRate),
            FEE_RATE_DENOMINATOR_VALUE.sub(new BN(feeRate)),
          );
        }
      }
    } else {
      const netOutput = BN.min(swapAmount, totalUnfilledAmount);

      if (isFeeOnInput) {
        result.amountOut = netOutput;
      } else {
        result.amountOut = BN.min(
          mulDivCeil(netOutput, FEE_RATE_DENOMINATOR_VALUE, FEE_RATE_DENOMINATOR_VALUE.sub(new BN(feeRate))),
          totalUnfilledAmount,
        );
      }

      result.amountIn = this.getLimitOrderInput({
        amountOut: result.amountOut,
        tick: tick.tick,
        zeroForOne: !swapDirectionZeroForOne,
      });

      if (isFeeOnInput) {
        result.ammFeeAmount = mulDivCeil(
          result.amountIn,
          new BN(feeRate),
          FEE_RATE_DENOMINATOR_VALUE.sub(new BN(feeRate)),
        );
      }
    }

    let consumeFromPartRemaining = BN_ZERO;
    if (tick.partFilledOrdersRemaining.gt(BN_ZERO)) {
      consumeFromPartRemaining = BN.min(tick.partFilledOrdersRemaining, result.amountOut);

      if (consumeFromPartRemaining.gt(BN_ZERO)) {
        tick.unfilledRatioX64 = mulDivFloor(
          tick.unfilledRatioX64,
          tick.partFilledOrdersRemaining.sub(consumeFromPartRemaining),
          tick.partFilledOrdersRemaining,
        );
      }

      tick.partFilledOrdersRemaining = tick.partFilledOrdersRemaining.sub(consumeFromPartRemaining);
    }

    const amountOutContinueToConsume = result.amountOut.sub(consumeFromPartRemaining);
    if (amountOutContinueToConsume.gt(BN_ZERO)) {
      if (!tick.partFilledOrdersRemaining.isZero()) throw new Error('!tick.partFilledOrdersRemaining.isZero()');
      if (tick.ordersAmount.lt(amountOutContinueToConsume)) throw new Error('InvalidLimitOrderAmount');

      tick.orderPhase = tick.orderPhase.add(BN_ONE);
      tick.unfilledRatioX64 = mulDivFloor(Q64, tick.ordersAmount.sub(amountOutContinueToConsume), tick.ordersAmount);
      tick.partFilledOrdersRemaining = tick.ordersAmount.sub(amountOutContinueToConsume);
      tick.ordersAmount = BN_ZERO;
    }

    if (!isFeeOnInput) {
      result.ammFeeAmount = mulDivCeil(result.amountOut, new BN(feeRate), FEE_RATE_DENOMINATOR_VALUE);
      result.amountOut = result.amountOut.sub(result.ammFeeAmount);
    }

    return result;
  }

  static getPriceAtTick(tick, roundUp) {
    const sqrtPriceX64 = this.getSqrtPriceAtTick(tick);
    if (roundUp) return sqrtPriceX64.mul(sqrtPriceX64).add(Q64.subn(1)).div(Q64);
    return sqrtPriceX64.mul(sqrtPriceX64).div(Q64);
  }

  static getTickAtSqrtPrice(sqrtPriceX64) {
    if (!(sqrtPriceX64.gte(MIN_SQRT_PRICE_X64) && sqrtPriceX64.lte(MAX_SQRT_PRICE_X64))) {
      throw new Error('SqrtPriceX64');
    }

    const msb = mostSignificantBit(sqrtPriceX64);
    const msbMinus64 = msb - 64;
    const log2pIntegerX32 = msbMinus64 >= 0
      ? new BN(msbMinus64).shln(32)
      : new BN(-msbMinus64).shln(32).neg();

    let r = msb >= 64 ? sqrtPriceX64.shrn(msb - 63) : sqrtPriceX64.shln(63 - msb);
    let log2pFractionX64 = new BN(0);
    let bit = new BN(1).shln(63);

    for (let precision = 0; precision < BIT_PRECISION && !bit.isZero(); precision++) {
      r = r.mul(r);
      const isRMoreThanTwo = r.shrn(127).toNumber();
      r = r.shrn(63 + isRMoreThanTwo);
      if (isRMoreThanTwo) log2pFractionX64 = log2pFractionX64.add(bit);
      bit = bit.shrn(1);
    }

    const log2pX32 = log2pIntegerX32.add(log2pFractionX64.shrn(32));
    const logSqrt10001X64 = log2pX32.mul(LOG_B_2_X32);
    const tickLow = this.signedShrn64(logSqrt10001X64.sub(LOG_B_P_ERR_MARGIN_LOWER_X64));
    const tickHigh = this.signedShrn64(logSqrt10001X64.add(LOG_B_P_ERR_MARGIN_UPPER_X64));

    if (tickLow === tickHigh) return tickLow;
    return TickUtil.getSqrtPriceAtTick(tickHigh).lte(sqrtPriceX64) ? tickHigh : tickLow;
  }

  static signedShrn64(bn) {
    if (bn.isNeg()) {
      const q64 = new BN(1).shln(64);
      const result = bn.div(q64);
      if (!bn.mod(q64).isZero()) return result.subn(1).toNumber();
      return result.toNumber();
    }
    return bn.shrn(64).toNumber();
  }

  static sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB) {
    const sqrtPriceSquared = sqrtPriceX64.mul(sqrtPriceX64);
    const decimalDiff = decimalsA - decimalsB;
    const decimalPrecision = 20;
    const precisionMultiplier = new BN(10).pow(new BN(decimalPrecision));
    const scaledResult = sqrtPriceSquared.mul(precisionMultiplier).div(new BN(1).shln(128));
    let resultStr = scaledResult.toString();

    while (resultStr.length <= decimalPrecision) resultStr = `0${resultStr}`;

    const integerPart = resultStr.slice(0, -decimalPrecision);
    const decimalPart = resultStr.slice(-decimalPrecision);
    return new Decimal(`${integerPart}.${decimalPart}`).mul(new Decimal(10).pow(decimalDiff));
  }

  static tickToPrice(tick, decimalsA, decimalsB) {
    return this.sqrtPriceX64ToPrice(TickUtil.getSqrtPriceAtTick(tick), decimalsA, decimalsB);
  }

  static priceToTick(price, decimalsA, decimalsB) {
    const adjustedPrice = price.div(Math.pow(10, decimalsA - decimalsB));
    const tick = adjustedPrice.log().div(new Decimal(1.0001).log()).floor();
    return Math.max(MIN_TICK, Math.min(MAX_TICK, tick.toNumber()));
  }

  static priceToSqrtPriceX64(price, decimalsA, decimalsB) {
    const adjustedPrice = price.div(Math.pow(10, decimalsA - decimalsB));
    return new BN(adjustedPrice.sqrt().mul(new Decimal(2).pow(64)).toFixed(0));
  }

  static toTickIndex(tick, tickSpacing) {
    if (tick >= 0) return tick - (tick % tickSpacing);
    return tick - (tick % tickSpacing) - (tick % tickSpacing !== 0 ? tickSpacing : 0);
  }

  static getPriceAndTick({ price, mintADecimals, mintBDecimals, zeroForOne, tickSpacing }) {
    let p = price.clamp(1 / 10 ** Math.max(mintADecimals, mintBDecimals), Number.MAX_SAFE_INTEGER);
    if (!zeroForOne) p = new Decimal(1).div(p);
    const newTick = TickUtil.toTickIndex(TickUtil.priceToTick(p, mintADecimals, mintBDecimals), tickSpacing);
    const newPrice = TickUtil.tickToPrice(newTick, mintADecimals, mintBDecimals);
    return {
      price: zeroForOne ? newPrice : new Decimal(1).div(newPrice),
      tick: newTick,
    };
  }
}

async function fetchTickArrays(programId, connection, poolId, currentTick, tickSpacing, tickArrayBitmap, zeroForOne = true) {
  const {
    getMultipleAccountsInfo,
    TickArrayBitmapExtensionLayout,
    TickArrayLayout,
  } = require('@raydium-io/raydium-sdk-v2');
  const tickArrays = [];
  const tickArrayBitmapExtension = getPdaExBitmapAccount(programId, poolId).publicKey;
  const tickArrayBitmapExtensionRes = await connection.getAccountInfo(tickArrayBitmapExtension);
  if (!tickArrayBitmapExtensionRes) return tickArrays;

  const tickArraysAddress = TickArrayBitmapUtil.findTickArrayAddress({
    programId,
    poolId,
    poolBitmap: tickArrayBitmap,
    tickArrayBitmap: TickArrayBitmapExtensionLayout.decode(tickArrayBitmapExtensionRes.data),
    tickSpacing,
    findInfo: { type: zeroForOne ? 'zeroForOne' : 'oneForZero', tickArrayCurrent: currentTick },
  });

  const tickArrayRes = await getMultipleAccountsInfo(connection, tickArraysAddress);
  tickArrayRes.forEach((res, idx) => {
    if (res) tickArrays.push({ address: tickArraysAddress[idx], value: TickArrayLayout.decode(res.data) });
  });

  return tickArrays;
}

module.exports = {
  TickArrayBitmapUtil,
  TickArrayUtil,
  TickUtil,
  fetchTickArrays,
  constants: {
    BIT_PRECISION,
    BN_ONE,
    BN_ZERO,
    EXTENSION_TICKARRAY_BITMAP_SIZE,
    LOG_B_2_X32,
    LOG_B_P_ERR_MARGIN_LOWER_X64,
    LOG_B_P_ERR_MARGIN_UPPER_X64,
    MAX_SQRT_PRICE_X64,
    MAX_TICK,
    MIN_SQRT_PRICE_X64,
    MIN_TICK,
    Q64,
    TICK_ARRAY_BITMAP_SIZE,
    TICK_ARRAY_SIZE,
    TICK_TO_SQRT_PRICE_FACTORS,
  },
  layouts: {
    get PoolInfoLayout() {
      return require('@raydium-io/raydium-sdk-v2').PoolInfoLayout;
    },
    get TickArrayBitmapExtensionLayout() {
      return require('@raydium-io/raydium-sdk-v2').TickArrayBitmapExtensionLayout;
    },
    get TickArrayLayout() {
      return require('@raydium-io/raydium-sdk-v2').TickArrayLayout;
    },
    get TickLayout() {
      return require('@raydium-io/raydium-sdk-v2').TickLayout;
    },
  },
  pda: {
    getPdaExBitmapAccount,
    getPdaTickArrayAddress,
  },
};
