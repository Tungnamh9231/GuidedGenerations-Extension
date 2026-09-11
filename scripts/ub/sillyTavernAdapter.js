import { getContext } from '../../../../../extensions.js';
import { promptManager, reasoning_effort_types } from '../../../../../openai.js';
import { EFFORT_VALUES, UB_BUTTON_ATTR } from './constants.js';

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

export async function applyPromptEnabledMap(enabledByIdentifier) {
    if (!isPromptManagerReady()) {
        return { changed: false, missing: [...enabledByIdentifier.keys()], unavailable: true };
    }

    // Resolve everything before mutating anything. This makes state application
    // transactional with respect to missing/deleted prompts.
    const resolved = [];
    const missing = [];
    for (const [identifier, enabled] of enabledByIdentifier.entries()) {
        const entry = getOrderEntry(identifier);
        if (!entry) missing.push(identifier);
        else resolved.push({ entry, enabled: Boolean(enabled) });
    }
    if (missing.length) return { changed: false, missing, unavailable: false };

    let changed = false;
    const previous = resolved.map(({ entry }) => ({ entry, enabled: Boolean(entry.enabled) }));
    for (const { entry, enabled } of resolved) {
        if (Boolean(entry.enabled) !== enabled) {
            entry.enabled = enabled;
            changed = true;
        }
    }

    if (changed) {
        promptManager.render();
        try {
            await promptManager.saveServiceSettings();
        } catch (error) {
            // Restore in-memory state as well as the rendered Prompt Manager if
            // persistence fails, so callers never observe a half-applied state.
            for (const item of previous) item.entry.enabled = item.enabled;
            promptManager.render();
            throw error;
        }
    }

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

    // UI-only synchronization. The setting object above remains the source of truth.
    const select = document.getElementById('openai_reasoning_effort');
    if (select && select.value !== normalized) select.value = normalized;

    if (changed) context.saveSettingsDebounced();
    return changed;
}

export function getEventBus() {
    const context = getContext();
    return { eventSource: context.eventSource, eventTypes: context.eventTypes };
}

export function getMessageElement(messageId) {
    const id = CSS.escape(String(messageId));
    return document.querySelector(`#chat > .mes[mesid="${id}"]`);
}

export function getDisplayedMessageIds() {
    return [...document.querySelectorAll('#chat > .mes[mesid]')]
        .map(element => element.getAttribute('mesid'))
        .filter(id => id !== null);
}

export function resolveMessageToolbar(messageId) {
    const message = getMessageElement(messageId);
    if (!message) return null;
    return message.querySelector('.extraMesButtons') || message.querySelector('.mes_buttons');
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
