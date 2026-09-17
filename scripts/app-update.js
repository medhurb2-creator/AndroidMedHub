// scripts/app-update.js
// MedVix — Google Play In-App Updates service
// Policy: exactly one version behind → soft (flexible).
//         two or more versions behind → hard (immediate).

const PLUGIN_NAME = 'AppUpdate';

// ============================================================
// STATE
// ============================================================
let _plugin = null;
let _bound = false;
const _handlers = {
    progress: [],
    downloaded: [],
    failed: [],
    canceled: [],
};

// ============================================================
// PLUGIN RESOLUTION
// ============================================================
function plugin() {
    if (_plugin) return _plugin;

    const C = typeof window !== 'undefined' ? window.Capacitor : null;
    if (!C) return null;

    if (typeof C.isNativePlatform === 'function' && !C.isNativePlatform()) {
        return null;
    }
    if (typeof C.isPluginAvailable === 'function' && !C.isPluginAvailable(PLUGIN_NAME)) {
        return null;
    }

    if (typeof C.registerPlugin === 'function') {
        _plugin = C.registerPlugin(PLUGIN_NAME);
    } else if (C.Plugins && C.Plugins[PLUGIN_NAME]) {
        _plugin = C.Plugins[PLUGIN_NAME];
    }

    return _plugin || null;
}

function bindListeners() {
    const p = plugin();
    if (!p || _bound) return;
    _bound = true;

    const emit = (key) => (data) => {
        const list = _handlers[key] || [];
        list.forEach((fn) => {
            try { fn(data); } catch (e) { console.error(`[app-update] handler error (${key}):`, e); }
        });
    };

    if (typeof p.addListener === 'function') {
        p.addListener('downloadProgress', emit('progress'));
        p.addListener('updateDownloaded', emit('downloaded'));
        p.addListener('updateFailed', emit('failed'));
        p.addListener('updateCanceled', emit('canceled'));
    }
}

// ============================================================
// PUBLIC — SUPPORT CHECK
// ============================================================
export function isAppUpdateSupported() {
    return !!plugin();
}

// ============================================================
// PUBLIC — EVENT SUBSCRIPTION
// ============================================================
export function onAppUpdate(event, fn) {
    bindListeners();
    if (!_handlers[event]) _handlers[event] = [];
    _handlers[event].push(fn);
    return () => {
        _handlers[event] = _handlers[event].filter((f) => f !== fn);
    };
}

// ============================================================
// PUBLIC — RAW API
// ============================================================
export async function checkForUpdate() {
    const p = plugin();
    if (!p) {
        return {
            supported: false,
            updateAvailable: false,
            updateInProgress: false,
            flexibleAllowed: false,
            immediateAllowed: false,
            updatePriority: 0,
            availableVersionCode: 0,
            installStatusName: 'UNKNOWN',
        };
    }
    const info = await p.check();
    return { supported: true, ...info };
}

export async function startFlexibleUpdate() {
    const p = plugin();
    if (!p) return { started: false, reason: 'unsupported' };
    return p.startFlexible();
}

export async function startImmediateUpdate() {
    const p = plugin();
    if (!p) return { started: false, reason: 'unsupported' };
    return p.startImmediate();
}

export async function applyDownloadedUpdate() {
    const p = plugin();
    if (!p) return;
    await p.completeUpdate();
}

// ============================================================
// PUBLIC — SEVERITY CLASSIFIER
// ============================================================
/**
 * Rule:
 *   diff == 1  → soft  (one version behind)
 *   diff >= 2  → hard  (two or more versions behind)
 *   diff <= 0  → none  (already current, or ahead)
 *
 * @param {number} currentCode  Running app's versionCode
 * @param {number} newCode      versionCode Play is offering
 * @returns {'none'|'soft'|'hard'}
 */
export function classifyUpdate(currentCode, newCode) {
    const diff = Number(newCode) - Number(currentCode);
    if (diff <= 0) return 'none';
    if (diff === 1) return 'soft';
    return 'hard';
}

// ============================================================
// PUBLIC — FULL POLICY
// ============================================================
/**
 * @param {object}   opts
 * @param {number}   opts.currentVersionCode  Running app's versionCode
 * @param {function} opts.onFlexibleReady     Called when a soft download completes
 */
export async function runUpdatePolicy({
    currentVersionCode,
    onFlexibleReady = null,
} = {}) {
    const p = plugin();
    if (!p) return { action: 'unsupported' };

    bindListeners();

    const info = await p.check();

    if (!info.updateAvailable && !info.updateInProgress) {
        return { action: 'none', info };
    }

    // A previous-session flexible download is already sitting on disk.
    if (info.installStatusName === 'DOWNLOADED') {
        if (onFlexibleReady) onFlexibleReady(info);
        return { action: 'flexible-ready', info };
    }

    const newCode = Number(info.availableVersionCode) || 0;
    const severity = classifyUpdate(currentVersionCode, newCode);

    console.log(
        `[app-update] current=${currentVersionCode} available=${newCode} ` +
        `diff=${newCode - currentVersionCode} severity=${severity}`
    );

    if (severity === 'hard') {
        if (!info.immediateAllowed) {
            console.warn('[app-update] hard wanted but immediate not allowed — falling back');
            if (info.flexibleAllowed) {
                if (onFlexibleReady) onAppUpdate('downloaded', () => onFlexibleReady(info));
                const r = await p.startFlexible();
                return { action: 'flexible', started: r.started, info };
            }
            return { action: 'none', info };
        }
        const r = await p.startImmediate();
        return { action: 'immediate', started: r.started, info };
    }

    if (severity === 'soft') {
        if (!info.flexibleAllowed) {
            if (info.immediateAllowed) {
                const r = await p.startImmediate();
                return { action: 'immediate', started: r.started, info };
            }
            return { action: 'none', info };
        }
        if (onFlexibleReady) onAppUpdate('downloaded', () => onFlexibleReady(info));
        const r = await p.startFlexible();
        return { action: 'flexible', started: r.started, info };
    }

    return { action: 'none', info };
}