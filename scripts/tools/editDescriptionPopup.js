/**
 * Edit Description Popup - Handles UI for editing character descriptions using AI generation.
 * Simplified version of EditIntrosPopup: only custom instruction input, no preset options.
 */

import {
    extensionName,
    getContext,
    extension_settings,
    debugLog,
    requestCompletion,
    getPromptObject,
    getPromptValue,
    fillPromptTemplate,
    activateSendButtons,
    deactivateSendButtons,
    setSendButtonState,
} from '../persistentGuides/guideExports.js'; // Import from central hub

const SCRIPT_PROMPT_KEY = 'script_inject_';
const INJECT_POSITIONS = { chat: 1 };
const INJECT_ROLES = { system: 0, user: 1, assistant: 2 };

function setTemporaryInjection(context, id, value, { position = INJECT_POSITIONS.chat, depth = 0, scan = true, role = INJECT_ROLES.system } = {}) {
    if (!context.chatMetadata.script_injects) context.chatMetadata.script_injects = {};
    context.chatMetadata.script_injects[id] = { value, position, depth, scan, role, filter: null };
    context.setExtensionPrompt?.(`${SCRIPT_PROMPT_KEY}${id}`, value, position, depth, scan, role);
    context.saveMetadataDebounced?.();
}

function flushTemporaryInjection(context, id) {
    const existingInject = context.chatMetadata?.script_injects?.[id];
    const position = existingInject?.position ?? INJECT_POSITIONS.chat;
    const depth = existingInject?.depth ?? 0;
    const scan = existingInject?.scan ?? true;
    const role = existingInject?.role ?? INJECT_ROLES.system;

    if (context.chatMetadata?.script_injects) {
        delete context.chatMetadata.script_injects[id];
    }
    context.setExtensionPrompt?.(`${SCRIPT_PROMPT_KEY}${id}`, '', position, depth, scan, role);
    context.saveMetadataDebounced?.();
}

// Class to handle the popup functionality
export class EditDescriptionPopup {
    constructor() {
        this.popupElement = null;
        this.initialized = false;
        this.lastCustomCommand = sessionStorage.getItem('gg_lastCustomDescCommand') || '';
    }

    /**
     * Initialize the popup
     */
    async init() {
        if (this.initialized) return;

        // Create popup container if it doesn't exist
        if (!document.getElementById('editDescriptionPopup')) {
            const popupHtml = `
                <div id="editDescriptionPopup" class="gg-popup">
                    <div class="gg-popup-content">
                        <div class="gg-popup-header">
                            <h2>Edit Description</h2>
                            <span class="gg-popup-close">&times;</span>
                        </div>
                        <div class="gg-popup-body">
                            <!-- Custom Command Section -->
                            <div class="gg-popup-section gg-custom-command-section">
                                <h3>Custom Instruction</h3>
                                <textarea id="gg-custom-edit-description-command" placeholder="Enter your instruction for generating/editing the character description...">${this.lastCustomCommand}</textarea>
                            </div>
                        </div>
                        <div class="gg-popup-footer">
                            <button id="ggCancelEditDescription" class="gg-button gg-button-secondary">Cancel</button>
                            <button id="ggCreateNewDescription" class="gg-button gg-button-secondary">Create New</button>
                            <button id="ggEditExistingDescription" class="gg-button gg-button-primary">Edit Existing</button>
                        </div>
                    </div>
                </div>
            `;

            // Append to body
            const popupContainer = document.createElement('div');
            popupContainer.innerHTML = popupHtml;
            document.body.appendChild(popupContainer.firstElementChild);
        }

        // Get the popup element reference
        this.popupElement = document.getElementById('editDescriptionPopup');

        // Setup event listeners
        this.setupEventListeners();

        this.initialized = true;
    }

    /**
     * Setup event listeners for the popup elements
     */
    setupEventListeners() {
        if (!this.popupElement) return;

        const closeButton = this.popupElement.querySelector('.gg-popup-close');
        const cancelButton = this.popupElement.querySelector('#ggCancelEditDescription');
        const createNewButton = this.popupElement.querySelector('#ggCreateNewDescription');
        const editExistingButton = this.popupElement.querySelector('#ggEditExistingDescription');

        // Close/Cancel Actions
        closeButton.addEventListener('click', () => this.close());
        cancelButton.addEventListener('click', () => this.close());

        // Generate Actions
        createNewButton.addEventListener('click', () => this.generateDescription('makeNew'));
        editExistingButton.addEventListener('click', () => this.generateDescription('editExisting'));
    }

    /**
     * Open the popup
     */
    open() {
        if (!this.initialized) {
            this.init().then(() => {
                if (this.popupElement) {
                    this.popupElement.style.display = 'block';
                }
            });
        } else if (this.popupElement) {
            this.popupElement.style.display = 'block';
        }
    }

