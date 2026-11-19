export const GG_EXTENSION_NAME = 'GuidedGenerations-Extension';
export const SETTINGS_KEY = 'unicodeSensitiveWords';
export const SETTINGS_SCHEMA_VERSION = 4;
export const SETTINGS_SECTION_ID = 'gg-text-obfuscation-settings';
export const STYLE_ID = 'gg-text-obfuscation-style';
export const RUNTIME_KEY = '__GG_TEXT_OBFUSCATION_RUNTIME__';
export const ZERO_WIDTH_SPACE = '\u200B';
export const MAX_REPORT_SAMPLES = 6;

// ─── Invisible channels ──────────────────────────────────────────────────────
// Filters are not one thing. The useful mental model is a stack of sanitizers
// that a payload has to walk through:
//
//   L1 exact substring match            → any inserted char breaks it
//   L2 NFKC + strip \p{Cf}              → kills ZWSP/WJ/soft hyphen
//   L3 strip \p{Mn} (combining marks)   → kills CGJ / variation selectors
//   L4 ASCII whitelist [a-z0-9] only    → kills every non-Latin channel
//   L5 confusable folding (skeleton)    → kills Cyrillic/Greek lookalikes
//   L6 fuzzy / edit distance ≤ 1-2      → kills a single substitution
//   L7 BPE/ML classifier                → reads the obfuscated word anyway
//
// No single channel survives all of them, so the transform stacks channels:
// a Cf marker + an Mn marker + non-NFKC-foldable homoglyphs. Each stage a
// sanitizer implements only removes one channel, and whatever it does not
// strip stays inside the keyword. Crucially: never use a character that NFKC
// folds back to ASCII (fullwidth, mathematical alphanumerics, small caps,
// ligatures) — those make the payload *match* after normalization.
export const MARKER_SETS = Object.freeze({
    zwsp: Object.freeze({
        label: 'Basic — ZWSP only (legacy)',
        chars: Object.freeze(['\u200B']),
    }),
    balanced: Object.freeze({
        label: 'Balanced — ZWSP + word joiner (legacy)',
        chars: Object.freeze(['\u200B', '\u2060']),
    }),
    stealth: Object.freeze({
        label: 'Stealth — invisible operators (Cf only)',
        chars: Object.freeze(['\u2060', '\u2061', '\u2062', '\u2063']),
    }),
    combining: Object.freeze({
        label: 'Combining — CGJ + variation selectors (Mn, survives Cf strip)',
        chars: Object.freeze([
            '\u034F',
            '\uFE00', '\uFE01', '\uFE02', '\uFE03',
            '\u{E0100}', '\u{E0101}', '\u{E0102}',
        ]),
    }),
    layered: Object.freeze({
        label: 'Layered — Cf + Mn mixed (default)',
        chars: Object.freeze([
            '\u200B', '\u2060',
            '\u034F',
            '\uFE00', '\uFE01', '\uFE02',
        ]),
    }),
    extreme: Object.freeze({
        label: 'Extreme — Cf + Mn + Hangul fillers (widest survival)',
        chars: Object.freeze([
            '\u200B', '\u2060', '\u2063',
            '\u034F',
            '\uFE00', '\uFE01', '\uFE02', '\uFE0F',
            '\u3164', '\u115F', '\u1160',
        ]),
    }),
});

export const MARKER_LABELS = Object.freeze({
    '\u200B': 'ZWSP',
    '\u200C': 'ZWNJ',
    '\u200D': 'ZWJ',
    '\u2060': 'WJ',
    '\u2061': 'IFA',
    '\u2062': 'IT',
    '\u2063': 'IS',
    '\u2064': 'IP',
    '\u034F': 'CGJ',
    '\uFE00': 'VS1',
    '\uFE01': 'VS2',
    '\uFE02': 'VS3',
    '\uFE03': 'VS4',
    '\uFE0F': 'VS16',
    '\u{E0100}': 'VS17',
    '\u{E0101}': 'VS18',
    '\u{E0102}': 'VS19',
    '\u3164': 'HF',
    '\u115F': 'HCF',
    '\u1160': 'HV',
});

