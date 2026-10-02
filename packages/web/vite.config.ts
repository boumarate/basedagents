import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(fileURLToPath(import.meta.url));

// Extension-less pretty URLs for the STATIC marketing leaf pages → their .html
// file. In production Cloudflare Pages serves these as assets ahead of the SPA
// fallback; in `vite dev` the default SPA fallback would otherwise serve
// index.html (the SPA shell) for them. Everything NOT listed here falls through
// to Vite's default index.html SPA fallback — matching production's
// `/* /index.html 200`. (The homepage `/` is served by the SPA shell + the React
// `Home` route, so it is intentionally NOT a static leaf here.)
const STATIC_PAGES: Record<string, string> = {
  '/keyring': '/keyring.html',
  '/registry': '/registry.html',
  '/docs/agents': '/docs/agents.html',
  '/codex': '/codex.html',
};

function devStaticPages() {
  return {
    name: 'dev-static-pages',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const wantsHtml = (req.headers.accept ?? '').includes('text/html');
        const target = STATIC_PAGES[path];
        if (wantsHtml && target) req.url = target;
        next();
      });
    },
  };
}

// Google Analytics (GA4). Injected at the top of <head> in EVERY built HTML
// entry — the SPA shell (and so every prerendered route) plus the static leaf
// pages below — so the tag lives in one place. Build only: local dev sends no
// hits. The CSP in public/_headers allows Google's GA4 origins; the privacy
// page discloses it.
//
// Consent Mode v2: analytics starts DENIED for everyone (no cookies, cookieless
// pings only) and waits up to CONSENT_WAIT_MS for an update. The visitor's
// country comes from Cloudflare's same-origin /cdn-cgi/trace; outside the
// regions that require prior consent for analytics cookies (EEA, UK,
// Switzerland) it is updated to granted. If the lookup fails the visitor stays
// denied — the safe side. Ad signals are denied and Google Signals is off
// everywhere (no ads here; it would also post to www.google.com, outside the CSP).
// (gtag's own region-scoped defaults were tried first: they denied a verified
// US visitor, so the country is resolved here instead.)
const GA_MEASUREMENT_ID = 'G-988W9C9SMZ';
const CONSENT_WAIT_MS = 500;
const CONSENT_REQUIRED_COUNTRIES = [
  // EU
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // rest of the EEA, the UK, Switzerland
  'IS', 'LI', 'NO', 'GB', 'CH',
];

function googleAnalytics() {
  return {
    name: 'google-analytics',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      if (html.includes('googletagmanager.com/gtag/js')) return html;
      return {
        html,
        tags: [
          {
            tag: 'script',
            children: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: ${CONSENT_WAIT_MS} });
fetch('/cdn-cgi/trace', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
  var m = /(?:^|\\n)loc=([A-Z]{2})/.exec(t);
  if (m && ${JSON.stringify(CONSENT_REQUIRED_COUNTRIES)}.indexOf(m[1]) === -1) gtag('consent', 'update', { analytics_storage: 'granted' });
}).catch(function () {});
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}', { allow_google_signals: false, allow_ad_personalization_signals: false });`,
            injectTo: 'head-prepend' as const,
          },
          { tag: 'script', attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}` }, injectTo: 'head-prepend' as const },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), devStaticPages(), googleAnalytics()],
  build: {
    rollupOptions: {
      input: {
        // The SPA shell AND the homepage (/) — index.html carries the SPA mount
        // plus a curl-readable static fallback in <noscript>/#root.
        main: resolve(root, 'index.html'),
        // Static marketing leaf pages, served at /keyring, /registry,
        // /docs/agents by Cloudflare Pages' pretty-URL asset serving ahead of
        // the SPA fallback. Fully self-contained (inline styles + JS), curl-readable.
        keyring: resolve(root, 'keyring.html'),
        registry: resolve(root, 'registry.html'),
        docsAgents: resolve(root, 'docs/agents.html'),
        codex: resolve(root, 'codex.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
