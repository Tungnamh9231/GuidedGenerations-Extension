/**
 * @file Group-chat character picker.
 *
 * Centralises how Guided Generations asks the user "which group member
 * should respond next?". If STGroupResponderSelector (GRS) is installed and
 * exposes its picker API, we delegate to it — that is its whole reason to
 * exist. Otherwise we fall back to GG's own selector (a proper modal popup
 * matching the project's design system).
 *
 * The cross-extension contract is the ST-sanctioned `globalThis.<Name>`
 * pattern (the same one `globalThis.quickReplyApi` uses):
 *
 *     globalThis.STGroupResponderSelector.pickCharacter(): Promise<{chid, name}|null>
 *
 * GG only ever consumes that — it never assumes GRS is present.
 */

import { extensionName, debugLog, getContext } from '../persistentGuides/guideExports.js';

/**
 * @typedef GroupMember
 * @property {number} chid
 * @property {string} name
 * @property {string|null} avatar
 * @property {string} triggerArg  Argument to pass to ST's `/trigger` command
 *                                (name as JSON string, or index as a bare
 *                                number when the name starts with a digit).
 */

/**
 * Look up GRS's published picker, if any.
 * @returns {{pickCharacter: () => Promise<{chid:number,name:string}|null>}|null}
 */
function getGrsPicker() {
    try {
        const api = globalThis.STGroupResponderSelector;
        return api && typeof api.pickCharacter === 'function' ? api : null;
    } catch {
        return null;
    }
}

/**
 * Build the `/trigger` argument for a member. ST's `/trigger` accepts either
 * a member index or a name string; we send the index when the name would
 * otherwise be misparsed as a number (i.e. starts with a digit).
 */
function triggerArgFor(index, name) {
    return /^\d/.test(name) && index >= 0 ? String(index) : JSON.stringify(name);
}

/**
 * Read the current group's members from ST context, each pre-tagged with
 * the `/trigger` argument that would target them.
 * @returns {GroupMember[]}
 */
function getGroupMembers() {
    const context = getContext();
    if (!context?.groupId || !Array.isArray(context.groups)) return [];

    const group = context.groups.find(g => g.id === context.groupId);
    if (!group || !Array.isArray(group.members)) return [];

    const characters = Array.isArray(context.characters) ? context.characters : [];
    const disabled = Array.isArray(group.disabled_members) ? group.disabled_members : [];

    const members = [];
    group.members.forEach((memberAvatar, index) => {
        if (typeof memberAvatar !== 'string') return;
        const chid = characters.findIndex(c => c && c.avatar === memberAvatar);
        if (chid === -1) return;
        const character = characters[chid];
        const name = typeof character.name === 'string' && character.name.length ? character.name : memberAvatar;
        members.push({
            chid,
            name,
            avatar: memberAvatar,
            muted: disabled.includes(memberAvatar),
            triggerArg: triggerArgFor(index, name),
        });
    });
    return members;
}

/**
 * GG's own picker modal. Builds a full-screen overlay with a centered dialog
 * matching the project's gg-editor-popup design system. Includes search
 * filtering, avatar display, and smooth animations.
 *
 * @param {GroupMember[]} members
 * @returns {Promise<GroupMember|null>}
 */
