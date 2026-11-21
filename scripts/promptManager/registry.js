// Single source of truth for "which extension feature owns which prompt".
//
// Every prompt listed here is placed by the extension's own Prompt Manager:
// the block position in its list decides where the prompt goes, and the saved
// role / position / depth / order decide how it is sent. SillyTavern's native
// prompt manager only governs its own prompts.
//
// scope 'chat'  -> the prompt is injected into the chat completion prompt.
// scope 'tool'  -> the prompt is sent inside the owning feature's own request.
// textOnly      -> the prompt is plain text consumed by a feature flow that
//                  cannot be repositioned (/continue and /gen input), so only
//                  its text is managed here.

const CHAT = 'chat';
const TOOL = 'tool';

// Prompt text placeholders, documented in the Prompt Manager edit tab.
// `st: true` marks a SillyTavern macro expanded by SillyTavern when the prompt
// is sent; the rest are replaced by the owning feature before sending.
const V = (name, desc) => ({ name, desc });
const ST = (name, desc) => ({ name, desc, st: true });

const INPUT_TEXT = () => V('input', "Text currently in the message box");
const PIPE_OUTPUT = () => ST('pipe', "Output of the guide generation (SillyTavern slash pipe)");

export const PROMPT_SCOPE = Object.freeze({ CHAT, TOOL });

