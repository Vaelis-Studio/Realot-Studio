"""
Checks manifest.webmanifest as Chromium parses it (.rs file handler + icons) and
simulates the OS opening a .rs file in the installed app (launchQueue).
Run tests/e2e-script-sync.py first: it writes /tmp/tampered.rs used here.
Editor served on http://127.0.0.1:8001.
"""
import base64, sys
from playwright.sync_api import sync_playwright
data = base64.b64encode(open('/tmp/tampered.rs','rb').read()).decode()
ok=[]
def check(n,c,x=""): ok.append(c); print(("PASS " if c else "FAIL ")+n+(("  -> "+str(x)[:120]) if x!="" else ""))
with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1400,"height":900}, service_workers="block")
    pg=ctx.new_page(); pg.on("dialog", lambda d: d.accept())
    # 1) manifest as Chromium itself parses it
    pg.goto("http://127.0.0.1:8001/index.html", wait_until="domcontentloaded", timeout=60000); pg.wait_for_timeout(1200)
    cdp=ctx.new_cdp_session(pg); am=cdp.send("Page.getAppManifest")
    import json; man=json.loads(am.get("data") or "{}")
    errs=[e for e in am.get("errors",[]) if e.get("critical") or "file_handler" in e.get("message","")]
    check("Chromium parsed the manifest without file-handler errors", not errs, errs[:2] or am.get("errors",[])[:1])
    fh=man.get("file_handlers",[])
    check("file_handlers present with .rs and 4 icons", bool(fh) and ".rs" in json.dumps(fh) and len(fh[0].get("icons",[]))==4, json.dumps(fh)[:100])
    imgs=pg.evaluate("""async (srcs)=>{const r=[];for(const s of srcs){const x=await fetch(s);r.push(s.split('/').pop()+':'+x.status+':'+(x.headers.get('content-type')||''))}return r}""",[i["src"] for i in fh[0]["icons"]] if fh else [])
    check("all file icons are served as images", all(":200:image/png" in s for s in imgs), imgs)
    # 2) simulate the OS handing a .rs file to the installed app (launchQueue)
    pg2=ctx.new_page(); pg2.on("dialog", lambda d: d.accept())
    pg2.add_init_script("Object.defineProperty(window, 'launchQueue', { value: { setConsumer(fn) { window.__lq = fn; } }, configurable: true });")
    pg2.goto("http://127.0.0.1:8001/project/editor/index.html", wait_until="domcontentloaded", timeout=60000)
    pg2.wait_for_selector("[data-action=toggle-play]", timeout=60000); pg2.wait_for_timeout(2500)
    check("editor registered a launchQueue consumer", pg2.evaluate("typeof window.__lq") == "function")
    pg2.evaluate("""(b64)=>{ const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
      const file=new File([u],'opened-from-os.rs',{type:'application/x-realot-project'});
      window.__lq({files:[{getFile: async()=>file}]}); }""", data)
    done=False
    for _ in range(40):
        pg2.wait_for_timeout(500)
        done = pg2.evaluate("async()=>{const ss=await import('/project/editor/scripting/ScriptStorage.js'); return ss.getAllScripts().some(n=>ss.getScriptSource(n).includes('STORAGE-B'));}")
        if done: break
    check("opening a .rs from the OS loaded the project", done)
    log = pg2.evaluate("async()=>{const st=await import('/project/editor/state/EditorState.js'); return (st.editorState.logs||[]).map(l=>l.msg||'').slice(-6)}")
    check("no 'replace everything' prompt blocked it and no load error", not any('Failed to load' in l for l in log), log[-2:])
    b.close()
print("SUMMARY: %d/%d"%(sum(ok),len(ok))); sys.exit(0 if all(ok) else 1)
