import { SETTINGS_SECTION_ID, STYLE_ID } from './constants.js';
import { getTextObfuscationSettings, saveTextObfuscationSettings } from './store.js';
import { escapeZeroWidthForDisplay, normalizePatterns, obfuscateMatch } from './transformer.js';

const CONTROL_ATTR = 'data-gg-text-obfuscation-control';

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-card {
            display:flex;
            flex-direction:column;
            gap:9px;
            padding:10px 11px;
            border:1px solid var(--SmartThemeBorderColor);
            border-radius:10px;
            background:rgba(127,127,127,.045);
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-head {
            display:flex;
            align-items:flex-start;
            justify-content:space-between;
            gap:10px;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-title {
            display:flex;
            align-items:center;
            gap:6px;
            font-weight:700;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle {
            display:inline-flex;
            align-items:center;
            gap:6px;
            min-height:32px;
            padding:3px 8px;
            border:1px solid var(--SmartThemeBorderColor);
            border-radius:7px;
            white-space:nowrap;
            font-size:10px;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle input {
            width:18px;
            height:18px;
        }
        #${SETTINGS_SECTION_ID} textarea {
            width:100%;
            min-height:118px;
            resize:vertical;
            font-family:var(--monoFontFamily, monospace);
            line-height:1.4;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-meta,
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status {
            opacity:.72;
            font-size:10px;
            line-height:1.45;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status.is-ok { opacity:.9; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status.is-warn { color:#f6c453; opacity:.95; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-preview,
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-samples {
            display:flex;
            flex-wrap:wrap;
            gap:5px;
        }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-pill {
            display:inline-flex;
            align-items:center;
            max-width:100%;
            padding:3px 7px;
            border:1px solid var(--SmartThemeBorderColor);
            border-radius:999px;
            background:rgba(127,127,127,.065);
            font:10px/1.35 var(--monoFontFamily, monospace);
            overflow-wrap:anywhere;
        }
        @media (pointer: coarse) {
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle { min-height:40px; }
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle input { width:20px; height:20px; }
        }
        @media (max-width:520px) {
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-head { flex-direction:column; }
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle { width:100%; justify-content:space-between; }
            #${SETTINGS_SECTION_ID} textarea { min-height:140px; }
        }
    `;
    document.head.appendChild(style);
}

function findSettingsContainer() {
    return document.querySelector('#extension_settings_GuidedGenerations-Extension .inline-drawer-content')
        || document.querySelector('.GuidedGenerations-Extension-settingslist .inline-drawer-content');
}

function createPill(text) {
    const pill = document.createElement('span');
    pill.className = 'gg-text-obfuscation-pill';
    pill.textContent = text;
    return pill;
}

export class TextObfuscationSettingsView {
    constructor() {
        this.section = null;
        this.lastReport = null;
        this.enabledInput = null;
        this.patternsInput = null;
        this.meta = null;
        this.status = null;
        this.preview = null;
        this.samples = null;
    }

    destroy() {
        this.section?.remove();
        this.section = null;
        document.getElementById(STYLE_ID)?.remove();
    }

    setLastReport(report) {
        this.lastReport = report ? { ...report } : null;
        this.renderState();
    }

    ensure() {
        ensureStyles();
        const container = findSettingsContainer();
        if (!container) return false;

        if (this.section?.isConnected) {
            this.renderState();
            return true;
        }

        document.getElementById(SETTINGS_SECTION_ID)?.remove();
        const section = document.createElement('div');
        section.id = SETTINGS_SECTION_ID;
        section.className = 'settings_section';
        section.setAttribute(CONTROL_ATTR, 'true');
        section.innerHTML = `
            <hr>
            <h4>Unicode Sensitive Words</h4>
            <div class="gg-text-obfuscation-card">
                <div class="gg-text-obfuscation-head">
                    <div>
                        <div class="gg-text-obfuscation-title"><i class="fa-solid fa-text-width"></i> Zero-width text transform</div>
                        <small class="setting_item_description">Mỗi dòng là một từ hoặc cụm từ. Khi bật, Chat Completion prompt tạm sẽ chèn U+200B sau code point đầu tiên của mỗi match. Chat lưu và cấu trúc payload không bị rebuild.</small>
                    </div>
                    <label class="gg-text-obfuscation-toggle" title="Bật xử lý cho mọi Chat Completion generation.">
                        <input type="checkbox" class="gg-text-obfuscation-enable">
                        <span>Enabled</span>
                    </label>
                </div>
                <textarea class="text_pole gg-text-obfuscation-patterns" rows="6" spellcheck="false" placeholder="Agent&#10;Hello world&#10;Shiba"></textarea>
                <div class="gg-text-obfuscation-meta"></div>
                <div class="gg-text-obfuscation-preview"></div>
                <div class="gg-text-obfuscation-status"></div>
                <div class="gg-text-obfuscation-samples"></div>
            </div>`;

        const ubSection = document.getElementById('gg-native-ub-settings');
        if (ubSection?.parentElement === container) ubSection.insertAdjacentElement('afterend', section);
        else container.insertBefore(section, container.firstChild);

        this.section = section;
        this.enabledInput = section.querySelector('.gg-text-obfuscation-enable');
        this.patternsInput = section.querySelector('.gg-text-obfuscation-patterns');
        this.meta = section.querySelector('.gg-text-obfuscation-meta');
        this.status = section.querySelector('.gg-text-obfuscation-status');
        this.preview = section.querySelector('.gg-text-obfuscation-preview');
        this.samples = section.querySelector('.gg-text-obfuscation-samples');

        const initial = getTextObfuscationSettings();
        this.enabledInput.checked = initial.enabled;
        this.patternsInput.value = initial.patternsText;

        this.enabledInput.addEventListener('change', () => {
            const current = getTextObfuscationSettings();
            current.enabled = this.enabledInput.checked;
            saveTextObfuscationSettings(current);
            this.lastReport = null;
            this.renderState();
        });
        this.patternsInput.addEventListener('input', () => {
            const current = getTextObfuscationSettings();
            current.patternsText = this.patternsInput.value;
            saveTextObfuscationSettings(current);
            this.lastReport = null;
            this.renderState();
        });

        this.renderState();
        return true;
    }

    renderState() {
        if (!this.section?.isConnected) return;
        const settings = getTextObfuscationSettings();
        const patterns = normalizePatterns(settings.patternsText);

        if (document.activeElement !== this.patternsInput && this.patternsInput.value !== settings.patternsText) {
            this.patternsInput.value = settings.patternsText;
        }
        this.enabledInput.checked = settings.enabled;
        this.meta.textContent = `${patterns.length} active pattern(s) · case-insensitive substring match · U+200B`;

        this.preview.replaceChildren();
        for (const pattern of patterns.slice(0, 5)) {
            this.preview.appendChild(createPill(`${pattern} → ${escapeZeroWidthForDisplay(obfuscateMatch(pattern))}`));
        }
        if (patterns.length > 5) this.preview.appendChild(createPill(`+${patterns.length - 5} more`));

        this.status.className = 'gg-text-obfuscation-status';
        this.samples.replaceChildren();
        if (!settings.enabled) {
            this.status.textContent = 'Disabled · prompt đi qua SillyTavern nguyên bản.';
            return;
        }
        if (!patterns.length) {
            this.status.textContent = 'Enabled · không có pattern hợp lệ nên không xử lý.';
            return;
        }
        if (!this.lastReport) {
            this.status.classList.add('is-ok');
            this.status.textContent = `Ready · ${patterns.length} pattern(s). Chờ Chat Completion request tiếp theo.`;
            return;
        }
        if (this.lastReport.error) {
            this.status.classList.add('is-warn');
            this.status.textContent = `Last request: transformer bỏ qua do lỗi (${this.lastReport.error}). Request gốc không bị chặn.`;
            return;
        }

        const protectedText = this.lastReport.protectedMessages
            ? ` · ${this.lastReport.protectedMessages} signed-prefix message(s) protected`
            : '';
        this.status.classList.add(this.lastReport.replacements > 0 ? 'is-ok' : 'is-warn');
        this.status.textContent = `Last request: ${this.lastReport.replacements} replacement(s) · ${this.lastReport.matchedPatterns} matched pattern(s) · ${this.lastReport.textBlocks} text block(s)${protectedText}`;
        for (const sample of this.lastReport.samples ?? []) {
            this.samples.appendChild(createPill(`${sample.before} → ${sample.after}`));
        }
    }
}
