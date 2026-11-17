import { getContext } from '../../../../../extensions.js';
import { peekTextObfuscationSettings } from './store.js';
import {
    buildMatcher,
    stripMarkersFromText,
    transformChatInPlace,
    transformTextWithStats,
    verifyFinalPayload,
} from './transformer.js';

// Keep correlation history deliberately small. Each pending entry can contain a
// verification plan with transformed chat text, so a large queue retains a lot
// of memory on long chats and multiplies fallback verification work.
const MAX_PENDING_VERIFICATIONS = 3;
const CHAT_COMPLETION_ENDPOINT = '/api/backends/chat-completions/generate';

function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    return typeof input?.url === 'string' ? input.url : '';
}

function isChatCompletionRequest(input) {
    const rawUrl = getRequestUrl(input);
    if (!rawUrl) return false;
    try {
        const base = globalThis.location?.href ?? 'http://localhost/';
        return new URL(rawUrl, base).pathname === CHAT_COMPLETION_ENDPOINT;
    } catch {
        return rawUrl.includes(CHAT_COMPLETION_ENDPOINT);
    }
}

function normalizeVerificationResult(result) {
    return {
        ...result,
        expectedOccurrences: result?.expectedBlocks ?? 0,
        matchedOccurrences: result?.matchedBlocks ?? 0,
        missingOccurrences: result?.missingBlocks ?? 0,
    };
}

function createWeakReference(value) {
    if (value && typeof value === 'object' && typeof WeakRef === 'function') {
        try {
            return new WeakRef(value);
        } catch {
            // Fall back to a strong reference below.
        }
    }
    return value;
}

function dereference(value) {
    if (value && typeof value.deref === 'function') {
        try {
            return value.deref();
        } catch {
            return undefined;
        }
    }
    return value;
}

/**
 * Select a pending correlation candidate without eagerly verifying every entry.
 * The newest pending request is checked first because SillyTavern's completion
 * events are normally ordered. We stop immediately on a full verification match
 * and otherwise keep only the best partial match.
 */
function selectByVerification(pendingItems, payload) {
    if (!pendingItems.length) return null;

    if (pendingItems.length === 1) {
        return {
            index: 0,
            pending: pendingItems[0],
            result: verifyFinalPayload(payload, pendingItems[0].plan),
            correlation: 'queue',
        };
    }

    let best = null;
    for (let index = pendingItems.length - 1; index >= 0; index -= 1) {
        const pending = pendingItems[index];
        const result = verifyFinalPayload(payload, pending.plan);
        if (result.status === 'verified') {
            return { index, pending, result, correlation: 'fingerprint' };
        }
        if (result.status === 'unavailable') continue;
        if (!best || (result.matchedBlocks ?? 0) > (best.result.matchedBlocks ?? 0)) {
            best = { index, pending, result, correlation: 'fingerprint' };
        }
    }

    return (best?.result?.matchedBlocks ?? 0) > 0 ? best : null;
}

export class TextObfuscationController {
    constructor(settingsView) {
        this.settingsView = settingsView;
        this.active = false;
        this.eventSource = null;
        this.promptEventType = null;
        this.textPromptEventType = null;
        this.settingsEventType = null;
        this.messageReceivedType = null;
        this.messageSwipedType = null;
        this.pendingVerifications = [];
        this.pendingDispatches = [];
        this.reportSerial = 0;
        this.latestReportId = 0;
        this.originalFetch = null;
        this.fetchWrapper = null;
        this.fetchObserverAvailable = false;
        this.matcherCacheKey = '';
        this.matcherCache = null;
        this.handlePromptReady = this.handlePromptReady.bind(this);
        this.handleTextPromptReady = this.handleTextPromptReady.bind(this);
        this.handleSettingsReady = this.handleSettingsReady.bind(this);
        this.handleMessageReceived = this.handleMessageReceived.bind(this);
        this.handleMessageSwiped = this.handleMessageSwiped.bind(this);
    }

