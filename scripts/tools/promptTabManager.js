import { extensionName, extension_settings, saveSettingsDebounced, getPromptValue } from '../persistentGuides/guideExports.js';

export class PromptTabManager {
    /**
     * @param {string} toolName - e.g., 'editDescription' or 'editIntros'
     * @param {Array} promptsConfig - Configuration array for each prompt
     * Example: 
     * [
     *   { 
     *     key: 'editExisting', 
     *     label: 'Edit Existing', 
     *     variables: [
     *       { short: 'i', long: 'instruction', desc: 'User edit instruction' },
     *       { short: 'cd', long: 'currentDescription', desc: 'Current description' }
     *     ]
     *   }
     * ]
     */
    constructor(toolName, promptsConfig) {
        this.toolName = toolName;
        this.promptsConfig = promptsConfig;
        
        // Ensure customPrompts storage exists
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        if (!extension_settings[extensionName].customPrompts) {
            extension_settings[extensionName].customPrompts = {};
        }
    }

    /**
     * Get the prompt text for a specific key.
     * Uses custom prompt if available, else fallback to prompts.json
     */
    async getPrompt(promptKey) {
        const fullKey = `${this.toolName}.${promptKey}`;
        if (extension_settings[extensionName]?.customPrompts?.[fullKey]) {
            return extension_settings[extensionName].customPrompts[fullKey];
        }
        return await getPromptValue(fullKey, '');
    }

    /**
     * Get the HTML for the prompt tab content
     */
    getHtml() {
        const optionsHtml = this.promptsConfig.map(p => 
            `<option value="${p.key}">${p.label}</option>`
        ).join('');

        return `
            <section class="gg-popup-section gg-editor-card gg-prompt-section">
                <div class="gg-editor-section-heading">
                    <div>
                        <h3>Prompt Configuration</h3>
                        <p>Customize the prompts used by this tool.</p>
                    </div>
                </div>
                
                <div class="gg-prompt-selector-container">
                    <label for="gg-${this.toolName}-prompt-selector" class="gg-editor-section-label">Select Prompt:</label>
                    <select id="gg-${this.toolName}-prompt-selector" class="text_pole gg-prompt-selector">
                        ${optionsHtml}
                    </select>
                </div>
                
                <div class="gg-prompt-editor-container">
                    <textarea id="gg-${this.toolName}-prompt-textarea" class="text_pole gg-editor-textarea" rows="8"></textarea>
                </div>
                
                <div class="gg-prompt-variables-container">
                    <div class="gg-editor-section-label">Available Variables</div>
                    <div id="gg-${this.toolName}-prompt-variables-list" class="gg-prompt-variables-list">
                        <!-- Variables will be populated here -->
                    </div>
                </div>
                
                <div class="gg-prompt-actions">
                    <button type="button" id="gg-${this.toolName}-prompt-reset-btn" class="gg-button gg-button-secondary">
                        <i class="fa-solid fa-rotate-left"></i> Reset to Default
                    </button>
                    <button type="button" id="gg-${this.toolName}-prompt-reset-all-btn" class="gg-button gg-button-quiet" title="Reset all prompts for this tool">
                        Reset All
                    </button>
                </div>
            </section>
        `;
    }

    /**
     * Setup event listeners for the rendered HTML
     */
    setupEventListeners(popupElement) {
        if (!popupElement) return;

        const selector = popupElement.querySelector(`#gg-${this.toolName}-prompt-selector`);
        const textarea = popupElement.querySelector(`#gg-${this.toolName}-prompt-textarea`);
        const resetBtn = popupElement.querySelector(`#gg-${this.toolName}-prompt-reset-btn`);
        const resetAllBtn = popupElement.querySelector(`#gg-${this.toolName}-prompt-reset-all-btn`);
        
        if (!selector || !textarea) return;

        // Load the currently selected prompt
        const loadSelectedPrompt = async () => {
            const key = selector.value;
            const config = this.promptsConfig.find(p => p.key === key);
            if (!config) return;

            // Load prompt and convert to short variables
            const rawPrompt = await this.getPrompt(key);
            textarea.value = this.convertLongToShort(rawPrompt, config);
            
            // Render variables list
            this.renderVariables(popupElement, config);
        };

        selector.addEventListener('change', loadSelectedPrompt);
        
        // Save changes when user types
        textarea.addEventListener('input', () => {
            const key = selector.value;
            const config = this.promptsConfig.find(p => p.key === key);
            if (!config) return;
            
            const rawValue = textarea.value;
            const longPrompt = this.convertShortToLong(rawValue, config);
            
            const fullKey = `${this.toolName}.${key}`;
            extension_settings[extensionName].customPrompts[fullKey] = longPrompt;
            saveSettingsDebounced();
        });

        // Reset current prompt
        resetBtn.addEventListener('click', async () => {
            const key = selector.value;
            const fullKey = `${this.toolName}.${key}`;
            
            if (extension_settings[extensionName].customPrompts[fullKey] !== undefined) {
                delete extension_settings[extensionName].customPrompts[fullKey];
                saveSettingsDebounced();
            }
            
            await loadSelectedPrompt();
        });

        // Reset all prompts for this tool
        resetAllBtn.addEventListener('click', async () => {
            if (confirm(`Are you sure you want to reset all prompts for ${this.toolName}?`)) {
                let changed = false;
                for (const p of this.promptsConfig) {
                    const fullKey = `${this.toolName}.${p.key}`;
                    if (extension_settings[extensionName].customPrompts[fullKey] !== undefined) {
                        delete extension_settings[extensionName].customPrompts[fullKey];
                        changed = true;
                    }
                }
                if (changed) {
                    saveSettingsDebounced();
                }
                await loadSelectedPrompt();
            }
        });

        // Initial load
        loadSelectedPrompt();
    }

    renderVariables(popupElement, config) {
        const variablesContainer = popupElement.querySelector(`#gg-${this.toolName}-prompt-variables-list`);
        if (!variablesContainer) return;

        if (!config.variables || config.variables.length === 0) {
            variablesContainer.innerHTML = '<span class="gg-prompt-variable-empty">No variables available for this prompt.</span>';
            return;
        }

        const html = config.variables.map(v => `
            <div class="gg-prompt-variable-item">
                <span class="gg-prompt-variable-tag">{{${v.short}}}</span>
                <span class="gg-prompt-variable-desc">${v.desc}</span>
            </div>
        `).join('');
        
        variablesContainer.innerHTML = html;
    }

    convertLongToShort(text, config) {
        if (!text || !config || !config.variables) return text;
        let result = text;
        for (const v of config.variables) {
            result = result.replaceAll(`{{${v.long}}}`, `{{${v.short}}}`);
        }
        return result;
    }

    convertShortToLong(text, config) {
        if (!text || !config || !config.variables) return text;
        let result = text;
        for (const v of config.variables) {
            result = result.replaceAll(`{{${v.short}}}`, `{{${v.long}}}`);
        }
        return result;
    }
}
