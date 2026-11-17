/**
 * Edit Description Popup - Handles UI for editing character descriptions using AI generation.
 * Features:
 *   - Display current character description (read-only)
 *   - "Show edit result after gen" checkbox with diff highlighting
 *   - Collapsible guidebook with usage instructions
 */

import {
    extensionName,
    getContext,
    extension_settings,
    debugLog,
    activateSendButtons,
    deactivateSendButtons,
    setSendButtonState,
    getPromptValue,
    fillPromptTemplate
} from '../persistentGuides/guideExports.js'; // Import from central hub
import { openRequestPromptSlot, closeRequestPromptSlot } from '../promptManager/store.js';
import descriptionHistory from './descriptionHistory.js';



// ─── Hybrid line + word-level diff (LCS-based) ─────────────────────
/**
 * Generic LCS diff on any two arrays of strings.
 * Returns array of { type: 'unchanged'|'added'|'removed', text: string }
 */
function computeLCS(oldArr, newArr) {
    const m = oldArr.length;
    const n = newArr.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldArr[i - 1] === newArr[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
            result.push({ type: 'unchanged', text: oldArr[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.push({ type: 'added', text: newArr[j - 1] });
            j--;
        } else {
            result.push({ type: 'removed', text: oldArr[i - 1] });
            i--;
        }
    }
    return result.reverse();
}

/**
 * Tokenize text into word, whitespace, and punctuation tokens for word-level diffing.
 * This separates punctuation from words (e.g. "dã." -> "dã", ".") to improve diff accuracy.
 */
function tokenizeWords(text) {
    return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}\s_]+/gu) || [];
}

/**
 * Compute a line-by-line diff, then post-process to detect modified lines
 * (consecutive removed+added pairs) and produce word-level inline diffs for them.
 * Returns array of:
 *   { type: 'unchanged', text }
 *   { type: 'added', text }
 *   { type: 'removed', text }
 *   { type: 'modified', oldText, newText }  ← word-level diff rendered inline
 */
function computeLineDiff(oldText, newText) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const rawDiff = computeLCS(oldLines, newLines);

    // Post-process: group consecutive removed+added as 'modified'
    const result = [];
    let idx = 0;
    while (idx < rawDiff.length) {
        if (rawDiff[idx].type === 'unchanged') {
            result.push(rawDiff[idx]);
            idx++;
        } else {
            // Collect consecutive non-unchanged entries
            const removedLines = [];
            const addedLines = [];
            while (idx < rawDiff.length && rawDiff[idx].type !== 'unchanged') {
                if (rawDiff[idx].type === 'removed') removedLines.push(rawDiff[idx].text);
                if (rawDiff[idx].type === 'added') addedLines.push(rawDiff[idx].text);
                idx++;
            }
            if (removedLines.length > 0 && addedLines.length > 0) {
                // Modified: pair them for word-level diff
                result.push({
                    type: 'modified',
                    oldText: removedLines.join('\n'),
                    newText: addedLines.join('\n'),
                });
            } else {
                // Pure addition or pure removal
                for (const line of removedLines) result.push({ type: 'removed', text: line });
                for (const line of addedLines) result.push({ type: 'added', text: line });
            }
        }
    }
    return result;
}

/**
 * Word-level diff for a pair of lines, rendered separately for the old and
 * new sides so the final view can keep removed lines above added lines.
 */
function renderInlineDiff(oldText, newText) {
    const oldTokens = tokenizeWords(oldText);
    const newTokens = tokenizeWords(newText);
    const wordDiff = computeLCS(oldTokens, newTokens);

    let oldHtml = '';
    let newHtml = '';
    for (const entry of wordDiff) {
        const escaped = escapeHtml(entry.text);
        switch (entry.type) {
            case 'removed':
                oldHtml += `<span class="gg-diff-word-removed">${escaped}</span>`;
                break;
            case 'added':
                newHtml += `<span class="gg-diff-word-added">${escaped}</span>`;
                break;
            default:
                oldHtml += escaped;
                newHtml += escaped;
                break;
        }
    }
    return { oldHtml, newHtml };
}

/**
 * Render a modified block the GitHub way: every removed line first (red),
 * then every added line (green). Lines are paired by index for inline
 * word-level highlights where both sides exist.
 */
function renderModifiedBlock(oldText, newText) {
    const oldLines = String(oldText ?? '').split('\n');
    const newLines = String(newText ?? '').split('\n');
    const pairCount = Math.min(oldLines.length, newLines.length);
    const pairs = [];
    for (let index = 0; index < pairCount; index++) {
        pairs.push(renderInlineDiff(oldLines[index], newLines[index]));
    }

    const removedHtml = oldLines.map((line, index) => {
        const content = index < pairCount ? pairs[index].oldHtml : escapeHtml(line || ' ');
        return `<div class="gg-diff-line gg-diff-removed"><span class="gg-diff-prefix">−</span>${content || ' '}</div>`;
    }).join('');
    const addedHtml = newLines.map((line, index) => {
        const content = index < pairCount ? pairs[index].newHtml : escapeHtml(line || ' ');
        return `<div class="gg-diff-line gg-diff-added"><span class="gg-diff-prefix">+</span>${content || ' '}</div>`;
    }).join('');
    return `${removedHtml}${addedHtml}`;
}

/**
 * Render diff result into HTML string. Removed lines are emitted before
 * added lines for every changed block, matching a normal unified diff.
 */
