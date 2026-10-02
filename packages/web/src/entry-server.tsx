/**
 * Server entry for build-time prerendering (POSITIONING_SPEC.md §A1).
 *
 * `scripts/prerender.mjs` bundles this with `vite build --ssr`, calls
 * `render(url)` for each prerendered route and writes the markup into the
 * built index.html. Nothing here runs at request time — Cloudflare Pages
 * serves static files; there is no SSR server.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AppRoutes } from './App.js';

export function render(url: string): string {
  return renderToString(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </React.StrictMode>,
  );
}
