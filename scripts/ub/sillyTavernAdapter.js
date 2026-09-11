import { getContext } from '../../../../../extensions.js';
import { promptManager, reasoning_effort_types } from '../../../../../openai.js';
import { EFFORT_VALUES, UB_BUTTON_ATTR } from './constants.js';

const HIDDEN_EXTRA_ATTR = 'data-gg-native-ub-hidden-extra';
const PREV_DISPLAY_ATTR = 'data-gg-native-ub-prev-display';
const PREV_PRIORITY_ATTR = 'data-gg-native-ub-prev-display-priority';

const VALID_EFFORTS = new Set([
    reasoning_effort_types?.min ?? 'min',
    reasoning_effort_types?.low ?? 'low',
    reasoning_effort_types?.medium ?? 'medium',
    reasoning_effort_types?.high ?? 'high',
    reasoning_effort_types?.max ?? 'max',
]);

export function getStContext() {
    return getContext();
}

export function isPromptManagerReady() {
    return Boolean(
        promptManager
        && promptManager.activeCharacter
        && promptManager.serviceSettings
        && Array.isArray(promptManager.serviceSettings.prompts)
        && typeof promptManager.getPromptOrderEntry === 'function'
    );
}

function getOrderEntry(identifier) {
    if (!isPromptManagerReady()) return null;
    try {
        return promptManager.getPromptOrderEntry(promptManager.activeCharacter, identifier) ?? null;
    } catch (error) {
        console.warn('[GG Native UB] Could not resolve prompt order entry:', identifier, error);
        return null;
    }
}

function getPromptRow(identifier) {
    const escapedIdentifier = CSS.escape(String(identifier));
    const prefix = String(promptManager?.configuration?.prefix ?? 'completion_');
    const listId = `${prefix}prompt_manager_list`;
    return document.querySelector(`#${CSS.escape(listId)} [data-pm-identifier="${escapedIdentifier}"]`)
        ?? document.querySelector(`[data-pm-identifier="${escapedIdentifier}"]`);
}

