const { randomUUID } = require("node:crypto");
const { asBigInt, bpsBetween, subtractBps } = require("./amount.js");
const { NullEventStore, NullStateStore } = require("./persistence.js");
const { SilentLogger } = require("./logger.js");
require(dotenv).config();


const EngineStatus = Object.freeze({
  IDLE_SOL: "IDLE_SOL",
  WAITING_FOR_SIGNAL: "WAITING_FOR_SIGNAL",
  VALIDATING_SIGNAL: "VALIDATING_SIGNAL",
  EXECUTING_SWAP: "EXECUTING_SWAP",
  CONFIRMING: "CONFIRMING",
  ADVANCE_LEG: "ADVANCE_LEG",
  COMPLETE_CYCLE: "COMPLETE_CYCLE",
  UNWINDING: "UNWINDING",
  ERROR_RECOVERY: "ERROR_RECOVERY"
});

class SignalRejectedError extends Error {
  constructor(reason, details = {}) {
    super(`signal rejected: ${reason}`);
    this.name = "SignalRejectedError";
    this.reason = reason;
    this.details = details;
  }
}
function loadWallet() {
  if (!envHelper || typeof envHelper.loadKeypair !== 'function') {
    throw new Error('wallet helper unavailable; cannot start live mode');
  }
  const wallet = envHelper.loadKeypair();
  console.info('[index] wallet loaded', { publicKey: wallet.publicKey.toBase58() });
  return wallet;
}

class SwapEngine {
  constructor({
    graph,
    wallet,
    executor,
    poolStateProvider,
    balanceProvider,
    stateStore = new NullStateStore(),
    eventStore = new NullEventStore(),
    logger = new SilentLogger(),
    config
  }) {
    if (!graph) throw new TypeError("graph is required");
    if (!executor) throw new TypeError("executor is required");
    if (!config?.startMint || !config?.targetMint) {
      throw new TypeError("config.startMint and config.targetMint are required");
    }

    this.graph = graph;
    this.executor = executor;
    this.wallet = wallet;
    this.poolStateProvider = poolStateProvider;
    this.balanceProvider = balanceProvider;
    this.stateStore = stateStore;
    this.eventStore = eventStore;
    this.logger = logger;
    this.config = {
      maxHops: 4,
      minProfitBps: 3,
      safetyBufferBps: 1.5,
      slippageBufferBps: 0,
      priorityFeeBps: 0,
      staleStateBufferBps: 0,
      maxSignalAgeMs: 750,
      maxPoolSlotLag: 2,
      maxPoolAgeMs: 2_000,
      maxQuoteDriftBps: 5,
      maxSingleSwapSlippageBps: 10,
      maxIntermediateHoldMs: 30_000,
      maxUnwindHops: 4,
      maxUnwindSlippageBps: 30,
      requirePostTradeBalanceCheck: true,
      allowedTokens: new Set([config.startMint, config.targetMint]),
      ...config
    };

    this.state = {
      status: EngineStatus.IDLE_SOL,
      cycleId: null,
      currentMint: this.config.startMint,
      currentAmountAtomic: 0n,
      startMint: this.config.startMint,
      targetMint: this.config.targetMint,
      legIndex: 0,
      maxHops: this.config.maxHops,
      startedAt: null,
      intermediateSince: null,
      lastExecutedPool: null,
      startingValueAtomic: 0n,
      projectedPnlBps: 0,
      realizedPnlBps: null,
      networkFeesTargetAtomic: 0n,
      completedCycles: 0,
      lastCompletedCycle: null
    };
    const payer = this.wallet.publicKey;
    const ixs = [];
    const signers = [this.wallet];
    const preSwapATAs = [];
  }


