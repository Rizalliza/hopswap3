/**
 * DIRECT DEX ENDPOINTS - ALL POOL TYPES
 * ===========================================================================
 * This configuration provides DIRECT access to each DEX's pool types
 * (NOT aggregated through Jupiter)
 *
 * Purpose: Get non-aggregated quotes from individual DEXs to find
 *          price deviations for arbitrage opportunities
 *
 * Pool Types Included:
 * - Raydium: AMM V4, CLMM, CPMM, StableSwap
 * - Orca: Whirlpool (CLMM)
 * - Meteora: DLMM, DAMM V1, DAMM V2, Dynamic Vaults
 * ===========================================================================
 */

const DEX_DIRECT_CONFIGS = {

    // ========================================================================
    // RAYDIUM - Multiple Pool Types
    // ========================================================================
    raydium: {
        name: 'Raydium',
        description: 'Largest AMM on Solana with multiple pool types',

        // All Program IDs
        programIds: {
            launchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',

            // AMM V4 (Legacy Constant Product) - Most liquidity
            ammV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

            // CPMM (New Constant Product with Token-2022 support)
            cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',

            // CLMM (Concentrated Liquidity Market Maker)
            clmm: 'CAMMCzo5YL8w4VFF8KVHrE22H1wSNoa8qYHsBPkaVa2',

            // StableSwap (For pegged assets)
            stableSwap: '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',

            // Utility programs
            burnAndEarn: 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',
            routing: 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
            staking: 'EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q',
            farmStaking: '9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z',
            ecosystemFarm: 'FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG'
        },

        // API V2 Endpoints (Primary)
        api_v2: {
            base: 'https://api.raydium.io/v2',

            // Price feeds (all pool types aggregated)
            price: 'https://api.raydium.io/v2/main/price',

            // All pairs (AMM V4 + CLMM + CPMM combined)
            pairs: 'https://api.raydium.io/v2/main/pairs',

            // AMM V3/V4 pools (Constant Product)
            ammPools: 'https://api.raydium.io/v2/ammV3/ammPools',

            // Farm pools (for yield farming)
            farmPools: 'https://api.raydium.io/v2/main/farm-pools',

            // Info endpoint
            info: 'https://api.raydium.io/v2/main/info'
        },

        // API V3 Endpoints (Newer)
        api_v3: {
            base: 'https://api-v3.raydium.io',

            // Pool info list
            poolsList: 'https://api-v3.raydium.io/pools/info/list',

            // Individual pool info (requires pool address)
            poolInfo: 'https://api-v3.raydium.io/pools/info/{poolAddress}',

            // Pool line data (price history)
            poolLine: 'https://api-v3.raydium.io/pools/line/{poolAddress}'
        },

        // CLMM Specific Endpoints
        clmm: {
            type: 'Concentrated Liquidity Market Maker',
            description: 'Capital-efficient pools with concentrated liquidity',
            feeTiers: ['0.01%', '0.05%', '0.25%', '1%'],

            endpoints: {
                // CLMM pools (use pairs endpoint, filter by program ID)
                pools: 'https://api.raydium.io/v2/main/pairs',

                // V3 API pool list
                poolsV3: 'https://api-v3.raydium.io/pools/info/list'
            }
        },

        // CPMM Specific Endpoints
        cpmm: {
            type: 'Constant Product Market Maker',
            description: 'New standard AMM with Token-2022 support',
            features: ['Token-2022 support', 'No OpenBook market ID required'],

            endpoints: {
                // All CPMM pools (use general pools endpoint)
                pools: 'https://api.raydium.io/v2/main/pairs'
            }
        },

        // AMM V4 Specific Endpoints
        ammV4: {
            type: 'Legacy Constant Product AMM',
            description: 'Battle-tested AMM, most distributed on Solana',

            endpoints: {
                // All AMM pools (V3/V4 combined)
                pools: 'https://api.raydium.io/v2/ammV3/ammPools',

                // Alternative: pairs endpoint (includes all pool types)
                pairsEndpoint: 'https://api.raydium.io/v2/main/pairs',

                // Legacy pools endpoint
                legacyPools: 'https://api.raydium.io/pools'
            }
        },

        // StableSwap Endpoints
        stableSwap: {
            type: 'Stable Asset AMM',
            description: 'Optimized for pegged assets (e.g., stablecoins)',

            endpoints: {
                // Stable swap pools (use general pools endpoint)
                pools: 'https://api.raydium.io/v2/main/pairs'
            }
        },

        config: {
            enabled: true,
            timeout: 120000,  // 2 minutes - Raydium endpoints can be slow with large datasets
            rateLimit: 'Medium'
        }
    },

    // ========================================================================
    // ORCA - Whirlpool (CLMM)
    // ========================================================================
    orca: {
        name: 'Orca',
        description: 'User-friendly DEX with Whirlpools (CLMM)',

        // Program IDs
        programIds: {
            whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            aquafarm: '82yxjeMsvaURa4MbZZ7WZZHfobirZYkH1zF8fmeGtyaQ'
        },

        // Main API Endpoints
        api: {
            base: 'https://api.mainnet.orca.so/v1',

            // Whirlpool list (CLMM pools)
            whirlpools: 'https://api.mainnet.orca.so/v1/whirlpool/list',

            // Token list
            tokens: 'https://api.mainnet.orca.so/v1/token/list'
        },

        // Whirlpool (CLMM) Specific
        whirlpool: {
            type: 'Concentrated Liquidity Market Maker',
            description: 'Orca\'s capital-efficient concentrated liquidity pools',
            feeTiers: ['0.01%', '0.04%', '0.3%', '1%', '2%'],

            endpoints: {
                // All whirlpools
                list: 'https://api.mainnet.orca.so/v1/whirlpool/list',

                // Individual whirlpool (via SDK, requires pool address)
                // Use SDK: @orca-so/whirlpools-sdk
            }
        },

        config: {
            enabled: true,
            timeout: 60000,  // 1 minute - Orca is faster but still allow buffer
            rateLimit: 'Medium'
        }
    },

    // ========================================================================
    // METEORA - Multiple Pool Types (DLMM, DAMM, Dynamic Vaults)
    // ========================================================================
    meteora: {
        name: 'Meteora',
        description: 'Advanced DEX with DLMM, DAMM, and Dynamic Vaults',

        // Program IDs
        programIds: {
            dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
            damm: 'METAmTMXwdb8gYzyCPfXXFmZZw4rUsXX58PNsDg7zjL',
            dammv2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
            dynamicVaults: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'
            //'DAMMV2p1xXGmL6j3f6Y7o5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5'
        },

        // DLMM (Dynamic Liquidity Market Maker) - Primary
        dlmm: {
            type: 'Dynamic Liquidity Market Maker',
            description: 'Bin-based AMM with dynamic fees',
            features: ['Bin-based liquidity', 'Dynamic fees', 'Zero slippage in bins'],

            endpoints: {
                // All DLMM pairs
                allPairs: 'https://dlmm.datapi.meteora.ag/pair/all',

                // Individual pair info (requires pair address)
                pairInfo: 'https://dlmm-api.meteora.ag/pair/{pairAddress}',

                // Position info
                position: 'https://dlmm-api.meteora.ag/position/{positionAddress}',

                // Position V2
                positionV2: 'https://dlmm-api.meteora.ag/position_v2/{positionAddress}',

                // Position metrics
                positionMetrics: 'https://dlmm-api.meteora.ag/position/{positionAddress}/metrics',

                // Stake info
                stake: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}',

                // Stake metrics
                stakeMetrics: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}/metrics',

                // Stake position
                stakePosition: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}/position'
            }
        },

        // DAMM V2 (Dynamic AMM V2)
        dammv2: {
            type: 'Dynamic AMM V2',
            description: 'Multi-token pools with dynamic weights',
            features: ['Multi-token pools', 'Dynamic weights', 'Auto-rebalancing'],

            endpoints: {
                // Global metrics
                globalMetrics: 'https://dammv2-api.meteora.ag/pools/global-metrics',

                // Individual pool (requires pool address)
                pool: 'https://dammv2-api.meteora.ag/pools/{poolAddress}',

                // Pool metrics
                metrics: 'https://dammv2-api.meteora.ag/pools/{poolAddress}/metrics',

                // Position info
                position: 'https://dammv2-api.meteora.ag/pools/{poolAddress}/position',

                // Vesting info
                vesting: 'https://dammv2-api.meteora.ag/pools/vesting/{address}'
            }
        },

        // DAMM V1 (Legacy)
        dammv1: {
            type: 'Dynamic AMM V1',
            description: 'Legacy multi-token pools',

            endpoints: {
                // Global metrics
                globalMetrics: 'https://damm-api.meteora.ag/pools/global-metrics',

                // Individual pool
                pool: 'https://damm-api.meteora.ag/pools/{poolAddress}',

                // Pool metrics
                metrics: 'https://damm-api.meteora.ag/pools/{poolAddress}/metrics',

                // Position info
                position: 'https://damm-api.meteora.ag/pools/{poolAddress}/position',

                // Vesting info
                vesting: 'https://damm-api.meteora.ag/pools/vesting/{address}',

                // Search pools
                search: 'https://damm-api.meteora.ag/pools/search?query={query}',

                // Fee config
                feeConfig: 'https://damm-api.meteora.ag/fee-config/{configAddress}'
            }
        },

        // Dynamic Vaults
        dynamicVaults: {
            type: 'Dynamic Vaults',
            description: 'Automated market-making vaults',

            endpoints: {
                // Vault info (V2 API)
                vaultInfoV2: 'https://merv2-api.meteora.ag/vault_info/{vaultAddress}',

                // Vault info (Alternative)
                vaultInfo: 'https://dynamic-vault-api.meteora.ag/vault_info/{vaultAddress}',

                // Vault state (V2)
                vaultStateV2: 'https://merv2-api.meteora.ag/vault_state/{tokenMint}',

                // Vault state (Alternative)
                vaultState: 'https://dynamic-vault-api.meteora.ag/vault_state/{tokenMint}'
            }
        },

        // General endpoints
        general: {
            // Global metrics (legacy)
            globalMetrics: 'https://gmetrics.meteora.ag/api/v1/pairs'
        },

        config: {
            enabled: true,
            timeout: 120000,  // 2 minutes - Meteora has large datasets
            rateLimit: 'Low'
        }
    }
};

