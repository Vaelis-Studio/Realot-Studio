/**
 * EmptyState.js
 * Reusable centered empty/zero-result state with concentric rings
 * motif (echoes the engine's camera-gizmo/lighting-cone visuals).
 */
window.RealotEmptyState = {
    /**
     * @param {{icon:string,title:string,desc:string,actionLabel?:string,onAction?:Function}} opts
     */
    render({ icon, title, desc, actionLabel, onAction }) {
        const { el } = window.RealotDom;

        const children = [
            el('div', { class: 'empty-rings' }, [
                el('div', { class: 'ring ring-outer' }),
                el('div', { class: 'ring ring-inner' }),
                el('div', { class: 'ring-icon' }, [el('span', { html: `<svg data-lucide="${icon}"></svg>` })])
            ]),
            el('div', { class: 'empty-title' }, [title]),
            el('div', { class: 'empty-desc' }, [desc])
        ];

        if (actionLabel && onAction) {
            children.push(
                el('button', { class: 'btn btn-ghost', onClick: onAction }, [
                    el('span', { html: '<svg data-lucide="plus"></svg>' }),
                    actionLabel
                ])
            );
        }

        return el('div', { class: 'empty-state' }, children);
    }
};
