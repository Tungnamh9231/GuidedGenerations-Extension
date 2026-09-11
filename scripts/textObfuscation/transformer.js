import { MAX_REPORT_SAMPLES, ZERO_WIDTH_SPACE } from './constants.js';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codePointLength(value) {
    return Array.from(value).length;
}

function normalizeCase(value) {
    return value.toLowerCase();
}

export function normalizePatterns(patternsText) {
    const seen = new Set();
    const patterns = [];

    for (const rawLine of String(patternsText ?? '').split(/\r?\n/u)) {
        const pattern = rawLine.trim();
        if (!pattern || codePointLength(pattern) < 2 || pattern.includes(ZERO_WIDTH_SPACE)) continue;

        const key = normalizeCase(pattern);
        if (seen.has(key)) continue;
        seen.add(key);
        patterns.push(pattern);
    }

    patterns.sort((a, b) => {
        const pointDiff = codePointLength(b) - codePointLength(a);
        if (pointDiff !== 0) return pointDiff;
        return b.length - a.length;
    });
    return patterns;
}

export function buildMatcher(patternsText) {
    const patterns = normalizePatterns(patternsText);
    if (!patterns.length) return null;

    try {
        return {
            patterns,
            regex: new RegExp(patterns.map(escapeRegExp).join('|'), 'giu'),
        };
    } catch (error) {
        console.error('[GG Unicode Sensitive Words] Failed to compile matcher.', error);
        return null;
    }
}

export function obfuscateMatch(match) {
    if (!match || match.includes(ZERO_WIDTH_SPACE)) return match;
    const codePoint = match.codePointAt(0);
    if (codePoint === undefined) return match;
    const first = String.fromCodePoint(codePoint);
    if (first.length >= match.length) return match;
    return `${first}${ZERO_WIDTH_SPACE}${match.slice(first.length)}`;
}

export function escapeZeroWidthForDisplay(text) {
    return String(text ?? '').split(ZERO_WIDTH_SPACE).join('⟦ZWSP⟧');
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
        activePatterns: matcher?.patterns?.length ?? 0,
        replacements: 0,
        matchedPatterns: 0,
        textBlocks: 0,
        protectedMessages: protectedThrough >= 0 ? protectedThrough + 1 : 0,
        samples: [],
        _matchedKeys: new Set(),
        _sampleKeys: new Set(),
    };
}

function recordReplacement(report, match, transformed) {
    report.replacements += 1;
    report._matchedKeys.add(normalizeCase(match));

    const sampleKey = `${match}\u0000${transformed}`;
    if (report.samples.length >= MAX_REPORT_SAMPLES || report._sampleKeys.has(sampleKey)) return;
    report._sampleKeys.add(sampleKey);
    report.samples.push({
        before: match,
        after: escapeZeroWidthForDisplay(transformed),
    });
}

function transformText(text, matcher, report) {
    let changed = false;
    matcher.regex.lastIndex = 0;
    const transformed = text.replace(matcher.regex, match => {
        const next = obfuscateMatch(match);
        if (next === match) return match;
        changed = true;
        recordReplacement(report, match, next);
        return next;
    });
    if (changed) report.textBlocks += 1;
    return transformed;
}

function isMutableTextRole(message) {
    const role = String(message?.role ?? '').toLowerCase();
    return role !== 'tool' && role !== 'function';
}

export function transformChatInPlace(chat, matcher) {
    const protectedThrough = findLastSignedMessageIndex(chat);
    const report = createReport(matcher, protectedThrough);
    if (!Array.isArray(chat) || !matcher?.regex) return finalizeReport(report);

    // Stage copy-on-write replacements and commit them only after the full walk
    // succeeds. This prevents a thrown edge case from leaving a half-mutated
    // prompt in SillyTavern's generation pipeline.
    const stagedMessages = [];

    for (let index = protectedThrough + 1; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || typeof message !== 'object' || !isMutableTextRole(message)) continue;

        const content = message.content;
        if (typeof content === 'string') {
            const transformed = transformText(content, matcher, report);
            if (transformed !== content) stagedMessages.push([index, { ...message, content: transformed }]);
            continue;
        }

        if (!Array.isArray(content)) continue;
        let nextContent = content;
        let contentChanged = false;

        for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
            const block = content[blockIndex];
            if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue;
            const transformed = transformText(block.text, matcher, report);
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
    report.matchedPatterns = report._matchedKeys.size;
    delete report._matchedKeys;
    delete report._sampleKeys;
    return report;
}
