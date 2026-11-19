import {
    ALL_MARKERS,
    CONFUSABLE_TO_LATIN,
    HOMOGLYPHS,
    MARKER_LABELS,
    MARKER_SETS,
    MAX_REPORT_SAMPLES,
    STRIP_ALWAYS,
    isCombiningMarker,
    isWordLikeChar,
} from './constants.js';

const MARKER_CHARS = new Set(ALL_MARKERS);
const STRIP_ALWAYS_CHARS = new Set(STRIP_ALWAYS);
const WORD_BOUNDARY_RE = /[\p{L}\p{N}\p{M}_]/u;

// Each channel in the stack costs one sanitizer stage to remove, and the stages
// are independent: a Cf-stripper leaves the Mn markers, an Mn-stripper leaves
// the homoglyphs, an ASCII whitelist leaves nothing to match because the word
// no longer reads as the keyword. Density scales with the strength profile so a
// long keyword can absorb an edit-distance-2 fuzzy matcher.
const STRENGTH_PROFILES = Object.freeze({
    light: Object.freeze({ markers: 1, homoglyphs: 1 }),
    balanced: Object.freeze({ markers: 1, homoglyphs: 2 }),
    paranoid: Object.freeze({ markers: 2, homoglyphs: 3 }),
});

export function getStrengthProfile(strength) {
    return STRENGTH_PROFILES[strength] ?? STRENGTH_PROFILES.balanced;
}

const PROTECT_PATTERNS = [
    /```[\s\S]*?```/gu,           // fenced code blocks
    /`[^`\n]*`/gu,                // inline code
    /\bhttps?:\/\/[^\s<>"'`]+/giu // URLs
];

const CACHE_LIMIT = 200;
const CACHE_MAX_TEXT_LENGTH = 20000;
const FOLD_CACHE_LIMIT = 4096;
const textCache = new Map();
const foldCache = new Map();

let wordSegmenter = null;
let graphemeSegmenter = null;

function hashString(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function codePointLength(value) {
    return Array.from(value).length;
}

function patternKey(pattern) {
    return String(pattern).toLowerCase();
}

function containsMarker(value) {
    for (const ch of String(value ?? '')) {
        if (MARKER_CHARS.has(ch)) return true;
    }
    return false;
}

export function countMarkers(value) {
    let count = 0;
    for (const ch of String(value ?? '')) {
        if (MARKER_CHARS.has(ch)) count += 1;
    }
    return count;
}

// Combining markers are only stripped when they sit inside a word, which is the
// only place this extension puts them. A variation selector after an emoji base
// is meaningful (emoji presentation, ZWJ sequences) and stays untouched.
export function stripMarkersFromText(value) {
    const text = String(value ?? '');
    let result = '';
    let changed = false;
    let lastChar = '';
    for (const ch of text) {
        if (STRIP_ALWAYS_CHARS.has(ch)) {
            changed = true;
            continue;
        }
        if (isCombiningMarker(ch)) {
            if (lastChar && isWordLikeChar(lastChar)) {
                changed = true;
                continue;
            }
        }
        result += ch;
        lastChar = ch;
    }
    return changed ? result : text;
}

export function escapeZeroWidthForDisplay(text) {
    let result = '';
    for (const ch of String(text ?? '')) {
        result += MARKER_LABELS[ch] ? `⟦${MARKER_LABELS[ch]}⟧` : ch;
    }
    return result;
}

function sanitizeRule(rule, index = 0) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = String(rule.pattern ?? rule.text ?? '').trim();
    if (!pattern || containsMarker(pattern)) return null;
    return {
        id: String(rule.id ?? `rule-${index + 1}`),
        pattern,
        strictWord: Boolean(rule.strictWord),
        caseSensitive: Boolean(rule.caseSensitive),
        allWords: Boolean(rule.allWords ?? rule.multiWordUnicode),
    };
}

