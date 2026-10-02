#!/usr/bin/env node
/**
 * Render public/og-image.png (1200×630) from scripts/og-image.svg with headless
 * Chromium (POSITIONING_SPEC.md §A2). Not part of the build: run it when the
 * one-liner changes, commit the PNG, and bump OG_IMAGE_VERSION in
 * src/content/positioning.ts so caches refetch it.
 *
 *   node scripts/gen-og-image.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(web, 'scripts/og-image.svg'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:#0A0A0B}svg{display:block}</style></head><body>${svg}</body></html>`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
writeFileSync(join(web, 'public/og-image.png'), png);
console.log(`wrote public/og-image.png (${png.length} bytes)`);
