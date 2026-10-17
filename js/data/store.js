/**
 * store.js
 * Minimal state container with a pub/sub subscribe model. Projects are
 * persisted to localStorage so created projects survive navigation to
 * the editor and back, and can be deleted.
 */
(function () {
    const STORAGE_KEY = 'realot.projects';

    function loadProjects() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (e) { /* ignore corrupt storage */ }
        return [...window.RealotSeedProjects];
    }

    function saveProjects(projects) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch (e) { /* ignore */ }
    }

    const state = {
        view: 'projects',            // 'projects' | 'learn' | 'installs'
        projects: loadProjects(),
        searchQuery: '',
        modalOpen: false,
        renamingProjectId: null,     // id of the project card currently showing its rename input, or null
        selectedTemplateId: window.RealotTemplates.find(t => t.default)?.id || window.RealotTemplates[0].id
    };

    const listeners = new Set();
    function notify() { listeners.forEach(fn => fn(state)); }
    function persist() { saveProjects(state.projects); }

    window.RealotStore = {
        getState() { return state; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        setView(view) { state.view = view; notify(); },
        setSearchQuery(q) { state.searchQuery = q; notify(); },
        openModal() { state.modalOpen = true; notify(); },
        closeModal() { state.modalOpen = false; notify(); },
        selectTemplate(id) { state.selectedTemplateId = id; notify(); },
        getProject(id) { return state.projects.find(p => p.id === id) || null; },
        createProject({ name }) {
            const tpl = window.RealotTemplates.find(t => t.id === state.selectedTemplateId);
            const project = {
                id: 'proj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                name: name || 'Untitled Project',
                template: tpl ? tpl.name : 'Blank Canvas',
                // Template id (distinct from the display name above) — read
                // by the editor's loadInitialProject() on this project's
                // first open to decide whether to seed it from a template's
                // bundled snapshot (see js/data/templates.js's hasBundledData)
                // instead of the normal blank starter scene. Not used by the
                // launcher itself past this point.
                templateId: tpl ? tpl.id : 'blank',
                version: window.RealotVersion || '1.0.0',
                platform: 'Web',
                lastOpened: Date.now(),
                art: null
            };
            state.projects.unshift(project);
            state.modalOpen = false;
            state.view = 'projects';
            persist();
            notify();
            return project;
        },
        touchProject(id) {
            const p = state.projects.find(p => p.id === id);
            if (!p) return;
            p.lastOpened = Date.now();
            persist();
            notify();
        },
        startRename(id) {
            state.renamingProjectId = id;
            notify();
        },
        cancelRename() {
            state.renamingProjectId = null;
            notify();
        },
        renameProject(id, name) {
            const p = state.projects.find(p => p.id === id);
            state.renamingProjectId = null;
            if (!p) { notify(); return; }
            const trimmed = (name || '').trim();
            if (trimmed && trimmed !== p.name) {
                p.name = trimmed;
                persist();
            }
            notify();
        },
        deleteProject(id) {
            state.projects = state.projects.filter(p => p.id !== id);
            persist();
            notify();
            // Also drop this project's autosaved editor snapshot (scenes,
            // assets, scripts, layers, tags — see editor/state/
            // ProjectStorage.js) so a deleted project doesn't keep taking
            // up localStorage/IndexedDB space, and so its id can never be
            // "resurrected" with stale data if it were ever reused.
            if (window.RealotPersistence) {
                window.RealotPersistence.removeItem(window.RealotPersistence.projectSnapshotKey(id));
                // Also drop any granted FSA backup directory handle for
                // this project (see RealotPersistence.js's removeFsaBackupHandle
                // doc comment) — lives in a completely separate IndexedDB
                // object store from the snapshot removed above, so it
                // needs its own explicit cleanup call or it's never freed.
                if (typeof window.RealotPersistence.removeFsaBackupHandle === 'function') {
                    window.RealotPersistence.removeFsaBackupHandle(id);
                }
            }
        }
    };
})();
