'use strict';
/**
 * Q_CLMM.js — Raydium Concentrated Liquidity Market Maker (CLMM) Quoter
 *
 * Provides:
 *   - Full CLMM swap-step math (SqrtPriceMath, TickUtils, LiquidityMath, MathUtil)
 *   - CLMMAdapter class for quoteExactIn / quoteFastExactIn
 *   - Standalone computeSwapStep and swapStepQuoteCLMM functions
 *
 * FIXES from original:
 *   - Removed broken constructor code (this.AmountSpec = state.amountSpecifiedRemainin)
 *   - Consolidated all exports into single module.exports object
 *   - Removed duplicate normalizePools / normalizePoolRecord functions
 *   - Lazy-loads poolContract / finalizeQuote — works standalone if missing
 *   - Removed @orca-so/common-sdk hard dependency
 *   - All math classes preserved exactly as authored
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, } = require('@solana/web3.js');
const bs58 = require('bs58');
const BN = require('bn.js');
const Decimal = require('decimal.js');
const { buildClmmSwapTx } = require('./transact/tx_clmm');
const { fetchTickArrays, PoolInfoLayout, TickArrayLayout } = require('@raydium-io/raydium-sdk-v2');

// Lazy-load project dependencies (may not exist in sandbox)
function lazyRequire(id, fallback) {
    try { return require(id); } catch (_e) { return fallback || null; }
}

const poolContract = lazyRequire('./poolContract');
const normalizer = lazyRequire('./normalizer');

// Constants
const ZERO = new BN(0);
const ONE = new BN(1);
const NEGATIVE_ONE = new BN(-1);
const Q64 = new BN(1).shln(64);
const Q128 = new BN(1).shln(128);
const MaxU64 = Q64.sub(ONE);
const MaxUint128 = Q128.sub(ONE);
const U64Resolution = 64;

const MIN_TICK = -307200;
const MAX_TICK = 307200;
const MIN_SQRT_PRICE_X64 = new BN('3939943522091');
const MAX_SQRT_PRICE_X64 = new BN('86367321006760116002434269');
const MIN_TICK_ARRAY_START_INDEX = -307200;
const MAX_TICK_ARRAY_START_INDEX = 306600;
const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_BITMAP_SIZE = 1024;

const FEE_RATE_DENOMINATOR = new BN(10).pow(new BN(6));
const BIT_PRECISION = 14;
const LOG_B_2_X32 = '59543866431248';
const LOG_B_P_ERR_MARGIN_LOWER_X64 = '184467440737095516';
const LOG_B_P_ERR_MARGIN_UPPER_X64 = '15793534762490258745';

/* -------------------------------------------------------------------------- */
/*                             Utility functions                              */
/* -------------------------------------------------------------------------- */

function ensure(cond, msg) { if (!cond) throw new Error(msg); }

function toBN(value, fallback = '0') {
    if (BN.isBN(value)) return value;
    if (value === undefined || value === null || value === '') return new BN(fallback);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return new BN(fallback);
        return new BN(String(Math.trunc(value)));
    }
    const text = String(value).trim();
    if (!text) return new BN(fallback);
    if (text.includes('.')) return new BN(text.split('.')[0] || fallback);
    if (/^-?(0x)?[0-9a-fA-F]+$/.test(text) && /[a-fA-F]/.test(text)) {
        const negative = text.startsWith('-');
        const hex = text.replace(/^-?0x/i, '');
        const parsed = new BN(hex || fallback, 16);
        return negative ? parsed.neg() : parsed;
    }
    return new BN(text);
}

function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (value === undefined || value === null || value === '') return 0n;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return 0n;
        if (trimmed.includes('e') || trimmed.includes('E')) return BigInt(Math.floor(Number(trimmed)));
        if (trimmed.includes('.')) return BigInt(trimmed.split('.')[0] || '0');
        return BigInt(trimmed);
    }
    return BigInt(String(value));
}

function signedLeftShift(n0, shiftBy, bitWidth) {
    const twosN0 = n0.toTwos(bitWidth).shln(shiftBy);
    twosN0.imaskn(bitWidth + 1);
    return twosN0.fromTwos(bitWidth);
}

function signedRightShift(n0, shiftBy, bitWidth) {
    const twoN0 = n0.toTwos(bitWidth).shrn(shiftBy);
    twoN0.imaskn(bitWidth - shiftBy + 1);
    return twoN0.fromTwos(bitWidth - shiftBy);
}

function mulRightShift(val, mulBy) {
    return signedRightShift(val.mul(mulBy), 64, 256);
}

/* -------------------------------------------------------------------------- */
/*                             Pool normalization                             */
/* -------------------------------------------------------------------------- */

function normalizePools(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.data)) return raw.data;
    return Object.values(raw || {});
}

function normalizePoolRecord(pool = {}) {
    // Try poolContract first, fallback to inline
    if (poolContract && typeof poolContract.mergeCanonicalPool === 'function') {
        return poolContract.mergeCanonicalPool({
            ...pool,
            type: pool.type || 'clmm',
            dexType: pool.dexType || 'RAYDIUM_CLMM',
        });
    }
    // Inline fallback matching canonical shape
    return {
        ...pool,
        poolAddress: pool?.poolAddress || pool?.address || pool?.id || '',
        type: pool?.type || 'clmm',
        dexType: pool?.dexType || 'RAYDIUM_CLMM',
        dex: pool?.dex || 'raydium',
        tokenXMint: pool?.tokenXMint || pool?.baseMint || pool?.mintA || pool?.tokenA || '',
        tokenYMint: pool?.tokenYMint || pool?.quoteMint || pool?.mintB || pool?.tokenB || '',
        tokenXDecimals: pool?.tokenXDecimals || pool?.baseDecimals || 9,
        tokenYDecimals: pool?.tokenYDecimals || pool?.quoteDecimals || 6,
        reserves: pool?.reserves || { x: '0', y: '0' },
        vaults: pool?.vaults || { xVault: pool?.xVault, yVault: pool?.yVault },
        feeBps: pool?.feeBps ?? 25,
        tickSpacing: pool?.tickSpacing ?? 2,
        tickCurrent: pool?.tickCurrent ?? 0,
        tickArrays: Array.isArray(pool?.tickArrays) ? pool.tickArrays : [],
        liquidity: pool?.liquidity || '0',
        sqrtPrice: pool?.sqrtPrice || pool?.sqrtPriceX64 || '0',
        sqrtPriceX64: pool?.sqrtPriceX64 || pool?.sqrtPrice || '0',
        normalized: true,
    };
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => {
            if (entry == null) return null;
            if (typeof entry === 'string') return entry;
            if (typeof entry.toBase58 === 'function') return entry.toBase58();
            if (typeof entry.publicKey?.toBase58 === 'function') return entry.publicKey.toBase58();
            if (typeof entry.pubkey?.toBase58 === 'function') return entry.pubkey.toBase58();
            return String(entry);
        })
        .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*                        normalizeClmmPoolMathState                          */
