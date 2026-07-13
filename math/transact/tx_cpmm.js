'use strict';

const BN = require('bn.js');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout } = require('@solana/spl-token');
const { mergeCanonicalPool } = require('../poolContract');
const {
  CurveCalculator,
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  liquidityStateV4Layout,
  MARKET_STATE_LAYOUT_V3,
  getPdaPoolAuthority,
  makeSwapCpmmBaseInInstruction,
  makeAMMSwapInstruction,
  makeAMMSwapV2Instruction,
  getLiquidityAssociatedAuthority,
} = require('@raydium-io/raydium-sdk-v2');
const { readSerumOpenOrdersTotals } = require('../helpers/cpmm');

const raydiumSdk = require('@raydium-io/raydium-sdk-v2');
const RAYDIUM_CPMM_PROGRAM_ID = raydiumSdk.CREATE_CPMM_POOL_PROGRAM || new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const RAYDIUM_AMM_V4_PROGRAM_ID = raydiumSdk.AMM_V4 || new PublicKey('75kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_AMM_STABLE_PROGRAM_ID = raydiumSdk.AMM_STABLE || new PublicKey('5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h');

const RAYDIUM_CPMM_PROGRAM = RAYDIUM_CPMM_PROGRAM_ID.toBase58();
const RAYDIUM_AMM_V4_PROGRAM = RAYDIUM_AMM_V4_PROGRAM_ID.toBase58();
const RAYDIUM_AMM_STABLE_PROGRAM = RAYDIUM_AMM_STABLE_PROGRAM_ID.toBase58();

function ensureStandardQuote(standardQuote, dexType) {
  if (!standardQuote || !standardQuote.inAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.inAmountRaw`);
  }
  if (!standardQuote.minOutAmountRaw && !standardQuote.outAmountRaw) {
    throw new Error(`${dexType} buildSwapTx requires standardQuote.minOutAmountRaw or outAmountRaw`);
  }
}

function pubkey(value, label) {
  if (!value) throw new Error(`RAYDIUM_CPMM missing ${label}`);
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

function isTokenA(inputMint, poolMintA) {
  return pubkeyString(inputMint) === pubkeyString(poolMintA);
}

function userAta(wallet, mint) {
  return getAssociatedTokenAddressSync(pubkey(mint, 'mint'), wallet, true, TOKEN_PROGRAM_ID);
}

async function fetchRaydiumPoolKeys(poolId) {
  if (typeof fetch !== 'function') {
    throw new Error('RAYDIUM_AMM_STABLE requires fetch to load Raydium pool keys');
  }
  const id = pubkeyString(poolId);
  const url = `https://api-v3.raydium.io/pools/key/ids?ids=${encodeURIComponent(id)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`RAYDIUM_AMM_STABLE pool key fetch failed: ${response.status}`);
  }
  const payload = await response.json();
  const keys = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!keys) throw new Error(`RAYDIUM_AMM_STABLE pool keys not found: ${id}`);
  return keys;
}

async function fetchAccount(connection, address, label) {
  const key = pubkey(address, label);
  const account = await connection.getAccountInfo(key);
  if (!account) throw new Error(`RAYDIUM_CPMM ${label} account not found: ${key.toBase58()}`);
  return { key, account };
}

function subFloor(value, ...subs) {
  let out = value;
  for (const sub of subs) out = out.sub(sub || new BN(0));
  return out.lt(new BN(0)) ? new BN(0) : out;
}

function tokenAccountAmount(info) {
  if (!info?.data) return new BN(0);
  try {
    return new BN(info.data.readBigUInt64LE(64).toString());
  } catch (_error) {
    return new BN(0);
  }
}

function bnToBigInt(value) {
  if (!value) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value.toString === 'function') return BigInt(value.toString());
  return BigInt(String(value));
}

function bigIntToBN(value) {
  return new BN(String(value || 0n));
}

function effectiveAmmV4Reserve({ vaultAmount, openOrdersTotal = 0n, needTakePnl = 0n }) {
  const reserve = bnToBigInt(vaultAmount) + bnToBigInt(openOrdersTotal) - bnToBigInt(needTakePnl);
  return bigIntToBN(reserve > 0n ? reserve : 0n);
}

function ammV4FeeBps(state, poolShape = {}) {
  const numerator = bnToBigInt(state?.swapFeeNumerator ?? state?.tradeFeeNumerator ?? 0);
  const denominator = bnToBigInt(state?.swapFeeDenominator ?? state?.tradeFeeDenominator ?? 0);
  if (numerator > 0n && denominator > 0n) {
    return Number((numerator * 10000n) / denominator);
  }
  return Number(poolShape.feeBps ?? 25);
}

