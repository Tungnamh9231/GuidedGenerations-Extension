import { getBlockById, PROMPT_SCOPE } from './registry.js';
import {
    getEffectivePromptConfig,
    setPromptConfig,
    resetPromptConfig,
    readPromptText,
    writePromptText,
    resetPromptText,
    IN_CHAT,
    RELATIVE,
} from './store.js';
import { extensionName, extension_settings, saveSettingsDebounced } from '../persistentGuides/guideExports.js';
import { defaultSettings } from '../../index.js';

const POPUP_ID = 'gg-pm-edit-popup';

let editor = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function definitionOf(block, key) {
    return block.prompts.find(prompt => prompt.key === key);
}

// Feature-level flags (raw send) are consumed by the guide code itself, so they
// live in extension settings rather than in the prompt config.
function featureKeys(block, definition) {
    const flags = block.flags ?? {};
    return {
        rawKey: definition.scope === PROMPT_SCOPE.TOOL ? (flags.raw ?? null) : null,
    };
}

function writeFeatureSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

async function createDraft(block, key) {
    const definition = definitionOf(block, key);
    const config = getEffectivePromptConfig(key);
    const { rawKey } = featureKeys(block, definition);
    return {
        key,
        scope: definition.scope,
        textOnly: Boolean(definition.textOnly),
        label: definition.label,
        text: await readPromptText(key),
        name: config.name,
        role: config.role,
        position: config.position,
        depth: config.depth,
        order: config.order,
        rawKey,
        raw: rawKey ? Boolean(extension_settings[extensionName]?.[rawKey]) : false,
        variables: definition.variables ?? [],
        touched: new Set(),
    };
}

function variablesHtml(variables) {
    if (!variables.length) return '';
    const list = items => items.map(item => `
        <div class="gg-prompt-variable-item">
            <span class="gg-prompt-variable-tag">{{${escapeHtml(item.name)}}}</span>
            <span class="gg-prompt-variable-desc">${escapeHtml(item.desc)}</span>
        </div>
    `).join('');

    const feature = variables.filter(item => !item.st);
    const macros = variables.filter(item => item.st);
    const groups = [];
    if (feature.length) {
        groups.push(`
            <div class="gg-pm-field gg-pm-field-full">
                <label>Prompt variables</label>
                <div class="text_muted">Replaced by this feature right before the prompt is sent. Keep the double braces.</div>
                <div class="gg-prompt-variables-list">${list(feature)}</div>
            </div>
        `);
    }
    if (macros.length) {
        groups.push(`
            <div class="gg-pm-field gg-pm-field-full">
                <label>SillyTavern macros</label>
                <div class="text_muted">Expanded by SillyTavern when the prompt is sent.</div>
                <div class="gg-prompt-variables-list">${list(macros)}</div>
            </div>
        `);
    }
    return groups.join('');
}

function tabsHtml() {
    if (editor.block.prompts.length < 2) return '';
    const buttons = editor.block.prompts.map(definition => {
        const draft = editor.drafts.get(definition.key);
        const dirty = draft && draft.touched.size ? '<span class="gg-pm-tab-dot"></span>' : '';
        const active = definition.key === editor.current ? ' gg-pm-tab-active' : '';
        return `<button type="button" class="gg-pm-tab${active}" data-pm-tab="${escapeHtml(definition.key)}">${escapeHtml(definition.label)}${dirty}</button>`;
    }).join('');
    return `<div class="gg-pm-edit-tabs">${buttons}</div>`;
}

