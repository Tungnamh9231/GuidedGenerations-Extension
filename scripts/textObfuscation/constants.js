export const GG_EXTENSION_NAME = 'GuidedGenerations-Extension';
export const SETTINGS_KEY = 'unicodeSensitiveWords';
export const SETTINGS_SCHEMA_VERSION = 3;
export const SETTINGS_SECTION_ID = 'gg-text-obfuscation-settings';
export const STYLE_ID = 'gg-text-obfuscation-style';
export const RUNTIME_KEY = '__GG_TEXT_OBFUSCATION_RUNTIME__';
export const ZERO_WIDTH_SPACE = '\u200B';
export const MAX_REPORT_SAMPLES = 6;

// Marker characters are invisible format characters (Unicode category Cf) that
// have no legitimate use in prose, so stripping them on incoming messages is
// safe. Variation selectors / ZWJ are deliberately excluded: they carry real
// meaning inside emoji sequences and would break rendered content.
export const MARKER_SETS = Object.freeze({
    zwsp: Object.freeze({
        label: 'Basic — ZWSP only',
        chars: Object.freeze(['\u200B']),
    }),
    balanced: Object.freeze({
        label: 'Balanced — ZWSP + word joiner',
        chars: Object.freeze(['\u200B', '\u2060']),
    }),
    stealth: Object.freeze({
        label: 'Stealth — word joiner + invisible operators',
        chars: Object.freeze(['\u2060', '\u2061', '\u2062']),
    }),
});

export const MARKER_LABELS = Object.freeze({
    '\u200B': 'ZWSP',
    '\u2060': 'WJ',
    '\u2061': 'IFA',
    '\u2062': 'IT',
});

export const ALL_MARKERS = Object.freeze(
    Array.from(new Set(Object.values(MARKER_SETS).flatMap(set => set.chars))),
);
