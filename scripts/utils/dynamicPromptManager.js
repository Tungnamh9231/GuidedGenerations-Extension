/**
 * Dynamic Prompt Manager — Shared module for managing ordered prompt blocks.
 *
 * Used by editDescriptionPopup and editIntrosPopup to let users define, reorder,
 * toggle, and edit prompt blocks with template variables. The uneditable "Preset"
 * block represents the SillyTavern Preset and can be repositioned but not deleted.
 *
 * Template Variables (resolved by the extension before generation):
 *   {{i}} — User instruction
 *   {{d}} — Current character description   (editDescription only)
 *   {{t}} — Ping target details             (editDescription only)
 *   {{f}} — Format fields                   (editDescription only)
 *   {{m}} — Current intro message            (editIntros only)
 *
 * {{char}} and {{user}} are passed through to SillyTavern's macro resolver.
 */

import {
    extensionName,
    extension_settings,
    debugLog,
} from '../persistentGuides/guideExports.js';

// ────────────────────────────────────────────────────────────────────────────
// Data helpers
// ────────────────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateBlockId() {
    return `blk_${Date.now()}_${_idCounter++}`;
}

/**
 * Create a new custom prompt block.
 */
export function createBlock({ name = 'New Prompt', role = 'system', content = '', enabled = true } = {}) {
    return {
        id: generateBlockId(),
        type: 'custom',
        name,
        role,
        content,
        enabled,
    };
}

/**
 * Create the immutable Preset block.
 */
