(function () {
"use strict";
const $ = id => document.getElementById(id);
const fmtT = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isAr = s => /[؀-ۿ]/.test(s);
const num = (x, d = 0) => (x == null || !isFinite(x) ? "--" : Number(x).toFixed(d));

let lang = "ar"; try { lang = localStorage.getItem("physio.lang") || "ar"; } catch (e) {}
$("aiLang").value = lang;
$("aiLang").onchange = () => { lang = $("aiLang").value; try { localStorage.setItem("physio.lang", lang); } catch (e) {} };

// ---------- state ----------
let ws = null, caseKey = "free", def = CASES.free, V = null, ended = false, running = true, speed = 1;
let C = null; // per-case page state
let aiOn = false;
function newCaseState() {
  return { A: {}, F: {}, log: [], trends: [], abg: null, chatTurns: [], objs: (def.objectives || []).filter(Boolean).map(o => ({ ...o, met: null, fired: null, hold: o.hold || 0, acc: 0, na: false, late: false })), hidden: null };
}

// ---------- socket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { $("conn").textContent = "Pulse connected"; startCase(caseKey); };
  ws.onclose = e => { $("conn").textContent = e.code === 4401 ? "login needed" : "disconnected — retrying"; if (e.code === 4401) location.reload(); else setTimeout(connect, 2000); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "frame") onFrame(m);
    else if (m.type === "loading") { $("conn").textContent = "loading patient…"; }
    else if (m.type === "started") { $("conn").textContent = "Pulse 4.4 running"; }
    else if (m.type === "finding") finding(m.kind === "echo" ? "Echo" : m.kind === "circuit" ? "Circuit" : "Exam", m.text);
    else if (m.type === "reveal") { C.hidden = m.hidden; showReveal(); }
    else if (m.type === "error") { $("conn").textContent = m.msg; }
  };
}
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const action = a => send({ type: "action", action: a });

// ---------- helpers ----------
function log(msg) {
  const el = $("log"), d = document.createElement("div"), a = document.createElement("span"), b = document.createElement("span");
  a.textContent = fmtT(V ? V.t : 0); b.textContent = msg; d.append(a, b); el.prepend(d);
  if (C) C.log.push(fmtT(V ? V.t : 0) + " " + msg);
}
function chatMsg(kind, who, text) {
  const d = document.createElement("div"); d.className = "msg " + kind;
  const w = document.createElement("span"); w.className = "who"; w.textContent = who;
  const t = document.createElement("span"); t.textContent = text; if (isAr(text) && !/[A-Za-z]{12,}/.test(text)) t.dir = "rtl";
  d.append(w, t); $("chat").append(d); $("chat").scrollTop = $("chat").scrollHeight; return t;
}
function teamSay(en, ar) { const txt = lang === "en" ? en : lang === "ar" ? (ar || en) : en + (ar ? "\n" + ar : ""); chatMsg("team", "Team", txt); if (C) C.log.push(fmtT(V ? V.t : 0) + " [team] " + en); }
function finding(title, text) { chatMsg("find", title, text); if (C) C.log.push(fmtT(V ? V.t : 0) + " [" + title + "] " + text); }
function act(code, msg, extra) { C.A[code] = (C.A[code] || 0) + 1; if (extra) for (const k in extra) C.A[k] = (C.A[k] || 0) + extra[k]; log(msg); }

// ---------- case load ----------
function startCase(key) {
  caseKey = key; def = CASES[key]; C = newCaseState(); ended = false; running = true; V = null;
  $("btnPlay").textContent = "Pause"; $("btnPlay").classList.add("on");
  document.querySelectorAll("#chips button").forEach(b => b.classList.toggle("on", b.dataset.k === key));
  $("caseName").textContent = def.title; $("briefEn").textContent = def.brief; $("briefAr").textContent = def.briefAr || "";
  $("log").textContent = ""; $("chat").textContent = ""; $("resultCard").hidden = true; $("debrief").textContent = "";
  $("tabPt").hidden = !def.sandbox;
  if (!def.sandbox && document.querySelector("#ctlTabs button.on")?.dataset.tab === "pt") selectTab("vent");
  pvHist = []; samples = []; clearWaves(); renderObjs();
  chatMsg("team", "Team", lang === "en" ? "Handover: " + def.brief : (def.briefAr || def.brief));
  log("Case loaded: " + def.title);
  send({ type: "start", case: key, speed });
}
for (const k in CASES) { const b = document.createElement("button"); b.dataset.k = k; b.innerHTML = esc(CASES[k].title) + "<small>" + esc(CASES[k].tag) + "</small>"; b.onclick = () => startCase(k); $("chips").append(b); }

// ---------- frames ----------
let firstFrame = true;
function onFrame(m) {
  V = m.v;
  if (m.case && m.case.flags) Object.assign(C.F, m.case.flags);
  for (const e of m.events || []) {
    if (e[0] === "team") teamSay(e[1], e[2]);
    else if (e[0] === "flag" && e[1] === "alarmAt") { C.F.alarmAt = e[2]; C.F.rpmAtAlarm = e[3]; }
    else if (e[0] === "error") log("⚠ " + e[1]);
  }
  for (const w of m.wave || []) addSample(w);
  if (firstFrame) { firstFrame = false; syncSliders(); }
  if (!C.abg && !def.sandbox && V.pao2 != null) C.abg = snapshotAbg();
  evalObjectives();
  if (!C.F.lastTrend || V.t - C.F.lastTrend >= 5) { C.F.lastTrend = V.t; C.trends.push({ t: V.t, map: V.map, hr: V.hr, spo2: (V.spo2 || 0) * 100, lac: V.lac_mmol, co: V.co, flow: V.ecmo.on ? V.ecmo.flow : 0, pven: V.ecmo.on ? V.ecmo.pven : null }); if (C.trends.length > 800) C.trends.shift(); }
  if (def.duration && V.t >= def.duration) endCase("Time is up");
}

