'use strict';

const BN = require('bn.js');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { mergeCanonicalPool } = require('../poolContract');
const {
  ClmmInstrument,
  PoolInfoLayout,
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
  TickArrayUtil,
  getPdaTickArrayAddress,
} = require('@raydium-io/raydium-sdk-v2');

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

function firstNonEmptyArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function poolRemainingAccounts(poolShape) {
  const maxPoolAccounts = Number(process.env.CLMM_MAX_POOL_REMAINING_ACCOUNTS || 4);
  const remaining = Array.isArray(poolShape.remainingAccounts) ? poolShape.remainingAccounts : [];
  if (remaining.length > 0 && remaining.length <= maxPoolAccounts) return remaining;
  const tickArrays = Array.isArray(poolShape.tickArrays) ? poolShape.tickArrays : [];
  if (tickArrays.length > 0 && tickArrays.length <= maxPoolAccounts) return tickArrays;
  return [];
}

// Account-budget guard: the standardQuote.tickArrays / standardQuote.remainingAccounts
// paths are NOT bounded by poolRemainingAccounts' cap, so a long enrichment list would
// flow straight into the instruction and blow the 1232-byte packet. Cap them to the same
// max (default 4). swapV2 needs at most ~3 ordered tick arrays, so this never truncates a
// valid set; it only trims runaway lists, and warns loudly when it does.
function clmmMaxAccounts() {
  return Number(process.env.CLMM_MAX_POOL_REMAINING_ACCOUNTS || 4);
}

function capAccounts(list, label) {
  if (!Array.isArray(list)) return list;
  const max = clmmMaxAccounts();
  if (list.length <= max) return list;
  console.error(`[tx_clmm] WARN capping ${label} ${list.length} -> ${max} (account-budget guard); check enrichment`);
  return list.slice(0, max);
}

function ensureStandardQuote(standardQuote, dexType) {
  if (!standardQuote || !standardQuote.inAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.inAmountRaw`);
  }
  if (!standardQuote.minOutAmountRaw && !standardQuote.outAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.minOutAmountRaw or outAmountRaw`);
  }
}

function pubkey(value, label) {
  if (!value) throw new Error(`RAYDIUM_CLMM missing ${label}`);
  return value instanceof PublicKey ? value : new PublicKey(String(value));
}

function pubkeyString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return String(value);
}

function getPoolAddress(poolShape, standardQuote) {
  return poolShape.poolAddress || poolShape.address || poolShape.id || standardQuote.poolAddress;
}

function userAta(wallet, mint) {
  return getAssociatedTokenAddressSync(pubkey(mint, 'mint'), wallet, true, TOKEN_PROGRAM_ID);
}

async function fetchPoolState(connection, poolAddress) {
  const poolId = pubkey(poolAddress, 'poolAddress');
  const account = await connection.getAccountInfo(poolId);
  if (!account) throw new Error(`RAYDIUM_CLMM pool account not found: ${poolId.toBase58()}`);
  return { poolId, programId: account.owner, state: PoolInfoLayout.decode(account.data) };
}

function defaultSqrtPriceLimit(inputIsA) {
  return inputIsA
    ? new BN(MIN_SQRT_PRICE_X64.toString()).addn(1)
    : new BN(MAX_SQRT_PRICE_X64.toString()).subn(1);
}

function deriveFallbackTickArrays(programId, poolId, state, inputIsA) {
  const tickSpacing = Number(state.tickSpacing || 0);
  const tickCurrent = Number(state.tickCurrent || 0);
  if (!Number.isFinite(tickSpacing) || tickSpacing <= 0) {
    throw new Error('RAYDIUM_CLMM cannot derive tick arrays without tickSpacing');
  }
  if (!Number.isFinite(tickCurrent)) {
    throw new Error('RAYDIUM_CLMM cannot derive tick arrays without tickCurrent');
  }
  const tickCount = TickArrayUtil.tickCount(tickSpacing);
  const currentStart = TickArrayUtil.getTickArrayStartIndex(tickCurrent, tickSpacing);
  return [0, 1].map((offset) => {
    const startIndex = inputIsA
      ? currentStart - (offset * tickCount)
      : currentStart + (offset * tickCount);
    return getPdaTickArrayAddress(programId, poolId, startIndex).publicKey;
  });
}

