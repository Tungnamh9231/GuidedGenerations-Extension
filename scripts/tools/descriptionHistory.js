/**
 * Per-character description snapshot history for Edit Description.
 * Snapshots persist in localStorage and are capped per character.
 */

import { getContext, debugLog } from '../persistentGuides/guideExports.js';

const STORAGE_KEY = 'gg_editDescriptionHistoryV1';
const MAX_ENTRIES = 10;
const STYLE_ID = 'gg-desc-history-style';
const ALL_POPUP_ID = 'ggDescHistoryAllPopup';

const MODE_LABELS = Object.freeze({
    before: 'Before change',
    editExisting: 'Edit Existing',
    makeNew: 'Create New',
    createWorld: 'Create World',
    revert: 'Revert',
});

function uid() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        /* fall through */
    }
    return `desc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatTime(ts) {
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return String(ts);
    }
}

function modeLabel(mode) {
    return MODE_LABELS[mode] || 'Change';
}

function previewText(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '(empty)';
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function notify(type, message) {
    const api = globalThis.toastr;
    const fn = api?.[type] || api?.info;
    if (typeof fn === 'function') fn(message);
    else console[type === 'error' ? 'error' : 'log'](`[EditDescriptionHistory] ${message}`);
}

function getCharacterKey(character) {
    const avatar = character?.avatar;
    return typeof avatar === 'string' && avatar ? avatar : null;
}

function createEmptyStore() {
    return { version: 1, characters: {} };
}

function normalizeRecord(record, key) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.entries)) return null;
    const entries = record.entries
        .filter(entry => entry && typeof entry.value === 'string' && Number.isFinite(Number(entry.ts)))
        .map(entry => ({
            id: typeof entry.id === 'string' && entry.id ? entry.id : uid(),
            ts: Number(entry.ts),
            value: entry.value,
            mode: typeof entry.mode === 'string' ? entry.mode : 'before',
        }))
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_ENTRIES);
    if (!entries.length) return null;
    return {
        name: typeof record.name === 'string' && record.name ? record.name : key,
        entries,
    };
}

function loadStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return createEmptyStore();
        const parsed = JSON.parse(raw);
        const characters = {};
        for (const [key, record] of Object.entries(parsed?.characters || {})) {
            const normalized = normalizeRecord(record, key);
            if (normalized) characters[key] = normalized;
        }
        return { version: 1, characters };
    } catch (error) {
        console.warn('[EditDescriptionHistory] Could not read saved history:', error);
        return createEmptyStore();
    }
}

function persistStore(store) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        return true;
    } catch (error) {
        console.error('[EditDescriptionHistory] Could not save history:', error);
        notify('error', 'Could not save description history. Browser storage may be full.');
        return false;
    }
}

function isElementVisible(element) {
    return Boolean(
        element
        && element.isConnected
        && element.getAttribute('aria-hidden') !== 'true'
        && getComputedStyle(element).display !== 'none',
    );
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .gg-desc-history-toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 10px;
        }
        .gg-history-section .gg-button,
        .gg-desc-history-all-dialog .gg-button {
            display: inline-flex;
            flex: 0 0 auto;
            align-items: center;
            justify-content: center;
            gap: 6px;
            box-sizing: border-box;
            width: auto;
            height: auto;
            min-height: 34px;
            margin: 0;
            padding: 7px 12px;
            white-space: nowrap;
            text-align: center;
            font-family: inherit;
            font-size: 0.8em;
            font-weight: 600;
            line-height: 1.2;
            color: var(--SmartThemeBodyColor);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 8px;
            box-shadow: none;
            appearance: none;
            -webkit-appearance: none;
            cursor: pointer;
            transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease;
        }
        .gg-history-section .gg-button:hover,
        .gg-desc-history-all-dialog .gg-button:hover {
            background: rgba(255, 255, 255, 0.11);
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, var(--SmartThemeBorderColor));
            opacity: 1;
        }
        .gg-history-section .gg-button-quiet,
        .gg-desc-history-all-dialog .gg-button-quiet {
            background: transparent;
            border-color: var(--SmartThemeBorderColor);
            opacity: 0.85;
        }
        .gg-history-section .gg-button-quiet:hover,
        .gg-desc-history-all-dialog .gg-button-quiet:hover {
            background: rgba(255, 255, 255, 0.08);
            opacity: 1;
        }
        .gg-history-section .gg-button[data-history-action="revert"],
        .gg-desc-history-all-dialog .gg-button[data-history-action="revert"] {
            background: color-mix(in srgb, var(--gg-editor-accent, var(--SmartThemeQuoteColor)) 10%, transparent);
            border-color: color-mix(in srgb, var(--gg-editor-accent, var(--SmartThemeQuoteColor)) 45%, var(--SmartThemeBorderColor));
        }
        .gg-history-section .gg-button[data-history-action="revert"]:hover,
        .gg-desc-history-all-dialog .gg-button[data-history-action="revert"]:hover {
            background: color-mix(in srgb, var(--gg-editor-accent, var(--SmartThemeQuoteColor)) 18%, transparent);
        }
        .gg-history-section .gg-desc-history-danger,
        .gg-desc-history-all-dialog .gg-desc-history-danger {
            color: #ff9b9b;
            border-color: color-mix(in srgb, #ff7676 38%, var(--SmartThemeBorderColor));
        }
        .gg-history-section .gg-desc-history-danger:hover,
        .gg-desc-history-all-dialog .gg-desc-history-danger:hover {
            background: rgba(255, 118, 118, 0.12);
        }
        .gg-history-section .gg-button:disabled,
        .gg-desc-history-all-dialog .gg-button:disabled {
            cursor: not-allowed;
            opacity: 0.4;
            filter: saturate(0.5);
        }
        .gg-desc-history-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 46vh;
            overflow-y: auto;
            padding-right: 2px;
        }
        .gg-desc-history-entry {
            padding: 9px 10px;
            background: rgba(0, 0, 0, 0.12);
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 9px;
        }
        .gg-desc-history-entry-head {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px 10px;
            font-size: 0.74em;
            opacity: 0.75;
        }
        .gg-desc-history-mode {
            font-weight: 600;
        }
        .gg-desc-history-preview {
            display: -webkit-box;
            margin: 6px 0 7px;
            overflow: hidden;
            font-size: 0.82em;
            line-height: 1.4;
            white-space: pre-wrap;
            opacity: 0.9;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
        }
        .gg-desc-history-entry-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
        }
        .gg-desc-history-entry-actions .gg-button,
        .gg-desc-history-char-head .gg-button {
            min-height: 30px;
            padding: 5px 10px;
            font-size: 0.78em;
        }
        .gg-desc-history-empty {
            padding: 18px 12px;
            text-align: center;
            font-size: 0.85em;
            opacity: 0.7;
            border: 1px dashed var(--SmartThemeBorderColor);
            border-radius: 9px;
        }
        .gg-desc-history-summary {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-bottom: 10px;
            font-size: 0.85em;
            opacity: 0.85;
        }
        .gg-desc-history-all-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .gg-desc-history-char-card {
            padding: 10px;
            margin-bottom: 10px;
            background: rgba(0, 0, 0, 0.1);
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 11px;
        }
        .gg-desc-history-char-card.is-orphan {
            border-color: rgba(255, 118, 118, 0.5);
        }
        .gg-desc-history-char-head {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
        }
        .gg-desc-history-avatar-wrap {
            position: relative;
            flex: 0 0 34px;
            width: 34px;
            height: 34px;
        }
        .gg-desc-history-avatar,
        .gg-desc-history-avatar-fallback {
            width: 34px;
            height: 34px;
            border-radius: 50%;
            object-fit: cover;
        }
        .gg-desc-history-avatar-fallback {
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 18%, transparent);
        }
        .gg-desc-history-avatar {
            position: absolute;
            inset: 0;
        }
        .gg-desc-history-char-copy {
            flex: 1;
            min-width: 0;
        }
        .gg-desc-history-char-name {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 700;
        }
        .gg-desc-history-char-meta {
            overflow-wrap: anywhere;
            font-size: 0.72em;
            opacity: 0.7;
        }
        .gg-desc-history-orphan-badge {
            padding: 1px 5px;
            font-size: 0.65em;
            color: #ff9b9b;
            background: rgba(255, 118, 118, 0.15);
            border-radius: 999px;
        }
        .gg-desc-history-orphan-status {
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 8px 10px;
            margin-bottom: 10px;
            font-size: 0.8em;
            border-radius: 8px;
        }
        .gg-desc-history-orphan-status.ok {
            color: #8fdf9b;
            background: rgba(76, 175, 80, 0.1);
        }
        .gg-desc-history-orphan-status.warn {
            color: #ff9b9b;
            background: rgba(255, 118, 118, 0.1);
        }
        .gg-desc-history-orphan-status.info {
            opacity: 0.8;
            background: rgba(255, 255, 255, 0.05);
        }
        .gg-desc-history-section-title {
            margin: 14px 0 8px;
            font-size: 0.9em;
        }
        .gg-desc-history-no-history {
            margin-top: 12px;
            font-size: 0.85em;
        }
        .gg-desc-history-no-history summary {
            cursor: pointer;
            opacity: 0.85;
        }
        .gg-desc-history-name-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
        }
        .gg-desc-history-name-chip {
            padding: 3px 8px;
            font-size: 0.8em;
            opacity: 0.8;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 999px;
        }
        .gg-editor-popup .gg-editor-dialog.gg-desc-history-all-dialog {
            width: min(920px, 94vw);
            max-width: 920px;
        }
        #ggDescHistoryComparePopup .gg-editor-dialog {
            width: min(1080px, 96vw);
            max-width: 1080px;
        }
        .gg-desc-compare-meta {
            margin-bottom: 10px;
            font-size: 0.82em;
            opacity: 0.8;
        }
        .gg-desc-compare-grid {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 12px;
        }
        .gg-desc-compare-panel {
            display: flex;
            flex-direction: column;
            min-width: 0;
            overflow: hidden;
            background: rgba(0, 0, 0, 0.12);
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 10px;
        }
        .gg-desc-compare-panel-head {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 10px;
            font-size: 0.8em;
            font-weight: 700;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid var(--SmartThemeBorderColor);
        }
        .gg-desc-compare-panel-meta {
            font-weight: 500;
            opacity: 0.7;
        }
        .gg-desc-compare-text {
            max-height: 52vh;
            margin: 0;
            padding: 10px;
            overflow: auto;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            font-size: 0.82em;
            line-height: 1.55;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        #ggDescHistoryComparePopup .gg-desc-compare-diff {
            max-height: 52vh;
            border: 0;
            border-radius: 0;
        }
        .gg-desc-compare-legend {
            display: inline-flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
            font-weight: 500;
            font-size: 0.92em;
            opacity: 0.9;
        }
        .gg-desc-compare-legend span {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .gg-desc-compare-note {
            margin: 10px 0 0;
            font-size: 0.78em;
            opacity: 0.7;
        }
        @media (max-width: 760px) {
            .gg-desc-compare-grid {
                grid-template-columns: 1fr;
            }
            .gg-desc-compare-text,
            #ggDescHistoryComparePopup .gg-desc-compare-diff {
                max-height: 35vh;
            }
        }
        @media (max-width: 560px) {
            .gg-desc-history-list {
                max-height: 52vh;
            }
            .gg-desc-history-entry-actions {
                justify-content: stretch;
            }
            .gg-desc-history-entry-actions .gg-button {
                flex: 1 1 0;
            }
        }
    `;
    document.head.appendChild(style);
}

