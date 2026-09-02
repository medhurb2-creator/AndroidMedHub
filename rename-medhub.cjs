const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

const OLD_NAME = "medvix";
const NEW_NAME = "medvix";

// Directories that should NEVER be modified
const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".vite",
    ".cache",
    "coverage"
]);

// Text files that are safe to inspect
const TEXT_EXTENSIONS = new Set([
    ".html",
    ".htm",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".json",
    ".jsonc",
    ".xml",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".env",
    ".properties",
    ".gradle"
]);

/**
 * Converts:
 *
 * medvix  -> medvix
 * MedVix  -> MedVix
 * MEDVIX  -> MEDVIX
 * medviX  -> medviX
 * mEdViX  -> mEdViX
 *
 * by preserving the capitalization of each character.
 */
function preserveCase(match) {
    const replacement = NEW_NAME;

    return [...replacement]
        .map((char, index) => {
            const original = match[index];

            if (!original) {
                return char;
            }

            if (original === original.toUpperCase()) {
                return char.toUpperCase();
            }

            return char.toLowerCase();
        })
        .join("");
}

let changedFiles = 0;
let totalReplacements = 0;

function processDirectory(directory) {
    let entries;

    try {
        entries = fs.readdirSync(directory, {
            withFileTypes: true
        });
    } catch (error) {
        console.error(`Cannot read: ${directory}`);
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        // Skip directories
        if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name)) {
                processDirectory(fullPath);
            }

            continue;
        }

        // Only process known text files
        const extension = path.extname(entry.name).toLowerCase();

        if (!TEXT_EXTENSIONS.has(extension)) {
            continue;
        }

        let content;

        try {
            content = fs.readFileSync(fullPath, "utf8");
        } catch {
            continue;
        }

        // Case-insensitive search
        const regex = /medvix/gi;

        let fileReplacements = 0;

        const newContent = content.replace(regex, match => {
            fileReplacements++;
            return preserveCase(match);
        });

        // Write only if something actually changed
        if (newContent !== content) {
            try {
                fs.writeFileSync(fullPath, newContent, "utf8");

                changedFiles++;
                totalReplacements += fileReplacements;

                console.log(
                    `✓ ${path.relative(ROOT, fullPath)} — ${fileReplacements} replacement(s)`
                );
            } catch (error) {
                console.error(
                    `✗ Failed to write: ${path.relative(ROOT, fullPath)}`
                );
            }
        }
    }
}

console.log("");
console.log("==========================================");
console.log("       MedVix → MedVix Rename Tool");
console.log("==========================================");
console.log("");
console.log("Case-preserving replacement enabled.");
console.log("");

processDirectory(ROOT);

console.log("");
console.log("==========================================");
console.log("                 SUMMARY");
console.log("==========================================");
console.log(`Files changed: ${changedFiles}`);
console.log(`Replacements:  ${totalReplacements}`);
console.log("==========================================");
console.log("");