    init() {
        if (this.active) return;
        const context = getContext();
        const eventSource = context.eventSource;
        const promptEventType = context.eventTypes?.CHAT_COMPLETION_PROMPT_READY;
        const textPromptEventType = context.eventTypes?.GENERATE_AFTER_COMBINE_PROMPTS;
        const settingsEventType = context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
        if (!eventSource || !promptEventType) throw new Error('CHAT_COMPLETION_PROMPT_READY is unavailable.');

        eventSource.on(promptEventType, this.handlePromptReady);
        if (textPromptEventType) eventSource.on(textPromptEventType, this.handleTextPromptReady);
        if (settingsEventType) eventSource.on(settingsEventType, this.handleSettingsReady);
        else console.warn('[GG Unicode Sensitive Words] CHAT_COMPLETION_SETTINGS_READY is unavailable; final payload verification is disabled.');

        const receivedType = context.eventTypes?.MESSAGE_RECEIVED;
        const swipedType = context.eventTypes?.MESSAGE_SWIPED;
        if (receivedType) eventSource.on(receivedType, this.handleMessageReceived);
        if (swipedType) eventSource.on(swipedType, this.handleMessageSwiped);

        this.eventSource = eventSource;
        this.promptEventType = promptEventType;
        this.textPromptEventType = textPromptEventType ?? null;
        this.settingsEventType = settingsEventType ?? null;
        this.messageReceivedType = receivedType ?? null;
        this.messageSwipedType = swipedType ?? null;
        this.installFetchObserver();
        this.active = true;
    }

    installFetchObserver() {
        const originalFetch = globalThis.fetch;
        if (typeof originalFetch !== 'function') {
            this.fetchObserverAvailable = false;
            console.warn('[GG Unicode Sensitive Words] fetch is unavailable; network dispatch verification is disabled.');
            return;
        }

        const controller = this;
        const wrapper = function (...args) {
            const [input, init] = args;
            const shouldObserve = isChatCompletionRequest(input);
            let bodyText = typeof init?.body === 'string' ? init.body : null;
            let requestBodyPromise = null;

            if (shouldObserve && bodyText === null && typeof Request !== 'undefined' && input instanceof Request) {
                try {
                    requestBodyPromise = input.clone().text();
                } catch (error) {
                    console.debug('[GG Unicode Sensitive Words] Could not clone outgoing Request body.', error);
                }
            }

            // Dispatch first and keep verification off the synchronous fetch hot path.
            // The observer never changes request arguments or the returned promise.
            const result = Reflect.apply(originalFetch, this, args);

            if (shouldObserve) {
                if (bodyText !== null) {
                    setTimeout(() => controller.handleNetworkDispatch(bodyText), 0);
                } else if (requestBodyPromise) {
                    requestBodyPromise
                        .then(text => setTimeout(() => controller.handleNetworkDispatch(text), 0))
                        .catch(error => setTimeout(() => controller.handleNetworkDispatch(null, String(error?.message ?? error)), 0));
                } else {
                    setTimeout(() => controller.handleNetworkDispatch(null, 'outgoing request body is unavailable'), 0);
                }
            }

            return result;
        };

        this.originalFetch = originalFetch;
        this.fetchWrapper = wrapper;
        globalThis.fetch = wrapper;
        this.fetchObserverAvailable = globalThis.fetch === wrapper;
    }

    uninstallFetchObserver() {
        if (this.fetchWrapper && globalThis.fetch === this.fetchWrapper && this.originalFetch) {
            globalThis.fetch = this.originalFetch;
        }
        this.originalFetch = null;
        this.fetchWrapper = null;
        this.fetchObserverAvailable = false;
    }

    detach(eventType, handler) {
        if (!eventType) return;
        if (typeof this.eventSource?.off === 'function') this.eventSource.off(eventType, handler);
        else if (typeof this.eventSource?.removeListener === 'function') this.eventSource.removeListener(eventType, handler);
    }

