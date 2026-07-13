'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');

function getConfiguredRpcUrls() {
    const urls = [];

    const add = (v) => {
        const text = typeof v === 'string' ? v.trim() : '';
        if (text) urls.push(text);
    };

    add(process.env.HELIUS_ENDPOINT1);
    add(process.env.HELIUS_ENDPOINT2);
    add(process.env.HELIUS_ENDPOINT3);
    add(process.env.HELIUS_ENDPOINT);
    add(process.env.GETBLOCK_ENDPOINT1);
    add(process.env.GETBLOCK_ENDPOINT2);
    add(process.env.GETBLOCK_ENDPOINT3);
    add(process.env.GETBLOCK_ENDPOINT);
    add(process.env.RPC_URL);
    add(process.env.SOLANA_RPC_URL);

    // Also support HELIUS_RPC_URLS as comma-separated.
    const lists = [process.env.HELIUS_RPC_URLS, process.env.GETBLOCK_RPC_URLS, process.env.RPC_URLS];
    for (const list of lists) {
        if (typeof list === 'string' && list.trim()) {
            list.split(',').map((s) => s.trim()).filter(Boolean).forEach(add);
        }
    }

    return Array.from(new Set(urls));
}

function isRetryableRpcError(err) {
    if (!err) return false;
    const status = Number(err.status || err.code || err?.cause?.status || 0);
    const msg = String(err?.message || err || '').toLowerCase();

    return status === 0
        || status === 408
        || status === 425
        || status === 429
        || status === 500
        || status === 502
        || status === 503
        || status === 504
        || msg.includes('429')
        || msg.includes('rate limit')
        || msg.includes('too many requests')
        || msg.includes('timeout')
        || msg.includes('timed out')
        || msg.includes('econnreset')
        || msg.includes('socket')
        || msg.includes('fetch failed')
        || msg.includes('gateway')
        || msg.includes('service unavailable');
}

function maskEndpoint(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const key = parsed.searchParams.get('api-key') || parsed.searchParams.get('api_key');
        if (key) {
            const suffix = key.length > 4 ? key.slice(-4) : '****';
            parsed.searchParams.delete('api_key');
            parsed.searchParams.set('api-key', `***${suffix}`);
        }
        if (/^go\.getblock\.(io|us|asia)$/i.test(parsed.hostname)) {
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts[0]) {
                const token = parts[0];
                const suffix = token.length > 4 ? token.slice(-4) : '****';
                parsed.pathname = `/***${suffix}/`;
            }
        }
        return parsed.toString();
    } catch (_e) {
        return String(url).replace(/api[-_]?key=([^&]+)/i, 'api-key=***');
    }
}

/**
 * Creates a light-weight Connection proxy that rotates every RPC method call
 * across the configured endpoints. Transient failures are retried on the next
 * healthy endpoint and the failing endpoint is cooled down briefly.
 */
