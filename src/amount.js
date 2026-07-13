function asBigInt(value, name = "value") {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${name} must be a bigint, safe integer, or integer string`);
}

function bpsBetween(finalAmount, initialAmount) {
  const finalValue = asBigInt(finalAmount, "finalAmount");
  const initialValue = asBigInt(initialAmount, "initialAmount");
  if (initialValue <= 0n) throw new RangeError("initialAmount must be positive");

  // Four decimal places of basis-point precision.
  const scaled = ((finalValue - initialValue) * 100_000_000n) / initialValue;
  return Number(scaled) / 10_000;
}

function subtractBps(amount, bps) {
  const value = asBigInt(amount, "amount");
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10_000) {
    throw new RangeError("bps must be in [0, 10000)");
  }
  const scaledBps = BigInt(Math.ceil(bps * 10_000));
  return (value * (100_000_000n - scaledBps)) / 100_000_000n;
}

function bigintMax(a, b) {
  return a > b ? a : b;
}
module.exports = {
  asBigInt,
  subtractBps,
  bigintMax,
  bpsBetween
}