// ---------- sliders ----------
let ventMode = "VC";
const SL = [
  ["sPeep", "oPeep", v => v + " cmH₂O", v => ({ type: "vent", peep: v }), () => V.vent.peep, "PEEP"],
  ["sFio2", "oFio2", v => Math.round(v * 100) + "%", v => ({ type: "vent", fio2: v }), () => V.vent.fio2, "FiO₂"],
  ["sVt", "oVt", v => v + " ml", v => ({ type: "vent", vt: v }), () => V.vent.vt, "Vt"],
  ["sPinsp", "oPinsp", v => v + " cmH₂O", v => ({ type: "vent", pinsp: v }), () => V.vent.pinsp, "P insp"],
  ["sRr", "oRr", v => v + " /min", v => ({ type: "vent", rr: v }), () => V.vent.rr, "RR"],
  ["sNe", "oNe", v => v.toFixed(2), v => ({ type: "drug", drug: "ne", dose: v }), () => V.drugs.ne, "Norepinephrine"],
  ["sEpi", "oEpi", v => v.toFixed(2), v => ({ type: "drug", drug: "epi", dose: v }), () => V.drugs.epi, "Epinephrine"],
  ["sPhenyl", "oPhenyl", v => v.toFixed(1), v => ({ type: "drug", drug: "phenyl", dose: v }), () => V.drugs.phenyl, "Phenylephrine"],
  ["sVaso", "oVaso", v => v.toFixed(2) + " U", v => ({ type: "drug", drug: "vaso", dose: v }), () => V.drugs.vaso, "Vasopressin"],
  ["sRpm", "oRpm", v => v + "", v => { if (V.ecmo.on && v > V.ecmo.rpm && V.ecmo.collapse > 0.6) C.F.rpmUpDuringSuck = true; if (V.ecmo.on && C.F.alarmAt && v < V.ecmo.rpm && !C.F.rpmDownAt) C.F.rpmDownAt = V.t; return { type: "ecmo", rpm: v }; }, () => V.ecmo.rpm, "ECMO RPM"],
  ["sSweep", "oSweep", v => v.toFixed(1) + " L", v => ({ type: "ecmo", sweep: v }), () => V.ecmo.sweep, "Sweep"],
  ["sFdo2", "oFdo2", v => Math.round(v * 100) + "%", v => ({ type: "ecmo", fdo2: v }), () => V.ecmo.fdo2, "FdO₂"],
  ["sBleed", "oBleed", v => v + " ml/min", v => ({ type: "hemorrhage", compartment: "Splanchnic", rate: v }), () => 0, "Bleeding"],
  ["sSvMul", "oSvMul", v => "×" + v.toFixed(2), v => ({ type: "cvmod", sv: v }), () => 1, "Stroke volume"],
  ["sSvrMul", "oSvrMul", v => "×" + v.toFixed(2), v => ({ type: "cvmod", svr: v }), () => 1, "SVR"],
  ["sArds", "oArds", v => Math.round(v * 100) + "%", v => ({ type: "ards", severity: v }), () => 0, "ARDS severity"],
  ["sEff", "oEff", v => v + " ml/min", v => ({ type: "effusion", rate: v }), () => 0, "Effusion"],
];
SL.forEach(([id, oid, f, mk, get, name]) => {
  const el = $(id);
  el.addEventListener("input", () => { $(oid).textContent = f(parseFloat(el.value)); });
  el.addEventListener("change", () => { const v = parseFloat(el.value); if (!V) return; action(mk(v)); log(name + " → " + f(v)); });
});
function syncSliders() { if (!V) return; SL.forEach(([id, oid, f, mk, get]) => { const v = get(); if (v == null) return; $(id).value = v; $(oid).textContent = f(v); }); setVentMode(V.vent.mode || "VC", false); syncEcmoUi(); }
function setVentMode(m, sendIt) { ventMode = m; document.querySelectorAll("[data-vmode]").forEach(b => b.classList.toggle("on", b.dataset.vmode === m)); $("rowVt").hidden = m !== "VC"; $("rowPinsp").hidden = m !== "PC"; if (sendIt) { action({ type: "vent", mode: m }); log("Ventilator mode → " + m); } }
document.querySelectorAll("[data-vmode]").forEach(b => b.onclick = () => setVentMode(b.dataset.vmode, true));
function syncEcmoUi() {
  const on = V && V.ecmo.on, pend = !!C.F.cannulating;
  $("ecmoConsole").hidden = !on;
  $("bCanVV").disabled = on || pend; $("bCanVA").disabled = on || pend;
  ["sRpm", "sSweep", "sFdo2", "bRepos", "bStopEcmo"].forEach(id => $(id).disabled = !on);
  if (V) $("ecmoMode").textContent = V.ecmo.mode + " ECMO";
}

