import { useEffect } from 'react';
import { routeMeta, SITE_URL } from '../content/positioning.js';

type RouteKey = keyof typeof routeMeta;

/**
 * Per-route <title> / description / canonical / OpenGraph, kept in step on
 * client-side navigation (POSITIONING_SPEC.md §A2). The prerendered HTML for
 * `/` and `/tasks` already carries the same values, so hydration changes
 * nothing on first paint; this only matters once the SPA navigates.
 */
export function useRouteMeta(route: RouteKey): void {
  useEffect(() => {
    const meta = routeMeta[route];
    const url = `${SITE_URL}${route === '/' ? '/' : route}`;
    document.title = meta.title;
    const set = (selector: string, attr: string, value: string) => {
      const el = document.head.querySelector<HTMLElement>(selector);
      if (el) el.setAttribute(attr, value);
    };
    set('meta[name="description"]', 'content', meta.description);
    set('link[rel="canonical"]', 'href', url);
    set('meta[property="og:title"]', 'content', meta.title);
    set('meta[property="og:description"]', 'content', meta.description);
    set('meta[property="og:url"]', 'content', url);
    set('meta[name="twitter:title"]', 'content', meta.title);
    set('meta[name="twitter:description"]', 'content', meta.description);
  }, [route]);
}
