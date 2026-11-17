import { PromptManager, Prompt } from '../../../../../PromptManager.js';
import { extension_prompt_types } from '../../../../../../script.js';
import { getContext } from '../persistentGuides/guideExports.js';
import { PROMPT_SCOPE, PROMPT_BLOCKS, getBlockById, getPromptDefinition } from './registry.js';
import { buildMergedOrder } from './order.js';
import {
    getPromptConfig,
    getEffectivePromptConfig,
    getRequestPromptKey,
    getInjectionPromptKey,
    setSendBridgeActive,
    IN_CHAT,
} from './store.js';

// Every extension prompt is placed by this extension's Prompt Manager, so the
// collection returned by SillyTavern's prompt manager is rebuilt with our
// blocks spliced in at the position the user dragged them to. Everything
// downstream (relative order, in-chat depth/order, role) then runs through the
// untouched native code path.

const STATIC_SLOTS = new Map();
for (const block of PROMPT_BLOCKS) {
    for (const prompt of block.prompts) {
        if (prompt.scope === PROMPT_SCOPE.CHAT && prompt.slot) STATIC_SLOTS.set(prompt.slot, prompt.key);
    }
}

// Custom guides are injected as script_inject_custom_<name>; all of them are
// generated from the same template prompt.
const CUSTOM_GUIDE_PREFIX = 'script_inject_custom_';
const CUSTOM_GUIDE_KEY = 'editGuides.generatedGuideInjection';

// Once a prompt is taken over, its extensionPrompts entry stays at position NONE
// (SillyTavern would otherwise inject it a second time). The original placement
// is remembered here so unconfigured prompts keep their feature's defaults.
const slotBaselines = new Map();

let installed = false;

export function installPromptSendBridge() {
    if (installed) return;
    const prototype = PromptManager?.prototype;
    if (typeof prototype?.getPromptCollection !== 'function') return;

    const original = prototype.getPromptCollection;
    prototype.getPromptCollection = function (generationType) {
        const collection = original.call(this, generationType);
        try {
            applyExtensionPrompts.call(this, collection);
        } catch (error) {
            console.warn('[GuidedGenerations] Prompt send bridge skipped:', error);
        }
        return collection;
    };
    installed = true;
    setSendBridgeActive(true);
}

function resolvePromptKey(slot) {
    const requestKey = getRequestPromptKey(slot);
    if (requestKey) return requestKey;
    const injectionKey = getInjectionPromptKey(slot);
    if (injectionKey) return injectionKey;
    const staticKey = STATIC_SLOTS.get(slot);
    if (staticKey) return staticKey;
    return slot.startsWith(CUSTOM_GUIDE_PREFIX) ? CUSTOM_GUIDE_KEY : '';
}

function baselineFor(slot, entry) {
    if (entry.position !== extension_prompt_types.NONE) {
        const baseline = { position: entry.position, depth: entry.depth, role: entry.role };
        slotBaselines.set(slot, baseline);
        return baseline;
    }
    return slotBaselines.get(slot) ?? null;
}

function applyExtensionPrompts(collection) {
    const extensionPrompts = getContext()?.extensionPrompts;
    if (!extensionPrompts || !Array.isArray(collection?.collection)) return;

    const governed = [];
    for (const [slot, entry] of Object.entries(extensionPrompts)) {
        if (!entry || !String(entry.value ?? '').trim()) continue;
        const promptKey = resolvePromptKey(slot);
        if (!promptKey) continue;
        const definition = getPromptDefinition(promptKey);
        if (!definition || definition.prompt.textOnly) continue;

        const isRequest = Boolean(getRequestPromptKey(slot));
        let config;
        if (isRequest) {
            // A feature's own generation prompt has no native placement; the
            // manager's saved config (or the relative/user defaults) decides.
            config = getPromptConfig(promptKey);
        } else {
            const baseline = baselineFor(slot, entry);
            const effectiveEntry = baseline ? { ...entry, ...baseline } : entry;
            config = getEffectivePromptConfig(promptKey, effectiveEntry);
            // Do not turn a native 'after'/'before' injection into a depth
            // injection: SillyTavern would add it twice.
            if (entry.position !== extension_prompt_types.IN_CHAT
                && entry.position !== extension_prompt_types.NONE
                && config.position === IN_CHAT) {
                continue;
            }
        }

        entry.position = extension_prompt_types.NONE;
        governed.push({
            slot,
            promptKey,
            blockId: definition.block.id,
            label: definition.prompt.label,
            text: entry.value,
            config,
            prepared: !isRequest,
        });
    }
    if (!governed.length) return;

    const nativeById = new Map(collection.collection.map(prompt => [prompt.identifier, prompt]));
    const tokens = buildMergedOrder(collection.collection.map(prompt => prompt.identifier));
    const rebuilt = [];
    const consumed = new Set();

    for (const token of tokens) {
        if (token.type === 'native') {
            const prompt = nativeById.get(token.id);
            if (prompt) {
                rebuilt.push(prompt);
                consumed.add(prompt.identifier);
            }
            continue;
        }

        const block = getBlockById(token.id);
        if (!block) continue;

        for (const item of governed) {
            if (item.blockId !== block.id) continue;
            const raw = new Prompt({
                identifier: item.slot,
                name: item.config.name || item.label || block.label,
                role: item.config.role,
                content: item.text,
                system_prompt: false,
                injection_position: item.config.position === IN_CHAT ? 1 : 0,
                injection_depth: item.config.depth,
                injection_order: item.config.order,
            });
            // Feature request prompts are sent verbatim; chat injections keep the
            // macro substitution SillyTavern applies to script injections.
            rebuilt.push(item.prepared ? this.preparePrompt(raw) : raw);
            consumed.add(item.slot);
        }
    }

    for (const prompt of collection.collection) {
        if (!consumed.has(prompt.identifier)) rebuilt.push(prompt);
    }

    collection.collection = rebuilt;
}
