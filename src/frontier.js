const { asBigInt, bpsBetween } = require("./amount.js");
const {
  bestProjectionToTarget,
  canCloseToTarget,
  isEdgeUsable,
  quoteEdge
} = require("./projection.js");

async function buildNextHopCandidates({
  graph,
  currentMint,
  currentAmountAtomic,
  startingTargetValueAtomic,
  targetMint,
  legIndex,
  maxHops,
  minProfitBps = 3,
  safetyBufferBps = 1.5,
  slippageBufferBps = 0,
  priorityFeeBps = 0,
  staleStateBufferBps = 0,
  allowedTokens,
  currentSlot,
  maxPoolSlotLag = 2,
  maxPoolAgeMs = 2_000,
  now = Date.now(),
  maxCandidates = 20
}) {
  if (!graph) throw new TypeError("graph is required");
  if (!currentMint || !targetMint) throw new TypeError("currentMint and targetMint are required");
  if (!Number.isInteger(legIndex) || legIndex < 0) {
    throw new RangeError("legIndex must be a non-negative integer");
  }
  if (!Number.isInteger(maxHops) || maxHops < 1) {
    throw new RangeError("maxHops must be a positive integer");
  }

  const inputAmount = asBigInt(currentAmountAtomic, "currentAmountAtomic");
  const startingValue = asBigInt(startingTargetValueAtomic, "startingTargetValueAtomic");
  const remainingAfterCandidate = maxHops - (legIndex + 1);
  if (remainingAfterCandidate < 0) return [];

  const commonUsability = (edge, amount = inputAmount) =>
    isEdgeUsable(edge, {
      allowedTokens,
      currentSlot,
      maxPoolSlotLag,
      now,
      maxPoolAgeMs,
      amountAtomic: amount
    });

  const candidates = [];

  for (const edge of graph.outgoing(currentMint)) {
    if (edge.tokenInMint !== currentMint) continue;
    if (!commonUsability(edge, inputAmount)) continue;

    const closureOk =
      edge.tokenOutMint === targetMint ||
      canCloseToTarget({
        graph,
        fromMint: edge.tokenOutMint,
        targetMint,
        remainingHops: remainingAfterCandidate,
        allowedTokens,
        edgeFilter: (suffixEdge) => commonUsability(suffixEdge)
      });

    if (!closureOk) continue;

    let firstQuote;
    try {
      firstQuote = await quoteEdge(edge, inputAmount);
    } catch {
      continue;
    }

    let projection;
    if (edge.tokenOutMint === targetMint) {
      projection = {
        finalAmountAtomic: firstQuote.outputAmountAtomic,
        path: []
      };
    } else {
      projection = await bestProjectionToTarget({
        graph,
        fromMint: edge.tokenOutMint,
        targetMint,
        amountAtomic: firstQuote.outputAmountAtomic,
        maxHops: remainingAfterCandidate,
        allowedTokens,
        excludedPools: new Set([edge.poolAddress]),
        edgeFilter: (suffixEdge, amount) => commonUsability(suffixEdge, amount)
      });
    }

    if (!projection) continue;

    const grossProjectedBps = bpsBetween(projection.finalAmountAtomic, startingValue);
    const projectedNetBps =
      grossProjectedBps -
      slippageBufferBps -
      priorityFeeBps -
      staleStateBufferBps;
    const requiredBps = minProfitBps + safetyBufferBps;

    if (projectedNetBps < requiredBps) continue;

    candidates.push({
      inputMint: currentMint,
      outputMint: edge.tokenOutMint,
      poolAddress: edge.poolAddress,
      dexType: edge.dexType,
      mathType: edge.mathType,
      inputAmountAtomic: inputAmount,
      estimatedOutputAtomic: firstQuote.outputAmountAtomic,
      projectedFinalTargetAtomic: projection.finalAmountAtomic,
      grossProjectedBps,
      projectedNetBps,
      minProfitBps,
      safetyBufferBps,
      slot: edge.lastUpdatedSlot,
      poolStateVersion: edge.stateVersion,
      suffixPath: projection.path.map(({ edge: suffixEdge }) => ({
        poolAddress: suffixEdge.poolAddress,
        inputMint: suffixEdge.tokenInMint,
        outputMint: suffixEdge.tokenOutMint
      })),
      reason: {
        depthOk: true,
        closureOk: true,
        feeBps: Number(edge.feeBps ?? 0),
        staleFlags: [...(edge.staleFlags ?? [])]
      }
    });
  }

  return candidates
    .sort((a, b) => {
      if (b.projectedNetBps !== a.projectedNetBps) {
        return b.projectedNetBps - a.projectedNetBps;
      }
      const aEdge = graph.getEdge(a.poolAddress, a.inputMint, a.outputMint);
      const bEdge = graph.getEdge(b.poolAddress, b.inputMint, b.outputMint);
      const liquidityDelta = Number(bEdge?.liquidity ?? 0) - Number(aEdge?.liquidity ?? 0);
      if (liquidityDelta !== 0) return liquidityDelta;
      return Number(aEdge?.feeBps ?? 0) - Number(bEdge?.feeBps ?? 0);
    })
    .slice(0, maxCandidates);
}
module.exports = {
  buildNextHopCandidates
};