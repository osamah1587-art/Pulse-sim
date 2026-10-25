# ICU ECMO Sim (Pulse 4.4)

Teaching simulator for ICU and ECMO, built on the [Pulse Physiology Engine](https://pulse.kitware.com) 4.4 by Kitware (Apache 2.0).
A Python bridge runs one Pulse engine per learner, streams the monitor to the browser, scores cases and proxies Claude for the bedside team, consultant hints and debriefs.

## What runs where

| Part | Folder | Role |
| --- | --- | --- |
| Pulse 4.4 | built in `Dockerfile` from gitlab.kitware.com | All physiology: heart, lungs, drugs, fluids, ventilator, ECMO |
| Bridge | `bridge/` | FastAPI + WebSocket; cases, procedures, pump layer, Claude proxy |
| Web | `web/` | Monitor, controls, objectives, debrief |

The ECMO pump in Pulse is an ideal flow source. `bridge/engine.py` adds a centrifugal-pump layer (RPM and preload set the flow, with drainage collapse and line chatter) and prescribes that flow to Pulse.

## Run on a laptop (Docker Desktop)

```
docker compose -f docker-compose.local.yml build
docker compose -f docker-compose.local.yml up
```

Open http://localhost:8080. Put `ANTHROPIC_API_KEY=...` in a `.env` file to switch Claude on.

## Run on a server

Copy `.env.example` to `.env`, fill it in, then:

```
docker compose build
docker compose up -d
```

## Cases

Free play, post-op bleeding, septic shock, cardiogenic shock, severe ARDS to VV ECMO, and Station 3 (VV ECMO drainage alarm with a hidden cause).

## Drug notes

Pulse 4.4 has norepinephrine, epinephrine, phenylephrine and vasopressin, but no dobutamine, so epinephrine is the inotrope.
Vasopressin is entered in units/min and mapped to 25 mcg per unit, calibrated so 0.04 U/min raises MAP by about 10 mmHg in a vasoplegic patient in Pulse.

Teaching use only. Not for clinical decisions.
