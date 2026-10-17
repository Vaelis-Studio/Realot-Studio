"""
End-to-end test of time.scale in a real browser: script API (rejects bad values, wait() follows game time,
scale 0 freeze, unscaledDeltaTime), physics pace, scene-restart persistence, Monaco autocomplete and highlighting.
Editor served on http://127.0.0.1:8001 with the Monaco bundle present. The headless browser is slow, so timing
checks are relative, not wall-clock.
"""
import sys, json
from playwright.sync_api import sync_playwright
BASE="http://127.0.0.1:8001"; res=[]
def check(n,c,x=""):
    res.append(bool(c)); print(("PASS " if c else "FAIL ")+n+(("  -> "+str(x)[:150]) if x!="" else ""))

SCRIPT_TEST = """
var r0 = 0, frames = 0, dtSum = 0, udtSum = 0, phase = 0, gs = 0, us = 0;
function onStart() {
  r0 = performance.now();
  time.scale = 0.5;
  wait(0.5, function () {
    console.log("T_WAIT gs=" + gs.toFixed(3) + " us=" + us.toFixed(3) + " scale=" + time.scale);
    time.scale = 0; phase = 1; frames = 0; dtSum = 0; udtSum = 0;
  });
  time.scale = -1;       console.log("T_NEG " + time.scale);
  time.scale = "abc";    console.log("T_STR " + time.scale);
  time.scale = NaN;      console.log("T_NAN " + time.scale);
  time.scale = "0.5";    console.log("T_NUMSTR " + time.scale);
  time.scale = 500;      console.log("T_BIG " + time.scale);
  time.scale = 0.5;
}
function onUpdate(dt) {
  if (phase === 0) { gs += time.deltaTime; us += time.unscaledDeltaTime; }
  if (phase === 1) {
    frames++; dtSum += time.deltaTime; udtSum += time.unscaledDeltaTime;
    if (frames === 30) {
      console.log("T_FREEZE frames=" + frames + " dtSum=" + dtSum + " udtSum_gt0=" + (udtSum > 0.2) + " elapsed_stopped=" + (time.scale === 0));
      time.scale = 1; phase = 2;
      console.log("T_DONE");
    }
  }
}
"""
SCRIPT_NOOP = "function onStart() {}\n"

def logs(ed):
    return ed.evaluate("async()=>{const st=await import('/project/editor/state/EditorState.js'); return (st.editorState.logs||[]).map(l=>String(l.msg||''))}")

