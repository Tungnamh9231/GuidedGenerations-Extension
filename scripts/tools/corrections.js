/**
 * @file Contains the logic for the Corrections tool.
 */
import {
    getContext,
    extension_settings,
    extensionName,
    debugLog,
    requestCompletion,
    shouldUseDirectCall,
    getPromptValue,
    fillPromptTemplate,
    deactivateSendButtons,
    activateSendButtons,
    setSendButtonState,
} from '../persistentGuides/guideExports.js';
import { appendSwipeToMessage } from '../utils/swipeHelpers.js';
import { registerInjectionPromptSlot } from '../promptManager/store.js';

let lastCorrectionInstruction = '';

const SCRIPT_PROMPT_KEY = 'script_inject_';
const INJECT_POSITIONS = { chat: 1 };
const INJECT_ROLES = { system: 0, user: 1, assistant: 2 };

function setTemporaryInjection(context, id, value, { position = INJECT_POSITIONS.chat, depth = 0, scan = true, role = INJECT_ROLES.system } = {}) {
    if (!context.chatMetadata) context.chatMetadata = {};
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

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

class CorrectionsPopup {
    constructor() {
        this.popupId = 'correctionsPopup';
        this.popupElement = null;
        this.initialized = false;
        this.messageIndex = null;
        this.swipeIndex = null;
        this.sendWithoutPreset = localStorage.getItem('gg_correctionsGenWithoutPreset') === 'true';
        this.selectionStart = null;
        this.selectionEnd = null;
    }

    async init(parentElement = document.body) {
        if (this.initialized) return;

        const existing = document.getElementById(this.popupId);
        if (!existing) {
            const popupHtml = `
                <div id="${this.popupId}" class="gg-popup gg-editor-popup" role="dialog" aria-modal="true" aria-labelledby="gg-corrections-title" aria-hidden="true" style="display: none;">
                    <div class="gg-popup-content gg-editor-dialog gg-corrections-dialog">
                        <div class="gg-popup-header">
                            <div class="gg-editor-title-group">
                                <span class="gg-editor-title-icon" aria-hidden="true">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                                </span>
                                <div>
                                    <span class="gg-editor-eyebrow">Precision editing</span>
                                    <h2 id="gg-corrections-title">Corrections</h2>
                                    <p>Rewrite a message — or just the part you highlight.</p>
                                </div>
                            </div>
                            <button type="button" class="gg-popup-close" aria-label="Close Corrections">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                        <div class="gg-popup-body gg-editor-body">
                            <section class="gg-popup-section gg-editor-card">
                                <div class="gg-editor-section-heading">
                                    <div>
                                        <h3>Choose target</h3>
                                        <p>Step through messages and swipes to pick what to correct.</p>
                                    </div>
                                </div>
                                <div class="gg-corr-nav-grid">
                                    <div class="gg-corr-nav-group">
                                        <button type="button" id="ggCorrectionsPrevMessage" class="gg-corr-step" title="Older message" aria-label="Older message"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                                        <span id="ggCorrectionsMessageInfo" class="gg-corr-info">Message</span>
                                        <button type="button" id="ggCorrectionsNextMessage" class="gg-corr-step" title="Newer message" aria-label="Newer message"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                                    </div>
                                    <div class="gg-corr-nav-group">
                                        <button type="button" id="ggCorrectionsPrevSwipe" class="gg-corr-step" title="Previous swipe" aria-label="Previous swipe"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                                        <span id="ggCorrectionsSwipeInfo" class="gg-corr-info">Swipe</span>
                                        <button type="button" id="ggCorrectionsNextSwipe" class="gg-corr-step" title="Next swipe" aria-label="Next swipe"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                                    </div>
                                </div>
                            </section>

                            <section class="gg-popup-section gg-editor-card">
                                <div class="gg-editor-section-heading">
                                    <div>
                                        <label for="ggCorrectionsMessage" class="gg-editor-section-label">Selected message</label>
                                        <p>Highlight part of it to rewrite only that part; leave it untouched to rewrite the whole message.</p>
                                    </div>
                                    <span id="ggCorrectionsSelectionInfo" class="gg-editor-meta">No recorded selection.</span>
                                </div>
                                <div class="gg-corrections-message-wrap">
                                    <div id="ggCorrectionsMessageOverlay" class="gg-corrections-message-overlay"></div>
                                    <textarea id="ggCorrectionsMessage" class="gg-corrections-message" rows="10" readonly aria-label="Selected message"></textarea>
                                </div>
                            </section>

                            <section class="gg-popup-section gg-editor-card">
                                <div class="gg-editor-section-heading">
                                    <div>
                                        <label for="ggCorrectionsInstruction" class="gg-editor-section-label">What should change?</label>
                                        <p>Describe the fix in plain words.</p>
                                    </div>
                                    <span class="gg-editor-required">Required</span>
                                </div>
                                <textarea id="ggCorrectionsInstruction" class="text_pole gg-editor-textarea" rows="5" placeholder="Example: Fix the grammar and keep the original tone..."></textarea>
                                <div class="gg-editor-field-footer">
                                    <div class="gg-editor-suggestions" aria-label="Quick instruction suggestions">
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Fix spelling and grammar mistakes.">Fix grammar</button>
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Make the message more concise without losing meaning.">Make concise</button>
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Improve the wording while keeping the original tone.">Polish wording</button>
                                    </div>
                                    <span id="ggCorrectionsInstructionCount" class="gg-editor-meta">0 characters</span>
                                </div>
                                <p id="ggCorrectionsInstructionError" class="gg-editor-error" role="alert" hidden>Please enter an instruction.</p>
                                <div class="gg-checkbox-row gg-corr-preset">
                                    <input id="ggCorrectionsSendWithoutPreset" type="checkbox">
                                    <label for="ggCorrectionsSendWithoutPreset">Send without preset</label>
                                </div>
                            </section>
                        </div>
                        <div class="gg-popup-footer-wrap gg-editor-footer-wrap">
                            <div class="gg-editor-footer-note">
                                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                                <span>The result is added as a new swipe, so the original message stays intact.</span>
                            </div>
                            <div class="gg-popup-footer">
                                <button type="button" id="ggCorrectionsCancel" class="gg-button gg-button-quiet">Cancel</button>
                                <button type="button" id="ggCorrectionsApply" class="gg-button gg-button-primary">
                                    <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                                    <span>Apply Correction</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            parentElement.insertAdjacentHTML('beforeend', popupHtml);
        }

        this.popupElement = document.getElementById(this.popupId);
        if (!this.popupElement) {
            console.error('[GuidedGenerations][Corrections] Failed to create popup element.');
            return;
        }

        this.setupEventListeners();
        this.initialized = true;
    }

    setupEventListeners() {
        if (!this.popupElement) return;

        const closeButton = this.popupElement.querySelector('.gg-popup-close');
        const cancelButton = this.popupElement.querySelector('#ggCorrectionsCancel');
        const applyButton = this.popupElement.querySelector('#ggCorrectionsApply');
        const prevMessageButton = this.popupElement.querySelector('#ggCorrectionsPrevMessage');
        const nextMessageButton = this.popupElement.querySelector('#ggCorrectionsNextMessage');
        const prevSwipeButton = this.popupElement.querySelector('#ggCorrectionsPrevSwipe');
        const nextSwipeButton = this.popupElement.querySelector('#ggCorrectionsNextSwipe');
        const sendWithoutPresetCheckbox = this.popupElement.querySelector('#ggCorrectionsSendWithoutPreset');
        const messageTextarea = this.popupElement.querySelector('#ggCorrectionsMessage');

        closeButton?.addEventListener('click', () => this.close());
        cancelButton?.addEventListener('click', () => this.close());
        applyButton?.addEventListener('click', () => this.applyCorrection());

        prevMessageButton?.addEventListener('click', () => this.changeMessage(-1));
        nextMessageButton?.addEventListener('click', () => this.changeMessage(1));
        prevSwipeButton?.addEventListener('click', () => this.changeSwipe(-1));
        nextSwipeButton?.addEventListener('click', () => this.changeSwipe(1));

        sendWithoutPresetCheckbox?.addEventListener('change', (event) => {
            this.sendWithoutPreset = !!event.target.checked;
            localStorage.setItem('gg_correctionsGenWithoutPreset', String(this.sendWithoutPreset));
        });

        if (messageTextarea) {
            const recordSelection = () => this.recordSelection(messageTextarea);
            messageTextarea.addEventListener('mouseup', recordSelection);
            messageTextarea.addEventListener('keyup', recordSelection);
            messageTextarea.addEventListener('select', recordSelection);
            // iOS/Safari: touch-based selection (long-press + drag handles) does
            // not fire mouseup and fires `select` unreliably. `touchend` covers
            // the moment the finger lifts after making/extending a selection.
            messageTextarea.addEventListener('touchend', () => {
                setTimeout(recordSelection, 50);
            }, { passive: true });
            // The reliable cross-platform signal for textarea selection changes is
            // `selectionchange` on `document` (it does not bubble to the textarea).
            // This is what actually fires on iPhone while dragging selection handles.
            this._bindDocumentSelectionChange(messageTextarea);
            // While focused, the native (yellow-tinted) selection is authoritative —
            // hide the overlay so the two never compete.
            messageTextarea.addEventListener('focus', () => {
                this.hideOverlay();
                this.restoreSelection(messageTextarea);
            });
            // On blur, paint a permanent yellow highlight from the recorded range so
            // the selection stays visible while the user edits the instruction box.
            messageTextarea.addEventListener('blur', () => {
                this.renderPersistentHighlight(messageTextarea.value || '');
            });
            const syncOverlayScroll = () => this.syncOverlayScroll(messageTextarea);
            messageTextarea.addEventListener('scroll', syncOverlayScroll, { passive: true });
        }

        const instructionTextarea = this.popupElement.querySelector('#ggCorrectionsInstruction');
        instructionTextarea?.addEventListener('input', () => {
            this._updateInstructionCount();
            this._setInstructionError(false);
        });
        instructionTextarea?.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                this.applyCorrection();
            }
        });

        this.popupElement.querySelectorAll('.gg-suggestion-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                if (!instructionTextarea) return;
                const suggestion = chip.dataset.instruction || '';
                const currentValue = instructionTextarea.value.trim();
                instructionTextarea.value = currentValue ? `${currentValue}\n${suggestion}` : suggestion;
                instructionTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                instructionTextarea.focus();
            });
        });

        this.popupElement.addEventListener('click', (event) => {
            if (event.target === this.popupElement) this.close();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.popupElement?.getAttribute('aria-hidden') === 'false') {
                this.close();
            }
        });
    }

    _updateInstructionCount() {
        const textarea = this.popupElement?.querySelector('#ggCorrectionsInstruction');
        const counter = this.popupElement?.querySelector('#ggCorrectionsInstructionCount');
        if (textarea && counter) {
            const count = textarea.value.length;
            counter.textContent = `${count} ${count === 1 ? 'character' : 'characters'}`;
        }
    }

    _setInstructionError(visible) {
        const textarea = this.popupElement?.querySelector('#ggCorrectionsInstruction');
        const error = this.popupElement?.querySelector('#ggCorrectionsInstructionError');
        textarea?.classList.toggle('gg-editor-input-error', visible);
        if (error) error.hidden = !visible;
    }

    open() {
        if (!this.initialized) {
            console.error('[GuidedGenerations][Corrections] Popup not initialized.');
            return;
        }

        const context = getContext();
        if (!context || !Array.isArray(context.chat) || context.chat.length === 0) {
            alert('No chat messages available to correct.');
            return;
        }

        this.messageIndex = context.chat.length - 1;
        this.swipeIndex = this._getDefaultSwipeIndex(context.chat[this.messageIndex]);

        const instructionTextarea = this.popupElement.querySelector('#ggCorrectionsInstruction');
        if (instructionTextarea) {
            instructionTextarea.value = lastCorrectionInstruction;
        }

        const sendWithoutPresetCheckbox = this.popupElement.querySelector('#ggCorrectionsSendWithoutPreset');
        if (sendWithoutPresetCheckbox) {
            sendWithoutPresetCheckbox.checked = this.sendWithoutPreset;
        }

        this.updateMessageDisplay();
        this._updateInstructionCount();
        this._setInstructionError(false);
        this.popupElement.style.display = 'flex';
        this.popupElement.setAttribute('aria-hidden', 'false');
        document.body.classList.add('gg-popup-open');
    }

    close() {
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
            this.popupElement.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('gg-popup-open');
        }
    }

    _getDefaultSwipeIndex(messageData) {
        if (!messageData) return 0;
        const swipeId = Number.isInteger(messageData.swipe_id) ? messageData.swipe_id : 0;
        const swipes = this._getSwipesForMessage(messageData);
        return Math.min(Math.max(swipeId, 0), Math.max(swipes.length - 1, 0));
    }

    _getSwipesForMessage(messageData) {
        if (!messageData) return [];
        if (Array.isArray(messageData.swipes) && messageData.swipes.length > 0) {
            return messageData.swipes;
        }
        return [messageData.mes || ''];
    }

    changeMessage(direction) {
        const context = getContext();
        if (!context || !Array.isArray(context.chat)) return;

        const newIndex = this.messageIndex + direction;
        if (newIndex < 0 || newIndex >= context.chat.length) return;

        this.messageIndex = newIndex;
        this.swipeIndex = this._getDefaultSwipeIndex(context.chat[this.messageIndex]);
        this.updateMessageDisplay();
    }

    changeSwipe(direction) {
        const context = getContext();
        if (!context || !Array.isArray(context.chat)) return;

        const messageData = context.chat[this.messageIndex];
        const swipes = this._getSwipesForMessage(messageData);
        const newIndex = this.swipeIndex + direction;
        if (newIndex < 0 || newIndex >= swipes.length) return;

        this.swipeIndex = newIndex;
        this.updateMessageDisplay();
    }

    updateMessageDisplay() {
        const context = getContext();
        if (!context || !Array.isArray(context.chat)) return;

        const messageData = context.chat[this.messageIndex];
        const swipes = this._getSwipesForMessage(messageData);
        const currentSwipe = swipes[this.swipeIndex] ?? messageData?.mes ?? '';

        const messageTextarea = this.popupElement.querySelector('#ggCorrectionsMessage');
        const messageInfo = this.popupElement.querySelector('#ggCorrectionsMessageInfo');
        const swipeInfo = this.popupElement.querySelector('#ggCorrectionsSwipeInfo');
        const prevMessageButton = this.popupElement.querySelector('#ggCorrectionsPrevMessage');
        const nextMessageButton = this.popupElement.querySelector('#ggCorrectionsNextMessage');
        const prevSwipeButton = this.popupElement.querySelector('#ggCorrectionsPrevSwipe');
        const nextSwipeButton = this.popupElement.querySelector('#ggCorrectionsNextSwipe');

        if (messageTextarea) messageTextarea.value = currentSwipe;
        if (messageInfo) messageInfo.textContent = `Message ${this.messageIndex + 1}/${context.chat.length}`;
        if (swipeInfo) swipeInfo.textContent = `Swipe ${this.swipeIndex + 1}/${swipes.length}`;

        if (prevMessageButton) prevMessageButton.disabled = this.messageIndex <= 0;
        if (nextMessageButton) nextMessageButton.disabled = this.messageIndex >= context.chat.length - 1;
        if (prevSwipeButton) prevSwipeButton.disabled = this.swipeIndex <= 0;
        if (nextSwipeButton) nextSwipeButton.disabled = this.swipeIndex >= swipes.length - 1;

        this.selectionStart = null;
        this.selectionEnd = null;
        this.updateSelectionIndicator();
        // Clear any persistent highlight from the previous message.
        this.hideOverlay();
        const overlay = this.popupElement?.querySelector('#ggCorrectionsMessageOverlay');
        if (overlay) overlay.innerHTML = '';
    }

    /**
     * Listen for `selectionchange` on `document`. This event does not bubble
     * and only fires on the document, but it is the only reliable signal that
     * the selection inside a textarea changed on iOS/Safari (where `mouseup`
     * and `select` are unreliable for touch-driven selection-handle drags).
     */
    _bindDocumentSelectionChange(textarea) {
        if (!textarea) return;
        // Guard against duplicate bindings across re-init.
        if (this._documentSelectionChangeBound) return;
        this._documentSelectionChangeBound = true;

        const handler = () => {
            // Only react when the change involves our message textarea.
            const active = document.activeElement;
            if (active !== textarea) return;
            // selectionchange fires very frequently during a drag; read the
            // indices directly so recordSelection stays the single source of
            // truth for what counts as a valid recorded range.
            this.recordSelection(textarea);
        };
        document.addEventListener('selectionchange', handler);
    }

    recordSelection(textarea) {
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
            this.selectionStart = start;
            this.selectionEnd = end;
            this.updateSelectionIndicator();
        }
    }

    restoreSelection(textarea) {
        if (!textarea) return;
        if (typeof this.selectionStart !== 'number' || typeof this.selectionEnd !== 'number') return;

        const maxLength = textarea.value.length;
        const start = Math.max(0, Math.min(this.selectionStart, maxLength));
        const end = Math.max(start, Math.min(this.selectionEnd, maxLength));
        if (end > start) {
            textarea.setSelectionRange(start, end);
        }
    }

    hideOverlay() {
        const overlay = this.popupElement?.querySelector('#ggCorrectionsMessageOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    showOverlay() {
        const overlay = this.popupElement?.querySelector('#ggCorrectionsMessageOverlay');
        if (overlay) overlay.style.display = 'block';
    }

    /**
     * Paint a permanent yellow highlight on the recorded range. Called on blur
     * so the selection stays visible while the user types in the instruction
     * field. Only the stored range is trusted (not live textarea indices, which
     * can be corrupted after blur).
     */
    renderPersistentHighlight(text) {
        const overlay = this.popupElement?.querySelector('#ggCorrectionsMessageOverlay');
        if (!overlay) return;

        const hasStored = typeof this.selectionStart === 'number'
            && typeof this.selectionEnd === 'number'
            && this.selectionEnd > this.selectionStart;

        if (!hasStored) {
            overlay.innerHTML = escapeHtml(text || '');
            overlay.style.display = 'none';
            return;
        }

        const start = Math.max(0, Math.min(this.selectionStart, text.length));
        const end = Math.max(start, Math.min(this.selectionEnd, text.length));
        const before = escapeHtml(text.slice(0, start));
        const selected = escapeHtml(text.slice(start, end));
        const after = escapeHtml(text.slice(end));
        overlay.innerHTML = `${before}<span class="gg-corrections-selection">${selected}</span>${after}`;
        overlay.style.display = 'block';
        // While hidden the overlay has no layout, so scroll offsets set earlier
        // were discarded — copy the textarea's position now to avoid a jump.
        this.syncOverlayScroll(this.popupElement?.querySelector('#ggCorrectionsMessage'));
    }

    syncOverlayScroll(textarea) {
        const overlay = this.popupElement?.querySelector('#ggCorrectionsMessageOverlay');
        if (!overlay) return;
        if (textarea && typeof textarea.scrollTop === 'number') {
            overlay.scrollTop = textarea.scrollTop;
            overlay.scrollLeft = textarea.scrollLeft;
        }
    }

    updateSelectionIndicator() {
        const indicator = this.popupElement?.querySelector('#ggCorrectionsSelectionInfo');
        if (!indicator) return;

        if (typeof this.selectionStart === 'number' && typeof this.selectionEnd === 'number' && this.selectionEnd > this.selectionStart) {
            const length = this.selectionEnd - this.selectionStart;
            indicator.textContent = `Recorded selection: ${length} characters.`;
        } else {
            indicator.textContent = 'No recorded selection.';
        }
    }

    resolveSelection(baseMessage, textarea) {
        // Only trust live textarea indices while the field is focused. After blur,
        // browsers may report a corrupted range (often selectionStart=0).
        const isFocused = textarea && document.activeElement === textarea;
        if (isFocused) {
            const activeStart = textarea.selectionStart;
            const activeEnd = textarea.selectionEnd;
            const hasActive = typeof activeStart === 'number' && typeof activeEnd === 'number' && activeEnd > activeStart;
            if (hasActive) {
                return { start: activeStart, end: activeEnd, hasSelection: true };
            }
        }

        const storedStart = this.selectionStart;
        const storedEnd = this.selectionEnd;
        const hasStored = typeof storedStart === 'number' && typeof storedEnd === 'number' && storedEnd > storedStart;
        if (hasStored) {
            const boundedStart = Math.max(0, Math.min(storedStart, baseMessage.length));
            const boundedEnd = Math.max(boundedStart, Math.min(storedEnd, baseMessage.length));
            return { start: boundedStart, end: boundedEnd, hasSelection: boundedEnd > boundedStart };
        }

        return { start: 0, end: 0, hasSelection: false };
    }

    async applyCorrection() {
        const context = getContext();
        if (!context || !Array.isArray(context.chat)) {
            console.error('[GuidedGenerations][Corrections] No chat context available.');
            return;
        }

        const instructionTextarea = this.popupElement.querySelector('#ggCorrectionsInstruction');
        const messageTextarea = this.popupElement.querySelector('#ggCorrectionsMessage');

        const instruction = instructionTextarea?.value?.trim() || '';
        if (!instruction) {
            this._setInstructionError(true);
            instructionTextarea?.focus();
            return;
        }

        lastCorrectionInstruction = instruction;
        this.close();

        const messageData = context.chat[this.messageIndex];
        if (!messageData) {
            console.error('[GuidedGenerations][Corrections] Selected message not found.');
            return;
        }

        const swipes = this._getSwipesForMessage(messageData);
        const baseMessage = swipes[this.swipeIndex] ?? messageData.mes ?? '';
        const { start: selectionStart, end: selectionEnd, hasSelection } = this.resolveSelection(baseMessage, messageTextarea);
        const selectedText = hasSelection ? baseMessage.slice(selectionStart, selectionEnd) : '';
        const taskPromptKey = hasSelection ? 'corrections.selectedTextTask' : 'corrections.fullMessageTask';

        const profileKey = 'profileCorrections';
        const presetKey = 'presetCorrections';
        const profileValue = extension_settings[extensionName]?.[profileKey] ?? '';
        const targetPreset = extension_settings[extensionName]?.[presetKey] ?? '';

        const promptTemplate = await getPromptValue('promptCorrections', '', {
            settings: extension_settings[extensionName],
        });
        const filledPrompt = fillPromptTemplate(promptTemplate, { input: instruction });

        const taskTemplate = await getPromptValue(taskPromptKey, '', {
            settings: extension_settings[extensionName],
        });
        const promptForModel = fillPromptTemplate(taskTemplate, {
            instruction: filledPrompt,
            historyBlock: '', // No history block in prompt template
            baseMessage,
            selectedText,
        });

        debugLog(`[GuidedGenerations][Corrections] Using profile: ${profileValue || 'current'}, preset: ${targetPreset || 'none'}`);

        try {
            const useDirectCall = await shouldUseDirectCall(profileValue, targetPreset);
            let correctedText = '';

            // Close the popup and lock the send button so the user sees that
            // a generation is in progress (matching spellchecker/requestCompletion behavior).
            this.close();
            setSendButtonState?.(true);
            deactivateSendButtons?.();

            try {
                if (useDirectCall && !this.sendWithoutPreset) {
                    correctedText = await requestCompletion({
                        profileName: profileValue,
                        presetName: targetPreset,
                        prompt: promptForModel,
                        promptKey: taskPromptKey,
                        debugLabel: 'corrections',
                        includeChatHistory: false,
                        includeIdentityContext: true,
                    });
                } else if (typeof context.executeSlashCommandsWithOptions === 'function') {
                    if (this.sendWithoutPreset) {
                        const escapedPrompt = promptForModel.replace(/\r?\n/g, '{{newline}}');
                        const result = await context.executeSlashCommandsWithOptions(`/genraw quiet=true ${escapedPrompt} |`, {
                            showOutput: false,
                            handleExecutionErrors: true,
                        });
                        correctedText = result?.pipe || '';
                    } else {
                        const injectionRole = extension_settings[extensionName]?.injectionEndRole ?? 'system';
                        const role = INJECT_ROLES[String(injectionRole).toLowerCase()] ?? INJECT_ROLES.system;
                        registerInjectionPromptSlot('script_inject_correctionsInstruct', taskPromptKey);
                        setTemporaryInjection(context, 'correctionsInstruct', promptForModel, { role });

                        const originalChat = [...(context.chat || [])];
                        if (context.chat) {
                            context.chat.length = 0;
                            // Add dummy system message to prevent greeting generation
                            context.chat.push({
                                name: 'System',
                                is_user: false,
                                is_system: true,
                                send_date: Date.now(),
                                mes: 'Applying correction...',
                                extra: { type: 'temp_correction_gen' }
                            });
                        }

                        try {
                            const genResult = await context.executeSlashCommandsWithOptions(`/gen quiet=true |`, {
                                showOutput: false,
                                handleExecutionErrors: true,
                            });
                            correctedText = genResult?.pipe || '';
                        } finally {
                            flushTemporaryInjection(context, 'correctionsInstruct');
                            if (context.chat) {
                                context.chat.length = 0;
                                context.chat.push(...originalChat);
                                if (typeof context.saveChat === 'function') await context.saveChat();
                                if (typeof context.reloadCurrentChat === 'function') await context.reloadCurrentChat();
                            }
                        }
                    }
                } else {
                    console.error('[GuidedGenerations][Corrections] context.executeSlashCommandsWithOptions not found.');
                }
            } finally {
                activateSendButtons?.();
                setSendButtonState?.(false);
                requestAnimationFrame(() => {
                    activateSendButtons?.();
                    setSendButtonState?.(false);
                });
            }

            if (!correctedText || correctedText.trim() === '') {
                console.error('[GuidedGenerations][Corrections] No corrected text received.');
                return;
            }

            const updatedMessage = hasSelection
                ? `${baseMessage.slice(0, selectionStart)}${correctedText}${baseMessage.slice(selectionEnd)}`
                : correctedText;

            await applyCorrectionSwipe(context, this.messageIndex, updatedMessage);
        } catch (error) {
            console.error('[GuidedGenerations][Corrections] Error during Corrections apply:', error);
            alert(`Corrections Tool Error: ${error.message || 'An unexpected error occurred.'}`);
        }
    }
}

const correctionsPopup = new CorrectionsPopup();

/**
 * Provides a tool to modify the last message based on user's instructions
 * 
 * @returns {Promise<void>}
 */
export default async function corrections() {
    debugLog('[GuidedGenerations][Corrections] Tool activated.');
    if (!correctionsPopup.initialized) {
        await correctionsPopup.init();
    }
    correctionsPopup.open();
}

/**
 * Helper function to execute ST-Script commands
 * @param {string} stscript - The ST-Script command to execute
 */
async function applyCorrectionSwipe(context, messageIndex, correctedText) {
    await appendSwipeToMessage(context, messageIndex, correctedText, {
        source: 'manual',
        model: 'Guided Generations',
    });

    // Refresh swipe UI (chevrons) so the user can navigate between the
    // original and the new correction swipe. Without this, the back-chevron
    // may not appear when correcting the first pass of a message.
    try {
        if (context?.swipe?.refresh && typeof context.swipe.refresh === 'function') {
            context.swipe.refresh(true, false);
        }
    } catch (refreshError) {
        debugLog('[GuidedGenerations][Corrections] Could not refresh swipe buttons:', refreshError);
    }
}

// Export the function
export { corrections };
