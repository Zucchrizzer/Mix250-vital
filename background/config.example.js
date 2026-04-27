/**
 * config.js — Local secrets file. Never commit this.
 *
 * Setup:
 *   1. Copy this file to background/config.js
 *   2. Replace YOUR_API_KEY_HERE with your key from https://console.anthropic.com
 *   3. Set USE_MOCK = false in service-worker.js to enable live analysis
 *
 * Loaded by the service worker via importScripts('config.js').
 * Defines ANTHROPIC_API_KEY as a global variable.
 */

const ANTHROPIC_API_KEY = 'YOUR_API_KEY_HERE';
