import { getContext } from '../../../../../extensions.js';
import { GG_EXTENSION_NAME, UB_SETTINGS_ANCHOR_ID } from './constants.js';

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

function normalize(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return {
        autoConfirmNewChat: Boolean(source.autoConfirmNewChat ?? DEFAULTS.autoConfirmNewChat),
        autoConfirmDeleteCharacter: Boolean(source.autoConfirmDeleteCharacter ?? DEFAULTS.autoConfirmDeleteCharacter),
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

function waitForActivePopupCheckbox(id, timeoutMs = POPUP_WAIT_MS) {
    const immediate = findActivePopupCheckbox(id);
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
        let timer = null;
        const observer = new MutationObserver(() => {
            const checkbox = findActivePopupCheckbox(id);
            if (!checkbox) return;
            cleanup();
            resolve(checkbox);
        });
        const cleanup = () => {
            observer.disconnect();
            if (timer) clearTimeout(timer);
        };
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['open'],
        });
        timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
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
        this.pending = new Set();
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
    }

    init() {
        if (this.active) return;
        this.active = true;
        getMinorQolSettings();
        document.body.addEventListener('click', this.handleDocumentClick, true);
        ensureStyles();
    }

    destroy() {
        if (!this.active) return;
        document.body.removeEventListener('click', this.handleDocumentClick, true);
        this.pending.clear();
        this.active = false;
        document.querySelectorAll(`[${CONTROL_ATTR}]`).forEach(element => element.remove());
        document.getElementById(STYLE_ID)?.remove();
    }

    handleDocumentClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const newChatTrigger = target.closest('#option_start_new_chat');
        const deleteCharacterTrigger = target.closest('#delete_button');
        if (!newChatTrigger && !deleteCharacterTrigger) return;

        const settings = getMinorQolSettings();
        if (newChatTrigger && settings.autoConfirmNewChat) {
            void this.autoTickAndConfirm('del_chat_checkbox', 'autoConfirmNewChat');
            return;
        }

        if (deleteCharacterTrigger && settings.autoConfirmDeleteCharacter) {
            void this.autoTickAndConfirm('del_char_checkbox', 'autoConfirmDeleteCharacter');
        }
    }

    async autoTickAndConfirm(checkboxId, settingKey) {
        if (this.pending.has(checkboxId)) return;
        this.pending.add(checkboxId);
        try {
            const checkbox = await waitForActivePopupCheckbox(checkboxId);
            if (!checkbox) return;
            if (!getMinorQolSettings()[settingKey]) return;

            const popup = checkbox.closest('.popup');
            if (!isPopupOpen(popup)) return;

            // Match the original userscript behavior: tick the destructive-option
            // checkbox first, then confirm the exact popup that owns it.
            setChecked(checkbox, true);
            await nextFrame();
            if (!getMinorQolSettings()[settingKey] || !isPopupOpen(popup)) return;

            const confirmButton = popup.querySelector('.popup-button-ok');
            if (!(confirmButton instanceof HTMLElement)) return;
            if (confirmButton.matches(':disabled, [aria-disabled="true"]')) return;
            confirmButton.click();
        } finally {
            this.pending.delete(checkboxId);
        }
    }

    ensureSettingsControls() {
        ensureStyles();
        const section = document.getElementById(UB_SETTINGS_ANCHOR_ID);
        const actions = section?.querySelector('.gg-native-ub-card-actions');
        if (!actions) return false;

        const current = getMinorQolSettings();
        const existingNewChat = actions.querySelector('.gg-native-ub-auto-new-chat');
        const existingDelete = actions.querySelector('.gg-native-ub-auto-delete-char');
        if (existingNewChat && existingDelete) {
            existingNewChat.checked = current.autoConfirmNewChat;
            existingDelete.checked = current.autoConfirmDeleteCharacter;
            return true;
        }

        actions.querySelectorAll(`[${CONTROL_ATTR}]`).forEach(element => element.remove());
        const configureButton = actions.querySelector('.gg-native-ub-configure');

        const newChat = createToggle(
            'Auto Xác Nhận Tạo Chat',
            'Tự tick “Also delete the current chat file” rồi bấm Yes/OK khi tạo chat mới.',
        );
        newChat.input.className = 'gg-native-ub-auto-new-chat';
        newChat.input.checked = current.autoConfirmNewChat;
        newChat.input.addEventListener('change', () => {
            const settings = getMinorQolSettings();
            settings.autoConfirmNewChat = newChat.input.checked;
            saveMinorQolSettings(settings);
        });

        const deleteCharacter = createToggle(
            'Auto Xác Nhận Xóa NV',
            'Tự tick “Also delete the chat files” rồi bấm Yes/OK khi xóa nhân vật. Đây là thao tác xóa vĩnh viễn.',
            'gg-native-ub-qol-danger',
        );
        deleteCharacter.input.className = 'gg-native-ub-auto-delete-char';
        deleteCharacter.input.checked = current.autoConfirmDeleteCharacter;
        deleteCharacter.input.addEventListener('change', () => {
            const settings = getMinorQolSettings();
            settings.autoConfirmDeleteCharacter = deleteCharacter.input.checked;
            saveMinorQolSettings(settings);
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
