/**
 * ProjectCard.js
 * A single row in the recent-projects list: thumbnail, name, template
 * tag, and last-opened time. Clicking the row opens the project in the
 * editor; the trash action deletes it from the launcher. The pencil
 * action swaps the name label for an inline text input (rename mode is
 * tracked in RealotStore.state.renamingProjectId so only one card edits
 * at a time and re-renders cleanly).
 */
window.RealotProjectCard = {
    render(project) {
        const { el } = window.RealotDom;
        const isRenaming = window.RealotStore.getState().renamingProjectId === project.id;

        const thumb = el('div', { class: 'project-thumb' }, [
            el('span', { html: '<svg data-lucide="image"></svg>' })
        ]);

        const commitRename = (inputEl) => window.RealotStore.renameProject(project.id, inputEl.value);

        const nameNode = isRenaming
            ? el('input', {
                class: 'project-name-input',
                type: 'text',
                value: project.name,
                'aria-label': 'Project name',
                onClick: (e) => e.stopPropagation(),
                onKeydown: (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(e.target); }
                    else if (e.key === 'Escape') { e.preventDefault(); window.RealotStore.cancelRename(); }
                },
                onBlur: (e) => commitRename(e.target)
            })
            : el('div', { class: 'project-name' }, [project.name]);

        const meta = el('div', { class: 'project-meta' }, [
            nameNode,
            el('div', { class: 'project-path' }, [project.template || 'Blank Canvas'])
        ]);

        const tags = el('div', { class: 'project-tags' }, [
            el('span', { class: 'tag tag-version' }, [project.version]),
            el('span', { class: 'tag' }, [project.platform])
        ]);

        const opened = el('div', { class: 'project-opened' }, [window.RealotFormat.timeAgo(project.lastOpened)]);

        const renameBtn = el('button', {
            class: 'btn btn-icon',
            title: 'Rename project',
            'aria-label': 'Rename project',
            onClick: (e) => {
                e.stopPropagation();
                window.RealotStore.startRename(project.id);
            }
        }, [el('span', { html: '<svg data-lucide="edit-3"></svg>' })]);

        const delBtn = el('button', {
            class: 'btn btn-icon btn-danger-soft',
            title: 'Delete project',
            'aria-label': 'Delete project',
            onClick: (e) => {
                e.stopPropagation();
                if (confirm('Delete "' + project.name + '"? This removes it from your projects.')) {
                    window.RealotStore.deleteProject(project.id);
                }
            }
        }, [el('span', { html: '<svg data-lucide="trash-2"></svg>' })]);

        const actions = el('div', { class: 'project-row-actions' }, [renameBtn, delBtn]);

        const openProject = () => window.RealotNav.openEditor(project);

        const row = el('div', {
            class: 'project-row',
            role: 'button',
            tabindex: '0',
            title: 'Open ' + project.name,
            onClick: (e) => {
                // Renaming owns the click while its input is focused —
                // don't let a stray click on the row (outside the
                // input, e.g. the meta padding) navigate away and
                // silently drop the edit.
                if (isRenaming) return;
                openProject();
            },
            onKeydown: (e) => {
                if (isRenaming) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openProject();
                }
            }
        }, [thumb, meta, tags, opened, actions]);

        if (isRenaming) {
            // Focus + select on the next tick, after the input is
            // actually in the DOM.
            setTimeout(() => {
                const input = row.querySelector('.project-name-input');
                if (input) { input.focus(); input.select(); }
            }, 0);
        }

        return row;
    }
};
