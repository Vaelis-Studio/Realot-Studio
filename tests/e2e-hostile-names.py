"""
Puts script-injection payloads into entity names, script names and target
names, then makes the editor render them (hierarchy + inspector) and checks
that no injected code runs. Same setup as e2e-play-origin.py (needs the
editor served on 127.0.0.1:8001). Exits non-zero if anything executes.
"""
import sys
from playwright.sync_api import sync_playwright
PAY = '"><img src=x onerror="window.__pwned=(window.__pwned||0)+1">'
with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1500,"height":950}, service_workers="block")
    pg=ctx.new_page(); errs=[]
    pg.goto("http://127.0.0.1:8001/index.html", wait_until="domcontentloaded", timeout=60000); pg.wait_for_timeout(1500)
    pg.click("text=New project"); pg.wait_for_timeout(500)
    pg.click('.template-card:has-text("Platformer")'); pg.wait_for_timeout(300)
    pg.click("text=Initialize workspace"); pg.wait_for_timeout(5000)
    ed=ctx.pages[-1]; ed.on("pageerror", lambda e: errs.append(str(e)[:150]))
    ed.wait_for_selector("[data-action=toggle-play]", timeout=60000); ed.wait_for_timeout(2500)
    r = ed.evaluate("""async (PAY) => {
      const st = await import('/project/editor/state/EditorState.js');
      const es = st.editorState; const world = es.game && es.game.world;
      if (!world) return 'no world';
      const ents = world.getAllEntities(); let n = 0, sc = 0;
      for (const e of ents) { e.name = PAY + (n++); 
        for (const [k, c] of (e.components ? (e.components instanceof Map ? e.components : Object.entries(e.components)) : [])) { if (c && 'scriptName' in c) { c.scriptName = PAY; sc++; } if (c && 'targetName' in c) c.targetName = PAY; } }
      return 'renamed ' + n + ' entities, ' + sc + ' scriptNames';
    }""", PAY)
    print(r)
    # force re-renders: select each row, which re-renders hierarchy + inspector
    for row in ed.query_selector_all('[data-action="select-entity"]')[:8]:
        row.evaluate("e=>e.click()"); ed.wait_for_timeout(500)
    ed.wait_for_timeout(800)
    pwned = ed.evaluate("window.__pwned")
    stray = ed.evaluate("document.querySelectorAll('img[src=\"x\"]').length")
    print("window.__pwned in editor:", pwned, "| stray <img src=x> elements:", stray)
    where = ed.evaluate("""() => [...document.querySelectorAll('img[src="x"]')].map(i => { let n=i, chain=[]; for (let k=0;k<6&&n;k++){ n=n.parentElement; if(n) chain.push((n.id?'#'+n.id:'')+(n.className&&typeof n.className==='string'?'.'+n.className.split(' ')[0]:'')+'<'+n.tagName.toLowerCase()+'>'); } return chain.slice(0,4).join(' < '); })""")
    from collections import Counter
    for k,v in Counter(where).most_common(): print(v,'x',k)
    print("page errors:", errs[:3])
    ok = pwned is None and stray == 0
    print("RESULT:", "SAFE" if ok else "VULNERABLE")
    b.close(); sys.exit(0 if ok else 1)
