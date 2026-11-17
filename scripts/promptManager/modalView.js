import { getBlockById, PROMPT_SCOPE } from './registry.js';
import { buildMergedOrder, toStoredOrder } from './order.js';
import { setBlockOrder, getEffectivePromptConfig, readPromptText, isBlockHidden, setBlockHidden, getHiddenBlocks } from './store.js';
import {
    readNativeRows,
    readNativeTotals,
    watchNativeList,
    countTextTokens,
} from './nativeSource.js';
import { openBlockEditor } from './editPopup.js';

const POPUP_ID = 'gg-prompt-manager-popup';
const LIST_ID = 'gg-pm-list';

const ROLE_ICONS = { user: 'fa-user', assistant: 'fa-robot' };

const state = {
    open: false,
    dragging: false,
    stopWatching: null,
    renderSequence: 0,
};

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildRows() {
    const nativeRows = readNativeRows();
    const tokens = buildMergedOrder(nativeRows.map(row => row.id));
    const nativeById = new Map(nativeRows.map(row => [row.id, row]));
    return tokens
        .map(token => token.type === 'native'
            ? (nativeById.has(token.id) ? { kind: 'native', row: nativeById.get(token.id) } : null)
            : ({ kind: 'ext', block: getBlockById(token.id) }))
        .filter(Boolean)
        .filter(item => item.kind !== 'ext' || !isBlockHidden(item.block.id));
}

function roleBadge(role) {
    const icon = ROLE_ICONS[role];
    return icon ? `<i class="fa-solid ${icon} gg-pm-role" title="Role: ${escapeHtml(role)}"></i>` : '';
}

function renderNativeRow(row) {
    return `
        <li class="gg-pm-item gg-pm-item-native${row.enabled ? '' : ' gg-pm-off'}" data-pm-kind="native" data-pm-id="${escapeHtml(row.id)}"
            title="Native prompt — display only, managed in SillyTavern's own Prompt Manager">
            <span class="gg-pm-handle gg-pm-handle-locked" title="Display only"><i class="fa-solid fa-lock"></i></span>
            <span class="gg-pm-name">
                <i class="fa-solid ${row.icon} gg-pm-kind-icon" title="${escapeHtml(row.iconTitle)}"></i>
                <span class="gg-pm-label">${escapeHtml(row.name)}</span>
                ${roleBadge(row.role)}
                ${row.injection ? `<small class="gg-pm-depth" title="In-chat injection depth">@ ${escapeHtml(row.depth)}</small>` : ''}
            </span>
            <span class="gg-pm-controls"></span>
            <span class="gg-pm-tokens" data-pm-tokens>${row.tokens ? row.tokens : '–'}</span>
        </li>
    `;
}

function blockHints(block) {
    const placedPrompts = block.prompts.filter(prompt => !prompt.textOnly);
    if (!placedPrompts.length) return '';
    return placedPrompts.map(prompt => {
        const config = getEffectivePromptConfig(prompt.key);
        const inChat = config.position === 1;
        const detail = inChat
            ? `${prompt.label} — In-chat @ depth ${config.depth} as ${config.role}`
            : `${prompt.label} — Relative order, sent as ${config.role}`;
        return `
            <span class="gg-pm-hint" title="${escapeHtml(detail)}">
                <span class="gg-pm-hint-name">${escapeHtml(prompt.label)}</span>
                <small class="gg-pm-depth">${inChat ? `@ ${config.depth}` : 'rel'}</small>${roleBadge(config.role)}
            </span>
        `;
    }).join('');
}

function blockTooltip(block) {
    return block.prompts.map(prompt => {
        const scope = prompt.textOnly ? 'text' : prompt.scope === PROMPT_SCOPE.CHAT ? 'chat' : 'feature';
        return `${prompt.label} (${scope})`;
    }).join(' · ');
}