class DescriptionHistory {
    constructor() {
        this.initialized = false;
        this.eventsBound = false;
        this.store = null;
        this.panelRoot = null;
        this.panelOptions = null;
        this.boundPanel = null;
        this.allPopup = null;
        this.allState = null;
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;
        this.store = loadStore();
        ensureStyles();
        this._bindCharacterEvents();
        this._migrateLegacySnapshots();

        let attempts = 0;
        const tryPrune = () => {
            this._migrateLegacySnapshots();
            const result = this.pruneOrphans('startup');
            attempts += 1;
            if (result.skipped && attempts < 3) setTimeout(tryPrune, 3000);
        };
        setTimeout(tryPrune, 2000);
    }

    /**
     * Older builds stored both the value before and after a change. The value
     * after is the current description, so drop that trailing entry once the
     * character list is available.
     */
    _migrateLegacySnapshots() {
        if (!this.store) return;
        const characters = getContext()?.characters;
        if (!Array.isArray(characters) || !characters.length) return;

        const byAvatar = new Map();
        for (const character of characters) {
            if (character?.avatar) byAvatar.set(character.avatar, character);
        }

        let changed = false;
        for (const [key, record] of Object.entries(this.store.characters)) {
            const entries = record?.entries;
            if (!Array.isArray(entries) || !entries.length) continue;

            const last = entries[entries.length - 1];
            const character = byAvatar.get(key);
            if (last.mode !== 'before'
                && character
                && typeof character.description === 'string'
                && last.value === character.description) {
                entries.pop();
                changed = true;
            }
            if (!entries.length) {
                delete this.store.characters[key];
                changed = true;
            }
        }
        if (changed) persistStore(this.store);
    }

