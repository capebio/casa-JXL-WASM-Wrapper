// Browser sweep for file open/display paths.
// Logs launcher, navigation, console, page errors, card states, timings, and
// lightbox/view-switch permutations.

import type { Page } from "playwright";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { launch } from "./tools/launch-browser.mjs";

const APP_URL = process.env.APP_URL ?? process.env.URL ?? "http://localhost:9000/web/index.html";

// V-9: Global watchdog
const DEADLINE = process.env.VERIFY_DEADLINE_MS ? Number(process.env.VERIFY_DEADLINE_MS) : 600_000;
const globalWatchdog = setTimeout(() => {
    console.log("[fatal] global deadline reached");
    process.exit(2);
}, DEADLINE);
if (typeof globalWatchdog.unref === "function") {
    globalWatchdog.unref();
}

const DEFAULT_FILES = [
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140298 Aloidendron dichotomum.ORF`,
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140301.ORF`,
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140307 Hermannia eenioides.ORF`,
];

// V-10: Accept FILES env (; separated) before falling back
const inputFiles = process.argv.slice(2);
const files = inputFiles.length > 0 
    ? inputFiles 
    : (process.env.FILES ? process.env.FILES.split(";") : DEFAULT_FILES);

// V-10: Pre-flight existence check: if defaults missing, fail immediately
for (const f of files) {
    if (!existsSync(f)) {
        console.error(`Error: File not found: ${f}\nSet the FILES environment variable (semi-colon separated) or ensure default files exist on disk.`);
        process.exit(1);
    }
}

// Env-tunable timeouts
const THUMB_TIMEOUT = process.env.VERIFY_THUMB_TIMEOUT_MS ? Number(process.env.VERIFY_THUMB_TIMEOUT_MS) : 240_000;
const CANVAS_TIMEOUT = process.env.VERIFY_CANVAS_TIMEOUT_MS ? Number(process.env.VERIFY_CANVAS_TIMEOUT_MS) : 120_000;

const t0 = Date.now();
const mark = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(6, " ")}ms] ${msg}`);

// V-8: Machine-readable summary mode
const summaryData: any = {
    schemaVersion: 1,
    ok: false,
    pageErrorCount: 0,
    runs: []
};

function formatFiles(list: string[]) {
    return list.map((f, i) => `${i + 1}:${f}`).join(" | ");
}

// V-6: Fuse dumpStats + dumpThumbs into one page.evaluate returning {stats, thumbs}
async function dumpStateCombined(page: Page) {
    return await page.evaluate(() => {
        const stats = document.getElementById("stats-log")?.textContent?.trim() ?? "";
        const thumbs = Array.from(document.querySelectorAll(".thumb")).map((el, idx) => {
            const card = el as HTMLElement;
            const title = card.querySelector(".name")?.textContent?.trim() ?? "";
            const classes = card.className;
            const err = card.getAttribute("data-error") ?? "";
            const src = card.getAttribute("data-thumb-src") ?? "";
            return `${idx + 1}:{title="${title}", src="${src}", busy=${classes.includes("busy")}, encoding=${classes.includes("encoding")}, error=${classes.includes("error")}, data-error="${err}"}`;
        });
        return { stats, thumbs };
    });
}

async function dumpState(page: Page, label: string) {
    const { stats, thumbs } = await dumpStateCombined(page);
    if (stats) {
        mark(`${label} stats:\n${stats}`);
    }
    mark(`${label} thumbs=${thumbs.length}${thumbs.length ? `\n${thumbs.join(" | ")}` : ""}`);
    return { stats, thumbs };
}

