import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';

const root = document.getElementById('root')!;
const app = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// `/`, `/tasks` and `/about` ship prerendered markup (scripts/prerender.mjs): hydrate it
// when the markup was rendered for THIS path. The Pages fallback serves the
// prerendered homepage file for every other SPA route too — there the markup
// belongs to a different page, so drop it and render from scratch rather
// than hydrate a mismatch.
const here = window.location.pathname.replace(/\/+$/, '') || '/';
if (root.hasChildNodes() && root.dataset.prerendered === here) {
  ReactDOM.hydrateRoot(root, app);
} else {
  root.replaceChildren();
  ReactDOM.createRoot(root).render(app);
}