    _bindCharacterEvents() {
        if (this.eventsBound) return;
        const context = getContext();
        const source = context?.eventSource;
        const types = context?.eventTypes;
        if (!source || !types) return;
        this.eventsBound = true;

        if (types.CHARACTER_DELETED) {
            source.on(types.CHARACTER_DELETED, data => this.handleCharacterDeleted(data));
        }
        if (types.CHARACTER_RENAMED) {
            source.on(types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => this.handleCharacterRenamed(oldAvatar, newAvatar));
        }
        if (types.CHARACTER_EDITED) {
            source.on(types.CHARACTER_EDITED, data => this.handleCharacterEdited(data));
        }
        if (types.APP_READY) {
            source.on(types.APP_READY, () => setTimeout(() => this.pruneOrphans('app-ready'), 1200));
        }
        if (types.CHAT_CHANGED) {
            source.on(types.CHAT_CHANGED, () => this.refreshOpenViews());
        }
    }

    attachPanel(root, options = {}) {
        if (!root) return;
        this.panelRoot = root;
        this.panelOptions = options;
        this._bindCharacterEvents();
        if (this.boundPanel === root) return;
        this.boundPanel = root;

        root.querySelector('#gg-history-list')?.addEventListener('click', event => this._handlePanelAction(event));
        root.querySelector('#gg-history-clear')?.addEventListener('click', () => this.clearCurrentCharacter());
        root.querySelector('#gg-history-view-all')?.addEventListener('click', () => this.openAll());
    }