// V-3: waitForThumbs blind to error cards (fail-fast and say which card failed)
async function waitForThumbs(page: Page, expected: number, timeoutMs: number) {
    const result = await page.waitForFunction((n: number) => {
        const thumbs = Array.from(document.querySelectorAll(".thumb"));
        const errored = thumbs.filter((el) => el.classList.contains("error"));
        if (errored.length > 0) {
            return {
                error: errored.map((el) =>
                    `${el.querySelector(".name")?.textContent ?? "?"}: ${el.getAttribute("data-error") ?? ""}`
                ).join(" | ")
            };
        }
        const done = thumbs.length >= n && thumbs.every((el) =>
            !el.classList.contains("busy") && !el.classList.contains("encoding")
        );
        return done ? { ok: true } : false;  // falsy keeps polling
    }, expected, { timeout: timeoutMs });

    const value = await result.jsonValue() as { ok?: boolean; error?: string };
    if (value.error) throw new Error(`thumb error card(s): ${value.error}`);
}

async function waitForAnyThumbCanvas(page: Page, expected: number, timeoutMs: number) {
    await page.waitForFunction(
        (n: number) => document.querySelectorAll(".thumb canvas").length >= n,
        expected,
        { timeout: timeoutMs },
    );
}

async function selectView(page: Page, view: "rect" | "square" | "natural") {
    const btn = page.locator(`button.view-btn[data-view="${view}"]`);
    await btn.click({ timeout: 10000 });
    await page.waitForFunction(
        (v: string) => document.querySelector(`button.view-btn[data-view="${v}"]`)?.classList.contains("active") === true,
        view,
        { timeout: 10000 },
    );
    const gridClass = await page.locator("#grid").getAttribute("class");
    mark(`view=${view} grid.class="${gridClass ?? ""}"`);
    return gridClass ?? "";
}

// V-6: Hoist the identical lightbox-state extraction closure
const readLightboxState = () => {
    const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
    return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        sourceLabel: document.getElementById("lb-source-label")?.textContent?.trim() ?? "",
        banner: document.getElementById("lb-source-banner")?.textContent?.trim() ?? "",
        toggle: document.querySelector(".lb-toggle-jpeg")?.textContent?.trim() ?? "",
    };
};

async function openLightboxAndReport(page: Page, cardIndex: number) {
    const thumbs = page.locator(".thumb");
    await thumbs.nth(cardIndex).click({ timeout: 10000 });
    await page.locator("#lightbox").waitFor({ state: "visible", timeout: 10000 });

    const state = await page.evaluate(readLightboxState);
    mark(`lightbox card=${cardIndex + 1} canvas=${state.width}x${state.height} banner="${state.banner}" toggle="${state.toggle}" label="${state.sourceLabel}"`);
    return state;
}

async function cycleLightboxSource(page: Page, steps: number) {
    const button = page.locator(".lb-toggle-jpeg");
    const stepsData = [];
    for (let i = 0; i < steps; i++) {
        await button.click({ timeout: 10000 });
        const state = await page.evaluate(readLightboxState);
        mark(`source step ${i + 1}/${steps}: canvas=${state.width}x${state.height} banner="${state.banner}" toggle="${state.toggle}" label="${state.sourceLabel}"`);
        stepsData.push(state);
    }
    return stepsData;
}

