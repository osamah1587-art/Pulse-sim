"""Server-side case logic: initial physiology, timed events, hidden causes, procedures, bedside findings.
Objectives and scoring live in the browser (web/cases.js) and read the vitals stream.
"""
import random

BASE_STATE = "Ventilated@0s.json"
SEPSIS_STATE = "sim/Sepsis.json"


def say(s, en, ar):
    s.events.append(("team", en, ar))


class Case:
    id = "free"
    state = BASE_STATE
    sandbox = False

    def __init__(self, s):
        self.s = s
        self.flags = {}
        self.pending = []  # (sim_time, fn)
        self.hidden = None
        self.fired = set()

    def setup(self):
        pass

    def later(self, sec, fn):
        self.pending.append((self.s.t + sec, fn))

    def once(self, key, cond, fn):
        if key not in self.fired and cond():
            self.fired.add(key)
            fn()

    def tick(self):
        due = [p for p in self.pending if self.s.t >= p[0]]
        self.pending = [p for p in self.pending if self.s.t < p[0]]
        for _, fn in due:
            fn()
        self.case_tick()

    def case_tick(self):
        pass

    # ---- procedures common to all cases ----
    def procedure(self, name):
        s = self.s
        if name == "source":
            if self.flags.get("bleeding"):
                say(s, "Surgery called for source control.", "اتطلبت الجراحة للسيطرة على النزيف.")
                self.later(60 if self.hidden == "hypo" else 180, self._stop_bleed)
            else:
                say(s, "No active bleeding source found.", "مافيش مصدر نزيف نشط.")
        elif name == "abx":
            if not self.flags.get("abx"):
                self.flags["abx"] = s.t
                say(s, "Antibiotics running.", "المضاد الحيوي شغّال.")
        elif name == "peri":
            if self.flags.get("effusion"):
                s.act({"type": "effusion", "rate": -400})
                self.later(30, lambda: s.act({"type": "effusion", "rate": 0}))
                say(s, "Pericardiocentesis: 300 ml blood-stained fluid drained.", "سحبنا ٣٠٠ مل سائل دموي من التامور.")
            else:
                say(s, "Dry tap. No significant effusion.", "مافيش سوائل تذكر حوالين القلب.")
        elif name == "needle":
            s.act({"type": "needle", "side": "Right"})
            say(s, "Needle decompression, right 2nd intercostal space.", "اتعمل needle decompression يمين.")
        elif name == "repos":
            if s.ecmo["on"]:
                say(s, "Repositioning drainage cannula under echo…", "بنظبط الكانيولا بالإيكو…")
                self.later(60, self._repositioned)
        elif name == "cannulate_vv" or name == "cannulate_va":
            mode = "VV" if name.endswith("vv") else "VA"
            say(s, f"ECMO team called: {mode} cannulation started (≈90 s).", f"فريق الـ ECMO جه: بدأنا {mode} (حوالي ٩٠ ثانية).")
            self.later(90, lambda: (s.act({"type": "ecmo_start", "mode": mode, "rpm": 3000, "sweep": 2, "fdo2": 1}),
                                    say(s, f"{mode} ECMO running at 3000 rpm.", f"الـ {mode} ECMO شغّال على 3000 rpm.")))

    def _stop_bleed(self):
        self.s.act({"type": "hemorrhage", "compartment": self.flags.get("bleed_site", "Splanchnic"), "rate": 0})
        self.flags["bleeding"] = False
        self.flags["siteControlled"] = True
        say(self.s, "Bleeding controlled.", "النزيف اتوقف.")

    def _repositioned(self):
        self.s.act({"type": "ecmo", "rdMul": 1.0})
        self.flags["repositioned"] = True
        say(self.s, "Perfusionist: cannula repositioned and secured.", "البيرفيوجنست: الكانيولا اتظبطت واتثبتت.")

    # ---- findings ----
    def finding(self, kind):
        s, d = self.s, self.s.last
        out = []
        cvp, ef = d.get("cvp") or 0, (d.get("ef") or 0)
        if kind == "echo":
            if self.flags.get("effusion"):
                out.append("Circumferential pericardial effusion with RA/RV diastolic collapse. Plethoric IVC.")
            if ef < 0.3:
                out.append(f"Dilated LV with severely reduced function (EF ≈ {round(ef*100)}%).")
            elif cvp < 3:
                out.append("Small hyperdynamic LV, near cavity obliteration. IVC small and collapsing.")
            else:
                out.append(f"LV normal size, EF ≈ {round(ef*100)}%.")
            if s.ecmo["on"]:
                if self.hidden == "malpos":
                    out.append("Drainage cannula tip in a hepatic vein / against the IVC wall; turbulent inflow.")
                elif cvp < 3:
                    out.append("IVC collapsing around the drainage cannula.")
                else:
                    out.append("Cannula tips well positioned.")
        elif kind == "circuit":
            if not s.ecmo["on"]:
                out.append("No ECMO circuit in place.")
            else:
                p = s.pump
                out.append(f"Pump {round(p.rpm)} rpm, flow {p.flow:.2f} L/min, Pven {round(p.pven)} mmHg.")
                out.append("Drainage line chattering; flow oscillates." if p.collapse > 0.6 else "Lines steady, no chatter.")
                out.append("External depth mark 3 cm out vs the insertion record." if self.hidden == "malpos" else "Depth mark matches the insertion record. No kinks.")
        elif kind == "exam":
            out.append("Cold, mottled peripheries, CRT 5 s." if (d.get("map") or 90) < 65 else "Warm peripheries, CRT 2 s.")
            if self.flags.get("bleeding") and self.hidden == "hypo":
                out.append("Drainage cannula dressing soaked with fresh blood, steady ooze.")
            elif self.flags.get("bleeding"):
                out.append("Abdominal drain filling with fresh blood.")
            if self.flags.get("tension"):
                out.append("Absent breath sounds on the right, trachea deviated left, high airway pressures.")
        return " ".join(out)