function renderExtensionRow(block) {
    const label = block.label;
    const hint = blockHints(block);
    return `
        <li class="gg-pm-item gg-pm-item-ext" data-pm-kind="ext" data-pm-id="${escapeHtml(block.id)}"
            title="${escapeHtml(blockTooltip(block))} — drag to choose where this feature's prompts are sent">
            <span class="gg-pm-handle" title="Drag to move"><i class="fa-solid fa-grip-lines"></i></span>
            <span class="gg-pm-name">
                <i class="fa-solid ${block.icon} gg-pm-kind-icon gg-pm-kind-icon-ext"></i>
                <span class="gg-pm-label">${escapeHtml(label)}</span>
                <small class="gg-pm-badge">${block.prompts.length} prompt${block.prompts.length === 1 ? '' : 's'}</small>
                ${hint}
            </span>
            <span class="gg-pm-controls">
                <span class="gg-pm-control gg-pm-hide" title="Hide this block from the list"><i class="fa-solid fa-eye-slash"></i></span>
                <span class="gg-pm-control gg-pm-edit" title="Edit prompt"><i class="fa-solid fa-pencil"></i></span>
            </span>
            <span class="gg-pm-tokens" data-pm-tokens>–</span>
        </li>
    `;
}

function popupHtml() {
    return `
        <div id="${POPUP_ID}" class="gg-popup gg-pm-popup" style="display: none;" aria-hidden="true">
            <div class="gg-popup-content gg-pm-content">
                <div class="gg-pm-header">
                    <div>
                        <h2><i class="fa-solid fa-list-check"></i> Prompt Manager</h2>
                        <div class="gg-pm-totals">
                            <span>SillyTavern tokens: <b id="gg-pm-native-tokens">–</b></span>
                            <span>Extension tokens: <b id="gg-pm-ext-tokens">–</b></span>
                        </div>
                    </div>
                    <span class="gg-popup-close" id="gg-pm-close" title="Close">&times;</span>
                </div>

                <div class="gg-pm-legend">
                    <span class="gg-pm-legend-item"><i class="fa-solid fa-lock"></i> Native prompt — display only, a one-way mirror of SillyTavern's own Prompt Manager; edit, reorder or disable it there</span>
                    <span class="gg-pm-legend-item gg-pm-legend-ext"><i class="fa-solid fa-grip-lines"></i> Extension prompt — placed by this Prompt Manager: drag it to set where the feature's prompt is sent, the pencil edits its role / position / depth</span>
                    <span class="gg-pm-legend-item"><i class="fa-solid fa-eye-slash"></i> Hides a block from this list without disabling its feature; hidden blocks can be shown again at the bottom</span>
                </div>

                <ul id="${LIST_ID}" class="gg-pm-list"></ul>

                <div class="gg-pm-hidden" id="gg-pm-hidden" style="display: none;">
                    <span class="gg-pm-hidden-label"><i class="fa-solid fa-eye-slash"></i> Hidden blocks</span>
                    <span class="gg-pm-hidden-list" id="gg-pm-hidden-list"></span>
                </div>

                <div class="gg-popup-footer">
                    <button type="button" class="gg-button" id="gg-pm-footer-close">Close</button>
                </div>
            </div>
        </div>
    `;
}

function ensurePopup() {
    let popup = document.getElementById(POPUP_ID);
    if (!popup) {
        const holder = document.createElement('div');
        holder.innerHTML = popupHtml().trim();
        document.body.appendChild(holder.firstElementChild);
        popup = document.getElementById(POPUP_ID);
        popup.addEventListener('mousedown', event => {
            if (event.target === popup) closePromptManagerModal();
        });
        popup.querySelector('#gg-pm-close').addEventListener('click', () => closePromptManagerModal());
        popup.querySelector('#gg-pm-footer-close').addEventListener('click', () => closePromptManagerModal());
        popup.addEventListener('click', handleClick);
        document.addEventListener('keydown', handleKeydown);
    }
    return popup;
}

function handleKeydown(event) {
    if (event.key === 'Escape' && state.open) closePromptManagerModal();
}

function handleClick(event) {
    const show = event.target.closest('[data-pm-show]');
    if (show) {
        setBlockHidden(show.dataset.pmShow, false);
        renderList();
        return;
    }

    const control = event.target.closest('.gg-pm-control');
    if (!control) return;
    const row = event.target.closest('.gg-pm-item');
    if (!row || row.dataset.pmKind !== 'ext') return;

    if (control.classList.contains('gg-pm-edit')) {
        openBlockEditor(row.dataset.pmId, { onChanged: () => refreshPromptManagerModal() });
    } else if (control.classList.contains('gg-pm-hide')) {
        setBlockHidden(row.dataset.pmId, true);
        renderList();
    }
}