export function normalizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    const seen = new Set();
    const normalized = [];
    for (let index = 0; index < rules.length; index += 1) {
        const rule = sanitizeRule(rules[index], index);
        if (!rule) continue;
        const key = patternKey(rule.pattern);
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ ...rule, _order: index });
    }
    normalized.sort((a, b) => {
        const pointDiff = codePointLength(b.pattern) - codePointLength(a.pattern);
        if (pointDiff !== 0) return pointDiff;
        const unitDiff = b.pattern.length - a.pattern.length;
        if (unitDiff !== 0) return unitDiff;
        return a._order - b._order;
    });
    return normalized.map(({ _order, ...rule }) => rule);
}

// Case folding is per code point so Aho–Corasick match offsets stay aligned
// with the original text. Characters whose lowercase form changes length
// (e.g. Turkish İ) are compared as-is.
function foldChar(ch) {
    const cached = foldCache.get(ch);
    if (cached !== undefined) return cached;
    const lower = ch.toLowerCase();
    const folded = codePointLength(lower) === 1 ? lower : ch;
    if (foldCache.size > FOLD_CACHE_LIMIT) foldCache.clear();
    foldCache.set(ch, folded);
    return folded;
}

function buildAutomaton(entries) {
    const nodes = [{ next: new Map(), fail: 0, out: [] }];
    for (const { rule, cps } of entries) {
        let state = 0;
        for (const ch of cps) {
            let nextState = nodes[state].next.get(ch);
            if (nextState === undefined) {
                nextState = nodes.length;
                nodes.push({ next: new Map(), fail: 0, out: [] });
                nodes[state].next.set(ch, nextState);
            }
            state = nextState;
        }
        nodes[state].out.push({ rule, length: cps.length });
    }

    const queue = [];
    for (const child of nodes[0].next.values()) queue.push(child);
    for (let head = 0; head < queue.length; head += 1) {
        const state = queue[head];
        for (const [ch, child] of nodes[state].next) {
            let fail = nodes[state].fail;
            while (fail !== 0 && !nodes[fail].next.has(ch)) fail = nodes[fail].fail;
            const target = nodes[fail].next.get(ch);
            nodes[child].fail = target !== undefined && target !== child ? target : 0;
            if (nodes[child].fail !== 0) {
                nodes[child].out = nodes[child].out.concat(nodes[nodes[child].fail].out);
            }
            queue.push(child);
        }
    }
    return nodes;
}

export function buildMatcher(rules, options = {}) {
    const normalized = normalizeRules(rules);
    if (!normalized.length) return null;

    const markerSet = MARKER_SETS[options.markerSet] ?? MARKER_SETS.layered;
    const markerChars = [...markerSet.chars];
    const matcher = {
        rules: normalized.map((rule, order) => ({ ...rule, order })),
        markerChars,
        useHomoglyphs: Boolean(options.useHomoglyphs),
        profile: getStrengthProfile(options.strength),
        strength: options.strength ?? 'balanced',
        protectSpans: Boolean(options.protectSpans),
    };

    const sensitiveEntries = [];
    const insensitiveEntries = [];
    for (const rule of matcher.rules) {
        if (rule.caseSensitive) {
            sensitiveEntries.push({ rule, cps: Array.from(rule.pattern) });
        } else {
            insensitiveEntries.push({ rule, cps: Array.from(rule.pattern).map(foldChar) });
        }
    }

    matcher.automata = {
        sensitive: sensitiveEntries.length ? buildAutomaton(sensitiveEntries) : null,
        insensitive: insensitiveEntries.length ? buildAutomaton(insensitiveEntries) : null,
    };
    matcher.signature = JSON.stringify({
        markerChars,
        useHomoglyphs: matcher.useHomoglyphs,
        profile: matcher.profile,
        protectSpans: matcher.protectSpans,
        rules: matcher.rules.map(rule => [rule.pattern, rule.strictWord, rule.caseSensitive, rule.allWords, rule.order]),
    });
    return matcher;
}