function createRpcConnection({
    urls,
    commitment = 'confirmed',
    maxRetries,
    cooldownMs,
    logFailures = false,
} = {}) {
    const resolvedUrls = Array.isArray(urls) ? urls.filter(Boolean) : getConfiguredRpcUrls();
    const endpoints = Array.from(new Set(resolvedUrls)).map((url, index) => ({
        index,
        url,
        maskedUrl: maskEndpoint(url),
        connection: new Connection(url, commitment),
        failures: 0,
        successes: 0,
        lastError: null,
        lastUsedAt: null,
        cooldownUntil: 0,
    }));

    const retryBudget = Math.max(1, Number(maxRetries || endpoints.length || 1));
    const endpointCooldownMs = Math.max(0, Number(cooldownMs || process.env.RPC_COOLDOWN_MS || 2_000));

    let rpcCursor = 0;
    let urlCursor = 0;

    const pickEndpoint = (mode = 'rpc') => {
        if (!endpoints.length) return null;

        const now = Date.now();
        const cursor = mode === 'url' ? urlCursor : rpcCursor;

        for (let offset = 0; offset < endpoints.length; offset += 1) {
            const idx = (cursor + offset) % endpoints.length;
            const endpoint = endpoints[idx];
            if (endpoint.cooldownUntil <= now) {
                if (mode === 'url') urlCursor = (idx + 1) % endpoints.length;
                else rpcCursor = (idx + 1) % endpoints.length;
                endpoint.lastUsedAt = now;
                return endpoint;
            }
        }

        // All endpoints are cooling down. Pick the one that recovers first so
        // callers can still make progress instead of deadlocking the queue.
        const endpoint = endpoints
            .slice()
            .sort((left, right) => left.cooldownUntil - right.cooldownUntil)[0];
        if (mode === 'url') urlCursor = (endpoint.index + 1) % endpoints.length;
        else rpcCursor = (endpoint.index + 1) % endpoints.length;
        endpoint.lastUsedAt = now;
        return endpoint;
    };

    const recordSuccess = (endpoint) => {
        if (!endpoint) return;
        endpoint.successes += 1;
        endpoint.failures = 0;
        endpoint.lastError = null;
        endpoint.cooldownUntil = 0;
    };

    const recordFailure = (endpoint, err) => {
        if (!endpoint) return;
        endpoint.failures += 1;
        endpoint.lastError = String(err?.message || err || 'RPC error');
        if (isRetryableRpcError(err) && endpointCooldownMs > 0) {
            endpoint.cooldownUntil = Date.now() + Math.min(
                endpointCooldownMs * Math.max(1, endpoint.failures),
                30_000,
            );
        }
        if (logFailures) {
            console.warn(`[rpc] ${endpoint.maskedUrl || endpoint.index} failed: ${endpoint.lastError}`);
        }
    };

    const callWithRotation = async (methodName, fallbackValue, args) => {
        if (!endpoints.length) return fallbackValue;

        const attempts = Math.min(retryBudget, endpoints.length);
        let lastErr = null;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const endpoint = pickEndpoint('rpc');
            if (!endpoint) break;

            try {
                const fn = endpoint.connection?.[methodName];
                if (typeof fn !== 'function') return fallbackValue;
                const result = await fn.apply(endpoint.connection, args);
                recordSuccess(endpoint);
                return result;
            } catch (err) {
                lastErr = err;
                recordFailure(endpoint, err);
                if (!isRetryableRpcError(err)) break;
            }
        }

        if (fallbackValue !== undefined) return fallbackValue;
        throw lastErr || new Error(`RPC call failed: ${methodName}`);
    };

    const nextRpcEndpoint = () => {
        const endpoint = pickEndpoint('url');
        return endpoint ? endpoint.url : null;
    };

    const rotateRPC = nextRpcEndpoint;

    const nextConnection = () => {
        const endpoint = pickEndpoint('rpc');
        return endpoint ? endpoint.connection : null;
    };

    const getRpcPoolStatus = () => endpoints.map((endpoint) => ({
        index: endpoint.index,
        url: endpoint.maskedUrl,
        failures: endpoint.failures,
        successes: endpoint.successes,
        lastError: endpoint.lastError,
        coolingDown: endpoint.cooldownUntil > Date.now(),
        cooldownMsRemaining: Math.max(0, endpoint.cooldownUntil - Date.now()),
        lastUsedAt: endpoint.lastUsedAt,
    }));

    return {
        rpcEndpoint: endpoints[0]?.url || null,
        connection: endpoints[0]?.connection || null,

        listEndpoints: () => endpoints.map((endpoint) => endpoint.url),
        listMaskedEndpoints: () => endpoints.map((endpoint) => endpoint.maskedUrl),
        getRpcPoolStatus,
        nextConnection,
        nextRpcEndpoint,
        rotateRPC,

        getSlot: async (...args) => callWithRotation('getSlot', null, args),
        getAccountInfo: async (...args) => callWithRotation('getAccountInfo', null, args),
        getMultipleAccountsInfo: async (...args) => callWithRotation('getMultipleAccountsInfo', [], args),
        getProgramAccounts: async (...args) => callWithRotation('getProgramAccounts', [], args),
    };
}

module.exports = {
    createRpcConnection,
    getConfiguredRpcUrls,
    isRetryableRpcError,
    // Exported for older code paths that might import directly.
    PublicKey,
};
