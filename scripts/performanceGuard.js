// Performance compatibility guard for legacy code in index.js.
//
// The legacy QR integration creates a MutationObserver from
// setupQRMutationObserver() and asks it to watch document.body with subtree:true.
// On an active SillyTavern chat that observer receives essentially every DOM
// insertion made by streaming/rendering, even though it only cares about #qr--bar.
// Keep legacy behavior but transparently scope that one observer to #send_form.
// Other SillyTavern/extensions observers are left completely untouched.

const GUARD_KEY = '__GG_LEGACY_MUTATION_OBSERVER_GUARD__';
const NativeMutationObserver = globalThis.MutationObserver;

if (!globalThis[GUARD_KEY] && typeof NativeMutationObserver === 'function') {
    const nativeObserve = NativeMutationObserver.prototype.observe;

    class GuidedGenerationsMutationObserver extends NativeMutationObserver {
        constructor(callback) {
            const stack = String(new Error().stack ?? '');
            super(callback);
            this.__ggScopeLegacyQrObserver =
                stack.includes('GuidedGenerations-Extension/index.js')
                && stack.includes('setupQRMutationObserver');
            this.__ggDeferredObserveTimer = null;
        }

        observe(target, options) {
            const isLegacyBodyWatch = this.__ggScopeLegacyQrObserver
                && target === document.body
                && options?.childList === true
                && options?.subtree === true;

            if (!isLegacyBodyWatch) {
                return nativeObserve.call(this, target, options);
            }

            const observeSendForm = () => {
                const sendForm = document.getElementById('send_form');
                if (!sendForm) return false;
                nativeObserve.call(this, sendForm, options);
                return true;
            };

            // In normal ST startup #send_form already exists by the time the legacy
            // observer is created. If it does not, retry briefly instead of falling
            // back to a permanent whole-document subtree observer.
            if (observeSendForm()) return;

            let attempts = 0;
            this.__ggDeferredObserveTimer = setInterval(() => {
                attempts += 1;
                if (observeSendForm() || attempts >= 40) {
                    clearInterval(this.__ggDeferredObserveTimer);
                    this.__ggDeferredObserveTimer = null;
                }
            }, 250);
        }

        disconnect() {
            if (this.__ggDeferredObserveTimer) {
                clearInterval(this.__ggDeferredObserveTimer);
                this.__ggDeferredObserveTimer = null;
            }
            return super.disconnect();
        }
    }

    globalThis[GUARD_KEY] = {
        native: NativeMutationObserver,
        wrapper: GuidedGenerationsMutationObserver,
    };
    globalThis.MutationObserver = GuidedGenerationsMutationObserver;

    // index.js creates its QR observers from document.ready shortly after module
    // evaluation. Restore the global constructor afterwards so this compatibility
    // shim cannot affect observers created much later by unrelated code.
    setTimeout(() => {
        if (globalThis.MutationObserver === GuidedGenerationsMutationObserver) {
            globalThis.MutationObserver = NativeMutationObserver;
        }
    }, 15000);
}
