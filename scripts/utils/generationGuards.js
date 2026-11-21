/**
 * @file Shared helpers for tool generations that write card/intro text.
 *
 * Tools like Edit Intros and Edit Description isolate the chat before sending
 * their task prompt, so the request arrives with no scene behind it. These
 * helpers rebuild just enough context (character sheet, recent messages) to
 * keep the model in the story, and catch a refusal before it is written into a
 * message swipe or a character card.
 */

const DEFAULT_SCENE_LIMIT = 6;
const DEFAULT_SCENE_CHARS = 3000;
const DEFAULT_SHEET_FIELD_CHARS = 2200;

// A refusal that reaches the apply step would be saved as real content, so it
// is detected and reported instead. Only short replies whose opening line
// matches are treated as refusals, so in-dialogue "I can't" lines survive.
// A refusal has to name what it is refusing to do, otherwise in-dialogue lines
// such as "I can't believe you did that" would be thrown away as refusals.
const REFUSAL_PATTERNS = [
    /\bi (?:can(?:no|')t|can not|won't|will not|am unable to|'m not able to|'m unable to|must decline to)\b[^.!?]{0,60}\b(help|assist|write|create|provide|generate|produce|continue|rewrite|revise|comply|engage|participate|full?il)\b/,
    /\b(i|we) (?:must|have to|need to) decline\b/,
    /\bi(?:'m| am) (?:sorry|afraid), but\b/,
    /\bi apologis?e\b/,
    /\bas an ai\b/,
    /\bas a language model\b/,
    /\bi(?:'m| am) not (?:able|allowed|permitted) to\b/,
    /(?:t\u00f4i|m\u00ecnh|em) (?:kh\u00f4ng th\u1ec3|kh\u00f4ng \u0111\u01b0\u1ee3c ph\u00e9p)/,
    /kh\u00f4ng th\u1ec3 (?:h\u1ed7 tr\u1ee3|vi\u1ebft|t\u1ea1o|gi\u00fap|cung c\u1ea5p|ti\u1ebfp t\u1ee5c)/,
    /xin l\u1ed7i,? (?:nh\u01b0ng|v\u00ec)/,
];

/**
 * Join the fields of a character card into one block for the task prompt.
 * @param {object} character Character object from context.characters
 * @param {{fieldLimit?: number}} [options]
 * @returns {string}
 */
export function buildCharacterSheet(character, { fieldLimit = DEFAULT_SHEET_FIELD_CHARS } = {}) {
    const fields = [
        ['Description', character?.description],
        ['Personality', character?.personality],
        ['Scenario', character?.scenario],
        ['Example dialogue', character?.mes_example],
    ];
    const parts = [];
    for (const [label, value] of fields) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text) continue;
        parts.push(`${label}:\n${text.slice(0, fieldLimit)}`);
    }
    return parts.length ? parts.join('\n\n') : '(no character sheet available)';
}

function renderScene(context, messages, maxChars) {
    if (!messages.length) return '(no previous messages yet)';
    const lines = messages.map(message => {
        const name = message.name || (message.is_user ? (context?.name1 || 'User') : 'Character');
        return `${name}: ${message.mes.trim()}`;
    });
    const text = lines.join('\n\n');
    return text.length > maxChars ? text.slice(-maxChars) : text;
}

function usableMessages(messages) {
    return messages.filter(message => message && typeof message.mes === 'string' && message.mes.trim());
}

/**
 * Render the messages before `endIndex` (exclusive) as plain text. Used when a
 * tool rewrites one specific message: everything before it is the priming.
 * @param {object} context SillyTavern context
 * @param {number} endIndex Index of the message being rewritten
 * @param {{limit?: number, maxChars?: number}} [options]
 * @returns {string}
 */
export function buildSceneBefore(context, endIndex, { limit = DEFAULT_SCENE_LIMIT, maxChars = DEFAULT_SCENE_CHARS } = {}) {
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const stop = Number.isInteger(endIndex) ? Math.max(0, endIndex) : messages.length;
    const recent = usableMessages(messages.slice(0, stop)).slice(-limit);
    return renderScene(context, recent, maxChars);
}

/**
 * Render the last few chat messages as plain text. chat[0] (the greeting being
 * rewritten) is skipped because callers pass it separately.
 * @param {object} context SillyTavern context
 * @param {{limit?: number, maxChars?: number}} [options]
 * @returns {string}
 */
export function buildRecentScene(context, { limit = DEFAULT_SCENE_LIMIT, maxChars = DEFAULT_SCENE_CHARS } = {}) {
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const recent = usableMessages(messages.slice(1)).slice(-limit);
    return renderScene(context, recent, maxChars);
}

/**
 * True when a generated reply is a short refusal rather than task output.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeRefusal(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    // Dialogue and action beats can open with refusal-shaped words, so a reply
    // that starts in-scene is never treated as a refusal.
    if (/^["\u201c\u2018'*_(\[]/.test(raw)) return false;
    const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
    const head = normalized.slice(0, 400);
    const wordCount = normalized.split(' ').length;
    if (wordCount > 140) return false;
    return REFUSAL_PATTERNS.some(pattern => pattern.test(head));
}

/**
 * Remove wrappers a model tends to add around requested card text.
 * @param {string} text
 * @param {{stripLeadingLabel?: boolean}} [options]
 * @returns {string}
 */
export function sanitizeCardOutput(text, { stripLeadingLabel = true } = {}) {
    let out = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!out) return '';

    // Whole reply fenced, e.g. ```text ... ```
    const fenced = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
    if (fenced) out = fenced[1].trim();

    // Fence left on one end only
    out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    // "Here is the revised greeting:" style opener on its own line
    out = out.replace(/^(?:here(?:'s| is)|sure|certainly|below is|of course)\b[^\n]{0,80}:\s*\n+/i, '');

    // A bare label the model added that the prompt did not ask for
    if (stripLeadingLabel) {
        out = out.replace(/^(?:revised\s+|new\s+)?(?:character\s+)?(?:description|greeting|intro(?:duction)?|opening|world(?:\s+setting)?)\s*:\s*\n*/i, '');
    }

    // Trailing horizontal rule appended after the text
    out = out.replace(/\n+[-*_]{3,}\s*$/, '').trim();
    return out;
}