function renderDiffHtml(diffResult, { showHeader = true } = {}) {
    const header = `<div class="gg-diff-header">
        <span>Diff View</span>
        <span class="gg-diff-legend"><span class="gg-diff-legend-color gg-diff-legend-added"></span> Added</span>
        <span class="gg-diff-legend"><span class="gg-diff-legend-color gg-diff-legend-removed"></span> Removed</span>
    </div>`;

    const lines = diffResult.map(entry => {
        switch (entry.type) {
            case 'added': {
                const escaped = escapeHtml(entry.text || ' ');
                return `<div class="gg-diff-line gg-diff-added"><span class="gg-diff-prefix">+</span>${escaped}</div>`;
            }
            case 'removed': {
                const escaped = escapeHtml(entry.text || ' ');
                return `<div class="gg-diff-line gg-diff-removed"><span class="gg-diff-prefix">−</span>${escaped}</div>`;
            }
            case 'modified': {
                return renderModifiedBlock(entry.oldText, entry.newText);
            }
            default: {
                const escaped = escapeHtml(entry.text || ' ');
                return `<div class="gg-diff-line gg-diff-unchanged"><span class="gg-diff-prefix"> </span>${escaped}</div>`;
            }
        }
    }).join('');

    return `${showHeader ? header : ''}${lines}`;
}