function scanAutomaton(nodes, cps, fold, matches) {
    let state = 0;
    for (let index = 0; index < cps.length; index += 1) {
        const ch = fold ? foldChar(cps[index]) : cps[index];
        while (state !== 0 && !nodes[state].next.has(ch)) state = nodes[state].fail;
        const nextState = nodes[state].next.get(ch);
        state = nextState === undefined ? 0 : nextState;
        if (state === 0) continue;
        for (const out of nodes[state].out) {
            matches.push({ rule: out.rule, start: index + 1 - out.length, end: index + 1 });
        }
    }
}

function getWordSegmenter() {
    if (wordSegmenter !== null) return wordSegmenter;
    try {
        wordSegmenter = typeof Intl?.Segmenter === 'function'
            ? new Intl.Segmenter(undefined, { granularity: 'word' })
            : false;
    } catch {
        wordSegmenter = false;
    }
    return wordSegmenter;
}

function getGraphemeSegmenter() {
    if (graphemeSegmenter !== null) return graphemeSegmenter;
    try {
        graphemeSegmenter = typeof Intl?.Segmenter === 'function'
            ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
            : false;
    } catch {
        graphemeSegmenter = false;
    }
    return graphemeSegmenter;
}

function segmentWords(value) {
    const segmenter = getWordSegmenter();
    if (segmenter) {
        const parts = [];
        for (const part of segmenter.segment(value)) {
            parts.push({ segment: part.segment, isWordLike: Boolean(part.isWordLike) });
        }
        return parts;
    }
    const parts = [];
    const regex = /[\p{L}\p{N}\p{M}_]+/gu;
    let cursor = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
        if (match.index > cursor) parts.push({ segment: value.slice(cursor, match.index), isWordLike: false });
        parts.push({ segment: match[0], isWordLike: true });
        cursor = match.index + match[0].length;
    }
    if (cursor < value.length) parts.push({ segment: value.slice(cursor), isWordLike: false });
    return parts;
}

function splitGraphemes(value) {
    const segmenter = getGraphemeSegmenter();
    if (!segmenter) return Array.from(value);
    const clusters = [];
    for (const part of segmenter.segment(value)) clusters.push(part.segment);
    return clusters;
}

// Swap whole letters for non-NFKC-foldable lookalikes. Swaps are spread out and
// never adjacent to each other: adjacent swaps read as one foreign run (easy to
// spot) and cost the same edit distance as a spread pattern.
function applyHomoglyphs(word, maxSwaps, seed) {
    if (maxSwaps <= 0) return { word, swaps: 0 };
    const chars = Array.from(word);
    if (chars.length === 0) return { word, swaps: 0 };

    const candidates = [];
    // Very short keywords cannot take a marker without losing the word, so the
    // homoglyph channel is allowed to touch the first letter there. Longer words
    // keep the first letter Latin so the model still parses them instantly.
    const firstIndex = chars.length < 3 ? 0 : 1;
    for (let index = firstIndex; index < chars.length; index += 1) {
        if (HOMOGLYPHS.has(chars[index])) candidates.push(index);
    }
    if (!candidates.length) return { word, swaps: 0 };

    let rng = hashString(seed) || 0x9E3779B9;
    const used = new Set();
    let swaps = 0;
    const trySwap = (index, forbidNeighbours) => {
        if (used.has(index)) return false;
        if (forbidNeighbours && (used.has(index - 1) || used.has(index + 1))) return false;
        const variants = HOMOGLYPHS.get(chars[index]);
        if (!variants?.length) return false;
        chars[index] = variants[(rng >>> 8) % variants.length];
        used.add(index);
        swaps += 1;
        return true;
    };

    // Pass 1 keeps swaps apart for readability; pass 2 only fires when the word
    // cannot reach the profile's swap count otherwise, since raising the edit
    // distance matters more than letter spacing once a fuzzy matcher is in play.
    for (let attempt = 0; attempt < candidates.length * 2 && swaps < maxSwaps; attempt += 1) {
        rng = (Math.imul(rng, 0x01000193) ^ (rng >>> 13)) >>> 0;
        trySwap(candidates[rng % candidates.length], true);
    }
    for (let attempt = 0; attempt < candidates.length * 2 && swaps < maxSwaps; attempt += 1) {
        rng = (Math.imul(rng, 0x01000193) ^ (rng >>> 13)) >>> 0;
        trySwap(candidates[rng % candidates.length], false);
    }
    return { word: chars.join(''), swaps };
}

