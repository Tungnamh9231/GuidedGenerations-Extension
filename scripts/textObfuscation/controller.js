import { getContext } from '../../../../../extensions.js';
import { peekTextObfuscationSettings } from './store.js';
import { buildMatcher, transformChatInPlace } from './transformer.js';

export class TextObfuscationController {
    constructor(settingsView) {
        this.settingsView = settingsView;
        this.active = false;
        this.eventSource = null;
        this.eventType = null;
        this.handlePromptReady = this.handlePromptReady.bind(this);
    }

    init() {
        if (this.active) return;
        const context = getContext();
        const eventSource = context.eventSource;
        const eventType = context.eventTypes?.CHAT_COMPLETION_PROMPT_READY;
        if (!eventSource || !eventType) throw new Error('CHAT_COMPLETION_PROMPT_READY is unavailable.');

        eventSource.on(eventType, this.handlePromptReady);
        this.eventSource = eventSource;
        this.eventType = eventType;
        this.active = true;
    }

    destroy() {
        if (!this.active) return;
        try {
            if (typeof this.eventSource?.off === 'function') this.eventSource.off(this.eventType, this.handlePromptReady);
            else if (typeof this.eventSource?.removeListener === 'function') this.eventSource.removeListener(this.eventType, this.handlePromptReady);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Could not detach prompt listener.', error);
        }
        this.eventSource = null;
        this.eventType = null;
        this.active = false;
    }

    safeSetLastReport(report) {
        try {
            this.settingsView?.setLastReport(report);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Could not update transform report UI.', error);
        }
    }

    handlePromptReady(eventData) {
        try {
            const settings = peekTextObfuscationSettings();
            if (!settings.enabled) return;

            const matcher = buildMatcher(settings.patternsText);
            if (!matcher) {
                if (!eventData?.dryRun) {
                    this.safeSetLastReport({
                        activePatterns: 0,
                        replacements: 0,
                        matchedPatterns: 0,
                        textBlocks: 0,
                        protectedMessages: 0,
                        samples: [],
                    });
                }
                return;
            }

            if (!Array.isArray(eventData?.chat)) {
                if (!eventData?.dryRun) this.safeSetLastReport({ error: 'chat payload is unavailable', samples: [] });
                return;
            }

            const report = transformChatInPlace(eventData.chat, matcher);
            if (!eventData.dryRun) this.safeSetLastReport(report);
        } catch (error) {
            // Never let an optional text transform break SillyTavern generation.
            console.error('[GG Unicode Sensitive Words] Transform failed; continuing with SillyTavern pipeline.', error);
            if (!eventData?.dryRun) this.safeSetLastReport({ error: String(error?.message ?? error), samples: [] });
        }
    }
}
