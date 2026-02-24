#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(EXTENSION_ROOT, '..');

const DEFAULTS = {
    url: 'https://chatgpt.com/',
    mode: 'off',
    runId: '1',
    profileDir: path.join(os.homedir(), '.aichat-notes-perf-profile'),
    outputDir: path.join(PROJECT_ROOT, 'output', 'playwright', 'perf'),
    s1Ms: 10000,
    s2Ms: 20000,
    s3Ms: 20000,
    s4Ms: 20000,
    typingDelayMs: 30,
    send: true
};

const SCRIPTING_EVENT_NAMES = new Set([
    'EvaluateScript',
    'FunctionCall',
    'EventDispatch',
    'TimerFire',
    'RunMicrotasks',
    'FireAnimationFrame',
    'FireIdleCallback',
    'CompileScript',
    'V8.Execute',
    'v8.compile'
]);

const RENDERING_EVENT_NAMES = new Set([
    'UpdateLayoutTree',
    'Layout',
    'PrePaint',
    'Paint',
    'RasterTask',
    'CompositeLayers',
    'DrawFrame',
    'Animation'
]);

const KB_PERF_EVENT_NAMES = {
    mutationObserver: 'kb:perf:mutation_observer',
    injectButtons: 'kb:perf:inject_buttons',
    domCommit: 'kb:perf:dom_commit'
};

function parseArgs(argv) {
    const options = { ...DEFAULTS };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const [rawKey, inlineValue] = arg.slice(2).split('=');
        const key = rawKey.trim();
        const nextValue = inlineValue ?? argv[i + 1];
        const consumeNext = inlineValue === undefined;

        switch (key) {
            case 'url':
                options.url = String(nextValue);
                if (consumeNext) i += 1;
                break;
            case 'mode':
                options.mode = String(nextValue).toLowerCase();
                if (consumeNext) i += 1;
                break;
            case 'run-id':
                options.runId = String(nextValue);
                if (consumeNext) i += 1;
                break;
            case 'profile-dir':
                options.profileDir = String(nextValue);
                if (consumeNext) i += 1;
                break;
            case 'output-dir':
                options.outputDir = String(nextValue);
                if (consumeNext) i += 1;
                break;
            case 's1-ms':
                options.s1Ms = Number(nextValue);
                if (consumeNext) i += 1;
                break;
            case 's2-ms':
                options.s2Ms = Number(nextValue);
                if (consumeNext) i += 1;
                break;
            case 's3-ms':
                options.s3Ms = Number(nextValue);
                if (consumeNext) i += 1;
                break;
            case 's4-ms':
                options.s4Ms = Number(nextValue);
                if (consumeNext) i += 1;
                break;
            case 'typing-delay-ms':
                options.typingDelayMs = Number(nextValue);
                if (consumeNext) i += 1;
                break;
            case 'send':
                options.send = String(nextValue).toLowerCase() !== 'false';
                if (consumeNext) i += 1;
                break;
            default:
                break;
        }
    }
    return options;
}

function assertOptions(options) {
    if (!['off', 'on'].includes(options.mode)) {
        throw new Error(`Invalid mode: ${options.mode}. Use --mode off|on`);
    }
    ['s1Ms', 's2Ms', 's3Ms', 's4Ms', 'typingDelayMs'].forEach((key) => {
        if (!Number.isFinite(options[key]) || options[key] <= 0) {
            throw new Error(`Invalid numeric option: ${key}=${options[key]}`);
        }
    });
}

function utcNow() {
    return new Date().toISOString();
}

function normalizePath(p) {
    if (process.platform === 'win32') return p.replace(/^\/([A-Za-z]:\/)/, '$1');
    return p;
}

async function readProtocolStream(cdp, handle) {
    let traceText = '';
    let eof = false;
    while (!eof) {
        const chunk = await cdp.send('IO.read', { handle });
        traceText += chunk.data || '';
        eof = Boolean(chunk.eof);
    }
    await cdp.send('IO.close', { handle });
    return traceText;
}

async function startTracing(cdp) {
    await cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: {
            recordMode: 'record-until-full',
            includedCategories: [
                'devtools.timeline',
                'disabled-by-default-devtools.timeline',
                'disabled-by-default-v8.cpu_profiler',
                'toplevel',
                'blink.user_timing',
                'v8.execute'
            ]
        }
    });
}

