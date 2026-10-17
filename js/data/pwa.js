/**
 * pwa.js
 * Registers the service worker and captures the browser's install
 * prompt, so the titlebar can show a real "Install app" button instead
 * of the browser's own (often hidden) install affordance. Same
 * IIFE + pub/sub shape as store.js, kept as its own module since this
 * is orthogonal to project/UI state — components only need to know
 * "can I offer an install button right now."
 */
(function () {
    const state = {
        // Set from the captured beforeinstallprompt event. Non-null only
        // while an install is actually offerable — Chromium-family
        // browsers only fire this once the PWA criteria (manifest +
        // service worker + not already installed) are met.
        deferredPrompt: null,
        // True once the app is confirmed running as an installed PWA
        // (already installed launches with display-mode: standalone, or
        // the appinstalled event already fired this session) — used to
        // hide the button rather than offer to "install" an already-
        // installed app.
        installed: window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
    };

    const listeners = new Set();
    function notify() { listeners.forEach(fn => fn(state)); }

    // Fires when the browser decides this page qualifies as installable.
    // Prevent the default mini-infobar so our own titlebar button is the
    // only install affordance shown — matches the MDN-documented pattern.
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        state.deferredPrompt = e;
        notify();
    });

    window.addEventListener('appinstalled', () => {
        state.deferredPrompt = null;
        state.installed = true;
        notify();
    });

    if ('serviceWorker' in navigator) {
        // Registered from the root so its scope covers the whole Hub
        // (launcher + linked editor/player pages), matching manifest.
        // webmanifest's "scope": "/". Registration failure (e.g. running
        // over plain http on a non-localhost host) is swallowed — it
        // only means no install prompt is offered, never a broken app.
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => { /* no offline/installability support this session */ });
        });
    }

    window.RealotPWA = {
        getState() { return state; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        /** True when there's a real, currently-valid prompt to show. */
        canInstall() { return !state.installed && !!state.deferredPrompt; },
        /** Show the button whenever the app isn't already installed (uses manual help if no native prompt). */
        canOfferInstall() { return !state.installed; },
        /**
         * Shows the browser's native install prompt. Must be called
         * directly from a user gesture (click) — the captured event can
         * only be used once, so it's cleared immediately after.
         */
        async promptInstall() {
            const promptEvent = state.deferredPrompt;
            if (!promptEvent) {
                // Browsers fire beforeinstallprompt inconsistently (not at all
                // on Safari/Firefox, and Chrome/Edge suppress it after a
                // dismissal or if installed from another profile). Fall back
                // to telling the user where the browser's own install lives.
                window.alert('To install Realot:\n\n' +
                    '\u2022 Chrome / Edge (desktop): click the install icon at the right end of the address bar, or open the \u22EE / \u2026 menu \u2192 "Install Realot" / "Apps".\n' +
                    '\u2022 Safari (iPhone/iPad): Share \u2192 Add to Home Screen.\n' +
                    '\u2022 Safari (Mac): File \u2192 Add to Dock.');
                return;
            }
            state.deferredPrompt = null;
            notify();
            promptEvent.prompt();
            // outcome is 'accepted' | 'dismissed' — not surfaced further
            // today; appinstalled (above) is the source of truth for
            // "installed" state either way.
            await promptEvent.userChoice.catch(() => {});
        }
    };
})();