async function testRun(page: Page, label: string, selectedFiles: string[]) {
    const runMetric: any = {
        label,
        files: selectedFiles,
        views: {},
        lightbox: []
    };

    try {
        mark(`=== ${label} ===`);
        mark(`files: ${formatFiles(selectedFiles)}`);
        
        const tGotoStart = performance.now();
        await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!document.getElementById("file-input"), null, { timeout: 30000 });
        runMetric.gotoMs = Number((performance.now() - tGotoStart).toFixed(1));
        
        await dumpState(page, `${label} after goto`);

        const fileInput = page.locator("#file-input");
        const start = Date.now();
        mark(`${label} setInputFiles`);
        await fileInput.setInputFiles(selectedFiles);

        const tFirstCanvasStart = performance.now();
        await waitForAnyThumbCanvas(page, 1, CANVAS_TIMEOUT);
        runMetric.firstCanvasMs = Number((performance.now() - tFirstCanvasStart).toFixed(1));
        mark(`${label} first thumb canvas after ${Date.now() - start}ms`);
        
        // V-6: Halve CDP round trips with fused dumpState
        await dumpState(page, `${label} first display`);

        const tAllThumbsStart = performance.now();
        await waitForThumbs(page, selectedFiles.length, THUMB_TIMEOUT);
        runMetric.allThumbsMs = Number((performance.now() - tAllThumbsStart).toFixed(1));
        mark(`${label} thumbs complete after ${Date.now() - start}ms`);
        
        await dumpState(page, `${label} complete`);

        runMetric.views.rect_1 = await selectView(page, "rect");
        runMetric.views.square = await selectView(page, "square");
        runMetric.views.natural = await selectView(page, "natural");
        runMetric.views.rect_2 = await selectView(page, "rect");

        const lbInitial = await openLightboxAndReport(page, 0);
        runMetric.lightbox.push({ phase: "initial", ...lbInitial });
        
        const lbSteps = await cycleLightboxSource(page, 3);
        runMetric.lightbox.push(...lbSteps.map((s, i) => ({ phase: `step-${i + 1}`, ...s })));

        if (selectedFiles.length > 1) {
            await page.locator(".lightbox-next").click({ timeout: 10000 });
            const nextState = await page.evaluate(readLightboxState);
            mark(`lightbox next canvas=${nextState.width}x${nextState.height} banner="${nextState.banner}" label="${nextState.sourceLabel}"`);
            runMetric.lightbox.push({ phase: "next", ...nextState });

            await page.locator(".lightbox-prev").click({ timeout: 10000 });
            const backState = await page.evaluate(readLightboxState);
            mark(`lightbox prev canvas=${backState.width}x${backState.height} banner="${backState.banner}" label="${backState.sourceLabel}"`);
            runMetric.lightbox.push({ phase: "prev", ...backState });
        }

        await page.screenshot({ path: `verify-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`, fullPage: true });
        await dumpState(page, `${label} final`);
        
        summaryData.runs.push(runMetric);
    } catch (err) {
        // V-7: failure screenshot + state dump
        const failLabel = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        try {
            await page.screenshot({ path: `verify-${failLabel}-FAIL.png`, fullPage: true });
            mark(`Captured failure screenshot: verify-${failLabel}-FAIL.png`);
            await dumpState(page, `${label} FAIL`);
        } catch (screenshotErr) {
            console.error(`Failed to take screenshot on error:`, screenshotErr);
        }
        throw err;
    }
}

// Main process
let launcher: any = null;
let pageErrorCount = 0;