// ---------- tabs / toolbar ----------
function selectTab(t) { document.querySelectorAll("#ctlTabs button").forEach(x => x.classList.toggle("on", x.dataset.tab === t)); document.querySelectorAll("[data-pane]").forEach(p => p.hidden = p.dataset.pane !== t); }
document.querySelectorAll("#ctlTabs button").forEach(b => b.onclick = () => selectTab(b.dataset.tab));
let plotMode = "pv";
document.querySelectorAll("#plotTabs button").forEach(b => b.onclick = () => { plotMode = b.dataset.plot; document.querySelectorAll("#plotTabs button").forEach(x => x.classList.toggle("on", x === b)); $("plotHint").textContent = plotMode === "pv" ? "LV pressure–volume loop from Pulse, last 5 beats." : "MAP (red), HR (green), SpO₂ (cyan, right scale), ECMO flow ×20 (orange). Every 5 s of sim time."; drawPlot(); });
$("btnPlay").onclick = () => { if (ended) return; running = !running; action({ type: "pause", value: !running }); $("btnPlay").textContent = running ? "Pause" : "Resume"; $("btnPlay").classList.toggle("on", running); };
document.querySelectorAll("[data-speed]").forEach(b => b.onclick = () => { speed = +b.dataset.speed; action({ type: "speed", value: speed }); document.querySelectorAll("[data-speed]").forEach(x => x.classList.toggle("on", x === b)); sweepSec = 6 * speed; clearWaves(); });
$("btnReset").onclick = () => startCase(caseKey);
$("btnEnd").onclick = () => endCase("Ended by user");

// ---------- interventions ----------
$("bFluid").onclick = () => { action({ type: "fluid", compound: "Saline", ml: 500, rate: 250 }); act("fluid", "Saline 500 ml over 2 min", { crystalloidMl: 500 }); };
$("bRl").onclick = () => { action({ type: "fluid", compound: "PlasmaLyte", ml: 500, rate: 250 }); act("fluid", "Plasma-Lyte 500 ml over 2 min", { crystalloidMl: 500 }); };
$("bPrbc").onclick = () => { action({ type: "fluid", compound: "PackedRBC", ml: 300, rate: 100 }); act("prbc", "PRBC 1 unit (300 ml) over 3 min", { prbcMl: 300 }); };
$("bAbx").onclick = () => { send({ type: "proc", name: "abx" }); act("abx", "Broad-spectrum antibiotics given"); };
$("bSource").onclick = () => { send({ type: "proc", name: "source" }); act("source", "Source / bleeding control requested"); };
$("bNeedle").onclick = () => { send({ type: "proc", name: "needle" }); act("needle", "Needle decompression"); };
$("bPeri").onclick = () => { send({ type: "proc", name: "peri" }); act("peri", "Pericardiocentesis"); };
let cprOn = false;
$("bCpr").onclick = () => { cprOn = !cprOn; action({ type: "cpr", on: cprOn }); $("bCpr").textContent = cprOn ? "Stop CPR" : "Start CPR"; act("cpr", cprOn ? "CPR started (automated 110/min)" : "CPR stopped"); };
$("bShock").onclick = () => { action({ type: "rhythm", rhythm: "NormalSinus" }); act("shock", "Defibrillation 200 J"); };
$("bTension").onclick = () => { action({ type: "tension", severity: 0.6, side: "Right" }); C.F.tension = true; log("Right tension pneumothorax started"); };
$("selRhythm").onchange = () => { const r = $("selRhythm").value; if (r) { action({ type: "rhythm", rhythm: r }); log("Rhythm → " + r); } $("selRhythm").value = ""; };
$("bCanVV").onclick = () => { send({ type: "proc", name: "cannulate_vv" }); C.F.cannulating = true; act("cannulateVV", "VV cannulation started"); syncEcmoUi(); setTimeout(() => { C.F.cannulating = false; }, 95000 / speed); };
$("bCanVA").onclick = () => { send({ type: "proc", name: "cannulate_va" }); C.F.cannulating = true; act("cannulateVA", "VA cannulation started"); syncEcmoUi(); setTimeout(() => { C.F.cannulating = false; }, 95000 / speed); };
$("bRepos").onclick = () => { send({ type: "proc", name: "repos" }); act("repos", "Echo-guided repositioning of drainage cannula"); };
$("bStopEcmo").onclick = () => { action({ type: "ecmo_stop" }); C.F.ecmoStopped = (caseKey === "st3" || caseKey === "ards"); act("ecmoOff", "ECMO stopped"); };
$("bEcho").onclick = () => { send({ type: "finding", kind: "echo" }); act("echo", "Bedside echo"); };
$("bCircuit").onclick = () => { send({ type: "finding", kind: "circuit" }); act("circuit", "Circuit and cannula inspected"); };
$("bExam").onclick = () => { send({ type: "finding", kind: "exam" }); act("exam", "Patient examined"); };
$("bAbg").onclick = () => { act("abg", "ABG sent"); C.abg = snapshotAbg(); updateNums(); };
function snapshotAbg() { return { t: V.t, ph: V.ph, pao2: V.pao2, paco2: V.paco2, hco3: V.hco3_mmol, lac: V.lac_mmol, hb: V.hb, pf: V.pao2 / V.vent.fio2 }; }

