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
        .gg-ub-config { display:flex; flex-direction:column; gap:10px; min-width:min(760px,85vw); }
        .gg-ub-config-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .gg-ub-config-tabs { display:flex; gap:6px; flex-wrap:wrap; }
        .gg-ub-config-tab.active { outline:2px solid var(--SmartThemeQuoteColor); }
        .gg-ub-config-blocks { display:flex; flex-direction:column; gap:8px; max-height:45vh; overflow:auto; }
        .gg-ub-config-block { padding:8px; border:1px solid var(--SmartThemeBorderColor); border-radius:8px; }
        .gg-ub-config-block-head { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .gg-ub-config-ref { display:inline-flex; align-items:center; gap:4px; margin:4px 4px 0 0; padding:3px 6px; border-radius:999px; background:rgba(127,127,127,.15); }
        .gg-ub-config-muted { opacity:.7; font-size:11px; }
        .gg-ub-config-danger { color:#ff7676; }
        .gg-ub-config select, .gg-ub-config input[type="text"], .gg-ub-config input[type="number"] { max-width:100%; }
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

        const globalRow = document.createElement('div');
        globalRow.className = 'gg-ub-config-row';
        globalRow.innerHTML = `
            <label><input type="checkbox" data-field="enabled" ${draft.enabled ? 'checked' : ''}> Enable Native UB</label>
            <label><input type="checkbox" data-field="toolbar" ${draft.toolbar.enabled ? 'checked' : ''}> Message toolbar</label>
            <label>Hold ms <input class="text_pole" type="number" min="300" max="3000" step="50" data-field="hold" value="${draft.toolbar.longPressMs}"></label>
        `;
        root.appendChild(globalRow);

        const status = document.createElement('div');
        status.className = 'gg-ub-config-muted';
        status.textContent = isPromptManagerReady()
            ? 'Prompt Manager detected. Configuration stores prompt identifiers, not DOM names.'
            : 'Prompt Manager is not ready. You can edit existing config, but prompt discovery is unavailable.';
        root.appendChild(status);

        const tabs = document.createElement('div');
        tabs.className = 'gg-ub-config-tabs';
        for (const tab of draft.tabs) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `menu_button gg-ub-config-tab ${tab.id === activeTabId ? 'active' : ''}`;
            button.textContent = tab.name;
            button.addEventListener('click', () => { activeTabId = tab.id; render(); });
            tabs.appendChild(button);
        }
        const newName = document.createElement('input');
        newName.type = 'text';
        newName.className = 'text_pole';
        newName.placeholder = 'New tab name';
        newName.style.width = '130px';
        const addTab = document.createElement('button');
        addTab.type = 'button';
        addTab.className = 'menu_button';
        addTab.textContent = '+ Tab';
        addTab.addEventListener('click', () => {
            const name = newName.value.trim();
            if (!name) return;
            const tab = {
                id: uid('tab'), name, isDefault: false, enabled: true, changeEffort: true, blocks: [],
            };
            draft.tabs.push(tab);
            activeTabId = tab.id;
            render();
        });
        tabs.append(newName, addTab);
        root.appendChild(tabs);

        const tab = draft.tabs.find(item => item.id === activeTabId);
        if (!tab) return;

        const tabRow = document.createElement('div');
        tabRow.className = 'gg-ub-config-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'text_pole';
        nameInput.value = tab.name;
        nameInput.disabled = tab.isDefault;
        nameInput.title = tab.isDefault ? 'Default HJB tab name is fixed to keep state labels stable.' : '';
        nameInput.addEventListener('input', () => { tab.name = nameInput.value.trim() || tab.name; });

        const visibleLabel = document.createElement('label');
        visibleLabel.innerHTML = `<input type="checkbox" ${tab.enabled ? 'checked' : ''}> Show button`;
        visibleLabel.querySelector('input').addEventListener('change', event => { tab.enabled = event.target.checked; });

        const effortLabel = document.createElement('label');
        effortLabel.innerHTML = `<input type="checkbox" ${tab.changeEffort ? 'checked' : ''}> Change effort`;
        effortLabel.querySelector('input').addEventListener('change', event => { tab.changeEffort = event.target.checked; render(); });

        tabRow.append('Tab:', nameInput, visibleLabel, effortLabel);
        if (!tab.isDefault) {
            const removeTab = document.createElement('button');
            removeTab.type = 'button';
            removeTab.className = 'menu_button gg-ub-config-danger';
            removeTab.textContent = 'Delete tab';
            removeTab.addEventListener('click', () => {
                draft.tabs = draft.tabs.filter(item => item.id !== tab.id);
                activeTabId = draft.tabs[0]?.id ?? null;
                render();
            });
            tabRow.appendChild(removeTab);
        }
        root.appendChild(tabRow);

        const promptList = listPromptEntries();
        const used = allUsedIds(tab);
        const addRow = document.createElement('div');
        addRow.className = 'gg-ub-config-row';
        const promptSelect = document.createElement('select');
        promptSelect.className = 'text_pole';
        const available = promptList.filter(prompt => !used.has(prompt.identifier));
        if (available.length) {
            for (const prompt of available) {
                const option = document.createElement('option');
                option.value = prompt.identifier;
                option.textContent = `${prompt.name} [${prompt.role || 'n/a'}]`;
                promptSelect.appendChild(option);
            }
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No unused prompts available';
            promptSelect.appendChild(option);
        }
        const addBlock = document.createElement('button');
        addBlock.type = 'button';
        addBlock.className = 'menu_button';
        addBlock.textContent = '+ Block';
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
        addRow.append('Add prompt:', promptSelect, addBlock);
        root.appendChild(addRow);

        const blocks = document.createElement('div');
        blocks.className = 'gg-ub-config-blocks';
        if (!tab.blocks.length) {
            const empty = document.createElement('div');
            empty.className = 'gg-ub-config-muted';
            empty.textContent = 'No blocks configured. Add prompts above.';
            blocks.appendChild(empty);
        }

        tab.blocks.forEach((block, index) => {
            const card = document.createElement('div');
            card.className = 'gg-ub-config-block';
            const head = document.createElement('div');
            head.className = 'gg-ub-config-block-head';

            const title = document.createElement('strong');
            title.textContent = `${index + 1}. ${block.promptRefs.length > 1 ? '[GROUP] ' : ''}${block.name}`;
            head.appendChild(title);

            if (tab.changeEffort) {
                const effort = document.createElement('select');
                effort.className = 'text_pole';
                for (const value of EFFORT_VALUES) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = `Effort: ${value}`;
                    option.selected = block.effort === value;
                    effort.appendChild(option);
                }
                effort.addEventListener('change', () => { block.effort = effort.value; });
                head.appendChild(effort);
            }

            const up = document.createElement('button');
            up.type = 'button'; up.className = 'menu_button'; up.textContent = '↑'; up.disabled = index === 0;
            up.addEventListener('click', () => {
                [tab.blocks[index - 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index - 1]];
                render();
            });
            const down = document.createElement('button');
            down.type = 'button'; down.className = 'menu_button'; down.textContent = '↓'; down.disabled = index === tab.blocks.length - 1;
            down.addEventListener('click', () => {
                [tab.blocks[index + 1], tab.blocks[index]] = [tab.blocks[index], tab.blocks[index + 1]];
                render();
            });
            const remove = document.createElement('button');
            remove.type = 'button'; remove.className = 'menu_button gg-ub-config-danger'; remove.textContent = '×';
            remove.addEventListener('click', () => { tab.blocks.splice(index, 1); render(); });
            head.append(up, down, remove);
            card.appendChild(head);

            const refs = document.createElement('div');
            block.promptRefs.forEach((ref, refIndex) => {
                const pill = document.createElement('span');
                pill.className = 'gg-ub-config-ref';
                const exists = promptList.some(prompt => prompt.identifier === ref.identifier);
                pill.textContent = `${ref.nameSnapshot}${exists ? '' : ' (missing)'}`;
                if (!exists) pill.classList.add('gg-ub-config-danger');
                if (block.promptRefs.length > 1) {
                    const rm = document.createElement('button');
                    rm.type = 'button'; rm.className = 'menu_button'; rm.textContent = '×';
                    rm.addEventListener('click', () => {
                        block.promptRefs.splice(refIndex, 1);
                        block.name = block.promptRefs[0]?.nameSnapshot ?? block.name;
                        if (!block.promptRefs.length) tab.blocks.splice(index, 1);
                        render();
                    });
                    pill.appendChild(rm);
                }
                refs.appendChild(pill);
            });
            card.appendChild(refs);

            const unusedForGroup = promptList.filter(prompt => !used.has(prompt.identifier));
            if (unusedForGroup.length) {
                const groupRow = document.createElement('div');
                groupRow.className = 'gg-ub-config-row';
                const groupSelect = document.createElement('select');
                groupSelect.className = 'text_pole';
                for (const prompt of unusedForGroup) {
                    const option = document.createElement('option');
                    option.value = prompt.identifier;
                    option.textContent = prompt.name;
                    groupSelect.appendChild(option);
                }
                const groupAdd = document.createElement('button');
                groupAdd.type = 'button'; groupAdd.className = 'menu_button'; groupAdd.textContent = '+ Group member';
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
        root.appendChild(blocks);

        root.querySelector('[data-field="enabled"]').addEventListener('change', event => { draft.enabled = event.target.checked; });
        root.querySelector('[data-field="toolbar"]').addEventListener('change', event => { draft.toolbar.enabled = event.target.checked; });
        root.querySelector('[data-field="hold"]').addEventListener('change', event => {
            draft.toolbar.longPressMs = Math.max(300, Math.min(3000, Number(event.target.value) || 1000));
        });
    };

    render();
    const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wider: true,
        large: true,
        allowVerticalScrolling: true,
    });
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
        <div class="setting_item">
            <label><input type="checkbox" class="gg-native-ub-enable" ${settings.enabled ? 'checked' : ''}> Enable native UB engine</label>
            <small class="setting_item_description">Uses SillyTavern events and PromptManager state. Disabled by default for safe rollout.</small>
        </div>
        <button type="button" class="menu_button gg-native-ub-configure"><i class="fa-solid fa-sliders"></i> Configure UB</button>
        <span class="gg-native-ub-summary gg-ub-config-muted"></span>
    `;
    container.insertBefore(section, container.firstChild);

    const summary = section.querySelector('.gg-native-ub-summary');
    const refreshSummary = () => {
        const current = getUbSettings();
        summary.textContent = `${current.tabs.length} tab(s), ${current.tabs.reduce((sum, tab) => sum + tab.blocks.length, 0)} block/group(s)`;
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