    destroy() {
        if (!this.active) return;
        try {
            this.detach(this.promptEventType, this.handlePromptReady);
            this.detach(this.textPromptEventType, this.handleTextPromptReady);
            this.detach(this.settingsEventType, this.handleSettingsReady);
            this.detach(this.messageReceivedType, this.handleMessageReceived);
            this.detach(this.messageSwipedType, this.handleMessageSwiped);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Could not detach prompt listeners.', error);
        }
        this.uninstallFetchObserver();
        this.eventSource = null;
        this.promptEventType = null;
        this.textPromptEventType = null;
        this.settingsEventType = null;
        this.messageReceivedType = null;
        this.messageSwipedType = null;
        this.pendingVerifications = [];
        this.pendingDispatches = [];
        this.matcherCacheKey = '';
        this.matcherCache = null;
        this.active = false;
    }

    safeSetLastReport(report) {
        try {
            this.settingsView?.setLastReport(report);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Could not update transform report UI.', error);
        }
    }

    publishError(error) {
        const reportId = ++this.reportSerial;
        this.latestReportId = reportId;
        this.safeSetLastReport({
            reportId,
            error: String(error?.message ?? error),
            samples: [],
        });
    }

    publishTextReport(report) {
        const reportId = ++this.reportSerial;
        this.latestReportId = reportId;
        this.safeSetLastReport({
            ...report,
            reportId,
            verification: { status: 'not_needed' },
            dispatch: { status: 'not_needed' },
        });
    }

    getMatcher(settings) {
        const options = {
            markerSet: settings.markerSet,
            useHomoglyphs: settings.useHomoglyphs,
            protectSpans: settings.protectSpans,
        };
        let key = '';
        try {
            key = JSON.stringify({ rules: settings.rules ?? [], ...options });
        } catch {
            return buildMatcher(settings.rules, options);
        }
        if (key === this.matcherCacheKey) return this.matcherCache;
        this.matcherCacheKey = key;
        this.matcherCache = buildMatcher(settings.rules, options);
        return this.matcherCache;
    }

    publishReport(report, verificationPlan, chatRef) {
        const reportId = ++this.reportSerial;
        this.latestReportId = reportId;
        const publicReport = { ...report, reportId };

        if (!report.replacements) {
            publicReport.verification = { status: 'not_needed' };
            publicReport.dispatch = { status: 'not_needed' };
        } else if (!this.settingsEventType) {
            publicReport.verification = {
                status: 'unavailable',
                reason: 'CHAT_COMPLETION_SETTINGS_READY is unavailable',
            };
            publicReport.dispatch = {
                status: 'unavailable',
                reason: 'final payload correlation stage is unavailable',
            };
        } else if (!verificationPlan?.blocks?.length) {
            publicReport.verification = {
                status: 'unavailable',
                reason: 'verification plan is empty',
            };
            publicReport.dispatch = {
                status: 'unavailable',
                reason: 'verification plan is empty',
            };
        } else {
            const expectedBlocks = verificationPlan.blocks.reduce((sum, block) => sum + (block.count ?? 0), 0);
            publicReport.verification = {
                status: 'pending',
                expectedBlocks,
                expectedOccurrences: expectedBlocks,
                expectedMarkers: verificationPlan.expectedMarkers ?? 0,
            };
            publicReport.dispatch = this.fetchObserverAvailable
                ? {
                    status: 'pending',
                    expectedOccurrences: expectedBlocks,
                    expectedMarkers: verificationPlan.expectedMarkers ?? 0,
                }
                : {
                    status: 'unavailable',
                    reason: 'fetch observer is unavailable',
                };
            this.pendingVerifications.push({
                reportId,
                report: publicReport,
                plan: verificationPlan,
                // Avoid pinning a complete prompt/messages array in memory solely
                // for identity correlation when WeakRef is available.
                chatRef: createWeakReference(chatRef),
            });
            if (this.pendingVerifications.length > MAX_PENDING_VERIFICATIONS) this.pendingVerifications.shift();
        }

        this.safeSetLastReport(publicReport);
    }

