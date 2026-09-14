import { DRAG_CANCEL_THRESHOLD, UB_BUTTON_ATTR } from './constants.js';
import { cycleTabState, deriveTabState, getAvailableStates, applyTabState } from './engine.js';
import { getUbSettings } from './store.js';
import {
    compactMessageToolbar,
    getDisplayedMessageIds,
    getEventBus,
    getPopupApi,
    getStContext,
    removeOwnedMessageButtons,
    resolveMessageToolbar,
    restoreCompactedMessageToolbars,
} from './sillyTavernAdapter.js';

const STYLE_ID = 'gg-native-ub-toolbar-style';
const FIRST_MESSAGE_ATTR = 'data-gg-native-ub-first-message';
const EDIT_PROXY_ATTR = 'data-gg-native-ub-edit-proxy';

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .gg-native-ub-button {
            position: relative;
            display: inline-flex !important;
            align-items: center;
            gap: 4px;
            min-width: 40px;
            padding-inline: 6px !important;
            border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 38%, var(--SmartThemeBorderColor));
            border-radius: 6px;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 8%, transparent);
        }
        .gg-native-ub-button:hover { background: color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent); }
        .gg-native-ub-button .gg-native-ub-badge { font-size: 10px; font-weight: 750; line-height: 1; }
        .gg-native-ub-button.gg-native-ub-disabled { opacity: .42; pointer-events: none; }
        .gg-native-ub-button.gg-native-ub-error { border-color: rgba(239,68,68,.55); }
        .gg-native-ub-button.gg-native-ub-error .gg-native-ub-badge { color: #ff7676; }
        .gg-native-ub-first-message { display: inline-flex !important; align-items: center; gap: 3px; }
        .gg-native-ub-first-message .gg-native-ub-badge { font-size: 10px; font-weight: 750; line-height: 1; }
        .gg-native-ub-menu-edit { display: inline-flex !important; align-items: center; }

        .gg-native-ub-state-list { display:flex; flex-direction:column; gap:6px; min-width:260px; max-height:min(70vh,560px); overflow-y:auto; }
        .gg-native-ub-state-btn { width:100%; text-align:left; }
        .gg-native-ub-state-btn.active { outline:1px solid var(--SmartThemeQuoteColor); }
        .gg-native-ub-state-note { opacity:.7; font-size:11px; margin-left:6px; }
    `;
    document.head.appendChild(style);
}

function toast(type, message) {
    const api = globalThis.toastr;
    if (api?.[type]) api[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[GG Native UB] ${message}`);
}

function stateDisplay(tab, derived, lastValid) {
    if (derived.state === 'MISSING') return 'MISS';
    if (derived.state === 'UNAVAILABLE') return 'N/A';
    if (derived.state === 'E') return lastValid ?? (tab.isDefault ? 'UB' : 'OFF');
    return derived.state;
}

function getRawMessageText(messageId) {
    const context = getStContext();
    const numericId = Number(messageId);
    if (Number.isInteger(numericId) && numericId >= 0) {
        const raw = context.chat?.[numericId]?.mes;
        if (typeof raw === 'string') return raw;
    }
    return '';
}

