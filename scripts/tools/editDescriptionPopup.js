/**
 * Edit Description Popup - Handles UI for editing character descriptions using AI generation.
 * Features:
 *   - Display current character description (read-only)
 *   - Custom instruction input with @{...} ping syntax
 *   - "Show edit result after gen" checkbox with diff highlighting
 *   - Collapsible guidebook with usage instructions
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
 * Render word-level diff for a modified block into inline HTML.
 * Unchanged text renders normally, removed words in red, added words in green.
 */
function renderModifiedHtml(oldText, newText) {
    const oldTokens = tokenizeWords(oldText);
    const newTokens = tokenizeWords(newText);
    const wordDiff = computeLCS(oldTokens, newTokens);

    return wordDiff.map(entry => {
        const escaped = escapeHtml(entry.text);
        switch (entry.type) {
            case 'removed':
                return `<span class="gg-diff-word-removed">${escaped}</span>`;
            case 'added':
                return `<span class="gg-diff-word-added">${escaped}</span>`;
            default:
                return escaped;
        }
    }).join('');
}

/**
 * Render diff result into HTML string
 */
function renderDiffHtml(diffResult) {
    const header = `<div class="gg-diff-header">
        <span>📊 Diff View</span>
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
                const inlineHtml = renderModifiedHtml(entry.oldText, entry.newText);
                return `<div class="gg-diff-line gg-diff-modified"><span class="gg-diff-prefix">~</span>${inlineHtml}</div>`;
            }
            default: {
                const escaped = escapeHtml(entry.text || ' ');
                return `<div class="gg-diff-line gg-diff-unchanged"><span class="gg-diff-prefix"> </span>${escaped}</div>`;
            }
        }
    }).join('');

    return `${header}${lines}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Ping parser ────────────────────────────────────────────────────
/**
 * Extract @{...} ping tokens from an instruction string.
 * @param {string} instruction
 * @returns {{ cleanInstruction: string, pings: string[] }}
 */
function extractPings(instruction) {
    const pings = [];
    const cleanInstruction = instruction.replace(/@\{([^}]+)\}/g, (match, content) => {
        pings.push(content.trim());
        return ''; // Remove from clean instruction
    }).replace(/\s{2,}/g, ' ').trim();
    return { cleanInstruction, pings };
}


// ─── Guidebook HTML ─────────────────────────────────────────────────
const GUIDEBOOK_HTML = `
<details class="gg-guidebook">
    <summary>📖 Guidebook — How to use Edit Description</summary>
    <div class="gg-guidebook-content">
        <h4>🔹 Create New vs Edit Existing</h4>
        <ul>
            <li><strong>Create New</strong> — Generates an entirely new description from scratch based on your instruction. The current description is ignored.</li>
            <li><strong>Edit Existing</strong> — Modifies the current description. The AI receives both your instruction and the existing description, and applies targeted changes.</li>
        </ul>

        <h4>🔹 Custom Instruction</h4>
        <p>Write what you want in the textarea. Be specific about what to change or create. Examples:</p>
        <ul>
            <li><code>Make her hair color blue instead of red</code></li>
            <li><code>Add a scar on the left cheek</code></li>
            <li><code>Rewrite the personality to be more cheerful</code></li>
        </ul>

        <h4>🔹 Ping Syntax — <code>@{...}</code></h4>
        <p>Use <code>@{detail}</code> to "pin" a specific part of the description for special handling:</p>
        <ul>
            <li><strong>With Edit Existing:</strong> The AI will ONLY modify the pinged detail(s) and keep everything else exactly as-is.</li>
            <li><strong>With Create New:</strong> The AI will retain the pinged detail(s) in the new description.</li>
        </ul>
        <p><strong>Examples:</strong></p>
        <ul>
            <li><code>@{blue eyes} Change eye color to green</code> → Only the "blue eyes" part gets changed to green, rest untouched.</li>
            <li><code>@{shy personality} @{wears glasses} Make a new energetic character</code> → New description will keep "shy personality" and "wears glasses" details.</li>
        </ul>

        <h4>🔹 Show Edit Result After Gen</h4>
        <p>When this checkbox is ticked and you press <strong>Edit Existing</strong>:</p>
        <ul>
            <li>After generation completes, the modal reopens automatically.</li>
            <li>The "Current Description" section shows a <strong>diff view</strong> comparing the old and new description.</li>
            <li><span style="color:#3fb950;">Green lines (+)</span> = newly added content.</li>
            <li><span style="color:#f85149;">Red lines (−)</span> = removed content.</li>
            <li>Close the modal to dismiss the diff. Next open shows the description normally.</li>
        </ul>
        <p><em>Note: This does NOT trigger for "Create New" — only for "Edit Existing".</em></p>
    </div>
</details>
`;


