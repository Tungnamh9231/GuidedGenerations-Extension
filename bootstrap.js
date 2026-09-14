// Compatibility bootstrap: install narrowly-scoped performance guards before
// loading the established extension, then attach independent optional subsystems.
// A failure in one subsystem must never block the legacy GuidedGenerations
// features or the other subsystem.
import './scripts/performanceGuard.js';
import './index.js';
import { activateNativeUb } from './scripts/ub/index.js';
import { activateTextObfuscation } from './scripts/textObfuscation/index.js';

try {
    activateNativeUb();
} catch (error) {
    console.error('[GuidedGenerations] Native UB bootstrap failed:', error);
}

try {
    activateTextObfuscation();
} catch (error) {
    console.error('[GuidedGenerations] Unicode Sensitive Words bootstrap failed:', error);
}
