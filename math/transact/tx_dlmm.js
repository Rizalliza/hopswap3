'use strict';
/**
 * tx_dlmm.js  (FLASHLOAN-COMPATIBLE)
 *
 * Builds Meteora DLMM swap2 instructions WITHOUT internal simulation.
 *
 * Uses the Anchor program client from DLMM.create() to build the instruction,
 * which means the IDL-correct account layout is always used. The simulation
 * (getEstimatedComputeUnitIxWithBuffer) is intentionally NOT called — it fails
 * in flashloan pipelines where tokens are not present until borrow executes.
 */

const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const BN = require('bn.js');

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function toBinArrayPubkey(a) {
  if (!a) return null;
  if (a instanceof PublicKey) return a;
  if (typeof a === 'string') return new PublicKey(a);
  const pk = a.publicKey || a.key;
  if (pk instanceof PublicKey) return pk;
  if (pk) return new PublicKey(String(pk));
  return null;
}

/**
 * Build DLMM swap instructions for flashloan execution.
 *
 * Uses DLMM.create() to fetch pool state (reserve addresses, oracle, token programs),
 * then calls program.methods.swap2(...).instruction() via the Anchor client.
 * No simulation is triggered — safe for flashloan contexts.
 *
 * @param {Object} params
 * @param {Connection} params.connection
 * @param {string} params.user          - User public key (base58)
 * @param {Object} params.standardQuote - Normalized quote from tradeExecute.js
 * @param {Object} params.pool          - Enriched pool context
 */
async function buildSwapInstructions({ connection, user, standardQuote, pool }) {
  const DLMM = require('@meteora-ag/dlmm');

  const lbPair = new PublicKey(pool.poolAddress || standardQuote.poolAddress);
  const userPubkey = new PublicKey(user);
  const inAmount = new BN(String(standardQuote.inAmountRaw || '0'));
  const minOutAmount = new BN(String(standardQuote.minOutAmountRaw || '0'));

  // Load pool state: fetches lb_pair account, binArrayBitmapExtension, clock.
  // No simulation involved — safe in flashloan context.
  const dlmmPool = await DLMM.create(connection, lbPair);

  // Derive user token accounts (ATAs). Direction: swapForY=true → X→Y (tokenXMint is input).
  const inputMint = new PublicKey(standardQuote.inputMint || standardQuote.tokenInMint);
  const outputMint = new PublicKey(standardQuote.outputMint || standardQuote.tokenOutMint);
  const swapForY = inputMint.equals(dlmmPool.lbPair.tokenXMint)
    ? true
    : inputMint.equals(dlmmPool.lbPair.tokenYMint)
      ? false
      : Boolean(standardQuote.swapForY);

  const inTokenProgram = inputMint.equals(dlmmPool.lbPair.tokenXMint)
    ? dlmmPool.tokenX.owner
    : dlmmPool.tokenY.owner;
  const outTokenProgram = outputMint.equals(dlmmPool.lbPair.tokenXMint)
    ? dlmmPool.tokenX.owner
    : dlmmPool.tokenY.owner;

  const userTokenIn = getAssociatedTokenAddressSync(inputMint, userPubkey, false, inTokenProgram);
  const userTokenOut = getAssociatedTokenAddressSync(outputMint, userPubkey, false, outTokenProgram);

  // Resolve bin arrays — prefer pre-fetched from presignRequoteGate/pool data.
  let binArrayPubkeys = (standardQuote.binArrays || pool.binArrays || [])
    .map(toBinArrayPubkey)
    .filter(Boolean);

  if (binArrayPubkeys.length === 0) {
    const fetched = await dlmmPool.getBinArrayForSwap(swapForY, 4);
    binArrayPubkeys = (fetched || []).map(toBinArrayPubkey).filter(Boolean);
  }

  if (binArrayPubkeys.length === 0) {
    throw new Error('DLMM swap2 requires binArrays — none available from quote or live fetch');
  }

  const binArrayRemainingAccounts = binArrayPubkeys.map((pk) => ({
    isSigner: false,
    isWritable: true,
    pubkey: pk,
  }));

  // Build instruction via Anchor program client.
  // swap2 args: (amount_in: u64, min_amount_out: u64, remaining_accounts_info: RemainingAccountsInfo)
  // For standard SPL tokens (no Token-2022 transfer hooks), slices is empty.
  const swapIx = await dlmmPool.program.methods
    .swap2(inAmount, minOutAmount, { slices: [] })
    .accountsPartial({
      lbPair,
      reserveX: dlmmPool.lbPair.reserveX,
      reserveY: dlmmPool.lbPair.reserveY,
      tokenXMint: dlmmPool.lbPair.tokenXMint,
      tokenYMint: dlmmPool.lbPair.tokenYMint,
      tokenXProgram: dlmmPool.tokenX.owner,
      tokenYProgram: dlmmPool.tokenY.owner,
      user: userPubkey,
      userTokenIn,
      userTokenOut,
      binArrayBitmapExtension: dlmmPool.binArrayBitmapExtension?.publicKey ?? null,
      oracle: dlmmPool.lbPair.oracle,
      hostFeeIn: null,
      memoProgram: MEMO_PROGRAM_ID,
    })
    .remainingAccounts(binArrayRemainingAccounts)
    .instruction();

  return [swapIx];
}

module.exports = {
  buildSwapInstructions,
};