// ─── Class ──────────────────────────────────────────────────────────
export class EditDescriptionPopup {
    constructor() {
        this.popupElement = null;
        this.initialized = false;
        this.lastCustomCommand = sessionStorage.getItem('gg_lastCustomDescCommand') || '';
        this.showEditResult = sessionStorage.getItem('gg_showEditDescResult') === 'true';
        this.formatEnabled = localStorage.getItem('gg_editDescFormatEnabled') !== 'false';
        this.genWithoutPreset = localStorage.getItem('gg_editDescGenWithoutPreset') === 'true';
        this._previousDescription = null; // Stored before gen for diff
        this._isDiffMode = false; // Currently showing diff?
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
            } catch(e) {}
            
            let formatListHtml = '';
            savedFormats.forEach(val => {
                formatListHtml += `
                    <div class="gg-format-item" style="display: flex; flex-direction: column; gap: 5px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 5px; border: 1px solid #444;">
                        <div style="display: flex; gap: 10px; align-items: flex-start;">
                            <textarea class="gg-format-value text_pole" placeholder="Format Template (e.g. name: )" style="flex: 1; resize: vertical; min-height: 40px;">${escapeHtml(val)}</textarea>
                            <button class="gg-button gg-button-secondary gg-remove-format-btn" style="min-width: 30px; padding: 0; height: 30px;" title="Remove Format">&times;</button>
                        </div>
                    </div>
                `;
            });