export const PROMPT_BLOCKS = [
    {
        id: 'impersonate1st',
        label: 'Impersonate (1st Person)',
        icon: 'fa-user',
        prompts: [{ key: 'promptImpersonate1st', label: 'Impersonate prompt', scope: TOOL, variables: [INPUT_TEXT(), ST('user', 'User persona name (SillyTavern macro)')] }],
    },
    {
        id: 'impersonate2nd',
        label: 'Impersonate (2nd Person)',
        icon: 'fa-user',
        prompts: [{ key: 'promptImpersonate2nd', label: 'Impersonate prompt', scope: TOOL, variables: [INPUT_TEXT(), ST('user', 'User persona name (SillyTavern macro)')] }],
    },
    {
        id: 'impersonate3rd',
        label: 'Impersonate (3rd Person)',
        icon: 'fa-user',
        prompts: [{ key: 'promptImpersonate3rd', label: 'Impersonate prompt', scope: TOOL, variables: [INPUT_TEXT(), ST('user', 'User persona name (SillyTavern macro)')] }],
    },
    {
        id: 'guidedContinue',
        label: 'Guided Continue',
        icon: 'fa-forward',
        prompts: [{ key: 'promptGuidedContinue', label: 'Guided Continue prompt', scope: TOOL, textOnly: true, variables: [INPUT_TEXT()] }],
    },
    {
        id: 'guidedResponse',
        label: 'Guided Response',
        icon: 'fa-reply',
        flags: { depth: 'depthPromptGuidedResponse' },
        prompts: [{ key: 'promptGuidedResponse', label: 'Guided Response prompt', scope: CHAT, variables: [INPUT_TEXT(), ST('user', 'User persona name (SillyTavern macro)')] }],
    },
    {
        id: 'guidedSwipe',
        label: 'Guided Swipe',
        icon: 'fa-clone',
        flags: { depth: 'depthPromptGuidedSwipe' },
        prompts: [{ key: 'promptGuidedSwipe', label: 'Guided Swipe prompt', scope: CHAT, variables: [INPUT_TEXT()] }],
    },
    {
        id: 'clothes',
        label: 'Describe Clothes',
        icon: 'fa-shirt',
        flags: { raw: 'rawPromptClothes', depth: 'depthPromptClothes' },
        prompts: [
            { key: 'promptClothes', label: 'Guide prompt', scope: TOOL, variables: [ST('user', 'User persona name (SillyTavern macro)')] },
            { key: 'persistentGuides.clothesInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_clothes', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'state',
        label: 'Describe State',
        icon: 'fa-heart-pulse',
        flags: { raw: 'rawPromptState', depth: 'depthPromptState' },
        prompts: [
            { key: 'promptState', label: 'Guide prompt', scope: TOOL, variables: [ST('user', 'User persona name (SillyTavern macro)')] },
            { key: 'persistentGuides.stateInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_state', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'thinking',
        label: 'Describe Thinking',
        icon: 'fa-brain',
        flags: { raw: 'rawPromptThinking', depth: 'depthPromptThinking' },
        prompts: [
            { key: 'promptThinking', label: 'Guide prompt', scope: TOOL, variables: [ST('user', 'User persona name (SillyTavern macro)')] },
            { key: 'persistentGuides.thinkingInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_thinking', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'separatedThinking',
        label: 'Separated Thinking',
        icon: 'fa-diagram-project',
        prompts: [{
            key: 'promptSeparatedThinking',
            label: 'Guide prompt',
            scope: TOOL,
            variables: [
                V('chat', 'Recent chat messages block'),
                V('message', 'Message being processed'),
                V('input', 'Same text as {{message}}'),
                V('messageIndex', '1-based index of the processed message'),
            ],
        }],
    },
    {
        id: 'situational',
        label: 'Situational',
        icon: 'fa-map-location-dot',
        flags: { raw: 'rawPromptSituational', depth: 'depthPromptSituational' },
        prompts: [
            { key: 'promptSituational', label: 'Guide prompt', scope: TOOL },
            { key: 'persistentGuides.situationalInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_situational', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'rules',
        label: 'Rules',
        icon: 'fa-list-check',
        flags: { raw: 'rawPromptRules', depth: 'depthPromptRules' },
        prompts: [
            { key: 'promptRules', label: 'Guide prompt', scope: TOOL, variables: [ST('char', 'Character name (SillyTavern macro)')] },
            { key: 'persistentGuides.rulesInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_rules', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'customAuto',
        label: 'Custom Auto Guide',
        icon: 'fa-bolt',
        flags: { raw: 'rawPromptCustomAuto', depth: 'depthPromptCustomAuto' },
        prompts: [
            { key: 'customAutoGuidePrompt', label: 'Guide prompt', scope: TOOL },
            { key: 'persistentGuides.customAutoInjection', label: 'Injection prompt', scope: CHAT, slot: 'script_inject_customAuto', variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'persistentGuides',
        label: 'Persistent Guides (shared)',
        icon: 'fa-thumbtack',
        prompts: [
            // Template used when a guide's previous injection is moved; it is
            // injected under the guide's own id, so the guide block owns placement.
            { key: 'persistentGuides.movedPreviousInjection', label: 'Moved injection', scope: CHAT, slot: null, textOnly: true, variables: [PIPE_OUTPUT()] },
        ],
    },
    {
        id: 'editDescription',
        label: 'Edit Description',
        icon: 'fa-pen-to-square',
        prompts: [
            {
                key: 'editDescription.editExisting',
                label: 'Edit existing',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's edit instruction"),
                    V('currentDescription', 'Current character description'),
                    V('characterName', 'Character name'),
                    V('userName', 'User persona name'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                    V('formatList', 'Format entries (empty when unused)'),
                ],
            },
            {
                key: 'editDescription.makeNew',
                label: 'Make new',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's creation instruction"),
                    V('characterName', 'Character name'),
                    V('userName', 'User persona name'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                ],
            },
            {
                key: 'editDescription.makeNewWithFormat',
                label: 'Make new with format',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's creation instruction"),
                    V('formatList', 'Format entries from the popup, joined by blank lines'),
                    V('characterName', 'Character name'),
                    V('userName', 'User persona name'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                ],
            },
            {
                key: 'editDescription.createWorld',
                label: 'Create world',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's creation instruction"),
                    V('formatList', 'Format entries (empty when unused)'),
                    V('characterName', 'Character name'),
                    V('userName', 'User persona name'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                ],
            },
        ],
    },
    {
        id: 'editIntros',
        label: 'Edit Intros',
        icon: 'fa-feather',
        prompts: [
            {
                key: 'editIntros.editExisting',
                label: 'Edit existing',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's edit instruction"),
                    V('messageToRewrite', 'Current greeting message'),
                    V('characterName', 'Character name'),
                    V('characterSheet', 'Character description, personality, scenario, examples'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                    V('userName', 'User persona name'),
                ],
            },
            {
                key: 'editIntros.makeNew',
                label: 'Make new',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', "User's creation instruction"),
                    V('characterName', 'Character name'),
                    V('characterSheet', 'Character description, personality, scenario, examples'),
                    V('recentScene', 'Last few chat messages, for continuity'),
                    V('userName', 'User persona name'),
                ],
            },
        ],
    },
    {
        id: 'corrections',
        label: 'Corrections',
        icon: 'fa-wand-magic-sparkles',
        prompts: [
            { key: 'promptCorrections', label: 'Corrections prompt', scope: TOOL, variables: [V('input', 'Correction instruction entered by the user')] },
            {
                key: 'corrections.selectedTextTask',
                label: 'Selected text task',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', 'Corrections prompt filled with the user instruction'),
                    V('baseMessage', 'The full message being corrected'),
                    V('selectedText', 'The part of the message highlighted by the user'),
                    V('historyBlock', 'Messages before the corrected one, for continuity'),
                ],
            },
            {
                key: 'corrections.fullMessageTask',
                label: 'Full message task',
                scope: TOOL,
                defaults: { role: 'system' },
                variables: [
                    V('instruction', 'Corrections prompt filled with the user instruction'),
                    V('baseMessage', 'The full message being corrected'),
                    V('historyBlock', 'Messages before the corrected one, for continuity'),
                ],
            },
        ],
    },
    {
        id: 'spellchecker',
        label: 'Spellchecker',
        icon: 'fa-spell-check',
        prompts: [{ key: 'promptSpellchecker', label: 'Spellchecker prompt', scope: TOOL, variables: [INPUT_TEXT()] }],
    },
    {
        id: 'fun',
        label: 'Fun',
        icon: 'fa-face-grin-stars',
        // The suffix is appended to the popup input and injected as an ephemeral
        // chat prompt, so its default placement follows that injection.
        prompts: [{ key: 'funPrompts.inputSuffix', label: 'Input suffix', scope: TOOL, defaults: { position: 1, depth: 0, role: 'system' }, variables: [INPUT_TEXT()] }],
    },
    {
        id: 'tracker',
        label: 'Tracker',
        icon: 'fa-satellite-dish',
        prompts: [
            { key: 'tracker.guidePrompt', label: 'Guide prompt', scope: TOOL, variables: [ST('char', 'Character name (SillyTavern macro)')] },
            { key: 'tracker.trackerPrompt', label: 'Tracker prompt', scope: TOOL, variables: [ST('char', 'Character name (SillyTavern macro)')] },
            { key: 'tracker.trackerInjection', label: 'Tracker injection', scope: CHAT, slot: 'script_inject_tracker', defaults: { depth: 1 }, variables: [V('tracker', 'Tracker update text')] },
        ],
    },
    {
        id: 'editGuides',
        label: 'Edit Guides',
        icon: 'fa-screwdriver-wrench',
        prompts: [{ key: 'editGuides.generatedGuideInjection', label: 'Generated guide injection', scope: CHAT, slot: null, variables: [V('generatedGuide', 'The generated guide text')] }],
    },
];

const blockIndex = new Map(PROMPT_BLOCKS.map(block => [block.id, block]));
const promptIndex = new Map();
for (const block of PROMPT_BLOCKS) {
    for (const prompt of block.prompts) promptIndex.set(prompt.key, { block, prompt });
}

export function getBlockById(blockId) {
    return blockIndex.get(blockId) ?? null;
}

export function getPromptDefinition(key) {
    return promptIndex.get(key) ?? null;
}

export function getPromptScope(key) {
    return promptIndex.get(key)?.prompt.scope ?? TOOL;
}