  async startCycle({
    amountAtomic,
    cycleId = `cycle_${randomUUID()}`,
    now = Date.now()
  }) {
    if (this.state.status !== EngineStatus.IDLE_SOL) {
      throw new Error(`cannot start cycle from status ${this.state.status}`);
    }

    const amount = asBigInt(amountAtomic, "amountAtomic");
    if (amount <= 0n) throw new RangeError("amountAtomic must be positive");

    this.state = {
      ...this.state,
      status: EngineStatus.WAITING_FOR_SIGNAL,
      cycleId,
      currentMint: this.config.startMint,
      currentAmountAtomic: amount,
      startMint: this.config.startMint,
      targetMint: this.config.targetMint,
      legIndex: 0,
      maxHops: this.config.maxHops,
      startedAt: new Date(now).toISOString(),
      intermediateSince: null,
      lastExecutedPool: null,
      startingValueAtomic: amount,
      projectedPnlBps: 0,
      realizedPnlBps: null,
      networkFeesTargetAtomic: 0n
    };
    await this.#persist("cycle_started", { cycleId, amountAtomic: amount });
    return this.snapshot();
  }

  async processSignal(signal, { currentSlot, now = Date.now() } = {}) {
    try {
      this.state.status = EngineStatus.VALIDATING_SIGNAL;
      await this.#persist("signal_validation_started", {
        signalId: signal?.signalId,
        cycleId: this.state.cycleId
      });