function pickMarker(markerChars, seed) {
    if (markerChars.length <= 1) return markerChars[0];
    return markerChars[hashString(seed) % markerChars.length];
}

// Evenly spaced insertion points across the grapheme clusters, so two markers
// do not stack next to each other and neither lands on a cluster boundary.
function markerPositions(clusterCount, wanted) {
    const positions = [];
    const total = Math.min(wanted, Math.max(1, clusterCount - 1));
    for (let slot = 1; slot <= total; slot += 1) {
        const raw = Math.round((clusterCount * slot) / (total + 1));
        const position = Math.max(1, Math.min(clusterCount - 1, raw));
        if (!positions.includes(position)) positions.push(position);
    }
    return positions.sort((a, b) => a - b);
}

function insertMarkers(word, wanted, markerChars, seed) {
    const clusters = splitGraphemes(word);
    if (clusters.length < 2) return word;
    const positions = markerPositions(clusters.length, Math.max(1, wanted));
    let result = '';
    let cursor = 0;
    for (const position of positions) {
        result += clusters.slice(cursor, position).join('') + pickMarker(markerChars, `${seed}\u0000${position}`);
        cursor = position;
    }
    result += clusters.slice(cursor).join('');
    return result;
}

function transformWord(word, config, seed) {
    const { word: swapped, swaps } = config.useHomoglyphs
        ? applyHomoglyphs(word, config.profile.homoglyphs, `${seed}\u0001h`)
        : { word, swaps: 0 };
    return {
        text: insertMarkers(swapped, config.profile.markers, config.markerChars, seed),
        swaps,
    };
}

function applySingleWordMatch(match, config, seed) {
    const parts = segmentWords(match);
    let bestIndex = -1;
    let bestLength = 0;
    for (let index = 0; index < parts.length; index += 1) {
        if (!parts[index].isWordLike) continue;
        const length = codePointLength(parts[index].segment);
        if (length > bestLength) {
            bestLength = length;
            bestIndex = index;
        }
    }
    if (bestIndex === -1) {
        return {
            text: insertMarkers(match, config.profile.markers, config.markerChars, seed),
            swaps: 0,
        };
    }
    let text = '';
    let swaps = 0;
    for (let index = 0; index < parts.length; index += 1) {
        if (index !== bestIndex) {
            text += parts[index].segment;
            continue;
        }
        const transformed = transformWord(parts[index].segment, config, `${seed}\u0000${index}`);
        text += transformed.text;
        swaps += transformed.swaps;
    }
    return { text, swaps };
}

function applyEveryWordMatch(match, config, seed) {
    const parts = segmentWords(match);
    let hasWord = false;
    let text = '';
    let swaps = 0;
    for (let index = 0; index < parts.length; index += 1) {
        if (!parts[index].isWordLike) {
            text += parts[index].segment;
            continue;
        }
        hasWord = true;
        const transformed = transformWord(parts[index].segment, config, `${seed}\u0000${index}`);
        text += transformed.text;
        swaps += transformed.swaps;
    }
    if (!hasWord) {
        return {
            text: insertMarkers(match, config.profile.markers, config.markerChars, seed),
            swaps: 0,
        };
    }
    return { text, swaps };
}

function transformMatch(match, rule, config, seed) {
    return rule.allWords
        ? applyEveryWordMatch(match, config, seed)
        : applySingleWordMatch(match, config, seed);
}

