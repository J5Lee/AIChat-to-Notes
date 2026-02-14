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
                    const title = json?.choices?.[0]?.message?.content?.trim() || '';
                    return sendResponse({ success: true, title });
                } catch (e) {
                    return sendResponse({ success: false, error: `Invalid JSON: ${e?.message || e}` });
                }
            })
            .catch((error) => sendResponse({ success: false, error: error.toString() }));
        return true;
    }

    if (request.action === 'proxyRequest') {
        const { method, url, data, headers } = request;
        fetch(url, {
            method,
            headers,
            body: typeof data === 'object' ? JSON.stringify(data) : data
        })
            .then((response) => {
                if (response.ok) sendResponse({ success: true });
                else response.text().then((text) => sendResponse({ success: false, error: text }));
            })
            .catch((error) => sendResponse({ success: false, error: error.toString() }));
        return true;
    }
});