function quoteExactInFromReserves({ inAmount, reserveIn, reserveOut, feeBps, slippageBps }) {
  const amountIn = new BN(String(inAmount || '0'));
  const inReserve = new BN(String(reserveIn || '0'));
  const outReserve = new BN(String(reserveOut || '0'));
  if (amountIn.lte(new BN(0)) || inReserve.lte(new BN(0)) || outReserve.lte(new BN(0))) {
    return null;
  }

  const fee = new BN(Math.max(0, Math.min(10000, Math.trunc(Number(feeBps || 0)))));
  const amountAfterFee = amountIn.mul(new BN(10000).sub(fee)).div(new BN(10000));
  const denominator = inReserve.add(amountAfterFee);
  if (denominator.lte(new BN(0))) return null;
  const outAmount = amountAfterFee.mul(outReserve).div(denominator);
  const minOutAmount = outAmount.mul(new BN(10000).sub(new BN(Math.max(0, Math.min(10000, Math.trunc(Number(slippageBps || 0))))))).div(new BN(10000));
  return { outAmount, minOutAmount };
}

async function refreshNewCpmmBaseInQuote({ connection, state, inputIsA, outputMint, inAmount, slippageBps }) {
  const [configAccount, vaultAAccount, vaultBAccount] = await connection.getMultipleAccountsInfo([
    state.configId,
    state.vaultA,
    state.vaultB,
  ]);
  if (!configAccount || !vaultAAccount || !vaultBAccount) return null;

  const config = CpmmConfigInfoLayout.decode(configAccount.data);
  const vaultAAmount = tokenAccountAmount(vaultAAccount);
  const vaultBAmount = tokenAccountAmount(vaultBAccount);
  const reserveA = subFloor(vaultAAmount, state.protocolFeesMintA, state.fundFeesMintA, state.creatorFeesMintA);
  const reserveB = subFloor(vaultBAmount, state.protocolFeesMintB, state.fundFeesMintB, state.creatorFeesMintB);
  const inputReserve = inputIsA ? reserveA : reserveB;
  const outputReserve = inputIsA ? reserveB : reserveA;
  const outputIsB = pubkeyString(outputMint) === pubkeyString(state.mintB);
  const isCreatorFeeOnInput = Number(state.feeOn) === 0 || Number(state.feeOn) === 2;

  const swapResult = CurveCalculator.swapBaseInput(
    inAmount,
    inputReserve,
    outputReserve,
    config.tradeFeeRate,
    config.creatorFeeRate,
    config.protocolFeeRate,
    config.fundFeeRate,
    isCreatorFeeOnInput,
  );
  const bps = Math.max(0, Math.min(10000, Math.trunc(Number(slippageBps ?? 20) || 0)));
  const minOut = swapResult.outputAmount.mul(new BN(10000 - bps)).div(new BN(10000));
  return { outAmount: swapResult.outputAmount, minOutAmount: minOut, outputIsB };
}

