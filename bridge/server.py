"""Web bridge: serves the simulator page, streams Pulse sessions over WebSocket, proxies Claude."""
import asyncio
import hashlib
import hmac
import json
import os
import time

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from engine import SimSession
from cases import CASES

WEB = os.environ.get("WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web"))
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "6"))
MODELS = {"quick": "claude-haiku-5-5", "default": "claude-sonnet-5-5", "complex": "claude-opus-5-5"}
SECRET = hashlib.sha256((ACCESS_CODE + API_KEY + "pulse-sim").encode()).hexdigest()

app = FastAPI()
active = {"n": 0}


def _token():
    return hmac.new(SECRET.encode(), b"ok", hashlib.sha256).hexdigest()


def authed(req_cookies) -> bool:
    return not ACCESS_CODE or req_cookies.get("sim_auth") == _token()


LOGIN = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>ICU ECMO Sim</title><style>body{background:#0c1317;color:#d8e3e6;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{display:flex;flex-direction:column;gap:10px;width:min(320px,90vw)}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #24343c;background:#172329;color:#d8e3e6}
button{background:#5fb3c9;color:#062029;font-weight:600}</style>
<form method=post action=/login><h2>ICU ECMO Sim</h2><input name=code type=password placeholder="Access code / كود الدخول" autofocus><button>Enter</button>%s</form>"""


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not authed(request.cookies):
        return HTMLResponse(LOGIN % "")
    return FileResponse(os.path.join(WEB, "index.html"))


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    if ACCESS_CODE and hmac.compare_digest(str(form.get("code", "")), ACCESS_CODE):
        r = Response(status_code=303, headers={"Location": "/"})
        r.set_cookie("sim_auth", _token(), max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax")
        return r
    return HTMLResponse(LOGIN % "<p style='color:#f87171'>Wrong code</p>", status_code=401)


@app.get("/api/info")
async def info(request: Request):
    if not authed(request.cookies):
        return JSONResponse({"error": "auth"}, 401)
    return {"ai": bool(API_KEY), "sessions": active["n"], "max": MAX_SESSIONS}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    if not authed(websocket.cookies):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    if active["n"] >= MAX_SESSIONS:
        await websocket.send_json({"type": "error", "msg": "Server busy: too many simulations running. Try again shortly."})
        await websocket.close()
        return
    active["n"] += 1
    sess, case, th = None, None, None
    loop = asyncio.get_running_loop()

    async def start(case_id, speed=1.0):
        nonlocal sess, case, th
        if sess:
            sess.stop()
        cls = CASES.get(case_id, CASES["free"])
        await websocket.send_json({"type": "loading", "case": case_id})
        def build():
            s = SimSession(cls.state, speed=speed)
            c = cls(s)
            c.setup()
            # apply setup actions and settle 10 s quickly
            s._send_vent()
            while not s.actions.empty():
                s._apply(s.actions.get_nowait())
            s.advance(10)
            s.t = 0.0
            return s, c
        sess, case = await loop.run_in_executor(None, build)
        th = sess.start()
        await websocket.send_json({"type": "started", "case": case_id, "sandbox": cls.sandbox, "hidden": None})

    async def pump_frames():
        last_tick = 0.0
        while True:
            await asyncio.sleep(0.1)
            if not sess:
                continue
            if case and sess.t - last_tick >= 0.25:
                last_tick = sess.t
                try:
                    case.tick()
                except Exception as ex:
                    sess.events.append(("error", f"case: {ex}"))
            while not sess.frames.empty():
                f = sess.frames.get_nowait()
                f["type"] = "frame"
                f["case"] = {"flags": {k: v for k, v in case.flags.items() if isinstance(v, (int, float, bool, str))}} if case else {}
                await websocket.send_text(json.dumps(f, separators=(",", ":")))

    sender = asyncio.create_task(pump_frames())
    try:
        while True:
            msg = await websocket.receive_json()
            t = msg.get("type")
            if t == "start":
                await start(msg.get("case", "free"), float(msg.get("speed", 1)))
            elif t == "proc" and case:
                case.procedure(msg.get("name"))
            elif t == "finding" and case:
                await websocket.send_json({"type": "finding", "kind": msg.get("kind"), "text": case.finding(msg.get("kind"))})
            elif t == "reveal" and case:
                await websocket.send_json({"type": "reveal", "hidden": case.hidden})
            elif t == "action" and sess:
                sess.act(msg.get("action", {}))
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        if sess:
            sess.stop()
        active["n"] -= 1


@app.post("/api/ai")
async def ai(request: Request):
    if not authed(request.cookies):
        return JSONResponse({"error": "auth"}, 401)
    if not API_KEY:
        return JSONResponse({"error": "no_key"}, 503)
    body = await request.json()
    tier = body.get("tier", "default")
    model = MODELS.get(tier, MODELS["default"])
    messages = body.get("messages")
    if not messages:
        messages = [{"role": "user", "content": str(body.get("prompt", ""))[:200000]}]
    max_tokens = 4000 if tier == "complex" else 1500 if tier == "default" else 600
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=API_KEY)

    async def gen():
        try:
            async with client.messages.stream(model=model, max_tokens=max_tokens, messages=messages) as stream:
                async for text in stream.text_stream:
                    yield text
        except Exception as ex:
            yield f"\n[Claude error: {type(ex).__name__}]"
    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


app.mount("/static", StaticFiles(directory=WEB), name="static")
