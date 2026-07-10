/**
 * Edit Intros Popup - Handles UI for editing character intros with various formatting options
 */

import {
    extensionName,
    getContext,
    extension_settings,
    debugLog,
    requestCompletion,
    shouldUseDirectCall,
    getPromptValue,
    fillPromptTemplate,
    buildChatMessagesWithPromptManager,
} from '../persistentGuides/guideExports.js'; // Import from central hub
import { appendSwipeToMessage } from '../utils/swipeHelpers.js';
import {
    loadBlocks,
    saveBlocks,
    renderPromptBlocksUI,
    assembleMessages,
    getDefaultEditIntrosBlocks,
    EDIT_INTROS_VARIABLES_HTML,
    EDIT_INTROS_MODES
} from '../utils/dynamicPromptManager.js';



// Class to handle the popup functionality
export class EditIntrosPopup {
    constructor() {
        this.popupElement = null;
        this.initialized = false;
        this.lastCustomCommand = sessionStorage.getItem('gg_lastCustomCommand') || ''; // Load last command
        // Track how many times applyChanges is called
        this.applyChangesCount = 0;
        this.currentPromptMode = 'editIntros.editExisting';
        this.promptsMap = {};
    }

    /**
     * Initialize the popup
     */
    async init() {
        if (this.initialized) return;
        for (const modeKey of Object.keys(EDIT_INTROS_MODES)) {
            const settingKey = `editIntrosCustomPrompts_${modeKey}`;
            this.promptsMap[modeKey] = loadBlocks(settingKey, getDefaultEditIntrosBlocks(modeKey));
        }

        // Migrate old setting if present and the new one isn't
        if (localStorage.getItem('gg_editIntrosCustomPrompts') && !localStorage.getItem('gg_editIntrosCustomPrompts_editIntros.editExisting')) {
            const oldBlocks = loadBlocks('editIntrosCustomPrompts', null);
            if (oldBlocks && oldBlocks.length > 0) {
                this.promptsMap['editIntros.editExisting'] = oldBlocks;
            }
        }


        // Create popup container if it doesn't exist
        if (!document.getElementById('editIntrosPopup')) {
            // Create the popup container
            const popupHtml = `
                <div id="editIntrosPopup" class="gg-popup">
                    <div class="gg-popup-content">
                        <div class="gg-popup-header">
                            <h2>Edit Intros</h2>
                            <span class="gg-popup-close">&times;</span>
                        </div>
                        <div class="gg-popup-body">
                            <div class="gg-tabs" style="display: flex; gap: 10px; margin-bottom: 15px; border-bottom: 1px solid #444; padding-bottom: 5px;">
                                <button class="gg-tab-btn active" data-tab="normal" style="background: none; border: none; color: white; cursor: pointer; padding: 5px 10px; border-radius: 4px; font-weight: bold;">Normal</button>
                                <button class="gg-tab-btn" data-tab="prompts" style="background: none; border: none; color: #ccc; cursor: pointer; padding: 5px 10px; border-radius: 4px;">Prompts</button>
                            </div>

                            <div id="gg-tab-normal" class="gg-tab-content active" style="display: block;">
                            <!-- Custom Command Section -->
                            <div class="gg-popup-section gg-custom-command-section">
                                <h3>Instruction</h3>
                                <textarea id="gg-custom-edit-command" placeholder="Enter rewrite instruction here...">${this.lastCustomCommand}</textarea>
                            </div>
                            </div>

                            <div id="gg-tab-prompts" class="gg-tab-content" style="display: none;">
                                <div class="gg-popup-section gg-prompts-section">
                                    <div class="gg-prompt-mode-selector-wrap" style="margin-bottom: 10px;">
                                        <label for="gg-intros-prompt-mode-select" style="margin-right: 5px;">Edit Prompts for:</label>
                                        <select id="gg-intros-prompt-mode-select" class="text_pole">
                                            ${Object.entries(EDIT_INTROS_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
                                        </select>
                                    </div>
                                    <div id="gg-intros-prompts-container"></div>
                                </div>
                            </div>
                        </div>
                        <div class="gg-popup-footer-wrap">
                        <div class="gg-popup-footer">
                            <button id="ggCancelEditIntros" class="gg-button gg-button-secondary">Cancel</button>
                            <button id="ggMakeNewIntro" class="gg-button gg-button-primary">Make New Intro</button>
                            <button id="ggApplyEditIntros" class="gg-button gg-button-primary">Edit Intro</button>
                        </div>
                        </div>
                    </div>
                </div>
            `;

            // Append to body
            const popupContainer = document.createElement('div');
            popupContainer.innerHTML = popupHtml;
            document.body.appendChild(popupContainer.firstElementChild);
            
            const renderBlocks = () => {
                const promptsContainer = document.getElementById('gg-intros-prompts-container');
                if (promptsContainer) {
                    const currentBlocks = this.promptsMap[this.currentPromptMode] || [];

                    renderPromptBlocksUI(promptsContainer, currentBlocks, {
                        settingKey: `editIntrosCustomPrompts_${this.currentPromptMode}`,
                        getDefaults: () => getDefaultEditIntrosBlocks(this.currentPromptMode),
                        variableGuideHtml: EDIT_INTROS_VARIABLES_HTML,
                        onResetAll: () => {
                            for (const modeKey of Object.keys(EDIT_INTROS_MODES)) {
                                this.promptsMap[modeKey] = getDefaultEditIntrosBlocks(modeKey);
                                saveBlocks(`editIntrosCustomPrompts_${modeKey}`, this.promptsMap[modeKey]);
                            }
                            return this.promptsMap[this.currentPromptMode];
                        },
                        onBlocksChanged: (blocks) => { 
                            this.promptsMap[this.currentPromptMode] = blocks; 
                        }
                    });
                }
            };
            
            this._renderBlocks = renderBlocks; // Save for external calls
            setTimeout(renderBlocks, 10);
        }

        // Get the popup element reference
        this.popupElement = document.getElementById('editIntrosPopup');

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
        const cancelButton = this.popupElement.querySelector('#ggCancelEditIntros');
        const applyButton = this.popupElement.querySelector('#ggApplyEditIntros');
        const makeNewIntroButton = this.popupElement.querySelector('#ggMakeNewIntro');
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');

        // Prompt Mode Dropdown
        const modeSelect = this.popupElement.querySelector('#gg-intros-prompt-mode-select');
        if (modeSelect) {
            modeSelect.addEventListener('change', (e) => {
                this.currentPromptMode = e.target.value;
                if (typeof this._renderBlocks === 'function') {
                    this._renderBlocks();
                }
            });
        }

        // Tabs
        const tabBtns = this.popupElement.querySelectorAll('.gg-tab-btn');
        const tabContents = this.popupElement.querySelectorAll('.gg-tab-content');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTab = e.target.getAttribute('data-tab');
                tabBtns.forEach(b => {
                    b.classList.remove('active');
                    b.style.fontWeight = 'normal';
                    b.style.color = '#ccc';
                });
                e.target.classList.add('active');
                e.target.style.fontWeight = 'bold';
                e.target.style.color = 'white';
                tabContents.forEach(content => {
                    content.style.display = content.id === `gg-tab-${targetTab}` ? 'block' : 'none';
                    content.classList.toggle('active', content.id === `gg-tab-${targetTab}`);
                });
            });
        });

        // Close/Cancel Actions
        closeButton.addEventListener('click', () => this.close());
        cancelButton.addEventListener('click', () => this.close());

        // Apply/Make New Actions
        applyButton.addEventListener('click', () => this.applyChanges());
        makeNewIntroButton.addEventListener('click', () => this.makeNewIntro());
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
     * Apply the selected changes
     */
    async applyChanges() {
        // Increment and log invocation count
        this.applyChangesCount++;
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        const instruction = customCommandTextarea.value.trim();

        if (!instruction) {
             alert('Please enter instructions.');
             return;
        }
        
        sessionStorage.setItem('gg_lastCustomCommand', instruction);

        // Close the popup immediately now that validation has passed
        this.close();

        const textareaElement = document.getElementById('send_textarea');
        const customEdit = textareaElement ? textareaElement.value.trim() : '';

        const introPresetSettingKey = 'presetEditIntros';
        const presetValue = extension_settings[extensionName]?.[introPresetSettingKey] ?? '';
        const profileValue = extension_settings[extensionName]?.profileEditIntros ?? '';

        try {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                console.error('[GuidedGenerations] No intro message available to edit.');
                return;
            }

            const messageToRewrite = context.chat[0]?.mes || '';
            const promptTemplate = await getPromptValue('editIntros.editExisting', '');
            
            const promptKey = 'editIntros.editExisting';
            const currentPrompts = this.promptsMap[promptKey] || [];
            const hasCustomBlocks = currentPrompts.some(b => b.type === 'custom' && b.content.trim() !== '');
            let useDynamicBlocks = hasCustomBlocks;
            let promptForModel = '';
            let finalMessages = [];

            if (useDynamicBlocks) {
                const variableMap = {
                    i: instruction,
                    m: messageToRewrite,
                };
                let presetMessages = [];
                if (!this.genWithoutPreset) {
                    const markerMessages = [{ role: 'system', content: '___GG_CHAT_MARKER___', name: 'GG_MARKER' }];
                    presetMessages = await buildChatMessagesWithPromptManager(context, markerMessages, presetValue, { prompt: '', includeChatHistory: false });
                }
                finalMessages = assembleMessages(currentPrompts, variableMap, presetMessages);
            } else {
                promptForModel = fillPromptTemplate(promptTemplate, {
                    instruction,
                    messageToRewrite,
                });
            }

            const useDirectCall = await shouldUseDirectCall(profileValue, presetValue);
            let updatedIntro = '';
            if (useDynamicBlocks || useDirectCall) {
                debugLog('[EditIntros] Requesting direct completion for intro edit...');
                const overrideOptions = useDynamicBlocks ? { bypassPromptManager: true } : {};
                updatedIntro = await requestCompletion({
                    profileName: profileValue,
                    presetName: presetValue,
                    prompt: promptForModel,
                    messages: useDynamicBlocks ? finalMessages : null,
                    debugLabel: 'editIntros:edit',
                    includeChatHistory: false,
                    optionsOverrides: overrideOptions
                });
            } else if (typeof context.executeSlashCommandsWithOptions === 'function') {
                const swipeHandled = await executeSwipeGenerationWithPrompt(context, promptForModel);
                if (swipeHandled) {
                    return;
                }
            } else {
                console.error('[GuidedGenerations] context.executeSlashCommandsWithOptions not found!');
            }

            if (!updatedIntro || updatedIntro.trim() === '') {
                console.error('[GuidedGenerations] No updated intro text received.');
                return;
            }

            await applyIntroUpdate(context, updatedIntro);
        } catch (error) {
            console.error('[GuidedGenerations] Error executing Edit Intros request:', error);
        }

        if (customEdit && textareaElement) {
            textareaElement.value = '';
        }
    }

    /**
     * Creates a new intro based on the selected option or custom instruction.
     */
    async makeNewIntro() {
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        const instruction = customCommandTextarea.value.trim();

        if (!instruction) {
             alert('Please enter instructions.');
             return;
        }

        sessionStorage.setItem('gg_lastCustomCommand', instruction);

        // Close the popup immediately now that validation has passed
        this.close();

        const introPresetSettingKey = 'presetEditIntros';
        const presetValue = extension_settings[extensionName]?.[introPresetSettingKey] ?? '';
        const profileValue = extension_settings[extensionName]?.profileEditIntros ?? '';

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable for intro generation.');
                return;
            }

            const promptTemplate = await getPromptValue('editIntros.makeNew', '');
            
            const promptKey = 'editIntros.makeNew';
            const currentPrompts = this.promptsMap[promptKey] || [];
            const hasCustomBlocks = currentPrompts.some(b => b.type === 'custom' && b.content.trim() !== '');
            let useDynamicBlocks = hasCustomBlocks;
            let promptForModel = '';
            let finalMessages = [];

            if (useDynamicBlocks) {
                const variableMap = {
                    i: instruction,
                    m: '', // empty for makeNew
                };
                let presetMessages = [];
                if (!this.genWithoutPreset) {
                    const markerMessages = [{ role: 'system', content: '___GG_CHAT_MARKER___', name: 'GG_MARKER' }];
                    presetMessages = await buildChatMessagesWithPromptManager(context, markerMessages, presetValue, { prompt: '', includeChatHistory: false });
                }
                finalMessages = assembleMessages(currentPrompts, variableMap, presetMessages);
            } else {
                promptForModel = fillPromptTemplate(promptTemplate, { instruction });
            }
            
            const useDirectCall = await shouldUseDirectCall(profileValue, presetValue);
            let newIntro = '';
            if (useDynamicBlocks || useDirectCall) {
                debugLog('[EditIntros] Requesting direct completion for new intro...');
                const overrideOptions = useDynamicBlocks ? { bypassPromptManager: true } : {};
                newIntro = await requestCompletion({
                    profileName: profileValue,
                    presetName: presetValue,
                    prompt: promptForModel,
                    messages: useDynamicBlocks ? finalMessages : null,
                    debugLabel: 'editIntros:new',
                    includeChatHistory: false,
                    optionsOverrides: overrideOptions
                });
            } else if (typeof context.executeSlashCommandsWithOptions === 'function') {
                const swipeHandled = await executeSwipeGenerationWithPrompt(context, promptForModel);
                if (swipeHandled) {
                    return;
                }
            } else {
                console.error('[GuidedGenerations] context.executeSlashCommandsWithOptions not found!');
            }

            if (!newIntro || newIntro.trim() === '') {
                console.error('[GuidedGenerations] No new intro text received.');
                return;
            }

            await applyIntroUpdate(context, newIntro);
        } catch (error) {
            console.error('[GuidedGenerations] Error executing Make New Intro request:', error);
        }
    }

}

