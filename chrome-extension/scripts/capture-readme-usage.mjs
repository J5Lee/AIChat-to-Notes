#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(PROJECT_ROOT, 'output', 'playwright', 'usage-chatgpt.png');
const profileDir = path.join(PROJECT_ROOT, 'output', 'playwright', 'profile-readme-usage');

const PROMPT_TEXT = 'Give me three short bullet points about why developers should take notes while working.';

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickFirstVisibleByText(page, candidates) {
    for (const candidate of candidates) {
        const locator = page.getByRole('button', { name: new RegExp(`^${escapeRegex(candidate)}$`, 'i') }).first();
        if (await locator.isVisible().catch(() => false)) {
            await locator.click().catch(() => null);
            return true;
        }
    }
    return false;
}

async function findPromptTarget(page) {
    const selectors = [
        'textarea#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Message" i]',
        'div#prompt-textarea[contenteditable="true"]',
        'div[data-testid="prompt-textarea"][contenteditable="true"]',
        'main [contenteditable="true"]'
    ];

    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return { locator, selector };
    }
    return null;
}

async function waitForAssistantResponse(page, timeoutMs = 120000) {
    const assistantSelectors = [
        '[data-message-author-role="assistant"]',
        'article[data-testid*="assistant"]',
        '[data-testid$="-assistant"]',
        'main article'
    ];

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        for (const selector of assistantSelectors) {
            const blocks = page.locator(selector);
            const count = await blocks.count().catch(() => 0);
            if (!count) continue;

            for (let i = count - 1; i >= 0; i -= 1) {
                const block = blocks.nth(i);
                const text = await block.innerText().catch(() => '');
                if ((text || '').trim().length >= 40) return true;
            }
        }
        await page.waitForTimeout(800);
    }
    return false;
}

async function main() {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${EXTENSION_ROOT}`,
            `--load-extension=${EXTENSION_ROOT}`
        ],
        viewport: { width: 1512, height: 982 }
    });

    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        await clickFirstVisibleByText(page, ['Accept all', 'Accept All', 'Accept', '동의']);
        await page.waitForTimeout(800);

        const promptTarget = await findPromptTarget(page);
        if (!promptTarget) throw new Error('Prompt input was not found on chatgpt.com');

        await promptTarget.locator.click({ timeout: 5000 });
        await page.keyboard.press('Meta+A').catch(() => null);
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.type(PROMPT_TEXT, { delay: 14 });
        await page.keyboard.press('Enter');

        await waitForAssistantResponse(page, 120000);
        await page.waitForTimeout(2000);
        await page.keyboard.press('End').catch(() => null);

        await page.waitForSelector('button.kb-btn--obsidian', { timeout: 90000 });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: outputPath, fullPage: true });

        console.log(`Saved screenshot: ${outputPath}`);
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error('[capture-readme-usage] failed:', error);
    process.exit(1);
});

