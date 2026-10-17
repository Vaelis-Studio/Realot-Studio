/**
 * router.js
 * Maps the current store view name to a view-content renderer.
 * Not a URL router — this launcher has no navigable history, just
 * in-memory tab state, so this simply resolves state.view -> component.
 */
window.RealotRouter = {
    resolve(view) {
        switch (view) {
            case 'projects':
                return window.RealotProjectList.render();
            case 'learn':
                return window.RealotLearnView.render();
            case 'installs':
                return window.RealotInstallsView.render();
            default:
                return window.RealotProjectList.render();
        }
    }
};