// ============================================================================
// DECODER COMPONENTS
// ============================================================================

/**
 * Decoder registry for on-chain enrichment.
 *
 * Keep this file declarative: the actual decoding still happens in _enrichment.js
 * and math adapters. This registry tells callers which installed SDK/layout/IDL
 * component can decode each account type and what follow-up state is required
 * before a pool is execution-ready.
 */
const DEX_DECODER_COMPONENTS = {
    raydium: {
        ammV4: {
            dexType: 'RAYDIUM_AMM_V4',
            programId: DEX_DIRECT_CONFIGS.raydium.programIds.ammV4,
            accountType: 'amm-v4-pool',
            source: 'node_modules',
            module: '@raydium-io/raydium-sdk-v2',
            decoder: 'liquidityStateV4Layout.decode',
            importSymbols: ['liquidityStateV4Layout'],
            requiredFields: ['baseVault', 'quoteVault', 'baseMint', 'quoteMint', 'baseDecimal', 'quoteDecimal'],
            followUpAccounts: ['baseVault', 'quoteVault'],
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'tokenXDecimals', 'tokenYDecimals', 'xReserve', 'yReserve'],
        },
        stableSwap: {
            dexType: 'RAYDIUM_STABLE',
            programId: DEX_DIRECT_CONFIGS.raydium.programIds.stableSwap,
            accountType: 'stable-pool',
            source: 'node_modules',
            module: '@raydium-io/raydium-sdk-v2',
            decoder: 'liquidityStateV5Layout.decode',
            importSymbols: ['liquidityStateV5Layout'],
            requiredFields: ['baseVault', 'quoteVault', 'baseMint', 'quoteMint'],
            followUpAccounts: ['baseVault', 'quoteVault'],
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'xReserve', 'yReserve'],
        },
        cpmm: {
            dexType: 'RAYDIUM_CPMM',
            programId: DEX_DIRECT_CONFIGS.raydium.programIds.cpmm,
            accountType: 'cpmm-pool',
            source: 'node_modules',
            module: '@raydium-io/raydium-sdk-v2',
            decoder: 'CpmmPoolInfoLayout.decode',
            importSymbols: ['CpmmPoolInfoLayout'],
            requiredFields: ['vaultA', 'vaultB', 'mintA', 'mintB', 'mintDecimalA', 'mintDecimalB'],
            followUpAccounts: ['vaultA', 'vaultB'],
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'tokenXDecimals', 'tokenYDecimals', 'xReserve', 'yReserve'],
        },
        clmm: {
            dexType: 'RAYDIUM_CLMM',
            programId: DEX_DIRECT_CONFIGS.raydium.programIds.clmm,
            accountType: 'clmm-pool',
            source: 'node_modules',
            module: '@raydium-io/raydium-sdk-v2',
            decoder: 'PoolInfoLayout.decode',
            importSymbols: ['PoolInfoLayout', 'TickArrayLayout', 'getPdaTickArrayAddress'],
            requiredFields: ['vaultA', 'vaultB', 'mintA', 'mintB', 'tickCurrent', 'tickSpacing', 'sqrtPriceX64', 'liquidity'],
            followUpAccounts: ['vaultA', 'vaultB', 'tickArrays'],
            tickArrayDecoder: 'TickArrayLayout.decode',
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'tickArrayData', 'ticks', 'sqrtPriceX64', 'liquidity'],
        },
    },
    orca: {
        whirlpool: {
            dexType: 'ORCA_WHIRLPOOL',
            programId: DEX_DIRECT_CONFIGS.orca.programIds.whirlpool,
            accountType: 'whirlpool',
            source: 'node_modules',
            module: '@orca-so/whirlpools-sdk',
            decoder: 'ParsableWhirlpool.parse',
            importSymbols: ['ParsableWhirlpool', 'ParsableTickArray', 'TickUtil', 'PDAUtil', 'ORCA_WHIRLPOOL_PROGRAM_ID'],
            requiredFields: ['tokenVaultA', 'tokenVaultB', 'tokenMintA', 'tokenMintB', 'tickCurrentIndex', 'tickSpacing', 'sqrtPrice', 'liquidity'],
            followUpAccounts: ['tokenVaultA', 'tokenVaultB', 'tickArrays'],
            tickArrayDecoder: 'ParsableTickArray.parse',
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'tickArrayData', 'ticks', 'sqrtPriceX64', 'liquidity'],
        },
    },
    meteora: {
        dlmm: {
            dexType: 'METEORA_DLMM',
            programId: DEX_DIRECT_CONFIGS.meteora.programIds.dlmm,
            accountType: 'lb-pair',
            source: 'node_modules',
            module: '@meteora-ag/dlmm',
            decoder: 'BorshAccountsCoder.decode("LbPair")',
            importSymbols: ['IDL', 'deriveBinArray', 'getBinArrayLowerUpperBinId', 'binIdToBinArrayIndex'],
            idlPath: '../SDK/meteora-dlmm-sdk-main/idls/dlmm.json',
            requiredFields: ['reserveX', 'reserveY', 'tokenXMint', 'tokenYMint', 'activeId', 'binStep'],
            followUpAccounts: ['reserveX', 'reserveY', 'binArrays'],
            binArrayDecoder: 'BorshAccountsCoder.decode("BinArray")',
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'activeBinId', 'binStep', 'binArrays', 'bins', 'xReserve', 'yReserve'],
        },
        dammv2: {
            dexType: 'METEORA_DAMM_V2',
            programId: DEX_DIRECT_CONFIGS.meteora.programIds.dammv2,
            accountType: 'cp-amm-pool',
            source: 'node_modules',
            module: '@meteora-ag/cp-amm-sdk',
            decoder: 'cpAmmCoder.accounts.decode("pool")',
            importSymbols: ['CpAmm', 'cpAmmCoder', 'CpAmmIdl', 'CP_AMM_PROGRAM_ID'],
            localSdkPath: '../SDK/meteora-damm-v2',
            requiredFields: ['tokenAVault', 'tokenBVault', 'tokenAMint', 'tokenBMint'],
            followUpAccounts: ['tokenAVault', 'tokenBVault'],
            outputFields: ['xVault', 'yVault', 'tokenXMint', 'tokenYMint', 'xReserve', 'yReserve'],
        },
    },
    openbook: {
        v2: {
            dexType: 'OPENBOOK_V2',
            accountType: 'orderbook-market',
            source: 'local-sdk',
            module: '../SDK/openbook-v2/dist/cjs',
            decoder: 'Market.load',
            importSymbols: ['Market', 'findAllMarkets'],
            requiredFields: ['market', 'bids', 'asks', 'baseVault', 'quoteVault'],
            followUpAccounts: ['bids', 'asks', 'baseVault', 'quoteVault'],
            outputFields: ['bids', 'asks', 'xVault', 'yVault', 'tokenXMint', 'tokenYMint'],
        },
    },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get all available pool types across all DEXs
 */