try {
    // V-1 & V-4: Handled cleanly by tools/launch-browser.mjs
    launcher = await launch({ headless: true, timeoutMs: 180_000 });
    const page = launcher.page;

    // V-2: Track console and page errors
    page.on("console", (m) => {
        const type = m.type();
        if (type === "error") {
            pageErrorCount++;
            console.log(`[page-error] ${m.text()}`);
        } else if (type === "warning" || type === "log") {
            console.log(`[page-${type}] ${m.text()}`);
        }
    });
    
    page.on("pageerror", (err: Error) => {
        pageErrorCount++;
        console.log(`[pageerror] ${err.message}`);
    });
    
    page.on("requestfailed", (req) => {
        console.log(`[netfail] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`);
    });
    
    page.on("response", (res) => {
        if (res.status() >= 400) {
            console.log(`[http] ${res.status()} ${res.url()}`);
        }
    });

    // Timeline streaming (Owl/film-backwards lens) when VERIFY_TRACE=1
    if (process.env.VERIFY_TRACE === "1") {
        await page.exposeFunction("__cardEvent", (name: string, transition: string, timestamp: number) => {
            mark(`[trace-card] ${name}: ${transition} at ${timestamp}ms`);
        });
        await page.addInitScript(() => {
            const observer = new MutationObserver((mutations) => {
                const now = performance.now();
                for (const mut of mutations) {
                    if (mut.type === "attributes" && mut.attributeName === "class") {
                        const el = mut.target as HTMLElement;
                        if (el.classList.contains("thumb")) {
                            const name = el.querySelector(".name")?.textContent?.trim() ?? "?";
                            const classes = Array.from(el.classList).filter(c => ["busy", "encoding", "error"].includes(c)).join(",") || "done";
                            (window as any).__cardEvent(name, classes, Math.round(now));
                        }
                    }
                }
            });
            document.addEventListener("DOMContentLoaded", () => {
                const grid = document.getElementById("grid");
                if (grid) {
                    observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ["class"] });
                } else {
                    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
                }
            });
        });
    }

    mark(`app url: ${APP_URL}`);
    await testRun(page, "single-file", [files[0]]);
    await testRun(page, "multi-file", files.slice(0, Math.min(files.length, 3)));

    // V-11 (a): VERIFY_GALLERY_N mode
    const galleryN = process.env.VERIFY_GALLERY_N ? Number(process.env.VERIFY_GALLERY_N) : 0;
    if (galleryN > 0) {
        const galleryDir = process.env.VERIFY_GALLERY_DIR ?? (files[0] ? dirname(files[0]) : null);
        if (galleryDir && existsSync(galleryDir)) {
            const allDirFiles = await readdir(galleryDir);
            const rawFiles = allDirFiles
                .filter(f => /\.(orf|dng|raw|arw|nef|cr2)$/i.test(f))
                .map(f => join(galleryDir, f))
                .slice(0, galleryN);
            if (rawFiles.length > 0) {
                await testRun(page, `gallery-scale-n${rawFiles.length}`, rawFiles);
            } else {
                mark(`[warning] gallery-scale mode: no RAW files found in ${galleryDir}`);
            }
        } else {
            mark(`[warning] gallery-scale mode: directory ${galleryDir} not found`);
        }
    }

    // V-11 (b): VERIFY_BAD_FILE mode
    if (process.env.VERIFY_BAD_FILE) {
        if (existsSync(process.env.VERIFY_BAD_FILE)) {
            await testRun(page, "bad-file", [process.env.VERIFY_BAD_FILE]);
            const errored = await page.evaluate(() => {
                const thumbs = Array.from(document.querySelectorAll(".thumb"));
                return thumbs.some(el => el.classList.contains("error") && !!el.getAttribute("data-error"));
            });
            if (!errored) {
                throw new Error("Assert failed: Bad file did not produce an error card with data-error attribute");
            }
            mark("Assert PASSED: Corrupt file correctly produced error card with data-error description");
        } else {
            mark(`[warning] bad-file mode: corrupt file ${process.env.VERIFY_BAD_FILE} not found`);
        }
    }

    mark("done");

    // V-2: Set process.exitCode = 1 if there are page errors (gated by opt-out env)
    if (pageErrorCount > 0) {
        if (!process.env.VERIFY_ALLOW_PAGE_ERRORS) {
            mark(`FAIL: ${pageErrorCount} page errors detected during the sweep`);
            process.exitCode = 1;
        } else {
            mark(`[warning] Allowed ${pageErrorCount} page errors per VERIFY_ALLOW_PAGE_ERRORS=1`);
        }
    }
} catch (err) {
    console.log(`[fatal] ${(err as Error).stack ?? (err as Error).message ?? String(err)}`);
    process.exitCode = 1;
} finally {
    clearTimeout(globalWatchdog);
    try {
        if (launcher?.close) {
            await launcher.close();
        }
    } catch (err) {
        console.log(`[browser-close] ${(err as Error).message ?? String(err)}`);
    }

    // V-8: Machine-readable summary output
    if (process.env.VERIFY_JSON === "1") {
        summaryData.pageErrorCount = pageErrorCount;
        summaryData.ok = (process.exitCode ?? 0) === 0;
        console.log(JSON.stringify(summaryData));
    }
}