// ---------- objectives ----------
function evalObjectives() {
  if (!C || ended || !V) return;
  const dt = C._lastEval != null ? Math.max(0, V.t - C._lastEval) : 0; C._lastEval = V.t;
  const ctx = { V, A: C.A, F: C.F, t: V.t };
  let changed = false;
  for (const o of C.objs) {
    let r; try { r = o.test(ctx); } catch (e) { r = false; }
    const na = r === "na"; if (na !== o.na) { o.na = na; changed = true; } if (na) continue;
    o.acc = r ? o.acc + dt : 0;
    if (r && o.acc >= o.hold) {
      if (o.pitfall && o.fired == null) { o.fired = V.t; changed = true; log("Pitfall: " + o.en); }
      if (!o.pitfall && o.met == null) { o.met = V.t; o.late = o.deadline != null && V.t > o.deadline; changed = true; log("Objective met: " + o.en); }
    }
  }
  if (changed) renderObjs();
}
function scoreOf() { let max = 0, got = 0; for (const o of C.objs) { if (o.pitfall) { if (o.fired != null) got -= o.w; continue; } if (o.na) continue; max += o.w; if (o.met != null) got += o.late ? o.w / 2 : o.w; } return { max, got: Math.max(0, got), pct: max ? Math.round(Math.max(0, got) / max * 100) : 0 }; }
function renderObjs() {
  const ul = $("objs"); ul.textContent = "";
  for (const o of C.objs) {
    const li = document.createElement("li");
    li.className = (o.pitfall ? "pit " : "") + (o.na ? "na " : "") + (o.fired != null ? "fired" : o.met != null ? (o.late ? "late" : "met") : "");
    const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = o.fired != null ? "!" : o.met != null ? "✓" : "";
    const tx = document.createElement("span"); tx.textContent = (o.pitfall ? "Avoid: " : "") + o.en + (o.deadline ? " (by " + fmtT(o.deadline) + ")" : "");
    const ar = document.createElement("span"); ar.className = "ar"; ar.textContent = o.ar || ""; tx.append(ar);
    const wh = document.createElement("span"); wh.className = "when"; wh.textContent = o.fired != null ? "−" + o.w + " · " + fmtT(o.fired) : o.met != null ? fmtT(o.met) : (o.pitfall ? "" : o.w + " pts");
    li.append(ic, tx, wh); ul.append(li);
  }
  if (!C.objs.length) { const li = document.createElement("li"); li.innerHTML = '<span></span><span class="hint">No objectives in free play. Pick a case above, or create one with Claude below.</span><span></span>'; ul.append(li); }
}
function endCase(reason) {
  if (ended) return; if (def.sandbox && reason !== "Ended by user") return;
  ended = true; running = false; action({ type: "pause", value: true });
  $("btnPlay").textContent = "Ended"; $("btnPlay").classList.remove("on");
  log("Case ended: " + reason);
  const sc = scoreOf(); $("resultCard").hidden = false; $("scoreBig").textContent = C.objs.length ? sc.pct + "%" : "—";
  send({ type: "reveal" });
  $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}
function showReveal() { if (C.hidden) $("debrief").innerHTML = "<p><b>Hidden cause:</b> " + (C.hidden === "hypo" ? "hypovolaemia from bleeding at the drainage cannula site" : "drainage cannula malposition") + "</p>" + $("debrief").innerHTML; }

// ---------- waveforms ----------
const wc = $("waveCanvas"), wx = wc.getContext("2d");
let W = 0, H = 0, sweepSec = 6, lastPts = null, samples = [], artDelay = [];
let pvBuf = [], pvHist = [], lastEcgPeak = 0, prevEcg = 0;
function sizeWaves() { const r = window.devicePixelRatio || 1; W = wc.clientWidth; H = wc.clientHeight; wc.width = W * r; wc.height = H * r; wx.setTransform(r, 0, 0, r, 0, 0); clearWaves(); }
function clearWaves() { wx.fillStyle = "#060a0c"; wx.fillRect(0, 0, W, H); lastPts = null; }
function addSample(w) {
  const [t, ecg, abp, paw, cvp, lvV, lvP] = w;
  artDelay.push(abp); if (artDelay.length > 12) artDelay.shift();
  const sys = V ? V.sys : 120, dia = V ? V.dia : 80, pp = Math.max((sys || 0) - (dia || 0), 1);
  const amp = Math.max(0.12, Math.min(1, pp / 45));
  samples.push({ t, ecg: ecg || 0, art: abp || 0, pleth: ((artDelay[0] || 0) - dia) / pp * amp, paw: paw || 0 });
  if (lvV != null && lvP != null) {
    pvBuf.push([lvV, lvP]);
    if (prevEcg < 0.5 && (ecg || 0) >= 0.5 && t - lastEcgPeak > 0.25) { if (pvBuf.length > 10) { pvHist.push(pvBuf); if (pvHist.length > 5) pvHist.shift(); } pvBuf = []; lastEcgPeak = t; }
    if (pvBuf.length > 300) pvBuf = [];
  }
  prevEcg = ecg || 0;
}
function drawWaves() {
  if (!samples.length) return;
  const band = H / 4, pxs = W / sweepSec;
  const map = {
    ecg: v => band * 0.62 - v * band * 0.45,
    art: v => band + band * 0.95 - Math.max(0, Math.min(160, v)) / 160 * band * 0.85,
    pleth: v => 2 * band + band * 0.85 - Math.max(-0.1, Math.min(1.1, v)) * band * 0.6,
    paw: v => 3 * band + band * 0.95 - Math.max(0, Math.min(40, v)) / 40 * band * 0.85,
  };
  const col = { ecg: "#4ade80", art: "#f87171", pleth: "#67e8f9", paw: "#facc15" };
  for (const sp of samples) {
    const x = (sp.t % sweepSec) * pxs;
    if (lastPts && x < lastPts.x) lastPts = null;
    wx.fillStyle = "#060a0c"; wx.fillRect(x, 0, 14, H);
    if (lastPts) { wx.lineWidth = 1.8; wx.lineJoin = "round"; for (const k in col) { wx.strokeStyle = col[k]; wx.beginPath(); wx.moveTo(lastPts.x, map[k](lastPts[k])); wx.lineTo(x, map[k](sp[k])); wx.stroke(); } }
    lastPts = { x, ...sp };
  }
  samples = [];
}

