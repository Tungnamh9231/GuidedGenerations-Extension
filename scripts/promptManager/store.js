import { extensionName, extension_settings, saveSettingsDebounced, getContext, eventSource, event_types } from '../persistentGuides/guideExports.js';
import { getPromptValue, setPromptOverrideResolver } from '../utils/promptManager.js';
import { getPromptDefinition, PROMPT_SCOPE } from './registry.js';

export const RELATIVE = 0;
export const IN_CHAT = 1;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_ORDER = 100;
export const DEFAULT_ROLE = 'system';
export const DEFAULT_TOOL_ROLE = 'user';

// Values SillyTavern uses in context.extensionPrompts / extension_prompt_types.
export const EXTENSION_PROMPT_TYPES = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1 });
export const EXTENSION_PROMPT_ROLES = Object.freeze({ system: 0, user: 1, assistant: 2 });

// SillyTavern stores extension-injection roles as numbers.
const ROLE_BY_ID = { 0: 'system', 1: 'user', 2: 'assistant' };

function ensureStore() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    const settings = extension_settings[extensionName];
    if (!settings.promptManager) settings.promptManager = { order: [], prompts: {}, hidden: {} };
    if (!Array.isArray(settings.promptManager.order)) settings.promptManager.order = [];
    if (!settings.promptManager.prompts || typeof settings.promptManager.prompts !== 'object') {
        settings.promptManager.prompts = {};
    }
    if (!settings.promptManager.hidden || typeof settings.promptManager.hidden !== 'object') {
        settings.promptManager.hidden = {};
    }
    return settings.promptManager;
}

function legacyOverrideKey(key) {
    return `use${key.charAt(0).toUpperCase()}${key.slice(1)}SettingOverride`;
}

export function installPromptOverrideResolver() {
    setPromptOverrideResolver(key => extension_settings[extensionName]?.customPrompts?.[key]);
}

export function getBlockOrder() {
    return ensureStore().order;
}

export function setBlockOrder(order) {
    const store = ensureStore();
    const next = order.map(entry => ({ id: entry.id, after: entry.after ?? '' }));
    const nextIds = new Set(next.map(entry => entry.id));
    // Hidden blocks are not part of the dragged list, so keep their saved anchor
    // instead of silently moving them to the end of the order.
    for (const entry of store.order) {
        if (nextIds.has(entry.id)) continue;
        if (store.hidden[entry.id]) next.push({ id: entry.id, after: entry.after ?? '' });
    }
    store.order = next;
    saveSettingsDebounced();
}

// Blocks hidden here only disappear from the extension Prompt Manager list;
// the owning feature keeps working exactly as before.
export function isBlockHidden(blockId) {
    return Boolean(ensureStore().hidden[blockId]);
}

export function setBlockHidden(blockId, hidden) {
    const store = ensureStore();
    if (hidden) store.hidden[blockId] = true;
    else delete store.hidden[blockId];
    saveSettingsDebounced();
}

export function getHiddenBlocks() {
    return Object.keys(ensureStore().hidden);
}

// The prompt collection is assembled synchronously, so request-scoped prompts
// (a feature's own generation prompt) are announced here right before the
// request is built, and released once it finishes.
const requestSlots = new Map();
const injectionSlots = new Map();
let injectionCleanupArmed = false;
let sendBridgeActive = false;

export function setSendBridgeActive(active) {
    sendBridgeActive = Boolean(active);
}

export function isSendBridgeActive() {
    return sendBridgeActive;
}

export function registerRequestPromptSlot(slot, promptKey) {
    requestSlots.set(slot, promptKey);
}

export function releaseRequestPromptSlot(slot) {
    requestSlots.delete(slot);
}

export function getRequestPromptKey(slot) {
    return requestSlots.get(slot) ?? '';
}

// Announces a feature's own prompt to the send bridge right before the request
// is built, so the Prompt Manager can place it like any other prompt. Returns
// the slot name to pass to closeRequestPromptSlot afterwards ('' when the
// bridge cannot govern it and the caller should fall back to a plain message).
export function openRequestPromptSlot(context, promptKey, value) {
    if (!context || !promptKey || !isSendBridgeActive()) return '';
    const slot = `gg_request_${String(promptKey).replace(/\W/g, '_')}`;
    if (!context.extensionPrompts) context.extensionPrompts = {};
    const config = getPromptConfig(promptKey);
    context.extensionPrompts[slot] = {
        value,
        position: EXTENSION_PROMPT_TYPES.IN_CHAT,
        depth: config.depth,
        scan: false,
        role: EXTENSION_PROMPT_ROLES[config.role] ?? 0,
        filter: null,
    };
    requestSlots.set(slot, promptKey);
    return slot;
}

export function closeRequestPromptSlot(context, slot) {
    if (!slot) return;
    try { delete context?.extensionPrompts?.[slot]; } catch (error) { /* ignore */ }
    releaseRequestPromptSlot(slot);
}