function getAllPoolTypes() {
    return {
        raydium: ['AMM V4', 'CLMM', 'CPMM', 'StableSwap'],
        orca: ['Whirlpool (CLMM)'],
        meteora: ['DLMM', 'DAMM V1', 'DAMM V2', 'Dynamic Vaults']
    };
}

/**
 * Get all direct quote endpoints (no aggregation)
 */
function getDirectQuoteEndpoints() {
    return {
        raydium: {
            ammV4: DEX_DIRECT_CONFIGS.raydium.ammV4.endpoints.pools,
            clmm: DEX_DIRECT_CONFIGS.raydium.clmm.endpoints.pools,
            cpmm: DEX_DIRECT_CONFIGS.raydium.cpmm.endpoints.pools,
            stableSwap: DEX_DIRECT_CONFIGS.raydium.stableSwap.endpoints.pools,
            price: DEX_DIRECT_CONFIGS.raydium.api_v2.price
        },
        orca: {
            whirlpool: DEX_DIRECT_CONFIGS.orca.whirlpool.endpoints.list,
            tokens: DEX_DIRECT_CONFIGS.orca.api.tokens
        },
        meteora: {
            dlmm: DEX_DIRECT_CONFIGS.meteora.dlmm.endpoints.allPairs,
            dammv2: DEX_DIRECT_CONFIGS.meteora.dammv2.endpoints.globalMetrics,
            dammv1: DEX_DIRECT_CONFIGS.meteora.dammv1.endpoints.globalMetrics
        }
    };
}

