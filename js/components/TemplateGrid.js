/**
 * TemplateGrid.js
 * Selectable grid of starter templates, used inside NewProjectModal.
 */
window.RealotTemplateGrid = {
    render() {
        const { el } = window.RealotDom;
        const state = window.RealotStore.getState();

        const cards = window.RealotTemplates.map(tpl => {
            const selected = state.selectedTemplateId === tpl.id;
            // Templates with a bundled banner thumbnail (see templates.js's
            // `thumbnail` field, e.g. Platformer Kit) show that image
            // instead of the small generic icon tile every other template
            // still uses — a real screenshot/art thumbnail is more useful
            // for choosing a starter than a single-color Lucide glyph, and
            // showing both would be redundant.
            const media = tpl.thumbnail
                ? el('div', { class: 'tpl-thumb' }, [
                    el('img', { src: tpl.thumbnail, alt: tpl.name + ' preview', loading: 'lazy' })
                ])
                : el('div', { class: 'tpl-icon' }, [el('span', { html: `<svg data-lucide="${tpl.icon}"></svg>` })]);
            return el('div', {
                class: 'template-card' + (selected ? ' selected' : '') + (tpl.thumbnail ? ' has-thumb' : ''),
                role: 'button',
                tabindex: '0',
                'aria-pressed': selected ? 'true' : 'false',
                onClick: () => window.RealotStore.selectTemplate(tpl.id)
            }, [
                el('div', { class: 'tpl-check' }, [el('span', { html: '<svg data-lucide="check"></svg>' })]),
                media,
                el('div', { class: 'tpl-name' }, [tpl.name]),
                el('div', { class: 'tpl-desc' }, [tpl.description])
            ]);
        });

        return el('div', { class: 'template-grid' }, cards);
    }
};
