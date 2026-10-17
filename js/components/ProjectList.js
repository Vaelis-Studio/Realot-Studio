/**
 * ProjectList.js
 * Renders the recent-projects list, sorted by last-opened, or the
 * EmptyState when there are no projects (or no search matches).
 */
window.RealotProjectList = {
    render() {
        const { el } = window.RealotDom;
        const state = window.RealotStore.getState();

        const sorted = state.projects.slice().sort((a, b) => b.lastOpened - a.lastOpened);
        const query = state.searchQuery.trim().toLowerCase();
        const filtered = query
            ? sorted.filter(p => p.name.toLowerCase().includes(query))
            : sorted;

        if (state.projects.length === 0) {
            return window.RealotEmptyState.render({
                icon: 'film',
                title: 'No projects yet',
                desc: 'Create your first project to start building in Realot.',
                actionLabel: 'Start new project',
                onAction: () => window.RealotStore.openModal()
            });
        }

        if (filtered.length === 0) {
            return window.RealotEmptyState.render({
                icon: 'search-x',
                title: 'No matches',
                desc: 'Nothing in your projects matches "' + state.searchQuery + '".'
            });
        }

        return el('div', { class: 'project-list' },
            filtered.map(p => window.RealotProjectCard.render(p))
        );
    }
};
