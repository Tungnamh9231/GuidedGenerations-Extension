import { PROMPT_BLOCKS } from './registry.js';
import { getBlockOrder } from './store.js';

// The extension only stores where each of its blocks sits *relative to a native
// prompt identifier*. Native prompts stay authoritative for their own ordering, so
// the UI and the send path both rebuild the full sequence from those two inputs.
export function buildMergedOrder(nativeIds, storedEntries = getBlockOrder()) {
    const nativeSet = new Set(nativeIds);
    const knownBlocks = new Set(PROMPT_BLOCKS.map(block => block.id));
    const entries = (Array.isArray(storedEntries) ? storedEntries : [])
        .filter(entry => entry && knownBlocks.has(entry.id))
        .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);

    const startBucket = [];
    const anchoredBuckets = new Map();
    const place = (bucket, id) => bucket.push(id);

    entries.forEach((entry, index) => {
        let anchor = entry.after ?? '';
        // The anchor may have been removed from the prompt order by SillyTavern;
        // fall back to the nearest earlier anchor that still exists.
        for (let i = index; i >= 0 && anchor && !nativeSet.has(anchor); i--) {
            anchor = entries[i].after ?? '';
        }
        if (!anchor) {
            if (!startBucket.includes(entry.id)) place(startBucket, entry.id);
            return;
        }
        if (!anchoredBuckets.has(anchor)) anchoredBuckets.set(anchor, []);
        place(anchoredBuckets.get(anchor), entry.id);
    });

    const tokens = startBucket.map(id => ({ type: 'ext', id }));
    for (const nativeId of nativeIds) {
        tokens.push({ type: 'native', id: nativeId });
        for (const id of anchoredBuckets.get(nativeId) ?? []) tokens.push({ type: 'ext', id });
    }

    const placed = new Set(tokens.filter(token => token.type === 'ext').map(token => token.id));
    for (const block of PROMPT_BLOCKS) {
        if (!placed.has(block.id)) tokens.push({ type: 'ext', id: block.id });
    }
    return tokens;
}

// Inverse of buildMergedOrder: turn a flat list of element ids back into the
// anchor list we persist. Native elements are never recorded.
export function toStoredOrder(tokens) {
    const stored = [];
    let lastNative = '';
    for (const token of tokens) {
        if (token.type === 'native') {
            lastNative = token.id;
            continue;
        }
        stored.push({ id: token.id, after: lastNative });
    }
    return stored;
}
