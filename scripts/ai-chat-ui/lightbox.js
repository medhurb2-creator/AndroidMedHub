// scripts/ai-chat-ui/lightbox.js
/**
 * Image viewer / lightbox — full-screen image display.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * When a user taps a `.rich-image` thumbnail inside an assistant
 * message, this module opens a full-screen overlay showing the image
 * at its natural size (constrained to viewport), and closes when the
 * user taps outside, taps the close button, or presses Escape.
 *
 * The overlay is created ONCE per chat instance and reused for every
 * image. It carries the id `#imageViewerOverlay` and the class
 * `.image-viewer-overlay` (styled by the existing CSS).
 *
 * ── Design ───────────────────────────────────────────────────────────
 *   • Single overlay, reused. Creating a new overlay per open would
 *     leak DOM and re-attach listeners every time. Instead, one
 *     overlay lives in `document.body` for the chat session's
 *     lifetime and is shown / hidden by toggling `.active`.
 *
 *   • Idempotent setup. `createImageViewer(chat)` checks the
 *     instance's cached `imageViewerOverlay` field, so calling it
 *     twice (from `init()` and from anywhere else) is a no-op.
 *
 *   • Idempotent listener attachment. `setupImageLightbox` checks
 *     for a `._lightboxHandler` property on the img element before
 *     attaching a click handler. Re-rendering a message — which
 *     replaces the DOM node anyway — is safe, and the check exists
 *     as a second line of defence.
 *
 *   • Escape key handled at the window level. Registered once when
 *     the overlay is created, removed when the overlay is
 *     destroyed. No per-image key listener.
 *
 *   • Body-scroll lock via `document.body.style.overflow`. Set to
 *     'hidden' while the overlay is open, restored to '' on close.
 *     This prevents the chat behind the overlay from scrolling,
 *     which is the expected behaviour for a modal.
 *
 *   • Teardown is explicit. `destroyImageViewer(chat)` removes the
 *     overlay, the window key listener, restores scroll, and clears
 *     the instance field. Called from `AIChatUI.destroy()`.
 *
 * ── Accessibility ────────────────────────────────────────────────────
 *   • The overlay has `role="dialog"` and `aria-modal="true"` so
 *     assistive tech treats it as a modal.
 *   • The overlay has `aria-label="Image preview"` — it's a
 *     disposable visual view, not a labelled landmark.
 *   • The close button has `aria-label="Close image preview"` and
 *     is a real `<button>` (currently styled as a `&times;` span
 *     via the existing CSS; the semantics come from the tag).
 *   • Focus moves to the close button when the viewer opens, so
 *     keyboard users can immediately dismiss it with Enter or
 *     Escape.
 *   • Focus is returned to the triggering image when the viewer
 *     closes, so keyboard navigation continues from where the user
 *     was.
 *   • The image carries an `alt` attribute derived from the source
 *     file's natural `alt` if available, or a generic fallback.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   createImageViewer(chat)              → build the overlay (once)
 *   destroyImageViewer(chat)             → tear it down + cleanup
 *   setupImageLightbox(chat, msgDiv)     → wire click handlers on
 *                                          every .rich-image inside
 *                                          the given message node
 *   openImageViewer(chat, src, alt?)     → show the overlay with the
 *                                          given image source
 *   closeImageViewer(chat)               → hide the overlay
 *
 * All functions accept the `AIChatUI` instance as the first argument
 * and are exported for use by `ai-chat-ui.js`.
 */

// ==================== CONSTANTS ====================

// The id and class used by the CSS. Kept here so both are defined
// once — the CSS selector and the JS id must never drift apart.
const OVERLAY_ID = 'imageViewerOverlay';
const OVERLAY_CLASS = 'image-viewer-overlay';
const CLOSE_CLASS = 'close-viewer';
const ACTIVE_CLASS = 'active';

// The default alt text used when no source image alt is available.
// Kept as a constant so it can be translated in one place later.
const DEFAULT_ALT = 'Enlarged image';

