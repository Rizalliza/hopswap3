const { buildNextHopCandidates } = require("./frontier.js");
const { createSignal } = require("./signal.js");
const { NullEventStore } = require("./persistence.js")
const { SilentLogger } = require("./logger.js");

class StatefulFrontierScanner {
  constructor({
    graph,
    queue,
    config = {},
    signalStore = new NullEventStore(),
    logger = new SilentLogger()
  }) {
    this.graph = graph;
    this.queue = queue;
    this.signalStore = signalStore;
    this.logger = logger;
    this.config = {
      minProfitBps: 3,
      safetyBufferBps: 1.5,
      slippageBufferBps: 0,
      priorityFeeBps: 0,
      staleStateBufferBps: 0,
      maxSignalAgeMs: 750,
      maxPoolSlotLag: 2,
      maxPoolAgeMs: 2_000,
      maxCandidates: 20,
      ...config
    };
  }

  async scan(engineState, { currentSlot, now = Date.now() } = {}) {
    if (!engineState?.cycleId) return [];

    const candidates = await buildNextHopCandidates({
      graph: this.graph,
      currentMint: engineState.currentMint,
      currentAmountAtomic: engineState.currentAmountAtomic,
      startingTargetValueAtomic: engineState.startingValueAtomic,
      targetMint: engineState.targetMint,
      legIndex: engineState.legIndex,
      maxHops: engineState.maxHops,
      allowedTokens: this.config.allowedTokens,
      currentSlot,
      now,
      minProfitBps: this.config.minProfitBps,
      safetyBufferBps: this.config.safetyBufferBps,
      slippageBufferBps: this.config.slippageBufferBps,
      priorityFeeBps: this.config.priorityFeeBps,
      staleStateBufferBps: this.config.staleStateBufferBps,
      maxPoolSlotLag: this.config.maxPoolSlotLag,
      maxPoolAgeMs: this.config.maxPoolAgeMs,
      maxCandidates: this.config.maxCandidates
    });

    this.logger.log("scanner_decision", {
      cycleId: engineState.cycleId,
      legIndex: engineState.legIndex,
      currentMint: engineState.currentMint,
      candidateCount: candidates.length
    });

    const emitted = [];
    for (const candidate of candidates) {
      const signal = createSignal({
        candidate,
        cycleId: engineState.cycleId,
        legIndex: engineState.legIndex,
        maxHops: engineState.maxHops,
        maxSignalAgeMs: this.config.maxSignalAgeMs,
        now
      });
      const result = this.queue.push(signal, now);
      await this.signalStore.append({
        type: result.accepted ? "scanner_signal_pushed" : "scanner_signal_rejected",
        signal,
        queueResult: result,
        timestamp: new Date(now).toISOString()
      });
      this.logger.log(
        result.accepted ? "scanner_signal_pushed" : "scanner_signal_rejected",
        {
          signalId: signal.signalId,
          cycleId: signal.cycleId,
          legIndex: signal.legIndex,
          inputMint: signal.inputMint,
          outputMint: signal.outputMint,
          poolAddress: signal.poolAddress,
          projectedNetBps: signal.projectedNetBps,
          queueReason: result.reason
        }
      );
      if (result.accepted) emitted.push(signal);
    }

    return emitted;
  }
}
module.exports = StatefulFrontierScanner;