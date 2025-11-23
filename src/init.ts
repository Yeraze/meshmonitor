// This module MUST be imported first in main.tsx
// It sets up the API base URL before any other modules are loaded
import api from './services/api';

// Get the basename from the <base> tag that was injected by the server
// This handles deployments with a custom base_url (like /meshmonitor)
const baseElement = document.querySelector('base');
const baseHref = baseElement?.getAttribute('href') || '/';
const basename = baseHref === '/' ? '' : baseHref.replace(/\/$/, '');

// Set the API base URL globally BEFORE any contexts or components are loaded
// This is critical for routes like /packet-monitor to work correctly
api.setBaseUrl(basename);

console.log('[INIT] Set API base URL to:', basename);

export const appBasename = basename;
