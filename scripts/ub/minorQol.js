import { getContext } from '../../../../../extensions.js';
import { GG_EXTENSION_NAME, UB_SETTINGS_ANCHOR_ID } from './constants.js';
import { peekUbSettings } from './store.js';

const QOL_SETTINGS_KEY = 'nativeUbQol';
const STYLE_ID = 'gg-native-ub-qol-style';
const CONTROL_ATTR = 'data-gg-native-ub-qol-control';
const POPUP_WAIT_MS = 2500;

const DEFAULTS = Object.freeze({
    autoConfirmNewChat: false,
    autoConfirmDeleteCharacter: false,
});

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
    }
    return value == null ? fallback : Boolean(value);
}

function normalize(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return {
        autoConfirmNewChat: toBoolean(source.autoConfirmNewChat, DEFAULTS.autoConfirmNewChat),
        autoConfirmDeleteCharacter: toBoolean(source.autoConfirmDeleteCharacter, DEFAULTS.autoConfirmDeleteCharacter),
    };
}

function getExtensionRoot() {
    const context = getContext();
    const root = context.extensionSettings;
    root[GG_EXTENSION_NAME] ??= {};
    return { context, extensionRoot: root[GG_EXTENSION_NAME] };
}

export function getMinorQolSettings() {
    const { extensionRoot } = getExtensionRoot();
    const normalized = normalize(extensionRoot[QOL_SETTINGS_KEY]);
    extensionRoot[QOL_SETTINGS_KEY] = normalized;
    return clone(normalized);
}

export function saveMinorQolSettings(nextSettings) {
    const { context, extensionRoot } = getExtensionRoot();
    const normalized = normalize(nextSettings);
    extensionRoot[QOL_SETTINGS_KEY] = normalized;
    context.saveSettingsDebounced();
    return clone(normalized);
}

function isMasterEnabled() {
    try {
        return Boolean(peekUbSettings().enabled);
    } catch (error) {
        console.warn('[GG Native UB] Could not read UB master state for QOL guard.', error);
        return false;
    }
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-qol-toggle {
            min-height: 32px;
        }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-qol-toggle.gg-native-ub-qol-danger {
            border-color: color-mix(in srgb, #ff7676 35%, var(--SmartThemeBorderColor));
        }
        @media (pointer: coarse) {
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions .gg-ub-inline-toggle,
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions .menu_button {
                min-height: 40px;
            }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions input[type="checkbox"] {
                width: 20px;
                height: 20px;
            }
        }
        @media (max-width: 520px) {
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions {
                width: 100%;
                display: grid;
                grid-template-columns: 1fr;
                gap: 7px;
            }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions .gg-ub-inline-toggle,
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions .menu_button {
                width: 100%;
                min-height: 42px;
            }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions .gg-ub-inline-toggle {
                justify-content: space-between;
            }
        }
    `;
    document.head.appendChild(style);
}

function isPopupOpen(popup) {
    if (!(popup instanceof HTMLElement)) return false;
    if ('open' in popup) return Boolean(popup.open);
    return popup.hasAttribute('open') || popup.style.display !== 'none';
}

function findActivePopupCheckbox(id) {
    const escaped = CSS.escape(id);
    for (const checkbox of document.querySelectorAll(`#${escaped}`)) {
        if (!(checkbox instanceof HTMLInputElement)) continue;
        const popup = checkbox.closest('.popup');
        if (isPopupOpen(popup)) return checkbox;
    }
    return null;
}

function waitForActivePopupCheckbox(id, signal, timeoutMs = POPUP_WAIT_MS) {
    if (signal?.aborted) return Promise.resolve(null);
    const immediate = findActivePopupCheckbox(id);
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
        let timer = null;
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const observer = new MutationObserver(() => {
            const checkbox = findActivePopupCheckbox(id);
            if (checkbox) finish(checkbox);
        });
        const onAbort = () => finish(null);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['open'],
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(null), timeoutMs);
    });
}

function setChecked(input, checked) {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.checked === checked) return;
    input.checked = checked;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function createToggle(labelText, title, className = '') {
    const label = document.createElement('label');
    label.className = `gg-ub-inline-toggle gg-native-ub-qol-toggle ${className}`.trim();
    label.setAttribute(CONTROL_ATTR, 'true');
    label.title = title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    return { label, input };
}

export class MinorQolController {
    constructor() {
        this.active = false;
        this.settings = clone(DEFAULTS);
        this.pending = new Map();
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
    }

    init() {
        if (this.active) return;
        this.settings = getMinorQolSettings();
        this.active = true;
        document.body.addEventListener('click', this.handleDocumentClick, true);
        ensureStyles();
    }