    getEntries(key) {
        return this.store?.characters?.[key]?.entries || [];
    }

    record(character, beforeValue, afterValue) {
        const key = getCharacterKey(character);
        if (!key) return false;
        if (typeof beforeValue !== 'string' || typeof afterValue !== 'string') return false;
        if (beforeValue === afterValue) return false;
        if (!this.store) this.store = loadStore();

        const record = this.store.characters[key] || { name: character?.name || key, entries: [] };
        record.name = character?.name || record.name || key;

        // Only the pre-change description is stored. The new value becomes
        // history later, when the next change starts from it.
        const last = record.entries[record.entries.length - 1];
        if (!last || last.value !== beforeValue) {
            record.entries.push({ id: uid(), ts: Date.now(), value: beforeValue, mode: 'before' });
        }
        if (record.entries.length > MAX_ENTRIES) {
            record.entries = record.entries.slice(-MAX_ENTRIES);
        }

        this.store.characters[key] = record;
        const saved = persistStore(this.store);
        this.refreshOpenViews();
        return saved;
    }

    deleteEntry(key, entryId) {
        const record = this.store?.characters?.[key];
        if (!record) return false;
        const nextEntries = record.entries.filter(entry => entry.id !== entryId);
        if (nextEntries.length === record.entries.length) return false;
        if (!nextEntries.length) delete this.store.characters[key];
        else record.entries = nextEntries;
        persistStore(this.store);
        this.refreshOpenViews();
        return true;
    }

    clearCharacter(key) {
        if (!key || !this.store?.characters?.[key]) return false;
        delete this.store.characters[key];
        persistStore(this.store);
        this.refreshOpenViews();
        return true;
    }

    clearCurrentCharacter() {
        const character = this.panelOptions?.getCurrentCharacter?.() ?? null;
        const key = getCharacterKey(character);
        if (!key) {
            notify('warning', 'Open a character in the Character Editor first.');
            return;
        }
        const record = this.store?.characters?.[key];
        if (!record) {
            notify('info', 'This character has no revert history.');
            return;
        }
        const name = character?.name || record.name || key;
        if (!confirm(`Delete all ${record.entries.length} snapshot(s) for "${name}"? This cannot be undone.`)) return;
        this.clearCharacter(key);
        notify('info', `Deleted revert history for "${name}".`);
    }

    _handlePanelAction(event) {
        const button = event.target.closest('[data-history-action]');
        if (!button) return;
        const action = button.dataset.historyAction;
        const entryId = button.dataset.entryId;
        const character = this.panelOptions?.getCurrentCharacter?.() ?? null;
        const key = getCharacterKey(character);
        if (!key) return;

        if (action === 'compare') {
            const entry = this.getEntries(key).find(item => item.id === entryId);
            if (!entry) return;
            if (!this.panelOptions?.onCompare) {
                notify('warning', 'Compare is unavailable. Open the Character Editor and try again.');
                return;
            }
            this.panelOptions.onCompare({ entry, key, character });
        } else if (action === 'revert') {
            const entry = this.getEntries(key).find(item => item.id === entryId);
            if (!entry) return;
            const applied = this.panelOptions?.onRevert?.(entry.value);
            if (applied === true) notify('success', 'Description reverted.');
            else if (applied === null) notify('info', 'The description already matches this snapshot.');
            else notify('warning', 'Could not revert. Open the Character Editor and try again.');
        } else if (action === 'delete-entry') {
            if (this.deleteEntry(key, entryId)) notify('info', 'Snapshot deleted.');
        }
    }

