document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

function saveOptions() {
    const notionKey = document.getElementById('notionKey').value;
    const notionParentId = document.getElementById('notionParentId').value;
    const notionParentType = document.getElementById('notionParentType').value;
    const obsidianUrl = document.getElementById('obsidianUrl').value;
    const obsidianKey = document.getElementById('obsidianKey').value;
    const autoTitleEnabled = document.getElementById('autoTitleEnabled').checked;

    chrome.storage.local.set(
        { notionKey, notionParentId, notionParentType, obsidianUrl, obsidianKey, autoTitleEnabled },
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
        ['notionKey', 'notionParentId', 'notionParentType', 'obsidianUrl', 'obsidianKey', 'autoTitleEnabled'],
        (items) => {
            document.getElementById('notionKey').value = items.notionKey || '';
            document.getElementById('notionParentId').value = items.notionParentId || '';
            document.getElementById('notionParentType').value = items.notionParentType || 'auto';
            document.getElementById('obsidianUrl').value = items.obsidianUrl || '';
            document.getElementById('obsidianKey').value = items.obsidianKey || '';
            document.getElementById('autoTitleEnabled').checked = items.autoTitleEnabled !== false;
        }
    );
}
