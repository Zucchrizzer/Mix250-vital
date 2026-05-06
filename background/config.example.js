/**
 * config.js — Local secrets file. Never commit this.
 *
 * Setup:
 *   1. Copy this file to background/config.js
 *   2. Replace YOUR_KEY_HERE with your key from https://aistudio.google.com
 *   3. Set USE_LIVE_API = true in service-worker.js to enable live analysis
 *
 * Loaded by the service worker via importScripts('config.js').
 * Defines GEMINI_API_KEY as a global variable.
 */

const GEMINI_API_KEY = 'YOUR_KEY_HERE';
