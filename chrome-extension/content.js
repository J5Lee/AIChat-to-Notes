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

    // Helper: Get config from storage
    async function getConfig() {
        return new Promise((resolve) => {
            chrome.storage.local.get(
                ['notionKey', 'notionParentId', 'notionParentType', 'obsidianUrl', 'obsidianKey', 'titleMode', 'llmBaseUrl', 'llmModel', 'autoTitleEnabled'],
                (items) => {
                resolve(items);
                }
            );
        });
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

    async function generateTitleWithLocalLLM({ config, userPrompt, assistantMarkdown }) {
        const baseUrl = (config?.llmBaseUrl || 'http://127.0.0.1:1234').replace(/\/+$/g, '');
        const model = (config?.llmModel || '').trim();

        // Keep it short for latency + privacy (don’t ship entire conversation)
        const excerpt = (assistantMarkdown || '').replace(/^---[\s\S]*?---\n\n/, '').slice(0, 4000);
        const up = (userPrompt || '').slice(0, 800);

        const system = [
            'You generate concise note titles.',
            'Output MUST be English only.',
            'Output ONLY the title text: no quotes, no markdown, no trailing period.',
            'Avoid file-name forbidden chars: \\ / : * ? " < > |'
        ].join(' ');

        const user = [
            'Task: Create a short, clear English note title (4-10 words).',
            'If the source text is Korean or mixed-language, translate concepts to English and still output English.',
            'Return ONLY the title text on a single line.',
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
            temperature: 0.2,
            max_tokens: 32
        });

        let resp = await sendMessageAsync({
            action: 'llmChatCompletions',
            url: `${baseUrl}/v1/chat/completions`,
            body: makeBody('English only. Do not output any Korean characters.')
        });

        if (!resp?.success) throw new Error(resp?.error || 'LLM title generation failed');

        let title = (resp?.title || '').trim();

        // If the model ignored the instruction and returned Korean, retry once with stricter constraints.
        if (/[\uAC00-\uD7AF]/.test(title)) {
            resp = await sendMessageAsync({
                action: 'llmChatCompletions',
                url: `${baseUrl}/v1/chat/completions`,
                body: makeBody('Rewrite the title in English ONLY. Use ASCII letters/spaces/digits if possible. Return ONE line only.')
            });
            if (resp?.success) title = (resp?.title || '').trim();
        }

        if (!resp?.success) throw new Error(resp?.error || 'LLM title generation failed');
        return sanitizeFileName(title);
    }

    /**
     * Advanced Post-processing for Obsidian
     */
    function postProcessForObsidian(md) {
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

        // 4. [LIST SPACING FIX] Remove blank lines between consecutive list items
        md = md.replace(/^(\d+\..+)\n\n(?=\d+\.)/gm, '$1\n');
        md = md.replace(/^(-.+)\n\n(?=-\s)/gm, '$1\n');

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

    function getMessageBlocks() {
        if (isGeminiHost) {
            return Array.from(document.querySelectorAll('message-content'));
        }

        if (isNotebookLmHost) {
            return getNotebookLmMessageBlocks();
        }

        // NOTE: These selectors are intentionally broad to survive frequent DOM churn.
        // - ChatGPT: data-message-author-role="assistant"
        // - Claude: common patterns include assistant message containers with data-testid
        // - Perplexity: often uses "prose"/"answer" containers
        const selectors = [
            // ChatGPT
            'div[data-message-author-role="assistant"]',
            'article[data-testid^="conversation-turn-"][data-testid$="-assistant"]',
            'main article[data-testid*="assistant"]',

            // Claude (best-effort)
            '[data-testid*="assistant" i]',
            '[data-testid*="message" i][data-testid*="assistant" i]',
            'div[class*="assistant" i]',

            // Perplexity (best-effort)
            'div[class*="answer" i]',
            'div[class*="response" i]',
            'div[class*="prose" i]'
        ];

        const blockSet = new Set();
        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => blockSet.add(el));
        });

        const candidates = Array.from(blockSet);
        return candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
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
        const topCandidates = candidates
            .filter((node) => getNodeTextLength(node) >= 80)
            .filter((node, idx, arr) => !arr.some((other, otherIdx) => otherIdx !== idx && other.contains(node)))
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

            const deduped = broadNodes.filter((node, idx, arr) => !arr.some((other, otherIdx) => otherIdx !== idx && other.contains(node)));
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
        if (block.querySelector('.kb-btn-wrapper')) return false;
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

        let md = ts.turndown(clone);
        if (isObsidian) md = postProcessForObsidian(md);

        return md;
    }

    function isChatGptGenerating() {
        if (!isChatGptHost) return false;
        // Best-effort: while generating, ChatGPT typically shows a stop button.
        const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="정지" i]');
        if (stop && isVisibleElement(stop)) return true;
        return false;
    }

    // Avoid repeated DOM churn: remember which blocks we've already processed.
    const __kbInjectedBlocks = new WeakSet();

    function injectButtons(passedBlocks = null) {
        if (isNotebookLmHost) {
            injectNotebookLmButtons();
            return;
        }

        // ChatGPT streams content; injecting mid-stream can place buttons in the middle.
        // Only inject when generation is finished.
        if (isChatGptHost && isChatGptGenerating()) return;

        let blocks = (passedBlocks ? Array.from(passedBlocks) : getMessageBlocks())
            .filter((b) => isEligibleBlock(b));

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

        blocks.forEach((block) => {
            if (!block) return;
            if (__kbInjectedBlocks.has(block)) return;

            // If a wrapper already exists, treat as injected and don't touch DOM again.
            const existing = block.querySelector('.kb-btn-wrapper');
            if (existing) {
                __kbInjectedBlocks.add(block);
                return;
            }

            const wrapper = createTransferButtons(block, false);
            block.append(wrapper);
            __kbInjectedBlocks.add(block);
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
        if (actionRows.length === 0) {
            blocks.forEach((block) => {
                const wrapper = createTransferButtons(block, true);
                block.append(wrapper);
            });
            return;
        }

        actionRows.forEach((row) => {
            const block = findClosestBlockAboveRow(row, blocks);
            if (!block || !row.parentElement) return;
            const wrapper = createTransferButtons(block, true);
            row.parentElement.insertBefore(wrapper, row);
        });
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

        blocks.forEach((block) => {
            const blockRect = block.getBoundingClientRect();
            if (blockRect.top > rowRect.top + 20) return;
            const distance = Math.max(0, rowRect.top - blockRect.bottom);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = block;
            }
        });

        if (best) return best;
        return blocks[blocks.length - 1] || null;
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
        const wrapper = document.createElement('div');
        wrapper.className = 'kb-btn-wrapper';
        wrapper.style = getButtonWrapperStyle(notebookLmMode);
        const nBtn = createBtn('Send to Notion', '#000');
        const oBtn = createBtn('Send to Obsidian', '#483699');
        nBtn.onclick = () => handleTransfer(block, 'Notion');
        oBtn.onclick = () => handleTransfer(block, 'Obsidian');
        wrapper.append(nBtn, oBtn);
        return wrapper;
    }

    function getButtonWrapperStyle(notebookLmMode = false) {
        if (notebookLmMode) {
            return 'display: flex; gap: 8px; justify-content: flex-end; width: 100%; margin: 2px 0 8px;';
        }
        const baseStyle = 'display: flex; gap: 8px; margin-top: 15px; padding-top: 10px; border-top: 1px solid #eee;';
        return `${baseStyle} justify-content: flex-end; width: 100%; margin-left: auto; align-self: flex-end;`;
    }

    function createBtn(txt, bg) {
        const b = document.createElement('button');
        b.innerText = txt;
        b.style = `padding: 6px 14px; cursor: pointer; background: ${bg}; color: #fff; border: none; border-radius: 6px; font-weight: bold; font-size: 11px;`;
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
                const users = Array.from(document.querySelectorAll('div[data-message-author-role="user"]'));
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
                // fallback
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

        const root = (node.nodeType === 1) ? node : node.parentElement;
        if (!root) return blocks;

        // ChatGPT selector first (most stable + specific)
        const chatgptSelector = 'div[data-message-author-role="assistant"], article[data-testid^="conversation-turn-"][data-testid$="-assistant"], main article[data-testid*="assistant"]';

        const direct = root.closest ? root.closest(chatgptSelector) : null;
        if (direct) blocks.add(direct);

        if (root.matches && root.matches(chatgptSelector)) blocks.add(root);

        // Also catch any blocks inside newly-added subtrees
        if (root.querySelectorAll) {
            root.querySelectorAll(chatgptSelector).forEach((el) => blocks.add(el));
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
                blocks.forEach((b) => pending.add(b));
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

    const observeRoot = document.querySelector('main') || document.body;

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
        if (isChatGptHost && isChatGptGenerating()) {
            armInjectAfterGeneration();
            return;
        }

        const found = new Set();
        for (const m of mutations) {
            if (m.addedNodes && m.addedNodes.length) {
                m.addedNodes.forEach((n) => {
                    findRelevantBlocksFromNode(n).forEach((b) => found.add(b));
                });
            }
        }

        if (found.size) scheduleInject(found);
    });

    mo.observe(observeRoot, { childList: true, subtree: true });
})();
