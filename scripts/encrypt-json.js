// scripts/encrypt-json.js
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { createCipheriv, randomBytes } from 'crypto';

// Exactly 32 bytes
const SECRET_KEY = Buffer.from('MedVixSecretKey2026!!32bytesXXKE', 'utf-8');
const ALGORITHM = 'aes-256-cbc';

// ── Files that MUST stay plain JSON at runtime ──────────────────────────
// Anything the browser fetches with fetch(...).json() must NOT be encrypted,
// because the client cannot decrypt it. Add new runtime assets here.
const SKIP_FILES = new Set([
    'manifest.json',
    'assetlinks.json',
    'emoji-map.json',
    // add more runtime-fetched JSON here, e.g.:
    // 'questions.json',
    // 'currencies.json',
    // 'config.json',
]);

// ── Folders that should never be touched ────────────────────────────────
const SKIP_DIRS = new Set([
    'emoji',
    'assets',
    'images',
    'icons',
]);

console.log(`[Encrypt] Key length: ${SECRET_KEY.length} bytes`);

function encryptFile(filePath) {
    const content = readFileSync(filePath, 'utf8');

    // Guard: skip if already encrypted (avoids double-encryption on repeat runs)
    if (/^[0-9a-f]{32}:[0-9a-f]+$/.test(content.trim())) {
        console.log(`Already encrypted, skipping: ${filePath}`);
        return;
    }

    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(content, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const output = iv.toString('hex') + ':' + encrypted;
    writeFileSync(filePath, output);
    console.log(`Encrypted: ${filePath}`);
}

function walkDir(dir) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir);
    for (const file of files) {
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
            if (SKIP_DIRS.has(file)) {
                console.log(`Skipping dir: ${file}`);
                continue;
            }
            walkDir(fullPath);
            continue;
        }

        if (extname(fullPath) !== '.json') continue;

        if (SKIP_FILES.has(file)) {
            console.log(`Skipping ${file}`);
            continue;
        }

        encryptFile(fullPath);
    }
}

const distPath = './dist';
if (existsSync(distPath)) {
    console.log('Encrypting JSON files in dist...');
    walkDir(distPath);
} else {
    console.error('dist folder not found. Run npm run build first.');
}