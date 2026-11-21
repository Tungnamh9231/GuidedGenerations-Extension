/**
 * @file Contains the logic for the Guided Response button.
 */
import { getContext, extension_settings, isGroupChat, setPreviousImpersonateInput, getPreviousImpersonateInput, debugLog, getPromptValue, fillPromptTemplate, pickGroupMember } from './persistentGuides/guideExports.js'; // Import from central hub
import { registerInjectionPromptSlot } from './promptManager/store.js';

// Import the guide scripts for direct execution
import thinkingGuide from './persistentGuides/thinkingGuide.js'; // Correct relative path
import stateGuide from './persistentGuides/stateGuide.js'; // Correct relative path
import clothesGuide from './persistentGuides/clothesGuide.js'; // Correct relative path
import customAutoGuide from './persistentGuides/customAutoGuide.js'; // Import the new Custom Auto Guide

const extensionName = "GuidedGenerations-Extension";

// Placement of the guided response instruction. Kept in one place so the set
// and the cleanup always agree on the same slot, depth and role.
const INJECT_KEY = 'script_inject_instruct';
const INJECT_CHAT = 1;
const ROLE_IDS = { system: 0, user: 1, assistant: 2 };

function expandMacros(context, text) {
    try {
        return typeof context?.substituteParams === 'function' ? context.substituteParams(text) : text;
    } catch {
        return text;
    }
}

function setGuidedInjection(context, value, { depth, role }) {
    context.setExtensionPrompt?.(INJECT_KEY, value, INJECT_CHAT, depth, true, role);
}

function clearGuidedInjection(context, { depth, role }) {
    context.setExtensionPrompt?.(INJECT_KEY, '', INJECT_CHAT, depth, false, role);
}

const guidedResponse = async () => {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        console.error('[GuidedGenerations][Response] Textarea #send_textarea not found.');
        return;
    }
    const originalInput = textarea.value; // Get current input

    // --- Get Setting ---
    const injectionRole = extension_settings[extensionName]?.injectionEndRole ?? 'system'; // Get the role setting

    // Save the input state using the shared function
    setPreviousImpersonateInput(originalInput);

    // Use user-defined guided response prompt override
    const promptTemplate = await getPromptValue('promptGuidedResponse', '', {
        settings: extension_settings[extensionName],
    });
    const filledPrompt = fillPromptTemplate(promptTemplate, { input: originalInput });
    const depth = extension_settings[extensionName]?.depthPromptGuidedResponse ?? 0;

    // For group chats, ask the user which member should respond. If GRS is
    // installed, this delegates to it; otherwise GG's own selector is used.
    // Resolves null when the user cancels.
    let selectedMember = null;
    if (isGroupChat()) {
        selectedMember = await pickGroupMember();
        if (!selectedMember) {
            debugLog('[Response] Group selection cancelled; aborting guided response (no generation).');
            return;
        }
    }

    if (selectedMember) {
        debugLog(`[Response] Group member selected: ${selectedMember.name} (chid ${selectedMember.chid}, trigger arg ${selectedMember.triggerArg}).`);
    }

    // Execute the injection and the generation.
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
        const context = SillyTavern.getContext();
        const role = ROLE_IDS[String(injectionRole).toLowerCase()] ?? ROLE_IDS.system;
        const triggerArg = selectedMember ? ` ${selectedMember.triggerArg}` : '';
        try {
            registerInjectionPromptSlot(INJECT_KEY, 'promptGuidedResponse');
            // The instruction is placed through the extension prompt API instead
            // of an stscript string, so a `|`, a newline or a quote in the user's
            // input can never split the command or break the parse.
            setGuidedInjection(context, expandMacros(context, filledPrompt), { depth, role });
            await context.executeSlashCommandsWithOptions(`/trigger await=true${triggerArg}`, { showOutput: false });
            debugLog('[Response] Guided response triggered.', { depth, role });
        } catch (error) {
            console.error('[GuidedGenerations][Response] Error executing Guided Response:', error);
        } finally {
            try {
                clearGuidedInjection(context, { depth, role });
            } catch (error) {
                console.error('[GuidedGenerations][Response] Could not clear the guided response injection:', error);
            }
            // Always restore the input field from the shared state
            const restoredInput = getPreviousImpersonateInput();
            textarea.value = restoredInput;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } else {
        console.error('[GuidedGenerations][Response] SillyTavern context is not available.');
        // Even if context isn't available, attempt restore if textarea exists
        if (textarea) {
             const restoredInput = getPreviousImpersonateInput();
             debugLog(`[Response] Restoring input field after context error: "${restoredInput}"`);
             textarea.value = restoredInput;
             textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
};

// Export the function
export { guidedResponse };
