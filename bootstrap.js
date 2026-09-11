// Compatibility bootstrap: load the existing extension unchanged, then attach
// the native/event-driven UB subsystem behind its own feature flag.
import './index.js';
import { activateNativeUb } from './scripts/ub/index.js';

try {
    activateNativeUb();
} catch (error) {
    // Native UB must never prevent the established GuidedGenerations features
    // from loading. The feature is disabled by default and can be rolled back
    // by pointing manifest.json back to index.js.
    console.error('[GuidedGenerations] Native UB bootstrap failed:', error);
}