export function obfuscateForRule(match, rule, options = {}) {
    const markerSet = MARKER_SETS[options.markerSet] ?? MARKER_SETS.layered;
    const config = {
        markerChars: [...markerSet.chars],
        useHomoglyphs: Boolean(options.useHomoglyphs),
        profile: getStrengthProfile(options.strength),
    };
    const effectiveRule = {
        pattern: String(rule?.pattern ?? match),
        allWords: Boolean(rule?.allWords),
    };
    return transformMatch(String(match), effectiveRule, config, effectiveRule.pattern).text;
}

// Rebuilds the text the way a confusable-folding sanitizer would see it, so the
// filter test can report whether a homoglyph survives that stage.
export function foldHomoglyphsToAscii(value) {
    let result = '';
    for (const ch of String(value ?? '')) {
        result += CONFUSABLE_TO_LATIN.get(ch) ?? ch;
    }
    return result;
}

function findProtectedRanges(text) {
    const ranges = [];
    for (const pattern of PROTECT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            ranges.push([match.index, match.index + match[0].length]);
            if (match[0].length === 0) pattern.lastIndex += 1;
        }
    }
    if (!ranges.length) return ranges;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    return merged;
}

function buildUnitOffsets(cps) {
    const offsets = new Array(cps.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < cps.length; index += 1) {
        offsets[index + 1] = offsets[index] + cps[index].length;
    }
    return offsets;
}

function intersectsRanges(start, end, ranges) {
    let low = 0;
    let high = ranges.length - 1;
    let candidate = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (ranges[mid][1] > start) {
            candidate = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    return candidate !== -1 && ranges[candidate][0] < end;
}

function createStats() {
    return {
        replacements: 0,
        insertedMarkers: 0,
        swappedLetters: 0,
        ruleIds: new Set(),
        samples: [],
        sampleKeys: new Set(),
    };
}

function recordReplacement(stats, rule, match, transformed, swappedLetters = 0) {
    stats.replacements += 1;
    stats.ruleIds.add(rule.id);
    stats.insertedMarkers += Math.max(0, countMarkers(transformed) - countMarkers(match));
    stats.swappedLetters += swappedLetters;
    if (stats.samples.length >= MAX_REPORT_SAMPLES) return;
    const sampleKey = `${rule.id}\u0000${match}\u0000${transformed}`;
    if (stats.sampleKeys.has(sampleKey)) return;
    stats.sampleKeys.add(sampleKey);
    stats.samples.push({
        pattern: rule.pattern,
        before: match,
        after: escapeZeroWidthForDisplay(transformed),
    });
}

function applyTransform(text, matcher) {
    const cps = Array.from(text);
    const unitOffsets = buildUnitOffsets(cps);
    const protectedRanges = matcher.protectSpans ? findProtectedRanges(text) : [];

    const candidates = [];
    if (matcher.automata.sensitive) scanAutomaton(matcher.automata.sensitive, cps, false, candidates);
    if (matcher.automata.insensitive) scanAutomaton(matcher.automata.insensitive, cps, true, candidates);
    candidates.sort((a, b) => a.start - b.start || (b.end - a.end) || (a.rule.order - b.rule.order));

    const stats = createStats();
    let output = '';
    let lastUnit = 0;
    let acceptedEnd = 0;

    for (const candidate of candidates) {
        if (candidate.start < acceptedEnd) continue;

        if (candidate.rule.strictWord) {
            const before = cps[candidate.start - 1];
            const after = cps[candidate.end];
            if (before && WORD_BOUNDARY_RE.test(before)) continue;
            if (after && WORD_BOUNDARY_RE.test(after)) continue;
        }

        const unitStart = unitOffsets[candidate.start];
        const unitEnd = unitOffsets[candidate.end];
        if (protectedRanges.length && intersectsRanges(unitStart, unitEnd, protectedRanges)) continue;

        const match = cps.slice(candidate.start, candidate.end).join('');
        if (containsMarker(match)) continue;

        const transformed = transformMatch(
            match,
            candidate.rule,
            matcher,
            `${candidate.rule.pattern}\u0000${match}\u0000${candidate.start}`,
        );
        if (transformed.text === match) continue;

        output += text.slice(lastUnit, unitStart) + transformed.text;
        lastUnit = unitEnd;
        acceptedEnd = candidate.end;
        recordReplacement(stats, candidate.rule, match, transformed.text, transformed.swaps);
    }

    if (lastUnit === 0) return { transformed: text, stats };
    output += text.slice(lastUnit);
    return { transformed: output, stats };
}

export function transformTextWithStats(text, matcher) {
    if (!text) return { transformed: text, stats: createStats() };
    const cacheable = text.length <= CACHE_MAX_TEXT_LENGTH;
    const cacheKey = cacheable ? `${matcher.signature}\u0000${text}` : '';
    if (cacheable) {
        const cached = textCache.get(cacheKey);
        if (cached) {
            textCache.delete(cacheKey);
            textCache.set(cacheKey, cached);
            return cached;
        }
    }
    const result = applyTransform(text, matcher);
    if (cacheable) {
        textCache.set(cacheKey, result);
        if (textCache.size > CACHE_LIMIT) {
            const oldestKey = textCache.keys().next().value;
            textCache.delete(oldestKey);
        }
    }
    return result;
}

function hasSignatureLikeValue(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.some(item => hasSignatureLikeValue(item, seen));
    }

    for (const [key, nested] of Object.entries(value)) {
        if (/signature/i.test(key) && nested !== null && nested !== undefined && String(nested).length > 0) {
            return true;
        }
        if (nested && typeof nested === 'object' && hasSignatureLikeValue(nested, seen)) return true;
    }
    return false;
}