    destroy() {
        if (!this.active) return;
        document.body.removeEventListener('click', this.handleDocumentClick, true);
        for (const controller of this.pending.values()) controller.abort();
        this.pending.clear();
        this.active = false;
        document.querySelectorAll(`[${CONTROL_ATTR}]`).forEach(element => element.remove());
        document.getElementById(STYLE_ID)?.remove();
    }

    isSettingActive(settingKey) {
        return Boolean(this.active && isMasterEnabled() && this.settings?.[settingKey]);
    }

    setSetting(settingKey, enabled) {
        this.settings[settingKey] = Boolean(enabled);
        saveMinorQolSettings(this.settings);
        if (!enabled) {
            this.pending.get(settingKey)?.abort();
            this.pending.delete(settingKey);
        }
    }

    handleDocumentClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !isMasterEnabled()) return;

        const newChatTrigger = target.closest('#option_start_new_chat');
        const deleteCharacterTrigger = target.closest('#delete_button');
        if (!newChatTrigger && !deleteCharacterTrigger) return;

        if (newChatTrigger && this.isSettingActive('autoConfirmNewChat')) {
            void this.autoTickAndConfirm('del_chat_checkbox', 'autoConfirmNewChat');
            return;
        }

        if (deleteCharacterTrigger && this.isSettingActive('autoConfirmDeleteCharacter')) {
            void this.autoTickAndConfirm('del_char_checkbox', 'autoConfirmDeleteCharacter');
        }
    }

    async autoTickAndConfirm(checkboxId, settingKey) {
        if (!this.isSettingActive(settingKey) || this.pending.has(settingKey)) return;

        const abortController = new AbortController();
        this.pending.set(settingKey, abortController);
        let checkbox = null;
        let wasChecked = null;
        try {
            checkbox = await waitForActivePopupCheckbox(checkboxId, abortController.signal);
            if (!checkbox || !this.isSettingActive(settingKey)) return;

            const popup = checkbox.closest('.popup');
            if (!isPopupOpen(popup)) return;

            wasChecked = checkbox.checked;
            setChecked(checkbox, true);
            await nextFrame();

            if (!this.isSettingActive(settingKey) || abortController.signal.aborted || !isPopupOpen(popup)) {
                if (wasChecked !== null) setChecked(checkbox, wasChecked);
                return;
            }

            const confirmButton = popup.querySelector('.popup-button-ok');
            if (!(confirmButton instanceof HTMLElement)) return;
            if (confirmButton.matches(':disabled, [aria-disabled="true"]')) return;
            confirmButton.click();
        } finally {
            if (this.pending.get(settingKey) === abortController) this.pending.delete(settingKey);
        }
    }

    ensureSettingsControls() {
        ensureStyles();
        const section = document.getElementById(UB_SETTINGS_ANCHOR_ID);
        const actions = section?.querySelector('.gg-native-ub-card-actions');
        if (!actions) return false;

        const existingNewChat = actions.querySelector('.gg-native-ub-auto-new-chat');
        const existingDelete = actions.querySelector('.gg-native-ub-auto-delete-char');
        if (existingNewChat && existingDelete) {
            existingNewChat.checked = this.settings.autoConfirmNewChat;
            existingDelete.checked = this.settings.autoConfirmDeleteCharacter;
            return true;
        }

        actions.querySelectorAll(`[${CONTROL_ATTR}]`).forEach(element => element.remove());
        const configureButton = actions.querySelector('.gg-native-ub-configure');

        const newChat = createToggle(
            'Auto Xác Nhận Tạo Chat',
            'Chỉ hoạt động khi Native UB Enabled đang bật. Tự tick “Also delete the current chat file” rồi bấm Yes/OK khi tạo chat mới.',
        );
        newChat.input.className = 'gg-native-ub-auto-new-chat';
        newChat.input.checked = this.settings.autoConfirmNewChat;
        newChat.input.addEventListener('change', () => {
            this.setSetting('autoConfirmNewChat', newChat.input.checked);
        });

        const deleteCharacter = createToggle(
            'Auto Xác Nhận Xóa NV',
            'Chỉ hoạt động khi Native UB Enabled đang bật. Tự tick “Also delete the chat files” rồi bấm Yes/OK khi xóa nhân vật. Đây là thao tác xóa vĩnh viễn.',
            'gg-native-ub-qol-danger',
        );
        deleteCharacter.input.className = 'gg-native-ub-auto-delete-char';
        deleteCharacter.input.checked = this.settings.autoConfirmDeleteCharacter;
        deleteCharacter.input.addEventListener('change', () => {
            this.setSetting('autoConfirmDeleteCharacter', deleteCharacter.input.checked);
        });

        if (configureButton) {
            actions.insertBefore(newChat.label, configureButton);
            actions.insertBefore(deleteCharacter.label, configureButton);
        } else {
            actions.append(newChat.label, deleteCharacter.label);
        }
        return true;
    }
}