class Free(Case):
    id = "free"
    sandbox = True


class Hem(Case):
    id = "hem"

    def setup(self):
        self.flags.update(bleeding=True, bleed_site="Splanchnic")
        self.s.act({"type": "hemorrhage", "compartment": "Splanchnic", "rate": 260})

    def case_tick(self):
        self.once("drain", lambda: self.s.t > 40, lambda: say(self.s, "Nurse: 400 ml of fresh blood in the drain over 30 minutes.", "الممرضة: الدرنقة نزّلت ٤٠٠ مل دم فريش في نص ساعة."))


class Sepsis(Case):
    id = "sep"
    state = SEPSIS_STATE

    def setup(self):
        self.s.act({"type": "intubate"})
        self.s.act({"type": "cvmod", "svr": 0.4})

    def case_tick(self):
        s = self.s
        self.once("cultures", lambda: s.t > 60, lambda: say(s, "Nurse: cultures sent. Hang antibiotics now?", "الممرضة: المزارع اتبعتت. أعلّق المضاد الحيوي؟"))
        # Antibiotics: vasoplegia eases slowly (SVR multiplier 0.4 -> 0.7 over 15 min)
        if self.flags.get("abx") and int(s.t) % 30 == 0 and self.flags.get("lastAbx") != int(s.t):
            self.flags["lastAbx"] = int(s.t)
            k = min(1.0, (s.t - self.flags["abx"]) / 900.0)
            s.act({"type": "cvmod", "svr": 0.4 + 0.3 * k})


class Cardiogenic(Case):
    id = "card"

    def setup(self):
        self.s.act({"type": "cvmod", "sv": 0.25})

    def case_tick(self):
        self.once("mottled", lambda: self.s.t > 50, lambda: say(self.s, "Nurse: mottled to the knees, urine 10 ml last hour.", "الممرضة: بقع لحد الركبة والبول ١٠ مل في آخر ساعة."))


class ARDS(Case):
    id = "ards"

    def setup(self):
        s = self.s
        s.act({"type": "ards", "severity": 0.85})
        s.act({"type": "vent", "fio2": 1.0, "peep": 8, "vt": 500, "rr": 24})

    def case_tick(self):
        self.once("rt", lambda: self.s.t > 45, lambda: say(self.s, "RT: plateau is high and he's fighting the vent. Want changes?", "أخصائي التنفس: الـ plateau عالي وهو بيقاوم الجهاز. أغيّر حاجة؟"))


class Station3(Case):
    id = "st3"

    def setup(self):
        s = self.s
        self.hidden = random.choice(["hypo", "malpos"])
        s.act({"type": "ards", "severity": 0.85})
        s.act({"type": "vent", "fio2": 0.4, "peep": 10, "vt": 280, "rr": 12})
        s.act({"type": "ecmo_start", "mode": "VV", "rpm": 3600, "sweep": 4, "fdo2": 1})

    def case_tick(self):
        s = self.s
        if self.hidden == "malpos" and s.t > 30 and not self.flags.get("repositioned"):
            if s.pump.rd_mul < 3.5:
                s.pump.rd_mul = min(3.5, s.pump.rd_mul + 0.0025)
                if int(s.t * 4) % 20 == 0:
                    s.act({"type": "ecmo", "rdMul": s.pump.rd_mul})
        if self.hidden == "hypo" and s.t > 20 and not self.flags.get("bleedStarted"):
            self.flags.update(bleedStarted=True, bleeding=True, bleed_site="VenaCava")
            s.act({"type": "hemorrhage", "compartment": "VenaCava", "rate": 260})
        if not self.flags.get("alarmAt") and s.ecmo["on"] and s.pump.pven < -100:
            self.flags["alarmAt"] = s.t
            s.events.append(("flag", "alarmAt", s.t, s.pump.rpm))
            say(s, "Perfusionist: Pven below −100 and the drainage line is chattering.", "البيرفيوجنست: الـ Pven تحت −١٠٠ وخط الدرنقة بيعمل chatter.")


CASES = {c.id: c for c in (Free, Hem, Sepsis, Cardiogenic, ARDS, Station3)}
