'use strict';

/**
 * utilities/whirlpool_tick_utils.js
 *
 * Minimal helper used by engine/zen_enrichment.js to normalize
 * structured whirlpool tick array data.
 *
 * Expected downstream shapes (consumers like Q_WHIRLPOOL / myEngine2):
 *   {
 *     address: <string>,
 *     data: {
 *       startTickIndex: <number>,
 *       ticks: [
 *         {
 *           tick: <number>,
 *           initialized: <boolean>,
 *           liquidityNet: <BN-like string or number>,
 *           liquidityGross: <BN-like string or number>,
 *         },
 *         ...
 *       ]
 *     }
 *   }
 */
const {
    combineCodec, getBooleanDecoder, getBooleanEncoder, getI128Decoder, getI128Encoder, getU128Decoder, getU128Encoder, getU64Decoder, getStructDecoder, getStructEncoder, getArrayDecoder, getArrayEncoder,
} = require('@solana/codecs');


const FIXED_TICK_ARRAY_DISCRIMINATOR = new Uint8Array([
    69, 97, 189, 190, 110, 7, 66, 187,
]);
const DYNAMIC_TICK_ARRAY_DISCRIMINATOR = new Uint8Array([
    17, 216, 246, 142, 225, 199, 218, 56,
]);
const FIXED_TICK_ARRAY_DISCRIMINATOR_NUMBER = getU64Decoder().decode(
    FIXED_TICK_ARRAY_DISCRIMINATOR,
);
const DYNAMIC_TICK_ARRAY_DISCRIMINATOR_NUMBER = getU64Decoder().decode(
    DYNAMIC_TICK_ARRAY_DISCRIMINATOR,
);

function getTickArraySize() {
    return getFixedTickArraySize();
}

const TICK_ARRAY_DISCRIMINATOR = FIXED_TICK_ARRAY_DISCRIMINATOR;

function getTickArrayDiscriminatorBytes() {
    return getFixedTickArrayDiscriminatorBytes();
}

function getTickArrayEncoder() {
    return getFixedTickArrayEncoder();
}

function getTickArrayDecoder() {
    return getFixedTickArrayDecoder();
}

function getTickArrayCodec() {
    return combineCodec(getFixedTickArrayEncoder(), getFixedTickArrayDecoder());
}
function toNumberLoose(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = typeof value === 'number' ? value : Number(String(value));
    return Number.isFinite(n) ? n : fallback;
}

function toBoolLoose(value, fallback = false) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
    return fallback;
}

function toStringLoose(value, fallback = '0') {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : fallback;
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value.toString === 'function') return value.toString();
    return fallback;
}

