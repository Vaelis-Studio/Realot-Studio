/**
 * Titlebar.js
 * Minimal centered brand mark in the window titlebar, plus an "Install
 * app" button flush to the right when the browser has actually offered
 * an install prompt (see js/data/pwa.js). The button only ever appears
 * once the browser confirms this page is installable — no dead button
 * that does nothing on browsers/contexts that don't support PWA
 * install (e.g. most non-Chromium browsers, or once already installed).
 * No window controls are rendered — the host app frame owns those.
 */
window.RealotTitlebar = {
    render() {
        const { el } = window.RealotDom;
        const canInstall = window.RealotPWA && window.RealotPWA.canOfferInstall();

        const brand = el('div', { class: 'tb-brand' }, [
            el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.2 4.2l4.2 4.2M15.5 15.5l4.2 4.2M1 12h6M17 12h6M4.2 19.8l4.2-4.2M15.5 8.5l4.2-4.2"/></svg>' }),
            el('span', {}, ['Realot Hub'])
        ]);

        // Left spacer mirrors the width of the right-side slot so the
        // brand mark stays visually centered whether or not the install
        // button is showing, same balancing trick as .rail-spacer.
        const side = el('div', { class: 'tb-side' }, canInstall ? [
            el('button', {
                class: 'btn btn-ghost btn-install',
                title: 'Install Realot as an app',
                onClick: () => window.RealotPWA.promptInstall()
            }, [
                el('span', { html: '<svg data-lucide="download"></svg>' }),
                'Install app'
            ])
        ] : []);

        return el('div', { class: 'tb-row' }, [
            el('div', { class: 'tb-side tb-side-left' }),
            brand,
            side
        ]);
    }
};