/* -------------------------------------------------------------------------- */

function normalizeClmmPoolMathState(poolShape) {
    const structuredTickArrays = Array.isArray(poolShape.tickArrayData) && poolShape.tickArrayData.length
        ? poolShape.tickArrayData
        : (Array.isArray(poolShape.aux?.clmm?.tickArrayData) && poolShape.aux.clmm.tickArrayData.length
            ? poolShape.aux.clmm.tickArrayData
            : (Array.isArray(poolShape.tickArrays) ? poolShape.tickArrays : []));
    const tickArrayCache = {};
    for (const ta of structuredTickArrays) {
        if (ta && typeof ta === 'object') {
            const data = ta.data && typeof ta.data === 'object' ? ta.data : ta;
            const startIndex = Number(data.startTickIndex ?? data.start_index ?? ta.startTickIndex ?? ta.start_index ?? 0);
            const rawTicks = Array.isArray(data.ticks) ? data.ticks : (Array.isArray(ta.ticks) ? ta.ticks : []);
            tickArrayCache[startIndex] = {
                startTickIndex: startIndex,
                ticks: rawTicks.map((t, index) => ({
                    tick: Number(t?.tick ?? t?.tickIndex ?? t?.index ?? (startIndex + (index * Number(poolShape.tickSpacing || 1)))),
                    initialized: Boolean(t?.initialized),
                    liquidityNet: toBN(t?.liquidityNet || '0'),
                    liquidityGross: toBN(t?.liquidityGross || '0'),
                })),
            };
        }
    }

    return {
        sqrtPriceX64: toBN(poolShape.sqrtPrice || poolShape.sqrtPriceX64 || '0'),
        liquidity: toBN(poolShape.liquidity || '0'),
        tickSpacing: Number(poolShape.tickSpacing || 2),
        tickCurrent: Number(poolShape.tickCurrent || 0),
        feeRate: Math.round((Number(poolShape.feeBps || 25) * 100)), // bps -> hundredths of bps
        tickArrayCache,
    };
}

function isMathReadyClmm(poolShape) {
    const state = normalizeClmmPoolMathState(poolShape);
    return state.sqrtPriceX64.gt(ZERO)
        && state.liquidity.gt(ZERO)
        && state.tickSpacing > 0
        && Object.keys(state.tickArrayCache).length > 0;
}

async function hydrateLiveClmmPoolShape(poolShape, connection) {
    if (!connection) {
        throw new Error('CLMM live quote requires connection');
    }

    const poolAddress = poolShape.poolAddress || poolShape.address || poolShape.id;
    if (!poolAddress) {
        throw new Error('CLMM live quote requires poolAddress');
    }

    const poolKey = new PublicKey(String(poolAddress));
    const account = await connection.getAccountInfo(poolKey);
    if (!account) {
        throw new Error(`CLMM pool account not found: ${poolKey.toBase58()}`);
    }

    const state = PoolInfoLayout.decode(account.data);

    const liveTickArrays = normalizeStringArray(
        poolShape.tickArrays?.length ? poolShape.tickArrays : poolShape.remainingAccounts
    );
    let tickArrayData = [];
    try {
        const fetched = await fetchTickArrays(
            account.owner,
            connection,
            poolKey,
            Number(state.tickCurrent || poolShape.tickCurrent || 0),
            Number(state.tickSpacing || poolShape.tickSpacing || 0),
            Buffer.from(state.tickArrayBitmap || []),
            Boolean(swapForY),
        );
        tickArrayData = fetched.map((entry) => ({
            address: entry.address.toBase58(),
            data: entry.value,
        }));
    } catch (bitmapError) {
        if (!liveTickArrays.length) {
            throw bitmapError;
        }

        const tickArrayKeys = liveTickArrays.map((addr) => new PublicKey(String(addr)));
        const tickArrayInfos = await connection.getMultipleAccountsInfo(tickArrayKeys, 'confirmed');
        tickArrayData = tickArrayInfos.map((info, index) => {
            if (!info) {
                throw new Error(`CLMM tick array not found: ${tickArrayKeys[index].toBase58()}`);
            }
            return {
                address: tickArrayKeys[index].toBase58(),
                data: TickArrayLayout.decode(Buffer.from(info.data)),
            };
        });
    }
    const hydrated = normalizePoolRecord({
        ...poolShape,
        poolAddress: poolKey.toBase58(),
        address: poolKey.toBase58(),
        programId: account.owner.toBase58(),
        dexType: poolShape.dexType || 'RAYDIUM_CLMM',
        dex: poolShape.dex || 'raydium',
        type: poolShape.type || 'clmm',
        tokenXMint: state.mintA?.toBase58 ? state.mintA.toBase58() : poolShape.tokenXMint,
        tokenYMint: state.mintB?.toBase58 ? state.mintB.toBase58() : poolShape.tokenYMint,
        baseMint: state.mintA?.toBase58 ? state.mintA.toBase58() : poolShape.baseMint,
        quoteMint: state.mintB?.toBase58 ? state.mintB.toBase58() : poolShape.quoteMint,
        tokenXDecimals: Number(poolShape.tokenXDecimals ?? poolShape.baseDecimals ?? 0),
        tokenYDecimals: Number(poolShape.tokenYDecimals ?? poolShape.quoteDecimals ?? 0),
        tickSpacing: Number(state.tickSpacing || poolShape.tickSpacing || 0),
        tickCurrent: Number(state.tickCurrent || poolShape.tickCurrent || 0),
        liquidity: state.liquidity?.toString ? state.liquidity.toString() : String(poolShape.liquidity || '0'),
        sqrtPrice: state.sqrtPriceX64?.toString ? state.sqrtPriceX64.toString() : String(poolShape.sqrtPrice || '0'),
        sqrtPriceX64: state.sqrtPriceX64?.toString ? state.sqrtPriceX64.toString() : String(poolShape.sqrtPriceX64 || '0'),
        vaults: {
            xVault: state.vaultA?.toBase58 ? state.vaultA.toBase58() : poolShape.vaults?.xVault,
            yVault: state.vaultB?.toBase58 ? state.vaultB.toBase58() : poolShape.vaults?.yVault,
        },
        tickArrays: liveTickArrays,
        remainingAccounts: liveTickArrays,
    });
    hydrated.tickArrayData = tickArrayData;
    hydrated.tickArrays = liveTickArrays;
    hydrated.remainingAccounts = liveTickArrays;
    return hydrated;
}

async function liveQuoteClmm(poolShape, inAmountAtomic, swapForY, slippageBps = 20, connection = null) {
    const livePool = await hydrateLiveClmmPoolShape(poolShape, connection);
    return finalizeQuote(
        swapStepQuoteCLMM(livePool, String(inAmountAtomic), Boolean(swapForY), slippageBps),
        livePool,
    );
}