export function createPresetBlock() {
    return {
        id: '__preset__',
        type: 'preset',
        name: 'ST Preset',
        role: '',       // N/A — preset has its own roles
        content: '',    // N/A — content comes from ST
        enabled: true,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load blocks from extension_settings. Returns the stored array or `defaults`.
 */
export function loadBlocks(settingKey, defaults = null) {
    const raw = extension_settings[extensionName]?.[settingKey];
    if (Array.isArray(raw) && raw.length > 0) {
        // Ensure every stored block has an id
        return raw.map(b => ({ ...b, id: b.id || generateBlockId() }));
    }
    return defaults ? defaults.map(b => ({ ...b })) : [];
}

/**
 * Save blocks to extension_settings and trigger a debounced save.
 */
export function saveBlocks(settingKey, blocks) {
    if (!extension_settings[extensionName]) return;
    extension_settings[extensionName][settingKey] = blocks.map(b => ({ ...b }));
    // Trigger ST save (debounced)
    try {
        const { saveSettingsDebounced } = window.SillyTavern?.getContext?.() || {};
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    } catch (_) { /* ignore */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Variable resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve extension-specific short variables in a prompt string.
 * @param {string} content   — The raw prompt text.
 * @param {Object} varMap    — Map of short keys to values, e.g. { i: '...', d: '...' }.
 * @returns {string}         — Content with variables replaced.
 */
export function resolveBlockVariables(content, varMap = {}) {
    if (!content) return '';
    let result = content;
    for (const [key, value] of Object.entries(varMap)) {
        result = result.replaceAll(`{{${key}}}`, String(value ?? ''));
    }
    return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Message assembly
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the final messages[] array from ordered blocks.
 *
 * @param {Array}  blocks          — Ordered array of block objects.
 * @param {Object} varMap          — Variable map for resolveBlockVariables.
 * @param {Array}  presetMessages  — Messages from ST's prompt manager (may be []).
 * @returns {Array} OpenAI-style messages [{ role, content }, ...]
 */
export function assembleMessages(blocks, varMap = {}, presetMessages = []) {
    const finalMessages = [];
    let presetBefore = presetMessages;
    let presetAfter = [];
    let hasPresetBlock = false;

    // Split preset messages at the chat marker so we know where ST expects the chat to be
    const markerIndex = presetMessages.findIndex(m => String(m.content).includes('___GG_CHAT_MARKER___'));
    if (markerIndex !== -1) {
        presetBefore = presetMessages.slice(0, markerIndex);
        presetAfter = presetMessages.slice(markerIndex + 1);
    }

    for (const block of blocks) {
        if (!block.enabled) continue;

        if (block.type === 'preset') {
            hasPresetBlock = true;
            if (presetBefore.length > 0) {
                finalMessages.push(...presetBefore);
            }
        } else {
            // Custom block
            const resolved = resolveBlockVariables(block.content, varMap);
            if (resolved.trim()) {
                finalMessages.push({
                    role: block.role || 'system',
                    content: resolved,
                });
            }
        }
    }

    // Post-history prompts (like Jailbreak) are ALWAYS placed at the very end of the final payload,
    // immediately following all custom blocks, because they are structurally required to be after the chat.
    if (hasPresetBlock && presetAfter.length > 0) {
        finalMessages.push(...presetAfter);
    }

    return finalMessages;
}

// ────────────────────────────────────────────────────────────────────────────
// Default block configurations
// ────────────────────────────────────────────────────────────────────────────

export const EDIT_DESCRIPTION_MODES = {
    'editDescription.editExisting': 'Edit Description (Existing)',
    'editDescription.editExistingWithPing': 'Edit Description (Targeted)',
    'editDescription.makeNew': 'Create New Desc — no format',
    'editDescription.makeNew.format': 'Create New Desc — have format',
    'editDescription.makeNewWithPing': 'Create New Desc Targeted — no format',
    'editDescription.makeNewWithPing.format': 'Create New Desc Targeted — have format',
    'editDescription.createWorld': 'Create World Info',
    'editDescription.createWorldWithPing': 'Create World Info (Targeted)',
};

export const EDIT_INTROS_MODES = {
    'editIntros.editExisting': 'Edit Intro (Existing)',
    'editIntros.makeNew': 'Create New Intro',
};

export function getDefaultEditDescriptionBlocks(modeKey = 'editDescription.editExisting') {
    const hasFormat = modeKey.endsWith('.format');
    const baseModeKey = modeKey.replace(/\.format$/, '');
    const isTargeted = baseModeKey.includes('WithPing');
    const isCreateWorld = baseModeKey.includes('createWorld');
    const isMakeNew = baseModeKey.includes('makeNew');

    let instructionText = '';

    if (isCreateWorld) {
        if (isTargeted) {
            instructionText = 'Based on the following instructions, write a world and setting description. Apply the output to the exact format provided below.\n\nInstructions:\n{{i}}\n\nFormat:\nWorld Context:\n\nIMPORTANT: The user wants to RETAIN the following specific detail(s) from the previous description. Make sure these details are preserved and integrated into the new description:\n{{t}}\n\nRules:\n- Output ONLY the formatted description text.\n- Do NOT add explanations or commentary.\n- The pinned details MUST appear in the final output.';
        } else {
            instructionText = 'Based on the following instructions, write a world and setting description. Apply the output to the exact format provided below.\n\nInstructions:\n{{i}}\n\nFormat:\nWorld Context:\n\nRules:\n- Output ONLY the formatted description text.\n- Do NOT add explanations or commentary.';
        }
    } else if (isMakeNew) {
        if (isTargeted) {
            if (hasFormat) {
                instructionText = 'Based on the following instructions, write a character description that describes their physical and mental traits. If the instruction specifies a name, use it, otherwise choose a random English name. Apply the output to the exact format provided by the user.\n\nInstructions:\n{{i}}\n\nFormat:\n{{f}}\n\nIMPORTANT: The user wants to RETAIN the following specific detail(s) from the previous description. Make sure these details are preserved and integrated into the new description:\n{{t}}\n\nRules:\n- Output ONLY the formatted description text.\n- Do NOT add explanations or commentary.\n- Focus on physical appearance, personality traits, and behavioral characteristics.\n- The pinned details MUST appear in the final output.';
            } else {
                instructionText = 'Based on the following instructions, write a character description that describes their physical and mental traits. If the instruction specifies a name, use it, otherwise choose a random English name.\n\nInstructions:\n{{i}}\n\nIMPORTANT: The user wants to RETAIN the following specific detail(s) from the previous description. Make sure these details are preserved and integrated into the new description:\n{{t}}\n\nRules:\n- Output ONLY the description text.\n- Do NOT add explanations or commentary.\n- Focus on physical appearance, personality traits, and behavioral characteristics.\n- The pinned details MUST appear in the final output.';
            }
        } else {
            if (hasFormat) {
                instructionText = 'Based on the following instructions, write a character description that describes their physical and mental traits. If the instruction specifies a name, use it, otherwise choose a random English name. Apply the output to the exact format provided by the user.\n\nInstructions:\n{{i}}\n\nFormat:\n{{f}}\n\nRules:\n- Output ONLY the formatted description text.\n- Do NOT add explanations or commentary.\n- Focus on physical appearance, personality traits, and behavioral characteristics.';
            } else {
                instructionText = 'Based on the following instructions, write a character description that describes their physical and mental traits. If the instruction specifies a name, use it, otherwise choose a random English name.\n\nInstructions:\n{{i}}\n\nRules:\n- Output ONLY the description text.\n- Do NOT add explanations or commentary.\n- Focus on physical appearance, personality traits, and behavioral characteristics.';
            }
        }
    } else {
        if (isTargeted) {
            instructionText = 'Revise the existing character description. The user has PINNED specific detail(s) they want to modify. Change ONLY the pinned detail(s) according to the instruction. Keep EVERYTHING else exactly as-is, word for word.\n\nPinned detail(s) to modify:\n{{t}}\n\nModification instruction:\n{{i}}\n\nOriginal description:\n{{d}}\n\nRules:\n- ONLY modify the pinned detail(s) as instructed.\n- Keep ALL other parts of the description identical — do not rephrase, reorder, or expand anything else.\n- Output ONLY the revised description text.\n- Do NOT add explanations or commentary.';
        } else {
            instructionText = 'Revise the existing character description using ONLY the requested adjustments below.\n\nRequested adjustments:\n{{i}}\n\nOriginal description:\n{{d}}\n\nRules:\n- Output ONLY the revised description text.\n- Do NOT add explanations or commentary.\n- Focus on physical appearance, personality traits, and behavioral characteristics.';
        }
    }

    return [
        createPresetBlock(),
        createBlock({
            name: 'Task Instruction',
            role: 'user',
            content: instructionText.trim(),
        }),
    ];
}

export function getDefaultEditIntrosBlocks(modeKey = 'editIntros.editExisting') {
    const isMakeNew = modeKey.includes('makeNew');

    let instructionText = '';
    if (isMakeNew) {
        instructionText = 'Write a single greeting based on the following requirements:\n{{i}}\n\nRules:\n- Output ONLY the greeting text.\n- Do NOT continue beyond the greeting.\n- Do NOT add extra sections, explanations, or commentary.';
    } else {
        instructionText = 'Revise the existing greeting using ONLY the requested adjustments below.\n\nRequested adjustments:\n{{i}}\n\nOriginal greeting:\n{{m}}\n\nRules:\n- Keep the greeting content, structure, formatting, links, and length as close as possible unless a requested adjustment requires a specific change.\n- Do NOT add new story events, new actions, or extra continuation text.\n- Do NOT expand the greeting.\n- Return ONLY the revised greeting text.';
    }

    return [
        createPresetBlock(),
        createBlock({
            name: 'Task Instruction',
            role: 'user',
            content: instructionText,
        }),
    ];
}


// ────────────────────────────────────────────────────────────────────────────
// UI Renderer
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const ROLE_OPTIONS = ['system', 'user', 'assistant'];
const ROLE_LABELS = { system: 'System', user: 'User', assistant: 'Assistant' };

/**
 * Render the prompt blocks UI into a container element.
 *
 * @param {HTMLElement} container      — The DOM element to render into.
 * @param {Array}       blocks         — Current ordered array of blocks.
 * @param {Object}      options
 * @param {string}      options.settingKey       — extension_settings key for persistence.
 * @param {Function}    options.onBlocksChanged  — Callback when blocks are mutated.
 * @param {string}      options.variableGuideHtml — HTML snippet showing available variables.
 */
export function renderPromptBlocksUI(container, blocks, options = {}) {
    const { settingKey, onBlocksChanged, variableGuideHtml = '' } = options;

    function persist() {
        if (settingKey) saveBlocks(settingKey, blocks);
        if (typeof onBlocksChanged === 'function') onBlocksChanged(blocks);
    }

    function rerender() {
        renderPromptBlocksUI(container, blocks, options);
    }

    // Build HTML
    let html = '<div class="gg-prompt-blocks-list">';

    blocks.forEach((block, index) => {
        const isPreset = block.type === 'preset';
        const disabledClass = block.enabled ? '' : ' gg-prompt-block-disabled';
        const presetClass = isPreset ? ' gg-prompt-block-preset' : '';
        const roleLabel = isPreset ? 'Preset' : (ROLE_LABELS[block.role] || block.role);
        const roleBadgeClass = isPreset ? 'preset' : (block.role || 'system');

        html += `
        <div class="gg-prompt-block${disabledClass}${presetClass}" data-block-index="${index}">
            <div class="gg-prompt-block-header">
                <div class="gg-prompt-block-left">
                    <label class="gg-prompt-toggle">
                        <input type="checkbox" class="gg-prompt-toggle-input" data-action="toggle" ${block.enabled ? 'checked' : ''} ${isPreset ? '' : ''}>
                        <span class="gg-prompt-toggle-slider"></span>
                    </label>
                    <span class="gg-prompt-role-badge gg-role-${roleBadgeClass}">${escapeHtml(roleLabel)}</span>
                    <span class="gg-prompt-block-name">${escapeHtml(block.name)}</span>
                </div>
                <div class="gg-prompt-block-actions">
                    <button class="gg-prompt-move-btn" data-action="move-up" title="Move Up" ${index === 0 ? 'disabled' : ''}>▲</button>
                    <button class="gg-prompt-move-btn" data-action="move-down" title="Move Down" ${index === blocks.length - 1 ? 'disabled' : ''}>▼</button>
                    ${isPreset ? '' : `<button class="gg-prompt-action-btn gg-prompt-edit-btn" data-action="edit" title="Edit">✏️</button>`}
                    ${isPreset ? '<span class="gg-prompt-lock">🔒</span>' : `<button class="gg-prompt-action-btn gg-prompt-delete-btn" data-action="delete" title="Delete">🗑️</button>`}
                </div>
            </div>
            ${!isPreset ? `
            <div class="gg-prompt-block-editor" data-editor-for="${index}" style="display: none;">
                <div class="gg-prompt-editor-row">
                    <div class="gg-prompt-editor-field">
                        <label>Name</label>
                        <input type="text" class="gg-prompt-editor-name text_pole" value="${escapeHtml(block.name)}" placeholder="Block name">
                    </div>
                    <div class="gg-prompt-editor-field">
                        <label>Role</label>
                        <select class="gg-prompt-editor-role text_pole">
                            ${ROLE_OPTIONS.map(r => `<option value="${r}" ${block.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="gg-prompt-editor-field">
                    <label>Prompt</label>
                    <textarea class="gg-prompt-editor-content text_pole" rows="6" placeholder="Enter prompt text. Use {{i}}, {{d}}, {{t}}, {{f}}, {{m}} for dynamic values.">${escapeHtml(block.content)}</textarea>
                </div>
            </div>
            ` : ''}
        </div>`;
    });

    html += '</div>';

    // Add Block + Reset buttons
    html += `
    <div class="gg-prompt-blocks-footer">
        <button class="gg-button gg-button-secondary gg-prompt-add-btn" data-action="add-block">＋ Add Block</button>
        <button class="gg-button gg-button-secondary gg-prompt-reset-btn" data-action="reset-defaults" title="Reset this mode to defaults">↺ Reset Mode</button>
        ${options.onResetAll ? `<button class="gg-button gg-button-secondary gg-prompt-reset-all-btn" data-action="reset-all" title="Reset all modes to defaults">↺ Reset All</button>` : ''}
    </div>`;

    // Variable guide
    if (variableGuideHtml) {
        html += `<div class="gg-prompt-variables-guide">${variableGuideHtml}</div>`;
    }

    container.innerHTML = html;

    // ── Event Delegation ──
    if (container._ggListeners) {
        container.removeEventListener('click', container._ggListeners.click);
        container.removeEventListener('change', container._ggListeners.change);
        container.removeEventListener('input', container._ggListeners.input);
    }

    container._ggListeners = {
        click: handleClick,
        change: handleChange,
        input: handleInput
    };

    container.addEventListener('click', handleClick);
    container.addEventListener('change', handleChange);
    container.addEventListener('input', handleInput);

    function handleClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const blockEl = btn.closest('.gg-prompt-block');
        const idx = blockEl ? parseInt(blockEl.dataset.blockIndex, 10) : -1;

        switch (action) {
            case 'move-up':
                if (idx > 0) {
                    [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]];
                    persist();
                    rerender();
                }
                break;
            case 'move-down':
                if (idx < blocks.length - 1) {
                    [blocks[idx], blocks[idx + 1]] = [blocks[idx + 1], blocks[idx]];
                    persist();
                    rerender();
                }
                break;
            case 'edit': {
                const editor = container.querySelector(`[data-editor-for="${idx}"]`);
                if (editor) {
                    const isVisible = editor.style.display !== 'none';
                    
                    // Close all editors
                    const allEditors = container.querySelectorAll('.gg-prompt-block-editor');
                    allEditors.forEach(ed => ed.style.display = 'none');

                    // If it wasn't visible before, open it now
                    if (!isVisible) {
                        editor.style.display = 'flex';
                    }
                }
                break;
            }
            case 'delete':
                if (idx >= 0 && blocks[idx]?.type !== 'preset') {
                    blocks.splice(idx, 1);
                    persist();
                    rerender();
                }
                break;
            case 'add-block':
                blocks.push(createBlock());
                persist();
                rerender();
                break;
            case 'reset-defaults': {
                // Caller supplies defaults via options
                if (typeof options.getDefaults === 'function') {
                    if (confirm('Reset this specific mode to defaults?')) {
                        const defaults = options.getDefaults();
                        blocks.length = 0;
                        blocks.push(...defaults);
                        persist();
                        rerender();
                    }
                }
                break;
            }
            case 'reset-all': {
                if (typeof options.onResetAll === 'function') {
                    if (confirm('Are you sure you want to reset ALL prompt modes back to their defaults?')) {
                        const newCurrentBlocks = options.onResetAll();
                        if (newCurrentBlocks) {
                            blocks.length = 0;
                            blocks.push(...newCurrentBlocks);
                        }
                        persist();
                        rerender();
                    }
                }
                break;
            }
        }
    }

    function handleChange(e) {
        const blockEl = e.target.closest('.gg-prompt-block');
        if (!blockEl) return;
        const idx = parseInt(blockEl.dataset.blockIndex, 10);
        if (isNaN(idx) || !blocks[idx]) return;

        if (e.target.classList.contains('gg-prompt-toggle-input')) {
            blocks[idx].enabled = e.target.checked;
            persist();
            rerender();
        } else if (e.target.classList.contains('gg-prompt-editor-role')) {
            blocks[idx].role = e.target.value;
            persist();
            rerender();
        }
    }

    function handleInput(e) {
        const blockEl = e.target.closest('.gg-prompt-block');
        if (!blockEl) return;
        const idx = parseInt(blockEl.dataset.blockIndex, 10);
        if (isNaN(idx) || !blocks[idx]) return;

        if (e.target.classList.contains('gg-prompt-editor-name')) {
            blocks[idx].name = e.target.value;
            // Update the display name live
            const nameSpan = blockEl.querySelector('.gg-prompt-block-name');
            if (nameSpan) nameSpan.textContent = e.target.value;
            persist();
        } else if (e.target.classList.contains('gg-prompt-editor-content')) {
            blocks[idx].content = e.target.value;
            persist();
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Variable guide HTML snippets
// ────────────────────────────────────────────────────────────────────────────

export const EDIT_DESC_VARIABLES_HTML = `
<details class="gg-variables-details">
    <summary>📋 Available Variables</summary>
    <table class="gg-variables-table">
        <tr><td><code>{{i}}</code></td><td>User instruction (from the Normal tab textarea)</td></tr>
        <tr><td><code>{{d}}</code></td><td>Current character description</td></tr>
        <tr><td><code>{{t}}</code></td><td>Pinged targets (from <code>@{...}</code> syntax)</td></tr>
        <tr><td><code>{{f}}</code></td><td>Format fields (from the Format tab)</td></tr>
        <tr><td><code>{{char}}</code></td><td>Character name (resolved by ST)</td></tr>
        <tr><td><code>{{user}}</code></td><td>User/persona name (resolved by ST)</td></tr>
    </table>
</details>`;

export const EDIT_INTROS_VARIABLES_HTML = `
<details class="gg-variables-details">
    <summary>📋 Available Variables</summary>
    <table class="gg-variables-table">
        <tr><td><code>{{i}}</code></td><td>User instruction (from the Instruction textarea)</td></tr>
        <tr><td><code>{{m}}</code></td><td>Current intro message (the greeting to rewrite)</td></tr>
        <tr><td><code>{{char}}</code></td><td>Character name (resolved by ST)</td></tr>
        <tr><td><code>{{user}}</code></td><td>User/persona name (resolved by ST)</td></tr>
    </table>
</details>`;