async function applyIntroUpdate(context, introText) {
    const targetIndex = context?.chat?.length ? 0 : -1;
    const characterName = context?.characters?.[context.characterId]?.name || 'Assistant';

    if (targetIndex === -1) {
        const message = {
            name: characterName,
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: introText,
            force_avatar: null,
            extra: {
                type: 'intro',
                gen_id: Date.now(),
            },
        };
        context.chat.push(message);
        await context.eventSource.emit('MESSAGE_SENT', context.chat.length - 1);
        if (typeof context.addOneMessage === 'function') {
            await context.addOneMessage(message);
        }
        await context.eventSource.emit('USER_MESSAGE_RENDERED', context.chat.length - 1);
        if (typeof context.saveChat === 'function') {
            await context.saveChat();
        }
        return;
    }

    const messageData = context.chat[targetIndex];
    if (!messageData) {
        console.error('[GuidedGenerations] Could not find intro message to update.');
        return;
    }

    await appendSwipeToMessage(context, targetIndex, introText, {
        source: 'manual',
        model: 'Guided Generations',
    });
}

// Singleton instance
const editIntrosPopup = new EditIntrosPopup();
export default editIntrosPopup;

const SCRIPT_PROMPT_KEY = 'script_inject_';
const INJECT_POSITIONS = {
    chat: 1,
};
const INJECT_ROLES = {
    system: 0,
    user: 1,
    assistant: 2,
};