function replaceFirstMessageFromMessage(messageId) {
    const text = getRawMessageText(messageId);
    if (!text) {
        toast('warning', 'This message has no raw text to copy.');
        return false;
    }

    const textarea = document.getElementById('firstmessage_textarea');
    if (!(textarea instanceof HTMLTextAreaElement) && !(textarea instanceof HTMLInputElement)) {
        toast('warning', 'Open the Character Creator/editor first.');
        return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value');
    if (descriptor?.set) descriptor.set.call(textarea, text);
    else textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    toast('success', 'First Message replaced from this message.');
    return true;
}

export class MessageToolbarController {
    constructor() {
        this.generating = false;
        this.applying = false;
        this.lastValidStates = new Map();
        this.listeners = [];
        this.active = false;
    }

    init() {
        if (this.active) return;
        this.active = true;
        ensureStyles();
        const { eventSource, eventTypes } = getEventBus();

        const listen = (event, fn) => {
            if (!event) return;
            eventSource.on(event, fn);
            this.listeners.push([event, fn]);
        };

        const renderOne = id => {
            const renderAndSync = () => {
                this.renderMessage(id);
                this.syncBadges();
            };
            renderAndSync();
            requestAnimationFrame(renderAndSync);
        };
        listen(eventTypes.USER_MESSAGE_RENDERED, renderOne);
        listen(eventTypes.CHARACTER_MESSAGE_RENDERED, renderOne);
        listen(eventTypes.MORE_MESSAGES_LOADED, () => this.renderAll());
        listen(eventTypes.CHAT_CHANGED, () => queueMicrotask(() => this.renderAll()));

        // SillyTavern emits GENERATION_STARTED for dry runs as well. Core ST
        // listeners explicitly ignore the third `isDryRun` argument. If we do
        // not, a dry run can leave the toolbar permanently locked because it
        // does not necessarily have a matching user-visible generation end.
        listen(eventTypes.GENERATION_STARTED, (_type, _params, isDryRun) => {
            if (isDryRun) return;
            this.generating = true;
            this.syncDisabledState();
        });
        const generationEnded = () => {
            this.generating = false;
            this.syncDisabledState();
            this.syncBadges();
        };
        listen(eventTypes.GENERATION_STOPPED, generationEnded);
        listen(eventTypes.GENERATION_ENDED, generationEnded);

        // These are high-frequency/global SillyTavern events. Rebuilding every
        // visible message toolbar here used to destroy and recreate all UB DOM
        // controls on unrelated settings saves. UB's own config already calls
        // controller.refresh() when its structure changes, so global events only
        // need to refresh derived badge/disabled state.
        const syncStateOnly = () => this.syncBadges();
        listen(eventTypes.SETTINGS_UPDATED, syncStateOnly);
        listen(eventTypes.OAI_PRESET_CHANGED_AFTER, syncStateOnly);
        listen(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, syncStateOnly);
        listen(eventTypes.CHATCOMPLETION_MODEL_CHANGED, syncStateOnly);

        this.renderAll();
        requestAnimationFrame(() => this.renderAll());
    }

    destroy() {
        if (!this.active) return;
        const { eventSource } = getEventBus();
        for (const [event, fn] of this.listeners) eventSource.removeListener(event, fn);
        this.listeners = [];
        this.active = false;
        removeOwnedMessageButtons();
        restoreCompactedMessageToolbars();
    }

    refresh() {
        removeOwnedMessageButtons();
        restoreCompactedMessageToolbars();
        this.renderAll();
    }

    renderAll() {
        const settings = getUbSettings();
        if (!settings.enabled || !settings.toolbar.enabled) {
            removeOwnedMessageButtons();
            restoreCompactedMessageToolbars();
            return;
        }

        for (const id of getDisplayedMessageIds()) this.renderMessage(id, settings);
        this.syncBadges(settings);
    }

    renderMessage(messageId, cachedSettings = null) {
        const settings = cachedSettings ?? getUbSettings();
        if (!settings.enabled || !settings.toolbar.enabled) return;

        const host = compactMessageToolbar(messageId) ?? resolveMessageToolbar(messageId);
        if (!host) return;
        const stableMessageId = host.closest('.mes')?.getAttribute('mesid') ?? messageId;

        // All Native UB-owned message controls use UB_BUTTON_ATTR so refresh,
        // disable and teardown remain deterministic. This includes F + Edit proxy.
        host.querySelectorAll(`[${UB_BUTTON_ATTR}]`).forEach(element => element.remove());

        const tabs = settings.tabs.filter(tab => tab.enabled);
        [...tabs].reverse().forEach(tab => {
            const button = this.createButton(tab, settings.toolbar.longPressMs);
            host.prepend(button);
        });

        this.addActionMenuButtons(stableMessageId, host);
    }

    addActionMenuButtons(messageId, host) {
        const extraButtons = host.querySelector('.extraMesButtons');
        if (!extraButtons) return;

        const firstMessageButton = document.createElement('div');
        firstMessageButton.className = 'mes_button st-btn-custom interactable gg-native-ub-first-message';
        firstMessageButton.setAttribute(UB_BUTTON_ATTR, 'true');
        firstMessageButton.setAttribute(FIRST_MESSAGE_ATTR, 'true');
        firstMessageButton.title = 'Replace First Message with this message';
        firstMessageButton.innerHTML = '<i class="fa-solid fa-quote-left"></i><span class="gg-native-ub-badge">F</span>';
        firstMessageButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            replaceFirstMessageFromMessage(messageId);
        });
        extraButtons.prepend(firstMessageButton);

        // Keep SillyTavern's real .mes_edit node in its native location (hidden by
        // compactMessageToolbar) and forward through a proxy in the ellipsis menu.
        // This avoids reparenting native DOM that ST or other extensions may query.
        const nativeEdit = host.querySelector('.mes_edit');
        if (!nativeEdit || nativeEdit.hasAttribute(UB_BUTTON_ATTR)) return;

        const editProxy = document.createElement('div');
        editProxy.className = 'mes_button st-btn-custom interactable gg-native-ub-menu-edit fa-solid fa-pencil';
        editProxy.setAttribute(UB_BUTTON_ATTR, 'true');
        editProxy.setAttribute(EDIT_PROXY_ATTR, 'true');
        editProxy.title = nativeEdit.getAttribute('title') || 'Edit';
        editProxy.setAttribute('aria-label', 'Edit');
        editProxy.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            nativeEdit.click();
        });
        extraButtons.append(editProxy);
    }

    createButton(tab, longPressMs) {
        const button = document.createElement('div');
        button.className = 'mes_button st-btn-custom interactable gg-native-ub-button';
        button.setAttribute(UB_BUTTON_ATTR, 'true');
        button.dataset.ggUbTabId = tab.id;
        button.title = `${tab.name}: click to cycle, hold to choose state`;
        button.innerHTML = `<i class="fa-solid ${tab.isDefault ? 'fa-bolt' : 'fa-layer-group'}"></i><span class="gg-native-ub-badge"></span>`;

        let timer = null;
        let holdFired = false;
        let startX = 0;
        let startY = 0;
        const cancelHold = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };

        button.addEventListener('pointerdown', event => {
            if (this.generating || this.applying) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            holdFired = false;
            startX = event.clientX;
            startY = event.clientY;
            timer = setTimeout(() => {
                holdFired = true;
                timer = null;
                this.showStatePicker(tab.id);
            }, longPressMs);
        });
        button.addEventListener('pointermove', event => {
            if (!timer) return;
            if (Math.abs(event.clientX - startX) > DRAG_CANCEL_THRESHOLD || Math.abs(event.clientY - startY) > DRAG_CANCEL_THRESHOLD) cancelHold();
        });
        button.addEventListener('pointerup', cancelHold);
        button.addEventListener('pointercancel', cancelHold);
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            if (this.generating || this.applying) return;
            if (holdFired) {
                holdFired = false;
                return;
            }
            await this.cycle(tab.id);
        });
        return button;
    }

    findTab(tabId) {
        return getUbSettings().tabs.find(tab => tab.id === tabId) ?? null;
    }

    async cycle(tabId) {
        const tab = this.findTab(tabId);
        if (!tab || this.applying) return;
        this.applying = true;
        this.syncDisabledState();
        try {
            const result = await cycleTabState(tab, this.lastValidStates.get(tabId));
            if (result?.state) this.lastValidStates.set(tabId, result.state);
        } catch (error) {
            this.handleApplyError(tab, error);
        } finally {
            this.applying = false;
            this.syncDisabledState();
            this.syncBadges();
        }
    }

    async apply(tabId, state) {
        const tab = this.findTab(tabId);
        if (!tab || this.applying) return;
        this.applying = true;
        this.syncDisabledState();
        try {
            await applyTabState(tab, state);
            this.lastValidStates.set(tabId, state);
        } catch (error) {
            this.handleApplyError(tab, error);
        } finally {
            this.applying = false;
            this.syncDisabledState();
            this.syncBadges();
        }
    }

    handleApplyError(tab, error) {
        console.error('[GG Native UB] Failed to apply state:', tab?.id, error);
        if (error?.code === 'GG_UB_MISSING_PROMPTS') toast('error', `${tab.name}: configured prompt is missing from the active preset.`);
        else toast('error', `${tab?.name ?? 'UB'}: ${error?.message ?? 'Could not change state.'}`);
        this.syncBadges();
    }

    syncDisabledState() {
        document.querySelectorAll(`[${UB_BUTTON_ATTR}][data-gg-ub-tab-id]`).forEach(button => {
            button.classList.toggle('gg-native-ub-disabled', this.generating || this.applying);
        });
    }

    syncBadges(cachedSettings = null) {
        const settings = cachedSettings ?? getUbSettings();
        if (!settings.enabled) return;
        for (const tab of settings.tabs.filter(tab => tab.enabled)) {
            const derived = deriveTabState(tab);
            if (!['E', 'MISSING', 'UNAVAILABLE'].includes(derived.state)) this.lastValidStates.set(tab.id, derived.state);
            const display = stateDisplay(tab, derived, this.lastValidStates.get(tab.id));
            document.querySelectorAll(`[${UB_BUTTON_ATTR}][data-gg-ub-tab-id="${CSS.escape(tab.id)}"]`).forEach(button => {
                const badge = button.querySelector('.gg-native-ub-badge');
                if (badge) badge.textContent = display;
                button.classList.toggle('gg-native-ub-error', ['MISSING', 'UNAVAILABLE'].includes(derived.state));
                button.classList.toggle('gg-native-ub-disabled', this.generating || this.applying);
                button.title = derived.state === 'MISSING'
                    ? `${tab.name}: one or more configured prompts are missing`
                    : `${tab.name}: ${derived.state} — click to cycle, hold to choose state`;
            });
        }
    }

    async showStatePicker(tabId) {
        const tab = this.findTab(tabId);
        if (!tab) return;
        const { Popup, POPUP_TYPE, POPUP_RESULT } = getPopupApi();
        if (!Popup || !POPUP_TYPE) return;

        const current = deriveTabState(tab).state;
        const root = document.createElement('div');
        root.className = 'gg-native-ub-state-list';
        let popup;
        for (const state of getAvailableStates(tab)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `menu_button gg-native-ub-state-btn ${state === current ? 'active' : ''}`;
            const blockIndex = tab.isDefault && state.startsWith('HJB')
                ? Number(state.slice(3)) - 1
                : (!tab.isDefault && state.startsWith(tab.name) ? Number(state.slice(tab.name.length)) - 1 : -1);
            const block = blockIndex >= 0 ? tab.blocks[blockIndex] : null;
            const groupTag = block?.promptRefs?.length > 1 ? ' [GROUP]' : '';
            button.textContent = block ? `${state}${groupTag} — ${block.name}` : state;
            button.addEventListener('click', async () => {
                await this.apply(tab.id, state);
                if (popup?.complete) await popup.complete(POPUP_RESULT?.AFFIRMATIVE ?? 1);
            });
            root.appendChild(button);
        }

        popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide:false, allowVerticalScrolling:true });
        await popup.show();
    }
}