    handlePromptReady(eventData) {
        try {
            const settings = peekTextObfuscationSettings();
            if (!settings.enabled) return;

            const matcher = this.getMatcher(settings);
            if (!matcher) {
                if (!eventData?.dryRun) {
                    this.publishReport({
                        activePatterns: 0,
                        replacements: 0,
                        matchedPatterns: 0,
                        textBlocks: 0,
                        protectedMessages: 0,
                        insertedMarkers: 0,
                        samples: [],
                    }, null, eventData?.chat);
                }
                return;
            }

            if (!Array.isArray(eventData?.chat)) {
                if (!eventData?.dryRun) this.publishError('chat payload is unavailable');
                return;
            }

            const report = transformChatInPlace(eventData.chat, matcher);
            if (eventData.dryRun) return;

            const verificationPlan = report.verificationPlan;
            delete report.verificationPlan;
            this.publishReport(report, verificationPlan, eventData.chat);
        } catch (error) {
            console.error('[GG Unicode Sensitive Words] Transform failed; continuing with SillyTavern pipeline.', error);
            if (!eventData?.dryRun) this.publishError(error);
        }
    }

    handleTextPromptReady(eventData) {
        try {
            const settings = peekTextObfuscationSettings();
            if (!settings.enabled) return;
            if (typeof eventData?.prompt !== 'string' || !eventData.prompt) return;

            const matcher = this.getMatcher(settings);
            if (!matcher) return;

            const { transformed, stats } = transformTextWithStats(eventData.prompt, matcher);
            if (transformed === eventData.prompt) return;
            eventData.prompt = transformed;
            if (eventData.dryRun) return;

            this.publishTextReport({
                activePatterns: matcher.rules.length,
                replacements: stats.replacements,
                matchedPatterns: stats.ruleIds.size,
                textBlocks: 1,
                protectedMessages: 0,
                insertedMarkers: stats.insertedMarkers,
                samples: stats.samples,
            });
        } catch (error) {
            console.error('[GG Unicode Sensitive Words] Text prompt transform failed; continuing with SillyTavern pipeline.', error);
        }
    }

    handleSettingsReady(generateData) {
        try {
            if (!this.pendingVerifications.length) return;

            // Fast path: identity correlation costs no payload scan. Only verify
            // the matching pending entry instead of eagerly verifying the entire queue.
            const identityIndex = this.pendingVerifications.findIndex(
                pending => dereference(pending.chatRef) === generateData?.messages
            );

            let selected = null;
            if (identityIndex >= 0) {
                const pending = this.pendingVerifications[identityIndex];
                selected = {
                    index: identityIndex,
                    pending,
                    result: verifyFinalPayload(generateData, pending.plan),
                    correlation: 'identity',
                };
            } else {
                selected = selectByVerification(this.pendingVerifications, generateData);
            }
            if (!selected) return;

            this.pendingVerifications.splice(selected.index, 1);
            const verification = {
                ...normalizeVerificationResult(selected.result),
                correlation: selected.correlation,
            };
            const nextReport = {
                ...selected.pending.report,
                verification,
            };

            if (this.fetchObserverAvailable && selected.pending.plan?.blocks?.length) {
                this.pendingDispatches.push({
                    reportId: selected.pending.reportId,
                    report: nextReport,
                    plan: selected.pending.plan,
                });
                if (this.pendingDispatches.length > MAX_PENDING_VERIFICATIONS) this.pendingDispatches.shift();
            }

            if (selected.pending.reportId === this.latestReportId) this.safeSetLastReport(nextReport);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Final payload verification failed safely.', error);
            const pending = this.pendingVerifications.shift();
            if (!pending || pending.reportId !== this.latestReportId) return;
            this.safeSetLastReport({
                ...pending.report,
                verification: {
                    status: 'unavailable',
                    reason: String(error?.message ?? error),
                },
            });
        }
    }

    handleMessageReceived(payload) {
        this.stripIncomingMessage(payload);
    }

    handleMessageSwiped(payload) {
        this.stripIncomingMessage(payload);
    }