export function findLastSignedMessageIndex(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (hasSignatureLikeValue(chat[index])) return index;
    }
    return -1;
}

function createReport(matcher, protectedThrough) {
    return {
        activePatterns: matcher?.rules?.length ?? 0,
        replacements: 0,
        matchedPatterns: 0,
        textBlocks: 0,
        protectedMessages: protectedThrough >= 0 ? protectedThrough + 1 : 0,
        insertedMarkers: 0,
        swappedLetters: 0,
        samples: [],
        _matchedRuleIds: new Set(),
        _sampleKeys: new Set(),
        _verificationBlocks: [],
    };
}

function recordVerificationBlock(report, transformedText) {
    report._verificationBlocks.push(transformedText);
}

function applyToText(text, matcher, report) {
    const { transformed, stats } = transformTextWithStats(text, matcher);
    if (transformed === text) return text;

    report.replacements += stats.replacements;
    report.insertedMarkers += stats.insertedMarkers;
    report.swappedLetters += stats.swappedLetters;
    for (const ruleId of stats.ruleIds) report._matchedRuleIds.add(ruleId);
    for (const sample of stats.samples) {
        if (report.samples.length >= MAX_REPORT_SAMPLES) break;
        const sampleKey = `${sample.pattern}\u0000${sample.before}\u0000${sample.after}`;
        if (report._sampleKeys.has(sampleKey)) continue;
        report._sampleKeys.add(sampleKey);
        report.samples.push(sample);
    }
    report.textBlocks += 1;
    recordVerificationBlock(report, transformed);
    return transformed;
}

function isMutableTextRole(message) {
    const role = String(message?.role ?? '').toLowerCase();
    return role !== 'tool' && role !== 'function';
}

function collectSafePayloadText(messages) {
    const textBlocks = [];
    if (!Array.isArray(messages)) return textBlocks;

    for (const message of messages) {
        if (!message || typeof message !== 'object' || !isMutableTextRole(message)) continue;
        const content = message.content;
        if (typeof content === 'string') {
            textBlocks.push(content);
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue;
            textBlocks.push(block.text);
        }
    }
    return textBlocks;
}