function ggFallbackPicker(members) {
    return new Promise((resolve) => {
        if (!members.length) {
            resolve(null);
            return;
        }

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeydown);
            popup.remove();
            resolve(value);
        };

        // ─── Build the modal ───
        const popup = document.createElement('div');
        popup.id = 'ggGroupPickerPopup';
        popup.className = 'gg-popup gg-editor-popup gg-picker-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-modal', 'true');
        popup.setAttribute('aria-labelledby', 'gg-picker-title');

        const dialog = document.createElement('div');
        dialog.className = 'gg-popup-content gg-editor-dialog gg-picker-dialog';

        // ── Header ──
        const header = document.createElement('div');
        header.className = 'gg-popup-header gg-picker-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'gg-editor-title-group';

        const titleIcon = document.createElement('span');
        titleIcon.className = 'gg-editor-title-icon';
        titleIcon.setAttribute('aria-hidden', 'true');
        titleIcon.innerHTML = '<i class="fa-solid fa-users"></i>';

        const titleTextWrap = document.createElement('div');
        const eyebrow = document.createElement('span');
        eyebrow.className = 'gg-editor-eyebrow';
        eyebrow.textContent = 'Group chat';
        const titleH2 = document.createElement('h2');
        titleH2.id = 'gg-picker-title';
        titleH2.textContent = 'Select Responder';
        titleTextWrap.append(eyebrow, titleH2);
        titleGroup.append(titleIcon, titleTextWrap);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'gg-popup-close';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        closeBtn.setAttribute('aria-label', 'Cancel');
        closeBtn.addEventListener('click', () => finish(null));

        header.append(titleGroup, closeBtn);

        // ── Body ──
        const body = document.createElement('div');
        body.className = 'gg-editor-body gg-picker-body';

        // Search box
        const searchSection = document.createElement('div');
        searchSection.className = 'gg-picker-search-section';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'gg-picker-search text_pole';
        searchInput.placeholder = 'Search characters...';
        searchInput.setAttribute('autocomplete', 'off');
        searchSection.appendChild(searchInput);

        // Member count
        const memberCount = document.createElement('div');
        memberCount.className = 'gg-picker-member-count';
        memberCount.textContent = `${members.length} member${members.length !== 1 ? 's' : ''} in group`;

        // Members list
        const membersList = document.createElement('div');
        membersList.className = 'gg-picker-members-list';

        const memberElements = [];

        for (const member of members) {
            const item = document.createElement('div');
            item.className = 'gg-picker-member-item';
            item.tabIndex = 0;
            if (member.muted) item.classList.add('gg-picker-member-muted');
            item.dataset.name = member.name.toLowerCase();

            // Avatar
            const avatarWrap = document.createElement('div');
            avatarWrap.className = 'gg-picker-avatar-wrap';
            const img = document.createElement('img');
            img.className = 'gg-picker-avatar';
            img.alt = '';
            img.loading = 'lazy';
            if (member.avatar) {
                img.src = `/thumbnail?type=avatar&file=${encodeURIComponent(member.avatar)}`;
            }
            img.addEventListener('error', () => {
                img.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'gg-picker-avatar-fallback';
                fallback.textContent = member.name.charAt(0).toUpperCase();
                avatarWrap.appendChild(fallback);
            });
            avatarWrap.appendChild(img);

            // Info
            const info = document.createElement('div');
            info.className = 'gg-picker-member-info';
            const nameEl = document.createElement('span');
            nameEl.className = 'gg-picker-member-name';
            nameEl.textContent = member.name;
            info.appendChild(nameEl);

            if (member.muted) {
                const mutedBadge = document.createElement('span');
                mutedBadge.className = 'gg-picker-muted-badge';
                mutedBadge.textContent = 'Muted';
                info.appendChild(mutedBadge);
            }

            // Arrow icon
            const arrow = document.createElement('span');
            arrow.className = 'gg-picker-select-arrow';
            arrow.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';

            item.append(avatarWrap, info, arrow);

            const choose = () => finish(member);
            item.addEventListener('click', choose);
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose();
                }
            });

            membersList.appendChild(item);
            memberElements.push({ el: item, name: member.name.toLowerCase() });
        }

        body.append(searchSection, memberCount, membersList);

        // ── Footer ──
        const footerWrap = document.createElement('div');
        footerWrap.className = 'gg-popup-footer-wrap gg-picker-footer-wrap';
        const footer = document.createElement('div');
        footer.className = 'gg-popup-footer gg-picker-footer';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'gg-button gg-button-quiet';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => finish(null));
        footer.appendChild(cancelBtn);
        footerWrap.appendChild(footer);

        // ── Assemble ──
        dialog.append(header, body, footerWrap);
        popup.appendChild(dialog);

        // ── Search filter ──
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            let visibleCount = 0;
            for (const { el, name } of memberElements) {
                const match = !query || name.includes(query);
                el.style.display = match ? '' : 'none';
                if (match) visibleCount++;
            }
            memberCount.textContent = query
                ? `${visibleCount} of ${members.length} shown`
                : `${members.length} member${members.length !== 1 ? 's' : ''} in group`;
        });

        // ── Keyboard & backdrop ──
        /** @param {KeyboardEvent} e */
        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(null);
            }
        };
        document.addEventListener('keydown', onKeydown);

        popup.addEventListener('click', (e) => {
            if (e.target === popup) finish(null);
        });

        // ── Mount ──
        popup.style.display = 'flex';
        document.body.appendChild(popup);

        // Focus search after mount
        requestAnimationFrame(() => {
            searchInput.focus();
        });
    });
}

/**
 * Ask the user which group member should respond next.
 *
 * - If STGroupResponderSelector is installed and publishes
 *   `globalThis.STGroupResponderSelector.pickCharacter`, use it.
 * - Otherwise open GG's own selector (with avatars).
 *
 * Returns the chosen member (with a ready-to-use `triggerArg`), or null if
 * the user cancelled.
 *
 * @returns {Promise<GroupMember|null>}
 */
export async function pickGroupMember() {
    const members = getGroupMembers();
    if (!members.length) {
        debugLog('[GroupSelection] No group members available; picker skipped.');
        return null;
    }

    const grs = getGrsPicker();
    if (grs) {
        try {
            debugLog('[GroupSelection] Using STGroupResponderSelector picker.');
            // Defer the call by one macrotask: GG's button click is still
            // bubbling at this point, and GRS's outside-click handler would
            // see the freshly-opened menu and close it immediately. Waiting
            // one tick lets the originating click finish propagating first.
            const picked = await new Promise((resolve) => setTimeout(resolve, 0))
                .then(() => grs.pickCharacter());
            if (!picked || typeof picked.chid !== 'number') {
                debugLog('[GroupSelection] GRS picker returned no selection.');
                return null;
            }
            // Normalise: prefer the locally-built member (it carries the
            // correct triggerArg, avatar and muted flag). Fall back to a
            // bare object if GRS reports a chid we don't know about.
            const matched = members.find(m => m.chid === picked.chid);
            return matched ?? {
                chid: picked.chid,
                name: typeof picked.name === 'string' && picked.name.length ? picked.name : String(picked.chid),
                avatar: null,
                muted: false,
                triggerArg: JSON.stringify(typeof picked.name === 'string' && picked.name.length ? picked.name : String(picked.chid)),
            };
        } catch (error) {
            console.warn(`[${extensionName}] GRS picker threw; falling back to GG selector.`, error);
        }
    }

    debugLog('[GroupSelection] Using GG fallback picker.');
    return ggFallbackPicker(members);
}