function setTemporaryInjection(context, id, value, { position = INJECT_POSITIONS.chat, depth = 0, scan = true, role = INJECT_ROLES.system } = {}) {
    if (!context.chatMetadata.script_injects) {
        context.chatMetadata.script_injects = {};
    }

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

async function executeSwipeGenerationWithPrompt(context, promptText) {
    const injectionRole = extension_settings[extensionName]?.injectionEndRole ?? 'system';
    const role = INJECT_ROLES[String(injectionRole).toLowerCase()] ?? INJECT_ROLES.system;
    const filledPrompt = String(promptText || '');
    const tempMessage = {
        name: 'Editing Greeting',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: 'Editing Greeting',
        swipes: ['Editing Greeting'],
        swipe_id: 0,
        force_avatar: null,
        extra: {
            type: 'temp_intro_edit',
            gen_id: Date.now(),
        },
    };

    // Insert deterministically at index 0 so generateNewSwipe targets intro, not temp.
    context.chat.unshift(tempMessage);
    if (typeof context.saveChat === 'function') {
        await context.saveChat();
    }
    if (typeof context.reloadCurrentChat === 'function') {
        await context.reloadCurrentChat();
    }

    let tempInserted = true;
    try {
        await context.executeSlashCommandsWithOptions('/hide 0', {
            showOutput: false,
            handleExecutionErrors: true,
        });

        setTemporaryInjection(context, 'instruct', filledPrompt, { role });

        const swipeSuccess = await generateNewSwipe();
        if (!swipeSuccess) {
            return false;
        }
        return true;
    } finally {
        flushTemporaryInjection(context, 'instruct');

        if (tempInserted) {
            if (context.chat[0] === tempMessage) {
                context.chat.splice(0, 1);
            } else {
                const fallbackIndex = context.chat.findIndex((message) => message?.extra?.gen_id === tempMessage.extra.gen_id);
                if (fallbackIndex !== -1) {
                    context.chat.splice(fallbackIndex, 1);
                }
            }
            if (typeof context.saveChat === 'function') {
                await context.saveChat();
            }
            if (typeof context.reloadCurrentChat === 'function') {
                await context.reloadCurrentChat();
            }
            // reloadCurrentChat rebuilds UI; generation may have left send/stop controls hidden — resync explicitly
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            try {
                activateSendButtons?.();
                setSendButtonState?.(false);
            } catch (_) {
                /* ignore if SillyTavern API differs */
            }
            debugLog('[EditIntros] Removed temporary "Editing Greeting" message after swipe generation.');
        }
    }
}
