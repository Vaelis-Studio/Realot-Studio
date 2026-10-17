/**
 * Topbar.js
 * View title/subtitle on the left, contextual search + primary action
 * on the right. Content adapts to the active view.
 */
window.RealotTopbar = {
    titles: {
        projects: { title: 'Projects', sub: 'Recently opened workspaces' },
        learn: { title: 'Learn', sub: 'Guides, references and rendering techniques' },
        installs: { title: 'Installs', sub: 'Engine versions on this machine' }
    },

    render() {
        const { el } = window.RealotDom;
        const state = window.RealotStore.getState();
        const meta = this.titles[state.view] || this.titles.projects;

        const left = el('div', {}, [
            el('div', { class: 'tv-title' }, [meta.title]),
            el('div', { class: 'tv-sub' }, [meta.sub])
        ]);

        const right = el('div', { style: 'display:flex;align-items:center;gap:12px;' });

        // Always visible regardless of which view is active (Projects/
        // Learn/Installs) — this engine is free, so the ask should be
        // where people already are, not buried in a settings screen
        // they may never open. Real <a> tag (not a JS-driven
        // window.open on a button) for correct external-link semantics
        // — middle-click/"open in new tab"/right-click "copy link" all
        // work the way people expect from a normal link.
        const donateBtn = el('a', {
            class: 'btn btn-donate',
            href: 'https://paypal.me/RealotStudio',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'This engine is free, forever — if it saved you time, a donation (any amount) helps keep it that way.'
        }, [
            el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>' }),
            'Donate'
        ]);
        right.append(donateBtn);

        if (state.view === 'projects') {
            const search = el('div', { class: 'search-field' }, [
                el('span', { html: '<svg data-lucide="search"></svg>' }),
                el('input', {
                    type: 'text',
                    placeholder: 'Search projects',
                    value: state.searchQuery,
                    oninput: (e) => window.RealotStore.setSearchQuery(e.target.value)
                })
            ]);
            const newBtn = el('button', {
                class: 'btn btn-primary',
                onClick: () => window.RealotStore.openModal()
            }, [
                el('span', { html: '<svg data-lucide="plus"></svg>' }),
                'New project'
            ]);
            right.append(search, newBtn);
        }

        const wrap = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;width:100%;' }, [left, right]);
        return wrap;
    }
};
