import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { syncColorScheme } from './lib/color-scheme';
import './styles/globals.css';

// Before the first render, so the shell never paints in the wrong color scheme.
const stopColorSchemeSync = syncColorScheme();
// The listener lives as long as the page. Only dev hot reloads re-run this module and need it removed.
import.meta.hot?.dispose(stopColorSchemeSync);

const container = document.getElementById('root');
if (container === null) {
  throw new Error('The shell page has no #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
