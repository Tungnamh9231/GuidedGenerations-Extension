import { SETTINGS_SECTION_ID, STYLE_ID, ZERO_WIDTH_SPACE } from './constants.js';
import { getTextObfuscationSettings, saveTextObfuscationSettings } from './store.js';
import { escapeZeroWidthForDisplay, obfuscateForRule } from './transformer.js';

const CONTROL_ATTR = 'data-gg-text-obfuscation-control';

function uid() {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch { /* fallback below */ }
    return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function patternKey(pattern) {
    return String(pattern).toLowerCase();
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-card { display:flex; flex-direction:column; gap:9px; padding:10px 11px; border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:rgba(127,127,127,.045); }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-title { display:flex; align-items:center; gap:6px; font-weight:700; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle { display:inline-flex; align-items:center; gap:6px; min-height:32px; padding:3px 8px; border:1px solid var(--SmartThemeBorderColor); border-radius:7px; white-space:nowrap; font-size:10px; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle input { width:18px; height:18px; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-add { display:grid; grid-template-columns:minmax(0,1fr) 34px; gap:6px; align-items:center; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-add input { width:100%; min-width:0; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-add button { display:grid; place-items:center; min-width:34px; height:34px; padding:0; font-size:17px; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-list { display:flex; flex-direction:column; gap:7px; }
        #${SETTINGS_SECTION_ID} .gg-text-rule { display:flex; flex-direction:column; gap:7px; padding:8px 9px; border:1px solid var(--SmartThemeBorderColor); border-radius:9px; background:rgba(127,127,127,.035); }
        #${SETTINGS_SECTION_ID} .gg-text-rule-head { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-pattern { min-width:0; overflow-wrap:anywhere; font:600 11px/1.35 var(--monoFontFamily, monospace); }
        #${SETTINGS_SECTION_ID} .gg-text-rule-delete { display:grid; place-items:center; flex:0 0 28px; width:28px; min-width:28px; height:28px; padding:0; color:#ff7676; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-options { display:flex; flex-wrap:wrap; gap:5px; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-option { display:inline-flex; align-items:center; gap:5px; min-height:28px; padding:2px 7px; border:1px solid var(--SmartThemeBorderColor); border-radius:7px; background:rgba(127,127,127,.04); font-size:9px; white-space:nowrap; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-option input { width:15px; height:15px; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-preview { opacity:.7; font:9px/1.4 var(--monoFontFamily, monospace); overflow-wrap:anywhere; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-meta, #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status { opacity:.72; font-size:10px; line-height:1.45; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status { white-space:pre-line; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status.is-ok { opacity:.9; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-status.is-warn { color:#f6c453; opacity:.95; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-samples { display:flex; flex-wrap:wrap; gap:5px; }
        #${SETTINGS_SECTION_ID} .gg-text-obfuscation-pill { display:inline-flex; align-items:center; max-width:100%; padding:3px 7px; border:1px solid var(--SmartThemeBorderColor); border-radius:999px; background:rgba(127,127,127,.065); font:10px/1.35 var(--monoFontFamily, monospace); overflow-wrap:anywhere; }
        #${SETTINGS_SECTION_ID} .gg-text-rule-empty { padding:9px; border:1px dashed var(--SmartThemeBorderColor); border-radius:8px; text-align:center; opacity:.6; font-size:10px; }
        @media (pointer: coarse) {
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle { min-height:40px; }
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle input { width:20px; height:20px; }
            #${SETTINGS_SECTION_ID} .gg-text-rule-option { min-height:34px; }
            #${SETTINGS_SECTION_ID} .gg-text-rule-option input { width:18px; height:18px; }
        }
        @media (max-width:520px) {
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-head { flex-direction:column; }
            #${SETTINGS_SECTION_ID} .gg-text-obfuscation-toggle { width:100%; justify-content:space-between; }
            #${SETTINGS_SECTION_ID} .gg-text-rule-options { display:grid; grid-template-columns:1fr; }
            #${SETTINGS_SECTION_ID} .gg-text-rule-option { justify-content:space-between; }
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

function createRuleToggle(labelText, title, checked, onChange) {
    const label = document.createElement('label');
    label.className = 'gg-text-rule-option';
    label.title = title;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    const text = document.createElement('span');
    text.textContent = labelText;
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, text);
    return label;
}

function describeVerification(verification) {
    switch (verification?.status) {
        case 'verified':
            return `Final ST payload: ✓ verified · ${verification.matchedOccurrences}/${verification.expectedOccurrences} transformed occurrence(s) present · ${verification.observedMarkers} U+200B observed.`;
        case 'failed':
            return `Final ST payload: ⚠ verification failed · ${verification.matchedOccurrences}/${verification.expectedOccurrences} transformed occurrence(s) found · ${verification.missingOccurrences} missing.`;
        case 'pending':
            return `Final ST payload: … waiting for CHAT_COMPLETION_SETTINGS_READY (${verification.expectedOccurrences ?? 0} transformed occurrence(s) expected).`;
        case 'unavailable':
            return `Final ST payload: ? verification unavailable${verification.reason ? ` (${verification.reason})` : ''}.`;
        case 'not_needed':
            return 'Final ST payload: — no transformed occurrence to verify.';
        default:
            return 'Final ST payload: ? verification state unavailable.';
    }
}

export class TextObfuscationSettingsView {
    constructor() {
        this.section = null;
        this.lastReport = null;
        this.enabledInput = null;
        this.addInput = null;
        this.addButton = null;
        this.ruleList = null;
        this.meta = null;
        this.status = null;
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
                        <small class="setting_item_description">Thêm từng từ/cụm từ thành rule riêng. Mỗi rule có thể xét boundary, phân biệt hoa/thường và chọn chèn U+200B vào từ đầu hay mọi từ trong phrase. Chỉ prompt tạm được sửa; chat lưu và shape payload không bị rebuild.</small>
                    </div>
                    <label class="gg-text-obfuscation-toggle" title="Bật xử lý cho mọi Chat Completion generation.">
                        <input type="checkbox" class="gg-text-obfuscation-enable">
                        <span>Enabled</span>
                    </label>
                </div>
                <div class="gg-text-rule-add">
                    <input type="text" class="text_pole gg-text-rule-add-input" spellcheck="false" placeholder="Nhập từ hoặc cụm từ…">
                    <button type="button" class="menu_button gg-text-rule-add-button" title="Add rule" aria-label="Add rule"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="gg-text-rule-list"></div>
                <div class="gg-text-obfuscation-meta"></div>
                <div class="gg-text-obfuscation-status"></div>
                <div class="gg-text-obfuscation-samples"></div>
            </div>`;

        const ubSection = document.getElementById('gg-native-ub-settings');
        if (ubSection?.parentElement === container) ubSection.insertAdjacentElement('afterend', section);
        else container.insertBefore(section, container.firstChild);

        this.section = section;
        this.enabledInput = section.querySelector('.gg-text-obfuscation-enable');
        this.addInput = section.querySelector('.gg-text-rule-add-input');
        this.addButton = section.querySelector('.gg-text-rule-add-button');
        this.ruleList = section.querySelector('.gg-text-rule-list');
        this.meta = section.querySelector('.gg-text-obfuscation-meta');
        this.status = section.querySelector('.gg-text-obfuscation-status');
        this.samples = section.querySelector('.gg-text-obfuscation-samples');

        this.enabledInput.addEventListener('change', () => {
            const current = getTextObfuscationSettings();
            current.enabled = this.enabledInput.checked;
            saveTextObfuscationSettings(current);
            this.lastReport = null;
            this.renderState();
        });
        this.addButton.addEventListener('click', () => this.addRule());
        this.addInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.addRule();
            }
        });

        this.renderState();
        return true;
    }

    addRule() {
        const pattern = String(this.addInput?.value ?? '').trim();
        if (!pattern) return;
        if (pattern.includes(ZERO_WIDTH_SPACE)) {
            globalThis.toastr?.warning?.('Pattern không thể chứa U+200B sẵn.');
            return;
        }

        const current = getTextObfuscationSettings();
        const key = patternKey(pattern);
        if (current.rules.some(rule => patternKey(rule.pattern) === key)) {
            globalThis.toastr?.warning?.('Pattern này đã tồn tại (không phân biệt hoa/thường).');
            return;
        }

        current.rules.push({
            id: uid(),
            pattern,
            strictWord: false,
            caseSensitive: false,
            allWords: false,
        });
        saveTextObfuscationSettings(current);
        this.addInput.value = '';
        this.lastReport = null;
        this.renderState();
        this.addInput.focus();
    }

    updateRule(ruleId, patch) {
        const current = getTextObfuscationSettings();
        const rule = current.rules.find(item => item.id === ruleId);
        if (!rule) return;
        Object.assign(rule, patch);
        saveTextObfuscationSettings(current);
        this.lastReport = null;
        this.renderState();
    }

    removeRule(ruleId) {
        const current = getTextObfuscationSettings();
        current.rules = current.rules.filter(rule => rule.id !== ruleId);
        saveTextObfuscationSettings(current);
        this.lastReport = null;
        this.renderState();
    }

    renderRules(rules) {
        this.ruleList.replaceChildren();
        if (!rules.length) {
            const empty = document.createElement('div');
            empty.className = 'gg-text-rule-empty';
            empty.textContent = 'Chưa có rule. Nhập một từ/cụm từ rồi bấm +.';
            this.ruleList.appendChild(empty);
            return;
        }

        for (const rule of rules) {
            const card = document.createElement('div');
            card.className = 'gg-text-rule';

            const head = document.createElement('div');
            head.className = 'gg-text-rule-head';
            const pattern = document.createElement('div');
            pattern.className = 'gg-text-rule-pattern';
            pattern.textContent = rule.pattern;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button gg-text-rule-delete';
            remove.title = 'Xóa rule';
            remove.setAttribute('aria-label', `Xóa ${rule.pattern}`);
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener('click', () => this.removeRule(rule.id));
            head.append(pattern, remove);

            const options = document.createElement('div');
            options.className = 'gg-text-rule-options';
            options.append(
                createRuleToggle(
                    'Strict word',
                    'Chỉ match khi trước/sau toàn bộ từ hoặc phrase không nối liền với chữ, số, dấu combining hoặc _. Không tự phân biệt hoa/thường.',
                    rule.strictWord,
                    checked => this.updateRule(rule.id, { strictWord: checked }),
                ),
                createRuleToggle(
                    'Case sensitive',
                    'Phải trùng chính xác chữ hoa/chữ thường. Nếu Strict word tắt, vẫn có thể match bên trong một từ dài hơn.',
                    rule.caseSensitive,
                    checked => this.updateRule(rule.id, { caseSensitive: checked }),
                ),
                createRuleToggle(
                    'Unicode every word',
                    'Phrase nhiều từ: chèn U+200B vào từng từ. Tắt: chỉ chèn vào từ đầu của match. Với rule chỉ có một từ, hai chế độ cho kết quả như nhau.',
                    rule.allWords,
                    checked => this.updateRule(rule.id, { allWords: checked }),
                ),
            );

            const preview = document.createElement('div');
            preview.className = 'gg-text-rule-preview';
            preview.textContent = `Preview: ${escapeZeroWidthForDisplay(obfuscateForRule(rule.pattern, rule))}`;

            card.append(head, options, preview);
            this.ruleList.appendChild(card);
        }
    }

    renderState() {
        if (!this.section?.isConnected) return;
        const settings = getTextObfuscationSettings();
        this.enabledInput.checked = settings.enabled;
        this.renderRules(settings.rules);
        this.meta.textContent = `${settings.rules.length} rule(s) · longest phrase first · U+200B · final-payload verification enabled`;

        this.status.className = 'gg-text-obfuscation-status';
        this.samples.replaceChildren();
        if (!settings.enabled) {
            this.status.textContent = 'Disabled · prompt đi qua SillyTavern nguyên bản.';
            return;
        }
        if (!settings.rules.length) {
            this.status.textContent = 'Enabled · chưa có rule nên không xử lý.';
            return;
        }
        if (!this.lastReport) {
            this.status.classList.add('is-ok');
            this.status.textContent = `Ready · ${settings.rules.length} rule(s). Chờ Chat Completion request tiếp theo.`;
            return;
        }
        if (this.lastReport.error) {
            this.status.classList.add('is-warn');
            this.status.textContent = `Last transform: transformer bỏ qua do lỗi (${this.lastReport.error}). Request gốc không bị chặn.`;
            return;
        }

        const protectedText = this.lastReport.protectedMessages
            ? ` · ${this.lastReport.protectedMessages} signed-prefix message(s) protected`
            : '';
        const verification = this.lastReport.verification;
        const verificationBad = verification?.status === 'failed' || verification?.status === 'unavailable';
        if (verification?.status === 'verified') this.status.classList.add('is-ok');
        else if (verificationBad || this.lastReport.replacements === 0) this.status.classList.add('is-warn');

        const transformLine = `Last transform: ${this.lastReport.replacements} replacement(s) · ${this.lastReport.matchedPatterns} matched rule(s) · ${this.lastReport.textBlocks} text block(s)${protectedText}`;
        const verificationLine = describeVerification(verification);
        const dispatchLine = 'Network dispatch: not intercepted · verification stops at SillyTavern final payload stage before the normal fetch path.';
        this.status.textContent = `${transformLine}\n${verificationLine}\n${dispatchLine}`;

        for (const sample of this.lastReport.samples ?? []) {
            const prefix = sample.pattern ? `${sample.pattern}: ` : '';
            this.samples.appendChild(createPill(`${prefix}${sample.before} → ${sample.after}`));
        }
    }
}
