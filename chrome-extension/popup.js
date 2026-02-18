const CONFIG_KEYS = ['notionKey', 'notionParentId', 'notionParentType', 'obsidianUrl', 'obsidianKey', 'titleMode', 'llmBaseUrl', 'llmModel', 'autoTitleEnabled'];

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

function sendMessageAsync(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(payload, (response) => resolve(response));
        } catch (error) {
            resolve({ success: false, error: error?.message || String(error) });
        }
    });
}

function getStorageOptions() {
    return new Promise((resolve) => {
        chrome.storage.local.get(CONFIG_KEYS, (items) => resolve(items || {}));
    });
}

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

function inferTitleMode(items) {
    if (items.titleMode) return items.titleMode;
    if (items.autoTitleEnabled === false) return 'prompt';
    return items.llmBaseUrl ? 'llm' : 'auto';
}

function populateOptions(items) {
    document.getElementById('notionKey').value = items.notionKey || '';
    document.getElementById('notionParentId').value = items.notionParentId || '';
    document.getElementById('notionParentType').value = items.notionParentType || 'auto';
    document.getElementById('obsidianUrl').value = items.obsidianUrl || '';
    document.getElementById('obsidianKey').value = items.obsidianKey || '';
    document.getElementById('titleMode').value = inferTitleMode(items);
    document.getElementById('llmBaseUrl').value = items.llmBaseUrl || 'http://127.0.0.1:1234';
    document.getElementById('llmModel').value = items.llmModel || '';
}

async function restoreOptions() {
    const merged = await sendMessageAsync({ action: 'getMergedConfig' });
    const items = (merged?.success && merged?.config)
        ? merged.config
        : await getStorageOptions();
    populateOptions(items);
}
