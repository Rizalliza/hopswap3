
const { diagnoseTickArrays } = require('./tickArrayShapeReconciler');
const fs = require('fs');

function extractPools(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.pools)) return payload.pools;
    if (Array.isArray(payload?.filteredPools)) return payload.filteredPools;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.pools)) return payload.data.pools;
    if (Array.isArray(payload?.details)) return payload.details;
    throw new TypeError(`Expected a pool array or object with pools/filteredPools/data/details; got keys: ${Object.keys(payload || {}).join(', ')}`);
}

const file = process.argv[2] || 'tradePool/_STABLE_HOP.curated.json';
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const pools = extractPools(payload);
console.log(`[decoderChecker] file=${file} pools=${pools.length}`);
console.log('[tickshape]', JSON.stringify(diagnoseTickArrays(pools), null, 2));
// also count DLMM bin presence:
const dlmm = pools.filter(p => /dlmm/i.test(p.type || p.dexType || ''));
for (const p of dlmm) {
    const bins = p.binArrays || p.bins || p.aux?.dlmm?.binArrays || [];
    console.log(String(p.poolAddress || '').slice(0, 8), 'bins:', Array.isArray(bins) ? bins.length : 0,
        'shape:', typeof (bins[0]));
}

// node utilities/decoderChecker.js
