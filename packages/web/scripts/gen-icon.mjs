#!/usr/bin/env node
/**
 * Render public/icon-512.png (512×512, square) from scripts/icon.svg with
 * headless Chromium — the same pattern as gen-og-image.mjs. The square icon is
 * what app/plugin directories want (ChatGPT plugin submission needs ≥48×48;
 * docs/chatgpt-plugin/README.md points at https://basedagents.ai/icon-512.png).
 * Not part of the build: run it when the mark changes and commit the PNG.
 *
 *   node scripts/gen-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(web, 'scripts/icon.svg'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } });
await browser.close();
writeFileSync(join(web, 'public/icon-512.png'), png);
console.log(`wrote public/icon-512.png (${png.length} bytes)`);
