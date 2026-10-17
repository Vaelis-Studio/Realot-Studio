/**
 * Rail.js
 * Unity-Hub-style narrow icon rail for top-level section navigation.
 */
window.RealotRail = {
    render() {
        const { el } = window.RealotDom;
        const state = window.RealotStore.getState();

        const items = window.RealotIcons.rail.map(item => {
            const isActive = state.view === item.id;
            return el('button', {
                class: 'rail-item' + (isActive ? ' active' : ''),
                title: item.label,
                'aria-label': item.label,
                'aria-current': isActive ? 'page' : null,
                onClick: () => window.RealotStore.setView(item.id)
            }, [el('span', { html: `<svg data-lucide="${item.icon}"></svg>` })]);
        });

        const account = el('button', {
            class: 'rail-item rail-account',
            title: 'Guest Developer — sign in to sync',
            'aria-label': 'Account'
        }, [el('span', { html: '<svg data-lucide="user"></svg>' })]);

        return el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:8px;height:100%;' }, [
            ...items,
            el('div', { class: 'rail-spacer' }),
            account
        ]);
    }
};
