#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function loadJson(p) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function getPools(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.pools)) return data.pools;
    if (Array.isArray(data?.enrichedPools)) return data.enrichedPools;
    return [];
}

function getPairKey(pool) {
    const a = pool.tokenXMint || pool.baseMint || pool.mintA || pool.tokenA || '';
    const b = pool.tokenYMint || pool.quoteMint || pool.mintB || pool.tokenB || '';
    if (!a || !b) return null;
    return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function main() {
    const file = process.argv[2] || 'pools/02_ENRICHED.json';
    const data = loadJson(file);
    const pools = getPools(data);

    console.log(`\n📊 Pool Diversity Check: ${file}`);
    console.log(`   Total pools: ${pools.length}`);

    const byPair = {};
    const byDex = {};
    for (const pool of pools) {
        const pair = getPairKey(pool);
        if (!pair) continue;
        byPair[pair] = (byPair[pair] || 0) + 1;

        const dex = pool.dexType || pool.dex || pool.type || 'unknown';
        byDex[dex] = (byDex[dex] || 0) + 1;
    }

    const pairs = Object.keys(byPair);
    console.log(`   Unique pairs: ${pairs.length}`);
    console.log(`   By DEX: ${Object.entries(byDex).map(([k, v]) => `${k}=${v}`).join(', ')}`);

    if (pairs.length === 0) {
        console.log('\n❌ CRITICAL: Zero valid pairs found. Check pool schema (tokenXMint/tokenYMint missing).');
        return;
    }

    if (pairs.length < 3) {
        console.log(`\n❌ CRITICAL: Only ${pairs.length} pair(s). Need ≥3 distinct pairs to form triangles.`);
        console.log('   Pairs found:');
        for (const p of pairs) {
            const [a, b] = p.split('_');
            console.log(`     ${a.slice(0, 8)}... / ${b.slice(0, 8)}... (${byPair[p]} pools)`);
        }
        console.log('\n🔧 Fix: Lower --minLiquidity in your fetcher or expand token list.');
        return;
    }

    // Check if any token appears in ≥3 pairs (needed for triangle closure)
    const tokenPairCount = {};
    for (const pair of pairs) {
        const [a, b] = pair.split('_');
        tokenPairCount[a] = (tokenPairCount[a] || 0) + 1;
        tokenPairCount[b] = (tokenPairCount[b] || 0) + 1;
    }
    const hubs = Object.entries(tokenPairCount)
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    console.log(`\n✅ Sufficient pairs for triangles (${pairs.length}).`);
    console.log(`   Top hub tokens (appear in ≥3 pairs):`);
    for (const [mint, count] of hubs) {
        console.log(`     ${mint.slice(0, 12)}... → ${count} pairs`);
    }

    if (hubs.length === 0) {
        console.log('\n⚠️  No hub token found in ≥3 pairs. Triangles may still be sparse.');
    }
}

main();

//. node utilities/checkPoolDiversity.js pools/02_ENRICHED.json