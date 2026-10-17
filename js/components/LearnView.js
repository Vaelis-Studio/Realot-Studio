/**
 * LearnView.js
 * Documentation entry point. The docs themselves live in /docs/index.html
 * (static, works offline because it is listed in offline-manifest.json).
 */
window.RealotLearnView = {
    render() {
        const { el } = window.RealotDom;

        const link = (href, label, desc) =>
            el('a', {
                class: 'btn btn-ghost',
                href,
                target: '_blank',
                rel: 'noopener',
                style: 'display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-decoration:none;min-width:220px;'
            }, [
                el('span', {}, [label]),
                el('span', { style: 'opacity:.65;font-size:.85em;' }, [desc])
            ]);

        return el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-rings' }, [
                el('div', { class: 'ring ring-outer' }),
                el('div', { class: 'ring ring-inner' }),
                el('div', { class: 'ring-icon' }, [el('span', { html: '<svg data-lucide="book-open"></svg>' })])
            ]),
            el('div', { class: 'empty-title' }, ['Documentation & guides']),
            el('div', { class: 'empty-desc' }, ['Quick start, core concepts, the scripting API, and exporting your game.']),
            el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:12px;' }, [
                link('/docs/index.html', 'Open documentation', 'Quick start and scripting'),
                link('/docs/index.html#api', 'Script API', 'Lifecycle and globals'),
                link('/docs/index.html#safety', 'Safety', 'Scripts and shared projects')
            ])
        ]);
    }
};
