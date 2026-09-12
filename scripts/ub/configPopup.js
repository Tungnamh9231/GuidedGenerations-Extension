import { EFFORT_VALUES, UB_SETTINGS_ANCHOR_ID } from './constants.js';
import { getUbSettings, saveUbSettings } from './store.js';
import { getPopupApi, listPromptEntries, isPromptManagerReady } from './sillyTavernAdapter.js';
import { groupSelectedBlocks, ungroupBlock } from './grouping.js';

const STYLE_ID = 'gg-native-ub-config-style';

function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function normalizePromptSearchText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLocaleLowerCase();
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

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .gg-ub-config-popup { width:min(1080px,96vw)!important; max-width:96vw!important; }
        .gg-ub-config-popup .popup-content { overflow:hidden; }
        .gg-ub-config-popup .popup-controls { border-top:1px solid var(--SmartThemeBorderColor); padding-top:10px; margin-top:10px; }
        .gg-ub-config { display:flex; flex-direction:column; gap:12px; width:min(1020px,92vw); max-width:100%; color:var(--SmartThemeBodyColor); }
        .gg-ub-config * { box-sizing:border-box; }

        .gg-ub-hero { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:12px 14px; border:1px solid var(--SmartThemeBorderColor); border-radius:12px; background:rgba(127,127,127,.045); }
        .gg-ub-hero-title { display:flex; align-items:center; gap:9px; margin:0 0 4px; font-size:17px; font-weight:750; }
        .gg-ub-hero-subtitle { margin:0; opacity:.7; font-size:11px; line-height:1.45; }
        .gg-ub-statuses { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
        .gg-ub-status-pill { display:inline-flex; align-items:center; gap:5px; min-height:26px; padding:3px 8px; border:1px solid var(--SmartThemeBorderColor); border-radius:999px; background:rgba(127,127,127,.08); font-size:10px; white-space:nowrap; }
        .gg-ub-status-pill.is-ok { border-color:rgba(72,187,120,.45); }
        .gg-ub-status-pill.is-warn { border-color:rgba(245,158,11,.55); }

        .gg-ub-global-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
        .gg-ub-control-card { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:58px; padding:9px 11px; border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:rgba(127,127,127,.045); }
        .gg-ub-control-copy { min-width:0; }
        .gg-ub-control-title { display:block; font-size:12px; font-weight:700; }
        .gg-ub-control-hint { display:block; margin-top:3px; opacity:.58; font-size:9px; line-height:1.3; }
        .gg-ub-control-card input[type="checkbox"] { width:18px; height:18px; flex:0 0 auto; }
        .gg-ub-hold-wrap { display:flex; align-items:center; gap:6px; }
        .gg-ub-hold-wrap input { width:80px; text-align:right; }
        .gg-ub-unit { opacity:.62; font-size:10px; }

        .gg-ub-workspace { display:grid; grid-template-columns:190px minmax(0,1fr); height:min(64vh,690px); min-height:430px; overflow:hidden; border:1px solid var(--SmartThemeBorderColor); border-radius:12px; background:rgba(0,0,0,.08); }
        .gg-ub-sidebar { display:flex; flex-direction:column; gap:9px; min-width:0; min-height:0; padding:11px; border-right:1px solid var(--SmartThemeBorderColor); background:rgba(127,127,127,.035); overflow:hidden; }
        .gg-ub-sidebar-label,.gg-ub-section-eyebrow { text-transform:uppercase; letter-spacing:.08em; font-size:9px; font-weight:750; opacity:.56; }
        .gg-ub-tabs-list { display:flex; flex-direction:column; gap:5px; overflow-y:auto; min-height:0; }
        .gg-ub-config-tab { display:flex!important; align-items:center; justify-content:space-between; gap:7px; width:100%; min-height:35px; padding:6px 8px!important; text-align:left; border:1px solid transparent!important; border-radius:8px!important; background:transparent!important; }
        .gg-ub-config-tab:hover { background:rgba(127,127,127,.09)!important; }
        .gg-ub-config-tab.active { border-color:color-mix(in srgb,var(--SmartThemeQuoteColor) 58%,transparent)!important; background:color-mix(in srgb,var(--SmartThemeQuoteColor) 12%,transparent)!important; }
        .gg-ub-tab-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
        .gg-ub-tab-count { min-width:21px; padding:2px 5px; border-radius:999px; background:rgba(127,127,127,.13); font-size:9px; text-align:center; }
        .gg-ub-new-tab { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px; padding-top:9px; border-top:1px solid var(--SmartThemeBorderColor); }
        .gg-ub-new-tab input { min-width:0; width:100%; }

        .gg-ub-editor { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
        .gg-ub-editor-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:12px 14px; flex:0 0 auto; border-bottom:1px solid var(--SmartThemeBorderColor); background:rgba(127,127,127,.02); }
        .gg-ub-editor-title { margin:3px 0 0; font-size:16px; font-weight:750; }
        .gg-ub-editor-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
        .gg-ub-inline-toggle { display:inline-flex; align-items:center; gap:5px; min-height:30px; padding:3px 7px; border:1px solid var(--SmartThemeBorderColor); border-radius:7px; font-size:10px; white-space:nowrap; }
        .gg-ub-editor-body { display:flex; flex-direction:column; gap:11px; padding:12px 14px 14px; min-height:0; flex:1 1 auto; overflow:hidden; }
        .gg-ub-section { display:flex; flex-direction:column; gap:7px; flex:0 0 auto; }
        .gg-ub-blocks-section { flex:1 1 auto; min-height:0; }
        .gg-ub-section-title-row { display:flex; align-items:center; justify-content:space-between; gap:9px; flex-wrap:wrap; }
        .gg-ub-section-title { margin:0; font-size:12px; font-weight:750; }
        .gg-ub-section-hint { opacity:.58; font-size:9px; }
        .gg-ub-section-actions { display:flex; align-items:center; gap:5px; flex-wrap:wrap; justify-content:flex-end; }

        .gg-ub-add-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; align-items:end; padding:9px; border:1px dashed var(--SmartThemeBorderColor); border-radius:9px; background:rgba(127,127,127,.03); }
        .gg-ub-add-picker { display:flex; flex-direction:column; gap:6px; min-width:0; }
        .gg-ub-prompt-search-wrap { position:relative; display:flex; align-items:center; min-width:0; }
        .gg-ub-prompt-search-wrap > i { position:absolute; left:9px; opacity:.5; pointer-events:none; font-size:10px; }
        .gg-ub-prompt-search { width:100%; min-width:0; padding-left:28px!important; }
        .gg-ub-add-card select { width:100%; min-width:0; }
        .gg-ub-prompt-search-meta { min-height:14px; opacity:.58; font-size:9px; line-height:1.3; }

        .gg-ub-config-blocks { display:flex; flex-direction:column; gap:9px; min-height:150px; height:100%; max-height:100%; overflow-y:auto; overflow-x:hidden; padding:2px 6px 8px 0; scrollbar-gutter:stable; overscroll-behavior:contain; }
        .gg-ub-config-blocks::-webkit-scrollbar { width:8px; }
        .gg-ub-config-blocks::-webkit-scrollbar-thumb { border-radius:999px; background:rgba(127,127,127,.34); }
        .gg-ub-config-blocks::-webkit-scrollbar-track { background:transparent; }

        .gg-ub-config-block { display:flex; flex-direction:column; gap:8px; padding:10px 11px; flex:0 0 auto; border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:color-mix(in srgb,var(--SmartThemeBlurTintColor) 40%,transparent); transition:border-color .14s,background .14s,transform .14s; }
        .gg-ub-config-block.is-group { border-left:3px solid var(--SmartThemeQuoteColor); }
        .gg-ub-config-block.has-missing { border-color:rgba(239,68,68,.55); }
        .gg-ub-config-block.is-grouping { cursor:pointer; user-select:none; border-style:dashed; }
        .gg-ub-config-block.is-grouping:hover { background:rgba(127,127,127,.09); }
        .gg-ub-config-block.is-selected { border-color:var(--SmartThemeQuoteColor); background:color-mix(in srgb,var(--SmartThemeQuoteColor) 14%,transparent); transform:translateX(2px); }
        .gg-ub-config-block-head { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:9px; align-items:center; }
        .gg-ub-block-title-wrap { display:flex; align-items:center; gap:7px; min-width:0; }
        .gg-ub-block-index { display:inline-grid; place-items:center; width:25px; height:25px; flex:0 0 25px; border-radius:7px; background:rgba(127,127,127,.13); font-size:10px; font-weight:750; }
        .gg-ub-select-marker { display:inline-grid; place-items:center; width:25px; height:25px; flex:0 0 25px; border:1px solid var(--SmartThemeBorderColor); border-radius:7px; background:rgba(127,127,127,.08); color:transparent; }
        .gg-ub-config-block.is-selected .gg-ub-select-marker { color:inherit; border-color:var(--SmartThemeQuoteColor); background:color-mix(in srgb,var(--SmartThemeQuoteColor) 20%,transparent); }
        .gg-ub-block-name-wrap { min-width:0; }
        .gg-ub-block-name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:700; }
        .gg-ub-block-meta { display:block; margin-top:2px; opacity:.57; font-size:9px; }
        .gg-ub-effort { min-width:120px; }
        .gg-ub-block-actions { display:flex; gap:4px; align-items:center; }
        .gg-ub-icon-button { display:inline-grid!important; place-items:center; width:29px; min-width:29px!important; height:29px; padding:0!important; border-radius:7px!important; font-size:11px; }
        .gg-ub-icon-button:disabled { opacity:.28; }
        .gg-ub-config-danger { color:#ff7676!important; }
        .gg-ub-group-action { color:var(--SmartThemeQuoteColor)!important; }

        .gg-ub-members { display:flex; flex-wrap:wrap; gap:5px; padding-top:1px; }
        .gg-ub-config-ref { display:inline-flex; align-items:center; gap:5px; max-width:100%; min-height:26px; padding:3px 8px; border:1px solid var(--SmartThemeBorderColor); border-radius:999px; background:rgba(127,127,127,.075); font-size:10px; }
        .gg-ub-config-ref.is-missing { border-color:rgba(239,68,68,.55); background:rgba(239,68,68,.08); }
        .gg-ub-ref-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:320px; }

        .gg-ub-group-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:7px 8px; border:1px solid color-mix(in srgb,var(--SmartThemeQuoteColor) 35%,var(--SmartThemeBorderColor)); border-radius:8px; background:color-mix(in srgb,var(--SmartThemeQuoteColor) 8%,transparent); }
        .gg-ub-group-counter { min-width:72px; font-size:10px; font-weight:650; }
        .gg-ub-group-help { flex:1 1 180px; opacity:.65; font-size:9px; }

        .gg-ub-empty { display:grid; place-items:center; gap:7px; min-height:130px; padding:20px; border:1px dashed var(--SmartThemeBorderColor); border-radius:9px; text-align:center; opacity:.72; }
        .gg-ub-empty i { font-size:22px; }
        .gg-ub-empty strong { font-size:12px; }
        .gg-ub-empty span { max-width:420px; font-size:10px; line-height:1.45; }
        .gg-ub-config-muted { opacity:.66; font-size:10px; }

        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 11px; border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:rgba(127,127,127,.045); }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-main { min-width:0; }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-title { display:flex; align-items:center; gap:6px; font-weight:700; }
        #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions { display:flex; align-items:center; gap:7px; flex-wrap:wrap; justify-content:flex-end; }

        @media (max-width:760px) {
            .gg-ub-config { width:100%; }
            .gg-ub-hero { flex-direction:column; }
            .gg-ub-statuses { justify-content:flex-start; }
            .gg-ub-global-grid { grid-template-columns:1fr; }
            .gg-ub-workspace { grid-template-columns:1fr; height:auto; max-height:none; overflow:visible; }
            .gg-ub-sidebar { border-right:0; border-bottom:1px solid var(--SmartThemeBorderColor); overflow:visible; }
            .gg-ub-tabs-list { flex-direction:row; flex-wrap:wrap; overflow:visible; }
            .gg-ub-config-tab { width:auto; max-width:180px; }
            .gg-ub-editor,.gg-ub-editor-body { overflow:visible; }
            .gg-ub-config-blocks { height:auto; max-height:min(52vh,520px); overflow-y:auto; }
            .gg-ub-config-block-head { grid-template-columns:minmax(0,1fr) auto; }
            .gg-ub-effort { grid-column:1/-1; width:100%; min-width:0; }
            .gg-ub-block-actions { grid-column:2; grid-row:1; }
        }
        @media (max-width:520px) {
            .gg-ub-editor-head { flex-direction:column; }
            .gg-ub-editor-actions { justify-content:flex-start; }
            .gg-ub-add-card { grid-template-columns:1fr; align-items:stretch; }
            .gg-ub-add-card .menu_button { width:100%; }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card { align-items:flex-start; flex-direction:column; }
            #${UB_SETTINGS_ANCHOR_ID} .gg-native-ub-card-actions { justify-content:flex-start; }
        }
    `;
    document.head.appendChild(style);
}

export async function showUbConfigPopup(onSaved = null) {
    ensureStyles();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = getPopupApi();
    if (!Popup || !POPUP_TYPE) throw new Error('SillyTavern Popup API is unavailable.');

    const draft = clone(getUbSettings());
    let activeTabId = draft.tabs[0]?.id ?? null;
    let groupingTabId = null;
    const selectedBlockIds = new Set();
    const promptSearchByTab = new Map();

    const resetGrouping = () => {
        groupingTabId = null;
        selectedBlockIds.clear();
    };

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
                <p class="gg-ub-hero-subtitle">Prompt identifiers come from SillyTavern Prompt Manager. Grouping follows the original userscript: select existing blocks, then merge them into one state.</p>
            </div>
            <div class="gg-ub-statuses">
                <span class="gg-ub-status-pill ${promptManagerReady ? 'is-ok' : 'is-warn'}"><i class="fa-solid ${promptManagerReady ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>${promptManagerReady ? 'Prompt Manager ready' : 'Prompt Manager unavailable'}</span>
                <span class="gg-ub-status-pill"><i class="fa-solid fa-layer-group"></i>${draft.tabs.length} tab${draft.tabs.length === 1 ? '' : 's'}</span>
                <span class="gg-ub-status-pill"><i class="fa-solid fa-cubes-stacked"></i>${totalBlocks} block${totalBlocks === 1 ? '' : 's'}</span>
            </div>`;
        root.appendChild(hero);

        const globalGrid = document.createElement('div');
        globalGrid.className = 'gg-ub-global-grid';
        globalGrid.innerHTML = `
            <label class="gg-ub-control-card"><span class="gg-ub-control-copy"><span class="gg-ub-control-title">Enable Native UB</span><span class="gg-ub-control-hint">Turns the UB/HJB engine on or off.</span></span><input type="checkbox" data-field="enabled" ${draft.enabled ? 'checked' : ''}></label>
            <label class="gg-ub-control-card"><span class="gg-ub-control-copy"><span class="gg-ub-control-title">Message toolbar</span><span class="gg-ub-control-hint">Show UB state buttons and compact SillyTavern extra actions.</span></span><input type="checkbox" data-field="toolbar" ${draft.toolbar.enabled ? 'checked' : ''}></label>
            <label class="gg-ub-control-card"><span class="gg-ub-control-copy"><span class="gg-ub-control-title">Long press</span><span class="gg-ub-control-hint">Hold duration before state picker opens.</span></span><span class="gg-ub-hold-wrap"><input class="text_pole" type="number" min="300" max="3000" step="50" data-field="hold" value="${draft.toolbar.longPressMs}"><span class="gg-ub-unit">ms</span></span></label>`;
        root.appendChild(globalGrid);

        const workspace = document.createElement('div');
        workspace.className = 'gg-ub-workspace';
        const sidebar = document.createElement('aside');
        sidebar.className = 'gg-ub-sidebar';
        const sideLabel = document.createElement('div');
        sideLabel.className = 'gg-ub-sidebar-label';
        sideLabel.textContent = 'State tabs';
        sidebar.appendChild(sideLabel);

        const tabsList = document.createElement('div');
        tabsList.className = 'gg-ub-tabs-list';
        for (const tabItem of draft.tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `menu_button gg-ub-config-tab ${tabItem.id === activeTabId ? 'active' : ''}`;
            const name = document.createElement('span');
            name.className = 'gg-ub-tab-name';
            name.textContent = tabItem.name;
            const count = document.createElement('span');
            count.className = 'gg-ub-tab-count';
            count.textContent = String(tabItem.blocks.length);
            btn.append(name, count);
            btn.addEventListener('click', () => {
                if (activeTabId !== tabItem.id) resetGrouping();
                activeTabId = tabItem.id;
                render();
            });
            tabsList.appendChild(btn);
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
            const tabItem = { id: uid('tab'), name: name.slice(0, 10).toUpperCase(), isDefault: false, enabled: true, changeEffort: false, blocks: [] };
            draft.tabs.push(tabItem);
            activeTabId = tabItem.id;
            resetGrouping();
            render();
        };
        addTab.addEventListener('click', createTab);
        newName.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); createTab(); } });
        newTab.append(newName, addTab);
        sidebar.appendChild(newTab);
        workspace.appendChild(sidebar);

        const editor = document.createElement('section');
        editor.className = 'gg-ub-editor';
        const tab = draft.tabs.find(item => item.id === activeTabId);
        if (!tab) {
            const empty = document.createElement('div');
            empty.className = 'gg-ub-empty';
            empty.innerHTML = '<i class="fa-solid fa-layer-group"></i><strong>No tab selected</strong><span>Create or select a tab to configure UB states.</span>';
            editor.appendChild(empty);
            workspace.appendChild(editor);
            root.appendChild(workspace);
            return;
        }

        const grouping = groupingTabId === tab.id;
        for (const id of [...selectedBlockIds]) {
            if (!tab.blocks.some(block => block.id === id)) selectedBlockIds.delete(id);
        }

        const editorHead = document.createElement('div');
        editorHead.className = 'gg-ub-editor-head';
        const title = document.createElement('div');
        title.innerHTML = `<div class="gg-ub-section-eyebrow">Editing tab</div><div class="gg-ub-editor-title"></div>`;
        title.querySelector('.gg-ub-editor-title').textContent = tab.name;
        editorHead.appendChild(title);
        const editorActions = document.createElement('div');
        editorActions.className = 'gg-ub-editor-actions';

        if (!tab.isDefault && !grouping) {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'text_pole';
            nameInput.value = tab.name;
            nameInput.style.width = '135px';
            nameInput.addEventListener('change', () => { const next = nameInput.value.trim(); if (next) tab.name = next.slice(0, 10).toUpperCase(); render(); });
            editorActions.appendChild(nameInput);
        }
        const visible = document.createElement('label');
        visible.className = 'gg-ub-inline-toggle';
        visible.innerHTML = `<input type="checkbox" ${tab.enabled ? 'checked' : ''} ${grouping ? 'disabled' : ''}><span>Show button</span>`;
        visible.querySelector('input').addEventListener('change', event => { tab.enabled = event.target.checked; });
        editorActions.appendChild(visible);
        const effortToggle = document.createElement('label');
        effortToggle.className = 'gg-ub-inline-toggle';
        effortToggle.innerHTML = `<input type="checkbox" ${tab.changeEffort ? 'checked' : ''} ${grouping ? 'disabled' : ''}><span>Change effort</span>`;
        effortToggle.querySelector('input').addEventListener('change', event => { tab.changeEffort = event.target.checked; render(); });
        editorActions.appendChild(effortToggle);
        if (!tab.isDefault && !grouping) {
            const removeTab = createIconButton('fa-trash', 'Delete this tab', 'gg-ub-config-danger');
            removeTab.addEventListener('click', () => { draft.tabs = draft.tabs.filter(item => item.id !== tab.id); activeTabId = draft.tabs[0]?.id ?? null; resetGrouping(); render(); });
            editorActions.appendChild(removeTab);
        }
        editorHead.appendChild(editorActions);
        editor.appendChild(editorHead);

        const editorBody = document.createElement('div');
        editorBody.className = 'gg-ub-editor-body';

        const addSection = document.createElement('div');
        addSection.className = 'gg-ub-section';
        addSection.innerHTML = `<div class="gg-ub-section-title-row"><div><div class="gg-ub-section-eyebrow">Prompt Manager</div><h3 class="gg-ub-section-title">Add a state block</h3></div><span class="gg-ub-section-hint">Search by prompt name or ID, then add it as one selectable state.</span></div>`;
        const used = allUsedIds(tab);
        const available = promptList.filter(prompt => !used.has(prompt.identifier));
        const addCard = document.createElement('div');
        addCard.className = 'gg-ub-add-card';
        const picker = document.createElement('div');
        picker.className = 'gg-ub-add-picker';
        const searchWrap = document.createElement('div');
        searchWrap.className = 'gg-ub-prompt-search-wrap';
        const searchIcon = document.createElement('i');
        searchIcon.className = 'fa-solid fa-magnifying-glass';
        const promptSearch = document.createElement('input');
        promptSearch.type = 'search';
        promptSearch.className = 'text_pole gg-ub-prompt-search';
        promptSearch.placeholder = 'Tìm prompt theo tên hoặc ID…';
        promptSearch.autocomplete = 'off';
        promptSearch.spellcheck = false;
        promptSearch.value = promptSearchByTab.get(tab.id) ?? '';
        searchWrap.append(searchIcon, promptSearch);
        const promptSelect = document.createElement('select');
        promptSelect.className = 'text_pole';
        const searchMeta = document.createElement('div');
        searchMeta.className = 'gg-ub-prompt-search-meta';
        picker.append(searchWrap, promptSelect, searchMeta);
        const addBlock = document.createElement('button');
        addBlock.type = 'button';
        addBlock.className = 'menu_button';
        addBlock.innerHTML = '<i class="fa-solid fa-plus"></i> Add block';

        const filteredAvailablePrompts = () => {
            const query = normalizePromptSearchText(promptSearch.value.trim());
            if (!query) return available;
            return available.filter(prompt => normalizePromptSearchText(`${prompt.name}\n${prompt.identifier}\n${prompt.role || ''}`).includes(query));
        };

        const refreshPromptPicker = () => {
            const previousValue = promptSelect.value;
            const filtered = filteredAvailablePrompts();
            promptSelect.replaceChildren();

            if (filtered.length) {
                for (const prompt of filtered) {
                    const option = document.createElement('option');
                    option.value = prompt.identifier;
                    option.textContent = `${prompt.name} · ${prompt.role || 'n/a'}`;
                    option.title = `${prompt.name}\n${prompt.identifier}`;
                    promptSelect.appendChild(option);
                }
                if (filtered.some(prompt => prompt.identifier === previousValue)) promptSelect.value = previousValue;
            } else {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = available.length
                    ? 'Không tìm thấy prompt phù hợp'
                    : (promptManagerReady ? 'All available prompts are already used' : 'Prompt Manager is not ready');
                promptSelect.appendChild(option);
            }

            const queryActive = Boolean(promptSearch.value.trim());
            searchMeta.textContent = queryActive
                ? `${filtered.length}/${available.length} prompt chưa dùng khớp tìm kiếm`
                : `${available.length} prompt chưa dùng trong tab này`;
            addBlock.disabled = grouping || !filtered.length;
        };

        const addSelectedPrompt = () => {
            const prompt = promptList.find(item => item.identifier === promptSelect.value);
            if (!prompt) return;
            tab.blocks.push({ id: uid('block'), name: prompt.name, effort: 'min', promptRefs: [promptRef(prompt)] });
            render();
        };

        promptSearch.addEventListener('input', () => {
            promptSearchByTab.set(tab.id, promptSearch.value);
            refreshPromptPicker();
        });
        promptSearch.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !addBlock.disabled && promptSelect.value) {
                event.preventDefault();
                addSelectedPrompt();
            }
        });
        addBlock.addEventListener('click', addSelectedPrompt);
        refreshPromptPicker();
        addCard.append(picker, addBlock);
        addSection.appendChild(addCard);
        editorBody.appendChild(addSection);

        const blocksSection = document.createElement('div');
        blocksSection.className = 'gg-ub-section gg-ub-blocks-section';
        const blocksHeader = document.createElement('div');
        blocksHeader.className = 'gg-ub-section-title-row';
        const blocksTitle = document.createElement('div');
        blocksTitle.innerHTML = '<div class="gg-ub-section-eyebrow">State order</div><h3 class="gg-ub-section-title">Blocks & groups</h3>';
        blocksHeader.appendChild(blocksTitle);
        const sectionActions = document.createElement('div');
        sectionActions.className = 'gg-ub-section-actions';

        if (!grouping) {
            const hint = document.createElement('span');
            hint.className = 'gg-ub-section-hint';
            hint.textContent = 'Top to bottom = state 1, 2, 3…';
            sectionActions.appendChild(hint);
            if (tab.blocks.length >= 2) {
                const startGroup = document.createElement('button');
                startGroup.type = 'button';
                startGroup.className = 'menu_button';
                startGroup.innerHTML = '<i class="fa-solid fa-object-group"></i> Group blocks';
                startGroup.addEventListener('click', () => { groupingTabId = tab.id; selectedBlockIds.clear(); render(); });
                sectionActions.appendChild(startGroup);
            }
        }
        blocksHeader.appendChild(sectionActions);
        blocksSection.appendChild(blocksHeader);

        if (grouping) {
            const groupToolbar = document.createElement('div');
            groupToolbar.className = 'gg-ub-group-toolbar';
            const counter = document.createElement('span');
            counter.className = 'gg-ub-group-counter';
            counter.textContent = `${selectedBlockIds.size} selected`;
            const help = document.createElement('span');
            help.className = 'gg-ub-group-help';
            help.textContent = 'Select at least 2 existing blocks/groups. Existing groups are flattened into the new group.';
            const finish = document.createElement('button');
            finish.type = 'button';
            finish.className = 'menu_button';
            finish.innerHTML = `<i class="fa-solid fa-object-group"></i> Group selected (${selectedBlockIds.size})`;
            finish.disabled = selectedBlockIds.size < 2;
            finish.addEventListener('click', () => {
                if (groupSelectedBlocks(tab, selectedBlockIds, () => uid('group'))) {
                    resetGrouping();
                    render();
                }
            });
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'menu_button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => { resetGrouping(); render(); });
            groupToolbar.append(counter, help, finish, cancel);
            blocksSection.appendChild(groupToolbar);
        }

        const blocks = document.createElement('div');
        blocks.className = 'gg-ub-config-blocks';
        if (!tab.blocks.length) {
            const empty = document.createElement('div');
            empty.className = 'gg-ub-empty';
            empty.innerHTML = '<i class="fa-solid fa-cubes-stacked"></i><strong>No blocks yet</strong><span>Add Prompt Manager entries above. To make a group, first create the individual blocks, then select them with Group blocks.</span>';
            blocks.appendChild(empty);
        }

        const existsById = new Map(promptList.map(prompt => [prompt.identifier, prompt]));
        tab.blocks.forEach((block, index) => {
            const missingRefs = block.promptRefs.filter(ref => !existsById.has(ref.identifier));
            const selected = selectedBlockIds.has(block.id);
            const card = document.createElement('div');
            card.className = `gg-ub-config-block ${block.promptRefs.length > 1 ? 'is-group' : ''} ${missingRefs.length ? 'has-missing' : ''} ${grouping ? 'is-grouping' : ''} ${selected ? 'is-selected' : ''}`.trim();
            if (grouping) {
                card.setAttribute('role', 'checkbox');
                card.setAttribute('aria-checked', String(selected));
                card.tabIndex = 0;
                const toggle = () => {
                    if (selectedBlockIds.has(block.id)) selectedBlockIds.delete(block.id); else selectedBlockIds.add(block.id);
                    render();
                };
                card.addEventListener('click', toggle);
                card.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(); } });
            }

            const head = document.createElement('div');
            head.className = 'gg-ub-config-block-head';
            const titleWrap = document.createElement('div');
            titleWrap.className = 'gg-ub-block-title-wrap';
            const marker = document.createElement('span');
            if (grouping) {
                marker.className = 'gg-ub-select-marker';
                marker.innerHTML = '<i class="fa-solid fa-check"></i>';
            } else {
                marker.className = 'gg-ub-block-index';
                marker.textContent = String(index + 1);
            }
            const nameWrap = document.createElement('div');
            nameWrap.className = 'gg-ub-block-name-wrap';
            const name = document.createElement('span');
            name.className = 'gg-ub-block-name';
            name.textContent = block.promptRefs.length > 1 ? `[GROUP] ${block.name}` : block.name;
            const meta = document.createElement('span');
            meta.className = 'gg-ub-block-meta';
            meta.textContent = block.promptRefs.length > 1
                ? `Group · ${block.promptRefs.length} prompts${missingRefs.length ? ` · ${missingRefs.length} missing` : ''}`
                : `Single prompt${missingRefs.length ? ' · missing' : ''}`;
            nameWrap.append(name, meta);
            titleWrap.append(marker, nameWrap);
            head.appendChild(titleWrap);

            if (tab.changeEffort && !grouping) {
                const effort = document.createElement('select');
                effort.className = 'text_pole gg-ub-effort';
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
                head.appendChild(document.createElement('span'));
            }

            if (!grouping) {
                const actions = document.createElement('div');
                actions.className = 'gg-ub-block-actions';
                const up = createIconButton('fa-arrow-up', 'Move block up');
                up.disabled = index === 0;
                up.addEventListener('click', () => { [tab.blocks[index - 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index - 1]]; render(); });
                const down = createIconButton('fa-arrow-down', 'Move block down');
                down.disabled = index === tab.blocks.length - 1;
                down.addEventListener('click', () => { [tab.blocks[index + 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index + 1]]; render(); });
                actions.append(up, down);
                if (block.promptRefs.length > 1) {
                    const ungroup = createIconButton('fa-object-ungroup', 'Ungroup into individual blocks', 'gg-ub-group-action');
                    ungroup.addEventListener('click', () => { ungroupBlock(tab, index, () => uid('block')); render(); });
                    actions.appendChild(ungroup);
                }
                const remove = createIconButton('fa-trash', 'Delete block/group', 'gg-ub-config-danger');
                remove.addEventListener('click', () => { tab.blocks.splice(index, 1); render(); });
                actions.appendChild(remove);
                head.appendChild(actions);
            } else {
                head.appendChild(document.createElement('span'));
            }
            card.appendChild(head);

            const members = document.createElement('div');
            members.className = 'gg-ub-members';
            for (const ref of block.promptRefs) {
                const exists = existsById.has(ref.identifier);
                const pill = document.createElement('span');
                pill.className = `gg-ub-config-ref ${exists ? '' : 'is-missing'}`.trim();
                pill.title = ref.identifier;
                const refName = document.createElement('span');
                refName.className = 'gg-ub-ref-name';
                refName.textContent = `${ref.nameSnapshot}${exists ? '' : ' · missing'}`;
                pill.appendChild(refName);
                members.appendChild(pill);
            }
            card.appendChild(members);
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
        okButton: 'Save changes', cancelButton: 'Cancel', wider: true, large: true, allowVerticalScrolling: true,
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

    const section = document.createElement('div');
    section.id = UB_SETTINGS_ANCHOR_ID;
    section.className = 'settings_section';
    section.innerHTML = `
        <hr>
        <h4>Native UB Message Toolbar</h4>
        <div class="gg-native-ub-card">
            <div class="gg-native-ub-card-main">
                <div class="gg-native-ub-card-title"><i class="fa-solid fa-bolt"></i> Native UB / HJB</div>
                <small class="setting_item_description">Native PromptManager-backed UB states. When enabled, the message toolbar follows the compact userscript layout: UB buttons stay on the main row and extra SillyTavern actions are hidden reversibly except Copy.</small>
                <div class="gg-native-ub-summary gg-ub-config-muted"></div>
            </div>
            <div class="gg-native-ub-card-actions">
                <label class="gg-ub-inline-toggle"><input type="checkbox" class="gg-native-ub-enable"><span>Enabled</span></label>
                <button type="button" class="menu_button gg-native-ub-configure"><i class="fa-solid fa-sliders"></i> Configure UB</button>
            </div>
        </div>`;
    container.insertBefore(section, container.firstChild);

    const summary = section.querySelector('.gg-native-ub-summary');
    const enable = section.querySelector('.gg-native-ub-enable');
    const refreshSummary = () => {
        const current = getUbSettings();
        const blockCount = current.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0);
        const groupCount = current.tabs.reduce((sum, tab) => sum + tab.blocks.filter(block => block.promptRefs.length > 1).length, 0);
        summary.textContent = `${current.tabs.length} tab(s) · ${blockCount} state(s) · ${groupCount} group(s)`;
        enable.checked = current.enabled;
    };
    refreshSummary();

    enable.addEventListener('change', event => {
        const current = getUbSettings();
        current.enabled = event.target.checked;
        saveUbSettings(current);
        onChanged?.();
        refreshSummary();
    });
    section.querySelector('.gg-native-ub-configure').addEventListener('click', async () => {
        await showUbConfigPopup(() => { onChanged?.(); refreshSummary(); });
    });
    return true;
}