export function verifyFinalPayload(generateData, verificationPlan) {
    const blocks = Array.isArray(verificationPlan?.blocks) ? verificationPlan.blocks : [];
    if (!blocks.length) {
        return {
            status: 'not_needed',
            expectedBlocks: 0,
            matchedBlocks: 0,
            expectedMarkers: 0,
            observedMarkers: 0,
            missingBlocks: 0,
        };
    }

    const expectedBlocks = blocks.reduce((sum, block) => sum + (block.count ?? 0), 0);
    // Chat payloads carry messages; text-completion payloads carry one flat
    // prompt string. Both shapes are checked, so text-mode dispatch is verified
    // instead of silently reporting "unavailable".
    const payloadTexts = collectSafePayloadText(generateData?.messages);
    if (!payloadTexts.length && typeof generateData?.prompt === 'string' && generateData.prompt) {
        payloadTexts.push(generateData.prompt);
    }
    if (!payloadTexts.length) {
        return {
            status: 'unavailable',
            reason: 'final payload text is unavailable',
            expectedBlocks,
            matchedBlocks: 0,
            expectedMarkers: verificationPlan.expectedMarkers ?? 0,
            observedMarkers: 0,
            missingBlocks: expectedBlocks,
        };
    }

    // Build exact-text occurrence counts and the marker total in one pass. The
    // previous implementation rescanned every payload text block once for every
    // expected verification block (O(expected * payload)), which becomes very
    // expensive on long chats or common-word rules.
    const textCounts = new Map();
    let observedMarkers = 0;
    for (const text of payloadTexts) {
        textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
        observedMarkers += countMarkers(text);
    }

    let matchedBlocks = 0;
    let missingBlocks = 0;
    for (const block of blocks) {
        const expected = Math.max(0, Number(block.count) || 0);
        const actual = textCounts.get(block.text) ?? 0;
        matchedBlocks += Math.min(expected, actual);
        missingBlocks += Math.max(0, expected - actual);
    }

    const expectedMarkers = Math.max(0, Number(verificationPlan.expectedMarkers) || 0);
    const blocksPresent = missingBlocks === 0;
    const markerFloorPresent = observedMarkers >= expectedMarkers;

    return {
        status: blocksPresent && markerFloorPresent ? 'verified' : 'failed',
        expectedBlocks,
        matchedBlocks,
        expectedMarkers,
        observedMarkers,
        missingBlocks,
    };
}

export function transformChatInPlace(chat, matcher) {
    const protectedThrough = findLastSignedMessageIndex(chat);
    const report = createReport(matcher, protectedThrough);
    if (!Array.isArray(chat) || !matcher?.rules?.length) return finalizeReport(report);

    // Stage copy-on-write replacements and commit only after the full walk succeeds.
    const stagedMessages = [];

    for (let index = protectedThrough + 1; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || typeof message !== 'object' || !isMutableTextRole(message)) continue;

        const content = message.content;
        if (typeof content === 'string') {
            const transformed = applyToText(content, matcher, report);
            if (transformed !== content) {
                stagedMessages.push([index, { ...message, content: transformed }]);
            }
            continue;
        }

        if (!Array.isArray(content)) continue;
        let nextContent = content;
        let contentChanged = false;

        for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
            const block = content[blockIndex];
            if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue;
            const transformed = applyToText(block.text, matcher, report);
            if (transformed === block.text) continue;

            if (!contentChanged) nextContent = content.slice();
            nextContent[blockIndex] = { ...block, text: transformed };
            contentChanged = true;
        }

        if (contentChanged) stagedMessages.push([index, { ...message, content: nextContent }]);
    }

    for (const [index, message] of stagedMessages) chat[index] = message;
    return finalizeReport(report);
}

function finalizeReport(report) {
    report.matchedPatterns = report._matchedRuleIds.size;
    const blockCounts = new Map();
    for (const text of report._verificationBlocks) blockCounts.set(text, (blockCounts.get(text) ?? 0) + 1);
    report.verificationPlan = {
        blocks: Array.from(blockCounts, ([text, count]) => ({ text, count })),
        expectedMarkers: report.insertedMarkers,
    };
    delete report._matchedRuleIds;
    delete report._sampleKeys;
    delete report._verificationBlocks;
    return report;
}