function toAddressString(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value;
    if (value && typeof value.toBase58 === 'function') return value.toBase58();
    if (value && typeof value.toString === 'function') {
        const text = value.toString();
        return text === '[object Object]' ? null : text;
    }
    return null;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function getTickEncoder() {
    return getStructEncoder([
        ['initialized', getBooleanEncoder()],
        ['liquidityNet', getI128Encoder()],
        ['liquidityGross', getU128Encoder()],
        ['feeGrowthOutsideA', getU128Encoder()],
        ['feeGrowthOutsideB', getU128Encoder()],
        ['rewardGrowthsOutside', getArrayEncoder(getU128Encoder(), { size: 3 })],
    ]);
}

function getTickDecoder() {
    return getStructDecoder([
        ['initialized', getBooleanDecoder()],
        ['liquidityNet', getI128Decoder()],
        ['liquidityGross', getU128Decoder()],
        ['feeGrowthOutsideA', getU128Decoder()],
        ['feeGrowthOutsideB', getU128Decoder()],
        ['rewardGrowthsOutside', getArrayDecoder(getU128Decoder(), { size: 3 })],
    ]);
}

function getTickCodec() {
    return combineCodec(getTickEncoder(), getTickDecoder());
}

function getDynamicTickDataEncoder() {
    return getStructEncoder([
        ['liquidityNet', getI128Encoder()],
        ['liquidityGross', getU128Encoder()],
        ['feeGrowthOutsideA', getU128Encoder()],
        ['feeGrowthOutsideB', getU128Encoder()],
        ['rewardGrowthsOutside', getArrayEncoder(getU128Encoder(), { size: 3 })],
    ]);
}

function getDynamicTickDataDecoder() {
    return getStructDecoder([
        ['liquidityNet', getI128Decoder()],
        ['liquidityGross', getU128Decoder()],
        ['feeGrowthOutsideA', getU128Decoder()],
        ['feeGrowthOutsideB', getU128Decoder()],
        ['rewardGrowthsOutside', getArrayDecoder(getU128Decoder(), { size: 3 })],
    ]);
}

function getDynamicTickDataCodec() {
    return combineCodec(getDynamicTickDataEncoder(), getDynamicTickDataDecoder());
}

function getDynamicTickEncoder() {
    return getDiscriminatedUnionEncoder([
        ['Uninitialized', getUnitEncoder()],
        [
            'Initialized',
            getStructEncoder([
                ['fields', getTupleEncoder([getDynamicTickDataEncoder()])],
            ]),
        ],
    ]);
}

function getDynamicTickDecoder() {
    return getDiscriminatedUnionDecoder([
        ['Uninitialized', getUnitDecoder()],
        [
            'Initialized',
            getStructDecoder([
                ['fields', getTupleDecoder([getDynamicTickDataDecoder()])],
            ]),
        ],
    ]);
}

function getDynamicTickCodec() {
    return combineCodec(getDynamicTickEncoder(), getDynamicTickDecoder());
}

function dynamicTick(kind, data) {
    return Array.isArray(data)
        ? { __kind: kind, fields: data }
        : { __kind: kind, ...(data ?? {}) };
}

function isDynamicTick(kind, value) {
    return value.__kind === kind;
}

function getFixedTickArrayDiscriminatorBytes() {
    return fixEncoderSize(getBytesEncoder(), 8).encode(
        FIXED_TICK_ARRAY_DISCRIMINATOR,
    );
}

function getFixedTickArrayEncoder() {
    return transformEncoder(
        getStructEncoder([
            ['discriminator', fixEncoderSize(getBytesEncoder(), 8)],
            ['startTickIndex', getI32Encoder()],
            ['ticks', getArrayEncoder(getTickEncoder(), { size: 88 })],
            ['whirlpool', getAddressEncoder()],
        ]),
        (value) => ({ ...value, discriminator: FIXED_TICK_ARRAY_DISCRIMINATOR }),
    );
}

function getFixedTickArrayDecoder() {
    return getStructDecoder([
        ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
        ['startTickIndex', getI32Decoder()],
        ['ticks', getArrayDecoder(getTickDecoder(), { size: 88 })],
        ['whirlpool', getAddressDecoder()],
    ]);
}
function getFixedTickArrayCodec() {
    return combineCodec(getFixedTickArrayEncoder(), getFixedTickArrayDecoder());
}

function decodeFixedTickArray(encodedAccount) {
    return decodeAccount(encodedAccount, getFixedTickArrayDecoder());
}

async function fetchFixedTickArray(rpc, address, config) {
    const maybeAccount = await fetchMaybeFixedTickArray(rpc, address, config);
    assertAccountExists(maybeAccount);
    return maybeAccount;
}

async function fetchMaybeFixedTickArray(rpc, address, config) {
    const maybeAccount = await fetchEncodedAccount(rpc, address, config);
    return decodeFixedTickArray(maybeAccount);
}

async function fetchAllFixedTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchAllMaybeFixedTickArray(rpc, addresses, config);
    assertAccountsExist(maybeAccounts);
    return maybeAccounts;
}

async function fetchAllMaybeFixedTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchEncodedAccounts(rpc, addresses, config);
    return maybeAccounts.map((maybeAccount) => decodeFixedTickArray(maybeAccount));
}

function getFixedTickArraySize() {
    return 9988;
}

function getDynamicTickArrayDiscriminatorBytes() {
    return fixEncoderSize(getBytesEncoder(), 8).encode(
        DYNAMIC_TICK_ARRAY_DISCRIMINATOR,
    );
}

function getDynamicTickArrayEncoder() {
    return transformEncoder(
        getStructEncoder([
            ['discriminator', fixEncoderSize(getBytesEncoder(), 8)],
            ['startTickIndex', getI32Encoder()],
            ['whirlpool', getAddressEncoder()],
            ['tickBitmap', getU128Encoder()],
            ['ticks', getArrayEncoder(getDynamicTickEncoder(), { size: 88 })],
        ]),
        (value) => ({ ...value, discriminator: DYNAMIC_TICK_ARRAY_DISCRIMINATOR }),
    );
}

function getDynamicTickArrayDecoder() {
    return getStructDecoder([
        ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
        ['startTickIndex', getI32Decoder()],
        ['whirlpool', getAddressDecoder()],
        ['tickBitmap', getU128Decoder()],
        ['ticks', getArrayDecoder(getDynamicTickDecoder(), { size: 88 })],
    ]);
}

function getDynamicTickArrayCodec() {
    return combineCodec(
        getDynamicTickArrayEncoder(),
        getDynamicTickArrayDecoder(),
    );
}

function decodeDynamicTickArray(encodedAccount) {
    return decodeAccount(encodedAccount, getDynamicTickArrayDecoder());
}

async function fetchDynamicTickArray(rpc, address, config) {
    const maybeAccount = await fetchMaybeDynamicTickArray(rpc, address, config);
    assertAccountExists(maybeAccount);
    return maybeAccount;
}