function formHtml(draft) {
    const depthVisible = draft.position === IN_CHAT;

    const featureFields = [];
    if (draft.rawKey) {
        featureFields.push(`
            <div class="gg-pm-field">
                <label class="gg-pm-check" for="gg-pm-edit-raw">
                    <input id="gg-pm-edit-raw" type="checkbox"${draft.raw ? ' checked' : ''} />
                    <span>Raw prompt</span>
                </label>
                <div class="text_muted">Send the prompt without macro substitution.</div>
            </div>
        `);
    }
    const featureRow = featureFields.length ? `<div class="gg-pm-form-row">${featureFields.join('')}</div>` : '';

    const configFields = draft.textOnly ? `
        <div class="gg-pm-form-note">
            This prompt is plain text used inside the <b>${escapeHtml(editor.block.label)}</b> flow, so only its
            text is managed here.
        </div>
    ` : `
        <div class="gg-pm-form-row">
            <div class="gg-pm-field">
                <label for="gg-pm-edit-name">Name</label>
                <input id="gg-pm-edit-name" class="text_pole" type="text" value="${escapeHtml(draft.name)}" placeholder="${escapeHtml(draft.label)}" />
                <div class="text_muted">A name for this prompt.</div>
            </div>
            <div class="gg-pm-field">
                <label for="gg-pm-edit-role">Role</label>
                <select id="gg-pm-edit-role" class="text_pole">
                    <option value="system"${draft.role === 'system' ? ' selected' : ''}>System</option>
                    <option value="user"${draft.role === 'user' ? ' selected' : ''}>User</option>
                    <option value="assistant"${draft.role === 'assistant' ? ' selected' : ''}>AI Assistant</option>
                </select>
                <div class="text_muted">To whom this message will be attributed.</div>
            </div>
        </div>
        <div class="gg-pm-form-row">
            <div class="gg-pm-field">
                <label for="gg-pm-edit-position">Position</label>
                <select id="gg-pm-edit-position" class="text_pole">
                    <option value="${RELATIVE}"${draft.position === RELATIVE ? ' selected' : ''}>Relative</option>
                    <option value="${IN_CHAT}"${draft.position === IN_CHAT ? ' selected' : ''}>In-chat</option>
                </select>
                <div class="text_muted">Relative to the block's place in the list, or In-chat @ Depth.</div>
            </div>
            <div class="gg-pm-field${depthVisible ? '' : ' gg-pm-field-hidden'}" id="gg-pm-depth-field">
                <label for="gg-pm-edit-depth">Depth</label>
                <input id="gg-pm-edit-depth" class="text_pole" type="number" min="0" max="9999" value="${escapeHtml(draft.depth)}" />
                <div class="text_muted">0 = after the last message, 1 = before the last message, etc.</div>
            </div>
            <div class="gg-pm-field${depthVisible ? '' : ' gg-pm-field-hidden'}" id="gg-pm-order-field">
                <label for="gg-pm-edit-order">Order</label>
                <input id="gg-pm-edit-order" class="text_pole" type="number" min="0" max="9999" value="${escapeHtml(draft.order)}" />
                <div class="text_muted">Low to high; at the same order: Assistant, User, System.</div>
            </div>
        </div>
    `;

    return `
        ${featureRow}
        ${configFields}
        <div class="gg-pm-field gg-pm-field-full">
            <label for="gg-pm-edit-text">Prompt</label>
            <textarea id="gg-pm-edit-text" class="text_pole gg-editor-textarea" rows="12" placeholder="The prompt to be sent.">${escapeHtml(draft.text)}</textarea>
        </div>
        ${variablesHtml(draft.variables)}
    `;
}

function popupHtml() {
    return `
        <div id="${POPUP_ID}" class="gg-popup gg-pm-edit-popup" style="display: none;" aria-hidden="true">
            <div class="gg-popup-content gg-pm-edit-content">
                <div class="gg-popup-header">
                    <h2><i class="fa-solid fa-pencil" id="gg-pm-edit-icon"></i> <span id="gg-pm-edit-title"></span></h2>
                    <span class="gg-popup-close" id="gg-pm-edit-close" title="Close">&times;</span>
                </div>
                <div class="gg-pm-edit-tabs" id="gg-pm-edit-tabs"></div>
                <div class="gg-pm-edit-form" id="gg-pm-edit-form"></div>
                <div class="gg-popup-footer">
                    <button type="button" id="gg-pm-edit-reset" class="gg-button gg-button-secondary" title="Restore the default prompt and default send settings">
                        <i class="fa-solid fa-rotate-left"></i> Reset to default
                    </button>
                    <button type="button" id="gg-pm-edit-save" class="gg-button"><i class="fa-solid fa-save"></i> Save</button>
                    <button type="button" id="gg-pm-edit-cancel" class="gg-button gg-button-quiet">Close</button>
                </div>
            </div>
        </div>
    `;
}

function ensurePopup() {
    let popup = document.getElementById(POPUP_ID);
    if (popup) return popup;

    const holder = document.createElement('div');
    holder.innerHTML = popupHtml().trim();
    document.body.appendChild(holder.firstElementChild);
    popup = document.getElementById(POPUP_ID);

    popup.addEventListener('mousedown', event => {
        if (event.target === popup) closeBlockEditor();
    });
    popup.querySelector('#gg-pm-edit-close').addEventListener('click', () => closeBlockEditor());
    popup.querySelector('#gg-pm-edit-cancel').addEventListener('click', () => closeBlockEditor());
    popup.querySelector('#gg-pm-edit-save').addEventListener('click', () => saveEditor());
    popup.querySelector('#gg-pm-edit-reset').addEventListener('click', () => resetCurrentPrompt());
    popup.querySelector('#gg-pm-edit-tabs').addEventListener('click', event => {
        const tab = event.target.closest('[data-pm-tab]');
        if (tab) switchTab(tab.dataset.pmTab);
    });
    popup.querySelector('#gg-pm-edit-form').addEventListener('input', handleFormInput);
    popup.querySelector('#gg-pm-edit-form').addEventListener('change', handleFormInput);
    return popup;
}

function currentDraft() {
    return editor?.drafts.get(editor.current) ?? null;
}

function markDirty(draft, field) {
    draft.touched.add(field);
    if (field !== 'text' && field !== 'raw') draft.configTouched = true;
    editor.dirty = true;
    renderTabs();
}

