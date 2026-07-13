const { asBigInt } = require("./amount.js");

function fixedRateEdge({
  poolAddress,
  tokenInMint,
  tokenOutMint,
  numerator,
  denominator,
  slot = 100,
  version = 1,
  ...overrides
}) {
  const rateNumerator = asBigInt(numerator, "numerator");
  const rateDenominator = asBigInt(denominator, "denominator");
  if (rateNumerator <= 0n || rateDenominator <= 0n) {
    throw new RangeError("fixed rate numerator and denominator must be positive");
  }

  return {
    poolAddress,
    dexType: "TEST_DEX",
    mathType: "fixed_rate",
    tokenInMint,
    tokenOutMint,
    feeBps: 0,
    liquidity: 1_000_000,
    executionReady: true,
    stale: false,
    outlier: false,
    quarantined: false,
    lastUpdatedSlot: slot,
    lastHydratedAt: Date.now(),
    stateVersion: `${poolAddress}:${slot}:${version}`,
    quoteExactIn(amountAtomic) {
      return (asBigInt(amountAtomic) * rateNumerator) / rateDenominator;
    },
    ...overrides
  };
}

class StaticPoolStateProvider {
  constructor({ currentSlot = 100 } = {}) {
    this.currentSlot = currentSlot;
  }

  async refreshEdge(edge) {
    return edge;
  }

  async getCurrentSlot() {
    return this.currentSlot;
  }
}

class StaticBalanceProvider {
  constructor(balances = {}) {
    this.balances = new Map(
      Object.entries(balances).map(([mint, amount]) => [mint, asBigInt(amount)])
    );
  }

  async getBalance(mint) {
    return this.balances.get(mint) ?? 0n;
  }

  setBalance(mint, amount) {
    this.balances.set(mint, asBigInt(amount));
  }
}
module.exports = {
  fixedRateEdge,
  StaticBalanceProvider,
  StaticPoolStateProvider,
}