            const popupHtml = `
                <div id="editDescriptionPopup" class="gg-popup">
                    <div class="gg-popup-content">
                        <div class="gg-popup-header">
                            <h2>Edit Description</h2>
                            <span class="gg-popup-close">&times;</span>
                        </div>
                        <div class="gg-popup-body">
                            <!-- Guidebook -->
                            ${GUIDEBOOK_HTML}
                            
                            <div class="gg-tabs" style="display: flex; gap: 10px; margin-bottom: 15px; border-bottom: 1px solid #444; padding-bottom: 5px;">
                                <button class="gg-tab-btn active" data-tab="normal" style="background: none; border: none; color: white; cursor: pointer; padding: 5px 10px; border-radius: 4px; font-weight: bold;">Normal</button>
                                <button class="gg-tab-btn" data-tab="format" style="background: none; border: none; color: #ccc; cursor: pointer; padding: 5px 10px; border-radius: 4px;">Format</button>
                            </div>

                            <div id="gg-tab-normal" class="gg-tab-content active" style="display: block;">
                                <!-- Current Description Section -->
                                <div class="gg-popup-section gg-current-desc-section">
                                    <h3>Current Description</h3>
                                    <div id="gg-current-desc-display" class="gg-current-desc-container">
                                        <span class="gg-current-desc-empty">No description available.</span>
                                    </div>
                                </div>
                                
                                <!-- Custom Command Section -->
                                <div class="gg-popup-section gg-custom-command-section">
                                    <h3>Custom Instruction</h3>
                                    <textarea id="gg-custom-edit-description-command" placeholder="Enter your instruction for generating/editing the character description...&#10;&#10;Tip: Use @{detail} to pin specific parts (see Guidebook above).">${this.lastCustomCommand}</textarea>
                                </div>
                            </div>
                            
                            <div id="gg-tab-format" class="gg-tab-content" style="display: none;">
                                <div class="gg-popup-section gg-format-section">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                                        <h3 style="margin: 0;">Format Fields</h3>
                                        <div class="gg-checkbox-row" style="margin: 0;">
                                            <input type="checkbox" id="gg-enable-format-checkbox" ${this.formatEnabled ? 'checked' : ''}>
                                            <label for="gg-enable-format-checkbox">Enable Formats</label>
                                        </div>
                                    </div>
                                    <p style="font-size: 0.9em; color: #aaa; margin-bottom: 10px;">Formats are only applied when using <strong>Create New</strong> in the Normal tab. Leave empty to use default prompt.</p>
                                    <div id="gg-format-list" style="display: flex; flex-direction: column; gap: 10px;">
                                        ${formatListHtml}
                                    </div>
                                    <button id="gg-add-format-btn" class="gg-button gg-button-secondary" style="margin-top: 10px; width: 100%; font-size: 1.2em;">+</button>
                                </div>
                            </div>
                        </div>
                        <div class="gg-popup-footer-wrap">
                            <div style="display: flex; gap: 15px; margin-bottom: 10px;">
                                <div class="gg-checkbox-row" style="margin: 0;">
                                    <input type="checkbox" id="gg-show-edit-result-checkbox" ${this.showEditResult ? 'checked' : ''}>
                                    <label for="gg-show-edit-result-checkbox">Show edit result after gen</label>
                                </div>
                                <div class="gg-checkbox-row" style="margin: 0;">
                                    <input type="checkbox" id="gg-gen-without-preset-checkbox" ${this.genWithoutPreset ? 'checked' : ''}>
                                    <label for="gg-gen-without-preset-checkbox">Gen without preset</label>
                                </div>
                            </div>
                            <div class="gg-popup-footer">
                                <button id="ggCreateNewDescription" class="gg-button gg-button-secondary">Create New</button>
                                <button id="ggEditExistingDescription" class="gg-button gg-button-primary">Edit Existing</button>
                                <button id="ggCreateWorldDescription" class="gg-button gg-button-secondary">Create World</button>
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
        const createNewButton = this.popupElement.querySelector('#ggCreateNewDescription');
        const createWorldButton = this.popupElement.querySelector('#ggCreateWorldDescription');
        const editExistingButton = this.popupElement.querySelector('#ggEditExistingDescription');
        const showEditResultCheckbox = this.popupElement.querySelector('#gg-show-edit-result-checkbox');

        // Close Action
        closeButton.addEventListener('click', () => this.close());

        // Generate Actions
        createNewButton.addEventListener('click', () => this.generateDescription('makeNew'));
        createWorldButton.addEventListener('click', () => this.generateDescription('createWorld'));
        editExistingButton.addEventListener('click', () => this.generateDescription('editExisting'));

        const genWithoutPresetCheckbox = this.popupElement.querySelector('#gg-gen-without-preset-checkbox');

        // Checkbox state persistence
        showEditResultCheckbox.addEventListener('change', (e) => {
            this.showEditResult = e.target.checked;
            sessionStorage.setItem('gg_showEditDescResult', String(this.showEditResult));
        });

        genWithoutPresetCheckbox?.addEventListener('change', (e) => {
            this.genWithoutPreset = e.target.checked;
            localStorage.setItem('gg_editDescGenWithoutPreset', String(this.genWithoutPreset));
        });

        // Tabs
        const tabBtns = this.popupElement.querySelectorAll('.gg-tab-btn');
        const tabContents = this.popupElement.querySelectorAll('.gg-tab-content');
        const footerWrap = this.popupElement.querySelector('.gg-popup-footer-wrap');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTab = e.target.getAttribute('data-tab');
                
                // Update buttons
                tabBtns.forEach(b => {
                    b.classList.remove('active');
                    b.style.fontWeight = 'normal';
                    b.style.color = '#ccc';
                });
                e.target.classList.add('active');
                e.target.style.fontWeight = 'bold';
                e.target.style.color = 'white';
                
                // Update contents
                tabContents.forEach(content => {
                    content.style.display = content.id === `gg-tab-${targetTab}` ? 'block' : 'none';
                    content.classList.toggle('active', content.id === `gg-tab-${targetTab}`);
                });

                // Toggle footer
                if (footerWrap) {
                    footerWrap.style.display = targetTab === 'format' ? 'none' : 'block';
                }
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
            formatItem.style.cssText = 'display: flex; flex-direction: column; gap: 5px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 5px; border: 1px solid #444;';
            
            formatItem.innerHTML = `
                <div style="display: flex; gap: 10px; align-items: flex-start;">
                    <textarea class="gg-format-value text_pole" placeholder="Format Template (e.g. name: )" style="flex: 1; resize: vertical; min-height: 40px;"></textarea>
                    <button class="gg-button gg-button-secondary gg-remove-format-btn" style="min-width: 30px; padding: 0; height: 30px;" title="Remove Format">&times;</button>
                </div>
            `;
            
            formatList.appendChild(formatItem);
        });

        formatList.addEventListener('click', (e) => {
            if (e.target.classList.contains('gg-remove-format-btn')) {
                e.target.closest('.gg-format-item').remove();
                this._saveFormats();
            }
        });

        formatList.addEventListener('input', (e) => {
            if (e.target.classList.contains('gg-format-value')) {
                this._saveFormats();
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

    /**
     * Refresh the current description display in the popup
     */
    _refreshDescriptionDisplay() {
        const displayEl = this.popupElement?.querySelector('#gg-current-desc-display');
        if (!displayEl) return;

        // If in diff mode, don't refresh — keep the diff view
        if (this._isDiffMode) return;

        const currentDesc = this._getCurrentDescription();
        if (currentDesc) {
            displayEl.innerHTML = '';
            displayEl.textContent = currentDesc;
            displayEl.classList.remove('gg-diff-view');
        } else {
            displayEl.innerHTML = '<span class="gg-current-desc-empty">No description available.</span>';
            displayEl.classList.remove('gg-diff-view');
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
    }

    /**
     * Clear diff state and restore normal view
     */
    _clearDiffState() {
        this._previousDescription = null;
        this._isDiffMode = false;

        // Restore heading
        const heading = this.popupElement?.querySelector('.gg-current-desc-section h3');
        if (heading) heading.textContent = 'Current Description';

        // Remove diff-view class
        const displayEl = this.popupElement?.querySelector('#gg-current-desc-display');
        if (displayEl) displayEl.classList.remove('gg-diff-view');
    }

    /**
     * Open the popup
     */
    open() {
        if (!this.initialized) {
            this.init().then(() => {
                if (this.popupElement) {
                    this.popupElement.style.display = 'block';
                    this._refreshDescriptionDisplay();
                }
            });
        } else if (this.popupElement) {
            this.popupElement.style.display = 'block';
            this._refreshDescriptionDisplay();
        }
    }

    /**
     * Open the popup in diff mode (after generation)
     */
    _openWithDiff(oldDesc, newDesc) {
        if (!this.initialized) {
            this.init().then(() => {
                if (this.popupElement) {
                    this.popupElement.style.display = 'block';
                    this._showDiffView(oldDesc, newDesc);
                }
            });
        } else if (this.popupElement) {
            this.popupElement.style.display = 'block';
            this._showDiffView(oldDesc, newDesc);
        }
    }

    /**
     * Close the popup
     */
    close() {
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
        }
        // Always clear diff state on close
        this._clearDiffState();
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

        // Parse pings
        const { cleanInstruction, pings } = extractPings(instruction);
        const hasPings = pings.length > 0;

        // Save previous description BEFORE closing (for diff view later)
        const shouldShowResult = this.showEditResult && mode === 'editExisting';
        const descriptionTextarea = document.getElementById('description_textarea');
        const currentDescription = descriptionTextarea ? descriptionTextarea.value.trim() : '';
        
        if (shouldShowResult) {
            this._previousDescription = currentDescription;
        }

        // Close the popup immediately now that validation has passed
        // (Clear diff state so it doesn't interfere)
        this._isDiffMode = false;
        if (this.popupElement) {
            this.popupElement.style.display = 'none';
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

        const presetValue = extension_settings[extensionName]?.presetEditDescription ?? '';
        const profileValue = extension_settings[extensionName]?.profileEditDescription ?? '';

        try {
            const context = getContext();
            if (!context) {
                console.error('[GuidedGenerations] Context unavailable for description generation.');
                return;
            }

            // Choose prompt template based on mode + ping presence + format presence
            let promptKey;
            if (mode === 'editExisting') {
                promptKey = hasPings ? 'editDescription.editExistingWithPing' : 'editDescription.editExisting';
            } else if (mode === 'createWorld') {
                promptKey = hasPings ? 'editDescription.createWorldWithPing' : 'editDescription.createWorld';
            } else {
                if (hasPings) {
                    promptKey = formatList ? 'editDescription.makeNewWithPingFormat' : 'editDescription.makeNewWithPing';
                } else {
                    promptKey = formatList ? 'editDescription.makeNewWithFormat' : 'editDescription.makeNew';
                }
            }

            const promptTemplate = await getPromptValue(promptKey, '');

            // Build template data
            const templateData = {
                instruction: hasPings ? cleanInstruction : instruction,
                currentDescription: mode === 'editExisting' ? currentDescription : '',
                formatList: formatList
            };

            // Add ping details if present
            if (hasPings) {
                templateData.pingDetails = pings.map((p, i) => `${i + 1}. "${p}"`).join('\n');
            }

            const promptForModel = fillPromptTemplate(promptTemplate, templateData);

            // Toggle send button state to show generation is happening
            setSendButtonState?.(true);
            deactivateSendButtons?.();

            let generatedDescription = '';

            if (this.genWithoutPreset) {
                try {
                    debugLog('[EditDescription] Generating without preset using /genraw...');
                    // Use {{newline}} macro so ST's parser replaces it with real newlines 
                    // after splitting commands, preventing parser breakage.
                    const escapedPrompt = promptForModel.replace(/\r?\n/g, '{{newline}}');
                    const genResult = await context.executeSlashCommandsWithOptions(`/genraw quiet=true ${escapedPrompt} |`, {
                        showOutput: false,
                        handleExecutionErrors: true,
                    });
                    generatedDescription = genResult?.pipe || '';
                } catch (error) {
                    console.error('[GuidedGenerations] /genraw generation failed:', error);
                }
            } else {
                debugLog('[EditDescription] Using /gen with chat isolation...');
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

            // ── Show diff result if checkbox was ticked + Edit Existing mode ──
            if (shouldShowResult && this._previousDescription !== null) {
                const newDescription = generatedDescription.trim();
                this._openWithDiff(this._previousDescription, newDescription);
            }

        } catch (error) {
            console.error('[GuidedGenerations] Error executing Edit Description request:', error);
        }
    }
}


// Singleton instance
const editDescriptionPopup = new EditDescriptionPopup();
export default editDescriptionPopup;