// ---------- plots ----------
const pc = $("plotCanvas"), px = pc.getContext("2d");
function prepPlot() { const w = pc.clientWidth, h = pc.clientHeight, r = window.devicePixelRatio || 1; if (pc.width !== Math.round(w * r) || pc.height !== Math.round(h * r)) { pc.width = Math.round(w * r); pc.height = Math.round(h * r); } px.setTransform(r, 0, 0, r, 0, 0); px.clearRect(0, 0, w, h); px.font = "11px 'IBM Plex Sans', sans-serif"; return [w, h]; }
function grid(X, Y, xs, ys, w, h, L, B, T, R, xl, yl) { px.strokeStyle = "#24343c"; px.fillStyle = "#8aa1a9"; px.lineWidth = 1; xs.forEach(v => { px.beginPath(); px.moveTo(X(v), T); px.lineTo(X(v), h - B); px.stroke(); px.textAlign = "center"; px.fillText(xl(v), X(v), h - B + 15); }); ys.forEach(p => { px.beginPath(); px.moveTo(L, Y(p)); px.lineTo(w - R, Y(p)); px.stroke(); px.textAlign = "right"; px.fillText(yl(p), L - 6, Y(p) + 4); }); }
function drawPlot() {
  if (!V) return;
  const [w, h] = prepPlot();
  if (plotMode === "pv") {
    const L = 40, B = 26, T = 8, R = 10, vmax = 300, pmax = 160;
    const X = v => L + v / vmax * (w - L - R), Y = p => h - B - Math.max(0, Math.min(pmax, p)) / pmax * (h - B - T);
    grid(X, Y, [0, 50, 100, 150, 200, 250, 300], [0, 40, 80, 120, 160], w, h, L, B, T, R, v => v, p => p);
    px.textAlign = "right"; px.fillText("ml", w - R, h - B - 4); px.textAlign = "left"; px.fillText("mmHg", L + 4, T + 10);
    pvHist.forEach((loop, i) => { const last = i === pvHist.length - 1; px.strokeStyle = last ? "#5fb3c9" : "rgba(95,179,201," + (0.12 + i * 0.08) + ")"; px.lineWidth = last ? 2.2 : 1.2; px.beginPath(); loop.forEach(([v, p], j) => j ? px.lineTo(X(v), Y(p)) : px.moveTo(X(v), Y(p))); px.stroke(); });
  } else {
    const L = 34, B = 26, T = 8, R = 34, tr = C.trends, tmax = Math.max(120, tr.length ? tr[tr.length - 1].t : 0);
    const X = t => L + t / tmax * (w - L - R), Y = v => h - B - Math.max(0, Math.min(180, v)) / 180 * (h - B - T), Ys = v => h - B - (Math.max(50, Math.min(100, v)) - 50) / 50 * (h - B - T);
    const step = tmax > 1200 ? 300 : tmax > 480 ? 120 : 60, xs = []; for (let t = 0; t <= tmax; t += step) xs.push(t);
    grid(X, Y, xs, [0, 60, 120, 180], w, h, L, B, T, R, v => fmtT(v), p => p);
    px.textAlign = "left"; px.fillStyle = "#67e8f9"; [50, 75, 100].forEach(s => px.fillText(s + "%", w - R + 4, Ys(s) + 4));
    const line = (f, yf, c) => { px.strokeStyle = c; px.lineWidth = 1.8; px.beginPath(); let st = false; tr.forEach(d => { const v = f(d); if (v == null || !isFinite(v)) { st = false; return; } st ? px.lineTo(X(d.t), yf(v)) : px.moveTo(X(d.t), yf(v)); st = true; }); px.stroke(); };
    line(d => d.map, Y, "#f87171"); line(d => d.hr, Y, "#4ade80"); line(d => d.spo2, Ys, "#67e8f9");
    if (tr.some(d => d.flow > 0)) line(d => d.flow > 0 ? d.flow * 20 : null, Y, "#fb923c");
  }
}

