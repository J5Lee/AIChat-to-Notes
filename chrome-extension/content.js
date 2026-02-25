(function () {
    'use strict';

    const host = window.location.hostname;
    const isChatGptHost = host.includes('chatgpt.com') || host.includes('openai.com');
    const isGeminiHost = host.includes('gemini.google.com');
    const isNotebookLmHost = host.includes('notebooklm.google.com') || host.includes('notebooklm.googleusercontent.com');
    const isClaudeHost = host.includes('claude.ai');
    const isPerplexityHost = host.includes('perplexity.ai');

    const platformName = isNotebookLmHost
        ? 'NotebookLM'
        : (isClaudeHost
            ? 'Claude'
            : (isPerplexityHost
                ? 'Perplexity'
                : (isChatGptHost ? 'ChatGPT' : 'Gemini')));
    if (!shouldRunInFrame()) return;

    const CONFIG_KEYS = ['notionKey', 'notionParentId', 'notionParentType', 'obsidianUrl', 'obsidianKey', 'titleMode', 'llmBaseUrl', 'llmModel', 'autoTitleEnabled'];
    const CHATGPT_BLOCK_SELECTOR = [
        '[data-message-author-role="assistant"]',
        'article[data-testid^="conversation-turn-"][data-testid$="-assistant"]',
        '[data-testid^="conversation-turn-"][data-testid$="-assistant"]',
        'main article[data-testid*="assistant"]'
    ].join(',');
    const CHATGPT_USER_SELECTOR = '[data-message-author-role="user"]';
    const GEMINI_BLOCK_SELECTORS = [
        'message-content',
        '[data-message-author-role="model"]',
        'article[data-message-author-role="model"]',
        '[data-testid*="response" i]',
        '[class*="model-response" i]',
        '[class*="response-container" i]'
    ];
    const CLAUDE_BLOCK_SELECTORS = [
        '[data-testid*="assistant" i]',
        '[data-testid*="message" i][data-testid*="assistant" i]',
        'div[class*="assistant" i]',
        'article[class*="assistant" i]',
        '[role="article"][data-testid*="message" i]'
    ];
    const PERPLEXITY_BLOCK_SELECTORS = [
        'div[class*="answer" i]',
        'div[class*="response" i]',
        'div[class*="prose" i]',
        '[data-testid*="answer" i]',
        '[data-testid*="response" i]',
        '[role="article"]'
    ];
    const CHATGPT_STOP_SELECTOR = [
        'button[data-testid="stop-button"]',
        'button[aria-label*="stop generating" i]',
        'button[aria-label*="생성 중지" i]',
        'button[aria-label*="생성을 중지" i]'
    ].join(',');
    const CHATGPT_BUSY_SELECTOR = [
        '[data-message-author-role="assistant"][aria-busy="true"]',
        'article[aria-busy="true"]',
        '[data-testid*="assistant"][aria-busy="true"]'
    ].join(',');
    const GENERATION_STATE_CACHE_TTL_MS = 250;
    const MAX_PENDING_BLOCKS = 16;
    const MAX_MUTATION_NODES_PER_BATCH = 60;
    const NOTEBOOK_INJECT_MIN_INTERVAL_MS = 700;
    const CHATGPT_SELF_HEAL_INTERVAL_MS = 3500;
    const CHATGPT_SELF_HEAL_COOLDOWN_MS = 1200;
    const DOM_COMMIT_FALLBACK_DELAY_MS = 16;
    const KB_STYLE_TAG_ID = 'kb-aichat-notes-style';
    const KB_PERF_PREFIX = 'kb:perf';
    const KB_STYLE_TEXT = [
        '.kb-btn-wrapper{display:flex;gap:8px;justify-content:flex-end;width:100%;}',
        '.kb-btn-wrapper--chat{margin-top:15px;padding-top:10px;border-top:1px solid #eee;margin-left:auto;align-self:flex-end;}',
        '.kb-btn-wrapper--notebook{margin:2px 0 8px;}',
        '.kb-btn{padding:6px 14px;cursor:pointer;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:11px;line-height:1.2;}',
        '.kb-btn--obsidian{background:#483699;}',
        '.kb-btn:disabled{opacity:.7;cursor:not-allowed;}'
    ].join('');

    let __kbGeneratingCache = { at: 0, value: false };
    let __kbLastNotebookInjectAt = 0;
    let __kbStyleInjected = false;
    let __kbPerfMeasureSeq = 0;
    let __kbLastSelfHealAt = 0;

    function ensureUiStyles() {
        if (__kbStyleInjected) return;
        const root = document.head || document.documentElement;
        if (!root) return;
        if (document.getElementById(KB_STYLE_TAG_ID)) {
            __kbStyleInjected = true;
            return;
        }
        const style = document.createElement('style');
        style.id = KB_STYLE_TAG_ID;
        style.textContent = KB_STYLE_TEXT;
        root.append(style);
        __kbStyleInjected = true;
    }

    function measureSync(label, fn) {
        if (typeof performance === 'undefined' || typeof performance.mark !== 'function' || typeof performance.measure !== 'function') {
            return fn();
        }
        __kbPerfMeasureSeq += 1;
        const start = `${KB_PERF_PREFIX}:${label}:start:${__kbPerfMeasureSeq}`;
        const end = `${KB_PERF_PREFIX}:${label}:end:${__kbPerfMeasureSeq}`;

        performance.mark(start);
        try {
            return fn();
        } finally {
            try {
                performance.mark(end);
                performance.measure(`${KB_PERF_PREFIX}:${label}`, start, end);
            } catch {
                // Ignore perf timeline failures.
            }
            try {
                performance.clearMarks(start);
                performance.clearMarks(end);
            } catch {
                // Ignore cleanup failures.
            }
        }
    }

    // Best effort on initial load; createTransferButtons() also ensures styles.
    ensureUiStyles();

    // Helper: Get config (storage + .api fallback via background)
    async function getConfig() {
        const merged = await sendMessageAsync({ action: 'getMergedConfig' });
        if (merged?.success && merged?.config) return merged.config;
        return new Promise((resolve) => chrome.storage.local.get(CONFIG_KEYS, (items) => resolve(items || {})));
    }

    function generateAutoTitle() {
        // platform + creation time
        // Use a filename-safe timestamp (no ':' which breaks on Windows/macOS Finder sync tools)
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        return `${platformName}-${ts}`;
    }

    function sanitizeFileName(name, maxLen = 120) {
        const cleaned = (name || '')
            .replace(/[\\/:*?"<>|]/g, ' ') // Windows/portable
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned.slice(0, maxLen) || generateAutoTitle();
    }

    function inferTitleMode(config) {
        // Back-compat with autoTitleEnabled
        if (config?.titleMode) return config.titleMode;
        if (config?.autoTitleEnabled === false) return 'prompt';
        if (config?.llmBaseUrl) return 'llm';
        return 'auto';
    }

    function sendMessageAsync(payload) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(payload, (resp) => resolve(resp));
            } catch (e) {
                resolve({ success: false, error: e?.message || String(e) });
            }
        });
    }

    function normalizeGeneratedTitle(rawTitle) {
        let text = String(rawTitle || '').replace(/\r\n/g, '\n').trim();
        if (!text) return '';

        // Strip fenced wrappers sometimes returned by local models.
        text = text.replace(/^```[a-zA-Z0-9_-]*\n?/g, '').replace(/\n?```$/g, '').trim();

        // Drop explicit reasoning blocks if the model ignored the instruction.
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
        text = text.replace(/<\/?(analysis|reasoning)>/gi, ' ').trim();

        const lines = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^\s*(?:final answer|final|answer|output|title|suggested title)\s*[:\-]\s*/i, '').trim())
            .filter(Boolean);
        if (!lines.length) return '';

        const metaPattern = /\b(?:the user|assistant|prompt|response|question|task|let'?s|tackle|step by step|reasoning|analysis|think)\b/i;
        let title = lines.find((line) => !metaPattern.test(line)) || lines[lines.length - 1] || lines[0];
        title = title.replace(/^["'`]+|["'`]+$/g, '').replace(/[*_`#~]/g, '').trim();

        if (title.length > 70 || metaPattern.test(title)) {
            const sentenceCandidate = title
                .split(/[.!?]\s+/)
                .map((part) => part.trim())
                .find((part) => part && part.length <= 60 && !metaPattern.test(part));
            if (sentenceCandidate) title = sentenceCandidate;
        }

        return title.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim();
    }

    function isSuspiciousGeneratedTitle(title) {
        if (!title) return true;
        if (/[\n\r]/.test(title)) return true;
        if (/[\uAC00-\uD7AF]/.test(title)) return true;
        if (title.length < 3 || title.length > 90) return true;
        if (/^\s*(?:think|thinking|analysis|reasoning|okay\b|let'?s)\b/i.test(title)) return true;
        if (/\b(?:the user|assistant|prompt|response|question|task)\b/i.test(title)) return true;
        const words = title.split(/\s+/).filter(Boolean).length;
        return words > 16;
    }

    function fitTitleLength(title, maxChars = 40) {
        const clean = String(title || '').replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        if (clean.length <= maxChars) return clean;
        const sliced = clean.slice(0, maxChars);
        return sliced.replace(/\s+\S*$/g, '').trim() || clean.slice(0, maxChars).trim();
    }

    function fallbackTitleFromMarkdown(assistantMarkdown) {
        const source = String(assistantMarkdown || '').replace(/^---[\s\S]*?---\n\n/, '');
        const lines = source
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^\d+\.\s+/, '').replace(/^[-*+]\s+/, '').trim())
            .filter((line) => (
                line
                && line.length >= 6
                && line.length <= 100
                && !/^```/.test(line)
                && !/^\|/.test(line)
                && !/^\$\$/.test(line)
            ));

        const picked = lines[0] || '';
        if (!picked) return generateAutoTitle();
        const compact = picked.replace(/[*_`#~]/g, '').replace(/\s+/g, ' ').trim();
        return compact || generateAutoTitle();
    }

    async function generateTitleWithLocalLLM({ config, userPrompt, assistantMarkdown }) {
        const baseUrl = (config?.llmBaseUrl || 'http://127.0.0.1:1234').replace(/\/+$/g, '');
        let model = (config?.llmModel || '').trim();

        // If no model was configured, auto-pick the first model from /v1/models.
        if (!model) {
            const modelResp = await sendMessageAsync({
                action: 'llmListModels',
                url: `${baseUrl}/v1/models`
            });
            if (modelResp?.success && Array.isArray(modelResp.models) && modelResp.models.length > 0) {
                model = modelResp.models[0];
            }
        }

        // Keep it short for latency + privacy (don’t ship entire conversation)
        const excerpt = (assistantMarkdown || '').replace(/^---[\s\S]*?---\n\n/, '').slice(0, 4000);
        const up = (userPrompt || '').slice(0, 800);

        const system = [
            'You generate concise note titles.',
            'Output MUST be English only.',
            'Output ONLY the title text: no quotes, no markdown, no trailing period.',
            'Avoid file-name forbidden chars: \\ / : * ? " < > |',
            'Do not output reasoning, analysis, or any preface.'
        ].join(' ');

        const user = [
            'Task: Create a short, clear English note title.',
            'If the source text is Korean or mixed-language, translate concepts to English and still output English.',
            'Return ONLY the title text on a single line.',
            'Maximum 40 characters including spaces.',
            'Use concise noun-phrase style (not a full sentence).',
            '',
            'User prompt:',
            up,
            '',
            'Assistant content (excerpt):',
            excerpt
        ].join('\n');

        const makeBody = (extraInstruction) => ({
            model: model || undefined,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: extraInstruction ? `${user}\n\nExtra instruction: ${extraInstruction}` : user }
            ],
            temperature: 0.1,
            max_tokens: 24
        });

        let resp = await sendMessageAsync({
            action: 'llmChatCompletions',
            url: `${baseUrl}/v1/chat/completions`,
            body: makeBody('English only. Do not output any Korean characters.')
        });

        if (!resp?.success) throw new Error(resp?.error || 'LLM title generation failed');

        let title = normalizeGeneratedTitle(resp?.title || '');

        // Retry once when output is noisy (reasoning/preface/Korean/too long).
        if (isSuspiciousGeneratedTitle(title)) {
            resp = await sendMessageAsync({
                action: 'llmChatCompletions',
                url: `${baseUrl}/v1/chat/completions`,
                body: makeBody(
                    'Return exactly one concise English title line. '
                    + 'No thinking text, no explanation, no labels, no quotes. '
                    + 'Max 40 characters.'
                )
            });
            if (resp?.success) title = normalizeGeneratedTitle(resp?.title || '');
        }

        if (!resp?.success) throw new Error(resp?.error || 'LLM title generation failed');

        if (isSuspiciousGeneratedTitle(title)) {
            title = fallbackTitleFromMarkdown(assistantMarkdown);
        }

        return sanitizeFileName(fitTitleLength(title, 40), 40);
    }

    /**
     * Advanced Post-processing for Obsidian
     */
    function postProcessForObsidian(md) {
        // 0. ChatGPT UI artifacts cleanup (best-effort)
        // Some ChatGPT code blocks are converted into:
        //   python\n\nCopy code\n\n`...`
        // or:
        //   mermaid\n\nCopy code\n\n`flowchart ...`
        // Convert those into fenced blocks.
        md = md.replace(/^([a-zA-Z0-9_+-]+)\s*\n\s*Copy code\s*\n\s*`([\s\S]*?)`\s*$/gmi, (m, lang, code) => {
            const l = String(lang || '').trim().toLowerCase();
            const body = String(code || '').replace(/\r\n/g, '\n').trim();
            // only convert known-ish short language tags to avoid false positives
            if (l.length > 16) return m;
            return `\n\n\
\
\
\`\`\`${l}\n${body}\n\`\`\`\n\n`;
        });

        // Remove stray "Copy code" lines that still leak through.
        md = md.replace(/^Copy code\s*$/gmi, '');

        // 0.5. Convert <details>/<summary> blocks into plain markdown.
        // Obsidian can be finicky about rendering LaTeX inside raw HTML details tags.
        md = md.replace(/<details>\s*<summary>([\s\S]*?)<\/summary>/gmi, (m, summary) => {
            const title = String(summary || '').replace(/<[^>]*>/g, '').trim();
            return `\n\n---\n\n### ${title}\n\n`;
        });
        md = md.replace(/<\/details>/gmi, '\n\n');

        // 1. Unescape backslashes before markdown symbols
        md = md.replace(/\\([$_\*#])/g, '$1');

        // 2. [WHITESPACE LINE CLEANUP] Convert lines with only spaces/tabs to empty lines
        md = md.replace(/\n[ \t]+\n/g, '\n\n');

        // 3. [NEWLINE COMPRESSION] Normalize excessive newlines (3+ -> 2)
        md = md.replace(/\n{3,}/g, '\n\n');

        // 3.2. [HEADER SPACING FIX] Reduce newlines AFTER headers (2 -> 1)
        md = md.replace(/^(#+ .*)\n\n/gm, '$1\n');

        // 3.5. [BLOCK MATH SPACING] Remove blank lines around block math $$
        md = md.replace(/\n\n(\$\$\n)/g, '\n$1');   // blank line before opening $$
        md = md.replace(/(\n\$\$)\n\n/g, '$1\n');   // blank line after closing $$

        // 3.6. [MATH→TABLE SPACING] Obsidian table rendering often fails if a table starts
        // immediately after a closing $$ without a blank line.
        md = md.replace(/(\n\$\$)\n(?=\|)/g, '$1\n\n');

        // 3.7. [TABLE NORMALIZATION] Normalize markdown table rows and force blank-line
        // boundaries so Obsidian consistently recognizes tables in Reading/Live Preview.
        md = transformOutsideCodeFences(md, normalizeMarkdownTablesForObsidian);

        // 4. [LIST SPACING FIX] Remove blank lines between consecutive list items
        md = md.replace(/^(\d+\..+)\n\n(?=\d+\.)/gm, '$1\n');
        md = md.replace(/^(-.+)\n\n(?=-\s)/gm, '$1\n');
        // Also fix nested lists that Turndown sometimes emits with leading space + dash
        md = md.replace(/^\s+-\s*\n/gm, '');
        md = md.replace(/^(\s*- .+)\n\n(?=\s*-\s)/gm, '$1\n');

        // 5. [HORIZONTAL RULE FIX] Force blank lines around standalone ---
        md = md.replace(/^(.*\S.*)(\n)(---)\s*$/gm, '$1\n\n$3');  // text\n--- -> text\n\n---
        md = md.replace(/^(---)\s*\n(\S)/gm, '$1\n$2');           // ---\ntext -> ---\ntext

        // 5.5. [MATH-HR GUARD] Ensure blank line between closing $$ and ---
        md = md.replace(/^(\$\$)\s*\n(---)/gm, '$1\n\n$2');

        // 6. [BOLD FALLBACK] Convert any remaining ** to __
        md = md.replace(/\*\*/g, '__');

        // 7. [BOLD SPACING FALLBACK] Ensure closing __ has space before special chars
        md = md.replace(/(\S)__([^\s\w])/g, '$1__ $2');

        // 8. Cleanup: Consolidate multiple spaces (but not newlines)
        md = md.replace(/ {2,}/g, ' ');

        const now = new Date().toISOString();
        return `---\ndate: ${now}\nsource: ${platformName}\n---\n\n${md}`;
    }

    function postProcessForNotebookLm(md) {
        let out = (md || '').replace(/\r\n/g, '\n');

        // NotebookLM UI artifacts that occasionally leak into the converted markdown.
        out = out.replace(/^\s*🌍\s*$/gmu, '');
        out = out.replace(/^이모티콘을 찾을 수 없음\s*$/gmi, '');
        out = out.replace(/^로드 중\s*$/gmi, '');
        out = out.replace(/^소스\s+\d+개\s*$/gmi, '');
        out = out.replace(/^\d{1,2}월\s+\d{1,2}일\s+\S+\s*$/gmi, '');
        out = out.replace(/^(오늘|어제)\s*[•·]\s*.+$/gmi, '');

        // Fix compacted bullet lines found in NotebookLM answers.
        out = out.replace(/([.!?])-\s+/g, '$1\n- ');
        out = out.replace(/([가-힣A-Za-z0-9)])-\s+\$/g, '$1\n- $');
        out = out.replace(/([.!?])-\s+__/g, '$1\n- __');

        const lines = out.split('\n');
        const cleaned = [];
        const questionMarker = '__KB_NOTEBOOKLM_USER_QUESTION__::';
        const questionIndexes = [];

        const isLikelyQuestionLine = (line) => {
            const text = (line || '').trim();
            if (!text) return false;
            if (text.length > 120) return false;
            if (/^[-*#>|`]/.test(text)) return false;
            if (/[:：]$/.test(text)) return false;
            if (/[?？]$/.test(text)) return true;
            return /(뭐야|뭐지|어떻게|왜|언제|어디|누구|무엇|알려줘|찾아줘|인가요|일까|할까|이야)$/.test(text);
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                cleaned.push('');
                continue;
            }

            if (isLikelyQuestionLine(trimmed)) {
                questionIndexes.push(cleaned.length);
                cleaned.push(`${questionMarker}${trimmed}`);
                continue;
            }
            cleaned.push(line);
        }

        let finalLines = cleaned;
        if (questionIndexes.length > 0) {
            const lastQuestionIndex = questionIndexes[questionIndexes.length - 1];
            finalLines = cleaned.slice(lastQuestionIndex + 1);
        }

        out = finalLines
            .filter((line) => !line.trim().startsWith(questionMarker))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        out = transformOutsideCodeFences(out, normalizeNotebookLmTables);
        out = transformOutsideCodeFences(out, normalizeNotebookLmHeadings);

        return out;
    }

    function transformOutsideCodeFences(markdown, transformer) {
        if (!markdown) return '';
        if (typeof transformer !== 'function') return markdown;
        const parts = markdown.split(/(```[\s\S]*?```)/g);
        return parts
            .map((part) => (part.startsWith('```') ? part : transformer(part)))
            .join('');
    }

    function normalizeNotebookLmTables(markdown) {
        const lines = markdown.split('\n');
        const isSeparatorRow = (text) => /^\|\s*:?[-]+:?\s*(\|\s*:?[-]+:?\s*)+\|?$/.test(text);
        const isPipeLine = (text) => text.startsWith('|');
        const getPrevNonEmptyText = (idx) => {
            for (let cursor = idx - 1; cursor >= 0; cursor -= 1) {
                const text = lines[cursor].trim();
                if (text) return text;
            }
            return '';
        };
        const getNextNonEmptyText = (idx) => {
            for (let cursor = idx + 1; cursor < lines.length; cursor += 1) {
                const text = lines[cursor].trim();
                if (text) return text;
            }
            return '';
        };
        const isFragmentLine = (idx) => {
            const text = lines[idx].trim();
            if (isPipeLine(text)) return true;

            const prevText = getPrevNonEmptyText(idx);
            const nextText = getNextNonEmptyText(idx);
            if (!text) return isPipeLine(prevText) || isPipeLine(nextText);

            if (text.length > 220) return false;
            return isPipeLine(prevText) && isPipeLine(nextText);
        };
        const getColumns = (text) => text.split('|').map((part) => part.trim()).filter(Boolean);
        const toRow = (cells, colCount) => {
            const normalized = cells
                .map((cell) => (cell || '').trim().replace(/\s+/g, ' '))
                .slice(0, colCount);
            while (normalized.length < colCount) normalized.push('');
            return `| ${normalized.join(' | ')} |`;
        };

        const parseFragmentRows = (fragmentLines, colCount) => {
            const tokens = [];
            fragmentLines.forEach((line) => {
                const text = (line || '').trim();
                if (!text) return;

                if (text === '|') return;

                if (text.includes('|')) {
                    const cells = getColumns(text);
                    if (!cells.length) return;
                    tokens.push(...cells);
                    return;
                }

                tokens.push(text);
            });

            const rows = [];
            for (let cursor = 0; cursor + colCount <= tokens.length; cursor += colCount) {
                rows.push(tokens.slice(cursor, cursor + colCount));
            }
            if (!rows.length && tokens.length) rows.push(tokens.slice(0, colCount));
            return rows;
        };

        const result = [];
        let cursor = 0;
        let index = 0;

        while (index < lines.length) {
            const sepText = lines[index].trim();
            if (!isSeparatorRow(sepText)) {
                index += 1;
                continue;
            }

            const separatorColumns = getColumns(sepText);
            const colCount = separatorColumns.length;
            if (colCount < 2) {
                index += 1;
                continue;
            }

            let start = index - 1;
            while (start >= cursor && isFragmentLine(start)) start -= 1;
            start += 1;

            let end = index + 1;
            while (end < lines.length && isFragmentLine(end)) end += 1;

            const headerRows = parseFragmentRows(lines.slice(start, index), colCount);
            const bodyRows = parseFragmentRows(lines.slice(index + 1, end), colCount);
            if (!headerRows.length) {
                index += 1;
                continue;
            }

            result.push(...lines.slice(cursor, start));
            result.push(toRow(headerRows[0], colCount));
            result.push(`| ${separatorColumns.join(' | ')} |`);
            bodyRows.forEach((row) => result.push(toRow(row, colCount)));

            cursor = end;
            index = end;
        }

        result.push(...lines.slice(cursor));
        return result.join('\n');
    }

    function normalizeNotebookLmHeadings(markdown) {
        const lines = markdown.split('\n');
        const findNextNonEmptyIndex = (startIndex) => {
            for (let idx = startIndex; idx < lines.length; idx += 1) {
                if (lines[idx].trim()) return idx;
            }
            return -1;
        };

        for (let index = 0; index < lines.length; index += 1) {
            const text = lines[index].trim();
            if (!text) continue;

            if (/^#{1,6}\s/.test(text)) continue;
            if (/^[-*+]\s+/.test(text)) continue;
            if (/^>\s?/.test(text)) continue;
            if (/^\|/.test(text)) continue;
            if (/^```/.test(text)) continue;
            if (/^\$\$/.test(text)) continue;
            if (/^[-=_]{3,}$/.test(text)) continue;
            if (text.length < 6 || text.length > 90) continue;
            if (/^[\"'“‘]/.test(text)) continue;
            if (/[.!?]$/.test(text)) continue;
            if (/(니다|다)\.$/.test(text)) continue;

            const prevText = index > 0 ? lines[index - 1].trim() : '';
            const prevBlank = index === 0 || !lines[index - 1].trim();
            const nextBlank = index === lines.length - 1 || !lines[index + 1].trim();

            const isNumericSection = /^\d+\.\s+/.test(text);
            const prevBoundary = prevBlank || prevText === '$$' || /^[-=_]{3,}$/.test(prevText) || prevText.startsWith('|');
            if (isNumericSection) {
                if (!prevBoundary) continue;
                const nextNonEmptyIndex = findNextNonEmptyIndex(index + 1);
                if (nextNonEmptyIndex !== -1) {
                    const nextText = lines[nextNonEmptyIndex].trim();
                    if (nextText.length < 12) continue;
                }
                lines[index] = `## ${text}`;
                continue;
            }

            if (!prevBlank || !nextBlank) continue;
            const nextNonEmptyIndex = findNextNonEmptyIndex(index + 1);
            if (nextNonEmptyIndex === -1) continue;
            const nextText = lines[nextNonEmptyIndex].trim();
            if (nextText.length < 24) continue;

            const hasHeadingCue = /\([^)]+\)$/.test(text)
                || /^(차세대|주요|환경|결론|요약|개요|정리|비교)/.test(text);
            if (!hasHeadingCue) continue;

            lines[index] = `## ${text}`;
        }

        return lines.join('\n');
    }

    function normalizeMarkdownTablesForObsidian(markdown) {
        const lines = String(markdown || '').split('\n');
        const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
        const isTableRow = (line) => {
            const text = (line || '').trim();
            if (!text) return false;
            if (text.startsWith('```')) return false;
            if (text.startsWith('>')) return false;
            return /^\s*\|.*\|\s*$/.test(text);
        };
        const parseColumns = (line) => (
            String(line || '')
                .trim()
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|')
                .map((part) => part.trim())
                .filter((part) => part.length > 0)
        );
        const normalizeRow = (line, colCount) => {
            const cols = parseColumns(line);
            const clipped = cols.slice(0, colCount);
            while (clipped.length < colCount) clipped.push('');
            return `| ${clipped.join(' | ')} |`;
        };

        const output = [];
        let index = 0;
        while (index < lines.length) {
            const line = lines[index];
            const next = lines[index + 1];
            const isTableHead = isTableRow(line) && isTableSeparator(next || '');

            if (!isTableHead) {
                output.push(line);
                index += 1;
                continue;
            }

            const sepCols = parseColumns(next);
            const colCount = sepCols.length;
            if (colCount < 2) {
                output.push(line);
                index += 1;
                continue;
            }

            if (output.length > 0 && output[output.length - 1].trim()) {
                output.push('');
            }

            output.push(normalizeRow(line, colCount));
            output.push(`| ${sepCols.join(' | ')} |`);
            index += 2;

            while (index < lines.length && isTableRow(lines[index])) {
                output.push(normalizeRow(lines[index], colCount));
                index += 1;
            }

            if (index < lines.length && lines[index].trim()) {
                output.push('');
            }
        }

        return output.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function getMessageBlocks() {
        if (isGeminiHost) return collectBlocksBySelectors(GEMINI_BLOCK_SELECTORS);
        if (isNotebookLmHost) return getNotebookLmMessageBlocks();

        // Hot path: keep ChatGPT scans narrow and deterministic.
        if (isChatGptHost) return collectBlocksBySelectors([CHATGPT_BLOCK_SELECTOR]);

        if (isClaudeHost) {
            return collectBlocksBySelectors(CLAUDE_BLOCK_SELECTORS);
        }

        if (isPerplexityHost) {
            return collectBlocksBySelectors(PERPLEXITY_BLOCK_SELECTORS);
        }

        return [];
    }

    function getActiveHostBlockSelectors() {
        if (isChatGptHost) return [CHATGPT_BLOCK_SELECTOR];
        if (isGeminiHost) return GEMINI_BLOCK_SELECTORS;
        if (isClaudeHost) return CLAUDE_BLOCK_SELECTORS;
        if (isPerplexityHost) return PERPLEXITY_BLOCK_SELECTORS;
        return [];
    }

    function collectBlocksBySelectors(selectors) {
        const blockSet = new Set();
        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => blockSet.add(el));
        });

        const candidates = Array.from(blockSet);
        if (candidates.length <= 1) return candidates;
        return candidates.filter((node, idx, arr) => !arr.some((other, otherIdx) => otherIdx !== idx && other.contains(node)));
    }

    function keepMostSpecificNodes(nodes) {
        if (!Array.isArray(nodes) || nodes.length <= 1) return nodes || [];
        return nodes.filter((node, idx, arr) => !arr.some((other, otherIdx) => otherIdx !== idx && node.contains(other)));
    }

    function getNotebookLmMessageBlocks() {
        const root = document.body;
        const blockSet = new Set();
        const selectors = [
            '[data-testid*="response"]',
            '[data-testid*="response-item"]',
            '[data-testid*="turn"]',
            '[data-testid*="message"]',
            '[data-message-author-role]',
            '[data-message-id]',
            '[role="article"]',
            '[role="article"][aria-roledescription]',
            '[role="region"]',
            '[role="group"]',
            '[role="listitem"]',
            '[role="status"]',
            '[aria-live="polite"]',
            '[aria-label*="assistant"]',
            '[aria-label*="response"]',
            '[aria-label*="assistant response"]',
            '[id*="response"]',
            '[id*="message"]',
            '[class*="response"]',
            '[class*="answer"]',
            '[class*="message"]',
            '[class*="bubble"]',
            '[class*="prompt"]',
            '[class*="turn"]',
            '[class*="assistant"]',
            '[class*="content"]',
            '[class*="markdown"]',
            '[class*="prose"]',
            'main article',
            'main section',
            '.chat-turn',
            '.chat-message',
            '.response',
            '.assistant'
        ];

        selectors.forEach((selector) => {
            root.querySelectorAll(selector).forEach((el) => {
                if (isNotebookLmMessageCandidate(el, getNotebookLmMessageScore(el))) {
                    blockSet.add(el);
                }
            });
        });

        if (blockSet.size === 0) {
            root.querySelectorAll('article, section, div').forEach((el) => {
                if (isNotebookLmMessageCandidate(el, getNotebookLmMessageScore(el), true) && getNodeTextLength(el) > 140) {
                    blockSet.add(el);
                }
            });
        }

        if (blockSet.size > 0 && blockSet.size < 3) {
            root.querySelectorAll('div, section, article').forEach((el) => {
                if (isNotebookLmMessageCandidate(el, getNotebookLmMessageScore(el), true) && getNodeTextLength(el) > 220) {
                    blockSet.add(el);
                }
            });
        }

        if (blockSet.size === 0) {
            root.querySelectorAll('main [class], #content [class]').forEach((el) => {
                if (isNotebookLmMessageCandidate(el, getNotebookLmMessageScore(el), true)) {
                    blockSet.add(el);
                }
            });
        }

        const candidates = Array.from(blockSet);
        const specificCandidates = keepMostSpecificNodes(
            candidates.filter((node) => getNodeTextLength(node) >= 80)
        );
        const topCandidates = specificCandidates
            .map((node) => ({ node, score: getNotebookLmMessageScore(node) }))
            .filter(({ node, score }) => score >= (hasNotebookLmMessageHint(node) ? 42 : 72))
            .sort((a, b) => b.score - a.score)
            .slice(0, 24)
            .map(({ node }) => node);

        if (topCandidates.length === 0) {
            const broadNodes = Array.from(root.querySelectorAll('div, article, section, main div, main article'))
                .filter((node) => node instanceof Element)
                .filter((node) => isNotebookLmMessageCandidate(node, getNotebookLmMessageScore(node), true))
                .filter((node) => !node.closest('nav, header, aside, footer, form'));

            const deduped = keepMostSpecificNodes(broadNodes);
            const finalFallback = deduped
                .sort((a, b) => getNotebookLmMessageScore(b) - getNotebookLmMessageScore(a))
                .slice(0, 12);

            if (finalFallback.length > 0) {
                return finalFallback;
            }

            if (window.__aichatToNotesDebug !== false) {
                const selectorCount = new Set(blockSet).size;
                console.warn('[AIChat-to-Notes] No NotebookLM candidates found. Check DOM structure.',
                    { selectorBased: selectorCount, fallbackTried: true });
            }
        }

        return topCandidates;
    }

    function getNotebookLmMessageScore(node) {
        if (!node) return 0;
        const textLength = getNodeTextLength(node);
        const className = (node.className || '').toString().toLowerCase();
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        const role = (node.getAttribute('role') || '').toLowerCase();
        const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
        const elementId = (node.getAttribute('id') || '').toLowerCase();

        const markerText = `${className} ${testId} ${role} ${ariaLabel} ${elementId}`;
        let score = Math.min(textLength / 4, 90);
        if (/\b(response|answer|assistant|chat|markdown|content|bubble|message|turn|prose|prompt)\b/i.test(markerText)) score += 25;
        if (/\b(role|assistant|status|group|article|region|listitem|list)\b/i.test(role)) score += 18;
        if (/\b(assistant|response)\b/i.test(ariaLabel)) score += 14;
        if (node.querySelector('pre, code, blockquote, table, ul, ol, li')) score += 24;

        if (node.getBoundingClientRect) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 640) score += 10;
            if (rect.height > 40 && rect.height < 3200) score += 8;
        }

        return score;
    }

    function hasNotebookLmMessageHint(node) {
        if (!node) return false;
        const className = (node.className || '').toString().toLowerCase();
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        const role = (node.getAttribute('role') || '').toLowerCase();
        const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
        const elementId = (node.getAttribute('id') || '').toLowerCase();

        return /response|answer|message|turn|assistant|chat|markdown|content|bubble|prose|prompt/i.test(
            `${className} ${testId} ${role} ${ariaLabel} ${elementId}`
        );
    }

    function isNotebookLmMessageCandidate(node, score, fallback = false) {
        if (!node || !node.textContent) return false;
        const className = (node.className || '').toString().toLowerCase();
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
        const role = (node.getAttribute('role') || '').toLowerCase();
        const elementId = (node.getAttribute('id') || '').toLowerCase();
        const tag = node.tagName.toLowerCase();
        const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'option', 'nav', 'header', 'footer', 'aside']);
        if (noiseTags.has(tag)) return false;
        if (node.closest('form') || node.closest('header') || node.closest('nav') || node.closest('aside')) return false;
        if (node.querySelector('.kb-btn-wrapper')) return false;
        if (!node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        if (rect.height < 16 || rect.width < 260) return false;

        const hasMessageHints =
            /\b(response|answer|message|turn|assistant|chat|markdown|content)\b/i.test(className + ' ' + testId + ' ' + elementId) ||
            /\b(assistant|response|turn)\b/i.test(ariaLabel) ||
            /\b(listitem|article|region|status)\b/i.test(role);
        const hasText = getNodeTextLength(node) > (fallback ? 110 : 45);
        if (!hasMessageHints && !node.closest('main')) return false;
        if (!hasText) return false;

        if (fallback) return score >= 60;
        return score >= 34;
    }

    function getNodeTextLength(node) {
        return ((node.innerText || '').trim().replace(/\s+/g, ' ').length);
    }

    function shouldRunInFrame() {
        if (window.self === window.top) return true;
        return Boolean(document.querySelector(
            '[data-testid*="response"], [data-message-author-role], [data-message-id], [data-testid*="message"], [role="article"], [role="listitem"], [role="region"], .chat-message, .chat-turn, .assistant, .response'
        ));
    }

    function isEligibleBlock(block) {
        if (!block) return false;
        // Wrapper may be placed after the block on ChatGPT, so check both inside + immediate sibling.
        if (block.querySelector('.kb-btn-wrapper')) return false;
        if (block.nextElementSibling && block.nextElementSibling.classList && block.nextElementSibling.classList.contains('kb-btn-wrapper')) return false;
        if (block.closest('form')) return false;

        const text = (block.innerText || '').trim();
        return text.length > 0;
    }

    function getConfiguredMarkdown(block, target) {
        const isObsidian = target === 'Obsidian';
        // TurndownService is globally available from turndown.js
        const ts = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            hr: '---',
            bulletListMarker: '-',
            strongDelimiter: isObsidian ? '__' : '**'
        });

        // turndownPluginGfm is globally available
        if (typeof turndownPluginGfm !== 'undefined') ts.use(turndownPluginGfm.gfm);
        ts.escape = (s) => s;

        function extractLatexFromNode(node) {
            if (!node || !(node instanceof Element)) return null;

            // Common custom attributes
            const dataMath = node.getAttribute('data-math');
            if (dataMath) return dataMath.trim();

            // KaTeX stores original TeX here
            const katexAnn = node.querySelector('annotation[encoding="application/x-tex"]');
            if (katexAnn?.textContent) return katexAnn.textContent.trim();

            // MathJax v2/v3 patterns
            const mjxScript = node.querySelector('script[type="math/tex"], script[type="math/tex; mode=display"]');
            if (mjxScript?.textContent) return mjxScript.textContent.trim();

            // Fallback to textContent (last resort; often messy for rendered math)
            const text = (node.textContent || '').trim();
            return text || null;
        }

        function isBlockMathNode(node) {
            if (!node || !(node instanceof Element)) return false;
            if (node.classList.contains('math-block')) return true;
            if (node.classList.contains('katex-display')) return true;
            if (node.closest('.katex-display')) return true;
            if (node.tagName === 'DIV') return true;
            // MathJax v3 container
            if (node.tagName === 'MJX-CONTAINER' && node.getAttribute('display') === 'block') return true;
            return false;
        }

        // Math conversion
        // Platforms vary a lot:
        // - Gemini: may include math-* classes / data-math
        // - ChatGPT: KaTeX (.katex / .katex-display + annotation[encoding="application/x-tex"])
        // - Others: MathJax containers / scripts
        ts.addRule('math', {
            filter: (n) => {
                if (!(n instanceof Element)) return false;

                // Original rules
                if (n.classList.contains('math-block') || n.classList.contains('math-inline') || n.tagName === 'MATHEMATICS') return true;

                // KaTeX
                if (n.classList.contains('katex') || n.classList.contains('katex-display')) {
                    // Avoid double-processing nested nodes inside KaTeX
                    const parentKatex = n.parentElement?.closest('.katex, .katex-display');
                    if (parentKatex && parentKatex !== n) return false;
                    return true;
                }

                // MathJax
                if (n.tagName === 'MJX-CONTAINER' || n.classList.contains('MathJax')) return true;

                return false;
            },
            replacement: (c, n) => {
                const math = extractLatexFromNode(n);
                if (!math) return c;
                const isBlock = isBlockMathNode(n);
                return isBlock ? `\n$$\n${math}\n$$\n` : `$${math}$`;
            }
        });

        if (isObsidian) {
            ts.addRule('obsidianBold', {
                filter: ['strong', 'b'],
                replacement: (content, node) => {
                    if (!content.trim()) return content;
                    const trimmed = content.trim();
                    let prefix = '';
                    let suffix = '';
                    const prev = node.previousSibling;
                    const next = node.nextSibling;
                    if (prev) {
                        const t = prev.textContent || '';
                        if (/[\p{L}\p{N}]$/u.test(t)) prefix = ' ';
                    }
                    if (next) {
                        const t = next.textContent || '';
                        if (/^[^\s\w]/.test(t)) suffix = ' ';
                    }
                    return `${prefix}__${trimmed}__${suffix}`;
                }
            });
        }

        const clone = block.cloneNode(true);
        const btns = clone.querySelector('.kb-btn-wrapper');
        if (btns) btns.remove();
        clone.querySelectorAll('button, [role="button"], input, textarea, select').forEach((el) => el.remove());
        clone.querySelectorAll('[role="toolbar"], [class*="action" i], [class*="controls" i], [class*="footer" i]').forEach((el) => {
            const buttonCount = el.querySelectorAll('button, [role="button"]').length;
            if (buttonCount > 0 && getNodeTextLength(el) < 180) el.remove();
        });

        let md = ts.turndown(clone);
        if (isNotebookLmHost) md = postProcessForNotebookLm(md);
        if (isObsidian) md = postProcessForObsidian(md);

        return md;
    }

    function isChatGptGenerating() {
        if (!isChatGptHost) return false;
        const now = Date.now();
        if (now - __kbGeneratingCache.at < GENERATION_STATE_CACHE_TTL_MS) return __kbGeneratingCache.value;

        const stop = document.querySelector(CHATGPT_STOP_SELECTOR);
        const busy = document.querySelector(CHATGPT_BUSY_SELECTOR);
        const generating = Boolean(
            (stop && isVisibleElement(stop))
            || (busy && isVisibleElement(busy))
        );
        __kbGeneratingCache = { at: now, value: generating };
        return generating;
    }

    // Avoid repeated DOM churn: remember which blocks we've already processed.
    const __kbInjectedBlocks = new WeakSet();
    const __kbPendingInjectedBlocks = new WeakSet();

    function getInsertModeForHost() {
        // Gemini layout can break when controls are appended inside response blocks.
        if (isChatGptHost || isGeminiHost) return 'afterend';
        return 'append';
    }

    const scheduleDomCommit = (() => {
        let queued = false;
        let pendingOps = [];

        const run = () => {
            queued = false;
            const ops = pendingOps;
            pendingOps = [];
            if (!ops.length) return;

            measureSync('dom_commit', () => {
                for (const op of ops) {
                    const block = op?.block;
                    const wrapper = op?.wrapper;
                    try {
                        if (!block || !wrapper || !block.isConnected || __kbInjectedBlocks.has(block)) continue;
                        if (op.mode === 'afterend') {
                            block.insertAdjacentElement('afterend', wrapper);
                        } else {
                            block.append(wrapper);
                        }
                        __kbInjectedBlocks.add(block);
                    } catch {
                        // Fallback to in-block append when sibling insertion fails.
                        try {
                            if (block && wrapper && block.isConnected && !__kbInjectedBlocks.has(block)) {
                                block.append(wrapper);
                                __kbInjectedBlocks.add(block);
                            }
                        } catch {
                            // Ignore insertion failures and retry later via future scans.
                        }
                    } finally {
                        if (block) __kbPendingInjectedBlocks.delete(block);
                    }
                }
            });
        };

        return (ops) => {
            if (!ops || !ops.length) return;
            pendingOps.push(...ops);
            if (queued) return;
            queued = true;
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(run);
            } else {
                setTimeout(run, DOM_COMMIT_FALLBACK_DELAY_MS);
            }
        };
    })();

    function injectButtons(passedBlocks = null) {
        measureSync('inject_buttons', () => {
            if (isNotebookLmHost) {
                const now = Date.now();
                if (now - __kbLastNotebookInjectAt < NOTEBOOK_INJECT_MIN_INTERVAL_MS) return;
                __kbLastNotebookInjectAt = now;
                injectNotebookLmButtons();
                return;
            }

            // ChatGPT streams content; injecting mid-stream can place buttons in the middle.
            // Only inject when generation is finished.
            if (isChatGptHost && isChatGptGenerating()) return;

            let blocks = (passedBlocks ? Array.from(passedBlocks) : getMessageBlocks())
                .filter((b) => isEligibleBlock(b));

            if (isChatGptHost && blocks.length > MAX_PENDING_BLOCKS) {
                blocks = blocks.slice(-MAX_PENDING_BLOCKS);
            }

            // If we're doing a full scan (no passed blocks), prefer blocks near the viewport.
            if (!passedBlocks && isChatGptHost) {
                const visibleIdx = [];
                const vh = window.innerHeight || document.documentElement.clientHeight || 0;

                blocks.forEach((block, idx) => {
                    const rect = block.getBoundingClientRect();
                    const isVisible = rect.bottom > 0 && rect.top < vh;
                    if (isVisible) visibleIdx.push(idx);
                });

                if (visibleIdx.length) {
                    const min = Math.max(0, Math.min(...visibleIdx) - 2);
                    const max = Math.min(blocks.length - 1, Math.max(...visibleIdx) + 2);
                    blocks = blocks.slice(min, max + 1);
                } else if (blocks.length > 5) {
                    blocks = blocks.slice(-5);
                }
            }

            const domOps = [];

            blocks.forEach((block) => {
                if (!block) return;

                // If a wrapper already exists, keep cache state in sync and skip.
                const hasWrapperInside = Boolean(block.querySelector('.kb-btn-wrapper'));
                const hasWrapperSibling = Boolean(
                    block.nextElementSibling
                    && block.nextElementSibling.classList
                    && block.nextElementSibling.classList.contains('kb-btn-wrapper')
                );
                if (hasWrapperInside || hasWrapperSibling) {
                    __kbInjectedBlocks.add(block);
                    return;
                }

                // ChatGPT can re-render and remove our wrapper while keeping the same message block node.
                // In that case, clear cache so the button can be re-injected.
                if (__kbInjectedBlocks.has(block)) {
                    __kbInjectedBlocks.delete(block);
                }
                if (__kbPendingInjectedBlocks.has(block)) return;

                const wrapper = createTransferButtons(block, false);
                __kbPendingInjectedBlocks.add(block);
                domOps.push({
                    block,
                    wrapper,
                    mode: getInsertModeForHost()
                });
            });

            scheduleDomCommit(domOps);
        });
    }

    function injectNotebookLmButtons() {
        document.querySelectorAll('.kb-btn-wrapper').forEach((wrapper) => wrapper.remove());

        const blocks = getNotebookLmMessageBlocks()
            .filter((node) => isEligibleBlock(node))
            .filter((node) => isVisibleElement(node));
        if (blocks.length === 0) return;

        blocks.sort((a, b) => {
            if (a === b) return 0;
            const position = a.compareDocumentPosition(b);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        const actionRows = getNotebookLmActionRows();
        const targetBlock = pickNotebookLmTargetBlock(blocks);
        if (!targetBlock) return;

        const targetRow = pickNotebookLmTargetRow(targetBlock, actionRows);
        const wrapper = createTransferButtons(targetBlock, true);
        if (targetRow && targetRow.parentElement) {
            targetRow.parentElement.insertBefore(wrapper, targetRow);
            return;
        }
        targetBlock.append(wrapper);
    }

    function findNotebookLmActionRow(block) {
        if (!block) return null;

        const roots = [];
        roots.push(block);
        roots.push(block.nextElementSibling);
        roots.push(block.parentElement);
        roots.push(block.parentElement ? block.parentElement.nextElementSibling : null);
        roots.push(block.parentElement && block.parentElement.parentElement ? block.parentElement.parentElement : null);
        roots.push(block.parentElement && block.parentElement.parentElement ? block.parentElement.parentElement.nextElementSibling : null);

        for (const root of roots) {
            if (!root) continue;
            const copyButton = findCopyButton(root);
            if (!copyButton) continue;
            const row = getActionRowFromCopyButton(copyButton);
            if (row) return row;
        }

        return null;
    }

    function getNotebookLmActionRows() {
        const root = document.querySelector('main') || document.body;
        const rows = [];
        const seen = new Set();
        const buttons = root.querySelectorAll('button, [role="button"]');

        for (const button of buttons) {
            if (!isVisibleElement(button)) continue;
            if (!isCopyButton(button)) continue;

            const row = getActionRowFromCopyButton(button);
            if (!row || seen.has(row)) continue;
            seen.add(row);
            rows.push(row);
        }

        rows.sort((a, b) => {
            if (a === b) return 0;
            const position = a.compareDocumentPosition(b);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        return rows;
    }

    function findClosestBlockAboveRow(row, blocks) {
        const rowRect = row.getBoundingClientRect();
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        let overlapBest = null;
        let overlapDistance = Number.POSITIVE_INFINITY;

        blocks.forEach((block) => {
            if (!block || !block.isConnected) return;
            if (block === row) return;
            if (block.contains(row)) return;

            const blockRect = block.getBoundingClientRect();
            if (blockRect.top > rowRect.top + 20) return;

            const gap = rowRect.top - blockRect.bottom;
            const hasMultiCopy = countCopyButtons(block) > 1;
            if (hasMultiCopy && getNodeTextLength(block) > 300) return;

            if (gap >= -20) {
                const distance = Math.abs(gap);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = block;
                }
                return;
            }

            const distance = Math.abs(gap);
            if (distance < overlapDistance) {
                overlapDistance = distance;
                overlapBest = block;
            }
        });

        if (best) return best;
        if (overlapBest) return overlapBest;
        const fromDom = findNotebookLmBlockNearRow(row);
        if (fromDom) return fromDom;
        return blocks[blocks.length - 1] || null;
    }

    function isNotebookLmCentralLane(node) {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width < 220 || rect.height < 20) return false;
        if (window.innerWidth < 1000) return true;

        const centerX = rect.left + (rect.width / 2);
        const viewportCenterX = window.innerWidth / 2;
        const maxDistance = window.innerWidth * 0.22;
        return Math.abs(centerX - viewportCenterX) <= maxDistance;
    }

    function pickNotebookLmTargetBlock(blocks) {
        if (!blocks || blocks.length === 0) return null;
        const centralBlocks = blocks.filter((block) => isNotebookLmCentralLane(block));
        const pool = centralBlocks.length ? centralBlocks : blocks;
        if (pool.length === 1) return pool[0];

        let best = null;
        let bestTop = Number.NEGATIVE_INFINITY;
        pool.forEach((block) => {
            const rect = block.getBoundingClientRect();
            if (rect.top > bestTop) {
                bestTop = rect.top;
                best = block;
            }
        });
        return best || pool[pool.length - 1] || null;
    }

    function pickNotebookLmTargetRow(targetBlock, actionRows) {
        if (!targetBlock || !actionRows || actionRows.length === 0) return null;
        const blockRect = targetBlock.getBoundingClientRect();
        const blockCenterX = blockRect.left + (blockRect.width / 2);
        const centralRows = actionRows.filter((row) => isNotebookLmCentralLane(row));
        const rows = centralRows.length ? centralRows : actionRows;

        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        rows.forEach((row) => {
            if (!row || !row.getBoundingClientRect) return;
            const rowRect = row.getBoundingClientRect();
            const rowCenterX = rowRect.left + (rowRect.width / 2);
            const verticalGap = rowRect.top - blockRect.bottom;
            const horizontalGap = Math.abs(rowCenterX - blockCenterX);

            // NotebookLM has copy/action rows in multiple lanes (chat body + studio panel).
            // Keep only rows that overlap the chat message lane on the X axis.
            const horizontalOverlap = Math.min(blockRect.right, rowRect.right) - Math.max(blockRect.left, rowRect.left);
            const sameLane = horizontalOverlap >= 32 || horizontalGap <= Math.max(140, blockRect.width * 0.2);
            if (!sameLane) return;

            if (verticalGap < -220 || verticalGap > 520) return;
            const score = Math.abs(verticalGap) + (horizontalGap * 0.35);
            if (score < bestScore) {
                bestScore = score;
                best = row;
            }
        });

        return best;
    }

    function countCopyButtons(root) {
        if (!root || !root.querySelectorAll) return 0;
        const buttons = root.querySelectorAll('button, [role="button"]');
        let count = 0;
        for (const button of buttons) {
            if (isCopyButton(button)) count += 1;
            if (count >= 2) return count;
        }
        return count;
    }

    function findNotebookLmBlockNearRow(row) {
        if (!row) return null;

        let cursor = row.previousElementSibling;
        let hops = 0;
        while (cursor && hops < 16) {
            const score = getNotebookLmMessageScore(cursor);
            if (isNotebookLmMessageCandidate(cursor, score, true) && !cursor.contains(row) && getNodeTextLength(cursor) > 60) {
                return cursor;
            }
            cursor = cursor.previousElementSibling;
            hops += 1;
        }

        let parent = row.parentElement;
        let depth = 0;
        while (parent && depth < 6) {
            let prev = parent.previousElementSibling;
            let siblingHops = 0;
            while (prev && siblingHops < 8) {
                const score = getNotebookLmMessageScore(prev);
                if (isNotebookLmMessageCandidate(prev, score, true) && getNodeTextLength(prev) > 60) {
                    return prev;
                }
                prev = prev.previousElementSibling;
                siblingHops += 1;
            }
            parent = parent.parentElement;
            depth += 1;
        }

        return null;
    }

    function maybeSelfHealChatGptInjection(trigger = 'unknown') {
        if (!isChatGptHost) return;
        if (document.visibilityState === 'hidden') return;
        if (isChatGptGenerating()) return;

        const now = Date.now();
        if (now - __kbLastSelfHealAt < CHATGPT_SELF_HEAL_COOLDOWN_MS) return;

        const hasAssistant = Boolean(document.querySelector(CHATGPT_BLOCK_SELECTOR));
        if (!hasAssistant) return;

        if (!document.querySelector('.kb-btn-wrapper')) {
            __kbLastSelfHealAt = now;
            scheduleInject(new Set(getMessageBlocks().slice(-5)));
            return;
        }

        const recentBlocks = getMessageBlocks()
            .slice(-6)
            .filter((b) => isEligibleBlock(b));
        if (!recentBlocks.length) return;

        const missing = recentBlocks.filter((block) => {
            if (!block || !block.isConnected) return false;
            if (block.querySelector('.kb-btn-wrapper')) return false;
            const sibling = block.nextElementSibling;
            if (sibling && sibling.classList && sibling.classList.contains('kb-btn-wrapper')) return false;
            return true;
        });

        if (missing.length) {
            __kbLastSelfHealAt = now;
            scheduleInject(new Set(missing.slice(-MAX_PENDING_BLOCKS)));
            return;
        }

        // Keep trigger for debugging without noisy logs.
        void trigger;
    }

    function findCopyButton(root) {
        const selectors = [
            'button[aria-label*="copy" i]',
            'button[aria-label*="복사"]',
            'button[title*="copy" i]',
            'button[title*="복사"]',
            'button[data-testid*="copy" i]',
            '[data-testid*="copy" i] button',
            'button[mattooltip*="copy" i]',
            'button[mattooltip*="복사"]'
        ];

        for (const selector of selectors) {
            const button = root.querySelector(selector);
            if (button && isVisibleElement(button)) return button;
        }

        const buttons = root.querySelectorAll('button, [role="button"]');
        for (const button of buttons) {
            if (!isVisibleElement(button)) continue;
            if (isCopyButton(button)) return button;
        }

        return null;
    }

    function isCopyButton(button) {
        if (!button) return false;
        const text = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-testid') || ''}`.toLowerCase();
        return text.includes('copy') || text.includes('복사');
    }

    function getActionRowFromCopyButton(copyButton) {
        if (!copyButton) return null;
        const selector = '[role="toolbar"], div[class*="action"], div[class*="footer"], div[class*="tool"], div[class*="button"], div[class*="control"], div[class*="menu"]';
        const row = copyButton.closest(selector);
        if (row && row.querySelectorAll('button, [role="button"]').length >= 2) return row;

        const parent = copyButton.parentElement;
        if (parent && parent.querySelectorAll('button, [role="button"]').length >= 2) return parent;
        return null;
    }

    function isVisibleElement(node) {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function createTransferButtons(block, notebookLmMode) {
        ensureUiStyles();
        const wrapper = document.createElement('div');
        wrapper.className = notebookLmMode
            ? 'kb-btn-wrapper kb-btn-wrapper--notebook'
            : 'kb-btn-wrapper kb-btn-wrapper--chat';

        // Notion button intentionally hidden until Obsidian testing is complete.
        const oBtn = createBtn('Send to Obsidian', 'kb-btn--obsidian');
        oBtn.onclick = () => handleTransfer(block, 'Obsidian');

        wrapper.append(oBtn);
        return wrapper;
    }

    function createBtn(txt, variantClass) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = txt;
        b.className = ['kb-btn', variantClass].filter(Boolean).join(' ');
        return b;
    }

    async function handleTransfer(block, target) {
        const config = await getConfig();
        const titleMode = inferTitleMode(config);

        const md = getConfiguredMarkdown(block, target);

        // For LLM title generation, we want the user's last prompt if possible.
        // Best-effort extraction (platforms differ).
        const userPrompt = (() => {
            try {
                if (isGeminiHost) return '';
                if (isNotebookLmHost) return '';
                // ChatGPT-like
                const users = Array.from(document.querySelectorAll(CHATGPT_USER_SELECTOR));
                const last = users[users.length - 1];
                return (last?.innerText || '').trim();
            } catch {
                return '';
            }
        })();

        let title;
        if (titleMode === 'prompt') {
            title = window.prompt(`Title for ${target}:`, `${platformName} Response`);
        } else if (titleMode === 'llm') {
            try {
                title = await generateTitleWithLocalLLM({ config, userPrompt, assistantMarkdown: md });
            } catch (e) {
                const reason = e?.message || String(e);
                alert(`LLM title generation failed. Falling back to auto title.\n\n${reason}`);
                title = generateAutoTitle();
            }
        } else {
            title = generateAutoTitle();
        }

        if (!title) return;
        title = sanitizeFileName(title);

        // (md was computed earlier)

        const configUrl = target === 'Obsidian' ? config.obsidianUrl : '';
        const configKey = target === 'Obsidian' ? config.obsidianKey : config.notionKey;

        if (target === 'Obsidian' && !configUrl) {
            alert('Please configure Obsidian URL in extension settings.');
            return;
        }
        if (target === 'Notion' && !config.notionKey) {
            alert('Please configure Notion Integration Token in extension settings.');
            return;
        }
        if (target === 'Notion' && !config.notionParentId) {
            alert('Please configure Notion Parent ID in extension settings.');
            return;
        }

        const isObs = target === 'Obsidian';

        // Prepare request data
        const requestData = (() => {
            if (!isObs) {
                return {
                    action: 'sendToNotion',
                    method: 'POST',
                    url: configUrl,
                    data: { title, content: md },
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': configKey
                    },
                    title,
                    content: md,
                    config: {
                        notionKey: configKey,
                        notionParentId: config.notionParentId,
                        notionParentType: config.notionParentType || 'auto'
                    }
                };
            }

            // Obsidian Local REST API typically expects: PUT /vault/<path>
            // Let users enter either:
            // - http://127.0.0.1:27123
            // - http://127.0.0.1:27123/vault
            // We normalize to .../vault
            let base = (configUrl || '').trim().replace(/\/+$/g, '');
            // Users may enter either:
            // - http://127.0.0.1:27123
            // - http://127.0.0.1:27123/vault
            // - https://example.com/vault/SubFolder
            // Only append /vault when the URL does NOT already contain a /vault path segment.
            // (Checking only "/vault$" breaks subfolder paths.)
            if (base && !/\/vault(\/|$)/i.test(base)) base = `${base}/vault`;

            const fileName = `${title}.md`;
            const url = `${base}/${encodeURIComponent(fileName)}`;

            return {
                action: 'proxyRequest',
                method: 'PUT',
                url,
                data: md,
                headers: {
                    'Content-Type': 'text/markdown; charset=utf-8',
                    'Authorization': `Bearer ${configKey}`
                },
                title,
                content: md,
                config: {
                    notionKey: configKey,
                    notionParentId: config.notionParentId,
                    notionParentType: config.notionParentType || 'auto'
                }
            };
        })();

        chrome.runtime.sendMessage(requestData, (response) => {
            if (response && response.success) {
                alert(`✅ Sent to ${target}`);
            } else {
                alert(`❌ Error: ${response ? response.error : 'Unknown error'}`);
            }
        });
    }

    // Instead of polling every 2s (which can jank typing on heavy SPA pages like ChatGPT),
    // observe DOM changes and inject only for newly-added assistant message blocks.
    function findRelevantBlocksFromNode(node) {
        const blocks = new Set();
        if (!node) return blocks;
        if (isNotebookLmHost) return blocks;

        const root = (node.nodeType === 1) ? node : node.parentElement;
        if (!root || !(root instanceof Element)) return blocks;
        if (root.classList?.contains('kb-btn-wrapper')) return blocks;

        const selectors = getActiveHostBlockSelectors();
        if (!selectors.length) return blocks;
        const mergedSelector = selectors.join(',');

        const direct = root.closest ? root.closest(mergedSelector) : null;
        if (direct) blocks.add(direct);

        if (root.matches && root.matches(mergedSelector)) blocks.add(root);

        if (isChatGptHost && blocks.size && root.childElementCount > 24) return blocks;
        if (!root.querySelector) return blocks;

        const first = root.querySelector(mergedSelector);
        if (first) blocks.add(first);

        // For small subtrees, collect a few extra matches.
        if (root.childElementCount > 0 && root.childElementCount <= 6 && root.querySelectorAll) {
            const nested = root.querySelectorAll(mergedSelector);
            for (let index = 0; index < nested.length && index < 4; index += 1) {
                blocks.add(nested[index]);
            }
        }

        return blocks;
    }

    const scheduleInject = (() => {
        let queued = false;
        let pending = new Set();

        const run = () => {
            queued = false;
            const blocks = pending;
            pending = new Set();
            injectButtons(blocks);
        };

        return (blocks) => {
            if (blocks && blocks.size) {
                for (const block of blocks) {
                    pending.add(block);
                    if (pending.size >= MAX_PENDING_BLOCKS) break;
                }
            }
            if (queued) return;
            queued = true;

            // Prefer idle time to avoid competing with typing/streaming.
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(run, { timeout: 800 });
            } else {
                setTimeout(run, 150);
            }
        };
    })();

    // Initial best-effort injection
    scheduleInject(new Set(getMessageBlocks().slice(-5)));
    if (isChatGptHost) {
        setTimeout(() => maybeSelfHealChatGptInjection('initial'), 500);
    }

    const observeRoot = isChatGptHost
        ? (document.querySelector('main') || document.body)
        : document.body;

    // During generation, ChatGPT mutates DOM very frequently. Instead of injecting during the stream
    // (which can jank typing), we arm a lightweight debounced "generation finished" trigger.
    let __kbGenDoneTimer = null;
    function armInjectAfterGeneration() {
        if (!isChatGptHost) return;
        if (__kbGenDoneTimer) return;

        const check = () => {
            __kbGenDoneTimer = null;
            if (isChatGptGenerating()) {
                // Still generating; keep waiting.
                __kbGenDoneTimer = setTimeout(check, 400);
                return;
            }

            // Small debounce to let final DOM settle.
            setTimeout(() => {
                scheduleInject(new Set(getMessageBlocks().slice(-5)));
            }, 120);
        };

        __kbGenDoneTimer = setTimeout(check, 400);
    }

    const mo = new MutationObserver((mutations) => {
        measureSync('mutation_observer', () => {
            const isGenerating = isChatGptHost ? isChatGptGenerating() : false;
            if (isChatGptHost && isGenerating) {
                armInjectAfterGeneration();
                return;
            }
            if (isNotebookLmHost) {
                scheduleInject(new Set());
                return;
            }

            const found = new Set();
            let scannedNodes = 0;
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    for (const n of m.addedNodes) {
                        if (scannedNodes >= MAX_MUTATION_NODES_PER_BATCH || found.size >= MAX_PENDING_BLOCKS) break;
                        scannedNodes += 1;
                        if (n.nodeType === Node.ELEMENT_NODE && n.classList?.contains('kb-btn-wrapper')) continue;
                        findRelevantBlocksFromNode(n).forEach((block) => {
                            if (found.size < MAX_PENDING_BLOCKS) found.add(block);
                        });
                    }
                }
                if (scannedNodes >= MAX_MUTATION_NODES_PER_BATCH || found.size >= MAX_PENDING_BLOCKS) break;
            }

            if (found.size) {
                scheduleInject(found);
                return;
            }

            // Heavy mutation burst fallback: do a tiny bounded scan of recent blocks.
            if (scannedNodes >= MAX_MUTATION_NODES_PER_BATCH) {
                scheduleInject(new Set(getMessageBlocks().slice(-3)));
            }
        });
    });

    mo.observe(observeRoot, { childList: true, subtree: true });

    if (isChatGptHost) {
        const onWake = () => {
            setTimeout(() => maybeSelfHealChatGptInjection('wake'), 120);
        };
        window.addEventListener('focus', onWake, { passive: true });
        window.addEventListener('pageshow', onWake, { passive: true });
        window.addEventListener('popstate', onWake, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') onWake();
        });
        setInterval(() => {
            maybeSelfHealChatGptInjection('interval');
        }, CHATGPT_SELF_HEAL_INTERVAL_MS);
    }
})();