/**
 * Get program IDs for on-chain queries
 */
function getProgramIds() {
    return {
        raydium: {
            ammV4: DEX_DIRECT_CONFIGS.raydium.programIds.ammV4,
            clmm: DEX_DIRECT_CONFIGS.raydium.programIds.clmm,
            cpmm: DEX_DIRECT_CONFIGS.raydium.programIds.cpmm,
            stableSwap: DEX_DIRECT_CONFIGS.raydium.programIds.stableSwap
        },
        orca: {
            whirlpool: DEX_DIRECT_CONFIGS.orca.programIds.whirlpool
        },
        meteora: {
            dlmm: DEX_DIRECT_CONFIGS.meteora.programIds.dlmm,
            damm: DEX_DIRECT_CONFIGS.meteora.programIds.damm,
            dammv2: DEX_DIRECT_CONFIGS.meteora.programIds.dammv2
        }
    };
}

/**
 * Get decoder registry entries for all DEXes or a specific dex/pool type.
 */
function getDecoderComponents(dex, poolType) {
    if (!dex) return DEX_DECODER_COMPONENTS;
    const dexComponents = DEX_DECODER_COMPONENTS[dex];
    if (!dexComponents || !poolType) return dexComponents || null;
    return dexComponents[poolType] || null;
}

