import { getContext } from '../../../../../extensions.js';
import { peekTextObfuscationSettings } from './store.js';
import { buildMatcher, transformChatInPlace, verifyFinalPayload } from './transformer.js';

const MAX_PENDING_VERIFICATIONS = 8;

export class TextObfuscationController {
    constructor(settingsView) {
        this.settingsView = settingsView;
        this.active = false;
        this.eventSource = null;
        this.promptEventType = null;
        this.settingsEventType = null;
        this.pendingVerifications = [];
        this.reportSerial = 0;
        this.latestReportId = 0;
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
        this.active = true;
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
        this.eventSource = null;
        this.promptEventType = null;
        this.settingsEventType = null;
        this.pendingVerifications = [];
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

    publishReport(report, verificationPlan) {
        const reportId = ++this.reportSerial;
        this.latestReportId = reportId;
        const publicReport = { ...report, reportId };

        if (!report.replacements) {
            publicReport.verification = { status: 'not_needed' };
        } else if (!this.settingsEventType) {
            publicReport.verification = {
                status: 'unavailable',
                reason: 'CHAT_COMPLETION_SETTINGS_READY is unavailable',
            };
        } else if (!verificationPlan?.fragments?.length) {
            publicReport.verification = {
                status: 'unavailable',
                reason: 'verification plan is empty',
            };
        } else {
            publicReport.verification = {
                status: 'pending',
                expectedOccurrences: verificationPlan.fragments.reduce((sum, fragment) => sum + (fragment.count ?? 0), 0),
                expectedMarkers: verificationPlan.expectedMarkers ?? 0,
            };
            this.pendingVerifications.push({
                reportId,
                report: publicReport,
                plan: verificationPlan,
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
                    }, null);
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
            this.publishReport(report, verificationPlan);
        } catch (error) {
            // Never let an optional text transform break SillyTavern generation.
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

            // A positive fragment match is a stronger correlation signal than queue order
            // if two extension-driven generations ever overlap.
            let selected = candidates.find(candidate => candidate.result.status === 'verified');
            if (!selected) {
                const ranked = candidates
                    .filter(candidate => candidate.result.status !== 'unavailable')
                    .sort((a, b) => (b.result.matchedOccurrences ?? 0) - (a.result.matchedOccurrences ?? 0));
                if ((ranked[0]?.result?.matchedOccurrences ?? 0) > 0) selected = ranked[0];
            }
            if (!selected && candidates.length === 1) selected = candidates[0];
            if (!selected) return;

            this.pendingVerifications.splice(selected.index, 1);
            const nextReport = {
                ...selected.pending.report,
                verification: selected.result,
            };
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
}