// ---------- numerics ----------
function setV(id, html) { const el = $(id); if (el.innerHTML !== html) el.innerHTML = html; }
function alarm(id, crit, warn) { const el = $(id); el.classList.toggle("alarm", !!crit); el.classList.toggle("alarm-warn", !crit && !!warn); }
function kv(el, rows) { el.innerHTML = rows.map(([k, v, u, cls]) => `<div><span class="label">${k}</span><b class="${cls || ""}">${v}<small> ${u || ""}</small></b></div>`).join(""); }
function updateNums() {
  if (!V) return;
  const sp = (V.spo2 || 0) * 100, E = V.ecmo;
  setV("v-hr", num(V.hr)); alarm("n-hr", V.hr > 140 || V.hr < 45, V.hr > 110);
  setV("v-spo2", num(sp)); alarm("n-spo2", sp < 85, sp < 90);
  setV("v-abp", `${num(V.sys)}/${num(V.dia)} <small>(${num(V.map)})</small>`); alarm("n-abp", V.map < 60, V.map < 65);
  setV("v-cvp", num(V.cvp));
  setV("v-et", `${num(V.etco2)}<small>/${num(V.rr)}</small>`);
  setV("v-co", num(V.co, 1)); alarm("n-co", V.co < 2.2, V.co < 3);
  setV("v-paw", `${num(V.ppeak)}<small>/${num(V.pplat)}</small>`); alarm("n-ppeak", V.pplat > 30, V.pplat > 28);
  if (E.on) {
    setV("e-rpm", num(E.rpm)); setV("e-flow", num(E.flow, 2)); setV("e-pven", num(E.pven)); setV("e-pint", num(V.eInletP)); setV("e-part", num(V.eOutletP));
    setV("e-dp", num((V.eInletP || 0) - (V.eOutletP || 0))); setV("e-sweep", num(E.sweep, 1) + "<small style='font-size:16px'> / " + num(E.fdo2 * 100) + "%</small>");
    setV("e-post", V.eOutSat != null ? num(V.eOutSat * 100) + "<small style='font-size:16px'>% sat</small>" : "--");
    setV("e-spo2", V.eInSat != null ? num(V.eInSat * 100) + "<small style='font-size:16px'>% in</small>" : "--");
    setV("e-frac", num(V.eO2) + "<small style='font-size:16px'> ml O₂</small>"); setV("e-rec", num(V.eCO2) + "<small style='font-size:16px'> ml CO₂</small>"); setV("e-svo2", "—");
    $("ec-pven").classList.toggle("alarm", E.pven < -100); $("ec-flow").classList.toggle("alarm", E.collapse > 0.6);
    $("ecmoChatter").textContent = E.collapse > 0.6 ? "LINE CHATTER" : ""; $("ecmoChatter").className = E.collapse > 0.6 ? "chatter" : "";
  }
  if ($("ecmoConsole").hidden === !!E.on) syncEcmoUi();
  const g = def.sandbox ? snapshotAbg() : C.abg;
  if (g && g.pao2 != null) {
    $("abgAge").textContent = def.sandbox ? "live" : "sent " + fmtT(g.t);
    kv($("abg"), [
      ["pH", num(g.ph, 2), "", g.ph < 7.25 ? "bad" : g.ph < 7.35 || g.ph > 7.48 ? "warn" : ""],
      ["PaO₂", num(g.pao2), "mmHg", g.pao2 < 60 ? "bad" : ""], ["PaCO₂", num(g.paco2), "mmHg", g.paco2 > 55 ? "bad" : g.paco2 > 45 || g.paco2 < 30 ? "warn" : ""],
      ["HCO₃⁻", num(g.hco3, 1), "", g.hco3 < 18 ? "warn" : ""], ["Lactate", num(g.lac, 1), "mmol/L", g.lac > 4 ? "bad" : g.lac > 2 ? "warn" : ""],
      ["P/F", num(g.pf), "", g.pf < 100 ? "bad" : g.pf < 300 ? "warn" : ""], ["Hb", num(g.hb, 1), "g/dL", g.hb < 7 ? "bad" : g.hb < 9 ? "warn" : ""],
      ["Temp", num(V.temp, 1), "°C", V.temp > 38.3 ? "warn" : ""], ["Urine", num(V.urine * 60), "ml/h", V.urine * 60 < 30 ? "warn" : ""],
    ]);
  } else { $("abgAge").textContent = "not sent"; $("abg").innerHTML = '<p class="hint" style="grid-column:1/-1">Press "Send ABG" in Procedures.</p>'; }
  const svr = V.svr != null ? V.svr * 1333 : null;
  kv($("adv"), [
    ["SV", num(V.sv), "ml", V.sv < 40 ? "warn" : ""], ["LVEF", num((V.ef || 0) * 100), "%", V.ef < 0.3 ? "bad" : V.ef < 0.45 ? "warn" : ""], ["PCWP", num(V.pcwp), "mmHg", V.pcwp > 18 ? "warn" : ""],
    ["mPAP", num(V.papm), "mmHg", V.papm > 25 ? "warn" : ""], ["SVR", num(svr), "dyn", svr < 700 ? "warn" : ""], ["Driving P", num((V.pplat || 0) - V.vent.peep), "cmH₂O", (V.pplat - V.vent.peep) > 15 ? "bad" : ""],
    ["Tidal vol", num(V.vt), "ml", ""], ["Blood vol", num(V.bv), "ml", V.bv < 4200 ? "warn" : ""], ["Mode", V.vent.mode, "", ""],
  ]);
  $("clock").textContent = fmtT(V.t);
  $("caseTimer").textContent = def.duration ? "Time left " + fmtT(def.duration - V.t) + (C.objs.length ? " · score " + scoreOf().pct + "%" : "") : "";
}

// ---------- render loop ----------
let numAcc = 0, last = performance.now();
function frame(now) { const real = (now - last) / 1000; last = now; drawWaves(); numAcc += real; if (numAcc > 0.25) { numAcc = 0; updateNums(); drawPlot(); } requestAnimationFrame(frame); }
window.addEventListener("resize", () => { sizeWaves(); drawPlot(); });