/* -------------------------------------------------------------------------- */
/*                             MathUtil class                                 */
/* -------------------------------------------------------------------------- */

class MathUtil {
    static mulDivRoundingUp(a, b, denominator) {
        const numerator = a.mul(b);
        let result = numerator.div(denominator);
        if (!numerator.mod(denominator).eq(ZERO)) {
            result = result.add(ONE);
        }
        return result;
    }

    static mulDivFloor(a, b, denominator) {
        if (denominator.eq(ZERO)) throw new Error('division by 0');
        return a.mul(b).div(denominator);
    }

    static mulDivCeil(a, b, denominator) {
        if (denominator.eq(ZERO)) throw new Error('division by 0');
        const numerator = a.mul(b).add(denominator.sub(ONE));
        return numerator.div(denominator);
    }

    static x64ToDecimal(num, decimalPlaces = 18) {
        return new Decimal(num.toString())
            .div(Decimal.pow(2, 64))
            .toDecimalPlaces(decimalPlaces);
    }

    static decimalToX64(num) {
        return new BN(num.mul(Decimal.pow(2, 64)).floor().toFixed());
    }

    static wrappingSubU128(n0, n1) {
        return n0.add(Q128).sub(n1).mod(Q128);
    }

    static bpsToFeeRate(bps) {
        return new BN(bps * 100);
    }

    static calculateFee(amount, feeBps) {
        const feeRate = this.bpsToFeeRate(feeBps);
        return amount.mul(feeRate).div(FEE_RATE_DENOMINATOR);
    }

    static amountAfterFee(amount, feeBps) {
        const fee = this.calculateFee(amount, feeBps);
        return amount.sub(fee);
    }
}

/* -------------------------------------------------------------------------- */
/*                           SqrtPriceMath class                              */
/* -------------------------------------------------------------------------- */

class SqrtPriceMath {
    static sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB) {
        return MathUtil.x64ToDecimal(sqrtPriceX64)
            .pow(2)
            .mul(Decimal.pow(10, decimalsA - decimalsB));
    }

    static priceToSqrtPriceX64(price, decimalsA, decimalsB) {
        return MathUtil.decimalToX64(
            price.mul(Decimal.pow(10, decimalsB - decimalsA)).sqrt()
        );
    }

    static getNextSqrtPriceX64FromInput(sqrtPriceX64, liquidity, amountIn, zeroForOne) {
        if (!sqrtPriceX64.gt(ZERO)) throw new Error('sqrtPriceX64 must greater than 0');
        if (!liquidity.gt(ZERO)) throw new Error('liquidity must greater than 0');
        return zeroForOne
            ? this.getNextSqrtPriceFromTokenAmountARoundingUp(sqrtPriceX64, liquidity, amountIn, true)
            : this.getNextSqrtPriceFromTokenAmountBRoundingDown(sqrtPriceX64, liquidity, amountIn, true);
    }

    static getNextSqrtPriceX64FromOutput(sqrtPriceX64, liquidity, amountOut, zeroForOne) {
        if (!sqrtPriceX64.gt(ZERO)) throw new Error('sqrtPriceX64 must greater than 0');
        if (!liquidity.gt(ZERO)) throw new Error('liquidity must greater than 0');
        return zeroForOne
            ? this.getNextSqrtPriceFromTokenAmountBRoundingDown(sqrtPriceX64, liquidity, amountOut, false)
            : this.getNextSqrtPriceFromTokenAmountARoundingUp(sqrtPriceX64, liquidity, amountOut, false);
    }

    static getNextSqrtPriceFromTokenAmountARoundingUp(sqrtPriceX64, liquidity, amount, add) {
        if (amount.eq(ZERO)) return sqrtPriceX64;
        const liquidityLeftShift = liquidity.shln(U64Resolution);
        if (add) {
            const numerator1 = liquidityLeftShift;
            const denominator = liquidityLeftShift.add(amount.mul(sqrtPriceX64));
            if (denominator.gte(numerator1)) {
                return MathUtil.mulDivCeil(numerator1, sqrtPriceX64, denominator);
            }
            return MathUtil.mulDivRoundingUp(
                numerator1,
                ONE,
                numerator1.div(sqrtPriceX64).add(amount)
            );
        } else {
            const amountMulSqrtPrice = amount.mul(sqrtPriceX64);
            if (!liquidityLeftShift.gt(amountMulSqrtPrice)) {
                throw new Error('liquidityLeftShift must gt amountMulSqrtPrice');
            }
            const denominator = liquidityLeftShift.sub(amountMulSqrtPrice);
            return MathUtil.mulDivCeil(liquidityLeftShift, sqrtPriceX64, denominator);
        }
    }

    static getNextSqrtPriceFromTokenAmountBRoundingDown(sqrtPriceX64, liquidity, amount, add) {
        const deltaY = amount.shln(U64Resolution);
        if (add) {
            return sqrtPriceX64.add(deltaY.div(liquidity));
        } else {
            const amountDivLiquidity = MathUtil.mulDivRoundingUp(deltaY, ONE, liquidity);
            if (!sqrtPriceX64.gt(amountDivLiquidity)) {
                throw new Error('sqrtPriceX64 must gt amountDivLiquidity');
            }
            return sqrtPriceX64.sub(amountDivLiquidity);
        }
    }

    static getSqrtPriceX64FromTick(tick) {
        if (!Number.isInteger(tick)) throw new Error('tick must be integer');
        if (tick < MIN_TICK || tick > MAX_TICK) throw new Error('tick out of range');
        const tickAbs = tick < 0 ? tick * -1 : tick;
        let ratio = (tickAbs & 0x1) != 0
            ? new BN('18445821805675395072')
            : new BN('18446744073709551616');
        if ((tickAbs & 0x2) != 0) ratio = mulRightShift(ratio, new BN('18444899583751176192'));
        if ((tickAbs & 0x4) != 0) ratio = mulRightShift(ratio, new BN('18443055278223355904'));
        if ((tickAbs & 0x8) != 0) ratio = mulRightShift(ratio, new BN('18439367220385607680'));
        if ((tickAbs & 0x10) != 0) ratio = mulRightShift(ratio, new BN('18431993317065453568'));
        if ((tickAbs & 0x20) != 0) ratio = mulRightShift(ratio, new BN('18417254355718170624'));
        if ((tickAbs & 0x40) != 0) ratio = mulRightShift(ratio, new BN('18387811781193609216'));
        if ((tickAbs & 0x80) != 0) ratio = mulRightShift(ratio, new BN('18329067761203558400'));
        if ((tickAbs & 0x100) != 0) ratio = mulRightShift(ratio, new BN('18212142134806163456'));
        if ((tickAbs & 0x200) != 0) ratio = mulRightShift(ratio, new BN('17980523815641700352'));
        if ((tickAbs & 0x400) != 0) ratio = mulRightShift(ratio, new BN('17526086738831433728'));
        if ((tickAbs & 0x800) != 0) ratio = mulRightShift(ratio, new BN('16651378430235570176'));
        if ((tickAbs & 0x1000) != 0) ratio = mulRightShift(ratio, new BN('15030750278694412288'));
        if ((tickAbs & 0x2000) != 0) ratio = mulRightShift(ratio, new BN('12247334978884435968'));
        if ((tickAbs & 0x4000) != 0) ratio = mulRightShift(ratio, new BN('8131365268886854656'));
        if ((tickAbs & 0x8000) != 0) ratio = mulRightShift(ratio, new BN('3584323654725218816'));
        if ((tickAbs & 0x10000) != 0) ratio = mulRightShift(ratio, new BN('696457651848324352'));
        if ((tickAbs & 0x20000) != 0) ratio = mulRightShift(ratio, new BN('26294789957507116'));
        if ((tickAbs & 0x40000) != 0) ratio = mulRightShift(ratio, new BN('37481735321082'));
        if (tick > 0) ratio = MaxUint128.div(ratio);
        return ratio;
    }

    static getTickFromSqrtPriceX64(sqrtPriceX64) {
        if (sqrtPriceX64.gt(MAX_SQRT_PRICE_X64) || sqrtPriceX64.lt(MIN_SQRT_PRICE_X64)) {
            throw new Error('sqrtPrice out of range');
        }
        const msb = sqrtPriceX64.bitLength() - 1;
        const adjustedMsb = new BN(msb - 64);
        const log2pIntegerX32 = signedLeftShift(adjustedMsb, 32, 128);
        let bit = new BN('8000000000000000', 'hex');
        let precision = 0;
        let log2pFractionX64 = new BN(0);
        let r = msb >= 64 ? sqrtPriceX64.shrn(msb - 63) : sqrtPriceX64.shln(63 - msb);
        while (bit.gt(new BN(0)) && precision < BIT_PRECISION) {
            r = r.mul(r);
            const rMoreThanTwo = r.shrn(127);
            r = r.shrn(63 + rMoreThanTwo.toNumber());
            log2pFractionX64 = log2pFractionX64.add(bit.mul(rMoreThanTwo));
            bit = bit.shrn(1);
            precision += 1;
        }
        const log2pFractionX32 = log2pFractionX64.shrn(32);
        const log2pX32 = log2pIntegerX32.add(log2pFractionX32);
        const logbpX64 = log2pX32.mul(new BN(LOG_B_2_X32));
        const tickLow = signedRightShift(
            logbpX64.sub(new BN(LOG_B_P_ERR_MARGIN_LOWER_X64)),
            64,
            128
        ).toNumber();
        const tickHigh = signedRightShift(
            logbpX64.add(new BN(LOG_B_P_ERR_MARGIN_UPPER_X64)),
            64,
            128
        ).toNumber();
        if (tickLow == tickHigh) return tickLow;
        const derivedTickHighSqrtPriceX64 = this.getSqrtPriceX64FromTick(tickHigh);
        return derivedTickHighSqrtPriceX64.lte(sqrtPriceX64) ? tickHigh : tickLow;
    }
}