function buildClmmSwapTx({ user, standardQuote, pool }) {
  const dexType = 'RAYDIUM_CLMM';
  ensureStandardQuote(standardQuote, dexType);
  const poolShape = mergeCanonicalPool(pool || {});
  const swapForY = Boolean(standardQuote.swapForY);
  const tickArrays = normalizeStringArray(firstNonEmptyArray(capAccounts(standardQuote.tickArrays, 'standardQuote.tickArrays'), poolRemainingAccounts(poolShape)));
  const remainingAccounts = normalizeStringArray(firstNonEmptyArray(
    capAccounts(standardQuote.remainingAccounts, 'standardQuote.remainingAccounts'),
    poolRemainingAccounts(poolShape),
    tickArrays
  ));

  return {
    mode: 'localMath_swap_request',
    dexType,
    quoteMode: 'exactIn',
    requiresExternalExecutor: true,
    user: user ? String(user) : null,
    poolAddress: poolShape.poolAddress,
    inputMint: swapForY ? poolShape.tokenXMint : poolShape.tokenYMint,
    outputMint: swapForY ? poolShape.tokenYMint : poolShape.tokenXMint,
    inAmountRaw: String(standardQuote.inAmountRaw),
    expectedOutAmountRaw: String(standardQuote.outAmountRaw || '0'),
    minOutAmountRaw: String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0'),
    slippageBps: Number(standardQuote.slippageBps || 20),
    feeBps: Number(standardQuote.feeBps ?? poolShape.feeBps ?? 0),
    quoteSource: standardQuote.quoteSource || 'local-math',
    swapForY,
    tickArrays,
    remainingAccounts,
    vaults: standardQuote.vaults || poolShape.vaults || null,
    standardQuote,
  };
}

async function buildSwapInstructions({ connection, user, standardQuote, pool }) {
  if (!connection) throw new Error('RAYDIUM_CLMM buildSwapInstructions requires connection');
  ensureStandardQuote(standardQuote, 'RAYDIUM_CLMM');
  const poolShape = mergeCanonicalPool(pool || {});
  const poolAddress = getPoolAddress(poolShape, standardQuote);
  const { poolId, programId, state } = await fetchPoolState(connection, poolAddress);
  const wallet = pubkey(user, 'user');
  const inputMint = pubkey(standardQuote.inputMint || standardQuote.tokenInMint, 'inputMint');
  const outputMint = pubkey(standardQuote.outputMint || standardQuote.tokenOutMint, 'outputMint');
  const inputIsA = pubkeyString(inputMint) === pubkeyString(state.mintA);
  const outputIsA = pubkeyString(outputMint) === pubkeyString(state.mintA);
  if (inputIsA === outputIsA) {
    throw new Error(`RAYDIUM_CLMM mint direction mismatch: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
  }

  const tickArrays = normalizeStringArray(firstNonEmptyArray(capAccounts(standardQuote.tickArrays, 'standardQuote.tickArrays'), poolRemainingAccounts(poolShape)));
  const remainingAccounts = normalizeStringArray(firstNonEmptyArray(
    capAccounts(standardQuote.remainingAccounts, 'standardQuote.remainingAccounts'),
    poolRemainingAccounts(poolShape),
    tickArrays
  )).map((addr) => new PublicKey(addr));
  const swapAccounts = remainingAccounts.length
    ? remainingAccounts
    : deriveFallbackTickArrays(programId, poolId, state, inputIsA);
  if (process.env.CLMM_TX_DEBUG === 'true') {
    console.error('[tx_clmm] account source', JSON.stringify({
      standardTickArrays: Array.isArray(standardQuote.tickArrays) ? standardQuote.tickArrays.length : null,
      standardRemainingAccounts: Array.isArray(standardQuote.remainingAccounts) ? standardQuote.remainingAccounts.length : null,
      poolTickArrays: Array.isArray(poolShape.tickArrays) ? poolShape.tickArrays.length : null,
      poolRemainingAccounts: Array.isArray(poolShape.remainingAccounts) ? poolShape.remainingAccounts.length : null,
      selectedRemainingAccounts: remainingAccounts.length,
      swapAccounts: swapAccounts.length,
      maxPoolAccounts: Number(process.env.CLMM_MAX_POOL_REMAINING_ACCOUNTS || 4),
    }));
  }

  return [ClmmInstrument.swapV2Instruction(
    programId,
    wallet,
    poolId,
    state.configId,
    inputIsA ? userAta(wallet, state.mintA) : userAta(wallet, state.mintB),
    inputIsA ? userAta(wallet, state.mintB) : userAta(wallet, state.mintA),
    inputIsA ? state.vaultA : state.vaultB,
    inputIsA ? state.vaultB : state.vaultA,
    inputIsA ? state.mintA : state.mintB,
    inputIsA ? state.mintB : state.mintA,
    swapAccounts,
    state.observationId,
    new BN(String(standardQuote.inAmountRaw || '0')),
    new BN(String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0')),
    standardQuote.sqrtPriceLimitX64
      ? new BN(String(standardQuote.sqrtPriceLimitX64))
      : defaultSqrtPriceLimit(inputIsA),
    true,
  )];
}

module.exports = {
  isExecutable: true,
  buildSwapInstructions,
  buildClmmSwapTx,
  capAccounts,
};
