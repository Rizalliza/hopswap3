import { PairGraph } from "./graph.js";
import { BoundedSignalQueue } from "./queue.js";
import { StatefulFrontierScanner } from "./scanner.js";
import { DryRunExecutor } from "./executor.js";
import { SwapEngine } from "./engine.js";
import { StructuredLogger } from "./logger.js";
import { fixedRateEdge, StaticBalanceProvider, StaticPoolStateProvider } from "./testing.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_B = "TokenBMint";
const TOKEN_C = "TokenCMint";
const now = Date.now();

const graph = new PairGraph([
  fixedRateEdge({
    poolAddress: "Pool_SOL_B",
    tokenInMint: SOL,
    tokenOutMint: TOKEN_B,
    numerator: 2n,
    denominator: 1n,
    slot: 100,
    lastHydratedAt: now
  }),
  fixedRateEdge({
    poolAddress: "Pool_B_C",
    tokenInMint: TOKEN_B,
    tokenOutMint: TOKEN_C,
    numerator: 3n,
    denominator: 1n,
    slot: 100,
    lastHydratedAt: now
  }),
  fixedRateEdge({
    poolAddress: "Pool_C_SOL",
    tokenInMint: TOKEN_C,
    tokenOutMint: SOL,
    numerator: 17n,
    denominator: 100n,
    slot: 100,
    lastHydratedAt: now
  })
]);

const logger = new StructuredLogger();
const queue = new BoundedSignalQueue({ capacity: 10 });
const commonConfig = {
  startMint: SOL,
  targetMint: SOL,
  maxHops: 3,
  minProfitBps: 3,
  safetyBufferBps: 1.5,
  maxPoolAgeMs: 60_000,
  maxPoolSlotLag: 2,
  allowedTokens: new Set([SOL, TOKEN_B, TOKEN_C])
};

const scanner = new StatefulFrontierScanner({
  graph,
  queue,
  logger,
  config: commonConfig
});

const engine = new SwapEngine({
  graph,
  executor: new DryRunExecutor(),
  poolStateProvider: new StaticPoolStateProvider({ currentSlot: 100 }),
  balanceProvider: new StaticBalanceProvider({
    [SOL]: 1_000_000_000n,
    [TOKEN_B]: 10_000_000_000n,
    [TOKEN_C]: 10_000_000_000n
  }),
  logger,
  config: commonConfig
});

await engine.startCycle({ amountAtomic: 1_000_000_000n, now });

while (engine.state.status !== "IDLE_SOL") {
  await scanner.scan(engine.snapshot(), { currentSlot: 100, now: Date.now() });
  const signal = queue.popBest({
    cycleId: engine.state.cycleId,
    legIndex: engine.state.legIndex,
    inputMint: engine.state.currentMint
  });
  if (!signal) throw new Error("no compatible signal available");
  const outcome = await engine.processSignal(signal, {
    currentSlot: 100,
    now: Date.now()
  });
  if (!outcome.accepted) throw new Error(`signal failed: ${outcome.reason}`);
}

console.log("Completed:", engine.state.lastCompletedCycle);