export const ALL_MARKERS = Object.freeze(
    Array.from(new Set(Object.values(MARKER_SETS).flatMap(set => set.chars))),
);

// Format characters and fillers that are safe to drop from incoming text in
// every context: Cf has no legitimate role in prose, and the Hangul fillers are
// blank spacers.
export const STRIP_ALWAYS = Object.freeze(
    Array.from(new Set(ALL_MARKERS.filter(ch => !isCombiningMarker(ch) && ch !== '\u200D'))),
);

export function isCombiningMarker(ch) {
    if (typeof ch !== 'string' || ch.length === 0) return false;
    const cp = ch.codePointAt(0);
    if (cp === 0x034F) return true;
    if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
    if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
    return false;
}

export function isWordLikeChar(ch) {
    return typeof ch === 'string' && /[\p{L}\p{N}\p{M}_]/u.test(ch);
}

// ─── Homoglyph pool ──────────────────────────────────────────────────────────
// Every candidate must survive NFKC unchanged, otherwise a filter that runs
// NFKC before matching gets the plain keyword back. Scripts are limited to
// Cyrillic / Greek / Coptic / Cherokee / Latin-extended lookalikes: NFKC keeps
// them, so the only thing that can catch them is a confusable-skeleton folder
// or a script-mixing detector — which is exactly why the marker channel is
// carried alongside.
const RAW_HOMOGLYPHS = {
    a: ['\u0430', '\u03B1', '\u0251'],
    c: ['\u0441', '\u03F2'],
    d: ['\u0501'],
    e: ['\u0435', '\u03B5'],
    g: ['\u0261'],
    i: ['\u0456', '\u03B9', '\u0131', '\u0269'],
    j: ['\u0458', '\u03F3'],
    k: ['\u043A', '\u03BA'],
    l: ['\u04CF'],
    o: ['\u043E', '\u03BF'],
    p: ['\u0440', '\u03C1'],
    q: ['\u051B'],
    s: ['\u0455'],
    t: ['\u03C4'],
    u: ['\u03C5', '\u0475'],
    v: ['\u03BD', '\u0475'],
    w: ['\u03C9'],
    x: ['\u0445', '\u03C7'],
    y: ['\u0443'],
    A: ['\u0410', '\u0391'],
    B: ['\u0412', '\u0392'],
    C: ['\u0421', '\u03F9'],
    D: ['\u13A0'],
    E: ['\u0415', '\u0395'],
    H: ['\u041D', '\u0397'],
    I: ['\u0406', '\u0399'],
    J: ['\u0408'],
    K: ['\u041A', '\u039A'],
    L: ['\u13DE'],
    M: ['\u041C', '\u039C'],
    N: ['\u039D'],
    O: ['\u041E', '\u039F'],
    P: ['\u0420', '\u03A1'],
    Q: ['\u051A'],
    S: ['\u0405'],
    T: ['\u0422', '\u03A4'],
    V: ['\u0474'],
    X: ['\u0425', '\u03A7'],
    Y: ['\u0423', '\u03A5'],
    Z: ['\u0396'],
};

function nfkcStable(ch) {
    try {
        return ch.normalize('NFKC') === ch && ch.toLowerCase().normalize('NFKC') === ch.toLowerCase();
    } catch {
        return false;
    }
}

export const HOMOGLYPHS = Object.freeze(
    new Map(
        Object.entries(RAW_HOMOGLYPHS)
            .map(([latin, candidates]) => [latin, Object.freeze(candidates.filter(nfkcStable))])
            .filter(([, candidates]) => candidates.length > 0),
    ),
);

// Reverse map used by the filter test to rebuild the skeleton a confusable
// folder would produce, so the UI can show what still gets caught.
export const CONFUSABLE_TO_LATIN = Object.freeze(
    new Map(
        Array.from(HOMOGLYPHS, ([latin, candidates]) => candidates.map(ch => [ch, latin]))
            .flat(),
    ),
);
