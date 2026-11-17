import { ALL_MARKERS, MARKER_SETS, SETTINGS_SECTION_ID, STYLE_ID } from './constants.js';
import { getTextObfuscationSettings, saveTextObfuscationSettings } from './store.js';
import {
    buildMatcher,
    escapeZeroWidthForDisplay,
    obfuscateForRule,
    transformTextWithStats,
} from './transformer.js';

const CONTROL_ATTR = 'data-gg-text-obfuscation-control';
const MARKER_CHARS = new Set(ALL_MARKERS);

function uid() {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch { /* fallback below */ }
    return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function patternKey(pattern) {
    return String(pattern).toLowerCase();
}

function containsMarker(value) {
    for (const ch of String(value ?? '')) {
        if (MARKER_CHARS.has(ch)) return true;
    }
    return false;
}

function hasMixedScript(text) {
    let latin = false;
    let foreign = false;
    for (const ch of String(text ?? '')) {
        if (/[A-Za-z]/.test(ch)) latin = true;
        else if (/[\u0400-\u04FF\u0370-\u03FF]/.test(ch)) foreign = true;
        if (latin && foreign) return true;
    }
    return false;
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
        #${SETTINGS_SECTION_ID} .gg-text-config { display:flex; flex-direction:column; gap:7px; padding:8px 9px; border:1px solid var(--SmartThemeBorderColor); border-radius:9px; background:rgba(127,127,127,.03); }
        #${SETTINGS_SECTION_ID} .gg-text-config-field { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:10px; }
        #${SETTINGS_SECTION_ID} .gg-text-config-field select { min-width:0; max-width:62%; }
        #${SETTINGS_SECTION_ID} .gg-text-config-toggles { display:flex; flex-wrap:wrap; gap:5px; }
        #${SETTINGS_SECTION_ID} .gg-text-sim { display:flex; flex-direction:column; gap:7px; padding:8px 9px; border:1px solid var(--SmartThemeBorderColor); border-radius:9px; background:rgba(127,127,127,.03); }
        #${SETTINGS_SECTION_ID} .gg-text-sim-result { display:flex; flex-direction:column; gap:4px; font:10px/1.45 var(--monoFontFamily, monospace); }
        #${SETTINGS_SECTION_ID} .gg-text-sim-row { display:flex; align-items:baseline; gap:6px; overflow-wrap:anywhere; }
        #${SETTINGS_SECTION_ID} .gg-text-sim-row .is-pass { color:#7bd88f; }
        #${SETTINGS_SECTION_ID} .gg-text-sim-row .is-block { color:#ff8a8a; }
        #${SETTINGS_SECTION_ID} .gg-text-sim-row .is-warn { color:#f6c453; }
        #${SETTINGS_SECTION_ID} .gg-text-sim-sample { opacity:.75; font:9px/1.4 var(--monoFontFamily, monospace); overflow-wrap:anywhere; }
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

function createSimRow(status, text, sample) {
    const row = document.createElement('div');
    row.className = 'gg-text-sim-row';
    const icon = document.createElement('span');
    icon.className = status === 'pass' ? 'is-pass' : status === 'block' ? 'is-block' : 'is-warn';
    icon.textContent = status === 'pass' ? '✓' : status === 'block' ? '✗' : '⚠';
    const label = document.createElement('span');
    label.textContent = text;
    row.append(icon, label);
    if (sample) {
        const sampleEl = document.createElement('span');
        sampleEl.className = 'gg-text-sim-sample';
        sampleEl.textContent = sample;
        row.appendChild(sampleEl);
    }
    return row;
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
            return `Final ST payload: ✓ verified · ${verification.matchedBlocks}/${verification.expectedBlocks} transformed block(s) present · ${verification.observedMarkers} invisible marker(s) observed.`;
        case 'failed':
            return `Final ST payload: ⚠ verification failed · ${verification.matchedBlocks}/${verification.expectedBlocks} transformed block(s) found · ${verification.missingBlocks} missing.`;
        case 'pending':
            return `Final ST payload: … waiting for CHAT_COMPLETION_SETTINGS_READY (${verification.expectedBlocks ?? 0} transformed block(s) expected).`;
        case 'unavailable':
            return `Final ST payload: ? verification unavailable${verification.reason ? ` (${verification.reason})` : ''}.`;
        case 'not_needed':
            return 'Final ST payload: — no transformed occurrence to verify.';
        default:
            return 'Final ST payload: ? verification state unavailable.';
    }
}

function describeDispatch(dispatch) {
    switch (dispatch?.status) {
        case 'verified':
            return `Network dispatch: ✓ fetch observed + payload verified · ${dispatch.matchedBlocks}/${dispatch.expectedBlocks} transformed block(s) present · ${dispatch.observedMarkers} invisible marker(s) observed.`;
        case 'failed':
            return `Network dispatch: ⚠ fetch observed but payload verification failed · ${dispatch.matchedBlocks}/${dispatch.expectedBlocks} transformed block(s) found · ${dispatch.missingBlocks} missing.`;
        case 'observed':
            return `Network dispatch: ✓ fetch observed · payload verification unavailable${dispatch.reason ? ` (${dispatch.reason})` : ''}.`;
        case 'pending':
            return 'Network dispatch: … waiting for Chat Completion fetch.';
        case 'unavailable':
            return `Network dispatch: ? observer unavailable${dispatch.reason ? ` (${dispatch.reason})` : ''}.`;
        case 'not_needed':
            return 'Network dispatch: — no transformed occurrence to verify.';
        default:
            return 'Network dispatch: ? state unavailable.';
    }
}

export class TextObfuscationSettingsView {
    constructor() {
        this.section = null;
        this.lastReport = null;
        this.enabledInput = null;
        this.markerSetSelect = null;
        this.homoglyphInput = null;
        this.stripIncomingInput = null;
        this.protectSpansInput = null;
        this.addInput = null;
        this.addButton = null;
        this.ruleList = null;
        this.simInput = null;
        this.simButton = null;
        this.simResult = null;
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
                        <small class="setting_item_description">Thêm từng từ/cụm từ thành rule riêng. Ký tự vô hình được chèn giữa từ (không chen vào dấu kết hợp), có thể đổi bộ ký tự, thêm chữ ngoại quốc giống hệt, bảo vệ code/URL và tự dọn marker ở tin nhắn AI trả về. Chỉ prompt tạm được sửa; chat lưu và shape payload không bị rebuild.</small>
                    </div>
                    <label class="gg-text-obfuscation-toggle" title="Bật xử lý cho mọi Chat Completion generation.">
                        <input type="checkbox" class="gg-text-obfuscation-enable">
                        <span>Enabled</span>
                    </label>
                </div>
                <div class="gg-text-config">
                    <label class="gg-text-config-field">
                        <span title="Bộ ký tự vô hình dùng để chèn. Bộ càng lạ càng khó bị bộ lọc dọn sạch, nhưng AI có thể đọc kém tự nhiên hơn.">Marker set</span>
                        <select class="text_pole gg-text-marker-set"></select>
                    </label>
                    <div class="gg-text-config-toggles">
                        <label class="gg-text-rule-option" title="Thay một chữ Latin trong từ bằng chữ ngoại quốc nhìn giống hệt (Cyrillic). Sống sót cả bộ lọc xoá mọi ký tự vô hình, nhưng mặt chữ thay đổi thật và có thể bị máy phát hiện trộn bảng chữ.">
                            <input type="checkbox" class="gg-text-use-homoglyphs"><span>Homoglyph letters</span>
                        </label>
                        <label class="gg-text-rule-option" title="Tự xoá ký tự vô hình khỏi tin nhắn AI trả về để chat sạch, không tích tụ marker qua nhiều lượt.">
                            <input type="checkbox" class="gg-text-strip-incoming"><span>Strip AI replies</span>
                        </label>
                        <label class="gg-text-rule-option" title="Không chèn vào code block, inline code và URL để không phá nội dung AI cần chép nguyên văn.">
                            <input type="checkbox" class="gg-text-protect-spans"><span>Protect code &amp; URLs</span>
                        </label>
                    </div>
                </div>
                <div class="gg-text-rule-add">
                    <input type="text" class="text_pole gg-text-rule-add-input" spellcheck="false" placeholder="Nhập từ hoặc cụm từ…">
                    <button type="button" class="menu_button gg-text-rule-add-button" title="Add rule" aria-label="Add rule"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="gg-text-rule-list"></div>
                <div class="gg-text-sim">
                    <div class="gg-text-obfuscation-title"><i class="fa-solid fa-flask"></i> Filter test</div>
                    <div class="gg-text-rule-add">
                        <input type="text" class="text_pole gg-text-sim-input" spellcheck="false" placeholder="Nhập từ mẫu rồi bấm ▶ để thử qua các bộ lọc…">
                        <button type="button" class="menu_button gg-text-sim-button" title="Run filter test" aria-label="Run filter test"><i class="fa-solid fa-play"></i></button>
                    </div>
                    <div class="gg-text-sim-result"></div>
                </div>
                <div class="gg-text-obfuscation-meta"></div>
                <div class="gg-text-obfuscation-status"></div>
                <div class="gg-text-obfuscation-samples"></div>
            </div>`;

        const ubSection = document.getElementById('gg-native-ub-settings');
        if (ubSection?.parentElement === container) ubSection.insertAdjacentElement('afterend', section);
        else {
            // Keep the static hero first when the UB section is not mounted yet.
            const root = container.querySelector(':scope > .gg-settings-root');
            if (root) root.insertAdjacentElement('afterend', section);
            else container.insertBefore(section, container.firstChild);
        }

        this.section = section;
        this.enabledInput = section.querySelector('.gg-text-obfuscation-enable');
        this.markerSetSelect = section.querySelector('.gg-text-marker-set');
        this.homoglyphInput = section.querySelector('.gg-text-use-homoglyphs');
        this.stripIncomingInput = section.querySelector('.gg-text-strip-incoming');
        this.protectSpansInput = section.querySelector('.gg-text-protect-spans');
        this.addInput = section.querySelector('.gg-text-rule-add-input');
        this.addButton = section.querySelector('.gg-text-rule-add-button');
        this.ruleList = section.querySelector('.gg-text-rule-list');
        this.simInput = section.querySelector('.gg-text-sim-input');
        this.simButton = section.querySelector('.gg-text-sim-button');
        this.simResult = section.querySelector('.gg-text-sim-result');
        this.meta = section.querySelector('.gg-text-obfuscation-meta');
        this.status = section.querySelector('.gg-text-obfuscation-status');
        this.samples = section.querySelector('.gg-text-obfuscation-samples');

        for (const [key, set] of Object.entries(MARKER_SETS)) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = set.label;
            this.markerSetSelect.appendChild(option);
        }

        this.enabledInput.addEventListener('change', () => {
            const current = getTextObfuscationSettings();
            current.enabled = this.enabledInput.checked;
            saveTextObfuscationSettings(current);
            this.lastReport = null;
            this.renderState();
        });
        this.markerSetSelect.addEventListener('change', () => {
            const current = getTextObfuscationSettings();
            current.markerSet = this.markerSetSelect.value;
            saveTextObfuscationSettings(current);
            this.lastReport = null;
            this.renderState();
        });
        const saveToggle = (input, key) => {
            input.addEventListener('change', () => {
                const current = getTextObfuscationSettings();
                current[key] = input.checked;
                saveTextObfuscationSettings(current);
                this.lastReport = null;
                this.renderState();
            });
        };
        saveToggle(this.homoglyphInput, 'useHomoglyphs');
        saveToggle(this.stripIncomingInput, 'stripIncoming');
        saveToggle(this.protectSpansInput, 'protectSpans');

        this.addButton.addEventListener('click', () => this.addRule());
        this.addInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.addRule();
            }
        });
        this.simButton.addEventListener('click', () => this.runFilterTest());
        this.simInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.runFilterTest();
            }
        });

        this.renderState();
        return true;
    }

    addRule() {
        const pattern = String(this.addInput?.value ?? '').trim();
        if (!pattern) return;
        if (containsMarker(pattern)) {
            globalThis.toastr?.warning?.('Pattern không thể chứa sẵn ký tự vô hình (ZWSP/WJ/…).');
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

    runFilterTest() {
        const raw = String(this.simInput?.value ?? '').trim();
        this.simResult.replaceChildren();
        if (!raw) return;

        const settings = getTextObfuscationSettings();
        if (!settings.rules.length) {
            this.simResult.appendChild(createSimRow('warn', 'Chưa có rule nào để thử.', ''));
            return;
        }

        const matcher = buildMatcher(settings.rules, settings);
        if (!matcher) {
            this.simResult.appendChild(createSimRow('warn', 'Không dựng được matcher từ rule hiện tại.', ''));
            return;
        }

        const { transformed, stats } = transformTextWithStats(raw, matcher);
        const display = escapeZeroWidthForDisplay(transformed);
        if (!stats.replacements) {
            this.simResult.appendChild(createSimRow('warn', 'Không rule nào khớp mẫu này.', display));
            return;
        }

        const matchedRules = settings.rules.filter(rule => stats.ruleIds.has(rule.id));
        const survivingPattern = text => {
            for (const rule of matchedRules) {
                const found = rule.caseSensitive
                    ? text.includes(rule.pattern)
                    : text.toLowerCase().includes(rule.pattern.toLowerCase());
                if (found) return rule.pattern;
            }
            return '';
        };

        const stages = [
            ['Nguyên bản', transformed],
            ['Bỏ ký tự vô hình', transformed.replace(/\p{Cf}/gu, '')],
            ['NFKC + bỏ ký tự vô hình', transformed.normalize('NFKC').replace(/\p{Cf}/gu, '')],
            ['Gộp khoảng trắng + bỏ ký tự vô hình', transformed.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ')],
        ];
        for (const [label, text] of stages) {
            const hit = survivingPattern(text);
            this.simResult.appendChild(hit
                ? createSimRow('block', `${label}: vẫn còn “${hit}”`, '')
                : createSimRow('pass', `${label}: đã phá từ khóa`, ''));
        }

        this.simResult.appendChild(hasMixedScript(transformed)
            ? createSimRow('warn', 'Trộn bảng chữ Latin + Cyrillic/Greek — homoglyph có tác dụng nhưng máy có thể phát hiện.', '')
            : createSimRow('pass', 'Không trộn bảng chữ.', ''));
        this.simResult.appendChild(createSimRow(
            'pass',
            `${stats.replacements} chỗ đã biến đổi · ${stats.insertedMarkers} marker được chèn.`,
            display,
        ));
    }

    renderRules(rules, options) {
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
            const sample = obfuscateForRule(rule.pattern, rule, options);
            preview.textContent = `Preview: ${escapeZeroWidthForDisplay(sample)}`;

            card.append(head, options, preview);
            this.ruleList.appendChild(card);
        }
    }

    renderState() {
        if (!this.section?.isConnected) return;
        const settings = getTextObfuscationSettings();
        this.enabledInput.checked = settings.enabled;
        this.markerSetSelect.value = settings.markerSet;
        this.homoglyphInput.checked = settings.useHomoglyphs;
        this.stripIncomingInput.checked = settings.stripIncoming;
        this.protectSpansInput.checked = settings.protectSpans;
        this.renderRules(settings.rules, {
            markerSet: settings.markerSet,
            useHomoglyphs: settings.useHomoglyphs,
        });
        const setLabel = MARKER_SETS[settings.markerSet]?.label ?? settings.markerSet;
        const extras = [
            settings.useHomoglyphs ? 'homoglyphs on' : 'homoglyphs off',
            settings.protectSpans ? 'code/URL protected' : 'code/URL unprotected',
            settings.stripIncoming ? 'AI replies stripped' : 'AI replies kept',
        ].join(' · ');
        this.meta.textContent = `${settings.rules.length} rule(s) · longest phrase first · ${setLabel} · ${extras} · final-payload + network-dispatch verification enabled`;

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
        const dispatch = this.lastReport.dispatch;
        const verificationBad = verification?.status === 'failed' || verification?.status === 'unavailable';
        const dispatchBad = dispatch?.status === 'failed' || dispatch?.status === 'unavailable' || dispatch?.status === 'observed';
        if (verification?.status === 'verified' && !dispatchBad) this.status.classList.add('is-ok');
        else if (verificationBad || dispatchBad || this.lastReport.replacements === 0) this.status.classList.add('is-warn');

        const transformLine = `Last transform: ${this.lastReport.replacements} replacement(s) · ${this.lastReport.matchedPatterns} matched rule(s) · ${this.lastReport.textBlocks} text block(s)${protectedText}`;
        const verificationLine = describeVerification(verification);
        const dispatchLine = describeDispatch(dispatch);
        this.status.textContent = `${transformLine}\n${verificationLine}\n${dispatchLine}`;

        for (const sample of this.lastReport.samples ?? []) {
            const prefix = sample.pattern ? `${sample.pattern}: ` : '';
            this.samples.appendChild(createPill(`${prefix}${sample.before} → ${sample.after}`));
        }
    }
}
