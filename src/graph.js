function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
function edgeKey(poolAddress, tokenInMint, tokenOutMint) {
  return `${poolAddress}:${tokenInMint}:${tokenOutMint}`;
}
function normalizeEdge(edge) {
  if (!edge || typeof edge !== "object") throw new TypeError("edge must be an object");
  assertNonEmptyString(edge.poolAddress, "edge.poolAddress");
  assertNonEmptyString(edge.tokenInMint, "edge.tokenInMint");
  assertNonEmptyString(edge.tokenOutMint, "edge.tokenOutMint");
  if (edge.tokenInMint === edge.tokenOutMint) {
    throw new RangeError("edge input and output mints must differ");
  }
  if (typeof edge.quoteExactIn !== "function") {
    throw new TypeError("edge.quoteExactIn must be a function");
  }

  return {
    dexType: "UNKNOWN",
    mathType: "unknown",
    feeBps: 0,
    liquidity: 0,
    executionReady: false,
    stale: false,
    outlier: false,
    quarantined: false,
    staleFlags: [],
    lastUpdatedSlot: 0,
    lastHydratedAt: 0,
    stateVersion: `${edge.poolAddress}:0:0`,
    ...edge
  };
}

class PairGraph {
  #outgoing = new Map();
  #edges = new Map();

  constructor(edges = []) {
    for (const edge of edges) this.addEdge(edge);
  }

  addEdge(rawEdge) {
    const edge = normalizeEdge(rawEdge);
    const key = edgeKey(edge.poolAddress, edge.tokenInMint, edge.tokenOutMint);
    this.#edges.set(key, edge);

    const outgoing = this.#outgoing.get(edge.tokenInMint) ?? [];
    const existingIndex = outgoing.findIndex(
      (candidate) =>
        candidate.poolAddress === edge.poolAddress &&
        candidate.tokenOutMint === edge.tokenOutMint
    );
    if (existingIndex >= 0) outgoing[existingIndex] = edge;
    else outgoing.push(edge);
    this.#outgoing.set(edge.tokenInMint, outgoing);
    return edge;
  }

  replaceEdge(rawEdge) {
    return this.addEdge(rawEdge);
  }

  outgoing(mint) {
    return [...(this.#outgoing.get(mint) ?? [])];
  }

  getEdge(poolAddress, tokenInMint, tokenOutMint) {
    return this.#edges.get(edgeKey(poolAddress, tokenInMint, tokenOutMint));
  }

  allEdges() {
    return [...this.#edges.values()];
  }

  get size() {
    return this.#edges.size;
  }
}
module.exports = {
  PairGraph,
  normalizeEdge,
  assertNonEmptyString
}