async function quoteCpmmLiveExactIn({ connection, poolShape, inAmountAtomic, swapForY, slippageBps = 20 }) {
  if (!connection) throw new Error('CPMM live quote requires connection');
  const poolAddress = poolShape.poolAddress || poolShape.address || poolShape.id;
  if (!poolAddress) throw new Error('CPMM live quote requires poolAddress');

  const { key: poolId, account } = await fetchAccount(connection, poolAddress, 'pool');
  const inputIsA = Boolean(swapForY);
  const outputMint = inputIsA ? poolShape.tokenYMint || poolShape.quoteMint : poolShape.tokenXMint || poolShape.baseMint;
  let refreshed = null;

  const owner = account.owner.toBase58();

  if (owner === RAYDIUM_CPMM_PROGRAM) {
    const state = CpmmPoolInfoLayout.decode(account.data);
    refreshed = await refreshNewCpmmBaseInQuote({
      connection,
      state,
      inputIsA,
      outputMint,
      inAmount: new BN(String(inAmountAtomic || '0')),
      slippageBps,
    });
  } else if (owner === RAYDIUM_AMM_V4_PROGRAM || owner === RAYDIUM_AMM_STABLE_PROGRAM) {
    const state = liquidityStateV4Layout.decode(account.data);
    const [baseVault, quoteVault, openOrdersAccount] = await connection.getMultipleAccountsInfo([
      state.baseVault,
      state.quoteVault,
      state.openOrders,
    ]);
    if (!baseVault || !quoteVault || !openOrdersAccount) {
      throw new Error('AMM v4 live quote failed to fetch vault/openOrders accounts');
    }
    const openOrdersTotals = readSerumOpenOrdersTotals(openOrdersAccount.data);
    const reserveA = effectiveAmmV4Reserve({
      vaultAmount: tokenAccountAmount(baseVault),
      openOrdersTotal: openOrdersTotals.baseTokenTotal,
      needTakePnl: state.baseNeedTakePnl,
    });
    const reserveB = effectiveAmmV4Reserve({
      vaultAmount: tokenAccountAmount(quoteVault),
      openOrdersTotal: openOrdersTotals.quoteTokenTotal,
      needTakePnl: state.quoteNeedTakePnl,
    });
    refreshed = quoteExactInFromReserves({
      inAmount: inAmountAtomic,
      reserveIn: inputIsA ? reserveA : reserveB,
      reserveOut: inputIsA ? reserveB : reserveA,
      feeBps: ammV4FeeBps(state, poolShape),
      slippageBps,
    });
  } else {
    throw new Error(`Unsupported Raydium program for live CPMM quote: ${owner}`);
  }

  if (!refreshed || !refreshed.outAmount || refreshed.outAmount.lte(new BN(0))) {
    return {
      success: false,
      error: 'CPMM live quote returned zero output',
      quoteSource: 'rpc-live',
      dexType: 'RAYDIUM_CPMM',
      poolAddress: poolId.toBase58(),
      swapForY: Boolean(swapForY),
      inAmountRaw: String(inAmountAtomic || '0'),
      outAmountRaw: '0',
      minOutAmountRaw: '0',
    };
  }

  return {
    success: true,
    error: null,
    quoteSource: 'rpc-live',
    dexType: 'RAYDIUM_CPMM',
    poolAddress: poolId.toBase58(),
    swapForY: Boolean(swapForY),
    inputMint: inputIsA ? poolShape.tokenXMint || poolShape.baseMint || '' : poolShape.tokenYMint || poolShape.quoteMint || '',
    outputMint: outputMint || '',
    inAmountRaw: String(inAmountAtomic || '0'),
    outAmountRaw: refreshed.outAmount.toString(),
    minOutAmountRaw: refreshed.minOutAmount.toString(),
    feeBps: Number(poolShape.feeBps || 0),
  };
}

function buildCpmmSwapTx({ user, standardQuote, pool }) {
  const dexType = 'RAYDIUM_CPMM';
  ensureStandardQuote(standardQuote, dexType);
  const poolShape = mergeCanonicalPool(pool || {});
  const swapForY = Boolean(standardQuote.swapForY);

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
    vaults: standardQuote.vaults || poolShape.vaults || null,
    standardQuote,
  };
}