async function stopTracing(cdp) {
    return new Promise((resolve, reject) => {
        const onComplete = async (event) => {
            try {
                const traceText = await readProtocolStream(cdp, event.stream);
                resolve(traceText);
            } catch (error) {
                reject(error);
            }
        };

        cdp.once('Tracing.tracingComplete', onComplete);
        cdp.send('Tracing.end').catch((error) => {
            cdp.off('Tracing.tracingComplete', onComplete);
            reject(error);
        });
    });
}

function extractUrlsFromEvent(event) {
    const urls = [];
    const data = event?.args?.data;
    if (typeof data?.url === 'string') urls.push(data.url);
    if (typeof data?.scriptName === 'string') urls.push(data.scriptName);
    const stackFrames = data?.stackTrace || data?.stack || [];
    if (Array.isArray(stackFrames)) {
        stackFrames.forEach((frame) => {
            if (typeof frame?.url === 'string') urls.push(frame.url);
        });
    }
    return urls;
}

function pickMainThread(events) {
    const threadMarkers = events.filter(
        (e) => e?.name === 'thread_name' && e?.args?.name === 'CrRendererMain'
    );
    if (threadMarkers.length === 0) return null;

    // Prefer the most recent marker in case of multi-process traces.
    const marker = threadMarkers[threadMarkers.length - 1];
    return { pid: marker.pid, tid: marker.tid };
}

function microsToMillis(value) {
    return Number((value / 1000).toFixed(2));
}

function sumTimedEventDuration(events, eventName) {
    return events
        .filter((e) => e?.name === eventName && Number.isFinite(e?.dur))
        .reduce((sum, e) => sum + e.dur, 0);
}

function parseTraceMetrics(traceText) {
    const parsed = JSON.parse(traceText);
    const events = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
    const mainThread = pickMainThread(events);

    const timedEvents = events.filter((e) => {
        if (e?.ph !== 'X' || !Number.isFinite(e?.dur)) return false;
        if (!mainThread) return true;
        return e.pid === mainThread.pid && e.tid === mainThread.tid;
    });

    const runTaskEvents = timedEvents.filter((e) => e.name === 'RunTask');
    const longTaskSource = runTaskEvents.length ? runTaskEvents : timedEvents;
    const longTasks = longTaskSource.filter((e) => e.dur > 50000);
    const tbtMs = microsToMillis(longTasks.reduce((sum, e) => sum + (e.dur - 50000), 0));

    const scriptingUs = timedEvents
        .filter((e) => SCRIPTING_EVENT_NAMES.has(e.name))
        .reduce((sum, e) => sum + e.dur, 0);
    const renderingUs = timedEvents
        .filter((e) => RENDERING_EVENT_NAMES.has(e.name))
        .reduce((sum, e) => sum + e.dur, 0);

    const contentJsUs = timedEvents
        .filter((e) => extractUrlsFromEvent(e).some((url) => /chrome-extension:\/\/.+\/content\.js/.test(url)))
        .reduce((sum, e) => sum + e.dur, 0);

    const fallbackMutationObserverUs = timedEvents
        .filter((e) => {
            if (/mutationobserver/i.test(e.name || '')) return true;
            const fn = e?.args?.data?.functionName || '';
            return /mutationobserver/i.test(fn);
        })
        .reduce((sum, e) => sum + e.dur, 0);
    const perfMutationObserverUs = sumTimedEventDuration(timedEvents, KB_PERF_EVENT_NAMES.mutationObserver);
    const injectButtonsUs = sumTimedEventDuration(timedEvents, KB_PERF_EVENT_NAMES.injectButtons);
    const domCommitUs = sumTimedEventDuration(timedEvents, KB_PERF_EVENT_NAMES.domCommit);
    const mutationObserverUs = perfMutationObserverUs || fallbackMutationObserverUs;

    return {
        tbtMs,
        longTaskCount: longTasks.length,
        scriptingMs: microsToMillis(scriptingUs),
        renderingMs: microsToMillis(renderingUs),
        contentJsSelfMs: microsToMillis(contentJsUs),
        mutationObserverMs: microsToMillis(mutationObserverUs),
        injectButtonsMs: microsToMillis(injectButtonsUs),
        domCommitMs: microsToMillis(domCommitUs),
        traceEventCount: events.length
    };
}