async function fetchMaybeDynamicTickArray(rpc, address, config) {
    const maybeAccount = await fetchEncodedAccount(rpc, address, config);
    return decodeDynamicTickArray(maybeAccount);
}

async function fetchAllDynamicTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchAllMaybeDynamicTickArray(rpc, addresses, config);
    assertAccountsExist(maybeAccounts);
    return maybeAccounts;
}

async function fetchAllMaybeDynamicTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchEncodedAccounts(rpc, addresses, config);
    return maybeAccounts.map((maybeAccount) => decodeDynamicTickArray(maybeAccount));
}

function consolidateTick(tick) {
    if ('initialized' in tick) return tick;

    switch (tick.__kind) {
        case 'Uninitialized':
            return {
                initialized: false,
                liquidityGross: 0n,
                liquidityNet: 0n,
                feeGrowthOutsideA: 0n,
                feeGrowthOutsideB: 0n,
                rewardGrowthsOutside: [0n, 0n, 0n],
            };
        case 'Initialized':
            return {
                initialized: true,
                liquidityGross: tick.fields[0].liquidityGross,
                liquidityNet: tick.fields[0].liquidityNet,
                feeGrowthOutsideA: tick.fields[0].feeGrowthOutsideA,
                feeGrowthOutsideB: tick.fields[0].feeGrowthOutsideB,
                rewardGrowthsOutside: tick.fields[0].rewardGrowthsOutside,
            };
        default:
            throw new Error(`Unknown dynamic tick kind: ${tick.__kind}`);
    }
}

function consolidateTickArray(tickArrayAccount) {
    if ('exists' in tickArrayAccount && !tickArrayAccount.exists) {
        return tickArrayAccount;
    }

    const discriminator = getU64Decoder().decode(
        tickArrayAccount.data.discriminator.subarray(0, 8),
    );
    const __kind = discriminator === FIXED_TICK_ARRAY_DISCRIMINATOR_NUMBER
        ? 'Fixed'
        : 'Dynamic';

    return {
        ...tickArrayAccount,
        data: {
            __kind,
            ...tickArrayAccount.data,
            ticks: tickArrayAccount.data.ticks.map(consolidateTick),
        },
    };
}

function decodeTickArray(encodedAccount) {
    if ('exists' in encodedAccount && !encodedAccount.exists) {
        return encodedAccount;
    }

    const discriminator = getU64Decoder().decode(encodedAccount.data.subarray(0, 8));
    switch (discriminator) {
        case FIXED_TICK_ARRAY_DISCRIMINATOR_NUMBER:
            return consolidateTickArray(decodeFixedTickArray(encodedAccount));
        case DYNAMIC_TICK_ARRAY_DISCRIMINATOR_NUMBER:
            return consolidateTickArray(decodeDynamicTickArray(encodedAccount));
        default:
            throw new Error(`Unknown discriminator: ${discriminator}`);
    }
}

async function fetchTickArray(rpc, address, config) {
    const maybeAccount = await fetchMaybeTickArray(rpc, address, config);
    assertAccountExists(maybeAccount);
    return maybeAccount;
}

async function fetchMaybeTickArray(rpc, address, config) {
    const maybeAccount = await fetchEncodedAccount(rpc, address, config);
    return decodeTickArray(maybeAccount);
}

async function fetchAllTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchAllMaybeTickArray(rpc, addresses, config);
    assertAccountsExist(maybeAccounts);
    return maybeAccounts;
}

async function fetchAllMaybeTickArray(rpc, addresses, config) {
    const maybeAccounts = await fetchEncodedAccounts(rpc, addresses, config);
    return maybeAccounts.map((maybeAccount) => decodeTickArray(maybeAccount));
}
/**
 * normalizeStructuredTickArray({ address, data })
 */
function normalizeStructuredTickArray({ address, data, tickSpacing = 1 } = {}) {
    const startTickIndex = toNumberLoose(data?.startTickIndex ?? data?.start_index ?? 0, 0);
    const spacing = Math.max(1, toNumberLoose(data?.tickSpacing ?? data?.tick_spacing ?? tickSpacing, 1));

    const rawTicks = Array.isArray(data?.ticks) ? data.ticks : [];
    // Ensure each tick has the fields that the simulator reads:
    // - tick
    // - initialized
    // - liquidityNet
    // - liquidityGross
    const ticks = rawTicks.map((tick, idx) => {
        const tickIndex = toNumberLoose(
            tick?.tick ?? tick?.tickIndex ?? tick?.index,
            startTickIndex + (idx * spacing),
        );

        const initialized = tick?.initialized !== undefined
            ? toBoolLoose(tick.initialized, Boolean(tick?.liquidityGross))
            : Boolean(tick?.liquidityGross && toStringLoose(tick.liquidityGross, '0') !== '0');

        return {
            tick: tickIndex,
            initialized,
            liquidityNet: toStringLoose(tick?.liquidityNet ?? tick?.liquidity_net, '0'),
            liquidityGross: toStringLoose(tick?.liquidityGross ?? tick?.liquidity_gross, '0'),
        };
    });

    return {
        address: toAddressString(address),
        data: {
            startTickIndex,
            tickSpacing: spacing,
            ticks,
        },
    };
}

