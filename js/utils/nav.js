/**
 * nav.js
 * Navigation from the launcher into the editor. The editor lives at
 * /project/editor/ and is opened in the same frame
 * (replacing the launcher) so the React host stays put and no new tab
 * is opened. The project id/name is passed as a query param so the
 * editor can identify the open project; the store also records the
 * last-opened time so the project bubbles to the top of the list.
 */
window.RealotNav = {
    openEditor(project) {
        const params = new URLSearchParams();
        if (project && project.id) params.set('project', project.id);
        if (project && project.name) params.set('name', project.name);
        // Only pass templateId through when it names a template with real
        // bundled data to seed from (see templates.js's hasBundledData) —
        // the editor only needs this on a project's very first open (see
        // SceneViewport.js's loadInitialProject()), and every later open
        // already has its own saved snapshot, so there's no reason to keep
        // widening this URL's contract for every project going forward.
        if (project && project.templateId) {
            const tpl = window.RealotTemplates.find(t => t.id === project.templateId);
            if (tpl && tpl.hasBundledData) params.set('template', tpl.id);
        }
        if (project && project.id) window.RealotStore.touchProject(project.id);
        const qs = params.toString();
        window.location.href = 'project/editor/' + (qs ? '?' + qs : '');
    },
    backToHub() {
        window.location.href = './';
    }
};