function initSortable(list) {
    const jq = window.jQuery ?? window.$;
    if (typeof jq !== 'function' || !jq.fn?.sortable) return;

    if (jq(list).hasClass('ui-sortable')) {
        try { jq(list).sortable('destroy'); } catch (error) { /* not initialised yet */ }
    }

    jq(list).sortable({
        // Every row is a valid drop position so extension blocks can land between
        // native ones; `cancel` only stops native rows from being picked up.
        items: 'li[data-pm-kind]',
        cancel: '.gg-pm-item-native, .gg-pm-control, input, textarea, button, select, option',
        handle: '.gg-pm-handle',
        placeholder: 'gg-pm-placeholder',
        forcePlaceholderSize: true,
        tolerance: 'pointer',
        start: () => { state.dragging = true; },
        stop: () => { state.dragging = false; },
        update: () => {
            const tokens = Array.from(list.children)
                .filter(element => element.matches('li[data-pm-kind]'))
                .map(element => ({ type: element.dataset.pmKind, id: element.dataset.pmId }));
            setBlockOrder(toStoredOrder(tokens));
        },
    });
}

async function fillTokens(list, rows) {
    const sequence = ++state.renderSequence;
    const totals = readNativeTotals();
    const nativeTotal = document.getElementById('gg-pm-native-tokens');
    if (nativeTotal) nativeTotal.textContent = String(totals.tokens || '–');

    let extensionTotal = 0;
    for (const item of rows) {
        if (item.kind !== 'ext') continue;
        let blockTokens = 0;
        for (const prompt of item.block.prompts) {
            const text = await readPromptText(prompt.key);
            blockTokens += await countTextTokens(text);
        }
        if (sequence !== state.renderSequence || !list.isConnected) return;
        extensionTotal += blockTokens;
        const element = list.querySelector(`li[data-pm-kind="ext"][data-pm-id="${item.block.id}"] [data-pm-tokens]`);
        if (element) element.textContent = blockTokens ? String(blockTokens) : '–';
    }

    if (sequence !== state.renderSequence) return;
    const extTotal = document.getElementById('gg-pm-ext-tokens');
    if (extTotal) extTotal.textContent = String(extensionTotal || '–');
}

function renderHiddenPanel() {
    const panel = document.getElementById('gg-pm-hidden');
    const list = document.getElementById('gg-pm-hidden-list');
    if (!panel || !list) return;

    const hiddenBlocks = getHiddenBlocks()
        .map(id => getBlockById(id))
        .filter(Boolean);
    if (!hiddenBlocks.length) {
        panel.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    panel.style.display = 'flex';
    list.innerHTML = hiddenBlocks.map(block => `
        <button type="button" class="gg-pm-hidden-chip" data-pm-show="${escapeHtml(block.id)}" title="Show this block again">
            <i class="fa-solid fa-eye"></i> ${escapeHtml(block.label)}
        </button>
    `).join('');
}

function renderList() {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    const rows = buildRows();
    list.innerHTML = rows
        .map(item => item.kind === 'native' ? renderNativeRow(item.row) : renderExtensionRow(item.block))
        .join('');
    initSortable(list);
    renderHiddenPanel();
    fillTokens(list, rows);
}

export function openPromptManagerModal() {
    const popup = ensurePopup();
    state.open = true;
    popup.style.display = 'flex';
    popup.setAttribute('aria-hidden', 'false');
    renderList();

    if (!state.stopWatching) {
        // Native rows are read live: any change in SillyTavern's Prompt Manager is
        // reflected here immediately.
        state.stopWatching = watchNativeList(() => {
            if (state.open && !state.dragging) renderList();
        });
    }
}

export function closePromptManagerModal() {
    const popup = document.getElementById(POPUP_ID);
    state.open = false;
    if (popup) {
        popup.style.display = 'none';
        popup.setAttribute('aria-hidden', 'true');
    }
    if (state.stopWatching) {
        state.stopWatching();
        state.stopWatching = null;
    }
}

export function refreshPromptManagerModal() {
    if (state.open && !state.dragging) renderList();
}

export function isPromptManagerOpen() {
    return state.open;
}