function normalizeTickArrayCollection(value, tickSpacing = 1) {
    return asArray(value).map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const data = entry.data && typeof entry.data === 'object' ? entry.data : entry;
        if (!Array.isArray(data.ticks) && !Array.isArray(entry.ticks)) return entry;

        const spacing = data.tickSpacing
            ?? data.tick_spacing
            ?? entry.tickSpacing
            ?? entry.tick_spacing
            ?? tickSpacing;

        return normalizeStructuredTickArray({
            address: entry.address ?? entry.pubkey ?? entry.publicKey ?? null,
            tickSpacing: spacing,
            data: {
                startTickIndex: data.startTickIndex ?? data.start_index ?? entry.startTickIndex ?? entry.start_index ?? 0,
                tickSpacing: spacing,
                ticks: Array.isArray(data.ticks) ? data.ticks : entry.ticks,
            },
        });
    });
}

function flattenInitializedTicks(tickArrayData, tickSpacing = 1) {
    const out = [];
    for (const entry of asArray(tickArrayData)) {
        const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
        const startTickIndex = toNumberLoose(data?.startTickIndex ?? data?.start_index, 0);
        const spacing = Math.max(1, toNumberLoose(data?.tickSpacing ?? data?.tick_spacing ?? tickSpacing, 1));
        const ticks = asArray(data?.ticks);

        ticks.forEach((tick, index) => {
            const liquidityGross = tick?.liquidityGross ?? tick?.liquidity_gross ?? '0';
            const initialized = tick?.initialized === true || String(liquidityGross) !== '0';
            if (!initialized) return;

            const tickIndex = toNumberLoose(
                tick?.tick ?? tick?.tickIndex ?? tick?.index,
                startTickIndex + (index * spacing),
            );

            out.push({
                index: tickIndex,
                tickIndex,
                tick: tickIndex,
                initialized: true,
                liquidityNet: toStringLoose(tick?.liquidityNet ?? tick?.liquidity_net, '0'),
                liquidityGross: toStringLoose(liquidityGross, '0'),
                sqrtPrice: tick?.sqrtPrice ?? tick?.sqrtPriceX64 ?? '0',
            });
        });
    }
    return out.sort((left, right) => (left.tickIndex ?? left.index) - (right.tickIndex ?? right.index));
}

module.exports = {
    DYNAMIC_TICK_ARRAY_DISCRIMINATOR,
    DYNAMIC_TICK_ARRAY_DISCRIMINATOR_NUMBER,
    FIXED_TICK_ARRAY_DISCRIMINATOR,
    FIXED_TICK_ARRAY_DISCRIMINATOR_NUMBER,
    TICK_ARRAY_DISCRIMINATOR,
    consolidateTick,
    consolidateTickArray,
    decodeDynamicTickArray,
    decodeFixedTickArray,
    decodeTickArray,
    dynamicTick,
    fetchAllDynamicTickArray,
    fetchAllFixedTickArray,
    fetchAllMaybeDynamicTickArray,
    fetchAllMaybeFixedTickArray,
    fetchAllMaybeTickArray,
    fetchAllTickArray,
    fetchDynamicTickArray,
    fetchFixedTickArray,
    fetchMaybeDynamicTickArray,
    fetchMaybeFixedTickArray,
    fetchMaybeTickArray,
    fetchTickArray,
    getDynamicTickArrayCodec,
    getDynamicTickArrayDecoder,
    getDynamicTickArrayDiscriminatorBytes,
    getDynamicTickArrayEncoder,
    getDynamicTickCodec,
    getDynamicTickDataCodec,
    getDynamicTickDataDecoder,
    getDynamicTickDataEncoder,
    getDynamicTickDecoder,
    getDynamicTickEncoder,
    getFixedTickArrayCodec,
    getFixedTickArrayDecoder,
    getFixedTickArrayDiscriminatorBytes,
    getFixedTickArrayEncoder,
    getFixedTickArraySize,
    getTickArrayCodec,
    getTickArrayDecoder,
    getTickArrayDiscriminatorBytes,
    getTickArrayEncoder,
    getTickArraySize,
    getTickCodec,
    getTickDecoder,
    getTickEncoder,
    isDynamicTick,
    flattenInitializedTicks,
    normalizeTickArrayCollection,
    normalizeStructuredTickArray,
    toAddressString,
    toBoolLoose,
    toNumberLoose,
    toStringLoose,
};