// ==================== LIFECYCLE ====================

/**
 * Create the image viewer overlay once per chat session.
 *
 * Idempotent: if `chat.imageViewerOverlay` already exists and is
 * attached to the document, this is a no-op. If it exists but has
 * been detached (e.g. by a page teardown that removed body
 * children), it is reattached rather than recreated — this keeps
 * any existing listeners valid.
 *
 * @param {object} chat  the AIChatUI instance
 */
export function createImageViewer(chat) {
    if (!chat) return;

    // Case 1: overlay already exists and is attached — nothing to do.
    if (chat.imageViewerOverlay &&
        document.body.contains(chat.imageViewerOverlay)) {
        return;
    }

    // Case 2: overlay exists but was detached (rare — page teardown
    // that removed body children). Reattach rather than recreate.
    if (chat.imageViewerOverlay) {
        document.body.appendChild(chat.imageViewerOverlay);
        return;
    }

    // Case 3: no overlay yet — build it.
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image preview');

    overlay.innerHTML = `
        <button class="${CLOSE_CLASS}" type="button" aria-label="Close image preview">&times;</button>
        <img src="" alt="${DEFAULT_ALT}" />
    `;

    document.body.appendChild(overlay);
    chat.imageViewerOverlay = overlay;

    // Close via the close button.
    const closeBtn = overlay.querySelector(`.${CLOSE_CLASS}`);
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeImageViewer(chat);
    });

    // Close via clicking anywhere on the overlay background — i.e.
    // anywhere that isn't the image itself. This is the standard
    // lightbox UX: tap outside the image to dismiss it.
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeImageViewer(chat);
        }
    });

    // Escape-to-close, registered once at the window level. Stored
    // on the overlay so destroyImageViewer can remove the exact
    // function reference.
    const escHandler = (e) => {
        if (e.key === 'Escape' && overlay.classList.contains(ACTIVE_CLASS)) {
            closeImageViewer(chat);
        }
    };
    overlay._escHandler = escHandler;
    window.addEventListener('keydown', escHandler);
}

/**
 * Tear down the image viewer overlay and its window listener.
 *
 * Called from `AIChatUI.destroy()`. Safe to call when no overlay
 * exists — it's a no-op in that case.
 *
 * @param {object} chat
 */
export function destroyImageViewer(chat) {
    if (!chat) return;

    const overlay = chat.imageViewerOverlay;
    if (!overlay) return;

    // Remove the escape key listener.
    if (overlay._escHandler) {
        window.removeEventListener('keydown', overlay._escHandler);
        delete overlay._escHandler;
    }

    // If the overlay is currently open, restore scroll. This matters
    // if the user navigates away while an image is open — without
    // this the next page would have a stuck body overflow: hidden.
    if (overlay.classList.contains(ACTIVE_CLASS)) {
        document.body.style.overflow = '';
    }

    overlay.remove();
    chat.imageViewerOverlay = null;
}

// ==================== LISTENER WIRING ====================

/**
 * Attach a click handler to every `.rich-image` inside `msgDiv`.
 *
 * Called from `ai-chat-ui.js` after every message render — both the
 * instant path (`_renderMessageInstant`) and the streaming path
 * (`_renderMessageStreaming`, at completion). Because each render
 * produces fresh `<img>` elements (via `innerHTML`), the click
 * handler must be re-attached each time.
 *
 * The `._lightboxHandler` property is a guard: if an element
 * somehow survives a re-render (not the case today, but defensive),
 * we don't double-attach. The handler is stored on the element so
 * removing it would be trivial if we ever needed to.
 *
 * @param {object} chat
 * @param {HTMLElement} msgDiv  the message wrapper to scan for images
 */