function resolveExportPath(moduleExports, exportPath) {
    if (!exportPath || !moduleExports) return undefined;
    return exportPath.split('.').reduce((current, key) => (
        current && Object.prototype.hasOwnProperty.call(Object(current), key)
            ? current[key]
            : undefined
    ), moduleExports);
}

function flattenDecoderComponents(components = DEX_DECODER_COMPONENTS) {
    const entries = [];
    for (const [dex, pools] of Object.entries(components)) {
        for (const [poolType, component] of Object.entries(pools || {})) {
            entries.push({ dex, poolType, ...component });
        }
    }
    return entries;
}

/**
 * Best-effort local availability check.
 *
 * This verifies JS module availability and named exports only. It intentionally
 * does not fetch chain data or prove that an account can be decoded.
 */
function getMissingDecoderComponents() {
    return flattenDecoderComponents()
        .map((component) => {
            const missing = [];
            let moduleExports = null;
            if (!component.module) {
                missing.push('module');
            } else {
                try {
                    moduleExports = require(component.module);
                } catch (error) {
                    missing.push(`module:${error.message}`);
                }
            }

            for (const symbol of component.importSymbols || []) {
                if (!moduleExports || resolveExportPath(moduleExports, symbol) === undefined) {
                    missing.push(`export:${symbol}`);
                }
            }

            if (component.idlPath) {
                try {
                    require(component.idlPath);
                } catch (error) {
                    missing.push(`idl:${error.message}`);
                }
            }

            return { ...component, available: missing.length === 0, missing };
        })
        .filter((component) => !component.available || component.status);
}