function historyModeLabel(mode) {
    const labels = {
        before: 'Before change',
        editExisting: 'Edit Existing',
        makeNew: 'Create New',
        createWorld: 'Create World',
        revert: 'Revert',
    };
    return labels[mode] || 'Change';
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Guidebook HTML ─────────────────────────────────────────────────
const GUIDEBOOK_HTML = `
 <details class="gg-guidebook">
    <summary><i class="fa-regular fa-circle-question" aria-hidden="true"></i> How Edit Description works</summary>
    <div class="gg-guidebook-content">
        <h4>Previewing edits</h4>
        <p>When you use <strong>Edit Existing</strong>, the result is not saved immediately. Instead:</p>
        <ul>
            <li>After generation completes, the modal reopens automatically.</li>
            <li>You will see a <strong>diff view</strong> comparing the old and new description.</li>
            <li><span style="color:#3fb950;">Green lines (+)</span> = newly added content.</li>
            <li><span style="color:#f85149;">Red lines (-)</span> = removed content.</li>
            <li>Click <strong>Apply</strong> to save the changes, or <strong>Discard</strong> to throw them away.</li>
        </ul>
        <p><em>Create New and Create World replace the description immediately; only Edit Existing opens the comparison preview.</em></p>
        <h4>History and revert</h4>
        <p>Every applied change saves the description from before that change as a snapshot for the current character (up to 10). Open the <strong>History</strong> tab to revert to a snapshot or delete snapshots. History is removed automatically when its character is deleted.</p>
    </div>
</details>
`;


// ─── Class ──────────────────────────────────────────────────────────
export class EditDescriptionPopup {
    constructor() {
        this.popupElement = null;
        this.initialized = false;
        this.lastCustomCommand = sessionStorage.getItem('gg_lastCustomDescCommand') || '';
        this.formatEnabled = localStorage.getItem('gg_editDescFormatEnabled') !== 'false';
        this._previousDescription = null; // Stored before gen for diff
        this._pendingGeneratedDescription = null; // Stored for Apply button
        this._isDiffMode = false; // Currently showing diff?
        this._isPreviewMode = false; // Currently in preview mode?
        this._pendingCharacter = null; // Character captured when generation starts
        this.comparePopup = null;
        this.compareState = null;
    }

    /**
     * Initialize the popup
     */
    async init() {
        if (this.initialized) return;

        // Create popup container if it doesn't exist
        if (!document.getElementById('editDescriptionPopup')) {
            const savedFormatsStr = localStorage.getItem('gg_editDescFormats') || '[]';
            let savedFormats = [];
            try {
                savedFormats = JSON.parse(savedFormatsStr);
            } catch (e) { }

            let formatListHtml = '';
            savedFormats.forEach(val => {
                formatListHtml += `
                    <div class="gg-format-item">
                        <textarea class="gg-format-value text_pole" rows="2" aria-label="Description format field" placeholder="Example: Name:&#10;Appearance:&#10;Personality:">${escapeHtml(val)}</textarea>
                        <button type="button" class="gg-remove-format-btn" title="Remove format field" aria-label="Remove format field">
                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </div>
                `;
            });

            const popupHtml = `
                <div id="editDescriptionPopup" class="gg-popup gg-editor-popup" role="dialog" aria-modal="true" aria-labelledby="gg-edit-description-title" aria-hidden="true">
                    <div class="gg-popup-content gg-editor-dialog gg-description-editor-dialog">
                        <div class="gg-popup-header">
                            <div class="gg-editor-title-group">
                                <span class="gg-editor-title-icon" aria-hidden="true">
                                    <i class="fa-solid fa-address-card"></i>
                                </span>
                                <div>
                                    <span class="gg-editor-eyebrow">Character builder</span>
                                    <h2 id="gg-edit-description-title">Edit Description</h2>
                                    <p>Shape character details or build a world context with AI.</p>
                                </div>
                            </div>
                            <button type="button" class="gg-popup-close" aria-label="Close Edit Description">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                        <div class="gg-popup-body gg-editor-body">
                            <div class="gg-tabs" role="tablist" aria-label="Description editor sections">
                                <button type="button" id="gg-description-tab-normal" class="gg-tab-btn active" data-tab="normal" role="tab" aria-selected="true" aria-controls="gg-tab-normal">
                                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                                    <span>Write</span>
                                </button>
                                <button type="button" id="gg-description-tab-format" class="gg-tab-btn" data-tab="format" role="tab" aria-selected="false" aria-controls="gg-tab-format">
                                    <i class="fa-solid fa-list-check" aria-hidden="true"></i>
                                    <span>Output Format</span>
                                </button>
                                <button type="button" id="gg-description-tab-history" class="gg-tab-btn" data-tab="history" role="tab" aria-selected="false" aria-controls="gg-tab-history">
                                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
                                    <span>History</span>
                                </button>
                            </div>

                            <div id="gg-tab-normal" class="gg-tab-content active" role="tabpanel" aria-labelledby="gg-description-tab-normal">
                                <!-- Current Description Section -->
                                <section class="gg-popup-section gg-editor-card gg-current-desc-section">
                                    <div class="gg-editor-section-heading">
                                        <div>
                                            <h3>Current Description</h3>
                                            <p>The source used when you choose Edit Existing.</p>
                                        </div>
                                        <span id="gg-current-desc-stats" class="gg-editor-meta">0 words</span>
                                    </div>
                                    <div id="gg-current-desc-display" class="gg-current-desc-container">
                                        <span class="gg-current-desc-empty">No description available.</span>
                                    </div>
                                </section>
                                
                                <!-- Custom Command Section -->
                                <section class="gg-popup-section gg-editor-card gg-custom-command-section">
                                    <div class="gg-editor-section-heading">
                                        <div>
                                            <label for="gg-custom-edit-description-command" class="gg-editor-section-label">What should the description include?</label>
                                            <p>Be specific about traits, appearance, tone, setting, or structure.</p>
                                        </div>
                                        <span class="gg-editor-required">Required</span>
                                    </div>
                                    <textarea id="gg-custom-edit-description-command" class="text_pole gg-editor-textarea" rows="6" placeholder="Example: Add subtle flaws, sharpen the visual details, and keep the description under 250 words."></textarea>
                                    <div class="gg-editor-field-footer">
                                        <div class="gg-editor-suggestions" aria-label="Quick instruction suggestions">
                                            <button type="button" class="gg-suggestion-chip" data-instruction="Add more personality, motivations, and believable flaws.">Richer personality</button>
                                            <button type="button" class="gg-suggestion-chip" data-instruction="Refine the physical appearance with vivid, specific details.">Refine appearance</button>
                                            <button type="button" class="gg-suggestion-chip" data-instruction="Make the description concise and remove repetitive details.">Make concise</button>
                                        </div>
                                        <span id="gg-description-instruction-count" class="gg-editor-meta">0 characters</span>
                                    </div>
                                    <p id="gg-description-instruction-error" class="gg-editor-error" role="alert" hidden>Please enter an instruction.</p>
                                </section>
                            </div>
                            
                            <div id="gg-tab-format" class="gg-tab-content" role="tabpanel" aria-labelledby="gg-description-tab-format" hidden>
                                <section class="gg-popup-section gg-editor-card gg-format-section">
                                    <div class="gg-editor-section-heading">
                                        <div>
                                            <h3>Output Format</h3>
                                            <p>Define a reusable structure for newly generated character descriptions.</p>
                                        </div>
                                        <div class="gg-checkbox-row gg-format-toggle">
                                            <input type="checkbox" id="gg-enable-format-checkbox" ${this.formatEnabled ? 'checked' : ''}>
                                            <label for="gg-enable-format-checkbox">Use format</label>
                                        </div>
                                    </div>
                                    <div class="gg-editor-info-callout">
                                        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
                                        <span>This format applies only to <strong>Create New</strong>. Empty fields are ignored.</span>
                                    </div>
                                    <div id="gg-format-list" class="gg-format-list">
                                        ${formatListHtml}
                                    </div>
                                    <button type="button" id="gg-add-format-btn" class="gg-button gg-button-secondary gg-add-format-btn">
                                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                                        <span>Add format field</span>
                                    </button>
                                </section>
                            </div>

                            <div id="gg-tab-history" class="gg-tab-content" role="tabpanel" aria-labelledby="gg-description-tab-history" hidden>
                                <section class="gg-popup-section gg-editor-card gg-history-section">
                                    <div class="gg-editor-section-heading">
                                        <div>
                                            <h3>Revert History</h3>
                                            <p id="gg-history-subtitle">Descriptions from before each change for the current character. Up to 10 are kept per character.</p>
                                        </div>
                                        <span id="gg-history-count" class="gg-editor-meta">0 / 10 saved</span>
                                    </div>
                                    <div class="gg-desc-history-toolbar">
                                        <button type="button" id="gg-history-view-all" class="gg-button gg-button-secondary">
                                            <i class="fa-solid fa-table-list" aria-hidden="true"></i>
                                            <span>View all characters</span>
                                        </button>
                                        <button type="button" id="gg-history-clear" class="gg-button gg-button-quiet gg-desc-history-danger">
                                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                                            <span>Delete all</span>
                                        </button>
                                    </div>
                                    <div id="gg-history-list" class="gg-desc-history-list"></div>
                                </section>
                            </div>

                            ${GUIDEBOOK_HTML}
                        </div>
                        <div class="gg-popup-footer-wrap gg-editor-footer-wrap">
                            <div class="gg-editor-footer-note">
                                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                                <span>Edit Existing opens a diff preview before anything is saved.</span>
                            </div>
                            <div class="gg-popup-footer">
                                <button type="button" id="ggCancelEditDescription" class="gg-button gg-button-quiet">Cancel</button>
                                <button type="button" id="ggRevertEdit" class="gg-button gg-button-secondary gg-editor-action-button" style="display: none;">
                                    <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                                    <span>Discard</span>
                                </button>
                                <button type="button" id="ggApplyEdit" class="gg-button gg-button-primary gg-editor-action-button" style="display: none;">
                                    <i class="fa-solid fa-check" aria-hidden="true"></i>
                                    <span>Apply Changes</span>
                                </button>
                                <button type="button" id="ggCreateNewDescription" class="gg-button gg-button-secondary gg-editor-action-button">
                                    <i class="fa-regular fa-file" aria-hidden="true"></i>
                                    <span>Create New</span>
                                </button>
                                <button type="button" id="ggCreateWorldDescription" class="gg-button gg-button-secondary gg-editor-action-button">
                                    <i class="fa-solid fa-earth-americas" aria-hidden="true"></i>
                                    <span>Create World</span>
                                </button>
                                <button type="button" id="ggEditExistingDescription" class="gg-button gg-button-primary gg-editor-action-button">
                                    <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                                    <span>Edit Existing</span>
                                </button>
                            </div>
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
        const commandTextarea = this.popupElement.querySelector('#gg-custom-edit-description-command');
        if (commandTextarea) {
            commandTextarea.value = this.lastCustomCommand;
            this._updateInstructionCount();
        }

        // Setup event listeners
        this.setupEventListeners();

        try {
            descriptionHistory.init();
            descriptionHistory.attachPanel(this.popupElement, {
                getCurrentCharacter: () => this._getCurrentCharacter(),
                onRevert: (value) => this._applyHistoryValue(value),
                onCompare: (payload) => this._openHistoryCompare(payload),
            });
        } catch (error) {
            console.error('[GuidedGenerations] Description history initialization failed:', error);
        }

        this.initialized = true;
    }

    /**
     * Setup event listeners for the popup elements
     */
    setupEventListeners() {
        if (!this.popupElement) return;

        const closeButton = this.popupElement.querySelector('.gg-popup-close');
        const createNewButton = this.popupElement.querySelector('#ggCreateNewDescription');
        const createWorldButton = this.popupElement.querySelector('#ggCreateWorldDescription');
        const editExistingButton = this.popupElement.querySelector('#ggEditExistingDescription');
        const cancelButton = this.popupElement.querySelector('#ggCancelEditDescription');
        // Close Action
        closeButton.addEventListener('click', () => this.close());
        cancelButton?.addEventListener('click', () => this.close());

        // Generate Actions
        createNewButton.addEventListener('click', () => this.generateDescription('makeNew'));
        createWorldButton.addEventListener('click', () => this.generateDescription('createWorld'));
        editExistingButton.addEventListener('click', () => this.generateDescription('editExisting'));

        // Preview Actions
        const revertBtn = this.popupElement.querySelector('#ggRevertEdit');
        const applyBtn = this.popupElement.querySelector('#ggApplyEdit');

        revertBtn?.addEventListener('click', () => {
            this._clearDiffState();
            this._refreshDescriptionDisplay();
        });

        applyBtn?.addEventListener('click', () => {
            if (this._pendingGeneratedDescription) {
                const descriptionTextarea = document.getElementById('description_textarea');
                const targetCharacter = this._pendingCharacter;
                const currentCharacter = this._getCurrentCharacter();
                if (targetCharacter && targetCharacter.avatar !== currentCharacter?.avatar) {
                    alert('The active character changed while the edit was being prepared, so the result was not applied.');
                    this._clearDiffState();
                    this.close();
                    return;
                }
                if (descriptionTextarea) {
                    const beforeValue = descriptionTextarea.value;
                    const afterValue = this._pendingGeneratedDescription;
                    descriptionTextarea.value = afterValue;
                    const inputEvent = new Event('input', { bubbles: true });
                    descriptionTextarea.dispatchEvent(inputEvent);
                    descriptionTextarea.dispatchEvent(new Event('change', { bubbles: true }));
                    if (currentCharacter || targetCharacter) {
                        descriptionHistory.record(currentCharacter || targetCharacter, beforeValue, afterValue);
                    }
                }
            }
            this._clearDiffState();
            this.close();
        });

        // Tabs
        const tabBtns = this.popupElement.querySelectorAll('.gg-tab-btn');
        const tabContents = this.popupElement.querySelectorAll('.gg-tab-content');
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

                if (targetTab === 'history') {
                    descriptionHistory.renderCurrent();
                }

                // Toggle footer
                this._syncFooterVisibility();
            });
        });

        // Format Fields
        const addFormatBtn = this.popupElement.querySelector('#gg-add-format-btn');
        const formatList = this.popupElement.querySelector('#gg-format-list');
        const enableFormatCheckbox = this.popupElement.querySelector('#gg-enable-format-checkbox');

        enableFormatCheckbox?.addEventListener('change', (e) => {
            this.formatEnabled = e.target.checked;
            localStorage.setItem('gg_editDescFormatEnabled', String(this.formatEnabled));
        });

        addFormatBtn.addEventListener('click', () => {
            const formatItem = document.createElement('div');
            formatItem.className = 'gg-format-item';

            formatItem.innerHTML = `
                <textarea class="gg-format-value text_pole" rows="2" aria-label="Description format field" placeholder="Example: Name:&#10;Appearance:&#10;Personality:"></textarea>
                <button type="button" class="gg-remove-format-btn" title="Remove format field" aria-label="Remove format field">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                </button>
            `;

            formatList.appendChild(formatItem);
            formatItem.querySelector('.gg-format-value')?.focus();
        });

        formatList.addEventListener('click', (e) => {
            const removeButton = e.target.closest('.gg-remove-format-btn');
            if (removeButton) {
                removeButton.closest('.gg-format-item')?.remove();
                this._saveFormats();
            }
        });

        formatList.addEventListener('input', (e) => {
            if (e.target.classList.contains('gg-format-value')) {
                this._saveFormats();
            }
        });

        const commandTextarea = this.popupElement.querySelector('#gg-custom-edit-description-command');
        commandTextarea?.addEventListener('input', () => {
            this._updateInstructionCount();
            this._setInstructionError(false);
        });
        commandTextarea?.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                this.generateDescription('editExisting');
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

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.popupElement?.getAttribute('aria-hidden') === 'false') {
                this.close();
            }
        });
    }

    /**
     * Save current format fields to local storage
     */
    _saveFormats() {
        if (!this.popupElement) return;
        const formatItemElements = this.popupElement.querySelectorAll('.gg-format-item');
        let formatListArray = [];
        formatItemElements.forEach(item => {
            const value = item.querySelector('.gg-format-value').value.trim();
            if (value) {
                formatListArray.push(value);
            }
        });
        localStorage.setItem('gg_editDescFormats', JSON.stringify(formatListArray));
    }

    /**
     * Get current character description from SillyTavern's textarea
     */
    _getCurrentDescription() {
        const descriptionTextarea = document.getElementById('description_textarea');
        return descriptionTextarea ? descriptionTextarea.value.trim() : '';
    }

    _getCurrentCharacter() {
        const context = getContext();
        const chid = context?.characterId;
        if (chid === undefined || chid === null || chid === '') return null;
        return context?.characters?.[chid] ?? null;
    }

    _applyHistoryValue(value) {
        const textarea = document.getElementById('description_textarea');
        const character = this._getCurrentCharacter();
        if (!textarea || !character) {
            console.warn('[GuidedGenerations] Cannot revert: description textarea or character is unavailable.');
            return false;
        }
        if (textarea.value === value) return null;

        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        this._clearDiffState();
        this._refreshDescriptionDisplay();
        return true;
    }

    _syncFooterVisibility() {
        const activeTab = this.popupElement?.querySelector('.gg-tab-btn.active')?.dataset.tab || 'normal';
        const footer = this.popupElement?.querySelector('.gg-popup-footer-wrap');
        if (footer) footer.hidden = activeTab === 'format' || activeTab === 'history';
    }

    _restoreDescriptionAfterFailedGeneration(textarea, value, character) {
        if (!textarea || typeof value !== 'string' || !character || textarea.value) return;
        const currentCharacter = this._getCurrentCharacter();
        if (currentCharacter && character.avatar !== currentCharacter.avatar) return;
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        if (character) character.description = value;
    }

    _openHistoryCompare({ entry, key, character } = {}) {
        const textarea = document.getElementById('description_textarea');
        const currentCharacter = this._getCurrentCharacter();
        if (!textarea || !currentCharacter || !entry) {
            alert('Open the Character Editor to compare this snapshot.');
            return;
        }
        if (key && currentCharacter.avatar !== key) {
            alert('Open this character in the Character Editor to compare its history.');
            return;
        }

        this._ensureHistoryComparePopup();
        const currentText = textarea.value;
        const targetText = String(entry.value ?? '');
        this.compareState = {
            value: targetText,
            avatar: currentCharacter.avatar,
            entryId: entry.id,
        };

        const meta = this.comparePopup.querySelector('#ggDescCompareMeta');
        if (meta) {
            meta.innerHTML = `Character <strong>${escapeHtml(currentCharacter.name || currentCharacter.avatar)}</strong> - snapshot ${escapeHtml(new Date(entry.ts).toLocaleString())} (${escapeHtml(historyModeLabel(entry.mode))})`;
        }
        const currentPanel = this.comparePopup.querySelector('#ggDescCompareCurrent');
        if (currentPanel) currentPanel.textContent = currentText || '(empty)';
        const currentLines = this.comparePopup.querySelector('#ggDescCompareCurrentLines');
        if (currentLines) {
            const count = currentText ? currentText.split('\n').length : 0;
            currentLines.textContent = `${count} line${count === 1 ? '' : 's'}`;
        }

        const diff = computeLineDiff(currentText, targetText);
        const hasChanges = diff.some(item => item.type !== 'unchanged');
        const diffEl = this.comparePopup.querySelector('#ggDescCompareDiff');
        if (diffEl) {
            diffEl.innerHTML = hasChanges
                ? renderDiffHtml(diff, { showHeader: false })
                : '<div class="gg-desc-history-empty">No differences. The description already matches this snapshot.</div>';
        }
        const revertButton = this.comparePopup.querySelector('#ggDescCompareRevert');
        if (revertButton) revertButton.disabled = !hasChanges;

        this.comparePopup.style.display = 'flex';
        this.comparePopup.setAttribute('aria-hidden', 'false');
    }

    _ensureHistoryComparePopup() {
        if (this.comparePopup) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div id="ggDescHistoryComparePopup" class="gg-popup gg-editor-popup" role="dialog" aria-modal="true" aria-labelledby="ggDescCompareTitle" aria-hidden="true">
                <div class="gg-popup-content gg-editor-dialog gg-desc-history-all-dialog gg-desc-compare-dialog">
                    <div class="gg-popup-header">
                        <div class="gg-editor-title-group">
                            <span class="gg-editor-title-icon" aria-hidden="true">
                                <i class="fa-solid fa-code-compare"></i>
                            </span>
                            <div>
                                <span class="gg-editor-eyebrow">Edit Description</span>
                                <h2 id="ggDescCompareTitle">Compare History</h2>
                                <p>See what reverting to this snapshot would remove and add.</p>
                            </div>
                        </div>
                        <button type="button" class="gg-popup-close" aria-label="Close compare view">
                            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div class="gg-popup-body gg-editor-body">
                        <div id="ggDescCompareMeta" class="gg-desc-compare-meta"></div>
                        <div class="gg-desc-compare-grid">
                            <section class="gg-desc-compare-panel">
                                <div class="gg-desc-compare-panel-head">
                                    <span>Current</span>
                                    <span id="ggDescCompareCurrentLines" class="gg-desc-compare-panel-meta">0 lines</span>
                                </div>
                                <pre id="ggDescCompareCurrent" class="gg-desc-compare-text"></pre>
                            </section>
                            <section class="gg-desc-compare-panel">
                                <div class="gg-desc-compare-panel-head">
                                    <span>History checking</span>
                                    <span class="gg-desc-compare-legend">
                                        <span><span class="gg-diff-legend-color gg-diff-legend-removed"></span>Will remove</span>
                                        <span><span class="gg-diff-legend-color gg-diff-legend-added"></span>Will add</span>
                                    </span>
                                </div>
                                <div id="ggDescCompareDiff" class="gg-diff-view gg-desc-compare-diff"></div>
                            </section>
                        </div>
                        <p class="gg-desc-compare-note">Red lines exist only in Current and will be removed by reverting. Green lines exist only in the selected snapshot and will be added.</p>
                    </div>
                    <div class="gg-popup-footer-wrap gg-editor-footer-wrap">
                        <div class="gg-editor-footer-note">
                            <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
                            <span>Reverting does not create a new history snapshot.</span>
                        </div>
                        <div class="gg-popup-footer">
                            <button type="button" id="ggDescCompareClose" class="gg-button gg-button-quiet">Close</button>
                            <button type="button" id="ggDescCompareRevert" class="gg-button gg-button-primary gg-editor-action-button">
                                <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                                <span>Revert to this snapshot</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.comparePopup = wrapper.firstElementChild;
        document.body.appendChild(this.comparePopup);

        this.comparePopup.querySelector('.gg-popup-close')?.addEventListener('click', () => this._closeHistoryCompare());
        this.comparePopup.querySelector('#ggDescCompareClose')?.addEventListener('click', () => this._closeHistoryCompare());
        this.comparePopup.querySelector('#ggDescCompareRevert')?.addEventListener('click', () => this._revertFromCompare());
        this.comparePopup.addEventListener('click', event => {
            if (event.target === this.comparePopup) this._closeHistoryCompare();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.comparePopup?.getAttribute('aria-hidden') === 'false') {
                event.stopPropagation();
                this._closeHistoryCompare();
            }
        }, true);
    }

    _closeHistoryCompare() {
        if (!this.comparePopup) return;
        this.comparePopup.style.display = 'none';
        this.comparePopup.setAttribute('aria-hidden', 'true');
    }

    _revertFromCompare() {
        const state = this.compareState;
        if (!state) return;
        const currentCharacter = this._getCurrentCharacter();
        if (!currentCharacter || currentCharacter.avatar !== state.avatar) {
            alert('Open the same character in the Character Editor to revert.');
            return;
        }
        const applied = this._applyHistoryValue(state.value);
        if (applied === true) {
            this._closeHistoryCompare();
            descriptionHistory.closeAll();
            globalThis.toastr?.success?.('Description reverted.');
        } else if (applied === null) {
            alert('The description already matches this snapshot.');
        } else {
            alert('Could not revert. Open the Character Editor and try again.');
        }
    }

    /**
     * Refresh the current description display in the popup
     */
    _refreshDescriptionDisplay() {
        const displayEl = this.popupElement?.querySelector('#gg-current-desc-display');
        const statsEl = this.popupElement?.querySelector('#gg-current-desc-stats');
        if (!displayEl) return;

        // If in diff mode, don't refresh — keep the diff view
        if (this._isDiffMode) return;

        const currentDesc = this._getCurrentDescription();
        if (currentDesc) {
            displayEl.innerHTML = '';
            displayEl.textContent = currentDesc;
            displayEl.classList.remove('gg-diff-view');
            const wordCount = currentDesc.split(/\s+/).filter(Boolean).length;
            if (statsEl) statsEl.textContent = `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`;
        } else {
            displayEl.innerHTML = '<span class="gg-current-desc-empty">No description available.</span>';
            displayEl.classList.remove('gg-diff-view');
            if (statsEl) statsEl.textContent = '0 words';
        }
    }

    /**
     * Show diff view in the description display
     */
    _showDiffView(oldDesc, newDesc) {
        const displayEl = this.popupElement?.querySelector('#gg-current-desc-display');
        if (!displayEl) return;

        const diffResult = computeLineDiff(oldDesc, newDesc);
        displayEl.innerHTML = renderDiffHtml(diffResult);
        displayEl.classList.add('gg-diff-view');
        this._isDiffMode = true;

        // Update the section heading
        const heading = this.popupElement.querySelector('.gg-current-desc-section h3');
        if (heading) heading.textContent = 'Edit Result — Diff View';
        const subtitle = this.popupElement.querySelector('.gg-current-desc-section .gg-editor-section-heading p');
        if (subtitle) subtitle.textContent = 'Added and removed content is highlighted below.';
        const statsEl = this.popupElement.querySelector('#gg-current-desc-stats');
        if (statsEl) statsEl.textContent = 'Preview ready';
    }

    /**
     * Clear diff state and restore normal view
     */
    _clearDiffState() {
        this._previousDescription = null;
        this._pendingGeneratedDescription = null;
        this._isDiffMode = false;
        this._isPreviewMode = false;
        this._pendingCharacter = null;

        // Restore heading
        const heading = this.popupElement?.querySelector('.gg-current-desc-section h3');
        if (heading) heading.textContent = 'Current Description';
        const subtitle = this.popupElement?.querySelector('.gg-current-desc-section .gg-editor-section-heading p');
        if (subtitle) subtitle.textContent = 'The source used when you choose Edit Existing.';
        const footerNote = this.popupElement?.querySelector('.gg-editor-footer-note span');
        if (footerNote) footerNote.textContent = 'Edit Existing opens a diff preview before anything is saved.';

        // Remove diff-view class
        const displayEl = this.popupElement?.querySelector('#gg-current-desc-display');
        if (displayEl) displayEl.classList.remove('gg-diff-view');

        // Restore UI elements if popup is open
        if (this.popupElement) {
            const tabs = this.popupElement.querySelector('.gg-tabs');
            if (tabs) tabs.style.display = 'flex';

            const customCmd = this.popupElement.querySelector('.gg-custom-command-section');
            if (customCmd) customCmd.style.display = '';

            const checkboxes = this.popupElement.querySelector('#gg-checkboxes-container');
            if (checkboxes) checkboxes.style.display = 'flex';

            const guidebook = this.popupElement.querySelector('.gg-guidebook');
            if (guidebook) guidebook.style.display = '';

            const btnCreate = this.popupElement.querySelector('#ggCreateNewDescription');
            if (btnCreate) btnCreate.style.display = '';

            const btnEdit = this.popupElement.querySelector('#ggEditExistingDescription');
            if (btnEdit) btnEdit.style.display = '';

            const btnWorld = this.popupElement.querySelector('#ggCreateWorldDescription');
            if (btnWorld) btnWorld.style.display = '';

            const btnRevert = this.popupElement.querySelector('#ggRevertEdit');
            if (btnRevert) btnRevert.style.display = 'none';

            const btnApply = this.popupElement.querySelector('#ggApplyEdit');
            if (btnApply) btnApply.style.display = 'none';

            const btnCancel = this.popupElement.querySelector('#ggCancelEditDescription');
            if (btnCancel) btnCancel.style.display = '';
        }
    }

    /**
     * Enter preview mode
     */
    _enterPreviewMode(oldDesc, newDesc) {
        this._isPreviewMode = true;
        this._pendingGeneratedDescription = newDesc;
        this._previousDescription = oldDesc;

        if (!this.initialized) {
            return;
        }

        if (this.popupElement) {
            this.popupElement.style.display = 'flex';
            this.popupElement.setAttribute('aria-hidden', 'false');
            this._showDiffView(oldDesc, newDesc);
            const footerNote = this.popupElement.querySelector('.gg-editor-footer-note span');
            if (footerNote) footerNote.textContent = 'Review the highlighted changes before applying them.';

            // Hide other elements
            const tabs = this.popupElement.querySelector('.gg-tabs');
            if (tabs) tabs.style.display = 'none';

            const customCmd = this.popupElement.querySelector('.gg-custom-command-section');
            if (customCmd) customCmd.style.display = 'none';

            const checkboxes = this.popupElement.querySelector('#gg-checkboxes-container');
            if (checkboxes) checkboxes.style.display = 'none';

            const guidebook = this.popupElement.querySelector('.gg-guidebook');
            if (guidebook) guidebook.style.display = 'none';

            const btnCreate = this.popupElement.querySelector('#ggCreateNewDescription');
            if (btnCreate) btnCreate.style.display = 'none';

            const btnEdit = this.popupElement.querySelector('#ggEditExistingDescription');
            if (btnEdit) btnEdit.style.display = 'none';

            const btnWorld = this.popupElement.querySelector('#ggCreateWorldDescription');
            if (btnWorld) btnWorld.style.display = 'none';

            const btnRevert = this.popupElement.querySelector('#ggRevertEdit');
            if (btnRevert) btnRevert.style.display = '';

            const btnApply = this.popupElement.querySelector('#ggApplyEdit');
            if (btnApply) btnApply.style.display = '';

            const btnCancel = this.popupElement.querySelector('#ggCancelEditDescription');
            if (btnCancel) btnCancel.style.display = 'none';
        }
    }

    /**
     * Open the popup
     */
    open() {
        if (!this.initialized) {
            this.init().then(() => {
                this._show();
            });
        } else if (this.popupElement) {
            this._show();
        }
    }

    _show() {
        if (!this.popupElement) return;
        this._refreshDescriptionDisplay();
        this._updateInstructionCount();
        this._setInstructionError(false);
        this._syncFooterVisibility();
        descriptionHistory.renderCurrent();
        this.popupElement.style.display = 'flex';
        this.popupElement.setAttribute('aria-hidden', 'false');
        const canAutoFocus = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
        if (canAutoFocus) {
            requestAnimationFrame(() => {
                this.popupElement?.querySelector('#gg-custom-edit-description-command')?.focus({ preventScroll: true });
            });
        }
    }

    _updateInstructionCount() {
        const textarea = this.popupElement?.querySelector('#gg-custom-edit-description-command');
        const counter = this.popupElement?.querySelector('#gg-description-instruction-count');
        if (textarea && counter) {
            const count = textarea.value.length;
            counter.textContent = `${count} ${count === 1 ? 'character' : 'characters'}`;
        }
    }

    _setInstructionError(visible) {
        const textarea = this.popupElement?.querySelector('#gg-custom-edit-description-command');
        const error = this.popupElement?.querySelector('#gg-description-instruction-error');
        textarea?.classList.toggle('gg-editor-input-error', visible);
        if (error) error.hidden = !visible;
    }



    /**
     * Close the popup
     */
    close() {
        this._closeHistoryCompare();
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
            this.popupElement.setAttribute('aria-hidden', 'true');
        }
        // Always clear diff state on close
        this._clearDiffState();
    }

    /**
     * Generate description based on the custom instruction
     * @param {string} mode 'makeNew', 'createWorld', or 'editExisting'
     */
    async generateDescription(mode = 'editExisting') {
        const customCommandTextarea = this.popupElement.querySelector('#gg-custom-edit-description-command');
        let instruction = customCommandTextarea.value.trim();

        if (!instruction) {
            this._setInstructionError(true);
            customCommandTextarea.focus();
            return;
        }
        // Save the custom command for session recovery
        sessionStorage.setItem('gg_lastCustomDescCommand', instruction);

        // Save previous description BEFORE closing
        const descriptionTextarea = document.getElementById('description_textarea');
        const previousDescriptionRaw = descriptionTextarea ? descriptionTextarea.value : '';
        const currentDescription = descriptionTextarea ? descriptionTextarea.value.trim() : '';
        this._pendingCharacter = this._getCurrentCharacter();

        const isEditExisting = mode === 'editExisting';
        if (isEditExisting) {
            this._previousDescription = currentDescription;
        } else {
            // For Create New and Create World, clear the existing description immediately
            // so it doesn't get included in the AI context during generation.
            if (descriptionTextarea) {
                descriptionTextarea.value = '';
                descriptionTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                descriptionTextarea.dispatchEvent(new Event('change', { bubbles: true }));
                
                // Wait briefly to allow SillyTavern's event listeners to update character state
                // before the generation command collects the context.
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        // Close the popup immediately now that validation has passed
        // (Clear diff state so it doesn't interfere)
        this._isDiffMode = false;
        this._isPreviewMode = false;
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
            this.popupElement.setAttribute('aria-hidden', 'true');
        }

        // Get format list values
        let formatList = '';
        if (this.formatEnabled) {
            const formatItemElements = this.popupElement.querySelectorAll('.gg-format-item');
            let formatListArray = [];
            formatItemElements.forEach(item => {
                const value = item.querySelector('.gg-format-value').value.trim();
                if (value) {
                    formatListArray.push(value);
                }
            });
            formatList = formatListArray.join('\n\n');
        }

        // Apply format replacement directly in the instruction text
        instruction = instruction.replaceAll('{{f}}', formatList).replaceAll('{{fl}}', formatList);

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable for description generation.');
                return;
            }

            // Explicitly clear the character's internal description state for Create New/World
            // so the prompt generation context doesn't include the old description.
            if (!isEditExisting && context.characters && context.characterId !== undefined) {
                const char = context.characters[context.characterId];
                if (char) {
                    char.description = '';
                }
            }

            const promptKey = mode === 'editExisting'
                ? 'editDescription.editExisting'
                : mode === 'createWorld'
                    ? 'editDescription.createWorld'
                    : (formatList ? 'editDescription.makeNewWithFormat' : 'editDescription.makeNew');
            const readTemplate = key => getPromptValue(`editDescription.${key}`, '', { settings: extension_settings[extensionName] });

            let promptText = '';
            if (mode === 'editExisting') {
                promptText = fillPromptTemplate(await readTemplate('editExisting'), { instruction, currentDescription, formatList });
            } else if (mode === 'createWorld') {
                promptText = fillPromptTemplate(await readTemplate('createWorld'), { instruction, formatList });
            } else {
                promptText = fillPromptTemplate(await readTemplate(formatList ? 'makeNewWithFormat' : 'makeNew'), { instruction, formatList });
            }

            let generatedDescription = '';

            debugLog('[EditDescription] Using /gen with chat isolation...');

            const originalChat = [...(context.chat || [])];
            let requestSlot = '';
            if (context.chat) {
                context.chat.length = 0;
                // Chat completion: the task prompt is announced to the extension
                // Prompt Manager, which decides where it is sent. Text completion
                // has no prompt manager, so keep the old single-message approach.
                if (context.mainApi === 'openai') {
                    requestSlot = openRequestPromptSlot(context, promptKey, promptText);
                }
                if (!requestSlot) {
                    // Push the prompt as a User message in isolated context
                    context.chat.push({
                        name: 'User',
                        is_user: true,
                        is_system: false,
                        send_date: Date.now(),
                        mes: promptText,
                        extra: { type: 'temp_desc_gen' }
                    });
                }
            }

            // Toggle send button state to show generation is happening
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

            try {
                const genResult = await context.executeSlashCommandsWithOptions(`/gen quiet=true |`, {
                    showOutput: false,
                    handleExecutionErrors: true,
                });
                generatedDescription = genResult?.pipe || '';
            } catch (fallbackError) {
                console.error('[GuidedGenerations] Description generation failed:', fallbackError);
            } finally {
                closeRequestPromptSlot(context, requestSlot);
                if (context.chat) {
                    context.chat.length = 0;
                    context.chat.push(...originalChat);
                    if (typeof context.saveChat === 'function') await context.saveChat();
                    if (typeof context.reloadCurrentChat === 'function') await context.reloadCurrentChat();
                }
            }

            // Resync send/stop controls
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            try {
                activateSendButtons?.();
                setSendButtonState?.(false);
                const $sendButton = $('#send_but');
                if ($sendButton.length) {
                    $sendButton.removeClass('fa-stop-circle').addClass('fa-paper-plane');
                }
            } catch (_) {
                /* ignore if SillyTavern API differs */
            }
            if (!generatedDescription || generatedDescription.trim() === '') {
                console.error('[GuidedGenerations] No description text received.');
                if (!isEditExisting) {
                    this._restoreDescriptionAfterFailedGeneration(descriptionTextarea, previousDescriptionRaw, this._pendingCharacter);
                }
                this._pendingCharacter = null;
                return;
            }

            if (isEditExisting && this._previousDescription !== null) {
                // Enter preview mode and DO NOT save to textarea yet
                const newDescription = generatedDescription.trim();
                this._enterPreviewMode(this._previousDescription, newDescription);
            } else {
                const targetCharacter = this._pendingCharacter;
                const currentCharacter = this._getCurrentCharacter();
                if (targetCharacter && targetCharacter.avatar !== currentCharacter?.avatar) {
                    console.warn('[GuidedGenerations] Active character changed during description generation; result discarded.');
                    if (typeof targetCharacter.description === 'string') {
                        targetCharacter.description = previousDescriptionRaw;
                    }
                    alert('The active character changed while the description was being generated, so the result was not applied.');
                    this._pendingCharacter = null;
                    return;
                }

                // Put the result in the textarea immediately
                if (descriptionTextarea) {
                    descriptionTextarea.value = generatedDescription;

                    // dispatch input event to ensure ST registers the change
                    const inputEvent = new Event('input', { bubbles: true });
                    descriptionTextarea.dispatchEvent(inputEvent);
                    descriptionTextarea.dispatchEvent(new Event('change', { bubbles: true }));

                    if (currentCharacter || targetCharacter) {
                        descriptionHistory.record(currentCharacter || targetCharacter, previousDescriptionRaw, generatedDescription);
                    }

                    debugLog('[EditDescription] Description updated successfully.');
                } else {
                    console.error('[GuidedGenerations] #description_textarea not found in DOM.');
                }
                this._pendingCharacter = null;
            }

        } catch (error) {
            console.error('[GuidedGenerations] Error executing Edit Description request:', error);
            if (!isEditExisting) {
                this._restoreDescriptionAfterFailedGeneration(descriptionTextarea, previousDescriptionRaw, this._pendingCharacter);
            }
            this._pendingCharacter = null;
        }
    }
}


// Singleton instance
const editDescriptionPopup = new EditDescriptionPopup();
export default editDescriptionPopup;
