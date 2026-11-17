import { getContext } from '../../../../../extensions.js';
import {
    ALL_MARKERS,
    GG_EXTENSION_NAME,
    MARKER_SETS,
    SETTINGS_KEY,
    SETTINGS_SCHEMA_VERSION,
} from './constants.js';

const MARKER_CHARS = new Set(ALL_MARKERS);

const DEFAULTS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: false,
    rules: [],
    markerSet: 'balanced',
    useHomoglyphs: false,
    stripIncoming: true,
    protectSpans: true,
});

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
    }
    return value == null ? fallback : Boolean(value);
}

function containsMarker(value) {
    for (const ch of String(value ?? '')) {
        if (MARKER_CHARS.has(ch)) return true;
    }
    return false;
}

function patternKey(pattern) {
    return String(pattern).toLowerCase();
}

function sanitizeRule(rule, index) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = String(rule.pattern ?? rule.text ?? '').trim();
    if (!pattern || containsMarker(pattern)) return null;
    return {
        id: String(rule.id ?? `rule-${index + 1}`),
        pattern,
        strictWord: toBoolean(rule.strictWord, false),
        caseSensitive: toBoolean(rule.caseSensitive, false),
        allWords: toBoolean(rule.allWords ?? rule.multiWordUnicode, false),
    };
}

function legacyRules(source) {
    const legacyText = String(source.patternsText ?? source.words ?? '').replace(/\r\n?/gu, '\n');
    const seen = new Set();
    const rules = [];
    for (const rawLine of legacyText.split('\n')) {
        const pattern = rawLine.trim();
        const key = patternKey(pattern);
        if (!pattern || containsMarker(pattern) || seen.has(key)) continue;
        seen.add(key);
        rules.push({
            id: `legacy-${rules.length + 1}`,
            pattern,
            strictWord: false,
            caseSensitive: false,
            allWords: false,
        });
    }
    return rules;
}

function normalize(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const sourceRules = Array.isArray(source.rules)
        ? source.rules.map(sanitizeRule).filter(Boolean)
        : legacyRules(source);

    const seen = new Set();
    const rules = [];
    for (const rule of sourceRules) {
        // Case variants share one rule. Casing behavior belongs to the rule's
        // Case sensitive option; allowing both would create order-dependent matches.
        const key = patternKey(rule.pattern);
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push(rule);
    }

    const markerSet = Object.prototype.hasOwnProperty.call(MARKER_SETS, source.markerSet)
        ? source.markerSet
        : DEFAULTS.markerSet;

    return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        enabled: toBoolean(source.enabled, DEFAULTS.enabled),
        rules,
        markerSet,
        useHomoglyphs: toBoolean(source.useHomoglyphs, DEFAULTS.useHomoglyphs),
        stripIncoming: toBoolean(source.stripIncoming, DEFAULTS.stripIncoming),
        protectSpans: toBoolean(source.protectSpans, DEFAULTS.protectSpans),
    };
}

function getExtensionRoot() {
    const context = getContext();
    const root = context.extensionSettings;
    root[GG_EXTENSION_NAME] ??= {};
    return { context, extensionRoot: root[GG_EXTENSION_NAME] };
}

export function getTextObfuscationSettings() {
    const { extensionRoot } = getExtensionRoot();
    const normalized = normalize(extensionRoot[SETTINGS_KEY]);
    extensionRoot[SETTINGS_KEY] = normalized;
    return clone(normalized);
}

export function peekTextObfuscationSettings() {
    const { extensionRoot } = getExtensionRoot();
    return normalize(extensionRoot[SETTINGS_KEY]);
}

export function saveTextObfuscationSettings(nextSettings) {
    const { context, extensionRoot } = getExtensionRoot();
    const normalized = normalize(nextSettings);
    extensionRoot[SETTINGS_KEY] = normalized;
    context.saveSettingsDebounced();
    return clone(normalized);
}
