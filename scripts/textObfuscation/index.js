import { getContext } from '../../../../../extensions.js';
import { RUNTIME_KEY } from './constants.js';
import { TextObfuscationController } from './controller.js';
import { TextObfuscationSettingsView } from './settings.js';
import { getTextObfuscationSettings } from './store.js';

function scheduleSettingsUi(view) {
    const attempts = [0, 300, 800, 1500, 3000, 6000];
    for (const delay of attempts) {
        setTimeout(() => {
            try {
                view.ensure();
            } catch (error) {
                console.debug('[GG Unicode Sensitive Words] Settings UI is not ready yet.', error);
            }
        }, delay);
    }
}

export function activateTextObfuscation() {
    if (globalThis[RUNTIME_KEY]?.active) return globalThis[RUNTIME_KEY];

    const settingsView = new TextObfuscationSettingsView();
    const controller = new TextObfuscationController(settingsView);
    let appReadyHandler = null;

    const runtime = {
        active: true,
        controller,
        settingsView,
        deactivate() {
            controller.destroy();
            try {
                const context = getContext();
                if (appReadyHandler && typeof context.eventSource?.off === 'function') {
                    context.eventSource.off(context.eventTypes?.APP_READY, appReadyHandler);
                } else if (appReadyHandler && typeof context.eventSource?.removeListener === 'function') {
                    context.eventSource.removeListener(context.eventTypes?.APP_READY, appReadyHandler);
                }
            } catch (error) {
                console.debug('[GG Unicode Sensitive Words] Could not detach APP_READY listener.', error);
            }
            settingsView.destroy();
            runtime.active = false;
            delete globalThis[RUNTIME_KEY];
        },
        refresh() {
            settingsView.ensure();
        },
        settings() {
            return getTextObfuscationSettings();
        },
    };
    globalThis[RUNTIME_KEY] = runtime;

    try {
        controller.init();
        scheduleSettingsUi(settingsView);

        const context = getContext();
        if (context.eventTypes?.APP_READY) {
            appReadyHandler = () => {
                settingsView.ensure();
                scheduleSettingsUi(settingsView);
            };
            context.eventSource.on(context.eventTypes.APP_READY, appReadyHandler);
        }
    } catch (error) {
        runtime.active = false;
        delete globalThis[RUNTIME_KEY];
        console.error('[GG Unicode Sensitive Words] Startup failed.', error);
        throw error;
    }

    return runtime;
}