/**
 * Get pool type characteristics for arbitrage analysis
 */
function getPoolTypeCharacteristics() {
    return {
        'AMM V4': {
            type: 'Constant Product',
            formula: 'x * y = k',
            slippage: 'Linear with trade size',
            bestFor: 'Large trades, high liquidity pairs',
            feeTiers: ['0.25%']
        },
        'CLMM': {
            type: 'Concentrated Liquidity',
            formula: 'Uniswap V3 style',
            slippage: 'Low in active range, high outside',
            bestFor: 'Stable pairs, range-bound trading',
            feeTiers: ['0.01%', '0.04%', '0.25%', '1%']
        },
        'CPMM': {
            type: 'Constant Product (New)',
            formula: 'x * y = k',
            slippage: 'Linear with trade size',
            bestFor: 'Token-2022 assets, new pairs',
            feeTiers: ['Variable']
        },
        'StableSwap': {
            type: 'Curve-style Stable',
            formula: 'Stable invariant',
            slippage: 'Very low for pegged assets',
            bestFor: 'Stablecoin swaps, pegged assets',
            feeTiers: ['0.01%', '0.04%']
        },
        'DLMM': {
            type: 'Dynamic Liquidity (Bins)',
            formula: 'Bin-based pricing',
            slippage: 'Zero within bins, stepped',
            bestFor: 'Volatile pairs, dynamic fees',
            feeTiers: ['Dynamic (0.01% - 1%+)']
        },
        'DAMM': {
            type: 'Multi-token Dynamic',
            formula: 'Weighted invariant',
            slippage: 'Variable by weight',
            bestFor: 'Multi-asset pools, baskets',
            feeTiers: ['Variable']
        }
    };
}

/**
 * Build Meteora pool URL with address
 */