/* -------------------------------------------------------------------------- */
/*                             TickUtils class                                */
/* -------------------------------------------------------------------------- */

class TickUtils {

    static getTickArrayStartIndexByTick(tickIndex, tickSpacing) {
        let startIndex = tickIndex / (TICK_ARRAY_SIZE * tickSpacing);
        if (tickIndex < 0 && tickIndex % (TICK_ARRAY_SIZE * tickSpacing) != 0) {
            startIndex = Math.ceil(startIndex) - 1;
        } else {
            startIndex = Math.floor(startIndex);
        }
        return startIndex * (tickSpacing * TICK_ARRAY_SIZE);
    }

    static getTickArrayOffsetInBitmapByTick(tick, tickSpacing) {
        const multiplier = tickSpacing * TICK_ARRAY_SIZE;
        const compressed = Math.floor(tick / multiplier) + 512;
        return Math.abs(compressed);
    }

    static checkTickArrayIsInitialized(bitmap, tick, tickSpacing) {
        const multiplier = tickSpacing * TICK_ARRAY_SIZE;
        const compressed = Math.floor(tick / multiplier) + 512;
        const bit_pos = Math.abs(compressed);
        return {
            isInitialized: bitmap.testn(bit_pos),
            startIndex: (bit_pos - 512) * multiplier,
        };
    }

    static getNextTickArrayStartIndex(lastTickArrayStartIndex, tickSpacing, zeroForOne) {
        return zeroForOne
            ? lastTickArrayStartIndex - tickSpacing * TICK_ARRAY_SIZE
            : lastTickArrayStartIndex + tickSpacing * TICK_ARRAY_SIZE;
    }

    static mergeTickArrayBitmap(bns) {
        return bns[0]
            .add(bns[1].shln(64))
            .add(bns[2].shln(128))
            .add(bns[3].shln(192))
            .add(bns[4].shln(256))
            .add(bns[5].shln(320))
            .add(bns[6].shln(384))
            .add(bns[7].shln(448))
            .add(bns[8].shln(512))
            .add(bns[9].shln(576))
            .add(bns[10].shln(640))
            .add(bns[11].shln(704))
            .add(bns[12].shln(768))
            .add(bns[13].shln(832))
            .add(bns[14].shln(896))
            .add(bns[15].shln(960));
    }

    static getInitializedTickArrayInRange(tickArrayBitmap, tickSpacing, tickArrayStartIndex, expectedCount) {
        if (tickArrayStartIndex % (tickSpacing * TICK_ARRAY_SIZE) != 0) {
            throw new Error('Invalid tickArrayStartIndex');
        }
        const tickArrayOffset = Math.floor(tickArrayStartIndex / (tickSpacing * TICK_ARRAY_SIZE)) + 512;
        return [
            ...this.searchLowBitFromStart(tickArrayBitmap, tickArrayOffset - 1, 0, expectedCount, tickSpacing),
            ...this.searchHightBitFromStart(tickArrayBitmap, tickArrayOffset, TICK_ARRAY_BITMAP_SIZE, expectedCount, tickSpacing),
        ];
    }

    static searchLowBitFromStart(tickArrayBitmap, start, end, expectedCount, tickSpacing) {
        let fetchNum = 0;
        const result = [];
        for (let i = start; i >= end; i--) {
            if (tickArrayBitmap.shrn(i).and(new BN(1)).eqn(1)) {
                const nextStartIndex = (i - 512) * (tickSpacing * TICK_ARRAY_SIZE);
                result.push(nextStartIndex);
                fetchNum++;
            }
            if (fetchNum >= expectedCount) break;
        }
        return result;
    }

    static searchHightBitFromStart(tickArrayBitmap, start, end, expectedCount, tickSpacing) {
        let fetchNum = 0;
        const result = [];
        for (let i = start; i < end; i++) {
            if (tickArrayBitmap.shrn(i).and(new BN(1)).eqn(1)) {
                const nextStartIndex = (i - 512) * (tickSpacing * TICK_ARRAY_SIZE);
                result.push(nextStartIndex);
                fetchNum++;
            }
            if (fetchNum >= expectedCount) break;
        }
        return result;
    }