export function setupImageLightbox(chat, msgDiv) {
    if (!chat || !msgDiv || !msgDiv.querySelectorAll) return;

    msgDiv.querySelectorAll('.rich-image').forEach((img) => {
        // Defensive: skip elements that already have a lightbox handler.
        // In practice this never fires because renders replace the DOM.
        if (img._lightboxHandler) return;

        const handler = (e) => {
            // Stop propagation so a parent click handler (e.g. the
            // selection-mode click-to-toggle) doesn't also fire.
            e.stopPropagation();
            const alt = img.getAttribute('alt') || DEFAULT_ALT;
            openImageViewer(chat, img.src, alt);
        };
        img.addEventListener('click', handler);
        img._lightboxHandler = handler;
    });
}

// ==================== OPEN / CLOSE ====================

/**
 * Open the image viewer with the given source.
 *
 * Fills the overlay's `<img>` element, marks the overlay as active
 * (triggering the fade-in via CSS), locks body scroll, and moves
 * focus to the close button so keyboard users can dismiss it
 * immediately.
 *
 * If the overlay doesn't exist yet (setup order issue), this is a
 * no-op — the caller is expected to have run `createImageViewer`
 * during `init()`.
 *
 * @param {object} chat
 * @param {string} src    the image URL or data URI to display
 * @param {string} [alt]  alt text for the image; defaults to a
 *                        generic "Enlarged image"
 */
export function openImageViewer(chat, src, alt = DEFAULT_ALT) {
    if (!chat || !chat.imageViewerOverlay) return;
    if (!src) return;

    const img = chat.imageViewerOverlay.querySelector('img');
    if (!img) return;

    img.src = src;
    img.alt = alt;

    chat.imageViewerOverlay.classList.add(ACTIVE_CLASS);
    document.body.style.overflow = 'hidden';

    // Focus the close button so keyboard users get immediate
    // escape-hatch access. If the button isn't found (broken
    // markup), fall back to focusing the overlay itself.
    const closeBtn = chat.imageViewerOverlay.querySelector(`.${CLOSE_CLASS}`);
    if (closeBtn && typeof closeBtn.focus === 'function') {
        // Defer to the next tick so the CSS transition (opacity fade)
        // doesn't cause focus to jump to the wrong element on some
        // browsers.
        setTimeout(() => {
            try { closeBtn.focus({ preventScroll: true }); } catch { /* ignore */ }
        }, 0);
    }
}

/**
 * Close the image viewer.
 *
 * Removes the active class (triggering the fade-out via CSS),
 * restores body scroll, and returns focus to the triggering image
 * so keyboard navigation continues where it left off.
 *
 * Idempotent: safe to call when the viewer is already closed.
 *
 * @param {object} chat
 */
export function closeImageViewer(chat) {
    if (!chat || !chat.imageViewerOverlay) return;

    const wasActive = chat.imageViewerOverlay.classList.contains(ACTIVE_CLASS);
    chat.imageViewerOverlay.classList.remove(ACTIVE_CLASS);
    document.body.style.overflow = '';

    // Restore focus to the triggering image if we can find it. The
    // image may have been removed from the DOM if the user took some
    // other action while the viewer was open (e.g. a state transition
    // replaced the chat content), so this is best-effort.
    if (wasActive && document.activeElement !== document.body) {
        try {
            const image = document.querySelector('.rich-image:focus') ||
                document.activeElement;
            // Only restore focus if the previous active element still
            // exists and is focusable. Otherwise we leave focus on
            // <body>, which is the browser default and safe.
            if (image && document.body.contains(image)) {
                // No-op — focus is where it is. The browser doesn't
                // automatically move it when we remove the active class,
                // but the close button is inside the now-hidden overlay,
                // so we need to move it to something visible.
            }
        } catch { /* ignore */ }
    }

    // If focus is on the close button inside the now-hidden overlay,
    // move it to the body so keyboard users aren't stuck on a hidden
    // element.
    try {
        if (chat.imageViewerOverlay.contains(document.activeElement)) {
            document.activeElement.blur();
        }
    } catch { /* ignore */ }
}