    renderCurrent() {
        const root = this.panelRoot;
        if (!root) return;
        const list = root.querySelector('#gg-history-list');
        const subtitle = root.querySelector('#gg-history-subtitle');
        const countEl = root.querySelector('#gg-history-count');
        const clearButton = root.querySelector('#gg-history-clear');
        if (!list) return;

        const character = this.panelOptions?.getCurrentCharacter?.() ?? null;
        const key = getCharacterKey(character);
        const entries = key ? this.getEntries(key) : [];

        if (subtitle) {
            if (key) {
                subtitle.innerHTML = `Descriptions from before each change of <strong>${escapeHtml(character?.name || key)}</strong>. Up to ${MAX_ENTRIES} are kept per character.`;
            } else if (character) {
                subtitle.textContent = 'History is unavailable for this character because it has no avatar identifier.';
            } else {
                subtitle.textContent = 'Open a character in the Character Editor to see its revert history.';
            }
        }
        if (countEl) countEl.textContent = `${entries.length} / ${MAX_ENTRIES} saved`;
        if (clearButton) clearButton.disabled = entries.length === 0;

        if (!key) {
            list.innerHTML = '<div class="gg-desc-history-empty">Open a character in the Character Editor to see its revert history.</div>';
            return;
        }
        if (!entries.length) {
            list.innerHTML = '<div class="gg-desc-history-empty">No snapshots yet. The description from before each change is saved here.</div>';
            return;
        }

        const canEditDescription = Boolean(document.getElementById('description_textarea'));
        const canCompare = canEditDescription && Boolean(this.panelOptions?.onCompare);
        list.innerHTML = [...entries]
            .reverse()
            .map((entry, index) => this._entryHtml(entry, { key, canRevert: canEditDescription, canCompare, latest: index === 0 }))
            .join('');
    }

    _entryHtml(entry, { key, canRevert, canCompare = false, latest }) {
        const disabled = canRevert ? '' : ' disabled title="Open this character in the Character Editor to revert"';
        const compareDisabled = canCompare ? '' : ' disabled title="Open this character in the Character Editor to compare"';
        return `
            <article class="gg-desc-history-entry">
                <div class="gg-desc-history-entry-head">
                    <span class="gg-desc-history-time">${escapeHtml(formatTime(entry.ts))}</span>
                    <span class="gg-desc-history-mode">${escapeHtml(modeLabel(entry.mode))}${latest ? ' - latest' : ''}</span>
                    <span class="gg-desc-history-size">${entry.value.length} chars</span>
                </div>
                <div class="gg-desc-history-preview">${escapeHtml(previewText(entry.value))}</div>
                <div class="gg-desc-history-entry-actions">
                    <button type="button" class="gg-button gg-button-quiet" data-history-action="compare" data-key="${escapeHtml(key)}" data-entry-id="${escapeHtml(entry.id)}"${compareDisabled}>
                        <i class="fa-solid fa-code-compare" aria-hidden="true"></i>
                        <span>Compare</span>
                    </button>
                    <button type="button" class="gg-button gg-button-secondary" data-history-action="revert" data-key="${escapeHtml(key)}" data-entry-id="${escapeHtml(entry.id)}"${disabled}>
                        <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                        <span>Revert</span>
                    </button>
                    <button type="button" class="gg-button gg-button-quiet gg-desc-history-danger" data-history-action="delete-entry" data-key="${escapeHtml(key)}" data-entry-id="${escapeHtml(entry.id)}">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        <span>Delete</span>
                    </button>
                </div>
            </article>
        `;
    }

    openAll() {
        if (!this.panelOptions) return;
        this.allState = this.panelOptions;
        this._ensureAllPopup();
        this.renderAll();
        this.allPopup.style.display = 'flex';
        this.allPopup.setAttribute('aria-hidden', 'false');
    }

    closeAll() {
        if (!this.allPopup) return;
        this.allPopup.style.display = 'none';
        this.allPopup.setAttribute('aria-hidden', 'true');
    }