// ---------- Claude (server proxy) ----------
fetch("/api/info").then(r => r.json()).then(j => { aiOn = !!j.ai; setAi(aiOn); }).catch(() => setAi(false));
function setAi(on) { $("aiBox").hidden = !on; $("aiOff").hidden = on; $("bDebrief").hidden = !on; $("bGen").disabled = !on; if (!on) $("genStatus").textContent = "Needs an API key on the server."; }
async function claude(input, tier, onText, signal) {
  const body = Array.isArray(input) ? { messages: input, tier } : { prompt: input, tier };
  const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(r.status === 503 ? "No API key on the server." : "Claude request failed (" + r.status + ").");
  const rd = r.body.getReader(), dec = new TextDecoder(); let text = "";
  for (;;) { const { done, value } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); onText && onText(text); }
  return text;
}
const langRule = () => lang === "en" ? "Reply in English." : lang === "ar" ? "Reply in Egyptian Arabic (عامية مصرية), keeping drug names, numbers and medical terms in English." : "Reply in English, then give the same reply in Egyptian Arabic below it.";
function stateSnapshot() {
  const E = V.ecmo, d = V.drugs, v = V.vent;
  return [
    `Sim time ${fmtT(V.t)}. HR ${num(V.hr)}, ABP ${num(V.sys)}/${num(V.dia)} (MAP ${num(V.map)}), CVP ${num(V.cvp)}, SpO2 ${num(V.spo2 * 100)}%, EtCO2 ${num(V.etco2)}, CO ${num(V.co, 1)} L/min, temp ${num(V.temp, 1)}, urine ${num(V.urine * 60)} ml/h.`,
    `Vent: ${v.mode} ${v.mode === "VC" ? "Vt " + v.vt : "Pinsp " + v.pinsp}, RR ${v.rr}, PEEP ${v.peep}, FiO2 ${Math.round(v.fio2 * 100)}%, Ppeak ${num(V.ppeak)}, Pplat ${num(V.pplat)}.`,
    `Drugs: norepinephrine ${d.ne}, epinephrine ${d.epi}, phenylephrine ${d.phenyl} mcg/kg/min, vasopressin ${d.vaso} U/min. Crystalloid given ${C.A.crystalloidMl || 0} ml, PRBC ${C.A.prbcMl || 0} ml.`,
    E.on ? `ECMO ${E.mode}: ${E.rpm} rpm, flow ${num(E.flow, 2)} L/min, Pven ${num(E.pven)}, sweep ${E.sweep} L, FdO2 ${Math.round(E.fdo2 * 100)}%, line chatter ${E.collapse > 0.6 ? "YES" : "no"}.` : "No ECMO.",
    C.abg ? `Last ABG at ${fmtT(C.abg.t)}: pH ${num(C.abg.ph, 2)}, PaO2 ${num(C.abg.pao2)}, PaCO2 ${num(C.abg.paco2)}, lactate ${num(C.abg.lac, 1)}, Hb ${num(C.abg.hb, 1)}.` : "No ABG sent yet.",
  ].join("\n");
}
const caseContext = () => `CASE: ${def.title}. ${def.brief}\nHIDDEN TRUTH (for consistency, do not reveal unless examined): ${def.hiddenNote || "none"}`;
const NURSE_RULES = () => `You role-play the bedside ICU team (nurse, and the ECMO perfusionist when relevant) in a teaching simulation for ICU doctors. The physiology comes from the Pulse engine. Stay in role.
- Answer in 1-3 short sentences, like a competent ICU nurse at the bedside.
- Report only what the team can see or measure from the STATE given each turn. Never invent numbers that conflict with it.
- Do not hand over the diagnosis or tell the doctor what to do. If asked to look at something specific, describe what you see consistently with the HIDDEN TRUTH.
- If the doctor gives an order, acknowledge it and say which tab/button in the simulator does it (Ventilator, Drugs & fluids, ECMO, Procedures), since you cannot press it yourself.
- ${langRule()}`;
let chatCtl = null;
async function askTeam() {
  const q = $("chatIn").value.trim(); if (!q || !aiOn || !V) return;
  $("chatIn").value = ""; chatMsg("me", "You", q); C.log.push(fmtT(V.t) + " [doctor asked team] " + q);
  const bubble = chatMsg("ai", "Nurse", "Thinking…"); bubble.classList.add("thinking");
  const turns = [{ role: "user", content: NURSE_RULES() + "\n\n" + caseContext() }, { role: "assistant", content: "Understood. I'm at the bedside." }, ...C.chatTurns.slice(-8),
    { role: "user", content: `STATE NOW:\n${stateSnapshot()}\nRecent events:\n${C.log.slice(-10).join("\n")}\n\nDoctor: ${q}` }];
  chatCtl = new AbortController(); $("chatStop").hidden = false; $("chatSend").disabled = true;
  try { const text = await claude(turns, "quick", t => { bubble.classList.remove("thinking"); bubble.textContent = t; bubble.dir = isAr(t) && lang !== "en" ? "rtl" : "ltr"; }, chatCtl.signal); C.chatTurns.push({ role: "user", content: "Doctor: " + q }, { role: "assistant", content: text }); }
  catch (e) { bubble.classList.remove("thinking"); if (e.name !== "AbortError") bubble.textContent = e.message; }
  finally { $("chatStop").hidden = true; $("chatSend").disabled = false; }
}
$("chatSend").onclick = askTeam;
$("chatIn").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); askTeam(); } });
$("chatStop").onclick = () => chatCtl && chatCtl.abort();
$("bHint").onclick = async () => {
  if (!aiOn || !V) return; act("hint", "Consultant hint requested");
  const bubble = chatMsg("ai", "Consultant", "Thinking…"); bubble.classList.add("thinking");
  const objs = C.objs.map(o => `${o.pitfall ? "AVOID" : "GOAL"}: ${o.en} — ${o.pitfall ? (o.fired != null ? "happened" : "not happened") : (o.met != null ? "met" : "not yet")}`).join("\n");
  const prompt = `You are a senior intensive care consultant supervising a trainee in an ICU simulation driven by the Pulse physiology engine. Give ONE Socratic hint (max 3 sentences) pointing the trainee to the most important thing they are missing now, using the physiology on the monitor. Do not state the hidden diagnosis outright and do not give a full plan. ${langRule()}\n\n${caseContext()}\n\nSTATE:\n${stateSnapshot()}\n\nOBJECTIVES:\n${objs || "none (free play) — comment on the physiology"}\n\nACTIONS SO FAR:\n${C.log.slice(-25).join("\n")}`;
  chatCtl = new AbortController(); $("chatStop").hidden = false; $("bHint").disabled = true;
  try { await claude(prompt, "default", t => { bubble.classList.remove("thinking"); bubble.textContent = t; bubble.dir = isAr(t) && lang !== "en" ? "rtl" : "ltr"; }, chatCtl.signal); }
  catch (e) { bubble.classList.remove("thinking"); if (e.name !== "AbortError") bubble.textContent = e.message; }
  finally { $("chatStop").hidden = true; $("bHint").disabled = false; }
};
function mdToHtml(md) {
  const out = []; let inList = false;
  for (const raw of md.split(/\n/)) {
    const line = raw.trimEnd(), inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"), dir = isAr(line) ? ' dir="rtl"' : "";
    if (/^\s*[-*•]\s+/.test(line)) { if (!inList) { out.push("<ul" + dir + ">"); inList = true; } out.push("<li" + dir + ">" + inline(line.replace(/^\s*[-*•]\s+/, "")) + "</li>"); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    if (/^#{1,4}\s+/.test(line)) out.push("<h4" + dir + ">" + inline(line.replace(/^#{1,4}\s+/, "")) + "</h4>"); else if (line.trim()) out.push("<p" + dir + ">" + inline(line) + "</p>");
  }
  if (inList) out.push("</ul>"); return out.join("");
}
let debCtl = null;
$("bDebrief").onclick = async () => {
  if (!aiOn) return;
  const sc = scoreOf();
  const objs = C.objs.map(o => o.pitfall ? `PITFALL "${o.en}": ${o.fired != null ? "OCCURRED at " + fmtT(o.fired) + " (−" + o.w + ")" : "avoided"}` : `GOAL "${o.en}"${o.deadline ? " (deadline " + fmtT(o.deadline) + ")" : ""}: ${o.na ? "n/a" : o.met != null ? "met at " + fmtT(o.met) + (o.late ? " (late)" : "") : "NOT met"} [${o.w} pts]`).join("\n");
  const trend = C.trends.filter((d, i) => i % 3 === 0).map(d => `${fmtT(d.t)} MAP ${num(d.map)} HR ${num(d.hr)} SpO2 ${num(d.spo2)} lac ${num(d.lac, 1)} CO ${num(d.co, 1)}${d.flow ? " ECMO " + num(d.flow, 1) + "L Pven " + num(d.pven) : ""}`).join("\n");
  const prompt = `You are an experienced ICU and ECMO simulation instructor writing the debrief for a trainee who just finished a case on a Pulse-engine simulator. Be specific, cite times from the log, honest without being harsh.
${lang === "en" ? "Write in English." : lang === "ar" ? "Write in Egyptian Arabic (عامية مصرية) with medical terms, drugs and numbers in English." : "Write each section in English and then repeat it in Egyptian Arabic."}
Use exactly these sections as markdown "## " headings: Summary, What went well, What to improve, Physiology behind it, Key teaching points, References. Use "- " bullets. Under 450 words${lang === "both" ? " per language" : ""}. In References name the relevant guideline or trial (ELSO, Surviving Sepsis Campaign 2021, ARDSNet, EOLIA, ATLS…) without links.

${caseContext()}${C.hidden ? "\nActual hidden cause this run: " + C.hidden : ""}
Case duration ${fmtT(V.t)}. Score ${sc.pct}% (${sc.got}/${sc.max}).

OBJECTIVES:
${objs || "free play"}

FULL LOG:
${C.log.slice(-120).join("\n")}

TRENDS (every 15 s):
${trend}`;
  const out = $("debrief"), keep = out.innerHTML;
  out.innerHTML = keep + '<p class="thinking">Claude is reviewing the case… up to a minute.</p>';
  debCtl = new AbortController(); $("bDebriefStop").hidden = false; $("bDebrief").disabled = true;
  try { await claude(prompt, "complex", t => { out.innerHTML = keep + mdToHtml(t); }, debCtl.signal); }
  catch (e) { if (e.name !== "AbortError") out.innerHTML = keep + '<p class="hint">' + esc(e.message) + "</p>"; }
  finally { $("bDebriefStop").hidden = true; $("bDebrief").disabled = false; }
};
$("bDebriefStop").onclick = () => debCtl && debCtl.abort();
$("bGen").onclick = () => { $("genStatus").textContent = "Coming in the next version: Claude-generated cases on Pulse."; };

// ---------- start ----------
C = newCaseState(); sizeWaves(); renderObjs(); requestAnimationFrame(frame); connect();
})();
