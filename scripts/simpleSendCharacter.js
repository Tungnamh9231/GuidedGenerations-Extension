// scripts/simpleSendCharacter.js

import { setPreviousImpersonateInput, debugLog } from './persistentGuides/guideExports.js';

let isSending = false; 

const simpleSendCharacter = async () => {
	if (isSending) {
		debugLog(`[SimpleSendCharacter] already in progress, skipping.`);
		return;
	}
	isSending = true;

	try {
		const textarea = document.getElementById('send_textarea');
		if (!textarea) {
			console.error('[GuidedGenerations][SimpleSendCharacter] Textarea #send_textarea not found.');
			return;
		}
		const originalInput = textarea.value;

		setPreviousImpersonateInput(originalInput);
		debugLog(`[SimpleSendCharacter] Original input saved: "${originalInput}"`);

		const command = `/sendas name="{{char}}" {{input}} | /setinput`; 

		if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
			const context = SillyTavern.getContext();
			await context.executeSlashCommandsWithOptions(command);
		} else {
			console.error('[GuidedGenerations][SimpleSendCharacter] SillyTavern.getContext function not found.');
		}
	} catch (error) {
		console.error("[GuidedGenerations][SimpleSendCharacter] Error:", error);
	} finally {
		isSending = false;
	}
};

export { simpleSendCharacter };