    static tickToPrice(tick, decimalsA, decimalsB) {
        const sqrtPriceX64 = SqrtPriceMath.getSqrtPriceX64FromTick(tick);
        return SqrtPriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB);
    }

    static priceToTick(price, decimalsA, decimalsB) {
        const sqrtPriceX64 = SqrtPriceMath.priceToSqrtPriceX64(price, decimalsA, decimalsB);
        return SqrtPriceMath.getTickFromSqrtPriceX64(sqrtPriceX64);
    }
}

/* -------------------------------------------------------------------------- */
/*                           LiquidityMath class                              */
/* -------------------------------------------------------------------------- */

class LiquidityMath {
    static addDelta(x, y) {
        return x.add(y);
    }

    static getTokenAmountAFromLiquidity(sqrtPriceX64A, sqrtPriceX64B, liquidity, roundUp) {
        if (sqrtPriceX64A.gt(sqrtPriceX64B)) {
            [sqrtPriceX64A, sqrtPriceX64B] = [sqrtPriceX64B, sqrtPriceX64A];
        }
        if (!sqrtPriceX64A.gt(ZERO)) throw new Error('sqrtPriceX64A must greater than 0');
        const numerator1 = liquidity.ushln(U64Resolution);
        const numerator2 = sqrtPriceX64B.sub(sqrtPriceX64A);
        return roundUp
            ? MathUtil.mulDivRoundingUp(
                MathUtil.mulDivCeil(numerator1, numerator2, sqrtPriceX64B),
                ONE,
                sqrtPriceX64A
            )
            : MathUtil.mulDivFloor(numerator1, numerator2, sqrtPriceX64B).div(sqrtPriceX64A);
    }

    static getTokenAmountBFromLiquidity(sqrtPriceX64A, sqrtPriceX64B, liquidity, roundUp) {
        if (sqrtPriceX64A.gt(sqrtPriceX64B)) {
            [sqrtPriceX64A, sqrtPriceX64B] = [sqrtPriceX64B, sqrtPriceX64A];
        }
        if (!sqrtPriceX64A.gt(ZERO)) throw new Error('sqrtPriceX64A must greater than 0');
        return roundUp
            ? MathUtil.mulDivCeil(liquidity, sqrtPriceX64B.sub(sqrtPriceX64A), Q64)
            : MathUtil.mulDivFloor(liquidity, sqrtPriceX64B.sub(sqrtPriceX64A), Q64);
    }

    static getLiquidityFromTokenA(amountA, sqrtPriceX64A, sqrtPriceX64B, roundUp) {
        if (sqrtPriceX64A.gt(sqrtPriceX64B)) {
            [sqrtPriceX64A, sqrtPriceX64B] = [sqrtPriceX64B, sqrtPriceX64A];
        }
        const numerator = amountA.mul(sqrtPriceX64A).mul(sqrtPriceX64B);
        const denominator = sqrtPriceX64B.sub(sqrtPriceX64A).shln(U64Resolution);
        return roundUp
            ? MathUtil.mulDivCeil(numerator, ONE, denominator)
            : numerator.div(denominator);
    }

    static getLiquidityFromTokenB(amountB, sqrtPriceX64A, sqrtPriceX64B, roundUp) {
        if (sqrtPriceX64A.gt(sqrtPriceX64B)) {
            [sqrtPriceX64A, sqrtPriceX64B] = [sqrtPriceX64B, sqrtPriceX64A];
        }
        const result = amountB.mul(Q64).div(sqrtPriceX64B.sub(sqrtPriceX64A));
        return roundUp ? result.add(ONE) : result;
    }
}

/* -------------------------------------------------------------------------- */
/*                         findNextInitializedTick                            */
/* -------------------------------------------------------------------------- */

function findNextInitializedTick(tickArrayCache, currentTick, tickSpacing, zeroForOne) {
    const tickArrayStartIndex = TickUtils.getTickArrayStartIndexByTick(currentTick, tickSpacing);
    let tickArray = tickArrayCache[tickArrayStartIndex];

    if (!tickArray) {
        const adjacentStartIndex = zeroForOne
            ? tickArrayStartIndex - (tickSpacing * TICK_ARRAY_SIZE)
            : tickArrayStartIndex + (tickSpacing * TICK_ARRAY_SIZE);
        tickArray = tickArrayCache[adjacentStartIndex];
        if (!tickArray) return null;
    }

    const scanOrder = [];
    if (zeroForOne) {
        for (let start = tickArray.startTickIndex; start >= MIN_TICK; start -= tickSpacing * TICK_ARRAY_SIZE) {
            if (tickArrayCache[start]) scanOrder.push(tickArrayCache[start]);
        }
    } else {
        for (let start = tickArray.startTickIndex; start <= MAX_TICK; start += tickSpacing * TICK_ARRAY_SIZE) {
            if (tickArrayCache[start]) scanOrder.push(tickArrayCache[start]);
        }
    }

    for (const candidateArray of scanOrder) {
        const ticks = Array.isArray(candidateArray.ticks) ? candidateArray.ticks : [];
        if (!ticks.length) continue;

        if (zeroForOne) {
            for (let i = ticks.length - 1; i >= 0; i -= 1) {
                const tick = ticks[i];
                if (!tick?.initialized || !tick.liquidityGross?.gt?.(ZERO)) continue;
                if (tick.tick <= currentTick) {
                    return { tickArray: candidateArray, tick };
                }
            }
        } else {
            for (let i = 0; i < ticks.length; i += 1) {
                const tick = ticks[i];
                if (!tick?.initialized || !tick.liquidityGross?.gt?.(ZERO)) continue;
                if (tick.tick > currentTick) {
                    return { tickArray: candidateArray, tick };
                }
            }
        }
    }

    return null;
}

/* -------------------------------------------------------------------------- */
/*                         computeSwapStep function                            */
/* -------------------------------------------------------------------------- */

