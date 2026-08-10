#!/usr/bin/env node
/**
 * build.js — Production build for the BIN SALEH Store storefront.
 *
 * Copies the static site into dist/ and obfuscates every production
 * JavaScript file (js/*.js) with javascript-obfuscator — the same engine
 * the vite-plugin-javascript-obfuscator wraps. Development files are
 * NEVER touched: dev mode serves the source js/ directory directly, so
 * debugging stays readable while production ships hardened code.
 *
 * Compatibility rules that keep the site working:
 *  - renameGlobals / renameProperties are OFF — api.js, store.js and
 *    trackin.js share globals across files and inline page scripts
 *    (api, API_BASE, loadCart, saveCart, CART_KEY, TRACKING_DATA, ...),
 *    so top-level identifiers must survive obfuscation.
 *  - HTML/CSS/images are copied byte-for-byte — the UI is unchanged.
 *  - disableConsoleOutput only affects this production build.
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const JS_DIR = path.join(ROOT, 'js');

// 1) Wipe + copy the site, excluding build internals.
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const entry of fs.readdirSync(ROOT)) {
  if (entry === 'node_modules' || entry === 'dist' || entry === '.git' ||
      entry === 'build.js' || entry === 'package.json' || entry === 'package-lock.json') {
    continue;
  }
  fs.cpSync(path.join(ROOT, entry), path.join(DIST, entry), { recursive: true });
}

// 2) Obfuscate every production JS file in dist/js.
const OBFUSCATION_OPTIONS = {
  compact: true,
  // String Array — strings moved to a scrambled lookup table
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  // Control Flow Flattening — breaks the natural top-down flow
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  // Dead Code Injection — safe level (30% of functions get junk code)
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  // Identifier Renaming — hexadecimal names inside function scopes
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  // Self Defending — code self-destructs if beautified/tampered with
  selfDefending: true,
  // Disable Console Output — production only (dev files untouched)
  disableConsoleOutput: true,
  // Additional hardening
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  target: 'browser'
};

const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
if (!jsFiles.length) {
  console.error('❌ No JS files found in js/');
  process.exit(1);
}

for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
  const result = JavaScriptObfuscator.obfuscate(src, OBFUSCATION_OPTIONS);
  const out = result.getObfuscatedCode();
  fs.writeFileSync(path.join(DIST, 'js', file), out);
  console.log(`🔒 Obfuscated js/${file} (${(src.length / 1024).toFixed(1)} KB → ${(out.length / 1024).toFixed(1)} KB)`);
}

// 3) Sanity check — dist must contain every entry point the site needs.
for (const required of ['index.html', 'js/api.js', 'js/store.js', 'js/trackin.js', '_headers', '_redirects']) {
  if (!fs.existsSync(path.join(DIST, required))) {
    console.error(`❌ Missing ${required} in dist/`);
    process.exit(1);
  }
}

console.log('✅ Production build complete → dist/ (source files untouched)');
