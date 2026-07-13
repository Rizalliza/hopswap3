'use strict';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const NATIVE_SOL_MINT = '11111111111111111111111111111111';

function readPath(obj, path) {
  if (!obj) return undefined;
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function firstPath(obj, paths) {
  for (const path of paths) {
    const value = readPath(obj, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function stringifyPubkey(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object') {
    const nested = firstPath(value, [
      'mint',
      'address',
      'pubkey',
      'publicKey',
      'id',
    ]);
    if (nested !== undefined && nested !== null && nested !== value) {
      return stringifyPubkey(nested);
    }
    if (typeof value.toBase58 === 'function') return value.toBase58();
    if (typeof value.toString === 'function') {
      const text = value.toString();
      if (text && text !== '[object Object]') return text.trim();
    }
    return undefined;
  }
  return String(value).trim() || undefined;
}

function canonicalMint(value) {
  const text = stringifyPubkey(value);
  if (!text) return undefined;
  if (text === NATIVE_SOL_MINT || text.toUpperCase() === 'SOL' || text.toUpperCase() === 'WSOL') {
    return SOL_MINT;
  }
  return text;
}

function firstMint(pool, paths) {
  return canonicalMint(firstPath(pool, paths));
}

function mergeCanonicalPool(pool = {}) {
  const poolAddress = pool.poolAddress || pool.address || pool.id || '';
  const tokenXMint = firstMint(pool, [
    'tokenXMint',
    'baseMint',
    'mintA',
    'tokenMintA',
    'tokenAMint',
    'tokenA.mint',
    'tokenA.address',
    'tokenA',
    'token0.mint',
    'token0.address',
  ]);
  const tokenYMint = firstMint(pool, [
    'tokenYMint',
    'quoteMint',
    'mintB',
    'tokenMintB',
    'tokenBMint',
    'tokenB.mint',
    'tokenB.address',
    'tokenB',
    'token1.mint',
    'token1.address',
  ]);
  const tokenXDecimals = numberOrNull(firstPath(pool, [
    'tokenXDecimals',
    'baseDecimals',
    'tokenADecimals',
    'decimalsX',
    'tokenA.decimals',
    'token0.decimals',
  ]));
  const tokenYDecimals = numberOrNull(firstPath(pool, [
    'tokenYDecimals',
    'quoteDecimals',
    'tokenBDecimals',
    'decimalsY',
    'tokenB.decimals',
    'token1.decimals',
  ]));

  return {
    ...pool,
    address: pool.address || poolAddress,
    poolAddress,
    tokenXMint,
    tokenYMint,
    baseMint: canonicalMint(pool.baseMint) || tokenXMint,
    quoteMint: canonicalMint(pool.quoteMint) || tokenYMint,
    mintA: canonicalMint(pool.mintA) || tokenXMint,
    mintB: canonicalMint(pool.mintB) || tokenYMint,
    tokenXDecimals,
    tokenYDecimals,
    baseDecimals: numberOrNull(pool.baseDecimals ?? tokenXDecimals),
    quoteDecimals: numberOrNull(pool.quoteDecimals ?? tokenYDecimals),
    tokenXSymbol: pool.tokenXSymbol || pool.baseSymbol || pool.tokenA?.symbol,
    tokenYSymbol: pool.tokenYSymbol || pool.quoteSymbol || pool.tokenB?.symbol,
    baseSymbol: pool.baseSymbol || pool.tokenXSymbol || pool.tokenA?.symbol,
    quoteSymbol: pool.quoteSymbol || pool.tokenYSymbol || pool.tokenB?.symbol,
    feeBps: Number(pool.feeBps ?? pool.feeBpsCanonical ?? 0),
    reserves: {
      ...(pool.reserves || {}),
      x: pool.reserves?.x ?? pool.xReserve,
      y: pool.reserves?.y ?? pool.yReserve,
    },
    xReserve: pool.xReserve ?? pool.reserves?.x,
    yReserve: pool.yReserve ?? pool.reserves?.y,
  };
}

function finalizeQuote(quote = {}, pool = {}) {
  const mergedPool = mergeCanonicalPool(pool);
  const inAmountRaw = stringifyAmount(quote.inAmountRaw ?? quote.inputAmount ?? quote.amountInRaw);
  const outAmountRaw = stringifyAmount(quote.outAmountRaw ?? quote.amountOutRaw ?? quote.expectedOutputAmount);
  const minOutAmountRaw = stringifyAmount(quote.minOutAmountRaw ?? quote.minimumAmountOut ?? outAmountRaw);

  return {
    ...quote,
    dexType: quote.dexType || mergedPool.dexType || mergedPool.dex,
    poolAddress: quote.poolAddress || mergedPool.poolAddress,
    swapForY: Boolean(quote.swapForY),
    inAmountRaw,
    outAmountRaw,
    amountOutRaw: outAmountRaw,
    expectedOutputAmount: outAmountRaw,
    minOutAmountRaw,
    feeBps: Number(quote.feeBps ?? mergedPool.feeBps ?? 0),
    success: quote.success !== undefined ? Boolean(quote.success) : BigInt(outAmountRaw || '0') > 0n,
    error: quote.error || null,
    quoteSource: quote.quoteSource || 'local-adapter',
  };
}

function validateQuoteContract(quote = {}) {
  const required = [
    'poolAddress',
    'dexType',
    'inAmountRaw',
    'outAmountRaw',
    'minOutAmountRaw',
    'success',
  ];
  const missing = required.filter((key) => quote[key] === undefined || quote[key] === null || quote[key] === '');
  return { valid: missing.length === 0, missing };
}

function validatePoolContract(pool = {}) {
  const required = [
    'poolAddress',
    'type',
    'dexType',
    'tokenXMint',
    'tokenYMint',
    'tokenXDecimals',
    'tokenYDecimals',
    'feeBps',
  ];
  const missing = required.filter((key) => pool[key] === undefined || pool[key] === null || pool[key] === '');
  return { valid: missing.length === 0, missing };
}

function validateRouteLegContract(leg = {}) {
  const required = [
    'poolAddress',
    'type',
    'dexType',
    'tokenInMint',
    'tokenOutMint',
    'swapDirection',
    'inputDecimals',
    'outputDecimals',
  ];
  const missing = required.filter((key) => leg[key] === undefined || leg[key] === null || leg[key] === '');
  return { valid: missing.length === 0, missing };
}

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function stringifyAmount(value) {
  if (value === undefined || value === null || value === '') return '0';
  return String(value);
}

module.exports = {
  mergeCanonicalPool,
  finalizeQuote,
  validatePoolContract,
  validateRouteLegContract,
  validateQuoteContract,
};