    /**
     * Close the popup
     */
    close() {
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
        }
    }

    /**
     * Generate description based on the custom instruction
     * @param {string} mode 'makeNew' or 'editExisting'
     */
    async generateDescription(mode = 'editExisting') {
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-description-command');
        const instruction = customCommandTextarea.value.trim();

        if (!instruction) {
            alert('Please enter an instruction for generating the description.');
            return;
        }

        // Save the custom command for session recovery
        sessionStorage.setItem('gg_lastCustomDescCommand', instruction);

        // Close the popup immediately now that validation has passed
        this.close();

        const presetValue = extension_settings[extensionName]?.presetEditDescription ?? '';
        const profileValue = extension_settings[extensionName]?.profileEditDescription ?? '';

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable for description generation.');
                return;
            }

            // Get the current description from the textarea
            const descriptionTextarea = document.getElementById('description_textarea');
            const currentDescription = descriptionTextarea ? descriptionTextarea.value.trim() : '';

            // Get the prompt template from prompts.json based on mode
            const promptTemplate = await getPromptValue(`editDescription.${mode}`, '');
            const promptForModel = fillPromptTemplate(promptTemplate, {
                instruction,
                currentDescription: mode === 'editExisting' ? currentDescription : '',
            });

            // Toggle send button state to show generation is happening
            setSendButtonState?.(true);
            deactivateSendButtons?.();

            let generatedDescription = '';

            try {
                debugLog('[EditDescription] Requesting completion for description generation (includeChatHistory=false)...');
                generatedDescription = await requestCompletion({
                    profileName: profileValue,
                    presetName: presetValue,
                    prompt: promptForModel,
                    debugLabel: 'editDescription:generate',
                    includeChatHistory: false,
                    includeIdentityContext: true,
                });
            } catch (error) {
                console.warn('[GuidedGenerations] Error executing direct description generation, falling back...', error);
            }

            if (!generatedDescription || generatedDescription.trim() === '') {
                debugLog('[EditDescription] Direct generation failed or returned empty. Falling back to /gen with chat isolation...');
                const injectionRole = extension_settings[extensionName]?.injectionEndRole ?? 'system';
                const role = INJECT_ROLES[String(injectionRole).toLowerCase()] ?? INJECT_ROLES.system;
                setTemporaryInjection(context, 'editDescInstruct', promptForModel, { role });

                const originalChat = [...(context.chat || [])];
                if (context.chat) {
                    context.chat.length = 0;
                    // Add dummy system message to prevent greeting generation
                    context.chat.push({
                        name: 'System',
                        is_user: false,
                        is_system: true,
                        send_date: Date.now(),
                        mes: 'Generating description...',
                        extra: { type: 'temp_desc_gen' }
                    });
                }

                try {
                    const genResult = await context.executeSlashCommandsWithOptions(`/gen quiet=true |`, {
                        showOutput: false,
                        handleExecutionErrors: true,
                    });
                    generatedDescription = genResult?.pipe || '';
                } catch (fallbackError) {
                    console.error('[GuidedGenerations] Fallback generation also failed:', fallbackError);
                } finally {
                    flushTemporaryInjection(context, 'editDescInstruct');
                    if (context.chat) {
                        context.chat.length = 0;
                        context.chat.push(...originalChat);
                        if (typeof context.saveChat === 'function') await context.saveChat();
                        if (typeof context.reloadCurrentChat === 'function') await context.reloadCurrentChat();
                    }
                }
            }

            // Resync send/stop controls
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            try {
                activateSendButtons?.();
                setSendButtonState?.(false);
            } catch (_) {
                /* ignore if SillyTavern API differs */
            }
            if (!generatedDescription || generatedDescription.trim() === '') {
                console.error('[GuidedGenerations] No description text received.');
                return;
            }

            // Put the result in the textarea
            if (descriptionTextarea) {
                descriptionTextarea.value = generatedDescription;
                
                // dispatch input event to ensure ST registers the change
                const inputEvent = new Event('input', { bubbles: true });
                descriptionTextarea.dispatchEvent(inputEvent);
                descriptionTextarea.dispatchEvent(new Event('change', { bubbles: true }));
                
                debugLog('[EditDescription] Description updated successfully.');
            } else {
                console.error('[GuidedGenerations] #description_textarea not found in DOM.');
            }
        } catch (error) {
            console.error('[GuidedGenerations] Error executing Edit Description request:', error);
        }
    }
}


// Singleton instance
const editDescriptionPopup = new EditDescriptionPopup();
export default editDescriptionPopup;
