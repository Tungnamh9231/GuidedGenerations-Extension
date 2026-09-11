# Native UB subsystem

This subsystem implements message-level UB/HJB controls using SillyTavern state and lifecycle APIs instead of scraping the Prompt Manager DOM.

## Safety model

- Disabled by default (`extension_settings['GuidedGenerations-Extension'].nativeUb.enabled = false`).
- Existing GuidedGenerations code is loaded unchanged by `bootstrap.js` before this subsystem starts.
- Prompt state changes are preflighted before mutation. If any configured prompt identifier is missing, nothing is applied.
- Prompt identifiers are the source of truth; prompt names are snapshots for display/diagnostics only.
- Current UB state is derived from SillyTavern PromptManager + reasoning effort. It is not persisted as duplicate state.
- Message toolbar DOM access is isolated to `sillyTavernAdapter.js` / `messageToolbar.js` because SillyTavern currently has no message-action registration API.
- Buttons are additive and marked with `data-gg-ub-button`; native/third-party message buttons are never cleared.

## Modules

- `store.js`: schema, normalization, persistence in extension settings.
- `sillyTavernAdapter.js`: boundary around SillyTavern APIs/internal PromptManager and the minimal toolbar DOM fallback.
- `engine.js`: UB state machine and transactional state application.
- `messageToolbar.js`: event-driven per-message buttons and long-press state picker.
- `configPopup.js`: native Popup-based configuration UI.
- `index.js`: lifecycle wiring.

## Rollback

Point `manifest.json` `js` back from `bootstrap.js` to `index.js`. No existing GuidedGenerations settings are modified by the UB subsystem except the new `nativeUb` namespace.
