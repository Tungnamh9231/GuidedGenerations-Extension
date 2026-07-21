/**
 * Provides a tool to edit character descriptions using a popup UI
 * 
 * @returns {Promise<void>}
 */
import editDescriptionPopup from './editDescriptionPopup.js';

export default async function editDescription() {
    // Initialize and open the popup
    await editDescriptionPopup.init();
    editDescriptionPopup.open();
}
