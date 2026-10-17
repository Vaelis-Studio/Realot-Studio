# Third-party licenses

Realot bundles the open-source components below so it can run with no
network access. This file lists what is bundled and under which license.
Games exported from the editor only ship the three runtime libraries,
via `project/vendor/RUNTIME_LICENSES.txt`.

| Component | Version | Used in | License |
| --- | --- | --- | --- |
| PixiJS | 7.4.2 | editor, player, exports | MIT |
| Hammer.js | 2.0.7 | editor, player, exports | MIT |
| Rapier (rapier2d-compat) | 0.20.0 | editor, player, exports | Apache-2.0 |
| JSZip | 3.10.1 | editor only | MIT (dual MIT / GPLv3, used under MIT) |
| UPNG.js | 2.1.0 | editor only (PNG optimizer) | MIT |
| Monaco Editor | 0.45.0 | editor only (script editor) | MIT |
| Lucide | 1.35.0 | hub UI | ISC |
| Inter, JetBrains Mono | bundled files | hub and editor UI | SIL OFL 1.1 |

## Before you publish: two items to finish

I could not fetch these from upstream while preparing this file, so copy
the exact text yourself:

1. **UPNG.js** — copy its `LICENSE` from https://github.com/photopea/UPNG.js
   into the section below. It is MIT-licensed; the exact copyright line comes
   from that file.
2. **Fonts** — add the `OFL.txt` files shipped with Inter and JetBrains Mono
   next to the font files (`css/fonts/`). The OFL requires its text to
   accompany the fonts. Copyright lines: "Copyright (c) 2016 The Inter Project
   Authors" and "Copyright 2020 The JetBrains Mono Project Authors".

## PixiJS 7.4.2 — MIT

```
The MIT License

Copyright (c) 2013-2023 Mathew Groves, Chad Engler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Hammer.js 2.0.7 — MIT

```
MIT License

Copyright (c) 2016 Jorik Tangelder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## JSZip 3.10.1 — MIT

```
MIT License

Copyright (c) 2009-2016 Stuart Knightley and contributors (used under the MIT option of the dual MIT/GPLv3 licence)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Rapier 0.20.0 — Apache-2.0

The full license text is in
`project/vendor/@dimforge/rapier2d-compat/LICENSE`, and is also copied into
`project/vendor/RUNTIME_LICENSES.txt` for exported games.

## Monaco Editor 0.45.0 — MIT

See `project/vendor/monaco-editor/LICENSE` and
`project/vendor/monaco-editor/ThirdPartyNotices.txt` (keep both when
redistributing).

## Lucide 1.35.0 — ISC

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

## UPNG.js 2.1.0 — MIT

```
(paste the LICENSE text from https://github.com/photopea/UPNG.js here)
```
