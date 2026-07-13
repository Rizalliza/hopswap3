"use strict";

const { getTokenSymbol, getTokenInfo } = require("./defiTok");

// Backward-compatible cache for special-cases and overrides.
// `defiTok` is the canonical source; this map only patches gaps or aliases.
const MINT_TO_SYMBOL_COMPLETE = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "So11111111111111111111111111111111111111112": "SOL",
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": "JLP"
};

function getSymbolFromMint(mintAddress) {
    if (!mintAddress) return "";
    return (
        MINT_TO_SYMBOL_COMPLETE[mintAddress] ||
        getTokenSymbol(mintAddress) ||
        getTokenInfo(mintAddress)?.symbol ||
        mintAddress
    );
}
// Example modification for displaying PAIR column
function formatPairDisplay(baseMint, quoteMint) {
    const baseSymbol = getSymbolFromMint(baseMint);
    const quoteSymbol = getSymbolFromMint(quoteMint);
    return `${baseSymbol}/${quoteSymbol}`;
}
// If you're processing data from the saved JSON
function processPoolData(pools) {
    return pools.map(pool => {
        const baseMint = pool.baseMint || pool.mintA || pool.tokenXMint || pool.inputMint || pool.mint || pool.addressA || "";
        const quoteMint = pool.quoteMint || pool.mintB || pool.tokenYMint || pool.outputMint || pool.addressB || "";
        const baseSymbol = getSymbolFromMint(baseMint);
        const quoteSymbol = getSymbolFromMint(quoteMint);

        return {
            ...pool,
            pairDisplay: formatPairDisplay(baseMint, quoteMint),
            baseMint,
            quoteMint,
            baseSymbol,
            quoteSymbol,
            pair: pool.pair || `${baseSymbol}/${quoteSymbol}`,
        };
    });
}
// Example usage with your data structure
async function displayPools() {
    // Assuming you have loaded your JSON data
    const poolsData = require("./path/to/your/saved.json"); // or import for ES modules
    const processedPools = processPoolData(poolsData);
    // Display in table format
    console.table(processedPools.map(pool => ({
        "PAIR": pool.pairDisplay,
        "TVL": pool.tvl,
        "Volume 24h": pool.volume24h,
        "Fees 24h": pool.fees24h,
        // Add other columns as needed
    })));
}
// If you need to modify the original fetcher code
function modifyFetcherOutput(pools) {
    return pools.map(pool => {
        const baseSymbol = getSymbolFromMint(pool.baseMint);
        const quoteSymbol = getSymbolFromMint(pool.quoteMint);
        return {
            ...pool,
            pair: `${baseSymbol}/${quoteSymbol}`,
            // Optional: add symbol fields
            baseSymbol,
            quoteSymbol
        };
    });
}
// For CSV/Excel output
function generateCSVData(pools) {
    return pools.map(pool => {
        const baseMint = pool.baseMint || pool.mintA || pool.tokenXMint || pool.inputMint || "";
        const quoteMint = pool.quoteMint || pool.mintB || pool.tokenYMint || pool.outputMint || "";
        const baseSymbol = getSymbolFromMint(baseMint);
        const quoteSymbol = getSymbolFromMint(quoteMint);
        return {
            "Pair": `${baseSymbol}/${quoteSymbol}`,
            "Base Mint": baseMint,
            "Quote Mint": quoteMint,
            "Base Symbol": baseSymbol,
            "Quote Symbol": quoteSymbol,
            "TVL": pool.tvl,
            "Volume 24h": pool.volume24h,
            // Add other fields as needed
        };
    });
}
module.exports = {
    MINT_TO_SYMBOL_COMPLETE,
    getSymbolFromMint
};
