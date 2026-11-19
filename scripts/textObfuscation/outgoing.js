import { peekTextObfuscationSettings } from './store.js';
import {
    buildMatcher,
    transformChatInPlace,
    transformTextWithStats,
} from './transformer.js';

let matcherCacheKey = '';
let matcherCache = null;

function getMatcher(settings) {
    const options = {
        markerSet: settings.markerSet,
        strength: settings.strength,
        useHomoglyphs: settings.useHomoglyphs,
        protectSpans: settings.protectSpans,
    };
    let key = '';
    try {
        key = JSON.stringify({ rules: settings.rules ?? [], ...options });
    } catch {
        return buildMatcher(settings.rules, options);
    }
    if (key === matcherCacheKey) return matcherCache;
    matcherCacheKey = key;
    matcherCache = buildMatcher(settings.rules, options);
    return matcherCache;
}

/**
 * Apply Unicode Sensitive Words to a payload that is sent outside SillyTavern's
 * prompt-ready events (direct service calls from extension tools).
 */
export function applyOutgoingTextObfuscation({ messages = null, prompt = '' } = {}) {
    try {
        const settings = peekTextObfuscationSettings();
        if (!settings.enabled) return { messages, prompt, replacements: 0 };

        const matcher = getMatcher(settings);
        if (!matcher) return { messages, prompt, replacements: 0 };

        let replacements = 0;
        let nextMessages = messages;
        if (Array.isArray(messages) && messages.length) {
            const report = transformChatInPlace(messages, matcher);
            replacements += report.replacements;
            nextMessages = messages;
        }

        let nextPrompt = prompt;
        if (typeof prompt === 'string' && prompt) {
            const result = transformTextWithStats(prompt, matcher);
            nextPrompt = result.transformed;
            replacements += result.stats.replacements;
        }

        return { messages: nextMessages, prompt: nextPrompt, replacements };
    } catch (error) {
        console.warn('[GG Unicode Sensitive Words] Outgoing transform failed; sending the request unchanged.', error);
        return { messages, prompt, replacements: 0 };
    }
}