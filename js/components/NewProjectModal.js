/**
 * NewProjectModal.js
 * Modal dialog for creating a new project: project title and a starter
 * template. Mounted once at #modal-root and toggled via the .open class
 * so its internal input state survives re-renders of other views.
 */
window.RealotNewProjectModal = {
    nameValue: '',

    render() {
        const { el } = window.RealotDom;
        const state = window.RealotStore.getState();

        const nameInput = el('input', {
            type: 'text',
            class: 'field-input',
            placeholder: 'e.g. Untitled Masterpiece',
            value: this.nameValue,
            oninput: (e) => { this.nameValue = e.target.value; }
        });

        const body = el('div', { class: 'modal-body' }, [
            el('div', { class: 'field-group' }, [
                el('label', { class: 'field-label' }, ['Project title']),
                nameInput
            ]),
            el('div', {}, [
                el('label', { class: 'field-label' }, ['Starting architecture']),
                window.RealotTemplateGrid.render()
            ])
        ]);

        const footer = el('div', { class: 'modal-footer' }, [
            el('span', { style: 'font-size:12px;color:var(--text-500);' }, [`Realot Engine v${window.RealotVersion || '1.0.0'} (Stable)`]),
            el('div', { style: 'display:flex;gap:10px;' }, [
                el('button', { class: 'btn btn-ghost', onClick: () => window.RealotStore.closeModal() }, ['Cancel']),
                el('button', {
                    class: 'btn btn-primary',
                    onClick: () => {
                        const project = window.RealotStore.createProject({ name: this.nameValue.trim() });
                        this.nameValue = '';
                        window.RealotNav.openEditor(project);
                    }
                }, [
                    'Initialize workspace',
                    el('span', { html: '<svg data-lucide="arrow-right"></svg>' })
                ])
            ])
        ]);

        const panel = el('div', { class: 'modal-panel' }, [
            el('div', { class: 'modal-header' }, [
                el('div', { class: 'modal-title' }, ['New project']),
                el('button', { class: 'btn btn-icon', title: 'Close', 'aria-label': 'Close', onClick: () => window.RealotStore.closeModal() }, [
                    el('span', { html: '<svg data-lucide="x"></svg>' })
                ])
            ]),
            body,
            footer
        ]);

        const overlay = el('div', {
            class: 'modal-overlay' + (state.modalOpen ? ' open' : ''),
            onClick: (e) => { if (e.target === overlay) window.RealotStore.closeModal(); }
        }, [panel]);

        overlay.tabIndex = -1;
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') window.RealotStore.closeModal();
        });

        return overlay;
    }
};
