const { quoteEdge } = require("./projection.js");

class DryRunExecutor {
  async execute({ edge, inputAmountAtomic, minOutputAtomic }) {
    const quote = await quoteEdge(edge, inputAmountAtomic);
    if (quote.outputAmountAtomic < minOutputAtomic) {
      throw new Error("dry-run output fell below minOutputAtomic");
    }
    if (typeof edge.applySwap === "function") {
      await edge.applySwap(inputAmountAtomic, quote.outputAmountAtomic);
    }
    return {
      actualOutputAtomic: quote.outputAmountAtomic,
      txSignature: null,
      networkFeeTargetAtomic: 0n,
      confirmed: true,
      dryRun: true
    };
  }

  async confirm(result) {
    return result.confirmed === true;
  }
}
module.exports = DryRunExecutor;