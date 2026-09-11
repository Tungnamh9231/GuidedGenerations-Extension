import { ensureUbSettingsEntry } from './configPopup.js';
import { MessageToolbarController } from './messageToolbar.js';
import { MinorQolController } from './minorQol.js';
import { getUbSettings } from './store.js';
import { getEventBus } from './sillyTavernAdapter.js';

const RUNTIME_KEY = '__GG_NATIVE_UB_RUNTIME__';

function scheduleSettingsUi(controller, minorQol) {
    const attempts = [0, 300, 800, 1500, 3000, 6000];
    for (const delay of attempts) {
        setTimeout(() => {
            ensureUbSettingsEntry(() => controller.refresh());
            minorQol.ensureSettingsControls();
        }, delay);
    }
}

export function activateNativeUb() {
    if (globalThis[RUNTIME_KEY]?.active) return globalThis[RUNTIME_KEY];

    const controller = new MessageToolbarController();
    const minorQol = new MinorQolController();
    const runtime = {
        active: true,
        controller,
        minorQol,
        deactivate() {
            controller.destroy();
            minorQol.destroy();
            runtime.active = false;
            delete globalThis[RUNTIME_KEY];
        },
        refresh() {
            controller.refresh();
            ensureUbSettingsEntry(() => controller.refresh());
            minorQol.ensureSettingsControls();
        },
        settings() {
            return getUbSettings();
        },
    };
    globalThis[RUNTIME_KEY] = runtime;

    try {
        const { eventSource, eventTypes } = getEventBus();
        const start = () => {
            try {
                getUbSettings();
                controller.init();
                minorQol.init();
                scheduleSettingsUi(controller, minorQol);
            } catch (error) {
                console.error('[GG Native UB] Startup failed. Legacy GuidedGenerations remains active.', error);
            }
        };

        if (eventTypes?.APP_READY) eventSource.on(eventTypes.APP_READY, start);
        else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    } catch (error) {
        console.error('[GG Native UB] Could not attach to SillyTavern lifecycle.', error);
    }

    return runtime;
}