function handleFormInput(event) {
    const draft = currentDraft();
    if (!draft) return;

    switch (event.target.id) {
        case 'gg-pm-edit-text':
            draft.text = event.target.value;
            markDirty(draft, 'text');
            break;
        case 'gg-pm-edit-name':
            draft.name = event.target.value;
            markDirty(draft, 'name');
            break;
        case 'gg-pm-edit-role':
            draft.role = event.target.value;
            markDirty(draft, 'role');
            break;
        case 'gg-pm-edit-position':
            draft.position = Number(event.target.value);
            markDirty(draft, 'position');
            toggleDepthFields(draft.position === IN_CHAT);
            break;
        case 'gg-pm-edit-depth':
            draft.depth = Number(event.target.value);
            markDirty(draft, 'depth');
            break;
        case 'gg-pm-edit-order':
            draft.order = Number(event.target.value);
            markDirty(draft, 'order');
            break;
        case 'gg-pm-edit-raw':
            draft.raw = event.target.checked;
            markDirty(draft, 'raw');
            break;
    }
}

function toggleDepthFields(show) {
    const popup = ensurePopup();
    popup.querySelector('#gg-pm-depth-field')?.classList.toggle('gg-pm-field-hidden', !show);
    popup.querySelector('#gg-pm-order-field')?.classList.toggle('gg-pm-field-hidden', !show);
}

function renderTabs() {
    const popup = ensurePopup();
    popup.querySelector('#gg-pm-edit-tabs').innerHTML = tabsHtml();
}

function renderForm() {
    const popup = ensurePopup();
    const draft = currentDraft();
    if (!draft) return;
    popup.querySelector('#gg-pm-edit-form').innerHTML = formHtml(draft);
}

async function switchTab(key) {
    if (!editor || key === editor.current) return;
    if (!editor.block.prompts.some(prompt => prompt.key === key)) return;
    editor.current = key;
    renderTabs();
    renderForm();
}

function saveEditor() {
    if (!editor) return;
    for (const draft of editor.drafts.values()) {
        if (draft.touched.has('text')) {
            writePromptText(draft.key, draft.text);
        }
        if (draft.rawKey && draft.touched.has('raw')) {
            writeFeatureSetting(draft.rawKey, draft.raw);
        }
        if (!draft.textOnly && draft.configTouched) {
            // Seed with the currently effective values so saving one field does not
            // silently reset the others to their defaults.
            const effective = getEffectivePromptConfig(draft.key);
            setPromptConfig(draft.key, {
                name: draft.name || effective.name,
                role: draft.role,
                position: draft.position,
                depth: draft.depth,
                order: draft.order,
            });
            // Keep the feature's own injection depth in sync with the override.
            const depthKey = editor.block.flags?.depth;
            if (depthKey) writeFeatureSetting(depthKey, draft.depth);
        }
        draft.touched.clear();
        draft.configTouched = false;
    }
    editor.dirty = false;
    renderTabs();
    editor.onChanged?.();
    closeBlockEditor(true);
}

async function resetCurrentPrompt() {
    const draft = currentDraft();
    if (!draft) return;
    if (!confirm(`Reset "${draft.label}" to its default prompt and default send settings?`)) return;

    resetPromptText(draft.key);
    if (!draft.textOnly) {
        resetPromptConfig(draft.key);
        const depthKey = editor.block.flags?.depth;
        if (depthKey) writeFeatureSetting(depthKey, defaultSettings[depthKey]);
    }
    if (draft.rawKey) writeFeatureSetting(draft.rawKey, defaultSettings[draft.rawKey]);

    const fresh = await createDraft(editor.block, draft.key);
    editor.drafts.set(draft.key, fresh);
    editor.dirty = editor.dirty || [...editor.drafts.values()].some(item => item.touched.size > 0);
    renderTabs();
    renderForm();
    editor.onChanged?.();
}

export async function openBlockEditor(blockId, { onChanged = null } = {}) {
    const block = getBlockById(blockId);
    if (!block) return;

    if (editor?.dirty && !confirm('Discard unsaved changes?')) return;

    const popup = ensurePopup();
    editor = {
        block,
        current: block.prompts[0].key,
        drafts: new Map(),
        dirty: false,
        onChanged,
    };

    for (const definition of block.prompts) {
        editor.drafts.set(definition.key, await createDraft(block, definition.key));
    }

    popup.querySelector('#gg-pm-edit-title').textContent = block.label;
    const icon = popup.querySelector('#gg-pm-edit-icon');
    icon.className = `fa-solid ${block.icon}`;
    popup.style.display = 'flex';
    popup.setAttribute('aria-hidden', 'false');
    renderTabs();
    renderForm();
}

export function closeBlockEditor(force = false) {
    if (!editor) return;
    if (!force && editor.dirty && !confirm('Discard unsaved changes?')) return;
    const popup = document.getElementById(POPUP_ID);
    if (popup) {
        popup.style.display = 'none';
        popup.setAttribute('aria-hidden', 'true');
    }
    editor = null;
}