function syncPromptDomState(identifier, enabled) {
    const row = getPromptRow(identifier);
    if (!row) return;

    const prefix = String(promptManager?.configuration?.prefix ?? 'completion_');
    row.classList.toggle(`${prefix}prompt_manager_prompt_disabled`, !enabled);

    // Compatibility with current and older PromptManager controls. The row class
    // is the canonical visual state in current ST; these are best-effort mirrors.
    const toggle = row.querySelector('.prompt_manager_enable_cb, label.checkbox_label input, .prompt-manager-toggle-action');
    if (toggle instanceof HTMLInputElement) {
        toggle.checked = Boolean(enabled);
    } else if (toggle instanceof Element) {
        if (toggle.hasAttribute('aria-checked')) toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        if (toggle.hasAttribute('aria-pressed')) toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
}

function invalidatePromptTokenCount(identifier) {
    try {
        const counts = promptManager?.tokenHandler?.getCounts?.();
        if (counts && typeof counts === 'object') counts[identifier] = null;
    } catch (error) {
        // Token counts are UI/cache metadata. State application must not fail if
        // an upstream TokenHandler implementation changes.
        console.debug('[GG Native UB] Could not invalidate prompt token count:', identifier, error);
    }
}

function persistPromptManagerInBackground() {
    try {
        const result = promptManager.saveServiceSettings?.();
        if (result && typeof result.catch === 'function') {
            result.catch(error => {
                console.error('[GG Native UB] Prompt state changed in memory but persistence failed:', error);
                globalThis.toastr?.error?.('UB prompt state changed, but SillyTavern failed to save settings.');
            });
        }
    } catch (error) {
        console.error('[GG Native UB] Prompt state changed in memory but persistence failed:', error);
        globalThis.toastr?.error?.('UB prompt state changed, but SillyTavern failed to save settings.');
    }
}

export function listPromptEntries() {
    if (!isPromptManagerReady()) return [];
    return promptManager.serviceSettings.prompts
        .filter(prompt => prompt?.identifier && !prompt.marker)
        .map(prompt => {
            const entry = getOrderEntry(prompt.identifier);
            return {
                identifier: String(prompt.identifier),
                name: String(prompt.name || prompt.identifier),
                role: String(prompt.role || ''),
                enabled: entry ? Boolean(entry.enabled) : false,
                inOrder: Boolean(entry),
            };
        })
        .filter(prompt => prompt.inOrder);
}

export function getPromptEnabled(identifier) {
    const entry = getOrderEntry(identifier);
    return entry ? Boolean(entry.enabled) : null;
}

/**
 * Apply a complete UB prompt-state map using SillyTavern's own PromptManager
 * model, but deliberately avoid PromptManager.render() on the hot path.
 *
 * PromptManager.render() performs tryGenerate() by default before repainting the
 * manager. Awaiting that for every toolbar click made UB transitions feel slow
 * and could keep the toolbar locked for seconds. ST's own toggle handler mutates
 * promptOrderEntry.enabled and invalidates token counts before render/save, so we
 * perform those state mutations directly, mirror the visible row state, and let
 * settings persistence run in the background.
 */
export async function applyPromptEnabledMap(enabledByIdentifier) {
    if (!isPromptManagerReady()) {
        return { changed: false, missing: [...enabledByIdentifier.keys()], unavailable: true };
    }

    // Resolve every identifier before changing any state. This preserves the
    // all-or-nothing behavior for deleted/missing prompts.
    const resolved = [];
    const missing = [];
    for (const [identifier, enabled] of enabledByIdentifier.entries()) {
        const entry = getOrderEntry(identifier);
        if (!entry) missing.push(identifier);
        else resolved.push({ identifier, entry, enabled: Boolean(enabled) });
    }
    if (missing.length) return { changed: false, missing, unavailable: false };

    let changed = false;
    for (const { identifier, entry, enabled } of resolved) {
        if (Boolean(entry.enabled) === enabled) {
            syncPromptDomState(identifier, enabled);
            continue;
        }

        entry.enabled = enabled;
        invalidatePromptTokenCount(identifier);
        syncPromptDomState(identifier, enabled);
        changed = true;
    }

    if (changed) persistPromptManagerInBackground();
    return { changed, missing: [], unavailable: false };
}

export function getReasoningEffort() {
    return String(getContext().chatCompletionSettings?.reasoning_effort ?? 'auto');
}

export function normalizeEffort(effort) {
    const value = String(effort ?? '').toLowerCase();
    if (VALID_EFFORTS.has(value)) return value;
    if (EFFORT_VALUES.includes(value)) return value;
    return 'min';
}

export function setReasoningEffort(effort) {
    const context = getContext();
    const settings = context.chatCompletionSettings;
    if (!settings) return false;

    const normalized = normalizeEffort(effort);
    const changed = settings.reasoning_effort !== normalized;
    settings.reasoning_effort = normalized;

    const select = document.getElementById('openai_reasoning_effort');
    if (select && select.value !== normalized) {
        select.value = normalized;
        // Keep SillyTavern's own input-driven UI/settings listeners in sync while
        // retaining the settings object above as the source of truth.
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (changed) context.saveSettingsDebounced();
    return changed;
}

export function getEventBus() {
    const context = getContext();
    return { eventSource: context.eventSource, eventTypes: context.eventTypes };
}

function normalizeMessageId(value) {
    if (value && typeof value === 'object') {
        return value.messageId ?? value.mesId ?? value.id ?? null;
    }
    return value;
}

export function getMessageElement(messageId) {
    const normalized = normalizeMessageId(messageId);
    if (normalized === null || normalized === undefined) return null;
    const id = CSS.escape(String(normalized));
    return document.querySelector(`#chat .mes[mesid="${id}"]`);
}

export function getDisplayedMessageIds() {
    return [...document.querySelectorAll('#chat .mes[mesid]')]
        .map(element => element.getAttribute('mesid'))
        .filter(id => id !== null);
}

export function resolveMessageToolbar(messageId) {
    return getMessageElement(messageId)?.querySelector('.mes_buttons') ?? null;
}

function isCopyButton(element) {
    if (!(element instanceof Element)) return false;
    const text = [
        element.getAttribute('title'),
        element.getAttribute('aria-label'),
        element.getAttribute('data-i18n'),
        element.dataset?.i18n,
    ].filter(Boolean).join(' ').toLowerCase();
    if (text.includes('copy')) return true;
    if (element.classList.contains('mes_copy')) return true;
    return Boolean(element.querySelector('.fa-copy, .fa-clone'));
}

function restoreElementDisplay(element) {
    if (!element.hasAttribute(HIDDEN_EXTRA_ATTR)) return;
    const previous = element.getAttribute(PREV_DISPLAY_ATTR) ?? '';
    const priority = element.getAttribute(PREV_PRIORITY_ATTR) ?? '';
    if (previous) element.style.setProperty('display', previous, priority);
    else element.style.removeProperty('display');
    element.removeAttribute(HIDDEN_EXTRA_ATTR);
    element.removeAttribute(PREV_DISPLAY_ATTR);
    element.removeAttribute(PREV_PRIORITY_ATTR);
}

function hideElementDisplay(element) {
    if (!(element instanceof Element)) return;
    if (!element.hasAttribute(HIDDEN_EXTRA_ATTR)) {
        element.setAttribute(PREV_DISPLAY_ATTR, element.style.getPropertyValue('display') || '');
        element.setAttribute(PREV_PRIORITY_ATTR, element.style.getPropertyPriority('display') || '');
        element.setAttribute(HIDDEN_EXTRA_ATTR, 'true');
    }
    element.style.setProperty('display', 'none', 'important');
}

/**
 * Reproduce the userscript's compact toolbar layout without destroying native
 * nodes: all extra message actions are hidden except Copy, and can be restored
 * exactly when Native UB is disabled. Since the compact toolbar keeps its two
 * useful extra actions (F + Copy) visible, SillyTavern's ellipsis expander is
 * also hidden; otherwise clicking it can collapse the extra container and leave
 * an empty reserved area between UB controls and the native edit action.
 */
export function compactMessageToolbar(messageId) {
    const message = getMessageElement(messageId);
    if (!message) return null;
    const mesButtons = message.querySelector('.mes_buttons');
    if (!mesButtons) return null;
    const extraButtons = mesButtons.querySelector('.extraMesButtons');
    if (!extraButtons) return mesButtons;

    const extraButtonsHint = mesButtons.querySelector('.extraMesButtonsHint');
    if (extraButtonsHint) hideElementDisplay(extraButtonsHint);

    for (const child of [...extraButtons.children]) {
        if (child.hasAttribute(UB_BUTTON_ATTR)) continue;
        if (isCopyButton(child)) {
            restoreElementDisplay(child);
            continue;
        }
        hideElementDisplay(child);
    }

    extraButtons.classList.add('gg-native-ub-extra-compact');
    return mesButtons;
}

export function restoreCompactedMessageToolbars() {
    document.querySelectorAll(`[${HIDDEN_EXTRA_ATTR}]`).forEach(restoreElementDisplay);
    document.querySelectorAll('.gg-native-ub-extra-compact').forEach(element => element.classList.remove('gg-native-ub-extra-compact'));
}

export function removeOwnedMessageButtons() {
    document.querySelectorAll(`[${UB_BUTTON_ATTR}]`).forEach(element => element.remove());
}

export function getPopupApi() {
    const context = getContext();
    return {
        Popup: context.Popup,
        POPUP_TYPE: context.POPUP_TYPE,
        POPUP_RESULT: context.POPUP_RESULT,
    };
}