      const validated = await this.validateSignal(signal, { currentSlot, now });
      this.state.status = EngineStatus.EXECUTING_SWAP;
      await this.#persist("swap_execution_started", {
        signalId: signal.signalId,
        poolAddress: signal.poolAddress
      });

      const minimumOutput = subtractBps(
        validated.quote.outputAmountAtomic,
        this.config.maxSingleSwapSlippageBps
      );
      const preOutputBalance =
        typeof this.balanceProvider?.getBalance === "function"
          ? asBigInt(
            await this.balanceProvider.getBalance(signal.outputMint),
            "pre-trade output balance"
          )
          : null;

      const result = await this.executor.execute({
        signal,
        edge: validated.edge,
        inputAmountAtomic: this.state.currentAmountAtomic,
        minOutputAtomic: minimumOutput
      });

      this.state.status = EngineStatus.CONFIRMING;
      const confirmed =
        typeof this.executor.confirm === "function"
          ? await this.executor.confirm(result)
          : result.confirmed !== false;
      if (!confirmed) throw new Error("swap was not confirmed");

      if (!result.dryRun && this.config.requirePostTradeBalanceCheck) {
        if (preOutputBalance === null || typeof this.balanceProvider?.getBalance !== "function") {
          throw new Error("post-trade balance verification is required but unavailable");
        }
        const postOutputBalance = asBigInt(
          await this.balanceProvider.getBalance(signal.outputMint),
          "post-trade output balance"
        );
        const observedOutput = postOutputBalance - preOutputBalance;
        if (observedOutput <= 0n) {
          throw new Error("post-trade balance check found no positive output delta");
        }
        if (observedOutput < minimumOutput) {
          throw new Error("post-trade output balance fell below minOutputAtomic");
        }
        result.actualOutputAtomic = observedOutput;
      }

      await this.#advanceAfterSwap({
        signal,
        result,
        now,
        projectedNetBps: validated.candidate.projectedNetBps
      });

      return { accepted: true, result, state: this.snapshot() };
    } catch (error) {
      if (error instanceof SignalRejectedError) {
        this.state.status = EngineStatus.WAITING_FOR_SIGNAL;
        await this.#persist("signal_rejected", {
          signalId: signal?.signalId,
          reason: error.reason,
          details: error.details
        });
        return {
          accepted: false,
          reason: error.reason,
          details: error.details,
          state: this.snapshot()
        };
      }

      this.state.status = EngineStatus.ERROR_RECOVERY;
      await this.#persist("swap_execution_failed", {
        signalId: signal?.signalId,
        error: error?.message ?? String(error)
      });
      return {
        accepted: false,
        reason: "execution_failed",
        error,
        state: this.snapshot()
      };
    }
  }

  async validateSignal(signal, { currentSlot, now = Date.now() } = {}) {
    const reject = (reason, details) => {
      throw new SignalRejectedError(reason, details);
    };

    if (!signal) reject("missing_signal");
    if (this.state.status !== EngineStatus.VALIDATING_SIGNAL) {
      reject("engine_not_validating", { status: this.state.status });
    }
    if (signal.cycleId !== this.state.cycleId) reject("cycle_mismatch");
    if (signal.legIndex !== this.state.legIndex) reject("leg_mismatch");
    if (signal.inputMint !== this.state.currentMint) reject("input_mint_mismatch");
    if (asBigInt(signal.inputAmountAtomic) !== this.state.currentAmountAtomic) {
      reject("input_amount_mismatch");
    }

    const expiry = Date.parse(signal.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) reject("signal_expired");

    let edge = this.graph.getEdge(
      signal.poolAddress,
      signal.inputMint,
      signal.outputMint
    );
    if (!edge) reject("pool_edge_not_found");

    if (typeof this.poolStateProvider?.refreshEdge === "function") {
      const refreshed = await this.poolStateProvider.refreshEdge(edge);
      if (refreshed) {
        edge = this.graph.replaceEdge(refreshed);
      }
    }

    if (edge.stateVersion !== signal.poolStateVersion) {
      reject("pool_state_version_changed", {
        signalVersion: signal.poolStateVersion,
        currentVersion: edge.stateVersion
      });
    }

    const effectiveCurrentSlot =
      currentSlot ??
      (typeof this.poolStateProvider?.getCurrentSlot === "function"
        ? await this.poolStateProvider.getCurrentSlot()
        : edge.lastUpdatedSlot);

    if (
      !isEdgeUsable(edge, {
        allowedTokens: this.config.allowedTokens,
        currentSlot: effectiveCurrentSlot,
        maxPoolSlotLag: this.config.maxPoolSlotLag,
        now,
        maxPoolAgeMs: this.config.maxPoolAgeMs,
        amountAtomic: this.state.currentAmountAtomic
      })
    ) {
      reject("pool_not_executable_or_fresh");
    }

    if (typeof this.balanceProvider?.getBalance === "function") {
      const balance = asBigInt(
        await this.balanceProvider.getBalance(this.state.currentMint),
        "wallet balance"
      );
      if (balance < this.state.currentAmountAtomic) {
        reject("insufficient_wallet_balance", {
          required: this.state.currentAmountAtomic.toString(),
          balance: balance.toString()
        });
      }
    }

    const quote = await quoteEdge(edge, this.state.currentAmountAtomic);
    const minimumSignalOutput = subtractBps(
      asBigInt(signal.estimatedOutputAtomic),
      this.config.maxQuoteDriftBps
    );
    if (quote.outputAmountAtomic < minimumSignalOutput) {
      reject("quote_drift_exceeded", {
        quoted: quote.outputAmountAtomic.toString(),
        minimum: minimumSignalOutput.toString()
      });
    }

    const freshCandidates = await buildNextHopCandidates({
      graph: this.graph,
      currentMint: this.state.currentMint,
      currentAmountAtomic: this.state.currentAmountAtomic,
      startingTargetValueAtomic: this.state.startingValueAtomic,
      targetMint: this.state.targetMint,
      legIndex: this.state.legIndex,
      maxHops: this.state.maxHops,
      minProfitBps: this.config.minProfitBps,
      safetyBufferBps: this.config.safetyBufferBps,
      slippageBufferBps: this.config.slippageBufferBps,
      priorityFeeBps: this.config.priorityFeeBps,
      staleStateBufferBps: this.config.staleStateBufferBps,
      allowedTokens: this.config.allowedTokens,
      currentSlot: effectiveCurrentSlot,
      maxPoolSlotLag: this.config.maxPoolSlotLag,
      maxPoolAgeMs: this.config.maxPoolAgeMs,
      now
    });

    const candidate = freshCandidates.find(
      (item) =>
        item.poolAddress === signal.poolAddress &&
        item.inputMint === signal.inputMint &&
        item.outputMint === signal.outputMint
    );
    if (!candidate) reject("no_longer_profitable_or_closable");

    return { edge, quote, candidate };
  }

  async tick({ currentSlot, now = Date.now() } = {}) {
    if (
      this.state.status === EngineStatus.WAITING_FOR_SIGNAL &&
      this.state.currentMint !== this.state.targetMint &&
      this.state.intermediateSince
    ) {
      const heldForMs = now - Date.parse(this.state.intermediateSince);
      if (heldForMs >= this.config.maxIntermediateHoldMs) {
        return this.unwind({ currentSlot, now, reason: "intermediate_hold_timeout" });
      }
    }
    return { action: "none", state: this.snapshot() };
  }

  async unwind({
    currentSlot,
    now = Date.now(),
    reason = "manual_unwind"
  } = {}) {
    if (this.state.currentMint === this.state.targetMint) {
      await this.#completeCycle(now, { unwound: true, reason });
      return { action: "already_at_target", state: this.snapshot() };
    }

    this.state.status = EngineStatus.UNWINDING;
    await this.#persist("unwind_started", { reason });

    let remainingHops = this.config.maxUnwindHops;
    while (this.state.currentMint !== this.state.targetMint && remainingHops > 0) {
      const effectiveSlot =
        currentSlot ??
        (typeof this.poolStateProvider?.getCurrentSlot === "function"
          ? await this.poolStateProvider.getCurrentSlot()
          : undefined);

      const edgeFilter = (edge, amount) =>
        isEdgeUsable(edge, {
          allowedTokens: this.config.allowedTokens,
          currentSlot: effectiveSlot,
          maxPoolSlotLag: this.config.maxPoolSlotLag,
          now,
          maxPoolAgeMs: this.config.maxPoolAgeMs,
          amountAtomic: amount
        });

      const projection = await bestProjectionToTarget({
        graph: this.graph,
        fromMint: this.state.currentMint,
        targetMint: this.state.targetMint,
        amountAtomic: this.state.currentAmountAtomic,
        maxHops: remainingHops,
        allowedTokens: this.config.allowedTokens,
        edgeFilter
      });

      if (!projection || projection.path.length === 0) {
        this.state.status = EngineStatus.ERROR_RECOVERY;
        await this.#persist("unwind_failed", { reason: "no_safe_path_to_target" });
        return {
          action: "unwind_failed",
          reason: "no_safe_path_to_target",
          state: this.snapshot()
        };
      }

      let edge = projection.path[0].edge;
      if (typeof this.poolStateProvider?.refreshEdge === "function") {
        const refreshed = await this.poolStateProvider.refreshEdge(edge);
        if (refreshed) edge = this.graph.replaceEdge(refreshed);
      }
      if (!edgeFilter(edge, this.state.currentAmountAtomic)) {
        remainingHops -= 1;
        continue;
      }

      const quote = await quoteEdge(edge, this.state.currentAmountAtomic);
      const minimumOutput = subtractBps(
        quote.outputAmountAtomic,
        this.config.maxUnwindSlippageBps
      );
      const result = await this.executor.execute({
        signal: null,
        edge,
        inputAmountAtomic: this.state.currentAmountAtomic,
        minOutputAtomic: minimumOutput,
        unwind: true
      });
      const confirmed =
        typeof this.executor.confirm === "function"
          ? await this.executor.confirm(result)
          : result.confirmed !== false;
      if (!confirmed) {
        this.state.status = EngineStatus.ERROR_RECOVERY;
        await this.#persist("unwind_failed", { reason: "unwind_swap_unconfirmed" });
        return {
          action: "unwind_failed",
          reason: "unwind_swap_unconfirmed",
          state: this.snapshot()
        };
      }

      this.state.currentMint = edge.tokenOutMint;
      this.state.currentAmountAtomic = asBigInt(result.actualOutputAtomic);
      this.state.lastExecutedPool = edge.poolAddress;
      this.state.legIndex += 1;
      this.state.networkFeesTargetAtomic += asBigInt(
        result.networkFeeTargetAtomic ?? 0n
      );
      remainingHops -= 1;

      await this.#persist("unwind_swap_executed", {
        poolAddress: edge.poolAddress,
        inputMint: edge.tokenInMint,
        outputMint: edge.tokenOutMint,
        outputAmountAtomic: this.state.currentAmountAtomic
      });
    }

    if (this.state.currentMint !== this.state.targetMint) {
      this.state.status = EngineStatus.ERROR_RECOVERY;
      await this.#persist("unwind_failed", { reason: "unwind_hop_budget_exhausted" });
      return {
        action: "unwind_failed",
        reason: "unwind_hop_budget_exhausted",
        state: this.snapshot()
      };
    }

    await this.#completeCycle(now, { unwound: true, reason });
    return { action: "unwound", state: this.snapshot() };
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async #advanceAfterSwap({ signal, result, now, projectedNetBps }) {
    const previousMint = this.state.currentMint;
    const actualOutput = asBigInt(result.actualOutputAtomic, "actualOutputAtomic");
    if (actualOutput <= 0n) throw new Error("executor returned non-positive output");

    this.state.status = EngineStatus.ADVANCE_LEG;
    this.state.currentMint = signal.outputMint;
    this.state.currentAmountAtomic = actualOutput;
    this.state.legIndex += 1;
    this.state.lastExecutedPool = signal.poolAddress;
    this.state.projectedPnlBps = projectedNetBps;
    this.state.networkFeesTargetAtomic += asBigInt(
      result.networkFeeTargetAtomic ?? 0n
    );
    if (this.state.currentMint !== this.state.targetMint) {
      this.state.intermediateSince ??= new Date(now).toISOString();
    }

    await this.#persist("inventory_transition", {
      fromMint: previousMint,
      toMint: this.state.currentMint,
      amountAtomic: actualOutput,
      poolAddress: signal.poolAddress,
      legIndex: this.state.legIndex,
      txSignature: result.txSignature ?? null
    });

    if (this.state.currentMint === this.state.targetMint) {
      await this.#completeCycle(now, { unwound: false });
      return;
    }

    if (this.state.legIndex >= this.state.maxHops) {
      await this.unwind({ now, reason: "max_hops_reached" });
      return;
    }

    this.state.status = EngineStatus.WAITING_FOR_SIGNAL;
    await this.#persist("waiting_for_signal", {
      currentMint: this.state.currentMint,
      legIndex: this.state.legIndex
    });
  }

  async #completeCycle(now, { unwound, reason = null }) {
    this.state.status = EngineStatus.COMPLETE_CYCLE;
    const netAmount =
      this.state.currentAmountAtomic - this.state.networkFeesTargetAtomic;
    this.state.realizedPnlBps = bpsBetween(netAmount, this.state.startingValueAtomic);

    const completed = {
      cycleId: this.state.cycleId,
      completedAt: new Date(now).toISOString(),
      finalAmountAtomic: this.state.currentAmountAtomic,
      netAmountAtomic: netAmount,
      realizedPnlBps: this.state.realizedPnlBps,
      unwound,
      reason
    };
    this.state.lastCompletedCycle = completed;
    this.state.completedCycles += 1;
    await this.#persist("cycle_completed", completed);

    this.state.status = EngineStatus.IDLE_SOL;
    this.state.cycleId = null;
    this.state.currentMint = this.state.targetMint;
    this.state.intermediateSince = null;
    await this.#persist("engine_idle", {
      currentMint: this.state.currentMint,
      currentAmountAtomic: this.state.currentAmountAtomic
    });
  }

  async #persist(event, fields = {}) {
    const record = {
      type: event,
      timestamp: new Date().toISOString(),
      cycleId: this.state.cycleId,
      status: this.state.status,
      ...fields
    };
    await this.eventStore.append(record);
    await this.stateStore.save(this.state);
    this.logger.log(event, record);
  }
}
module.exports = {
  SwapEngine,
  SignalRejectedError
}