function computeSwapStep({ sqrtPriceX64Current, sqrtPriceX64Target, liquidity, amountRemaining, feeRate, zeroForOne }) {
    const swapStep = {
        sqrtPriceX64Next: new BN(0),
        amountIn: new BN(0),
        amountOut: new BN(0),
        feeAmount: new BN(0),
    };

    const baseInput = amountRemaining.gte(ZERO);

    if (baseInput) {
        const amountRemainingSubtractFee = MathUtil.mulDivFloor(
            amountRemaining,
            FEE_RATE_DENOMINATOR.sub(new BN(feeRate.toString())),
            FEE_RATE_DENOMINATOR
        );

        swapStep.amountIn = zeroForOne
            ? LiquidityMath.getTokenAmountAFromLiquidity(sqrtPriceX64Target, sqrtPriceX64Current, liquidity, true)
            : LiquidityMath.getTokenAmountBFromLiquidity(sqrtPriceX64Current, sqrtPriceX64Target, liquidity, true);

        if (amountRemainingSubtractFee.gte(swapStep.amountIn)) {
            swapStep.sqrtPriceX64Next = sqrtPriceX64Target;
        } else {
            swapStep.sqrtPriceX64Next = SqrtPriceMath.getNextSqrtPriceX64FromInput(
                sqrtPriceX64Current,
                liquidity,
                amountRemainingSubtractFee,
                zeroForOne
            );
        }
    } else {
        swapStep.amountOut = zeroForOne
            ? LiquidityMath.getTokenAmountBFromLiquidity(sqrtPriceX64Target, sqrtPriceX64Current, liquidity, false)
            : LiquidityMath.getTokenAmountAFromLiquidity(sqrtPriceX64Current, sqrtPriceX64Target, liquidity, false);

        if (amountRemaining.mul(NEGATIVE_ONE).gte(swapStep.amountOut)) {
            swapStep.sqrtPriceX64Next = sqrtPriceX64Target;
        } else {
            swapStep.sqrtPriceX64Next = SqrtPriceMath.getNextSqrtPriceX64FromOutput(
                sqrtPriceX64Current,
                liquidity,
                amountRemaining.mul(NEGATIVE_ONE),
                zeroForOne
            );
        }
    }

    const reachTargetPrice = sqrtPriceX64Target.eq(swapStep.sqrtPriceX64Next);

    if (zeroForOne) {
        if (!(reachTargetPrice && baseInput)) {
            swapStep.amountIn = LiquidityMath.getTokenAmountAFromLiquidity(
                swapStep.sqrtPriceX64Next,
                sqrtPriceX64Current,
                liquidity,
                true
            );
        }
        if (!(reachTargetPrice && !baseInput)) {
            swapStep.amountOut = LiquidityMath.getTokenAmountBFromLiquidity(
                swapStep.sqrtPriceX64Next,
                sqrtPriceX64Current,
                liquidity,
                false
            );
        }
    } else {
        swapStep.amountIn = reachTargetPrice && baseInput
            ? swapStep.amountIn
            : LiquidityMath.getTokenAmountBFromLiquidity(
                sqrtPriceX64Current,
                swapStep.sqrtPriceX64Next,
                liquidity,
                true
            );
        swapStep.amountOut = reachTargetPrice && !baseInput
            ? swapStep.amountOut
            : LiquidityMath.getTokenAmountAFromLiquidity(
                sqrtPriceX64Current,
                swapStep.sqrtPriceX64Next,
                liquidity,
                false
            );
    }

    if (!baseInput && swapStep.amountOut.gt(amountRemaining.mul(NEGATIVE_ONE))) {
        swapStep.amountOut = amountRemaining.mul(NEGATIVE_ONE);
    }

    if (baseInput && !swapStep.sqrtPriceX64Next.eq(sqrtPriceX64Target)) {
        swapStep.feeAmount = amountRemaining.sub(swapStep.amountIn);
    } else {
        swapStep.feeAmount = MathUtil.mulDivCeil(
            swapStep.amountIn,
            new BN(feeRate),
            FEE_RATE_DENOMINATOR.sub(new BN(feeRate))
        );
    }

    return {
        sqrtPriceX64Next: swapStep.sqrtPriceX64Next,
        amountIn: swapStep.amountIn,
        amountOut: swapStep.amountOut,
        feeAmount: swapStep.feeAmount,
    };
}

/* -------------------------------------------------------------------------- */
/*                         reserveQuoteClmm fallback                          */
/* -------------------------------------------------------------------------- */

function reserveQuoteClmm(poolShape, inAmountAtomic, swapForY, slippageBps = 20) {
    // CLMM reserves are the *current active tick range only*, not the full
    // pool depth. Applying constant-product x*y=k math to them produces
    // wildly inaccurate prices — often off by 1-3 orders of magnitude when
    // the active range is thin. This used to silently generate phantom
    // arbitrage opportunities (920+ bps fake profits in production runs).
    //
    // The correct behavior is to REFUSE to quote when CLMM math state
    // (sqrtPrice + liquidity + tickArrays) is missing. Returning success=false
    // with a clear error lets the upstream scanner skip the pool cleanly.
    //
    // If you genuinely want a reserves-based fallback for diagnostics, pass
    // poolShape._allowClmmReservesFallback=true and read the warning below.

    const amountIn = toBigInt(inAmountAtomic);
    const reserves = {
        x: toBigInt(poolShape.reserves?.x || poolShape.xReserve || '0'),
        y: toBigInt(poolShape.reserves?.y || poolShape.yReserve || '0'),
    };

    if (!poolShape._allowClmmReservesFallback) {
        return {
            dexType: poolShape.dexType || 'RAYDIUM_CLMM',
            poolAddress: poolShape.poolAddress,
            swapForY: Boolean(swapForY),
            inAmountRaw: String(inAmountAtomic || 0),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            feeBps: Number(poolShape.feeBps || 25),
            success: false,
            error: 'CLMM math state missing (need sqrtPriceX64 + liquidity + tickArrays). Constant-product fallback disabled because it produces phantom prices on CLMM pools.',
            quoteSource: 'clmm-refused-no-tick-state',
        };
    }

    if (amountIn <= 0n) {
        return {
            dexType: poolShape.dexType || 'RAYDIUM_CLMM',
            poolAddress: poolShape.poolAddress,
            swapForY: Boolean(swapForY),
            inAmountRaw: String(inAmountAtomic || 0),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            feeBps: Number(poolShape.feeBps || 25),
            success: false,
            error: 'inAmountAtomic required',
            quoteSource: 'adapter-approximation',
        };
    }

    if (reserves.x <= 0n || reserves.y <= 0n) {
        return {
            dexType: poolShape.dexType || 'RAYDIUM_CLMM',
            poolAddress: poolShape.poolAddress,
            swapForY: Boolean(swapForY),
            inAmountRaw: String(inAmountAtomic),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            feeBps: Number(poolShape.feeBps || 25),
            success: false,
            error: 'CLMM approximation requires reserves or sqrtPrice/liquidity',
            quoteSource: 'adapter-approximation',
        };
    }

    const feeBps = BigInt(Number(poolShape.feeBps || 25));
    const amountAfterFee = amountIn * (10_000n - feeBps) / 10_000n;
    const reserveIn = swapForY ? reserves.x : reserves.y;
    const reserveOut = swapForY ? reserves.y : reserves.x;
    const denominator = reserveIn + amountAfterFee;
    const outAmount = denominator > 0n ? reserveOut * amountAfterFee / denominator : 0n;
    const minOutAmount = outAmount * (10_000n - BigInt(slippageBps || 0)) / 10_000n;

    return {
        dexType: poolShape.dexType || 'RAYDIUM_CLMM',
        poolAddress: poolShape.poolAddress,
        swapForY: Boolean(swapForY),
        inAmountRaw: String(inAmountAtomic),
        outAmountRaw: outAmount.toString(),
        minOutAmountRaw: minOutAmount.toString(),
        feeBps: Number(poolShape.feeBps || 25),
        success: outAmount > 0n,
        error: outAmount > 0n ? null : 'CLMM approximation produced zero output',
        quoteSource: 'adapter-approximation-explicit-opt-in',
    };
}

