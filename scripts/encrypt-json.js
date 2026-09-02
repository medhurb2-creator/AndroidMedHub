// scripts/encrypt-json.js
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { createCipheriv, randomBytes } from 'crypto';

// Exactly 32 bytes
const SECRET_KEY = Buffer.from('MedVixSecretKey2026!!32bytesXXKE', 'utf-8');
const ALGORITHM = 'aes-256-cbc';

console.log(`[Encrypt] Key length: ${SECRET_KEY.length} bytes`);

function encryptFile(filePath) {
    const content = readFileSync(filePath, 'utf8');
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
            walkDir(fullPath);
        } else if (extname(fullPath) === '.json') {
            if (file === 'manifest.json' || file === 'assetlinks.json') {
                console.log(`Skipping ${file}`);
                continue;
            }
            encryptFile(fullPath);
        }
    }
}

const distPath = './dist';
if (existsSync(distPath)) {
    console.log('Encrypting JSON files in dist...');
    walkDir(distPath);
} else {
    console.error('dist folder not found. Run npm run build first.');
}