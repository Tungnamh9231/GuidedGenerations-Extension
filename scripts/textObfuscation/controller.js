import { getContext } from '../../../../../extensions.js';
import { peekTextObfuscationSettings } from './store.js';
import { buildMatcher, transformChatInPlace, verifyFinalPayload } from './transformer.js';

const MAX_PENDING_VERIFICATIONS = 8;
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

function payloadSignature(text) {
    if (typeof text !== 'string') return null;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193);
        second ^= code;
        second = Math.imul(second, 0x85ebca6b);
    }
    return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function signatureForPayload(value) {
    try {
        return payloadSignature(JSON.stringify(value));
    } catch {
        return null;
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

export class TextObfuscationController {
    constructor(settingsView) {
        this.settingsView = settingsView;
        this.active = false;
        this.eventSource = null;
        this.promptEventType = null;
        this.settingsEventType = null;
        this.pendingVerifications = [];
        this.pendingDispatches = [];
        this.reportSerial = 0;
        this.latestReportId = 0;
        this.originalFetch = null;
        this.fetchWrapper = null;
        this.fetchObserverAvailable = false;
        this.handlePromptReady = this.handlePromptReady.bind(this);
        this.handleSettingsReady = this.handleSettingsReady.bind(this);
    }

    init() {
        if (this.active) return;
        const context = getContext();
        const eventSource = context.eventSource;
        const promptEventType = context.eventTypes?.CHAT_COMPLETION_PROMPT_READY;
        const settingsEventType = context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
        if (!eventSource || !promptEventType) throw new Error('CHAT_COMPLETION_PROMPT_READY is unavailable.');

        eventSource.on(promptEventType, this.handlePromptReady);
        if (settingsEventType) eventSource.on(settingsEventType, this.handleSettingsReady);
        else console.warn('[GG Unicode Sensitive Words] CHAT_COMPLETION_SETTINGS_READY is unavailable; final payload verification is disabled.');

        this.eventSource = eventSource;
        this.promptEventType = promptEventType;
        this.settingsEventType = settingsEventType ?? null;
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

            // Call the real fetch first. Reaching the observer below therefore means the
            // browser accepted the normal fetch invocation; this wrapper never changes args.
            const result = Reflect.apply(originalFetch, this, args);

            if (shouldObserve) {
                if (bodyText !== null) {
                    controller.handleNetworkDispatch(bodyText);
                } else if (requestBodyPromise) {
                    requestBodyPromise
                        .then(text => controller.handleNetworkDispatch(text))
                        .catch(error => controller.handleNetworkDispatch(null, String(error?.message ?? error)));
                } else {
                    controller.handleNetworkDispatch(null, 'outgoing request body is unavailable');
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
            this.detach(this.settingsEventType, this.handleSettingsReady);
        } catch (error) {
            console.debug('[GG Unicode Sensitive Words] Could not detach prompt listeners.', error);
        }
        this.uninstallFetchObserver();
        this.eventSource = null;
        this.promptEventType = null;
        this.settingsEventType = null;
        this.pendingVerifications = [];
        this.pendingDispatches = [];
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
                chatRef,
            });
            if (this.pendingVerifications.length > MAX_PENDING_VERIFICATIONS) this.pendingVerifications.shift();
        }

        this.safeSetLastReport(publicReport);
    }

    handlePromptReady(eventData) {
        try {
            const settings = peekTextObfuscationSettings();
            if (!settings.enabled) return;

            const matcher = buildMatcher(settings.rules);
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

    handleSettingsReady(generateData) {
        try {
            if (!this.pendingVerifications.length) return;

            const candidates = this.pendingVerifications.map((pending, index) => ({
                index,
                pending,
                result: verifyFinalPayload(generateData, pending.plan),
            }));

            // Strongest correlation: SillyTavern normally carries the same messages array
            // from CHAT_COMPLETION_PROMPT_READY into generate_data.messages.
            let selected = candidates.find(candidate => candidate.pending.chatRef === generateData?.messages);
            let correlation = selected ? 'identity' : null;

            // Fallback for providers/paths that rebuild the messages array: correlate using
            // the transformed block fingerprints, preferring a full verification match.
            if (!selected) {
                selected = candidates.find(candidate => candidate.result.status === 'verified');
                if (selected) correlation = 'fingerprint';
            }
            if (!selected) {
                const ranked = candidates
                    .filter(candidate => candidate.result.status !== 'unavailable')
                    .sort((a, b) => (b.result.matchedBlocks ?? 0) - (a.result.matchedBlocks ?? 0));
                if ((ranked[0]?.result?.matchedBlocks ?? 0) > 0) {
                    selected = ranked[0];
                    correlation = 'fingerprint';
                }
            }
            if (!selected && candidates.length === 1) {
                selected = candidates[0];
                correlation = 'queue';
            }
            if (!selected) return;

            this.pendingVerifications.splice(selected.index, 1);
            const verification = {
                ...normalizeVerificationResult(selected.result),
                correlation,
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
                    payloadSignature: signatureForPayload(generateData),
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
                        reason: bodyError ?? 'request body is unavailable',
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

            const outgoingSignature = payloadSignature(bodyText);
            const candidates = this.pendingDispatches.map((pending, index) => ({
                index,
                pending,
                signatureMatch: Boolean(pending.payloadSignature && pending.payloadSignature === outgoingSignature),
                result: payload ? verifyFinalPayload(payload, pending.plan) : null,
            }));

            let selected = candidates.find(candidate => candidate.signatureMatch);
            let correlation = selected ? 'serialized' : null;
            if (!selected && payload) {
                selected = candidates.find(candidate => candidate.result?.status === 'verified');
                if (selected) correlation = 'fingerprint';
            }
            if (!selected && payload) {
                const ranked = candidates
                    .filter(candidate => candidate.result?.status && candidate.result.status !== 'unavailable')
                    .sort((a, b) => (b.result?.matchedBlocks ?? 0) - (a.result?.matchedBlocks ?? 0));
                if ((ranked[0]?.result?.matchedBlocks ?? 0) > 0) {
                    selected = ranked[0];
                    correlation = 'fingerprint';
                }
            }
            if (!selected && candidates.length === 1) {
                selected = candidates[0];
                correlation = 'queue';
            }
            if (!selected) return;

            this.pendingDispatches.splice(selected.index, 1);
            let dispatch;
            if (!payload) {
                dispatch = {
                    status: 'observed',
                    correlation,
                    reason: parseError ? `fetch body is not parseable JSON (${parseError})` : 'fetch body is unavailable',
                };
            } else {
                const normalized = normalizeVerificationResult(selected.result);
                dispatch = {
                    ...normalized,
                    status: normalized.status === 'verified' ? 'verified' : normalized.status,
                    correlation,
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
