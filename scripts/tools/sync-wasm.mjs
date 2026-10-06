// scripts/tools/sync-wasm.mjs
//
// Copies the Typst compiler WASM binary from node_modules into public/wasm/
// so it can be fetched from a fixed, deployment-safe URL. Runs before every
// `dev` and `build` via npm lifecycle hooks.
//
// Idempotent: re-running overwrites the destination with the source. If the
// file is already up to date, the copy is a no-op but the stat check still
// logs the size, which is useful during debugging.

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const SOURCE = resolve(
  ROOT,
  'node_modules',
  '@myriaddreamin',
  'typst-ts-web-compiler',
  'pkg',
  'typst_ts_web_compiler_bg.wasm'
);

const DEST_DIR = resolve(ROOT, 'public', 'wasm');
const DEST = resolve(DEST_DIR, 'typst_ts_web_compiler_bg.wasm');

async function main() {
  // ── Verify the source exists ──────────────────────────────────────────
  try {
    await stat(SOURCE);
  } catch {
    console.error(`[sync-wasm] Source WASM not found at:\n  ${SOURCE}`);
    console.error('[sync-wasm] Did you run:');
    console.error('[sync-wasm]   npm install @myriaddreamin/typst.ts @myriaddreamin/typst-ts-web-compiler');
    process.exit(1);
  }

  // ── Ensure destination directory exists ───────────────────────────────
  await mkdir(DEST_DIR, { recursive: true });

  // ── Copy ──────────────────────────────────────────────────────────────
  await copyFile(SOURCE, DEST);

  const info = await stat(DEST);
  console.log(
    `[sync-wasm] Copied typst_ts_web_compiler_bg.wasm → public/wasm/ ` +
    `(${info.size.toLocaleString()} bytes)`
  );
}

main().catch(err => {
  console.error('[sync-wasm] Unexpected failure:', err);
  process.exit(1);
});