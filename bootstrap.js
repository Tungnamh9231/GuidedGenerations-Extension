// Compatibility bootstrap: load the established extension first, then attach
// independent optional subsystems. A failure in one subsystem must never block
// the legacy GuidedGenerations features or the other subsystem.
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