    _ensureAllPopup() {
        if (this.allPopup) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div id="${ALL_POPUP_ID}" class="gg-popup gg-editor-popup" role="dialog" aria-modal="true" aria-labelledby="gg-desc-history-all-title" aria-hidden="true">
                <div class="gg-popup-content gg-editor-dialog gg-desc-history-all-dialog">
                    <div class="gg-popup-header">
                        <div class="gg-editor-title-group">
                            <span class="gg-editor-title-icon" aria-hidden="true">
                                <i class="fa-solid fa-clock-rotate-left"></i>
                            </span>
                            <div>
                                <span class="gg-editor-eyebrow">Edit Description</span>
                                <h2 id="gg-desc-history-all-title">Revert History - All Characters</h2>
                                <p>Inspect stored snapshots and verify that deleted characters leave no history behind.</p>
                            </div>
                        </div>
                        <button type="button" class="gg-popup-close" aria-label="Close revert history">
                            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div class="gg-popup-body gg-editor-body">
                        <div id="gg-desc-history-all-summary" class="gg-desc-history-summary"></div>
                        <div class="gg-desc-history-all-actions">
                            <button type="button" class="gg-button gg-button-secondary" data-history-action="clean-orphans">
                                <i class="fa-solid fa-broom" aria-hidden="true"></i>
                                <span>Clean orphaned data</span>
                            </button>
                            <button type="button" class="gg-button gg-button-quiet" data-history-action="refresh">
                                <i class="fa-solid fa-rotate" aria-hidden="true"></i>
                                <span>Refresh</span>
                            </button>
                        </div>
                        <div id="gg-desc-history-all-list"></div>
                    </div>
                </div>
            </div>
        `;
        this.allPopup = wrapper.firstElementChild;
        document.body.appendChild(this.allPopup);

        this.allPopup.querySelector('.gg-popup-close')?.addEventListener('click', () => this.closeAll());
        this.allPopup.addEventListener('click', event => {
            if (event.target === this.allPopup) {
                this.closeAll();
                return;
            }
            this._handleAllAction(event);
        });

        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (document.getElementById('ggDescHistoryComparePopup')?.getAttribute('aria-hidden') === 'false') return;
            if (this.allPopup?.getAttribute('aria-hidden') === 'false') {
                event.stopPropagation();
                this.closeAll();
            }
        }, true);
    }

    renderAll() {
        const list = this.allPopup?.querySelector('#gg-desc-history-all-list');
        const summary = this.allPopup?.querySelector('#gg-desc-history-all-summary');
        if (!list) return;

        const context = getContext();
        const characters = Array.isArray(context?.characters) ? context.characters : [];
        const byAvatar = new Map(characters.filter(character => character?.avatar).map(character => [character.avatar, character]));
        const currentCharacter = this.allState?.getCurrentCharacter?.() ?? null;
        const currentKey = getCharacterKey(currentCharacter);

        const existing = [];
        const orphans = [];
        for (const [key, record] of Object.entries(this.store?.characters || {})) {
            const character = byAvatar.get(key);
            if (character) existing.push({ key, record, character });
            else orphans.push({ key, record });
        }
        existing.sort((a, b) => characters.indexOf(a.character) - characters.indexOf(b.character));

        const withoutHistory = characters.filter(character => character?.avatar && !this.store?.characters?.[character.avatar]);

        if (summary) {
            const entryCount = existing.reduce((total, item) => total + item.record.entries.length, 0);
            const orphanEntryCount = orphans.reduce((total, item) => total + item.record.entries.length, 0);
            summary.innerHTML = `
                <span><strong>${characters.length}</strong> existing character(s)</span>
                <span><strong>${existing.length}</strong> with history</span>
                <span><strong>${entryCount}</strong> snapshot(s)</span>
                <span><strong>${orphans.length}</strong> orphaned record(s) / ${orphanEntryCount} snapshot(s)</span>
            `;
        }

        if (!existing.length && !orphans.length) {
            const names = withoutHistory
                .map(character => `<span class="gg-desc-history-name-chip">${escapeHtml(character.name || character.avatar)}</span>`)
                .join('');
            const details = withoutHistory.length
                ? `<details class="gg-desc-history-no-history"><summary>Characters without history (${withoutHistory.length})</summary><div class="gg-desc-history-name-list">${names}</div></details>`
                : '';
            list.innerHTML = `<div class="gg-desc-history-empty">No revert history is stored in this browser yet.</div>${details}`;
            return;
        }

        const parts = [];
        if (!characters.length) {
            parts.push('<div class="gg-desc-history-orphan-status info"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>Character list is empty or not loaded; records below cannot be matched to a character.</span></div>');
        } else if (orphans.length) {
            parts.push(`<div class="gg-desc-history-orphan-status warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>Found ${orphans.length} orphaned record(s). Use "Clean orphaned data" to remove them.</span></div>`);
        } else {
            parts.push('<div class="gg-desc-history-orphan-status ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>No orphaned history found. Deleted characters are cleaned up correctly.</span></div>');
        }

