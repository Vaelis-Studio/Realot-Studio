/**
 * format.js
 * Display formatting helpers.
 */
window.RealotFormat = {
    /** Format a timestamp as a short relative "time ago" string. */
    timeAgo(timestamp) {
        const diffMs = Date.now() - timestamp;
        const min = Math.floor(diffMs / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const day = Math.floor(hr / 24);
        if (day < 7) return `${day}d ago`;
        const wk = Math.floor(day / 7);
        return `${wk}w ago`;
    }
};
