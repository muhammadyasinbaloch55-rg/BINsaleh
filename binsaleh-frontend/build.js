#!/usr/bin/env node
/**
 * build.js — Production build for the BIN SALEH Store storefront.
 *
 * Copies the static site into dist/ and protects EVERY piece of JavaScript
 * that ships to the browser:
 *
 *   1. External files (js/*.js) are obfuscated with javascript-obfuscator
 *      using the aggressive production profile.
 *   2. Inline <script> blocks inside every HTML page (cart/checkout logic,
 *      the admin panel, product loaders, etc.) are obfuscated IN PLACE using
 *      a balanced profile — HTML structure, attributes and CSS are untouched.
 *
 * Development files are NEVER touched: dev mode serves the source js/
 * directory directly, so debugging stays readable while production ships
 * hardened code.
 *
 * Compatibility rules that keep the site working:
 *  - renameGlobals / renameProperties are OFF everywhere — external files
 *    share globals with inline scripts (api, API_BASE, loadCart, saveCart,
 *    CART_KEY, TRACKING_DATA, ...) and inline scripts define the global
 *    functions wired to HTML onclick attributes (placeOrder, showPage,
 *    openCheckout, ...). Top-level identifiers must survive obfuscation.
 *  - Script blocks that are NOT JavaScript (type="application/ld+json",
 *    text/template, type="module", ...) are skipped untouched. Module
 *    scripts are skipped deliberately: their top-level scope is module
 *    scope, not global scope, so renameGlobals:false would not protect
 *    their identifiers across import/export boundaries.
 *  - Any literal "</script>" the obfuscator might emit inside a string is
 *    re-escaped to "<\/script>" so the HTML block can never terminate early.
 *  - HTML/CSS/images are copied byte-for-byte — the UI is unchanged.
 *  - No source maps are generated or copied, and no sourceMappingURL
 *    comments are written, so the readable source is never downloadable.
 *  - disableConsoleOutput only affects this production build.
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const JS_DIR = path.join(ROOT, 'js');
const SEED = 20260812;

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

// 2) Obfuscate every production JS file in dist/js (aggressive profile).
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
  seed: SEED,
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

// 3) Obfuscate inline <script> blocks inside every dist HTML page.
// Balanced profile — strong protection without the size/runtime blow-up of
// dead-code injection, and without tamper-triggered self-destruction, which
// matters for large inline scripts like the admin panel.
const INLINE_OPTIONS = {
  compact: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.6,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  disableConsoleOutput: true,
  simplify: true,
  seed: SEED,
  target: 'browser'
};

function collectHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectHtml(full).forEach((f) => out.push(f));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

let inlineTotal = 0;
for (const htmlPath of collectHtml(DIST)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const original = html;
  let changed = false;

  const processed = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (match, attrs, body) => {
    // Leave external scripts alone (attrs always follow "<script" with whitespace).
    if (/\ssrc\s*=/.test(attrs)) return match;
    // Leave non-JavaScript blocks (JSON-LD, templates, type="module", ...) untouched.
    if (/type\s*=/i.test(attrs) && !/text\/javascript|application\/javascript/i.test(attrs)) return match;
    if (!body.trim()) return match;
    changed = true;
    let result;
    try {
      result = JavaScriptObfuscator.obfuscate(body, INLINE_OPTIONS).getObfuscatedCode();
    } catch (err) {
      console.error(`❌ Obfuscation failed for inline block in ${path.relative(ROOT, htmlPath)}: ${err.message}`);
      process.exit(1);
    }
    inlineTotal += result.length;
    // Safety net: a raw "</script>" inside the JS body would terminate the
    // HTML block early. "<\/script>" is byte-identical inside JS strings and
    // regexes, so this is always safe.
    const safe = result.split('</script>').join('<\\/script>');
    return `<script${attrs}>${safe}</script>`;
  });

  if (changed) {
    // Self-check: the number of <script> elements must never change — a
    // mismatch here would mean the regex mangled the HTML.
    const before = (html.match(/<script/gi) || []).length;
    const after = (processed.match(/<script/gi) || []).length;
    if (before !== after) {
      console.error(`❌ Script-tag mismatch in ${path.relative(ROOT, htmlPath)}: ${before} → ${after}`);
      process.exit(1);
    }
    fs.writeFileSync(htmlPath, processed);
    console.log(`🔒 Inline JS in ${path.relative(ROOT, htmlPath)} (${((original.length - processed.length) / 1024).toFixed(0)} KB net change)`);
  }
}

// 4) Final integrity checks.
console.log('');
for (const required of ['index.html', 'js/api.js', 'js/store.js', 'js/trackin.js', '_headers', '_redirects']) {
  if (!fs.existsSync(path.join(DIST, required))) {
    console.error(`❌ Missing ${required} in dist/`);
    process.exit(1);
  }
}

// No source maps may ship (requirement: never expose the readable source).
const distFiles = [...collectHtml(DIST), ...fs.readdirSync(path.join(DIST, 'js')).map((f) => path.join(DIST, 'js', f))];
const strayMaps = [];
for (const f of distFiles) {
  if (f.endsWith('.map')) strayMaps.push(f);
  if (fs.readFileSync(f, 'utf8').includes('sourceMappingURL')) strayMaps.push(`${f} (sourceMappingURL comment)`);
}
if (strayMaps.length) {
  console.error(`❌ Source map exposure: ${strayMaps.join(', ')}`);
  process.exit(1);
}

console.log(`✅ Production build complete → dist/ (${(inlineTotal / 1024).toFixed(0)} KB of inline JS protected, source files untouched, no source maps)`);
