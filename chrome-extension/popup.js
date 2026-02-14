document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

function saveOptions() {
    const notionKey = document.getElementById('notionKey').value;
    const notionParentId = document.getElementById('notionParentId').value;
    const notionParentType = document.getElementById('notionParentType').value;
    const obsidianUrl = document.getElementById('obsidianUrl').value;
    const obsidianKey = document.getElementById('obsidianKey').value;
    const titleMode = document.getElementById('titleMode').value;
    const llmBaseUrl = document.getElementById('llmBaseUrl').value;
    const llmModel = document.getElementById('llmModel').value;

    chrome.storage.local.set(
        { notionKey, notionParentId, notionParentType, obsidianUrl, obsidianKey, titleMode, llmBaseUrl, llmModel },
        () => {
            const status = document.getElementById('status');
            status.textContent = 'Options saved.';
            setTimeout(() => {
                status.textContent = '';
            }, 750);
        }
    );
}

function restoreOptions() {
    chrome.storage.local.get(
        ['notionKey', 'notionParentId', 'notionParentType', 'obsidianUrl', 'obsidianKey', 'titleMode', 'llmBaseUrl', 'llmModel', 'autoTitleEnabled'],
        (items) => {
            document.getElementById('notionKey').value = items.notionKey || '';
            document.getElementById('notionParentId').value = items.notionParentId || '';
            document.getElementById('notionParentType').value = items.notionParentType || 'auto';
            document.getElementById('obsidianUrl').value = items.obsidianUrl || '';
            document.getElementById('obsidianKey').value = items.obsidianKey || '';

            // Back-compat: old autoTitleEnabled flag
            // - autoTitleEnabled === false => prompt
            // - otherwise default to LLM if configured, else auto
            let mode = items.titleMode;
            if (!mode) {
                if (items.autoTitleEnabled === false) mode = 'prompt';
                else mode = items.llmBaseUrl ? 'llm' : 'auto';
            }
            document.getElementById('titleMode').value = mode;
            document.getElementById('llmBaseUrl').value = items.llmBaseUrl || 'http://127.0.0.1:1234';
            document.getElementById('llmModel').value = items.llmModel || '';
        }
    );
}
