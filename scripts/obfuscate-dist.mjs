// scripts/obfuscate-dist.mjs
//
// Runs AFTER `vite build`. Obfuscates every emitted JS file under dist/.
// Source files are never touched, so esbuild always sees clean code.
//
// Usage:  node scripts/obfuscate-dist.mjs
//
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const DIST_ASSETS = 'dist/assets';
const DIST_SCRIPTS = 'dist/scripts';

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }

  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

async function dirExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const roots = [];
  if (await dirExists(DIST_ASSETS))  roots.push(DIST_ASSETS);
  if (await dirExists(DIST_SCRIPTS)) roots.push(DIST_SCRIPTS);

  if (roots.length === 0) {
    console.error('[obfuscate-dist] No dist output found — did vite build succeed?');
    process.exit(1);
  }

  const files = (await Promise.all(roots.map(walk))).flat();
  if (files.length === 0) {
    console.warn('[obfuscate-dist] No .js files found in dist/ — nothing to obfuscate.');
    return;
  }

  let count = 0;
  let totalBytes = 0;

  for (const file of files) {
    const before = await readFile(file, 'utf8');
    const after = JavaScriptObfuscator.obfuscate(before, {
      compact: true,

      // ── OFF: these are the settings that break builds ────────────────
      controlFlowFlattening: false,
      deadCodeInjection: false,
      selfDefending: false,
      debugProtection: false,
      disableConsoleOutput: false,

      // ── ON: safe, useful, and what most apps actually want ───────────
      identifierNamesGenerator: 'hexadecimal',
      numbersToExpressions: true,
      renameGlobals: true,
      simplify: true,
      splitStrings: true,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      log: false,

      reservedStrings: [
        'typst_ts_web_compiler_bg',
        'typst.ts',
        'typst-ts-web-compiler',
        '.wasm',
      ],
    }).getObfuscatedCode();

    await writeFile(file, after);
    count++;
    totalBytes += Buffer.byteLength(after, 'utf8');
  }

  console.log(
    `[obfuscate-dist] Obfuscated ${count} file(s) ` +
    `(${(totalBytes / 1024).toFixed(1)} KB)`
  );
}

main().catch(err => {
  console.error('[obfuscate-dist] Failed:', err);
  process.exit(1);
});