/* -------------------------------------------------------------------------- */
/*                         finalizeQuote fallback                             */
/* -------------------------------------------------------------------------- */

function finalizeQuote(quote, _poolShape) {
    // Use poolContract.finalizeQuote if available, otherwise pass through
    if (poolContract && typeof poolContract.finalizeQuote === 'function') {
        return poolContract.finalizeQuote(quote, _poolShape);
    }
    return {
        ...quote,
        tokenXMint: _poolShape?.tokenXMint || _poolShape?.baseMint || '',
        tokenYMint: _poolShape?.tokenYMint || _poolShape?.quoteMint || '',
    };
}

/* -------------------------------------------------------------------------- */
/*                         swapStepQuoteCLMM                                  */
/* -------------------------------------------------------------------------- */

function swapStepQuoteCLMM(poolShape, inAmountAtomic, swapForY, slippageBps = 20) {
    const amountSpecified = toBN(inAmountAtomic);
    const zeroForOne = Boolean(swapForY);
    const state = normalizeClmmPoolMathState(poolShape);
    const tickArrays = Array.isArray(poolShape.tickArrays) ? poolShape.tickArrays : [];
    const remainingAccounts = Array.isArray(poolShape.remainingAccounts) ? poolShape.remainingAccounts : tickArrays;

    if (!amountSpecified.gt(ZERO)) {
        return finalizeQuote({
            dexType: 'RAYDIUM_CLMM',
            poolAddress: poolShape.poolAddress,
            swapForY: zeroForOne,
            inAmountRaw: String(inAmountAtomic ?? 0),
            feeBps: Number(poolShape.feeBps || 0),
            outAmountRaw: '0',
            minOutAmountRaw: '0',
            tickSpacing: poolShape.tickSpacing,
            tickCurrent: poolShape.tickCurrent,
            tickArrays: poolShape.tickArrays,
            remainingAccounts: poolShape.remainingAccounts,
            success: false,
            error: 'CLMM: amount must be positive',
            quoteSource: 'rpc-live',
            tickStrategy: 'swap-step',
        }, poolShape);
    }

    if (!isMathReadyClmm(poolShape)) {
        const fallback = reserveQuoteClmm(poolShape, inAmountAtomic, swapForY, slippageBps);
        return finalizeQuote({
            ...fallback,
            error: fallback.error || 'CLMM swap-step unavailable; using reserve fallback',
        }, poolShape);
    }

    const sqrtPriceLimitX64 = zeroForOne
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);

    const runtime = {
        amountSpecifiedRemaining: amountSpecified,
        amountCalculated: ZERO,
        sqrtPriceX64: state.sqrtPriceX64,
        tick: state.tickCurrent,
        liquidity: state.liquidity,
        feeAmount: ZERO,
    };

    let loopCount = 0;
    while (
        runtime.amountSpecifiedRemaining.gt(ZERO)
        && !runtime.sqrtPriceX64.eq(sqrtPriceLimitX64)
        && runtime.tick >= MIN_TICK
        && runtime.tick <= MAX_TICK
        && loopCount < 256
    ) {
        const found = findNextInitializedTick(state.tickArrayCache, runtime.tick, state.tickSpacing, zeroForOne);

        // Fall-through: when no initialized tick is reachable, swap against
        // current liquidity to the price-limit boundary. Mirrors what on-chain
        // would do as it walks past the tick arrays we pre-fetched.
        let tickNext;
        let nextTickLiquidityNet = null;
        if (found) {
            tickNext = found.tick.tick;
            nextTickLiquidityNet = found.tick.liquidityNet;
        } else {
            tickNext = zeroForOne ? MIN_TICK : MAX_TICK;
        }
        if (tickNext < MIN_TICK) tickNext = MIN_TICK;
        if (tickNext > MAX_TICK) tickNext = MAX_TICK;

        const sqrtPriceNextX64 = SqrtPriceMath.getSqrtPriceX64FromTick(tickNext);
        const targetPrice = (
            (zeroForOne && sqrtPriceNextX64.lt(sqrtPriceLimitX64))
            || (!zeroForOne && sqrtPriceNextX64.gt(sqrtPriceLimitX64))
        ) ? sqrtPriceLimitX64 : sqrtPriceNextX64;

        const step = computeSwapStep({
            sqrtPriceX64Current: runtime.sqrtPriceX64,
            sqrtPriceX64Target: targetPrice,
            liquidity: runtime.liquidity,
            amountRemaining: runtime.amountSpecifiedRemaining,
            feeRate: state.feeRate,
            zeroForOne,
        });

        runtime.sqrtPriceX64 = step.sqrtPriceX64Next;
        runtime.feeAmount = runtime.feeAmount.add(step.feeAmount);
        runtime.amountSpecifiedRemaining = runtime.amountSpecifiedRemaining.sub(step.amountIn.add(step.feeAmount));
        runtime.amountCalculated = runtime.amountCalculated.add(step.amountOut);

        if (runtime.sqrtPriceX64.eq(sqrtPriceNextX64) && nextTickLiquidityNet !== null) {
            let liquidityNet = nextTickLiquidityNet;
            if (zeroForOne) liquidityNet = liquidityNet.mul(NEGATIVE_ONE);
            runtime.liquidity = LiquidityMath.addDelta(runtime.liquidity, liquidityNet);
            runtime.tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (runtime.sqrtPriceX64.eq(sqrtPriceNextX64)) {
            runtime.tick = zeroForOne ? tickNext - 1 : tickNext;
            loopCount += 1;
            break;
        } else {
            runtime.tick = SqrtPriceMath.getTickFromSqrtPriceX64(runtime.sqrtPriceX64);
        }

        loopCount += 1;
    }

    const outAmount = runtime.amountCalculated;
    const minOutAmount = outAmount.muln(10_000 - Number(slippageBps || 0)).divn(10_000);
    const success = outAmount.gt(ZERO);

    return finalizeQuote({
        dexType: 'RAYDIUM_CLMM',
        poolAddress: poolShape.poolAddress,
        swapForY: zeroForOne,
        inAmountRaw: amountSpecified.toString(),
        outAmountRaw: success ? outAmount.toString() : '0',
        minOutAmountRaw: success ? minOutAmount.toString() : '0',
        feeBps: Number(poolShape.feeBps || 0),
        feeAmount: runtime.feeAmount.toString(),
        tickSpacing: state.tickSpacing,
        tickCurrent: runtime.tick,
        tickArrays,
        remainingAccounts,
        vaults: poolShape.vaults,
        liquidity: runtime.liquidity.toString(),
        sqrtPriceX64: runtime.sqrtPriceX64.toString(),
        success,
        error: success ? null : 'CLMM swap-step quote produced zero output',
        quoteSource: 'rpc-live',
        tickStrategy: 'swap-step',
        loopCount,
    }, poolShape);
}

