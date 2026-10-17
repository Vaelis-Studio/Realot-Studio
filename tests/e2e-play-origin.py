"""
End-to-end test for the Play window: handshake, origin isolation, console
escaping, pause/resume.

Setup (from the folder that contains index.html):
    python3 -m http.server 8001 --bind 127.0.0.1 &
    python3 -m http.server 8002 --bind 127.0.0.1 &
    pip install playwright && playwright install chromium
Run:
    python3 tests/e2e-play-origin.py same    # play window on the editor's origin
    python3 tests/e2e-play-origin.py cross   # play window on a second origin (recommended setup)
Exits non-zero if anything fails.
"""
import sys, json, re
from playwright.sync_api import sync_playwright
MODE = sys.argv[1]  # "cross" or "same"
EDITOR = "http://127.0.0.1:8001/project/editor/index.html"
PLAY_ORIGIN = "http://127.0.0.1:8002"
res = []
def check(name, ok, extra=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + name + (("  -> " + str(extra)) if extra != "" else ""))

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("editor pageerror: " + str(e)[:150]))
    if MODE == "cross":
        def patch(route):
            r = route.fetch(); body = r.text().replace('name="realot-play-origin" content=""', 'name="realot-play-origin" content="%s"' % PLAY_ORIGIN)
            route.fulfill(response=r, body=body)
        page.route("**/project/editor/index.html*", patch)
    page.goto(EDITOR, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector('[data-action="toggle-play"]', timeout=90000)
    page.wait_for_timeout(1500)
    page.evaluate("localStorage.setItem('e2e-editor-secret','TOP-SECRET-KEY')")
    with page.expect_popup(timeout=20000) as pop:
        page.click('[data-action="toggle-play"]')
    play = pop.value
    play.wait_for_function("() => !!window.__realotGame", timeout=30000)
    url = play.url
    check("popup opened on expected origin (%s)" % MODE, url.startswith(PLAY_ORIGIN if MODE == "cross" else "http://127.0.0.1:8001"), url[:70])
    check("popup url carries ?editor=", "editor=" in url)
    check("game booted in popup (payload handshake worked)", True)
    sec = play.evaluate("localStorage.getItem('e2e-editor-secret')")
    if MODE == "cross":
        check("popup CANNOT see editor localStorage", sec is None, sec)
        r = play.evaluate("() => { try { return String(window.opener.localStorage.getItem('e2e-editor-secret')); } catch(e) { return 'BLOCKED:' + e.name; } }")
        check("popup CANNOT reach window.opener.localStorage", str(r).startswith("BLOCKED"), r)
        r2 = play.evaluate("() => { try { return typeof window.opener.document.body; } catch(e) { return 'BLOCKED:' + e.name; } }")
        check("popup CANNOT read editor DOM via opener", str(r2).startswith("BLOCKED"), r2)
        r3 = play.evaluate("() => { try { return String((()=>{}).constructor('return localStorage.getItem(\"e2e-editor-secret\")')()); } catch(e){ return 'BLOCKED'; } }")
        check("script constructor-bypass now yields NOTHING from editor storage", r3 in ("null", "BLOCKED"), r3)
    else:
        check("(same-origin mode) popup shares storage as before", sec == "TOP-SECRET-KEY", sec)
    # console forwarding + XSS escaping
    play.evaluate("console.log('hello <img src=x onerror=\"window.__pwned=1\">')")
    play.evaluate("window.opener.postMessage({type:'realot_console_log', level:'x\" onmouseover=\"window.__pwned=2', message:'<b id=injected>bold</b>'}, '*')")
    page.wait_for_timeout(900)
    html = page.inner_html('#console-list-el') if page.query_selector('#console-list-el') else ""
    if not html:
        # console tab may not be active
        for t in page.query_selector_all('[data-action*="console"], button:has-text("Console")')[:1]: t.click()
        page.wait_for_timeout(500); html = page.inner_html('#console-list-el') if page.query_selector('#console-list-el') else ""
    check("console received forwarded message", "hello" in html, "html chars=%d" % len(html))
    check("console text is escaped (no live <img>/<b> injected)", page.query_selector('#console-list-el img[src="x"]') is None and page.query_selector('#console-list-el #injected') is None)
    check("no script ran in the editor (__pwned unset)", page.evaluate("window.__pwned") is None)
    check("bad level did not break out of class attribute", 'onmouseover' not in re.sub(r'&quot;|&amp;', '', html).split('class="log-row')[-1][:40] if 'onmouseover' in html else True)
    # untrusted sender (editor posting to itself) must be ignored
    page.evaluate("window.postMessage({type:'realot_console_log', message:'SPOOF-FROM-SELF'}, '*')")
    page.wait_for_timeout(500)
    html2 = page.inner_html('#console-list-el')
    check("message from a non-play window is ignored", "SPOOF-FROM-SELF" not in html2)
    # pause / resume
    page.click('[data-action="toggle-pause"]'); page.wait_for_timeout(500)
    paused = play.evaluate("window.__realotGame.loop._paused")
    check("Pause button pauses the popup's loop", paused is True, paused)
    page.click('[data-action="toggle-pause"]'); page.wait_for_timeout(500)
    check("Resume works", play.evaluate("window.__realotGame.loop._paused") is False)
    # script error forwarding
    play.evaluate("window.opener.postMessage({type:'realot_script_error', scriptName:'<i>S</i>', message:'boom', line:7, method:'onUpdate'}, '*')")
    page.wait_for_timeout(500)
    check("script error shows up (escaped)", "boom" in page.inner_html('#console-list-el') and page.query_selector('#console-list-el i') is None)
    # replay (reload path)
    page.click('[data-action="toggle-play"]'); page.wait_for_timeout(500)
    page.click('[data-action="toggle-play"]'); page.wait_for_timeout(2500)
    page.click('[data-action="toggle-play"]') if False else None
    pages = ctx.pages
    popups = [x for x in pages if 'play-popup' in x.url]
    ok = False
    if popups:
        try: popups[0].wait_for_function("() => !!window.__realotGame", timeout=20000); ok = True
        except Exception as e: ok = False
    check("play window still alive / re-bootable after toggling", ok, [x.url[:60] for x in pages])
    for e in errs: print("NOTE", e)
    b.close()
print("\nSUMMARY (%s): %d/%d passed" % (MODE, sum(res), len(res)))
sys.exit(0 if all(res) else 1)
