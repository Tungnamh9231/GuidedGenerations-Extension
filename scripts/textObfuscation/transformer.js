import { MAX_REPORT_SAMPLES, ZERO_WIDTH_SPACE } from './constants.js';

const WORD_BOUNDARY_CLASS = '\\p{L}\\p{N}\\p{M}_';
let wordSegmenter = null;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codePointLength(value) {
    return Array.from(value).length;
}

function patternKey(pattern) {
    return String(pattern).toLowerCase();
}

function countOccurrences(value, needle) {
    if (!needle) return 0;
    let count = 0;
    let cursor = 0;
    while (cursor <= value.length - needle.length) {
        const index = value.indexOf(needle, cursor);
        if (index === -1) break;
        count += 1;
        cursor = index + needle.length;
    }
    return count;
}

function sanitizeRule(rule, index = 0) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = String(rule.pattern ?? rule.text ?? '').trim();
    if (!pattern || pattern.includes(ZERO_WIDTH_SPACE)) return null;
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

function compileRule(rule) {
    const escaped = escapeRegExp(rule.pattern);
    const flags = rule.caseSensitive ? 'gu' : 'giu';
    if (rule.strictWord) {
        return {
            ...rule,
            regex: new RegExp(`(^|[^${WORD_BOUNDARY_CLASS}])(${escaped})(?![${WORD_BOUNDARY_CLASS}])`, flags),
            matchGroup: 2,
            prefixGroup: 1,
        };
    }
    return {
        ...rule,
        regex: new RegExp(`(${escaped})`, flags),
        matchGroup: 1,
        prefixGroup: 0,
    };
}

export function buildMatcher(rules) {
    const normalized = normalizeRules(rules);
    if (!normalized.length) return null;
    try {
        return { rules: normalized.map(compileRule) };
    } catch (error) {
        console.error('[GG Unicode Sensitive Words] Failed to compile rule matcher.', error);
        return null;
    }
}

function insertAfterFirstCodePoint(value) {
    if (!value || value.includes(ZERO_WIDTH_SPACE)) return value;
    const codePoint = value.codePointAt(0);
    if (codePoint === undefined) return value;
    const first = String.fromCodePoint(codePoint);
    return `${first}${ZERO_WIDTH_SPACE}${value.slice(first.length)}`;
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

function insertIntoEveryWord(value) {
    const segmenter = getWordSegmenter();
    if (segmenter) {
        let result = '';
        let cursor = 0;
        let changed = false;
        for (const part of segmenter.segment(value)) {
            result += value.slice(cursor, part.index);
            if (part.isWordLike) {
                const transformed = insertAfterFirstCodePoint(part.segment);
                result += transformed;
                changed ||= transformed !== part.segment;
            } else {
                result += part.segment;
            }
            cursor = part.index + part.segment.length;
        }
        result += value.slice(cursor);
        return changed ? result : insertAfterFirstCodePoint(value);
    }

    let changed = false;
    const transformed = value.replace(/[\p{L}\p{N}\p{M}_]+/gu, word => {
        const next = insertAfterFirstCodePoint(word);
        changed ||= next !== word;
        return next;
    });
    return changed ? transformed : insertAfterFirstCodePoint(value);
}

export function obfuscateForRule(match, rule) {
    return rule?.allWords ? insertIntoEveryWord(match) : insertAfterFirstCodePoint(match);
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
        activePatterns: matcher?.rules?.length ?? 0,
        replacements: 0,
        matchedPatterns: 0,
        textBlocks: 0,
        protectedMessages: protectedThrough >= 0 ? protectedThrough + 1 : 0,
        insertedMarkers: 0,
        samples: [],
        _matchedRuleIds: new Set(),
        _sampleKeys: new Set(),
        _verificationBlocks: [],
    };
}

function recordReplacement(report, rule, match, transformed) {
    report.replacements += 1;
    report._matchedRuleIds.add(rule.id);
    report.insertedMarkers += Math.max(0, countOccurrences(transformed, ZERO_WIDTH_SPACE) - countOccurrences(match, ZERO_WIDTH_SPACE));

    const sampleKey = `${rule.id}\u0000${match}\u0000${transformed}`;
    if (report.samples.length >= MAX_REPORT_SAMPLES || report._sampleKeys.has(sampleKey)) return;
    report._sampleKeys.add(sampleKey);
    report.samples.push({
        pattern: rule.pattern,
        before: match,
        after: escapeZeroWidthForDisplay(transformed),
    });
}

function recordVerificationBlock(report, transformedText) {
    report._verificationBlocks.push(transformedText);
}

function transformWithRule(text, rule, report) {
    rule.regex.lastIndex = 0;
    return text.replace(rule.regex, (...args) => {
        const fullMatch = args[0];
        const source = args.at(-1);
        const offset = args.at(-2);
        const prefix = rule.prefixGroup ? (args[rule.prefixGroup] ?? '') : '';
        const match = args[rule.matchGroup] ?? fullMatch;
        const firstCodePoint = match.codePointAt(0);
        if (firstCodePoint === undefined) return fullMatch;

        // Idempotency for single-code-point patterns: their marker sits directly
        // after the matched character, so the literal pattern would otherwise
        // still match on a second pass.
        const matchStart = offset + prefix.length;
        const first = String.fromCodePoint(firstCodePoint);
        if (match.includes(ZERO_WIDTH_SPACE) || source[matchStart + first.length] === ZERO_WIDTH_SPACE) {
            return fullMatch;
        }

        const transformed = obfuscateForRule(match, rule);
        if (transformed === match) return fullMatch;
        recordReplacement(report, rule, match, transformed);
        return `${prefix}${transformed}`;
    });
}

function transformText(text, matcher, report) {
    let transformed = text;
    for (const rule of matcher.rules) {
        transformed = transformWithRule(transformed, rule, report);
    }
    if (transformed !== text) report.textBlocks += 1;
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
    if (!Array.isArray(generateData?.messages)) {
        return {
            status: 'unavailable',
            reason: 'final payload messages are unavailable',
            expectedBlocks,
            matchedBlocks: 0,
            expectedMarkers: verificationPlan.expectedMarkers ?? 0,
            observedMarkers: 0,
            missingBlocks: expectedBlocks,
        };
    }

    const textBlocks = collectSafePayloadText(generateData.messages);
    let matchedBlocks = 0;
    let missingBlocks = 0;

    for (const block of blocks) {
        const expected = Math.max(0, Number(block.count) || 0);
        const actual = textBlocks.reduce((sum, text) => sum + (text === block.text ? 1 : 0), 0);
        matchedBlocks += Math.min(expected, actual);
        missingBlocks += Math.max(0, expected - actual);
    }

    const expectedMarkers = Math.max(0, Number(verificationPlan.expectedMarkers) || 0);
    const observedMarkers = textBlocks.reduce((sum, text) => sum + countOccurrences(text, ZERO_WIDTH_SPACE), 0);
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
            const transformed = transformText(content, matcher, report);
            if (transformed !== content) {
                recordVerificationBlock(report, transformed);
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
            const transformed = transformText(block.text, matcher, report);
            if (transformed === block.text) continue;

            recordVerificationBlock(report, transformed);
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