/* -------------------------------------------------------------------------- */
/*                           CLMMAdapter class                                */
/* -------------------------------------------------------------------------- */

class CLMMAdapter {
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
        return normalizePools(raw).map(normalizePoolRecord);
    }

    async getQuote(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
    }

    async quoteFastExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
    }

    async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
        const poolShape = normalizePoolRecord({
            ...this.poolShape,
            ...(opts.pool || {}),
            poolAddress: opts.pool?.poolAddress || opts.pool?.address || this.poolShape.poolAddress || this.poolAddress || '',
            address: opts.pool?.address || opts.pool?.poolAddress || this.poolShape.address || this.poolAddress || '',
        });

        const wantsLive = Boolean(opts.liveRpc || opts.requireLiveRpc || opts.useLiveRpc);
        if (wantsLive) {
            try {
                return await liveQuoteClmm(poolShape, inAmountAtomic, swapForY, slippageBps, this.connection);
            } catch (error) {
                if (opts.requireLiveRpc) {
                    return finalizeQuote({
                        dexType: poolShape.dexType || 'RAYDIUM_CLMM',
                        poolAddress: poolShape.poolAddress,
                        swapForY: Boolean(swapForY),
                        inAmountRaw: String(inAmountAtomic || '0'),
                        outAmountRaw: '0',
                        minOutAmountRaw: '0',
                        feeBps: Number(poolShape.feeBps || 25),
                        success: false,
                        error: `CLMM live quote failed: ${error.message}`,
                        quoteSource: 'rpc-live',
                    }, poolShape);
                }
            }
        }
        if (typeof opts?.quoteProvider === 'function') {
            const rawQuote = await opts.quoteProvider({
                pool: poolShape,
                inAmountAtomic: String(inAmountAtomic),
                swapForY,
                slippageBps,
                connection: this.connection,
            });
            return finalizeQuote({
                ...rawQuote,
                dexType: poolShape.dexType || 'RAYDIUM_CLMM',
                poolAddress: poolShape.poolAddress,
                quoteSource: 'custom-provider',
            }, poolShape);
        }

        return swapStepQuoteCLMM(poolShape, inAmountAtomic, swapForY, slippageBps);
    }

    async buildSwapTx({ user, standardQuote, opts = {} }) {
        const poolShape = normalizePoolRecord({
            ...this.poolShape,
            ...(opts.pool || {}),
            poolAddress: opts.pool?.poolAddress || opts.pool?.address || this.poolShape.poolAddress || this.poolAddress || '',
            address: opts.pool?.address || opts.pool?.poolAddress || this.poolShape.address || this.poolAddress || '',
        });
        return buildClmmSwapTx({ user, standardQuote, pool: poolShape });
    }
}
function parseArgs(argv) {
    const out = {
        input: 'sol_usdc.json',
        pool: null,
        amount: '1000000000',
        output: 'Qseries/_clmm.json',
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

module.exports = CLMMAdapter;
module.exports.CLMMAdapter = CLMMAdapter;
module.exports.MathUtil = MathUtil;
module.exports.SqrtPriceMath = SqrtPriceMath;
module.exports.TickUtils = TickUtils;
module.exports.LiquidityMath = LiquidityMath;
module.exports.computeSwapStep = computeSwapStep;
module.exports.swapStepQuoteCLMM = swapStepQuoteCLMM;
module.exports.liveQuoteClmm = liveQuoteClmm;
module.exports.findNextInitializedTick = findNextInitializedTick;
module.exports.isMathReadyClmm = isMathReadyClmm;
module.exports.normalizeClmmPoolMathState = normalizeClmmPoolMathState;
module.exports.normalizePoolRecord = normalizePoolRecord;
module.exports.normalizePools = normalizePools;
module.exports.reserveQuoteClmm = reserveQuoteClmm;
module.exports.buildClmmSwapTx = buildClmmSwapTx;
module.exports.finalizeQuote = finalizeQuote;
module.exports.toBN = toBN;
module.exports.toBigInt = toBigInt;
module.exports.signedLeftShift = signedLeftShift;
module.exports.signedRightShift = signedRightShift;
module.exports.mulRightShift = mulRightShift;
module.exports.ZERO = ZERO;
module.exports.ONE = ONE;
module.exports.NEGATIVE_ONE = NEGATIVE_ONE;
module.exports.Q64 = Q64;
module.exports.Q128 = Q128;
module.exports.MaxU64 = MaxU64;
module.exports.MaxUint128 = MaxUint128;
module.exports.U64Resolution = U64Resolution;
module.exports.MIN_TICK = MIN_TICK;
module.exports.MAX_TICK = MAX_TICK;
module.exports.MIN_SQRT_PRICE_X64 = MIN_SQRT_PRICE_X64;
module.exports.MAX_SQRT_PRICE_X64 = MAX_SQRT_PRICE_X64;
module.exports.TICK_ARRAY_SIZE = TICK_ARRAY_SIZE;
module.exports.TICK_ARRAY_BITMAP_SIZE = TICK_ARRAY_BITMAP_SIZE;
module.exports.FEE_RATE_DENOMINATOR = FEE_RATE_DENOMINATOR;

if (require.main === module) {
    (async () => {
        const input = process.argv[2] || 'sol_usdc.json';
        const amount = process.argv[3] || '1000';
        const output = process.argv[4] || 'Qseries/_CLMM.json';

        if (!fs.existsSync(input)) {
            throw new Error(`Input file not found: ${path.resolve(input)}`);
        }

        const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
        const pool = normalizePools(raw).find((entry) => {
            const type = String(entry?.type || '').toLowerCase();
            const dexType = String(entry?.dexType || '').toLowerCase();
            return type.includes('clmm') || dexType.includes('raydiumClmm');
        });
        if (!pool) throw new Error('No CLMM pool found in input file');

        const adapter = new CLMMAdapter(null, pool.poolAddress || pool.address || pool.id, pool);
        const quote = await adapter.quoteExactIn(amount, true, 50);
        const result = { poolAddress: adapter.poolShape.poolAddress, poolShape: adapter.poolShape, quote };
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    })().catch((error) => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
}

//. node math/Q_CLMM.js pools/raw_quality_stablePairs.json --out Qseries/clmm.json

//. 

/*


 node _enrichment.js sol_usdc_RAW.json \
--out sol_usdc.json

node math/Q_DLMM.js
node math/Q_CLMM.js
node math/Q_WHIRLPOOL.js
node math/Q_CPMM.js

  */
