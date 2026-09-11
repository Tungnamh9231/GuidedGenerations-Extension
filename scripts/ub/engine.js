import {
    applyPromptEnabledMap,
    getPromptEnabled,
    getReasoningEffort,
    isPromptManagerReady,
    normalizeEffort,
    setReasoningEffort,
} from './sillyTavernAdapter.js';

function refsForBlock(block) {
    return Array.isArray(block?.promptRefs)
        ? block.promptRefs.map(ref => ref.identifier).filter(Boolean)
        : [];
}

function allTabPromptIds(tab) {
    return [...new Set((tab.blocks ?? []).flatMap(refsForBlock))];
}

export function getAvailableStates(tab) {
    if (!tab) return [];
    const blockStates = (tab.blocks ?? []).map((_, index) =>
        tab.isDefault ? `HJB${index + 1}` : `${tab.name}${index + 1}`
    );
    return tab.isDefault ? ['UB', 'LJB', ...blockStates] : ['OFF', ...blockStates];
}

export function deriveTabState(tab) {
    if (!tab || !isPromptManagerReady()) return { state: 'UNAVAILABLE', missing: [] };

    const missing = [];
    const activeIndexes = [];
    let anyConfiguredPromptEnabled = false;
    let hasPartialBlock = false;

    (tab.blocks ?? []).forEach((block, index) => {
        const ids = refsForBlock(block);
        if (!ids.length) return;
        const states = ids.map(identifier => {
            const enabled = getPromptEnabled(identifier);
            if (enabled === null) missing.push(identifier);
            if (enabled === true) anyConfiguredPromptEnabled = true;
            return enabled;
        });
        const allOn = states.length && states.every(value => value === true);
        const allOff = states.every(value => value === false);
        if (allOn) activeIndexes.push(index);
        else if (!allOff) hasPartialBlock = true;
    });

    if (missing.length) return { state: 'MISSING', missing: [...new Set(missing)] };
    if (hasPartialBlock || activeIndexes.length > 1) return { state: 'E', missing: [] };
    if (activeIndexes.length === 1) {
        const activeIds = new Set(refsForBlock(tab.blocks[activeIndexes[0]]));
        const strayOn = allTabPromptIds(tab).some(id => !activeIds.has(id) && getPromptEnabled(id) === true);
        if (strayOn) return { state: 'E', missing: [] };
        const index = activeIndexes[0];
        return {
            state: tab.isDefault ? `HJB${index + 1}` : `${tab.name}${index + 1}`,
            missing: [],
        };
    }

    if (anyConfiguredPromptEnabled) return { state: 'E', missing: [] };
    if (!tab.isDefault) return { state: 'OFF', missing: [] };

    const effort = getReasoningEffort();
    if (effort === 'high') return { state: 'UB', missing: [] };
    if (effort === 'min' || effort === 'low') return { state: 'LJB', missing: [] };
    return { state: 'E', missing: [] };
}

function targetBlockIndex(tab, targetState) {
    if (tab.isDefault && /^HJB\d+$/.test(targetState)) {
        return Number(targetState.slice(3)) - 1;
    }
    if (!tab.isDefault && targetState.startsWith(tab.name)) {
        const suffix = targetState.slice(tab.name.length);
        if (/^\d+$/.test(suffix)) return Number(suffix) - 1;
    }
    return -1;
}

export async function applyTabState(tab, targetState) {
    if (!tab) throw new Error('UB tab not found.');
    if (!isPromptManagerReady()) throw new Error('SillyTavern Prompt Manager is not ready.');

    const available = getAvailableStates(tab);
    if (!available.includes(targetState)) {
        throw new Error(`Invalid UB state: ${targetState}`);
    }

    const configuredIds = allTabPromptIds(tab);
    const missingBeforeApply = configuredIds.filter(identifier => getPromptEnabled(identifier) === null);
    if (missingBeforeApply.length) {
        const error = new Error(`Missing ${missingBeforeApply.length} prompt(s) in the active Prompt Manager.`);
        error.code = 'GG_UB_MISSING_PROMPTS';
        error.missing = missingBeforeApply;
        throw error;
    }

    const enabledMap = new Map(configuredIds.map(identifier => [identifier, false]));
    let targetBlock = null;
    let desiredEffort = null;

    if (tab.isDefault && targetState === 'UB') {
        if (tab.changeEffort) desiredEffort = 'high';
    } else if (tab.isDefault && targetState === 'LJB') {
        if (tab.changeEffort) desiredEffort = 'min';
    } else if (!tab.isDefault && targetState === 'OFF') {
        // All configured blocks remain disabled.
    } else {
        const index = targetBlockIndex(tab, targetState);
        targetBlock = tab.blocks?.[index];
        if (!targetBlock) throw new Error(`No block mapped for ${targetState}`);

        for (const identifier of refsForBlock(targetBlock)) enabledMap.set(identifier, true);
        if (tab.changeEffort) desiredEffort = normalizeEffort(targetBlock.effort);
    }

    // PromptManager persistence is the more failure-prone operation. Commit it
    // first; only update reasoning effort after the prompt transaction succeeds.
    const result = await applyPromptEnabledMap(enabledMap);
    if (result.missing.length) {
        const error = new Error(`Missing ${result.missing.length} prompt(s) in the active Prompt Manager.`);
        error.code = 'GG_UB_MISSING_PROMPTS';
        error.missing = result.missing;
        throw error;
    }

    if (desiredEffort !== null) setReasoningEffort(desiredEffort);
    return { state: targetState, block: targetBlock };
}

export async function cycleTabState(tab, lastValidState = null) {
    const available = getAvailableStates(tab);
    if (!available.length) return null;

    const derived = deriveTabState(tab).state;
    const reference = ['E', 'MISSING', 'UNAVAILABLE'].includes(derived)
        ? (lastValidState ?? available[0])
        : derived;

    const currentIndex = available.indexOf(reference);
    const next = available[(currentIndex + 1 + available.length) % available.length];
    return applyTabState(tab, next);
}
