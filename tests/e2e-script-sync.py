"""
Imports a deliberately tampered .rs (stored script = B, the copy embedded in the
scene = stale) while the script editor is open on the old code, then checks the
script editor, the scene components and PLAY all use B. Also writes
/tmp/tampered.rs, which e2e-open-rs-file.py reuses.
Usage: python3 tests/e2e-script-sync.py http://127.0.0.1:8001 LABEL
(needs the Monaco bundle in project/vendor/monaco-editor and playwright)
"""
import sys, json, zipfile, re, io
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]          # e.g. http://127.0.0.1:8001
LABEL = sys.argv[2]
res=[]
def check(name, ok, extra=""):
    res.append(ok); print(("PASS " if ok else "FAIL ")+name+(("  -> "+str(extra)[:110]) if extra!="" else ""))
with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1500,"height":950}, service_workers="block", accept_downloads=True)
    pg=ctx.new_page(); pg.on("dialog", lambda d: d.accept())
    pg.goto(BASE+"/index.html", wait_until="domcontentloaded", timeout=60000); pg.wait_for_timeout(1500)
    pg.click("text=New project"); pg.wait_for_timeout(500); pg.click('.template-card:has-text("Platformer")'); pg.wait_for_timeout(300)
    pg.click("text=Initialize workspace"); pg.wait_for_timeout(5000)
    ed=ctx.pages[-1]; errs=[]; ed.on("pageerror", lambda e: errs.append(str(e)[:150]))
    ed.wait_for_selector("[data-action=toggle-play]", timeout=60000); ed.wait_for_timeout(2500)
    # find a script name that is attached to an entity
    info = ed.evaluate("""async () => {
      const st = await import('/project/editor/state/EditorState.js'); const ss = await import('/project/editor/scripting/ScriptStorage.js');
      const ents = st.editorState.game.world.getAllEntities(); const used=[];
      for (const e of ents){ const c=e.getComponent('Script'); if(c&&c.scriptName) used.push(c.scriptName); }
      return { used, names: ss.getAllScripts() };
    }""")
    X = info["used"][0]; print("script under test:", X, "| scripts in project:", len(info["names"]))
    origA = ed.evaluate("async (n)=> (await import('/project/editor/scripting/ScriptStorage.js')).getScriptSource(n)", X)
    # open the script editor on it (caches a Monaco model with the ORIGINAL code)
    def open_editor():
        n = ed.evaluate("document.querySelectorAll('[data-action=\"select-entity\"]').length")
        for i in range(n):
            ed.evaluate("(i)=>document.querySelectorAll('[data-action=\"select-entity\"]')[i]?.click()", i); ed.wait_for_timeout(450)
            has = ed.evaluate("(x)=>{ const b=document.querySelector('[data-action=\"open-script-editor\"]'); const v=document.querySelector('input[data-field*=scriptName]')?.value||''; return !!b && v===x; }", X)
            if has:
                ed.evaluate("document.querySelector('[data-action=\"open-script-editor\"]').click()"); return True
        return False
    check("opened script editor on original project", open_editor())
    ed.wait_for_selector(".monaco-editor", timeout=60000); ed.wait_for_timeout(1500)
    # save project -> .rs download
    ed.evaluate("document.querySelector('[data-action=\"toggle-menu\"][data-menu=\"file\"]')?.click()"); ed.wait_for_timeout(400)
    if not ed.query_selector('[data-action="save-project"]'):
        print("menus:", ed.evaluate("[...document.querySelectorAll('[data-action=toggle-menu]')].map(e=>e.dataset.menu)"))
        ed.evaluate("document.querySelectorAll('[data-action=toggle-menu]')[0].click()"); ed.wait_for_timeout(400)
    with ed.expect_download(timeout=30000) as dl:
        ed.evaluate("document.querySelector('[data-action=\"save-project\"]').click()")
    vs_bytes = open(dl.value.path(),'rb').read(); print("saved:", dl.value.suggested_filename, len(vs_bytes), "bytes")
    # tamper: stored script = B, embedded scene copies = STALE
    zin = zipfile.ZipFile(io.BytesIO(vs_bytes)); out = io.BytesIO(); zout = zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED)
    B = "global.__marker = 'STORAGE-B';\nfunction onStart() {}\n"; STALE = "global.__marker = 'STALE-EMBEDDED';\nfunction onStart() {}\n"
    def stale(n):
        if isinstance(n,dict):
            if isinstance(n.get("Script"),dict) and n["Script"].get("scriptName")==X: n["Script"]["source"]=STALE
            for v in n.values(): stale(v)
        elif isinstance(n,list):
            for v in n: stale(v)
    patched=0
    for item in zin.infolist():
        data=zin.read(item.filename)
        if item.filename=="scripts.json":
            d=json.loads(data); d[X]=B; data=json.dumps(d).encode()
        elif item.filename.startswith("scenes/") and item.filename.endswith(".json") and item.filename!="scenes/index.json":
            d=json.loads(data); stale(d); data=json.dumps(d).encode(); patched+=1
        zout.writestr(item, data)
    zout.close(); open("/tmp/tampered.rs","wb").write(out.getvalue())
    print("tampered .rs written; scene files patched:", patched)
    # import it while the script editor is still open on the OLD code
    ed.set_input_files('[data-action="load-project-input"]', "/tmp/tampered.rs")
    for _ in range(40):   # the import is async (assets, scenes): wait until it has visibly finished
        ed.wait_for_timeout(500)
        done = ed.evaluate("async (n)=>{ const ss=await import('/project/editor/scripting/ScriptStorage.js'); const l=document.body.innerText||''; return /Loaded project|Project loaded|Loaded/i.test(l) || ss.getScriptSource(n).includes('STORAGE-B'); }", X)
        if done: break
    ed.wait_for_timeout(1500)
    st = ed.evaluate("""async (n) => {
      const st = await import('/project/editor/state/EditorState.js'); const ss = await import('/project/editor/scripting/ScriptStorage.js');
      const comps=[]; for (const e of st.editorState.game.world.getAllEntities()){ const c=e.getComponent('Script'); if(c&&c.scriptName===n) comps.push(c.source); }
      return { storage: ss.getScriptSource(n), tabs: st.editorState.scriptEditor.openTabs.slice(), open: st.editorState.scriptEditor.open, comps };
    }""", X)
    check("storage holds the imported (B) code", "STORAGE-B" in st["storage"], st["storage"][:50])
    check("script editor tabs/models were reset by the import", st["tabs"] == [] and st["open"] is False, st["tabs"])
    check("scene components carry B, not the stale embedded copy", len(st["comps"])>0 and all("STORAGE-B" in c for c in st["comps"]), [c[:40] for c in st["comps"]])
    # reopen the editor via the Inspector button (the path that used to overwrite storage)
    check("reopened script editor from the Inspector", open_editor())
    ed.wait_for_selector(".monaco-editor", timeout=60000); ed.wait_for_timeout(1500)
    shown=[]
    for _ in range(20):
        shown = ed.evaluate("() => { const m = window.monaco && window.monaco.editor.getModels().map(x=>x.getValue()); return m||[]; }")
        if any(len(x)>0 for x in shown): break
        ed.wait_for_timeout(500)
    shown_has_B = any("STORAGE-B" in s for s in shown); shown_has_old = any((origA.strip() and origA.strip()[:60] in s) for s in shown if "STORAGE-B" not in s)
    check("editor shows B (not the old project's code)", shown_has_B and not shown_has_old, f"models={len(shown)}")
    after = ed.evaluate("async (n)=> (await import('/project/editor/scripting/ScriptStorage.js')).getScriptSource(n)", X)
    check("opening the editor did not overwrite stored code", "STORAGE-B" in after, after[:50])
    # Play: what does the game actually run?
    ed.evaluate("document.querySelector('[data-action=\"toggle-pause\"]') && 0")
    with ed.expect_popup(timeout=20000) as pop: ed.evaluate("document.querySelector('[data-action=toggle-play]').click()")
    play = pop.value; play.wait_for_function("() => !!(window.__realotGame || window.__zengineGame)", timeout=30000); play.wait_for_timeout(2500)
    ran = play.evaluate("""() => { const g = (window.__realotGame || window.__zengineGame); const seen = [];
      const walk = (o, d) => { if (!o || d > 3 || typeof o !== 'object') return; for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch(e) { continue; }
        if (v instanceof Map && k === '_scriptSources') for (const [n, s] of v) seen.push(n + '::' + s);
        else if (v && typeof v === 'object' && !(v instanceof Node)) walk(v, d + 1); } };
      walk(g, 0); return seen; }""")
    mine=[s for s in ran if s.startswith(X+"::")]
    check("PLAY compiled the B code", any("STORAGE-B" in s for s in mine), f"{len(mine)} compiled copies")
    check("PLAY never compiled the stale embedded code", not any("STALE-EMBEDDED" in s for s in ran))
    print("page errors:", errs[:2])
    b.close()
print(f"\nSUMMARY [{LABEL}]: {sum(res)}/{len(res)} passed"); sys.exit(0 if all(res) else 1)
