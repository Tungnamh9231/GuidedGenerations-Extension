import { getContext } from '../../../../../extensions.js';
import {
    DEFAULT_LONG_PRESS_MS,
    GG_EXTENSION_NAME,
    UB_SCHEMA_VERSION,
    UB_SETTINGS_KEY,
} from './constants.js';

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

export function createDefaultUbSettings() {
    return {
        schemaVersion: UB_SCHEMA_VERSION,
        enabled: false,
        toolbar: {
            enabled: true,
            longPressMs: DEFAULT_LONG_PRESS_MS,
        },
        tabs: [
            {
                id: 'default-hjb',
                name: 'HJB',
                isDefault: true,
                enabled: true,
                changeEffort: true,
                blocks: [],
            },
        ],
    };
}

function sanitizePromptRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const identifier = String(ref.identifier ?? '').trim();
    if (!identifier) return null;
    return {
        identifier,
        nameSnapshot: String(ref.nameSnapshot ?? ref.name ?? identifier),
    };
}

function sanitizeBlock(block, index) {
    if (!block || typeof block !== 'object') return null;

    let promptRefs = [];
    if (Array.isArray(block.promptRefs)) {
        promptRefs = block.promptRefs.map(sanitizePromptRef).filter(Boolean);
    } else if (block.identifier) {
        const ref = sanitizePromptRef(block);
        if (ref) promptRefs = [ref];
    }

    if (!promptRefs.length) return null;

    return {
        id: String(block.id ?? `block-${index + 1}`),
        name: String(block.name ?? block.nameSnapshot ?? promptRefs[0].nameSnapshot ?? `Block ${index + 1}`),
        effort: String(block.effort ?? 'min'),
        promptRefs,
    };
}

function sanitizeTab(tab, index) {
    if (!tab || typeof tab !== 'object') return null;
    const blocks = Array.isArray(tab.blocks)
        ? tab.blocks.map(sanitizeBlock).filter(Boolean)
        : [];

    return {
        id: String(tab.id ?? `tab-${index + 1}`),
        name: String(tab.name ?? `TAB${index + 1}`),
        isDefault: Boolean(tab.isDefault ?? index === 0),
        enabled: tab.enabled !== false,
        changeEffort: tab.changeEffort !== false,
        blocks,
    };
}

function normalize(settings) {
    const defaults = createDefaultUbSettings();
    const source = settings && typeof settings === 'object' ? settings : {};
    const tabs = Array.isArray(source.tabs)
        ? source.tabs.map(sanitizeTab).filter(Boolean)
        : defaults.tabs;

    let defaultSeen = false;
    for (const tab of tabs) {
        if (tab.isDefault && !defaultSeen) {
            defaultSeen = true;
        } else if (tab.isDefault) {
            tab.isDefault = false;
        }
    }
    if (!defaultSeen && tabs[0]) tabs[0].isDefault = true;

    return {
        schemaVersion: UB_SCHEMA_VERSION,
        enabled: Boolean(source.enabled ?? defaults.enabled),
        toolbar: {
            enabled: Boolean(source.toolbar?.enabled ?? defaults.toolbar.enabled),
            longPressMs: Math.max(300, Math.min(3000, Number(source.toolbar?.longPressMs) || DEFAULT_LONG_PRESS_MS)),
        },
        tabs: tabs.length ? tabs : defaults.tabs,
    };
}

function getRoot() {
    const context = getContext();
    const root = context.extensionSettings;
    root[GG_EXTENSION_NAME] ??= {};
    return { context, extensionRoot: root[GG_EXTENSION_NAME] };
}

export function getUbSettings() {
    const { extensionRoot } = getRoot();
    const normalized = normalize(extensionRoot[UB_SETTINGS_KEY]);
    extensionRoot[UB_SETTINGS_KEY] = normalized;
    return clone(normalized);
}

export function peekUbSettings() {
    const { extensionRoot } = getRoot();
    return normalize(extensionRoot[UB_SETTINGS_KEY]);
}

export function saveUbSettings(nextSettings) {
    const { context, extensionRoot } = getRoot();
    const normalized = normalize(nextSettings);
    extensionRoot[UB_SETTINGS_KEY] = normalized;
    context.saveSettingsDebounced();
    return clone(normalized);
}

export function updateUbSettings(mutator) {
    const current = getUbSettings();
    const result = mutator(current) ?? current;
    return saveUbSettings(result);
}
