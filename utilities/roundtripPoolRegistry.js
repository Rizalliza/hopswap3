/* ============================================================================
 *  ROUND-TRIP POOL REGISTRY  —  curated from your TVL dump (poolAddresses.js)
 * ============================================================================
 *
 *  SELECTION RULE: a 2-leg round trip needs a pair with >= 2 venues. So every
 *  pair below has multiple pools, and I've kept the LOWEST-fee venues because the
 *  fee stack is the whole hurdle. Single-pool pairs (the long meme/long-tail tail
 *  of your dump) are deliberately EXCLUDED — they can't round-trip and their
 *  "divergence" is pure impact, as your earlier runs proved.
 *
 *  Fee hurdle per round trip = feeA + feeB + flash(0.1bps) + impact(size).
 *  The pairs are ordered by how low that hurdle is — i.e. most likely to clear.
 *
 *  Feed these as your scanner's target pool universe. Keep it tight: ~4 pairs,
 *  ~12 pools, scanned fast and often. That is the opposite of the 150-pool
 *  over-curation you flagged — focus beats breadth for round trips.
 * ========================================================================== */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const ROUNDTRIP_POOLS = [
];
const ROUNDTRIP = [

    /* ----------------------------------------------------------------------
     *  TIER 1 — STABLE / LST: ~2 bps fee hurdle. Best round-trip candidates.
     *           Tight in steady state; blow out on depeg scares (stables) and
     *           epoch/stake-flow spikes (LST). This is where a non-co-located
     *           bot has the most realistic shot.
     * -------------------------------------------------------------------- */

    // SOL / JitoSOL — three venues, ALL 1 bp. ~2 bps hurdle. Dislocates on epochs.
    { pair: 'SOL/JitoSOL', address: 'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp', dex: 'whirlpool', feeBps: 1, tvl: 31439173 },
    { pair: 'SOL/JitoSOL', address: '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc', dex: 'clmm', feeBps: 1, tvl: 1748973 },
    { pair: 'SOL/JitoSOL', address: 'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U', dex: 'dlmm', feeBps: 1, tvl: 2290347 },

    // USDC / USDT — two venues, both 1 bp. ~2 bps hurdle. Depeg-scare spikes.
    { pair: 'USDC/USDT', address: 'BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU', dex: 'clmm', feeBps: 1, tvl: 4234399 },
    { pair: 'USDC/USDT', address: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4', dex: 'whirlpool', feeBps: 1, tvl: 1223791 },

    /* ----------------------------------------------------------------------
     *  TIER 2 — SOL / USDC: your richest pair, FIVE venues, fees 4-25 bps.
     *           Keep the low-fee ones; the 25 bps cpmm is a fee trap, dropped.
     *           Deep liquidity -> spreads survive size, but hurdle is ~8 bps so
     *           it needs a real dislocation to clear.
     * -------------------------------------------------------------------- */
    { pair: 'SOL/USDC', address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', dex: 'whirlpool', feeBps: 4, tvl: 32526289 },
    { pair: 'SOL/USDC', address: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', dex: 'clmm', feeBps: 4, tvl: 4906012 },
    { pair: 'SOL/USDC', address: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6', dex: 'dlmm', feeBps: 4, tvl: 3333440 },
    { pair: 'SOL/USDC', address: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y', dex: 'dlmm', feeBps: 10, tvl: 2712271 },
    { pair: 'SOL/USDC', address: 'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh', dex: 'dlmm', feeBps: 20, tvl: 1894170 },
    // NOTE: 58oQCh.. SOL/USDC cpmm is 25 bps — deliberately EXCLUDED (fee trap).

    /* ----------------------------------------------------------------------
     *  TIER 3 — WRAPPED BTC: same underlying, separate liquidity, periodic gaps.
     *           cbBTC is the hub (3 counterparties). Whirlpool fees here are
     *           higher (16 bps on cbBTC/USDC), so hurdle is steeper — chase only
     *           when the BTC-wrapper gap is wide.
     * -------------------------------------------------------------------- */
    { pair: 'cbBTC/USDC', address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', dex: 'whirlpool', feeBps: 16, tvl: 5809601 },
    { pair: 'cbBTC/WBTC', address: '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72', dex: 'whirlpool', feeBps: 1, tvl: 1290583 },
    { pair: 'cbBTC/LBTC', address: '2gdjgchz31VdaAxmERiAbTAJbzAtGBei7LAwAMV45P1M', dex: 'dlmm', feeBps: 1, tvl: 2828254 },
];

/* Pairs worth ADDING to your fetcher to deepen round-trip coverage (each
 * currently has only 1 venue in your dump, so add a second source):
 *   - SOL/mSOL   (you have MNDE/mSOL but no SOL/mSOL low-fee pool)
 *   - SOL/bSOL   (8phK65.. exists; add a 2nd venue)
 *   - SOL/JupSOL (DtYKbQ.. exists; add a 2nd venue)
 *   - USD1/USDC  (BCDdHo.. is 25 bps — find a 1 bp venue to make it tradeable)
 * LST/SOL pairs are the highest-value adds: low fee + recurring epoch dislocation.
 */

const ROUNDTRIP_PAIRS = [...new Set(ROUNDTRIP_POOLS.map((p) => p.pair))];

module.exports = { ROUNDTRIP_POOLS, ROUNDTRIP_PAIRS, SOL, USDC, USDT };
