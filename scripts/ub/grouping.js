function clonePromptRef(ref) {
    return {
        identifier: String(ref.identifier),
        nameSnapshot: String(ref.nameSnapshot ?? ref.name ?? ref.identifier),
    };
}

/**
 * Merge two or more existing state blocks into one group, preserving the
 * position and effort of the first selected block. Existing groups are
 * flattened, matching the original userscript's grouping semantics.
 */
export function groupSelectedBlocks(tab, selectedIds, createId = () => `group-${Date.now()}`) {
    if (!tab || !Array.isArray(tab.blocks)) return false;
    const selected = new Set(selectedIds ?? []);
    const selectedIndices = tab.blocks
        .map((block, index) => selected.has(block.id) ? index : -1)
        .filter(index => index >= 0)
        .sort((a, b) => a - b);

    if (selectedIndices.length < 2) return false;

    const parentIndex = selectedIndices[0];
    const firstBlock = tab.blocks[parentIndex];
    const promptRefs = [];

    for (const index of selectedIndices) {
        const block = tab.blocks[index];
        for (const ref of block.promptRefs ?? []) promptRefs.push(clonePromptRef(ref));
    }

    if (promptRefs.length < 2) return false;

    const group = {
        id: String(firstBlock.id || createId()),
        name: String(promptRefs[0]?.nameSnapshot || firstBlock.name || 'Group'),
        effort: String(firstBlock.effort || 'min'),
        promptRefs,
    };

    for (let i = selectedIndices.length - 1; i >= 0; i--) {
        tab.blocks.splice(selectedIndices[i], 1);
    }
    tab.blocks.splice(parentIndex, 0, group);
    return true;
}

/**
 * Split a group back into individual blocks. Every child inherits the group's
 * effort, matching the original userscript's Ungroup behavior.
 */
export function ungroupBlock(tab, blockIndex, createId = () => `block-${Date.now()}`) {
    if (!tab || !Array.isArray(tab.blocks)) return false;
    const block = tab.blocks[blockIndex];
    if (!block || !Array.isArray(block.promptRefs) || block.promptRefs.length < 2) return false;

    const effort = String(block.effort || 'min');
    const expanded = block.promptRefs.map((ref, index) => ({
        id: index === 0 ? String(block.id || createId()) : String(createId()),
        name: String(ref.nameSnapshot ?? ref.identifier),
        effort,
        promptRefs: [clonePromptRef(ref)],
    }));

    tab.blocks.splice(blockIndex, 1, ...expanded);
    return true;
}