function buildMeteoraPoolUrl(poolType, address) {
    const config = DEX_DIRECT_CONFIGS.meteora;

    switch (poolType) {
        case 'dlmm':
            return config.dlmm.endpoints.pairInfo.replace('{pairAddress}', address);
        case 'dammv2':
            return config.dammv2.endpoints.pool.replace('{poolAddress}', address);
        case 'dammv1':
            return config.dammv1.endpoints.pool.replace('{poolAddress}', address);
        default:
            throw new Error(`Unknown Meteora pool type: ${poolType}`);
    }
}

/**
 * Build Raydium pool URL with address (V3 API)
 */
function buildRaydiumPoolUrl(poolAddress, poolType) {
    switch (poolType) {
        case 'amm':
        case 'clmm':
        case 'cpmm':
        case 'stableSwap':
        case 'ammV4':
            return DEX_DIRECT_CONFIGS.raydium.api_v3.poolInfo.replace('{poolAddress}', poolAddress);
        default:
            throw new Error(`Unknown Raydium pool type: ${poolType}`);
    }
}

// ============================================================================
// EXPORT
// ============================================================================

module.exports = {
    // Main config
    DEX_DIRECT_CONFIGS,
    DEX_DECODER_COMPONENTS,

    // Utility functions
    getAllPoolTypes,
    getDirectQuoteEndpoints,
    getProgramIds,
    getDecoderComponents,
    getMissingDecoderComponents,
    getPoolTypeCharacteristics,
    buildMeteoraPoolUrl,
    buildRaydiumPoolUrl
};

// ============================================================================
// USAGE EXAMPLES & DOCUMENTATION
// ============================================================================

if (require.main === module) {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║           DIRECT DEX ENDPOINTS - ALL POOL TYPES                 ║');
    console.log('║              (Non-Aggregated, Direct Quotes)                     ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    console.log('📊 AVAILABLE POOL TYPES:\n');
    const poolTypes = getAllPoolTypes();
    Object.entries(poolTypes).forEach(([dex, types]) => {
        console.log(`${dex.toUpperCase()}:`);
        types.forEach(type => console.log(`  - ${type}`));
        console.log();
    });

    console.log('🔗 DIRECT QUOTE ENDPOINTS:\n');
    const endpoints = getDirectQuoteEndpoints();
    Object.entries(endpoints).forEach(([dex, dexEndpoints]) => {
        console.log(`${dex.toUpperCase()}:`);
        Object.entries(dexEndpoints).forEach(([type, url]) => {
            console.log(`  ${type}: ${url}`);
        });
        console.log();
    });

    console.log('📝 PROGRAM IDs (for on-chain queries):\n');
    const programIds = getProgramIds();
    Object.entries(programIds).forEach(([dex, ids]) => {
        console.log(`${dex.toUpperCase()}:`);
        Object.entries(ids).forEach(([type, id]) => {
            console.log(`  ${type}: ${id}`);
        });
        console.log();
    });

    console.log('💡 ARBITRAGE STRATEGY:\n');
    console.log('1. Query direct pools from each DEX (bypassing Jupiter aggregation)');
    console.log('2. Compare prices across different pool types');
    console.log('3. Look for deviations > gas costs + fees');
    console.log('4. Execute arbitrage on the specific pool type with best spread\n');

    console.log('═══════════════════════════════════════════════════════════════════\n');
}

// node dex/DEX_DIRECT_ENDPOINTS.js

`./engine/Q_enrichment.js`

/*

    ./ engine / triangleArb.js

        `./engine/Q-clmm.js`, `./engine/Q-cpmm.js`, `./engine/Q-dlmm.js`, 

                        ./ engine / triangleArb.js

        ('TRIANGLE CANDIDATE DIAGNOSTIC'); (current blocker due to secureHeapUsed(), normalizer etc) ./engine/3legSwapSimulator.js, i am not using this('./engine/3legSwapSimulator.js'); this is a  this portion for the codes had been pasted into triangleArb.Can you paste and overwrite  the existing. 3leg is now in triangleArb.can you check the codes, sycnax to see if its clean

        */