async function findComposerHandle(page) {
    const selectors = [
        'textarea#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
        'textarea[placeholder*="Message"]',
        'div#prompt-textarea[contenteditable="true"]',
        'div[data-testid*="composer"][contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count() === 0) continue;
        const isVisible = await locator.isVisible().catch(() => false);
        if (!isVisible) continue;
        return locator;
    }
    return null;
}

async function performTypingPhase(page, options) {
    const composer = await findComposerHandle(page);
    if (!composer) {
        throw new Error('Could not find ChatGPT composer. Open chat page and ensure input is visible.');
    }

    await composer.click();
    const endTs = Date.now() + options.s2Ms;
    let index = 1;
    while (Date.now() < endTs) {
        const text = `perf baseline probe ${index} `;
        await page.keyboard.type(text, { delay: options.typingDelayMs });
        index += 1;
        await page.waitForTimeout(40);
    }

    if (options.send) {
        await page.keyboard.press('Enter');
    }
}

async function performScrollPhase(page, options) {
    const endTs = Date.now() + options.s4Ms;
    let direction = 1;
    while (Date.now() < endTs) {
        await page.mouse.wheel(0, direction * 1100);
        direction *= -1;
        await page.waitForTimeout(250);
    }
}

function markdownRunRow(options, metrics) {
    return `| ${options.runId} | ${options.mode.toUpperCase()} | ${utcNow()} | ${options.url} | ${metrics.tbtMs} | ${metrics.longTaskCount} | ${metrics.scriptingMs} | ${metrics.renderingMs} | ${metrics.contentJsSelfMs} | ${metrics.mutationObserverMs} |  |`;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    assertOptions(options);

    const outputDir = normalizePath(path.resolve(options.outputDir));
    const profileDir = normalizePath(path.resolve(options.profileDir));
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const extensionArgs = options.mode === 'on'
        ? [
            `--disable-extensions-except=${normalizePath(EXTENSION_ROOT)}`,
            `--load-extension=${normalizePath(EXTENSION_ROOT)}`
        ]
        : [];

    let playwright;
    try {
        playwright = await import('playwright');
    } catch {
        throw new Error('Playwright is not installed. Run: cd chrome-extension && npm install');
    }

    const context = await playwright.chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: 'chromium',
        args: extensionArgs,
        viewport: { width: 1440, height: 900 }
    });

    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(options.url, { waitUntil: 'domcontentloaded' });
        await page.bringToFront();
        await page.waitForTimeout(1500);

        const cdp = await context.newCDPSession(page);
        await cdp.send('Page.enable');
        await startTracing(cdp);

        // S1: wait after page load
        await page.waitForTimeout(options.s1Ms);
        // S2: typing
        await performTypingPhase(page, options);
        // S3: wait during generation
        await page.waitForTimeout(options.s3Ms);
        // S4: scroll
        await performScrollPhase(page, options);

        const traceText = await stopTracing(cdp);
        const metrics = parseTraceMetrics(traceText);

        const stamp = utcNow().replace(/[:.]/g, '-');
        const baseName = `run-${options.runId}-${options.mode}-${stamp}`;
        const tracePath = path.join(outputDir, `${baseName}.trace.json`);
        const summaryPath = path.join(outputDir, `${baseName}.summary.json`);

        await fs.writeFile(tracePath, traceText, 'utf8');
        await fs.writeFile(
            summaryPath,
            JSON.stringify({
                runId: options.runId,
                mode: options.mode.toUpperCase(),
                url: options.url,
                profileDir,
                tracePath,
                measuredAt: utcNow(),
                metrics
            }, null, 2),
            'utf8'
        );

        console.log('=== Baseline Run Complete ===');
        console.log(`runId: ${options.runId}`);
        console.log(`mode: ${options.mode.toUpperCase()}`);
        console.log(`url: ${options.url}`);
        console.log(`trace: ${tracePath}`);
        console.log(`summary: ${summaryPath}`);
        console.log('metrics:', metrics);
        console.log('\nPaste row to 05_PERF_BASELINE.md:');
        console.log(markdownRunRow(options, metrics));
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error('[openclaw-baseline] failed:', error);
    process.exit(1);
});
