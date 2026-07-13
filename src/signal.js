const { randomUUID } = require("node:crypto");

function createSignal({
  candidate,
  cycleId,
  legIndex,
  maxHops,
  maxSignalAgeMs = 750,
  now = Date.now()
}) {
  if (!candidate) throw new TypeError("candidate is required");
  return {
    signalId: `sig_${randomUUID()}`,
    cycleId,
    legIndex,
    maxHops,
    inputMint: candidate.inputMint,
    outputMint: candidate.outputMint,
    poolAddress: candidate.poolAddress,
    dexType: candidate.dexType,
    mathType: candidate.mathType,
    inputAmountAtomic: candidate.inputAmountAtomic,
    estimatedOutputAtomic: candidate.estimatedOutputAtomic,
    projectedFinalTargetAtomic: candidate.projectedFinalTargetAtomic,
    projectedNetBps: candidate.projectedNetBps,
    minProfitBps: candidate.minProfitBps,
    safetyBufferBps: candidate.safetyBufferBps,
    slot: candidate.slot,
    poolStateVersion: candidate.poolStateVersion,
    expiresAt: new Date(now + maxSignalAgeMs).toISOString(),
    createdAt: new Date(now).toISOString(),
    reason: candidate.reason,
    suffixPath: candidate.suffixPath
  };
}
function signalDedupKey(signal, slotBucketSize = 2) {
  const bucket = Math.floor(Number(signal.slot) / slotBucketSize);
  return [
    signal.cycleId,
    signal.legIndex,
    signal.inputMint,
    signal.outputMint,
    signal.poolAddress,
    bucket
  ].join(":");
}
module.exports = {
  signalDedupKey,
  createSignal

}