        if (existing.length) {
            parts.push(`<h3 class="gg-desc-history-section-title">Characters with history (${existing.length})</h3>`);
            for (const item of existing) {
                parts.push(this._characterCardHtml(item, { currentKey }));
            }
        }
        if (orphans.length) {
            parts.push(`<h3 class="gg-desc-history-section-title">Orphaned records (${orphans.length})</h3>`);
            for (const item of orphans) {
                parts.push(this._characterCardHtml(item, { currentKey, orphan: true }));
            }
        }
        if (withoutHistory.length) {
            const names = withoutHistory
                .map(character => `<span class="gg-desc-history-name-chip">${escapeHtml(character.name || character.avatar)}</span>`)
                .join('');
            parts.push(`
                <details class="gg-desc-history-no-history">
                    <summary>Characters without history (${withoutHistory.length})</summary>
                    <div class="gg-desc-history-name-list">${names}</div>
                </details>
            `);
        }

        list.innerHTML = parts.join('');
        list.querySelectorAll('img.gg-desc-history-avatar').forEach(image => {
            image.addEventListener('error', () => image.remove(), { once: true });
        });
    }

    _characterCardHtml({ key, record, character }, { currentKey, orphan = false }) {
        const name = character?.name || record.name || key;
        const initial = escapeHtml((name || '?').charAt(0).toUpperCase());
        const entries = [...record.entries].reverse();
        const canEditDescription = Boolean(document.getElementById('description_textarea'));
        const canRevert = !orphan && key === currentKey && canEditDescription;
        const canCompare = !orphan && key === currentKey && canEditDescription && Boolean(this.allState?.onCompare);
        const avatar = orphan
            ? `<span class="gg-desc-history-avatar-fallback">${initial}</span>`
            : `<div class="gg-desc-history-avatar-wrap">
                    <span class="gg-desc-history-avatar-fallback">${initial}</span>
                    <img class="gg-desc-history-avatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(key)}" alt="" loading="lazy">
               </div>`;

        return `
            <section class="gg-desc-history-char-card${orphan ? ' is-orphan' : ''}">
                <header class="gg-desc-history-char-head">
                    ${avatar}
                    <div class="gg-desc-history-char-copy">
                        <div class="gg-desc-history-char-name">
                            ${escapeHtml(name)}
                            ${orphan ? '<span class="gg-desc-history-orphan-badge">orphaned</span>' : ''}
                            ${key === currentKey && !orphan ? '<span class="gg-desc-history-orphan-badge" style="color:var(--SmartThemeQuoteColor);background:color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);">current</span>' : ''}
                        </div>
                        <div class="gg-desc-history-char-meta">
                            ${entries.length} snapshot(s)${orphan ? ` - key: ${escapeHtml(key)}` : ''}
                        </div>
                    </div>
                    <button type="button" class="gg-button gg-button-quiet gg-desc-history-danger" data-history-action="clear-character" data-key="${escapeHtml(key)}">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        <span>Delete all</span>
                    </button>
                </header>
                <div class="gg-desc-history-list">
                    ${entries.map((entry, index) => this._entryHtml(entry, { key, canRevert, canCompare, latest: index === 0 })).join('')}
                </div>
            </section>
        `;
    }

    _handleAllAction(event) {
        const button = event.target.closest('[data-history-action]');
        if (!button) return;
        const action = button.dataset.historyAction;

        if (action === 'refresh') {
            this.renderAll();
            return;
        }
        if (action === 'clean-orphans') {
            const characters = getContext()?.characters;
            const force = Array.isArray(characters) && characters.length === 0;
            if (force && !confirm('The character list is empty. Delete ALL stored revert history? This cannot be undone.')) return;
            const result = this.pruneOrphans('manual', { force });
            if (result.skipped) notify('warning', 'Character list is not ready; try again in a moment.');
            else if (result.removed) notify('success', `Removed ${result.removed} orphaned record(s).`);
            else notify('info', 'No orphaned history found.');
            this.renderAll();
            return;
        }

        const key = button.dataset.key;
        const entryId = button.dataset.entryId;
        if (action === 'clear-character') {
            const record = this.store?.characters?.[key];
            if (!record) return;
            const name = record.name || key;
            if (!confirm(`Delete all ${record.entries.length} snapshot(s) for "${name}"? This cannot be undone.`)) return;
            this.clearCharacter(key);
            notify('info', `Deleted revert history for "${name}".`);
            return;
        }
        if (action === 'delete-entry') {
            if (this.deleteEntry(key, entryId)) notify('info', 'Snapshot deleted.');
            return;
        }
        if (action === 'compare') {
            const currentCharacter = this.allState?.getCurrentCharacter?.() ?? null;
            const currentKey = getCharacterKey(currentCharacter);
            if (key !== currentKey) {
                notify('warning', 'Open this character in the Character Editor to compare its history.');
                return;
            }
            const entry = this.getEntries(key).find(item => item.id === entryId);
            if (!entry) return;
            if (!this.allState?.onCompare) {
                notify('warning', 'Compare is unavailable. Open the Character Editor and try again.');
                return;
            }
            this.allState.onCompare({ entry, key, character: currentCharacter });
            return;
        }
        if (action === 'revert') {
            const currentKey = getCharacterKey(this.allState?.getCurrentCharacter?.() ?? null);
            if (key !== currentKey) {
                notify('warning', 'Open this character in the Character Editor to revert its history.');
                return;
            }
            const entry = this.getEntries(key).find(item => item.id === entryId);
            if (!entry) return;
            const applied = this.allState?.onRevert?.(entry.value);
            if (applied === true) notify('success', 'Description reverted.');
            else if (applied === null) notify('info', 'The description already matches this snapshot.');
            else notify('warning', 'Could not revert. Open the Character Editor and try again.');
        }
    }

    handleCharacterDeleted(data) {
        const context = getContext();
        const character = data?.character;
        const avatar = character?.avatar
            || (data?.id !== undefined ? context?.characters?.[data.id]?.avatar : null);
        if (!avatar || !this.store?.characters?.[avatar]) return;
        delete this.store.characters[avatar];
        persistStore(this.store);
        this.refreshOpenViews();
        notify('info', `Removed revert history for deleted character "${character?.name || avatar}".`);
        debugLog(`[EditDescriptionHistory] Removed history for deleted character ${avatar}.`);
    }

    handleCharacterRenamed(oldAvatar, newAvatar) {
        if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
        const record = this.store?.characters?.[oldAvatar];
        if (!record) return;
        const context = getContext();
        const renamed = context?.characters?.find(character => character?.avatar === newAvatar);
        const existing = this.store.characters[newAvatar];
        if (existing) {
            existing.entries = [...existing.entries, ...record.entries]
                .sort((a, b) => a.ts - b.ts)
                .slice(-MAX_ENTRIES);
            existing.name = renamed?.name || existing.name || record.name;
        } else {
            this.store.characters[newAvatar] = { ...record, name: renamed?.name || record.name };
        }
        delete this.store.characters[oldAvatar];
        persistStore(this.store);
        this.refreshOpenViews();
    }

    handleCharacterEdited(data) {
        const character = data?.character || data?.detail?.character;
        const avatar = character?.avatar;
        if (!avatar) return;
        const record = this.store?.characters?.[avatar];
        if (!record || !character?.name || record.name === character.name) return;
        record.name = character.name;
        persistStore(this.store);
        this.refreshOpenViews();
    }

    pruneOrphans(reason = 'manual', { force = false } = {}) {
        const characters = getContext()?.characters;
        if (!Array.isArray(characters) || (!characters.length && !force)) {
            debugLog('[EditDescriptionHistory] Orphan prune skipped: character list is not ready.');
            return { skipped: true, removed: 0 };
        }
        const validAvatars = new Set(characters.map(character => character?.avatar).filter(Boolean));
        if (characters.length && !validAvatars.size) return { skipped: true, removed: 0 };

        let removed = 0;
        for (const key of Object.keys(this.store?.characters || {})) {
            if (!validAvatars.has(key)) {
                delete this.store.characters[key];
                removed += 1;
            }
        }
        if (removed) {
            persistStore(this.store);
            this.refreshOpenViews();
            notify('info', `Removed revert history for ${removed} deleted character${removed === 1 ? '' : 's'}.`);
            debugLog(`[EditDescriptionHistory] Pruned ${removed} orphaned record(s) (${reason}).`);
        }
        return { skipped: false, removed };
    }

    refreshOpenViews() {
        if (isElementVisible(this.panelRoot)) this.renderCurrent();
        if (isElementVisible(this.allPopup)) this.renderAll();
    }
}

const descriptionHistory = new DescriptionHistory();

export default descriptionHistory;