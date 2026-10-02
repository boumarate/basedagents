import { useEffect, useState } from 'react';

/**
 * The "Recently paid" feed — the homepage section under the hero and the Paid
 * view on /tasks. On since 2026-09-24; turning it off is this one constant.
 *
 * With the constant off, `?preview=paid-feed` shows it for one browser tab
 * (sessionStorage) and `?preview=off` clears that.
 */
export const PAID_FEED_ENABLED = true;

const PREVIEW_KEY = 'ba:preview:paid-feed';

function previewRequested(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('preview');
    if (q === 'paid-feed') sessionStorage.setItem(PREVIEW_KEY, '1');
    if (q === 'off') sessionStorage.removeItem(PREVIEW_KEY);
    return sessionStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the paid feed renders. The first render (and the prerender) uses the
 * constant, so hydration never mismatches; a preview switches it on after mount.
 */
export function usePaidFeedFlag(): boolean {
  const [on, setOn] = useState(PAID_FEED_ENABLED);
  useEffect(() => {
    if (!PAID_FEED_ENABLED && previewRequested()) setOn(true);
  }, []);
  return on;
}
