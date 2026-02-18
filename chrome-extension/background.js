const CONFIG_KEYS = [
    'notionKey',
    'notionParentId',
    'notionParentType',
    'obsidianUrl',
    'obsidianKey',
    'titleMode',
    'llmBaseUrl',
    'llmModel',
    'autoTitleEnabled'
];

const API_FILE_KEY_TO_CONFIG_KEY = {
    NOTION_KEY: 'notionKey',
    NOTION_PARENT_ID: 'notionParentId',
    NOTION_PARENT_TYPE: 'notionParentType',
    OBSIDIAN_URL: 'obsidianUrl',
    OBSIDIAN_KEY: 'obsidianKey',
    TITLE_MODE: 'titleMode',
    LLM_BASE_URL: 'llmBaseUrl',
    LLM_MODEL: 'llmModel'
};

function stripWrappingQuotes(value) {
    if (value.length < 2) return value;
    const startsWithSingle = value.startsWith('\'') && value.endsWith('\'');
    const startsWithDouble = value.startsWith('"') && value.endsWith('"');
    return (startsWithSingle || startsWithDouble) ? value.slice(1, -1) : value;
}

function normalizeConfigValue(key, value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';

    if (key === 'titleMode') {
        const normalized = trimmed.toLowerCase();
        return ['llm', 'auto', 'prompt'].includes(normalized) ? normalized : '';
    }

    if (key === 'notionParentType') {
        const normalized = trimmed.toLowerCase();
        return ['auto', 'page', 'database'].includes(normalized) ? normalized : '';
    }

    return trimmed;
}

function parseDotApiConfig(text) {
    const config = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;

        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 0) continue;

        const rawKey = line.slice(0, separatorIndex).trim().toUpperCase();
        const configKey = API_FILE_KEY_TO_CONFIG_KEY[rawKey];
        if (!configKey) continue;

        const rawValue = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
        const normalizedValue = normalizeConfigValue(configKey, rawValue);
        if (normalizedValue) config[configKey] = normalizedValue;
    }
    return config;
}

async function readDotApiConfig() {
    try {
        const response = await fetch(chrome.runtime.getURL('.api'), { cache: 'no-store' });
        if (!response.ok) return {};
        const text = await response.text();
        return parseDotApiConfig(text);
    } catch {
        return {};
    }
}

function getStorageConfig() {
    return new Promise((resolve) => {
        chrome.storage.local.get(CONFIG_KEYS, (items) => resolve(items || {}));
    });
}

function hasConfigValue(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null;
}

function mergeConfig(storageConfig, fileConfig) {
    const merged = { ...storageConfig };
    for (const [key, fileValue] of Object.entries(fileConfig)) {
        if (!hasConfigValue(storageConfig[key]) && hasConfigValue(fileValue)) {
            merged[key] = fileValue;
        }
    }
    return merged;
}

async function resolveMergedConfig() {
    const [storageConfig, fileConfig] = await Promise.all([getStorageConfig(), readDotApiConfig()]);
    return mergeConfig(storageConfig, fileConfig);
}

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function normalizeNotionId(rawId) {
    if (!rawId) return '';
    const cleaned = rawId.trim().replace(/[-\s]/g, '');
    if (cleaned.length !== 32) return rawId.trim();
    return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
}

function splitText(text, limit = 2000) {
    const chunks = [];
    for (let index = 0; index < text.length; index += limit) {
        chunks.push(text.slice(index, index + limit));
    }
    return chunks.length ? chunks : [''];
}

