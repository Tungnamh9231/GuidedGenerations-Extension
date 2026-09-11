import { getContext } from '../../../../../extensions.js';
import { GG_EXTENSION_NAME, SETTINGS_KEY, SETTINGS_SCHEMA_VERSION } from './constants.js';

const DEFAULTS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: false,
    patternsText: '',
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

function normalize(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        enabled: toBoolean(source.enabled, DEFAULTS.enabled),
        patternsText: String(source.patternsText ?? source.words ?? DEFAULTS.patternsText).replace(/\r\n?/gu, '\n'),
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
