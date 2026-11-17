import { promptManager } from '../../../../../openai.js';
import { getTokenCountAsync } from '../../../../../tokenizers.js';

// Mirrors the native list: whatever SillyTavern renders in its own prompt
// manager is exactly what shows up here, in the same order and state.
const INJECTION_POSITION_ABSOLUTE = 1;

export function getNativePromptManager() {
    return promptManager;
}

export function isNativeListAvailable() {
    const manager = promptManager;
    return Boolean(manager?.serviceSettings && Array.isArray(manager.serviceSettings.prompts));
}

function describeIcon(prompt) {
    if (prompt.injection_position === INJECTION_POSITION_ABSOLUTE) return { icon: 'fa-syringe', title: 'In-Chat Injection' };
    if (prompt.marker) return { icon: 'fa-thumb-tack', title: 'Marker' };
    if (prompt.system_prompt && prompt.forbid_overrides) return { icon: 'fa-star', title: 'Important Prompt' };
    if (prompt.system_prompt) return { icon: 'fa-square-poll-horizontal', title: 'Global Prompt' };
    return { icon: 'fa-asterisk', title: 'Preset Prompt' };
}

export function readNativeRows() {
    const manager = promptManager;
    if (!isNativeListAvailable()) return [];

    const counts = manager.tokenHandler?.getCounts() ?? {};
    const rows = [];

    for (const entry of manager.getPromptOrderForCharacter(manager.activeCharacter)) {
        if (!entry) continue;
        const prompt = manager.getPromptById(entry.identifier);
        if (!prompt) continue;

        const { icon, title } = describeIcon(prompt);
        rows.push({
            id: prompt.identifier,
            name: prompt.name,
            role: prompt.role ?? 'system',
            enabled: entry.enabled !== false,
            tokens: counts[prompt.identifier] ?? 0,
            injection: prompt.injection_position === INJECTION_POSITION_ABSOLUTE,
            depth: prompt.injection_depth,
            order: prompt.injection_order,
            icon,
            iconTitle: title,
        });
    }

    return rows;
}

export function readNativeTotals() {
    const manager = promptManager;
    if (!manager) return { tokens: 0, budget: 0 };
    const budget = (manager.serviceSettings?.openai_max_context ?? 0) - (manager.serviceSettings?.openai_max_tokens ?? 0);
    return { tokens: manager.tokenUsage ?? 0, budget: Math.max(0, budget) };
}

// SillyTavern rebuilds #completion_prompt_manager with innerHTML on every
// render, so a subtree observer catches every native change (reorder, toggle,
// edit, preset switch, character switch).
export function watchNativeList(callback) {
    let timer = null;
    const fire = () => {
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            callback();
        }, 60);
    };

    let observer = null;
    let poll = null;
    const attach = () => {
        const container = document.getElementById('completion_prompt_manager');
        if (!container || observer) return;
        observer = new MutationObserver(fire);
        observer.observe(container, { childList: true, subtree: true, characterData: true });
        if (poll !== null) {
            clearInterval(poll);
            poll = null;
        }
    };

    attach();
    if (!observer) poll = setInterval(attach, 1000);

    return () => {
        observer?.disconnect();
        if (poll !== null) clearInterval(poll);
        if (timer !== null) clearTimeout(timer);
    };
}

const tokenCache = new Map();

export async function countTextTokens(text) {
    const value = String(text ?? '');
    if (!value.trim()) return 0;
    if (tokenCache.has(value)) return tokenCache.get(value);
    try {
        const count = await getTokenCountAsync(value);
        tokenCache.set(value, count);
        return count;
    } catch (error) {
        return 0;
    }
}