    resolveMessageIndex(payload) {
        if (Number.isInteger(payload)) return payload;
        if (payload && typeof payload === 'object') {
            for (const key of ['messageId', 'messageIndex', 'index', 'id']) {
                if (Number.isInteger(payload[key])) return payload[key];
            }
        }
        return -1;
    }

    stripIncomingMessage(payload) {
        try {
            const settings = peekTextObfuscationSettings();
            if (!settings.enabled || !settings.stripIncoming) return;

            const index = this.resolveMessageIndex(payload);
            if (index < 0) return;

            const context = getContext();
            const message = context.chat?.[index];
            if (!message || typeof message !== 'object') return;

            let changed = false;
            if (typeof message.mes === 'string') {
                const cleaned = stripMarkersFromText(message.mes);
                if (cleaned !== message.mes) {
                    message.mes = cleaned;
                    changed = true;
                }
            }
            if (Array.isArray(message.swipes)) {
                for (let swipeIndex = 0; swipeIndex < message.swipes.length; swipeIndex += 1) {
                    const swipe = message.swipes[swipeIndex];
                    if (typeof swipe !== 'string') continue;
                    const cleaned = stripMarkersFromText(swipe);
                    if (cleaned !== swipe) {
                        message.swipes[swipeIndex] = cleaned;
                        changed = true;
                    }
                }
            }
            if (!changed) return;

            context.saveChatDebounced?.();
            const textElement = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
            if (textElement) {
                const cleanedHtml = stripMarkersFromText(textElement.innerHTML);
                if (cleanedHtml !== textElement.innerHTML) textElement.innerHTML = cleanedHtml;
            }
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Incoming marker cleanup failed safely.', error);
        }
    }

    handleNetworkDispatch(bodyText, bodyError = null) {
        try {
            if (!this.pendingDispatches.length) return;

            if (typeof bodyText !== 'string') {
                if (this.pendingDispatches.length !== 1) return;
                const pending = this.pendingDispatches.shift();
                const nextReport = {
                    ...pending.report,
                    dispatch: {
                        status: 'observed',
                        reason: bodyError ?? 'outgoing request body is unavailable',
                    },
                };
                if (pending.reportId === this.latestReportId) this.safeSetLastReport(nextReport);
                return;
            }

            let payload = null;
            let parseError = null;
            try {
                payload = JSON.parse(bodyText);
            } catch (error) {
                parseError = String(error?.message ?? error);
            }

            let selected = null;
            if (payload) selected = selectByVerification(this.pendingDispatches, payload);
            if (!selected && this.pendingDispatches.length === 1) {
                const pending = this.pendingDispatches[0];
                selected = {
                    index: 0,
                    pending,
                    result: payload ? verifyFinalPayload(payload, pending.plan) : null,
                    correlation: 'queue',
                };
            }
            if (!selected) return;

            this.pendingDispatches.splice(selected.index, 1);
            let dispatch;
            if (!payload) {
                dispatch = {
                    status: 'observed',
                    correlation: selected.correlation,
                    reason: parseError ? `fetch body is not parseable JSON (${parseError})` : 'fetch body is unavailable',
                };
            } else {
                const normalized = normalizeVerificationResult(selected.result);
                dispatch = {
                    ...normalized,
                    status: normalized.status === 'verified' ? 'verified' : normalized.status,
                    correlation: selected.correlation,
                    endpoint: CHAT_COMPLETION_ENDPOINT,
                };
            }

            const nextReport = {
                ...selected.pending.report,
                dispatch,
            };
            if (selected.pending.reportId === this.latestReportId) this.safeSetLastReport(nextReport);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Network dispatch verification failed safely.', error);
            const pending = this.pendingDispatches.shift();
            if (!pending || pending.reportId !== this.latestReportId) return;
            this.safeSetLastReport({
                ...pending.report,
                dispatch: {
                    status: 'observed',
                    reason: String(error?.message ?? error),
                },
            });
        }
    }
}
