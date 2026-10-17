/**
 * InstallsView.js
 * Lists installed engine versions on this machine, Unity-Hub-Installs-tab style.
 */
window.RealotInstallsView = {
    // Single real install — this Hub only ever runs the one engine build
    // that ships alongside it (see runtime/EngineVersion.js, the single
    // source of truth for the version number). The old hardcoded second
    // "2.5.0-beta.3" row implied a second, separately-installed engine
    // version that doesn't actually exist anywhere in this project.
    installs: [
        { version: window.RealotVersion || '1.0.0', label: 'Stable', active: true }
    ],

    render() {
        const { el } = window.RealotDom;

        const rows = this.installs.map(inst => el('div', { class: 'project-row', style: 'cursor:default;' }, [
            el('div', { class: 'project-thumb' }, [el('span', { html: '<svg data-lucide="box"></svg>' })]),
            el('div', { class: 'project-meta' }, [
                el('div', { class: 'project-name' }, [`Realot ${inst.version}`]),
                el('div', { class: 'project-path' }, [inst.active ? 'Active version' : 'Installed'])
            ]),
            el('div', { class: 'project-tags' }, [
                el('span', { class: 'tag' + (inst.active ? ' tag-version' : '') }, [inst.label])
            ])
        ]));

        return el('div', { class: 'project-list' }, rows);
    }
};
