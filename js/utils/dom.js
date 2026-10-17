/**
 * dom.js
 * Tiny DOM helpers used across components to avoid repeating
 * createElement boilerplate. No framework — vanilla DOM only.
 */
window.RealotDom = {
    /**
     * Create an element with attributes and children.
     * @param {string} tag
     * @param {object} attrs - attributes; 'class' and 'html' are special-cased
     * @param {Array<Node|string>} children
     */
    el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([key, value]) => {
            if (value === null || value === undefined) return;
            if (key === 'class') node.className = value;
            else if (key === 'html') node.innerHTML = value;
            else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else {
                node.setAttribute(key, value);
            }
        });
        (Array.isArray(children) ? children : [children]).forEach(child => {
            if (child === null || child === undefined) return;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    },

    /** Replace all children of a mount node with a single new node. */
    mount(mountEl, node) {
        mountEl.innerHTML = '';
        mountEl.appendChild(node);
    },

    /** Re-run lucide icon replacement after DOM changes. */
    refreshIcons() {
        if (window.lucide) window.lucide.createIcons();
    }
};
