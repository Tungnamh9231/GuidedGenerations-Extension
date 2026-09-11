import { EFFORT_VALUES, UB_SETTINGS_ANCHOR_ID } from './constants.js';
import { getUbSettings, saveUbSettings } from './store.js';
import { getPopupApi, listPromptEntries, isPromptManagerReady } from './sillyTavernAdapter.js';

const STYLE_ID = 'gg-native-ub-config-style';

function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .gg-ub-config-popup {
            width: min(1080px, 96vw) !important;
            max-width: 96vw !important;
        }
        .gg-ub-config-popup .popup-content {
            overflow: hidden;
        }
        .gg-ub-config-popup .popup-controls {
            border-top: 1px solid var(--SmartThemeBorderColor);
            padding-top: 10px;
            margin-top: 10px;
        }

        .gg-ub-config {
            display: flex;
            flex-direction: column;
            gap: 14px;
            width: min(1020px, 92vw);
            max-width: 100%;
            color: var(--SmartThemeBodyColor);
        }
        .gg-ub-config * { box-sizing: border-box; }

        .gg-ub-hero {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            padding: 14px 16px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 12px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 72%, transparent);
        }
        .gg-ub-hero-title {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 0 0 4px;
            font-size: 18px;
            font-weight: 700;
        }
        .gg-ub-hero-title i { opacity: .9; }
        .gg-ub-hero-subtitle {
            margin: 0;
            opacity: .72;
            font-size: 12px;
            line-height: 1.45;
        }
        .gg-ub-statuses {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            flex-wrap: wrap;
        }
        .gg-ub-status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: 28px;
            padding: 4px 9px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 999px;
            background: rgba(127, 127, 127, .10);
            font-size: 11px;
            white-space: nowrap;
        }
        .gg-ub-status-pill.is-ok { border-color: rgba(72, 187, 120, .45); }
        .gg-ub-status-pill.is-warn { border-color: rgba(245, 158, 11, .55); }

        .gg-ub-global-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 10px;
        }
        .gg-ub-control-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            min-height: 62px;
            padding: 10px 12px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 10px;
            background: rgba(127, 127, 127, .055);
        }
        .gg-ub-control-copy { min-width: 0; }
        .gg-ub-control-title {
            display: block;
            font-size: 13px;
            font-weight: 650;
            line-height: 1.3;
        }
        .gg-ub-control-hint {
            display: block;
            margin-top: 3px;
            opacity: .62;
            font-size: 10px;
            line-height: 1.3;
        }
        .gg-ub-control-card input[type="checkbox"] {
            width: 18px;
            height: 18px;
            flex: 0 0 auto;
        }
        .gg-ub-hold-wrap {
            display: flex;
            align-items: center;
            gap: 6px;
            flex: 0 0 auto;
        }
        .gg-ub-hold-wrap input {
            width: 84px;
            text-align: right;
        }
        .gg-ub-unit { opacity: .65; font-size: 11px; }

        .gg-ub-workspace {
            display: grid;
            grid-template-columns: 190px minmax(0, 1fr);
            min-height: 430px;
            max-height: min(66vh, 720px);
            overflow: hidden;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 12px;
            background: rgba(0, 0, 0, .08);
        }
        .gg-ub-sidebar {
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-width: 0;
            padding: 12px;
            border-right: 1px solid var(--SmartThemeBorderColor);
            background: rgba(127, 127, 127, .045);
            overflow: hidden;
        }
        .gg-ub-sidebar-label,
        .gg-ub-section-eyebrow {
            text-transform: uppercase;
            letter-spacing: .08em;
            font-size: 10px;
            font-weight: 700;
            opacity: .58;
        }
        .gg-ub-tabs-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
            overflow-y: auto;
            min-height: 0;
        }
        .gg-ub-config-tab {
            display: flex !important;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            width: 100%;
            min-height: 36px;
            padding: 6px 9px !important;
            text-align: left;
            border: 1px solid transparent !important;
            border-radius: 8px !important;
            background: transparent !important;
        }
        .gg-ub-config-tab:hover { background: rgba(127, 127, 127, .10) !important; }
        .gg-ub-config-tab.active {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 58%, transparent) !important;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 13%, transparent) !important;
        }
        .gg-ub-tab-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 650;
        }
        .gg-ub-tab-count {
            min-width: 22px;
            padding: 2px 6px;
            border-radius: 999px;
            background: rgba(127, 127, 127, .14);
            font-size: 10px;
            text-align: center;
        }
        .gg-ub-new-tab {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 6px;
            padding-top: 10px;
            border-top: 1px solid var(--SmartThemeBorderColor);
        }
        .gg-ub-new-tab input { min-width: 0; width: 100%; }

        .gg-ub-editor {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
        }
        .gg-ub-editor-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            padding: 14px 16px;
            border-bottom: 1px solid var(--SmartThemeBorderColor);
            background: rgba(127, 127, 127, .025);
        }
        .gg-ub-editor-title {
            margin: 3px 0 0;
            font-size: 17px;
            font-weight: 700;
        }
        .gg-ub-editor-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .gg-ub-inline-toggle {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: 32px;
            padding: 4px 8px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 8px;
            font-size: 11px;
            white-space: nowrap;
        }
        .gg-ub-editor-body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 14px 16px 18px;
            min-height: 0;
            overflow-y: auto;
        }

        .gg-ub-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .gg-ub-section-title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .gg-ub-section-title {
            margin: 0;
            font-size: 13px;
            font-weight: 700;
        }
        .gg-ub-section-hint { opacity: .6; font-size: 10px; }

        .gg-ub-add-card {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 8px;
            align-items: center;
            padding: 10px;
            border: 1px dashed var(--SmartThemeBorderColor);
            border-radius: 10px;
            background: rgba(127, 127, 127, .035);
        }
        .gg-ub-add-card select { width: 100%; min-width: 0; }

        .gg-ub-config-blocks {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .gg-ub-config-block {
            display: flex;
            flex-direction: column;
            gap: 9px;
            padding: 11px 12px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 42%, transparent);
        }
        .gg-ub-config-block.is-group {
            border-left: 3px solid var(--SmartThemeQuoteColor);
        }
        .gg-ub-config-block.has-missing {
            border-color: rgba(239, 68, 68, .55);
        }
        .gg-ub-config-block-head {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto auto;
            gap: 10px;
            align-items: center;
        }
        .gg-ub-block-title-wrap {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }
        .gg-ub-block-index {
            display: inline-grid;
            place-items: center;
            width: 26px;
            height: 26px;
            flex: 0 0 26px;
            border-radius: 7px;
            background: rgba(127, 127, 127, .13);
            font-size: 11px;
            font-weight: 750;
        }
        .gg-ub-block-name-wrap { min-width: 0; }
        .gg-ub-block-name {
            display: block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 700;
        }
        .gg-ub-block-meta {
            display: block;
            margin-top: 2px;
            opacity: .58;
            font-size: 10px;
        }
        .gg-ub-effort { min-width: 126px; }
        .gg-ub-block-actions {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .gg-ub-icon-button {
            display: inline-grid !important;
            place-items: center;
            width: 30px;
            min-width: 30px !important;
            height: 30px;
            padding: 0 !important;
            border-radius: 7px !important;
            font-size: 12px;
        }
        .gg-ub-icon-button:disabled { opacity: .28; }
        .gg-ub-icon-button.gg-ub-config-danger:hover {
            background: rgba(239, 68, 68, .14) !important;
        }

        .gg-ub-members {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding-top: 2px;
        }
        .gg-ub-config-ref {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            max-width: 100%;
            min-height: 28px;
            padding: 3px 7px 3px 9px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 999px;
            background: rgba(127, 127, 127, .085);
            font-size: 11px;
        }
        .gg-ub-config-ref.is-missing {
            border-color: rgba(239, 68, 68, .55);
            background: rgba(239, 68, 68, .08);
        }
        .gg-ub-ref-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 280px;
        }
        .gg-ub-member-remove {
            width: 22px;
            min-width: 22px !important;
            height: 22px;
            padding: 0 !important;
            border-radius: 999px !important;
            font-size: 10px;
        }
        .gg-ub-group-add {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 6px;
            padding-top: 8px;
            border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 65%, transparent);
        }
        .gg-ub-group-add select { width: 100%; min-width: 0; }

        .gg-ub-empty {
            display: grid;
            place-items: center;
            gap: 8px;
            min-height: 150px;
            padding: 22px;
            border: 1px dashed var(--SmartThemeBorderColor);
            border-radius: 10px;
            text-align: center;
            opacity: .72;
        }
        .gg-ub-empty i { font-size: 24px; opacity: .65; }
        .gg-ub-empty strong { font-size: 13px; }
        .gg-ub-empty span { max-width: 420px; font-size: 11px; line-height: 1.45; }

        .gg-ub-config-muted { opacity: .68; font-size: 11px; }
        .gg-ub-config-danger { color: #ff7676 !important; }
        .gg-ub-config select,
        .gg-ub-config input[type="text"],
        .gg-ub-config input[type="number"] {
            max-width: 100%;
        }

        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 12px;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 10px;
            background: rgba(127, 127, 127, .05);
        }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-main { min-width: 0; }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-title {
            display: flex;
            align-items: center;
            gap: 7px;
            font-weight: 700;
        }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        @media (max-width: 760px) {
            .gg-ub-config { width: 100%; }
            .gg-ub-hero { flex-direction: column; }
            .gg-ub-statuses { justify-content: flex-start; }
            .gg-ub-global-grid { grid-template-columns: 1fr; }
            .gg-ub-workspace {
                grid-template-columns: 1fr;
                max-height: none;
                overflow: visible;
            }
            .gg-ub-sidebar {
                border-right: 0;
                border-bottom: 1px solid var(--SmartThemeBorderColor);
                overflow: visible;
            }
            .gg-ub-tabs-list {
                flex-direction: row;
                flex-wrap: wrap;
                overflow: visible;
            }
            .gg-ub-config-tab { width: auto; max-width: 180px; }
            .gg-ub-new-tab { max-width: 320px; }
            .gg-ub-editor { overflow: visible; }
            .gg-ub-editor-body { overflow: visible; }
            .gg-ub-config-block-head {
                grid-template-columns: minmax(0, 1fr) auto;
            }
            .gg-ub-effort {
                grid-column: 1 / -1;
                width: 100%;
                min-width: 0;
            }
            .gg-ub-block-actions { grid-column: 2; grid-row: 1; }
        }

        @media (max-width: 520px) {
            .gg-ub-editor-head { flex-direction: column; }
            .gg-ub-editor-actions { justify-content: flex-start; }
            .gg-ub-add-card,
            .gg-ub-group-add { grid-template-columns: 1fr; }
            .gg-ub-add-card .menu_button,
            .gg-ub-group-add .menu_button { width: 100%; }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card {
                align-items: flex-start;
                flex-direction: column;
            }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions { justify-content: flex-start; }
        }
    `;
    document.head.appendChild(style);
}

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function promptRef(prompt) {
    return { identifier: prompt.identifier, nameSnapshot: prompt.name };
}

function allUsedIds(tab) {
    return new Set(tab.blocks.flatMap(block => block.promptRefs.map(ref => ref.identifier)));
}

function createIconButton(icon, title, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button gg-ub-icon-button ${extraClass}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    return button;
}

export async function showUbConfigPopup(onSaved = null) {
    ensureStyles();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = getPopupApi();
    if (!Popup || !POPUP_TYPE) throw new Error('SillyTavern Popup API is unavailable.');

    const draft = clone(getUbSettings());
    let activeTabId = draft.tabs[0]?.id ?? null;
    const root = document.createElement('div');
    root.className = 'gg-ub-config';

    const render = () => {
        root.innerHTML = '';

        const promptManagerReady = isPromptManagerReady();
        const promptList = listPromptEntries();
        const totalBlocks = draft.tabs.reduce((sum, item) => sum + item.blocks.length, 0);

        const hero = document.createElement('div');
        hero.className = 'gg-ub-hero';
        hero.innerHTML = `
            <div>
                <div class="gg-ub-hero-title"><i class="fa-solid fa-bolt"></i><span>Native UB / HJB</span></div>
                <p class="gg-ub-hero-subtitle">Configure message-toolbar states using SillyTavern Prompt Manager identifiers. Changes are staged until you press Save.</p>
            </div>
            <div class="gg-ub-statuses">
                <span class="gg-ub-status-pill ${promptManagerReady ? 'is-ok' : 'is-warn'}">
                    <i class="fa-solid ${promptManagerReady ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                    ${promptManagerReady ? 'Prompt Manager ready' : 'Prompt Manager unavailable'}
                </span>
                <span class="gg-ub-status-pill"><i class="fa-solid fa-layer-group"></i>${draft.tabs.length} tab${draft.tabs.length === 1 ? '' : 's'}</span>
                <span class="gg-ub-status-pill"><i class="fa-solid fa-cubes-stacked"></i>${totalBlocks} block${totalBlocks === 1 ? '' : 's'}</span>
            </div>
        `;
        root.appendChild(hero);

        const globalGrid = document.createElement('div');
        globalGrid.className = 'gg-ub-global-grid';
        globalGrid.innerHTML = `
            <label class="gg-ub-control-card">
                <span class="gg-ub-control-copy">
                    <span class="gg-ub-control-title">Enable Native UB</span>
                    <span class="gg-ub-control-hint">Turns the UB/HJB engine on or off.</span>
                </span>
                <input type="checkbox" data-field="enabled" ${draft.enabled ? 'checked' : ''}>
            </label>
            <label class="gg-ub-control-card">
                <span class="gg-ub-control-copy">
                    <span class="gg-ub-control-title">Message toolbar</span>
                    <span class="gg-ub-control-hint">Show state buttons on each message.</span>
                </span>
                <input type="checkbox" data-field="toolbar" ${draft.toolbar.enabled ? 'checked' : ''}>
            </label>
            <label class="gg-ub-control-card">
                <span class="gg-ub-control-copy">
                    <span class="gg-ub-control-title">Long press</span>
                    <span class="gg-ub-control-hint">Hold duration before the state picker opens.</span>
                </span>
                <span class="gg-ub-hold-wrap">
                    <input class="text_pole" type="number" min="300" max="3000" step="50" data-field="hold" value="${draft.toolbar.longPressMs}">
                    <span class="gg-ub-unit">ms</span>
                </span>
            </label>
        `;
        root.appendChild(globalGrid);

        const workspace = document.createElement('div');
        workspace.className = 'gg-ub-workspace';

        const sidebar = document.createElement('aside');
        sidebar.className = 'gg-ub-sidebar';
        const sidebarLabel = document.createElement('div');
        sidebarLabel.className = 'gg-ub-sidebar-label';
        sidebarLabel.textContent = 'State tabs';
        sidebar.appendChild(sidebarLabel);

        const tabsList = document.createElement('div');
        tabsList.className = 'gg-ub-tabs-list';
        for (const tab of draft.tabs) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `menu_button gg-ub-config-tab ${tab.id === activeTabId ? 'active' : ''}`;
            const tabName = document.createElement('span');
            tabName.className = 'gg-ub-tab-name';
            tabName.textContent = tab.name;
            const tabCount = document.createElement('span');
            tabCount.className = 'gg-ub-tab-count';
            tabCount.textContent = String(tab.blocks.length);
            button.append(tabName, tabCount);
            button.addEventListener('click', () => { activeTabId = tab.id; render(); });
            tabsList.appendChild(button);
        }
        sidebar.appendChild(tabsList);

        const newTab = document.createElement('div');
        newTab.className = 'gg-ub-new-tab';
        const newName = document.createElement('input');
        newName.type = 'text';
        newName.className = 'text_pole';
        newName.placeholder = 'New tab';
        const addTab = document.createElement('button');
        addTab.type = 'button';
        addTab.className = 'menu_button';
        addTab.title = 'Add tab';
        addTab.innerHTML = '<i class="fa-solid fa-plus"></i>';
        const createTab = () => {
            const name = newName.value.trim();
            if (!name) return;
            const tab = {
                id: uid('tab'), name, isDefault: false, enabled: true, changeEffort: true, blocks: [],
            };
            draft.tabs.push(tab);
            activeTabId = tab.id;
            render();
        };
        addTab.addEventListener('click', createTab);
        newName.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                createTab();
            }
        });
        newTab.append(newName, addTab);
        sidebar.appendChild(newTab);
        workspace.appendChild(sidebar);

        const editor = document.createElement('section');
        editor.className = 'gg-ub-editor';
        const tab = draft.tabs.find(item => item.id === activeTabId);

        if (!tab) {
            const emptyEditor = document.createElement('div');
            emptyEditor.className = 'gg-ub-empty';
            emptyEditor.innerHTML = '<i class="fa-solid fa-layer-group"></i><strong>No tab selected</strong><span>Create or select a tab to configure UB states.</span>';
            editor.appendChild(emptyEditor);
            workspace.appendChild(editor);
            root.appendChild(workspace);
            return;
        }

        const editorHead = document.createElement('div');
        editorHead.className = 'gg-ub-editor-head';
        const titleWrap = document.createElement('div');
        titleWrap.innerHTML = `<div class="gg-ub-section-eyebrow">Editing tab</div><div class="gg-ub-editor-title"></div>`;
        titleWrap.querySelector('.gg-ub-editor-title').textContent = tab.name;
        editorHead.appendChild(titleWrap);

        const editorActions = document.createElement('div');
        editorActions.className = 'gg-ub-editor-actions';

        if (!tab.isDefault) {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'text_pole';
            nameInput.value = tab.name;
            nameInput.placeholder = 'Tab name';
            nameInput.style.width = '150px';
            nameInput.addEventListener('change', () => {
                const nextName = nameInput.value.trim();
                if (nextName) tab.name = nextName;
                render();
            });
            editorActions.appendChild(nameInput);
        }

        const visibleLabel = document.createElement('label');
        visibleLabel.className = 'gg-ub-inline-toggle';
        visibleLabel.innerHTML = `<input type="checkbox" ${tab.enabled ? 'checked' : ''}><span>Show button</span>`;
        visibleLabel.querySelector('input').addEventListener('change', event => { tab.enabled = event.target.checked; });
        editorActions.appendChild(visibleLabel);

        const effortLabel = document.createElement('label');
        effortLabel.className = 'gg-ub-inline-toggle';
        effortLabel.innerHTML = `<input type="checkbox" ${tab.changeEffort ? 'checked' : ''}><span>Change effort</span>`;
        effortLabel.querySelector('input').addEventListener('change', event => {
            tab.changeEffort = event.target.checked;
            render();
        });
        editorActions.appendChild(effortLabel);

        if (!tab.isDefault) {
            const removeTab = createIconButton('fa-trash', 'Delete this tab', 'gg-ub-config-danger');
            removeTab.addEventListener('click', () => {
                draft.tabs = draft.tabs.filter(item => item.id !== tab.id);
                activeTabId = draft.tabs[0]?.id ?? null;
                render();
            });
            editorActions.appendChild(removeTab);
        }

        editorHead.appendChild(editorActions);
        editor.appendChild(editorHead);

        const editorBody = document.createElement('div');
        editorBody.className = 'gg-ub-editor-body';

        const addSection = document.createElement('div');
        addSection.className = 'gg-ub-section';
        addSection.innerHTML = `
            <div class="gg-ub-section-title-row">
                <div>
                    <div class="gg-ub-section-eyebrow">Prompt Manager</div>
                    <h3 class="gg-ub-section-title">Add a state block</h3>
                </div>
                <span class="gg-ub-section-hint">Each block becomes one selectable state.</span>
            </div>
        `;

        const used = allUsedIds(tab);
        const available = promptList.filter(prompt => !used.has(prompt.identifier));
        const addCard = document.createElement('div');
        addCard.className = 'gg-ub-add-card';
        const promptSelect = document.createElement('select');
        promptSelect.className = 'text_pole';
        if (available.length) {
            for (const prompt of available) {
                const option = document.createElement('option');
                option.value = prompt.identifier;
                option.textContent = `${prompt.name} · ${prompt.role || 'n/a'}`;
                promptSelect.appendChild(option);
            }
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = promptManagerReady ? 'All available prompts are already used' : 'Prompt Manager is not ready';
            promptSelect.appendChild(option);
        }
        const addBlock = document.createElement('button');
        addBlock.type = 'button';
        addBlock.className = 'menu_button';
        addBlock.innerHTML = '<i class="fa-solid fa-plus"></i> Add block';
        addBlock.disabled = !available.length;
        addBlock.addEventListener('click', () => {
            const prompt = promptList.find(item => item.identifier === promptSelect.value);
            if (!prompt) return;
            tab.blocks.push({
                id: uid('block'),
                name: prompt.name,
                effort: 'min',
                promptRefs: [promptRef(prompt)],
            });
            render();
        });
        addCard.append(promptSelect, addBlock);
        addSection.appendChild(addCard);
        editorBody.appendChild(addSection);

        const blocksSection = document.createElement('div');
        blocksSection.className = 'gg-ub-section';
        const blocksHeader = document.createElement('div');
        blocksHeader.className = 'gg-ub-section-title-row';
        blocksHeader.innerHTML = `
            <div>
                <div class="gg-ub-section-eyebrow">State order</div>
                <h3 class="gg-ub-section-title">Blocks & groups</h3>
            </div>
            <span class="gg-ub-section-hint">Top to bottom = state 1, 2, 3…</span>
        `;
        blocksSection.appendChild(blocksHeader);

        const blocks = document.createElement('div');
        blocks.className = 'gg-ub-config-blocks';

        if (!tab.blocks.length) {
            const empty = document.createElement('div');
            empty.className = 'gg-ub-empty';
            empty.innerHTML = '<i class="fa-solid fa-cubes-stacked"></i><strong>No blocks yet</strong><span>Choose a prompt above and add it as the first state. You can later combine multiple prompts into one group.</span>';
            blocks.appendChild(empty);
        }

        tab.blocks.forEach((block, index) => {
            const existsById = new Map(promptList.map(prompt => [prompt.identifier, prompt]));
            const missingRefs = block.promptRefs.filter(ref => !existsById.has(ref.identifier));
            const card = document.createElement('div');
            card.className = `gg-ub-config-block ${block.promptRefs.length > 1 ? 'is-group' : ''} ${missingRefs.length ? 'has-missing' : ''}`.trim();

            const head = document.createElement('div');
            head.className = 'gg-ub-config-block-head';

            const blockTitleWrap = document.createElement('div');
            blockTitleWrap.className = 'gg-ub-block-title-wrap';
            const indexBadge = document.createElement('span');
            indexBadge.className = 'gg-ub-block-index';
            indexBadge.textContent = String(index + 1);
            const blockNameWrap = document.createElement('div');
            blockNameWrap.className = 'gg-ub-block-name-wrap';
            const blockName = document.createElement('span');
            blockName.className = 'gg-ub-block-name';
            blockName.textContent = block.name;
            const blockMeta = document.createElement('span');
            blockMeta.className = 'gg-ub-block-meta';
            blockMeta.textContent = block.promptRefs.length > 1
                ? `Group · ${block.promptRefs.length} prompts${missingRefs.length ? ` · ${missingRefs.length} missing` : ''}`
                : `Single prompt${missingRefs.length ? ' · missing' : ''}`;
            blockNameWrap.append(blockName, blockMeta);
            blockTitleWrap.append(indexBadge, blockNameWrap);
            head.appendChild(blockTitleWrap);

            if (tab.changeEffort) {
                const effort = document.createElement('select');
                effort.className = 'text_pole gg-ub-effort';
                effort.title = 'Reasoning effort for this state';
                for (const value of EFFORT_VALUES) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = `Effort: ${value}`;
                    option.selected = block.effort === value;
                    effort.appendChild(option);
                }
                effort.addEventListener('change', () => { block.effort = effort.value; });
                head.appendChild(effort);
            } else {
                const effortSpacer = document.createElement('span');
                head.appendChild(effortSpacer);
            }

            const actions = document.createElement('div');
            actions.className = 'gg-ub-block-actions';
            const up = createIconButton('fa-arrow-up', 'Move block up');
            up.disabled = index === 0;
            up.addEventListener('click', () => {
                [tab.blocks[index - 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index - 1]];
                render();
            });
            const down = createIconButton('fa-arrow-down', 'Move block down');
            down.disabled = index === tab.blocks.length - 1;
            down.addEventListener('click', () => {
                [tab.blocks[index + 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index + 1]];
                render();
            });
            const remove = createIconButton('fa-trash', 'Delete block', 'gg-ub-config-danger');
            remove.addEventListener('click', () => { tab.blocks.splice(index, 1); render(); });
            actions.append(up, down, remove);
            head.appendChild(actions);
            card.appendChild(head);

            const members = document.createElement('div');
            members.className = 'gg-ub-members';
            block.promptRefs.forEach((ref, refIndex) => {
                const exists = existsById.has(ref.identifier);
                const pill = document.createElement('span');
                pill.className = `gg-ub-config-ref ${exists ? '' : 'is-missing'}`.trim();
                pill.title = ref.identifier;
                const refName = document.createElement('span');
                refName.className = 'gg-ub-ref-name';
                refName.textContent = `${ref.nameSnapshot}${exists ? '' : ' · missing'}`;
                pill.appendChild(refName);
                if (block.promptRefs.length > 1) {
                    const rm = document.createElement('button');
                    rm.type = 'button';
                    rm.className = 'menu_button gg-ub-member-remove';
                    rm.title = `Remove ${ref.nameSnapshot} from group`;
                    rm.setAttribute('aria-label', rm.title);
                    rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                    rm.addEventListener('click', () => {
                        block.promptRefs.splice(refIndex, 1);
                        block.name = block.promptRefs[0]?.nameSnapshot ?? block.name;
                        if (!block.promptRefs.length) tab.blocks.splice(index, 1);
                        render();
                    });
                    pill.appendChild(rm);
                }
                members.appendChild(pill);
            });
            card.appendChild(members);

            const currentUsed = allUsedIds(tab);
            const unusedForGroup = promptList.filter(prompt => !currentUsed.has(prompt.identifier));
            if (unusedForGroup.length) {
                const groupRow = document.createElement('div');
                groupRow.className = 'gg-ub-group-add';
                const groupSelect = document.createElement('select');
                groupSelect.className = 'text_pole';
                for (const prompt of unusedForGroup) {
                    const option = document.createElement('option');
                    option.value = prompt.identifier;
                    option.textContent = `${prompt.name} · ${prompt.role || 'n/a'}`;
                    groupSelect.appendChild(option);
                }
                const groupAdd = document.createElement('button');
                groupAdd.type = 'button';
                groupAdd.className = 'menu_button';
                groupAdd.innerHTML = '<i class="fa-solid fa-object-group"></i> Add to group';
                groupAdd.addEventListener('click', () => {
                    const prompt = promptList.find(item => item.identifier === groupSelect.value);
                    if (!prompt) return;
                    block.promptRefs.push(promptRef(prompt));
                    render();
                });
                groupRow.append(groupSelect, groupAdd);
                card.appendChild(groupRow);
            }

            blocks.appendChild(card);
        });

        blocksSection.appendChild(blocks);
        editorBody.appendChild(blocksSection);
        editor.appendChild(editorBody);
        workspace.appendChild(editor);
        root.appendChild(workspace);

        root.querySelector('[data-field="enabled"]').addEventListener('change', event => { draft.enabled = event.target.checked; });
        root.querySelector('[data-field="toolbar"]').addEventListener('change', event => { draft.toolbar.enabled = event.target.checked; });
        root.querySelector('[data-field="hold"]').addEventListener('change', event => {
            draft.toolbar.longPressMs = Math.max(300, Math.min(3000, Number(event.target.value) || 1000));
            event.target.value = draft.toolbar.longPressMs;
        });
    };

    render();
    const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save changes',
        cancelButton: 'Cancel',
        wider: true,
        large: true,
        allowVerticalScrolling: true,
    });
    popup.dlg?.classList.add('gg-ub-config-popup');
    const result = await popup.show();
    if (result === (POPUP_RESULT?.AFFIRMATIVE ?? 1)) {
        const saved = saveUbSettings(draft);
        onSaved?.(saved);
        return saved;
    }
    return null;
}

export function ensureUbSettingsEntry(onChanged = null) {
    ensureStyles();
    if (document.getElementById(UB_SETTINGS_ANCHOR_ID)) return true;

    const container = document.querySelector('#extension_settings_GuidedGenerations-Extension .inline-drawer-content')
        || document.querySelector('.GuidedGenerations-Extension-settingslist .inline-drawer-content');
    if (!container) return false;

    const settings = getUbSettings();
    const section = document.createElement('div');
    section.id = UB_SETTINGS_ANCHOR_ID;
    section.className = 'settings_section';
    section.innerHTML = `
        <hr>
        <h4>Native UB Message Toolbar</h4>
        <div class="gg-native-ub-card">
            <div class="gg-native-ub-card-main">
                <div class="gg-native-ub-card-title"><i class="fa-solid fa-bolt"></i> Native UB / HJB</div>
                <small class="setting_item_description">PromptManager-backed states with additive per-message toolbar buttons.</small>
                <div class="gg-native-ub-summary gg-ub-config-muted"></div>
            </div>
            <div class="gg-native-ub-card-actions">
                <label class="gg-ub-inline-toggle"><input type="checkbox" class="gg-native-ub-enable" ${settings.enabled ? 'checked' : ''}><span>Enabled</span></label>
                <button type="button" class="menu_button gg-native-ub-configure"><i class="fa-solid fa-sliders"></i> Configure</button>
            </div>
        </div>
    `;
    container.insertBefore(section, container.firstChild);

    const summary = section.querySelector('.gg-native-ub-summary');
    const refreshSummary = () => {
        const current = getUbSettings();
        const blocks = current.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0);
        summary.textContent = `${current.tabs.length} tab${current.tabs.length === 1 ? '' : 's'} · ${blocks} block/group${blocks === 1 ? '' : 's'} · ${current.toolbar.enabled ? 'toolbar on' : 'toolbar off'}`;
        section.querySelector('.gg-native-ub-enable').checked = current.enabled;
    };
    refreshSummary();

    section.querySelector('.gg-native-ub-enable').addEventListener('change', event => {
        const current = getUbSettings();
        current.enabled = event.target.checked;
        saveUbSettings(current);
        onChanged?.();
        refreshSummary();
    });
    section.querySelector('.gg-native-ub-configure').addEventListener('click', async () => {
        await showUbConfigPopup(() => {
            onChanged?.();
            refreshSummary();
        });
    });

    return true;
}