function textToRichText(text, inheritedAnnotations = {}) {
    const richTextArray = [];
    const pattern = /(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)|\*\*(.+?)\*\*|__(.+?)__|(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)([^_]+?)(?<!_)_(?!_)|`([^`]+)`|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)/gs;
    let lastEnd = 0;

    const pushPlainText = (plainText) => {
        if (!plainText) return;
        for (const chunk of splitText(plainText)) {
            const item = { type: 'text', text: { content: chunk } };
            if (Object.keys(inheritedAnnotations).length > 0) item.annotations = { ...inheritedAnnotations };
            richTextArray.push(item);
        }
    };

    for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (start > lastEnd) pushPlainText(text.slice(lastEnd, start));

        const groups = match.slice(1);
        if (groups[0] !== undefined) {
            for (const chunk of splitText(groups[0])) {
                richTextArray.push({ type: 'equation', equation: { expression: chunk } });
            }
        } else if (groups[1] !== undefined || groups[2] !== undefined) {
            const content = groups[1] ?? groups[2];
            richTextArray.push(...textToRichText(content, { ...inheritedAnnotations, bold: true }));
        } else if (groups[3] !== undefined || groups[4] !== undefined) {
            const content = groups[3] ?? groups[4];
            richTextArray.push(...textToRichText(content, { ...inheritedAnnotations, italic: true }));
        } else if (groups[5] !== undefined) {
            for (const chunk of splitText(groups[5])) {
                richTextArray.push({
                    type: 'text',
                    text: { content: chunk },
                    annotations: { ...inheritedAnnotations, code: true }
                });
            }
        } else if (groups[6] !== undefined) {
            richTextArray.push(...textToRichText(groups[6], { ...inheritedAnnotations, strikethrough: true }));
        } else if (groups[7] !== undefined && groups[8] !== undefined) {
            for (const chunk of splitText(groups[7])) {
                const item = { type: 'text', text: { content: chunk, link: { url: groups[8] } } };
                if (Object.keys(inheritedAnnotations).length > 0) item.annotations = { ...inheritedAnnotations };
                richTextArray.push(item);
            }
        }

        lastEnd = start + match[0].length;
    }

    if (lastEnd < text.length) pushPlainText(text.slice(lastEnd));
    if (!richTextArray.length) pushPlainText(text);
    return richTextArray;
}

function parseMarkdownToBlocks(rawText) {
    const text = rawText
        .replace(/\n*Send to Notion\s*$/g, '')
        .replace(/\n*Send to Obsidian\s*$/g, '');

    const blocks = [];
    const lines = text.split('\n');
    let index = 0;
    let isCodeBlock = false;
    let isEquationBlock = false;
    let codeLanguage = 'plain text';
    let buffer = [];

    while (index < lines.length) {
        const line = lines[index];
        const stripped = line.trim();

        if (stripped.startsWith('$$') && !isCodeBlock) {
            if (!isEquationBlock) {
                isEquationBlock = true;
                buffer = [];
                if (stripped.endsWith('$$') && stripped.length > 4) {
                    const formula = stripped.slice(2, -2).trim();
                    blocks.push({ object: 'block', type: 'equation', equation: { expression: formula } });
                    isEquationBlock = false;
                } else if (stripped.length > 2) {
                    buffer.push(stripped.slice(2));
                }
            } else {
                if (stripped.endsWith('$$') && stripped.length > 2) buffer.push(stripped.slice(0, -2));
                blocks.push({ object: 'block', type: 'equation', equation: { expression: buffer.join('\n') } });
                isEquationBlock = false;
            }
            index += 1;
            continue;
        }

        if (isEquationBlock) {
            if (stripped.endsWith('$$')) {
                buffer.push(stripped.slice(0, -2));
                blocks.push({ object: 'block', type: 'equation', equation: { expression: buffer.join('\n') } });
                isEquationBlock = false;
            } else {
                buffer.push(line);
            }
            index += 1;
            continue;
        }

        if (stripped.startsWith('```')) {
            if (!isCodeBlock) {
                isCodeBlock = true;
                codeLanguage = stripped.slice(3).trim() || 'plain text';
                const languageMap = { js: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell' };
                codeLanguage = languageMap[codeLanguage.toLowerCase()] || codeLanguage;
                buffer = [];
            } else {
                const code = buffer.join('\n');
                blocks.push({
                    object: 'block',
                    type: 'code',
                    code: {
                        language: codeLanguage,
                        rich_text: [{ type: 'text', text: { content: code.slice(0, 2000) } }]
                    }
                });
                isCodeBlock = false;
            }
            index += 1;
            continue;
        }

        if (isCodeBlock) {
            buffer.push(line);
            index += 1;
            continue;
        }

        if (stripped.startsWith('>')) {
            const quoteLines = [];
            while (index < lines.length && lines[index].trim().startsWith('>')) {
                quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
                index += 1;
            }
            const quoteText = quoteLines.join('\n').trim();
            if (quoteText) {
                blocks.push({ object: 'block', type: 'quote', quote: { rich_text: textToRichText(quoteText) } });
            }
            continue;
        }

        if (line.startsWith('#### ')) {
            blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: textToRichText(line.slice(5)) } });
            index += 1;
            continue;
        }
        if (line.startsWith('### ')) {
            blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: textToRichText(line.slice(4)) } });
            index += 1;
            continue;
        }
        if (line.startsWith('## ')) {
            blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: textToRichText(line.slice(3)) } });
            index += 1;
            continue;
        }
        if (line.startsWith('# ')) {
            blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: textToRichText(line.slice(2)) } });
            index += 1;
            continue;
        }

        const todoMatch = stripped.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
        if (todoMatch) {
            blocks.push({
                object: 'block',
                type: 'to_do',
                to_do: { checked: todoMatch[1].toLowerCase() === 'x', rich_text: textToRichText(todoMatch[2]) }
            });
            index += 1;
            continue;
        }

        const orderedMatch = stripped.match(/^(\d+)\.\s+(.+)$/);
        if (orderedMatch) {
            blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: textToRichText(orderedMatch[2]) } });
            index += 1;
            continue;
        }

        if (stripped.startsWith('- ') || stripped.startsWith('* ')) {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: textToRichText(stripped.slice(2)) } });
            index += 1;
            continue;
        }

        if (/^[-*_]{3,}$/.test(stripped)) {
            blocks.push({ object: 'block', type: 'divider', divider: {} });
            index += 1;
            continue;
        }

        if (stripped) {
            blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: textToRichText(line) } });
        }
        index += 1;
    }

    return blocks;
}

