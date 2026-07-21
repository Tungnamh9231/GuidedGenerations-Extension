/**
 * Edit Intros Popup - Handles UI for editing character intros using AI generation.
 * Rewritten to use strict SillyTavern /gen command injection.
 */
/**
 * Edit Intros Popup - Handles UI for editing character intros using AI generation.
 * Rewritten to use strict SillyTavern /gen command injection.
 */

import {
    getContext,
    debugLog,
    activateSendButtons,
    setSendButtonState,
    getPromptValue,
    fillPromptTemplate
} from '../persistentGuides/guideExports.js';
import { appendSwipeToMessage } from '../utils/swipeHelpers.js';
import { PromptTabManager } from './promptTabManager.js';

export class EditIntrosPopup {
    constructor() {
        this.popupElement = null;
        this.initialized = false;
        this.lastCustomCommand = sessionStorage.getItem('gg_lastCustomCommand') || '';
    }

    async init() {
        if (this.initialized) return;

        if (!document.getElementById('editIntrosPopup')) {
            this.promptTabManager = new PromptTabManager('editIntros', [
                { 
                    key: 'editExisting', 
                    label: 'Edit Existing', 
                    variables: [
                        { short: 'i', long: 'instruction', desc: 'User edit instruction' },
                        { short: 'mtr', long: 'messageToRewrite', desc: 'Current greeting message' }
                    ]
                },
                { 
                    key: 'makeNew', 
                    label: 'Create New', 
                    variables: [
                        { short: 'i', long: 'instruction', desc: 'User creation instruction' }
                    ]
                }
            ]);
            const promptTabHtml = this.promptTabManager.getHtml();

            const popupHtml = `
                <div id="editIntrosPopup" class="gg-popup gg-editor-popup" role="dialog" aria-modal="true" aria-labelledby="gg-edit-intros-title" aria-hidden="true">
                    <div class="gg-popup-content gg-editor-dialog gg-intro-editor-dialog">
                        <div class="gg-popup-header">
                            <div class="gg-editor-title-group">
                                <span class="gg-editor-title-icon" aria-hidden="true">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                                </span>
                                <div>
                                    <span class="gg-editor-eyebrow">AI writing assistant</span>
                                    <h2 id="gg-edit-intros-title">Edit Intro</h2>
                                    <p>Polish the current greeting or create a fresh opening.</p>
                                </div>
                            </div>
                            <button type="button" class="gg-popup-close" aria-label="Close Edit Intro">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                        <div class="gg-popup-body gg-editor-body">
                            <div class="gg-tabs" role="tablist" aria-label="Intro editor sections">
                                <button type="button" id="gg-intros-tab-normal" class="gg-tab-btn active" data-tab="normal" role="tab" aria-selected="true" aria-controls="gg-tab-normal">
                                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                                    <span>Write</span>
                                </button>
                                <button type="button" id="gg-intros-tab-prompts" class="gg-tab-btn" data-tab="prompts" role="tab" aria-selected="false" aria-controls="gg-tab-prompts">
                                    <i class="fa-solid fa-terminal" aria-hidden="true"></i>
                                    <span>Prompt</span>
                                </button>
                            </div>

                            <div id="gg-tab-normal" class="gg-tab-content active" role="tabpanel" aria-labelledby="gg-intros-tab-normal">
                                <section class="gg-popup-section gg-editor-card gg-editor-preview-card">
                                <div class="gg-editor-section-heading">
                                    <div>
                                        <span class="gg-editor-section-label">Current greeting</span>
                                        <p>The opening message that will be used by Rewrite.</p>
                                    </div>
                                    <span id="gg-current-intro-stats" class="gg-editor-meta">0 words</span>
                                </div>
                                <div id="gg-current-intro-display" class="gg-editor-current-text">
                                    <span class="gg-current-desc-empty">No intro message available.</span>
                                </div>
                            </section>

                            <section class="gg-popup-section gg-editor-card gg-custom-command-section">
                                <div class="gg-editor-section-heading">
                                    <div>
                                        <label for="gg-custom-edit-command" class="gg-editor-section-label">What should change?</label>
                                        <p>Describe tone, point of view, pacing, length, or any details to include.</p>
                                    </div>
                                    <span class="gg-editor-required">Required</span>
                                </div>
                                <textarea id="gg-custom-edit-command" class="text_pole gg-editor-textarea" rows="6" placeholder="Example: Make the opening more atmospheric, keep it in third person, and end with a clear invitation for {{user}} to respond."></textarea>
                                <div class="gg-editor-field-footer">
                                    <div class="gg-editor-suggestions" aria-label="Quick instruction suggestions">
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Make the intro more immersive and atmospheric.">More immersive</button>
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Make the opening shorter and more direct.">Shorter opening</button>
                                        <button type="button" class="gg-suggestion-chip" data-instruction="Rewrite the intro in first-person point of view.">First-person POV</button>
                                    </div>
                                    <span id="gg-intro-instruction-count" class="gg-editor-meta">0 characters</span>
                                </div>
                                <p id="gg-intro-instruction-error" class="gg-editor-error" role="alert" hidden>Please enter an instruction.</p>
                            </section>
                            </div>

                            <div id="gg-tab-prompts" class="gg-tab-content" role="tabpanel" aria-labelledby="gg-intros-tab-prompts" hidden>
                                ${promptTabHtml}
                            </div>
                        </div>
                        <div class="gg-popup-footer-wrap gg-editor-footer-wrap">
                            <div class="gg-editor-footer-note">
                                <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
                                <span>Rewrite preserves the current greeting; New Intro starts from your instruction.</span>
                            </div>
                            <div class="gg-popup-footer">
                                <button type="button" id="ggCancelEditIntros" class="gg-button gg-button-quiet">Cancel</button>
                                <button type="button" id="ggMakeNewIntro" class="gg-button gg-button-secondary gg-editor-action-button">
                                    <i class="fa-regular fa-file" aria-hidden="true"></i>
                                    <span>New Intro</span>
                                </button>
                                <button type="button" id="ggApplyEditIntros" class="gg-button gg-button-primary gg-editor-action-button">
                                    <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                                    <span>Rewrite Current</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            const popupContainer = document.createElement('div');
            popupContainer.innerHTML = popupHtml;
            document.body.appendChild(popupContainer.firstElementChild);
        }

        this.popupElement = document.getElementById('editIntrosPopup');
        const commandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        if (commandTextarea) {
            commandTextarea.value = this.lastCustomCommand;
            this._updateInstructionCount();
        }
        this.setupEventListeners();
        if (this.promptTabManager) {
            this.promptTabManager.setupEventListeners(this.popupElement);
        }
        this.initialized = true;
    }

    setupEventListeners() {
        if (!this.popupElement) return;

        const closeButton = this.popupElement.querySelector('.gg-popup-close');
        const cancelButton = this.popupElement.querySelector('#ggCancelEditIntros');
        const applyButton = this.popupElement.querySelector('#ggApplyEditIntros');
        const makeNewIntroButton = this.popupElement.querySelector('#ggMakeNewIntro');

        closeButton.addEventListener('click', () => this.close());
        cancelButton.addEventListener('click', () => this.close());
        applyButton.addEventListener('click', () => this.applyChanges());
        makeNewIntroButton.addEventListener('click', () => this.makeNewIntro());

        const commandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        commandTextarea?.addEventListener('input', () => {
            this._updateInstructionCount();
            this._setInstructionError(false);
        });
        commandTextarea?.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                if (!applyButton.disabled) this.applyChanges();
            }
        });

        this.popupElement.querySelectorAll('.gg-suggestion-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                if (!commandTextarea) return;
                const suggestion = chip.dataset.instruction || '';
                const currentValue = commandTextarea.value.trim();
                commandTextarea.value = currentValue ? `${currentValue}\n${suggestion}` : suggestion;
                commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                commandTextarea.focus();
            });
        });

        this.popupElement.addEventListener('click', (event) => {
            if (event.target === this.popupElement) this.close();
        });

        // Tabs
        const tabBtns = this.popupElement.querySelectorAll('.gg-tab-btn');
        const tabContents = this.popupElement.querySelectorAll('.gg-tab-content');
        const footerWrap = this.popupElement.querySelector('.gg-popup-footer-wrap');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const selectedButton = e.currentTarget;
                const targetTab = selectedButton.getAttribute('data-tab');

                // Update buttons
                tabBtns.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                selectedButton.classList.add('active');
                selectedButton.setAttribute('aria-selected', 'true');

                // Update contents
                tabContents.forEach(content => {
                    const isActive = content.id === `gg-tab-${targetTab}`;
                    content.hidden = !isActive;
                    content.classList.toggle('active', isActive);
                });

                // Toggle footer
                if (footerWrap) {
                    footerWrap.hidden = targetTab === 'prompts';
                }
            });
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.popupElement?.getAttribute('aria-hidden') === 'false') {
                this.close();
            }
        });
    }

    open() {
        if (!this.initialized) {
            this.init().then(() => {
                this._show();
            });
        } else if (this.popupElement) {
            this._show();
        }
    }

    close() {
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
            this.popupElement.setAttribute('aria-hidden', 'true');
        }
    }

    _show() {
        if (!this.popupElement) return;
        this._refreshIntroPreview();
        this._updateInstructionCount();
        this._setInstructionError(false);
        this.popupElement.style.display = 'flex';
        this.popupElement.setAttribute('aria-hidden', 'false');
        const canAutoFocus = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
        if (canAutoFocus) {
            requestAnimationFrame(() => {
                this.popupElement?.querySelector('#gg-custom-edit-command')?.focus({ preventScroll: true });
            });
        }
    }

    _refreshIntroPreview() {
        const display = this.popupElement?.querySelector('#gg-current-intro-display');
        const stats = this.popupElement?.querySelector('#gg-current-intro-stats');
        const rewriteButton = this.popupElement?.querySelector('#ggApplyEditIntros');
        if (!display) return;

        const context = getContext();
        const introText = context?.chat?.[0]?.mes?.trim() || '';
        if (introText) {
            display.textContent = introText;
            const wordCount = introText.split(/\s+/).filter(Boolean).length;
            if (stats) stats.textContent = `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`;
            if (rewriteButton) {
                rewriteButton.disabled = false;
                rewriteButton.removeAttribute('title');
            }
        } else {
            display.innerHTML = '<span class="gg-current-desc-empty">No intro message available.</span>';
            if (stats) stats.textContent = '0 words';
            if (rewriteButton) {
                rewriteButton.disabled = true;
                rewriteButton.title = 'There is no current intro to rewrite.';
            }
        }
    }

    _updateInstructionCount() {
        const textarea = this.popupElement?.querySelector('#gg-custom-edit-command');
        const counter = this.popupElement?.querySelector('#gg-intro-instruction-count');
        if (textarea && counter) {
            const count = textarea.value.length;
            counter.textContent = `${count} ${count === 1 ? 'character' : 'characters'}`;
        }
    }

    _setInstructionError(visible) {
        const textarea = this.popupElement?.querySelector('#gg-custom-edit-command');
        const error = this.popupElement?.querySelector('#gg-intro-instruction-error');
        textarea?.classList.toggle('gg-editor-input-error', visible);
        if (error) error.hidden = !visible;
    }

    async applyChanges() {
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        const instruction = customCommandTextarea.value.trim();

        if (!instruction) {
            this._setInstructionError(true);
            customCommandTextarea.focus();
            return;
        }

        sessionStorage.setItem('gg_lastCustomCommand', instruction);
        this.close();

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable.');
                return;
            }

            const targetIndex = context?.chat?.length ? 0 : -1;
            let messageToRewrite = '';
            if (targetIndex !== -1 && context.chat[targetIndex]) {
                messageToRewrite = context.chat[targetIndex].mes;
            } else {
                console.error('[GuidedGenerations] No intro message found to rewrite.');
                alert('No intro message found to rewrite.');
                return;
            }

            const template = await this.promptTabManager.getPrompt('editExisting');
            const promptText = fillPromptTemplate(template, { instruction, messageToRewrite });

            await this.executeGeneration(context, promptText);
        } catch (error) {
            console.error('[GuidedGenerations] Error executing Edit Intro request:', error);
        }
    }

    async makeNewIntro() {
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-command');
        const instruction = customCommandTextarea.value.trim();

        if (!instruction) {
            this._setInstructionError(true);
            customCommandTextarea.focus();
            return;
        }

        sessionStorage.setItem('gg_lastCustomCommand', instruction);
        this.close();

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable.');
                return;
            }

            const template = await this.promptTabManager.getPrompt('makeNew');
            const promptText = fillPromptTemplate(template, { instruction });
            await this.executeGeneration(context, promptText);
        } catch (error) {
            console.error('[GuidedGenerations] Error executing Make New Intro request:', error);
        }
    }

    async executeGeneration(context, promptText) {
        const originalChat = [...(context.chat || [])];
        
        // Isolate chat context
        if (context.chat) {
            context.chat.length = 0;
            context.chat.push({
                name: 'User',
                is_user: true,
                is_system: false,
                send_date: Date.now(),
                mes: promptText,
                extra: { type: 'temp_intro_gen' }
            });
        }

        setSendButtonState?.(true);
        try {
            activateSendButtons?.();
            const $sendButton = $('#send_but');
            if ($sendButton.length) {
                $sendButton.removeClass('fa-paper-plane').addClass('fa-stop-circle');
            }
        } catch (e) {
            /* ignore */
        }

        let generatedIntro = '';
        try {
            debugLog('[EditIntros] Using /gen with injected prompt at end of chat...');
            const genResult = await context.executeSlashCommandsWithOptions(`/gen quiet=true |`, {
                showOutput: false,
                handleExecutionErrors: true,
            });
            generatedIntro = genResult?.pipe || '';
        } catch (genError) {
            console.error('[GuidedGenerations] Intro generation failed:', genError);
        } finally {
            if (context.chat) {
                context.chat.length = 0;
                context.chat.push(...originalChat);
                if (typeof context.saveChat === 'function') await context.saveChat();
                if (typeof context.reloadCurrentChat === 'function') await context.reloadCurrentChat();
            }
        }

        // Resync UI buttons
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
            activateSendButtons?.();
            setSendButtonState?.(false);
            const $sendButton = $('#send_but');
            if ($sendButton.length) {
                $sendButton.removeClass('fa-stop-circle').addClass('fa-paper-plane');
            }
        } catch (e) {
            /* ignore */
        }

        if (!generatedIntro || generatedIntro.trim() === '') {
            console.error('[GuidedGenerations] No generated intro text received.');
            return;
        }

        await this.applyIntroUpdate(context, generatedIntro);
    }

    async applyIntroUpdate(context, introText) {
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
            if (context.chat) {
                context.chat.push(message);
            }
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
}

// Singleton instance
const editIntrosPopup = new EditIntrosPopup();
export default editIntrosPopup;
