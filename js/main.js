/**
 * main.js
 * Application bootstrap. Subscribes to the store and re-renders the
 * affected DOM regions on every state change. No virtual DOM — each
 * region is small enough to fully re-render on change.
 */
(function () {
    const { mount, refreshIcons, el } = window.RealotDom;

    const titlebarRoot = document.getElementById('titlebar-root');
    const railRoot = document.getElementById('rail-root');
    const topbarRoot = document.getElementById('topbar-root');
    const viewRoot = document.getElementById('view-root');
    const modalRoot = document.getElementById('modal-root');

    function renderAll() {
        mount(titlebarRoot, window.RealotTitlebar.render());
        mount(railRoot, window.RealotRail.render());
        mount(topbarRoot, window.RealotTopbar.render());

        const state = window.RealotStore.getState();
        const inner = el('div', { class: 'view-inner' }, [window.RealotRouter.resolve(state.view)]);
        mount(viewRoot, inner);

        mount(modalRoot, window.RealotNewProjectModal.render());

        refreshIcons();
    }

    window.RealotStore.subscribe(renderAll);
    if (window.RealotPWA) window.RealotPWA.subscribe(renderAll);
    renderAll();
})();
