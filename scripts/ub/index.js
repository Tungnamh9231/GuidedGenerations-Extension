import { ensureUbSettingsEntry } from './configPopup.js';
import { MessageToolbarController } from './messageToolbar.js';
import { getUbSettings } from './store.js';
import { getEventBus } from './sillyTavernAdapter.js';

const RUNTIME_KEY = '__GG_NATIVE_UB_RUNTIME__';

function scheduleSettingsUi(controller) {
    const attempts = [0, 300, 800, 1500, 3000, 6000];
    for (const delay of attempts) {
        setTimeout(() => ensureUbSettingsEntry(() => controller.refresh()), delay);
    }
}

export function activateNativeUb() {
    if (globalThis[RUNTIME_KEY]?.active) return globalThis[RUNTIME_KEY];

    const controller = new MessageToolbarController();
    const runtime = {
        active: true,
        controller,
        deactivate() {
            controller.destroy();
            runtime.active = false;
            delete globalThis[RUNTIME_KEY];
        },
        refresh() {
            controller.refresh();
            ensureUbSettingsEntry(() => controller.refresh());
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
                scheduleSettingsUi(controller);
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