async function notionFetch(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(`${NOTION_API_BASE}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    return { ok: response.ok, status: response.status, payload };
}

function resolveErrorMessage(result) {
    if (typeof result.payload === 'string') return result.payload;
    if (result.payload && result.payload.message) return result.payload.message;
    return `Request failed with status ${result.status}`;
}

async function resolveNotionParent(token, parentId, parentType) {
    if (parentType === 'database') {
        const db = await notionFetch(`/databases/${parentId}`, { token });
        if (!db.ok) throw new Error(`Database lookup failed: ${resolveErrorMessage(db)}`);
        const titlePropertyName = Object.keys(db.payload.properties || {}).find((name) => db.payload.properties[name].type === 'title');
        if (!titlePropertyName) throw new Error('No title property found in this database.');
        return { kind: 'database', id: parentId, titlePropertyName };
    }

    if (parentType === 'page') {
        const page = await notionFetch(`/pages/${parentId}`, { token });
        if (!page.ok) throw new Error(`Page lookup failed: ${resolveErrorMessage(page)}`);
        return { kind: 'page', id: parentId };
    }

    const autoDb = await notionFetch(`/databases/${parentId}`, { token });
    if (autoDb.ok) {
        const titlePropertyName = Object.keys(autoDb.payload.properties || {}).find((name) => autoDb.payload.properties[name].type === 'title');
        if (!titlePropertyName) throw new Error('No title property found in this database.');
        return { kind: 'database', id: parentId, titlePropertyName };
    }

    const autoPage = await notionFetch(`/pages/${parentId}`, { token });
    if (autoPage.ok) return { kind: 'page', id: parentId };

    throw new Error(`Could not resolve parent ID. Database error: ${resolveErrorMessage(autoDb)} / Page error: ${resolveErrorMessage(autoPage)}`);
}

async function createNotionPage({ token, title, markdown, parentId, parentType }) {
    const resolvedParentId = normalizeNotionId(parentId);
    const parent = await resolveNotionParent(token, resolvedParentId, parentType || 'auto');
    const children = parseMarkdownToBlocks(markdown);

    const properties = parent.kind === 'database'
        ? {
            [parent.titlePropertyName]: {
                title: [{ type: 'text', text: { content: title.slice(0, 2000) } }]
            }
        }
        : {
            title: {
                title: [{ type: 'text', text: { content: title.slice(0, 2000) } }]
            }
        };

    const createPayload = {
        parent: parent.kind === 'database' ? { database_id: parent.id } : { page_id: parent.id },
        properties,
        children: children.slice(0, 100)
    };

    const createPageResult = await notionFetch('/pages', {
        method: 'POST',
        token,
        body: createPayload
    });

    if (!createPageResult.ok) {
        throw new Error(resolveErrorMessage(createPageResult));
    }

    const pageId = createPageResult.payload.id;
    for (let index = 100; index < children.length; index += 100) {
        const appendResult = await notionFetch(`/blocks/${pageId}/children`, {
            method: 'PATCH',
            token,
            body: { children: children.slice(index, index + 100) }
        });
        if (!appendResult.ok) throw new Error(resolveErrorMessage(appendResult));
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getMergedConfig') {
        (async () => {
            try {
                const config = await resolveMergedConfig();
                sendResponse({ success: true, config });
            } catch (error) {
                sendResponse({ success: false, error: error.message || String(error), config: {} });
            }
        })();
        return true;
    }

    if (request.action === 'sendToNotion') {
        (async () => {
            try {
                const { title, content, config } = request;
                if (!config?.notionKey) throw new Error('Notion Integration Token is missing.');
                if (!config?.notionParentId) throw new Error('Notion Parent ID is missing.');
                await createNotionPage({
                    token: config.notionKey,
                    title: title || 'Gemini Response',
                    markdown: content || '',
                    parentId: config.notionParentId,
                    parentType: config.notionParentType || 'auto'
                });
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: error.message || String(error) });
            }
        })();
        return true;
    }

    if (request.action === 'llmChatCompletions') {
        const { url, body } = request;
        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body || {})
        })
            .then(async (response) => {
                const txt = await response.text();
                if (!response.ok) return sendResponse({ success: false, error: txt || `HTTP ${response.status}` });
                try {
                    const json = JSON.parse(txt);
                    const title = (
                        json?.choices?.[0]?.message?.content
                        || json?.choices?.[0]?.text
                        || ''
                    ).trim();
                    return sendResponse({ success: true, title });
                } catch (e) {
                    return sendResponse({ success: false, error: `Invalid JSON: ${e?.message || e}` });
                }
            })
            .catch((error) => sendResponse({ success: false, error: error.toString() }));
        return true;
    }

    if (request.action === 'llmListModels') {
        const { url } = request;
        fetch(url, { method: 'GET' })
            .then(async (response) => {
                const txt = await response.text();
                if (!response.ok) return sendResponse({ success: false, error: txt || `HTTP ${response.status}`, models: [] });
                try {
                    const json = JSON.parse(txt);
                    const models = Array.isArray(json?.data)
                        ? json.data.map((item) => String(item?.id || '').trim()).filter(Boolean)
                        : [];
                    return sendResponse({ success: true, models });
                } catch (e) {
                    return sendResponse({ success: false, error: `Invalid JSON: ${e?.message || e}`, models: [] });
                }
            })
            .catch((error) => sendResponse({ success: false, error: error.toString(), models: [] }));
        return true;
    }

    if (request.action === 'proxyRequest') {
        const { method, url, data, headers } = request;
        let resolvedUrl;
        try {
            resolvedUrl = new URL(String(url || '')).toString();
        } catch {
            sendResponse({ success: false, error: `Invalid URL: ${url || '(empty)'}` });
            return true;
        }

        fetch(resolvedUrl, {
            method,
            headers,
            body: typeof data === 'object' ? JSON.stringify(data) : data
        })
            .then(async (response) => {
                if (response.ok) {
                    sendResponse({ success: true });
                    return;
                }

                const text = (await response.text()).trim();
                const detail = text || `HTTP ${response.status}`;
                sendResponse({
                    success: false,
                    error: `HTTP ${response.status} from ${resolvedUrl}: ${detail}`
                });
            })
            .catch((error) => {
                const message = error?.message || String(error);
                if (/Failed to fetch/i.test(message)) {
                    sendResponse({
                        success: false,
                        error: `Network error for ${resolvedUrl}. Check OBSIDIAN_URL and ensure the Obsidian Local REST API is reachable.`
                    });
                    return;
                }
                sendResponse({ success: false, error: message });
            });
        return true;
    }
});