// Prompts that a feature injects into the chat with a transient id (instruct,
// custom_<name>, ...) are mapped to their block until the generation ends.
export function registerInjectionPromptSlot(slot, promptKey) {
    injectionSlots.set(slot, promptKey);
    if (injectionCleanupArmed) return;
    if (!eventSource?.on || !event_types?.GENERATION_ENDED) return;
    injectionCleanupArmed = true;
    const clear = () => injectionSlots.clear();
    eventSource.on(event_types.GENERATION_ENDED, clear);
    eventSource.on(event_types.GENERATION_STOPPED, clear);
}

export function getInjectionPromptKey(slot) {
    return injectionSlots.get(slot) ?? '';
}

function isChatScoped(key) {
    return getPromptDefinition(key)?.prompt.scope === PROMPT_SCOPE.CHAT;
}

function defaultDepthFor(key) {
    const definition = getPromptDefinition(key);
    const flagKey = definition?.block?.flags?.depth;
    if (flagKey) {
        const flagValue = Number(extension_settings[extensionName]?.[flagKey]);
        if (Number.isFinite(flagValue)) return flagValue;
    }
    const explicit = definition?.prompt.defaults?.depth;
    return Number.isFinite(Number(explicit)) ? Number(explicit) : DEFAULT_DEPTH;
}

export function hasPromptConfig(key) {
    return Object.prototype.hasOwnProperty.call(ensureStore().prompts, key);
}

export function getPromptConfig(key) {
    const stored = ensureStore().prompts[key] ?? {};
    const definition = getPromptDefinition(key);
    const defaults = definition?.prompt.defaults ?? {};
    // Unset position defaults to in-chat for prompts the manager injects into the
    // chat, and to relative order for the ones a feature sends in its own request.
    const defaultPosition = defaults.position ?? (isChatScoped(key) ? IN_CHAT : RELATIVE);
    const defaultRole = defaults.role ?? (isChatScoped(key) ? DEFAULT_ROLE : DEFAULT_TOOL_ROLE);
    return {
        name: typeof stored.name === 'string' ? stored.name : '',
        role: stored.role ?? defaultRole,
        position: stored.position === undefined
            ? defaultPosition
            : (stored.position === IN_CHAT ? IN_CHAT : RELATIVE),
        depth: Number.isFinite(Number(stored.depth)) ? Number(stored.depth) : defaultDepthFor(key),
        order: Number.isFinite(Number(stored.order)) ? Number(stored.order) : DEFAULT_ORDER,
    };
}

// What the prompt will actually be sent with: the user's saved config when there
// is one, otherwise whatever the owning feature injected (or the defaults).
export function getEffectivePromptConfig(key, entryOverride = null) {
    const stored = getPromptConfig(key);
    if (hasPromptConfig(key)) return { ...stored, configured: true, source: 'user' };

    const slot = getPromptDefinition(key)?.prompt.slot;
    const entry = entryOverride ?? (slot ? getContext()?.extensionPrompts?.[slot] : null);
    if (!entry || typeof entry.value !== 'string' || !entry.value.trim()) {
        return { ...stored, configured: false, source: 'default' };
    }

    return {
        ...stored,
        role: ROLE_BY_ID[entry.role] ?? stored.role,
        position: entry.position === IN_CHAT
            ? IN_CHAT
            : (entry.position === EXTENSION_PROMPT_TYPES.NONE ? stored.position : RELATIVE),
        depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : stored.depth,
        configured: false,
        source: 'injection',
    };
}

export function setPromptConfig(key, patch) {
    const store = ensureStore();
    store.prompts[key] = { ...store.prompts[key], ...patch };
    saveSettingsDebounced();
}

// Drops the saved position/role/depth so the prompt goes back to whatever the
// owning feature (or SillyTavern) does by default.
export function resetPromptConfig(key) {
    const store = ensureStore();
    if (Object.prototype.hasOwnProperty.call(store.prompts, key)) {
        delete store.prompts[key];
        saveSettingsDebounced();
    }
}

export async function readPromptText(key) {
    const definition = getPromptDefinition(key);
    const settings = definition && !key.includes('.') ? extension_settings[extensionName] : null;
    return await getPromptValue(key, '', { settings, settingsKey: key });
}

export function writePromptText(key, text) {
    if (!extension_settings[extensionName].customPrompts) extension_settings[extensionName].customPrompts = {};
    extension_settings[extensionName].customPrompts[key] = text;

    // Keys without a dot are also read by the legacy path, so keep both stores equal.
    if (!key.includes('.')) {
        extension_settings[extensionName][key] = text;
        extension_settings[extensionName][legacyOverrideKey(key)] = false;
    }
    saveSettingsDebounced();
}

export function resetPromptText(key) {
    const settings = extension_settings[extensionName];
    delete settings.customPrompts?.[key];
    if (!key.includes('.')) {
        delete settings[key];
        settings[legacyOverrideKey(key)] = true;
    }
    saveSettingsDebounced();
}