with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1500,"height":950}, service_workers="block")
    pg=ctx.new_page(); pg.goto(BASE+"/index.html", wait_until="domcontentloaded", timeout=60000); pg.wait_for_timeout(1500)
    pg.click("text=New project"); pg.wait_for_timeout(500); pg.click('.template-card:has-text("Physics")'); pg.wait_for_timeout(300)
    pg.click("text=Initialize workspace"); pg.wait_for_timeout(5000)
    ed=ctx.pages[-1]; errs=[]; ed.on("pageerror", lambda e: errs.append(str(e)[:150]))
    ed.wait_for_selector("[data-action=toggle-play]", timeout=60000); ed.wait_for_timeout(2500)
    X = ed.evaluate("async()=>{const st=await import('/project/editor/state/EditorState.js'); for(const e of st.editorState.game.world.getAllEntities()){const c=e.getComponent('Script'); if(c&&c.scriptName) return c.scriptName;} return null}")
    print("script under test:", X)
    def setscript(code): ed.evaluate("async([n,c])=>(await import('/project/editor/scripting/ScriptStorage.js')).saveScript(n,c)", [X, code])
    def start_play():
        for _ in range(3):
            try:
                with ed.expect_popup(timeout=8000) as pop: ed.evaluate("document.querySelector('[data-action=toggle-play]').click()")
                pl=pop.value; pl.wait_for_function("() => !!window.__realotGame", timeout=30000); return pl
            except Exception: ed.wait_for_timeout(1000)
        raise RuntimeError("could not start play")
    # ---------- Play #1: script-side API ----------
    setscript(SCRIPT_TEST); play=start_play()
    for _ in range(60):
        ed.wait_for_timeout(500)
        L=logs(ed)
        if any("T_DONE" in l for l in L): break
    L=[l for l in logs(ed) if l.startswith("T_")]
    def get(k): return next((l for l in L if l.startswith(k)), "")
    check("negative value rejected (stays at 0.5)", "T_NEG 0.5" in L, get("T_NEG"))
    check("string 'abc' rejected", "T_STR 0.5" in L, get("T_STR"))
    check("NaN rejected", "T_NAN 0.5" in L, get("T_NAN"))
    check("numeric string '0.5' accepted", "T_NUMSTR 0.5" in L, get("T_NUMSTR"))
    check("values above 100 clamp to 100", "T_BIG 100" in L, get("T_BIG"))
    w=get("T_WAIT"); gs=float(w.split("gs=")[1].split()[0]) if "gs=" in w else -1; us=float(w.split("us=")[1].split()[0]) if "us=" in w else -1
    check("wait(0.5) fires after 0.5 GAME seconds (one frame of slack)", 0.5<=gs<=0.5+0.12, w)
    check("...which took ~2x as much real (unscaled) time at scale 0.5", us>0 and 1.6<us/gs<2.4, f"game {gs:.3f}s / unscaled {us:.3f}s")
    fz=get("T_FREEZE")
    check("scale 0: deltaTime stays 0 while onUpdate keeps running", "frames=30" in fz and "dtSum=0 " in fz+" ", fz)
    check("scale 0: unscaledDeltaTime keeps advancing (menus can animate)", "udtSum_gt0=true" in fz, fz)
    check("game recovered to scale 1 and kept running", any("T_DONE" in l for l in L))
    play.close(); ed.wait_for_timeout(1500)
    # ---------- Play #2: physics follows scaled game time ----------
    setscript(SCRIPT_NOOP); play=start_play(); play.wait_for_timeout(3000)
    out=play.evaluate("""async () => {
      const g = window.__realotGame, api = g.scriptApi, sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
      const pw = g.world.systems.find(x => x.physicsWorld).physicsWorld;
      let steps = 0; const orig = pw._stepOnce.bind(pw); pw._stepOnce = function () { steps++; return orig.apply(null, arguments); };
      const snap = () => JSON.stringify(g.world.getAllEntities().filter(e=>e.getComponent('Rigidbody2D')).map(e=>e.getComponent('Transform').y));
      const res = {};
      for (const s of [1, 0.5, 2, 4, 8]) {
        api.time.scale = 0; await sleep(300); steps = 0;
        const e0 = api.time.elapsed, r0 = performance.now(); api.time.scale = s;
        while (api.time.elapsed - e0 < 0.5) { await sleep(5); if (performance.now() - r0 > 15000) break; }
        const gameSec = api.time.elapsed - e0, realSec = (performance.now() - r0) / 1000; api.time.scale = 0; await sleep(100);
        res[s] = { simSec: steps / 60, gameSec, realPerGame: realSec / gameSec };
      }
      api.time.scale = 0; const f0 = snap(), t0 = api.time.elapsed; steps = 0; await sleep(1000);
      res.freeze = { still: f0 === snap(), elapsedSame: t0 === api.time.elapsed, steps };
      api._restartFn(); await sleep(300); res.persists = api.time.scale;
      return res; }""")
    print(json.dumps(out)[:700])
    # This headless browser is frame-starved (<10 FPS), where physics' pre-existing stall clamp applies even at
    # scale 1, so absolute equality is checked in the Node unit test instead. Here: physics must keep the SAME
    # fraction of game time at every speed (the old clamp made that fraction collapse as the scale grew).
    frac=lambda k: out[k]["simSec"]/out[k]["gameSec"]
    for k in ["0.5","2","4","8"]:
        check(f"physics keeps pace at scale {k}: {frac(k):.2f} of game time vs {frac('1'):.2f} at scale 1", frac(k) >= 0.8*frac("1"))
    rp=lambda k: out[k]["realPerGame"]
    check("scale 0.5 is slow motion: ~2x the real time per game second", 1.6 < rp("0.5")/rp("1") < 2.4, f"{rp('0.5')/rp('1'):.2f}x")
    check("scale 2 is fast-forward: ~1/2 the real time per game second", 0.35 < rp("2")/rp("1") < 0.65, f"{rp('2')/rp('1'):.2f}x")
    check("scale 4 faster still", rp("4") < rp("2"), f"{rp('4')/rp('1'):.2f}x")
    check("scale 0: physics performs NO steps, bodies still, game time stops", out["freeze"]["still"] and out["freeze"]["elapsedSame"] and out["freeze"]["steps"]==0, out["freeze"])
    check("time.scale persists across a scene restart (Unity-like)", out["persists"]==0, out["persists"])
    play.close(); ed.wait_for_timeout(800)
    # ---------- Monaco: autocomplete + highlighting ----------
    ed.evaluate("""async()=>{const st=await import('/project/editor/state/EditorState.js'); const ents=st.editorState.game.world.getAllEntities();}""")
    n=ed.evaluate("document.querySelectorAll('[data-action=\"select-entity\"]').length"); opened=False
    for i in range(n):
        ed.evaluate("(i)=>document.querySelectorAll('[data-action=\"select-entity\"]')[i]?.click()", i); ed.wait_for_timeout(400)
        if ed.evaluate("!!document.querySelector('[data-action=\"open-script-editor\"]')"): ed.evaluate("document.querySelector('[data-action=\"open-script-editor\"]').click()"); opened=True; break
    check("opened the script editor", opened)
    ed.wait_for_selector(".monaco-editor", timeout=60000); ed.wait_for_timeout(2500)
    ed.evaluate("""()=>{const e=window.monaco.editor.getEditors()[0]; e.focus(); e.setValue('function onUpdate() {\\n  time.'); const m=e.getModel(); const l=m.getLineCount(); e.setPosition({lineNumber:l,column:m.getLineMaxColumn(l)}); e.trigger('t','editor.action.triggerSuggest',{}); }""")
    ed.wait_for_timeout(1500)
    labels=ed.evaluate("[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(r=>(r.getAttribute('aria-label')||r.innerText).replace(/\\s+/g,' ').trim())")
    check("autocomplete after 'time.' lists scale", any(l.startswith("scale") for l in labels), labels[:6])
    check("autocomplete lists unscaledDeltaTime, deltaTime and elapsed too", all(any(l.startswith(k) for l in labels) for k in ["unscaledDeltaTime","deltaTime","elapsed"]), labels[:6])
    docs=ed.evaluate("""()=>{const e=window.monaco.editor.getEditors()[0]; e.setValue('function onUpdate() {\\n  time.sc'); const m=e.getModel(); const l=m.getLineCount(); e.setPosition({lineNumber:l,column:m.getLineMaxColumn(l)}); e.trigger('t','editor.action.triggerSuggest',{}); return 1}""")
    ed.wait_for_timeout(1200)
    narrowed=ed.evaluate("[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(r=>(r.getAttribute('aria-label')||r.innerText).replace(/\\s+/g,' ').trim())")
    check("typing 'time.sc' narrows to scale", len(narrowed)>=1 and narrowed[0].startswith("scale"), narrowed[:3])
    detail=ed.evaluate("()=>{const r=document.querySelector('.suggest-widget .monaco-list-row'); return r? r.innerText : ''}")
    ed.evaluate("()=>{const e=window.monaco.editor.getEditors()[0]; e.trigger('t','acceptSelectedSuggestion',{});}"); ed.wait_for_timeout(500)
    inserted=ed.evaluate("()=>window.monaco.editor.getEditors()[0].getValue()")
    check("accepting the suggestion inserts time.scale", inserted.rstrip().endswith("time.scale"), inserted[-30:])
    ed.evaluate("""()=>{const e=window.monaco.editor.getEditors()[0]; e.setValue('function onUpdate() {\\n  time.scale = 0.5;\\n  var d = time.unscaledDeltaTime + time.deltaTime;\\n  var scale = 3; var elapsed = 1;\\n}');}""")
    ed.wait_for_timeout(2500)
    deco=ed.evaluate("""()=>{const e=window.monaco.editor.getEditors()[0]; const m=e.getModel(); return m.getAllDecorations().filter(d=>d.options.inlineClassName||d.options.className).map(d=>[m.getValueInRange(d.range), d.options.inlineClassName||d.options.className, d.range.startLineNumber])}""")
    colored=[(t,l) for t,c,l in deco]
    check("highlighting colors 'time' and 'scale' in time.scale", ("time",2) in colored and ("scale",2) in colored, colored[:8])
    check("highlighting colors unscaledDeltaTime", any(t=="unscaledDeltaTime" for t,_ in colored))
    cls_api=[c for t,c,l in deco if t=="scale" and l==2]; cls_var=[c for t,c,l in deco if t=="scale" and l==4]
    print("scale class on time.scale:", cls_api, "| on `var scale`:", cls_var)
    check("`var scale` is not colored as an engine API member", not cls_var or cls_var!=cls_api, (cls_api, cls_var))
    check("no page errors during the whole run", not errs, errs[:3])
    b.close()
print(f"\nSUMMARY: {sum(res)}/{len(res)} passed"); sys.exit(0 if all(res) else 1)
