# Bundled browser dependencies

Realot includes the browser dependencies it needs so the launcher, editor,
player, physics runtime, and script editor can run without a network request.

| Dependency | Version | Local path | License |
| --- | --- | --- | --- |
| PIXI.js | 7.4.2 | `project/vendor/pixi/pixi.min.js` | MIT |
| JSZip | 3.10.1 | `project/vendor/jszip/jszip.min.js` | MIT |
| Hammer.js | 2.0.7 | `project/vendor/hammer/hammer.min.js` | MIT |
| UPNG.js | 2.1.0 | `project/vendor/upng/UPNG.min.js` | MIT |
| Monaco Editor | 0.45.0 | `project/vendor/monaco-editor/min/vs/` | MIT; see `monaco-editor/LICENSE` and `monaco-editor/ThirdPartyNotices.txt` |
| Lucide | 1.35.0 | `js/vendor/lucide.min.js` | ISC |
| Inter / JetBrains Mono | bundled font files | `css/fonts/` | OFL-1.1 |
| Rapier2D compat | 0.20.0 | `project/vendor/@dimforge/rapier2d-compat/` | Apache-2.0 |

The minified files were downloaded from their published distributions and
the runtime references local relative paths instead of remote CDN URLs.

Full license texts: see `/THIRD_PARTY_LICENSES.md`. Exported games include `THIRD_PARTY_LICENSES.txt` automatically.
