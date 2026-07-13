'use strict';

const { mergeCanonicalPool } = require('../../math/poolContract');
const BN = require('bn.js');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { ReadOnlyWallet } = require('@orca-so/common-sdk');
const {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  SwapUtils,
  WhirlpoolContext,
  WhirlpoolIx,
  buildDefaultAccountFetcher,
} = require('@orca-so/whirlpools-sdk');

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

function ensureStandardQuote(standardQuote, dexType) {
  if (!standardQuote || !standardQuote.inAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.inAmountRaw`);
  }
  if (!standardQuote.minOutAmountRaw && !standardQuote.outAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.minOutAmountRaw or outAmountRaw`);
  }
}

function buildWhirlpoolSwapTx({ user, standardQuote, pool }) {
  const dexType = 'ORCA_WHIRLPOOL';
  ensureStandardQuote(standardQuote, dexType);
  const poolShape = mergeCanonicalPool(pool || {});
  const swapForY = Boolean(standardQuote.swapForY);
  const tickArrays = normalizeStringArray(standardQuote.tickArrays || poolShape.tickArrays || []);
  const remainingAccounts = normalizeStringArray(
    standardQuote.remainingAccounts || poolShape.remainingAccounts || tickArrays
  );

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
  if (!connection) throw new Error('ORCA_WHIRLPOOL buildSwapInstructions requires connection');
  const poolShape = mergeCanonicalPool(pool || {});
  const whirlpool = new PublicKey(poolShape.poolAddress || standardQuote.poolAddress);
  const wallet = new PublicKey(String(user));

  // Detect the actual deployed Whirlpool program from the pool account owner.
  // Orca has deployed pools across multiple program addresses (e.g. the newer
  // whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc).  Using the wrong program ID
  // produces incorrect tick-array PDAs and oracle PDAs, causing AmountRemainingOverflow.
  const poolAccountInfo = await connection.getAccountInfo(whirlpool);
  if (!poolAccountInfo) throw new Error(`ORCA_WHIRLPOOL pool not found on-chain: ${whirlpool.toBase58()}`);
  const actualProgramId = poolAccountInfo.owner;

  const fetcher = buildDefaultAccountFetcher(connection);
  const ctx = WhirlpoolContext.from(connection, new ReadOnlyWallet(wallet), fetcher);
  const whirlpoolData = await ctx.fetcher.getPool(whirlpool);
  if (!whirlpoolData) throw new Error(`ORCA_WHIRLPOOL pool not found: ${whirlpool.toBase58()}`);

  const inputMint = new PublicKey(standardQuote.inputMint || standardQuote.tokenInMint);
  const outputMint = new PublicKey(standardQuote.outputMint || standardQuote.tokenOutMint);
  const aToB = inputMint.equals(whirlpoolData.tokenMintA) && outputMint.equals(whirlpoolData.tokenMintB);
  const bToA = inputMint.equals(whirlpoolData.tokenMintB) && outputMint.equals(whirlpoolData.tokenMintA);
  if (!aToB && !bToA) {
    throw new Error(`ORCA_WHIRLPOOL mint direction mismatch: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
  }

  const tickArrays = SwapUtils.getTickArrayPublicKeys(
    whirlpoolData.tickCurrentIndex,
    whirlpoolData.tickSpacing,
    aToB,
    actualProgramId,
    whirlpool,
  );
  const tokenOwnerAccountA = getAssociatedTokenAddressSync(whirlpoolData.tokenMintA, wallet, true, TOKEN_PROGRAM_ID);
  const tokenOwnerAccountB = getAssociatedTokenAddressSync(whirlpoolData.tokenMintB, wallet, true, TOKEN_PROGRAM_ID);
  const oracle = PDAUtil.getOracle(actualProgramId, whirlpool).publicKey;

  const ix = WhirlpoolIx.swapIx(ctx.program, {
    amount: new BN(String(standardQuote.inAmountRaw || '0')),
    otherAmountThreshold: new BN(String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0')),
    sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
    amountSpecifiedIsInput: true,
    aToB,
    whirlpool,
    tokenOwnerAccountA,
    tokenOwnerAccountB,
    tokenVaultA: whirlpoolData.tokenVaultA,
    tokenVaultB: whirlpoolData.tokenVaultB,
    tokenAuthority: wallet,
    tickArray0: tickArrays[0],
    tickArray1: tickArrays[1],
    tickArray2: tickArrays[2],
    oracle,
  });

  const instructions = ix.instructions || [];
  if (!actualProgramId.equals(ctx.program.programId)) {
    for (const inst of instructions) {
      inst.programId = actualProgramId;
    }
  }

  return instructions;
}

module.exports = {
  isExecutable: true,
  buildSwapInstructions,
  buildWhirlpoolSwapTx,
};