async function buildNewCpmmSwapInstructions({ connection, user, standardQuote, poolShape }) {
  const poolAddress = getPoolAddress(poolShape, standardQuote);
  const { key: poolId, account } = await fetchAccount(connection, poolAddress, 'pool');
  const programId = account.owner;
  const state = CpmmPoolInfoLayout.decode(account.data);
  const wallet = pubkey(user, 'user');
  const inputMint = pubkey(standardQuote.inputMint || standardQuote.tokenInMint, 'inputMint');
  const outputMint = pubkey(standardQuote.outputMint || standardQuote.tokenOutMint, 'outputMint');
  const inputIsA = isTokenA(inputMint, state.mintA);
  const outputIsA = isTokenA(outputMint, state.mintA);
  if (inputIsA === outputIsA) {
    throw new Error(`RAYDIUM_CPMM mint direction mismatch: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
  }

  const userInputAccount = userAta(wallet, inputMint);
  const userOutputAccount = userAta(wallet, outputMint);
  const inputVault = inputIsA ? state.vaultA : state.vaultB;
  const outputVault = inputIsA ? state.vaultB : state.vaultA;
  const inputTokenProgram = inputIsA ? state.mintProgramA : state.mintProgramB;
  const outputTokenProgram = inputIsA ? state.mintProgramB : state.mintProgramA;
  const { publicKey: authority } = getPdaPoolAuthority(programId);
  let minOutAmount = new BN(String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0'));
  if (process.env.CPMM_REFRESH_EXECUTION_QUOTE !== 'false') {
    const refreshed = await refreshNewCpmmBaseInQuote({
      connection,
      state,
      inputIsA,
      outputMint,
      inAmount: new BN(String(standardQuote.inAmountRaw || '0')),
      slippageBps: standardQuote.slippageBps,
    });
    if (refreshed?.minOutAmount?.gt?.(new BN(0))) minOutAmount = refreshed.minOutAmount;
  }

  return [makeSwapCpmmBaseInInstruction(
    programId,
    wallet,
    authority,
    state.configId,
    poolId,
    userInputAccount,
    userOutputAccount,
    inputVault,
    outputVault,
    inputTokenProgram || TOKEN_PROGRAM_ID,
    outputTokenProgram || TOKEN_PROGRAM_ID,
    inputMint,
    outputMint,
    state.observationId,
    new BN(String(standardQuote.inAmountRaw || '0')),
    minOutAmount,
  )];
}

async function buildAmmV4SwapInstructions({ connection, user, standardQuote, poolShape }) {
  const poolAddress = getPoolAddress(poolShape, standardQuote);
  const { key: poolId, account } = await fetchAccount(connection, poolAddress, 'AMM pool');
  const ownerProgramId = account.owner.toBase58();
  const version = pubkeyString(ownerProgramId) === RAYDIUM_AMM_STABLE_PROGRAM ? 5 : 4;
  const wallet = pubkey(user, 'user');
  const inputMint = pubkey(standardQuote.inputMint || standardQuote.tokenInMint, 'inputMint');
  const outputMint = pubkey(standardQuote.outputMint || standardQuote.tokenOutMint, 'outputMint');

  if (version === 5) {
    const poolKeys = await fetchRaydiumPoolKeys(poolId);
    const inputIsA = isTokenA(inputMint, poolKeys.mintA?.address);
    const outputIsA = isTokenA(outputMint, poolKeys.mintA?.address);
    if (inputIsA === outputIsA) {
      throw new Error(`RAYDIUM_AMM_STABLE mint direction mismatch: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
    }

    return [makeAMMSwapInstruction({
      version,
      poolKeys,
      userKeys: {
        tokenAccountIn: userAta(wallet, inputMint),
        tokenAccountOut: userAta(wallet, outputMint),
        owner: wallet,
      },
      amountIn: new BN(String(standardQuote.inAmountRaw || '0')),
      amountOut: new BN(String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0')),
      fixedSide: 'in',
    })];
  }

  const state = liquidityStateV4Layout.decode(account.data);
  const marketAccount = await connection.getAccountInfo(state.marketId);
  if (!marketAccount) throw new Error(`RAYDIUM_AMM market account not found: ${state.marketId.toBase58()}`);
  const market = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);
  const inputIsBase = isTokenA(inputMint, state.baseMint);
  const outputIsBase = isTokenA(outputMint, state.baseMint);
  if (inputIsBase === outputIsBase) {
    throw new Error(`RAYDIUM_AMM mint direction mismatch: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
  }

  const { publicKey: authority } = getLiquidityAssociatedAuthority({ programId: account.owner });
  const poolKeys = {
    id: poolId,
    version,
    programId: account.owner,
    authority,
    openOrders: state.openOrders,
    targetOrders: state.targetOrders,
    vault: { A: state.baseVault, B: state.quoteVault },
    marketProgramId: state.marketProgramId,
    marketId: state.marketId,
    marketBids: market.bids,
    marketAsks: market.asks,
    marketEventQueue: market.eventQueue,
    marketBaseVault: market.baseVault,
    marketQuoteVault: market.quoteVault,
    marketAuthority: PublicKey.createProgramAddressSync(
      [state.marketId.toBuffer(), market.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)],
      state.marketProgramId,
    ),
  };

  return [makeAMMSwapV2Instruction({
    version,
    poolKeys,
    userKeys: {
      tokenAccountIn: userAta(wallet, inputMint),
      tokenAccountOut: userAta(wallet, outputMint),
      owner: wallet,
    },
    amountIn: new BN(String(standardQuote.inAmountRaw || '0')),
    amountOut: new BN(String(standardQuote.minOutAmountRaw || standardQuote.outAmountRaw || '0')),
    fixedSide: 'in',
  })];
}

async function buildSwapInstructions({ connection, user, standardQuote, pool }) {
  if (!connection) throw new Error('RAYDIUM_CPMM buildSwapInstructions requires connection');
  ensureStandardQuote(standardQuote, 'RAYDIUM_CPMM');
  const poolShape = mergeCanonicalPool(pool || {});
  const poolAddress = getPoolAddress(poolShape, standardQuote);
  const { account } = await fetchAccount(connection, poolAddress, 'pool');
  const programId = account.owner.toBase58();
  if (programId === RAYDIUM_CPMM_PROGRAM) {
    return buildNewCpmmSwapInstructions({ connection, user, standardQuote, poolShape });
  }
  if (programId === RAYDIUM_AMM_V4_PROGRAM || programId === RAYDIUM_AMM_STABLE_PROGRAM) {
    return buildAmmV4SwapInstructions({ connection, user, standardQuote, poolShape });
  }
  throw new Error(`RAYDIUM_CPMM unsupported pool program: ${programId}`);
}

module.exports = {
  isExecutable: true,
  buildSwapInstructions,
  buildCpmmSwapTx,
  refreshNewCpmmBaseInQuote,
  quoteCpmmLiveExactIn,
};
