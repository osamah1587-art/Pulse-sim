"""Pulse 4.4 session wrapper: one PulseEngine per connected learner.

Runs the engine in its own thread at real time x speed, collects 50 Hz waveforms,
applies actions from the browser, and adds a centrifugal-pump layer on top of
Pulse's ideal-flow ECMO pump so drainage collapse / chatter can be taught.
"""
import math
import os
import queue
import threading
import time

from pulse.engine.PulseEngine import PulseEngine
from pulse.cdm.engine import SEDataRequest, SEDataRequestManager
from pulse.cdm.scalars import (ElectricPotentialUnit, FrequencyUnit, MassPerVolumeUnit, PressureUnit,
                               PressureTimePerVolumeUnit, TemperatureUnit, TimeUnit, VolumeUnit,
                               VolumePerTimeUnit)
from pulse.cdm.patient_actions import (SEHemorrhage, SESubstanceInfusion,
                                       SESubstanceCompoundInfusion, SEArrhythmia, SEChestCompressionAutomated,
                                       SETensionPneumothorax, SENeedleDecompression, SEPericardialEffusion,
                                       SEAcuteRespiratoryDistressSyndromeExacerbation, SEIntubation,
                                       eIntubationType, SECardiovascularMechanicsModification, eSide, eGate,
                                       eSwitch)
from pulse.cdm.physiology import eHeartRhythm, eLungCompartment
from pulse.cdm.mechanical_ventilator_actions import (SEMechanicalVentilatorVolumeControl,
                                                     SEMechanicalVentilatorPressureControl,
                                                     eMechanicalVentilator_VolumeControlMode,
                                                     eMechanicalVentilator_PressureControlMode)
from pulse.cdm.extracorporeal_membrane_oxygenation_device import \
    eExtracorporealMembraneOxygenationDevice_CannulationLocation as Cannula
from pulse.cdm.extracorporeal_membrane_oxygenation_device_actions import \
    SEExtracorporealMembraneOxygenationDeviceConfiguration

PULSE_BIN = os.environ.get("PULSE_BIN", "/pulse/bin")
DT = 0.02  # Pulse time step (s)

# ---- data requests (order matters: index -> name) ----
REQ = [
    ("hr", SEDataRequest.create_physiology_request("HeartRate", unit=FrequencyUnit.Per_min)),
    ("abp", SEDataRequest.create_physiology_request("ArterialPressure", unit=PressureUnit.mmHg)),
    ("sys", SEDataRequest.create_physiology_request("SystolicArterialPressure", unit=PressureUnit.mmHg)),
    ("dia", SEDataRequest.create_physiology_request("DiastolicArterialPressure", unit=PressureUnit.mmHg)),
    ("map", SEDataRequest.create_physiology_request("MeanArterialPressure", unit=PressureUnit.mmHg)),
    ("cvp", SEDataRequest.create_physiology_request("MeanCentralVenousPressure", unit=PressureUnit.mmHg)),
    ("cvpInst", SEDataRequest.create_physiology_request("CentralVenousPressure", unit=PressureUnit.mmHg)),
    ("co", SEDataRequest.create_physiology_request("CardiacOutput", unit=VolumePerTimeUnit.L_Per_min)),
    ("sv", SEDataRequest.create_physiology_request("HeartStrokeVolume", unit=VolumeUnit.mL)),
    ("ef", SEDataRequest.create_physiology_request("HeartEjectionFraction")),
    ("pcwp", SEDataRequest.create_physiology_request("PulmonaryCapillariesWedgePressure", unit=PressureUnit.mmHg)),
    ("papm", SEDataRequest.create_physiology_request("PulmonaryMeanArterialPressure", unit=PressureUnit.mmHg)),
    ("svr", SEDataRequest.create_physiology_request("SystemicVascularResistance", unit=PressureTimePerVolumeUnit.mmHg_s_Per_mL)),
    ("spo2", SEDataRequest.create_physiology_request("OxygenSaturation")),
    ("etco2", SEDataRequest.create_physiology_request("EndTidalCarbonDioxidePressure", unit=PressureUnit.mmHg)),
    ("rr", SEDataRequest.create_physiology_request("RespirationRate", unit=FrequencyUnit.Per_min)),
    ("vt", SEDataRequest.create_physiology_request("TidalVolume", unit=VolumeUnit.mL)),
    ("pao2", SEDataRequest.create_physiology_request("ArterialOxygenPressure", unit=PressureUnit.mmHg)),
    ("paco2", SEDataRequest.create_physiology_request("ArterialCarbonDioxidePressure", unit=PressureUnit.mmHg)),
    ("ph", SEDataRequest.create_physiology_request("BloodPH")),
    ("temp", SEDataRequest.create_physiology_request("CoreTemperature", unit=TemperatureUnit.C)),
    ("urine", SEDataRequest.create_physiology_request("UrineProductionRate", unit=VolumePerTimeUnit.mL_Per_min)),
    ("bv", SEDataRequest.create_physiology_request("BloodVolume", unit=VolumeUnit.mL)),
    ("hb", SEDataRequest.create_substance_request("Hemoglobin", "BloodConcentration", unit=MassPerVolumeUnit.g_Per_dL)),
    ("lac", SEDataRequest.create_substance_request("Lactate", "BloodConcentration", unit=MassPerVolumeUnit.mg_Per_dL)),
    ("hco3", SEDataRequest.create_substance_request("Bicarbonate", "BloodConcentration", unit=MassPerVolumeUnit.g_Per_L)),
    ("ecg", SEDataRequest.create_ecg_request("Lead3ElectricPotential", unit=ElectricPotentialUnit.mV)),
    ("paw", SEDataRequest.create_mechanical_ventilator_request("AirwayPressure", unit=PressureUnit.cmH2O)),
    ("ppeak", SEDataRequest.create_mechanical_ventilator_request("PeakInspiratoryPressure", unit=PressureUnit.cmH2O)),
    ("pplat", SEDataRequest.create_mechanical_ventilator_request("PlateauPressure", unit=PressureUnit.cmH2O)),
    ("lvV", SEDataRequest.create_liquid_compartment_request("LeftHeart", "Volume", unit=VolumeUnit.mL)),
    ("lvP", SEDataRequest.create_liquid_compartment_request("LeftHeart", "Pressure", unit=PressureUnit.mmHg)),
    ("eFlow", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("BloodFlow", unit=VolumePerTimeUnit.L_Per_min)),
    ("eDrain", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("DrainagePressure", unit=PressureUnit.mmHg)),
    ("eInletP", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("InletPressure", unit=PressureUnit.mmHg)),
    ("eOutletP", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("OutletPressure", unit=PressureUnit.mmHg)),
    ("eInSat", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("InletOxygenSaturation")),
    ("eOutSat", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("OutletOxygenSaturation")),
    ("eO2", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("MembraneLungOxygenContribution", unit=VolumePerTimeUnit.mL_Per_min)),
    ("eCO2", SEDataRequest.create_extracorporeal_membrane_oxygenation_device_request("MembraneLungCarbonDioxideContribution", unit=VolumePerTimeUnit.mL_Per_min)),
]
KEYS = [k for k, _ in REQ]


def _f(x):
    try:
        x = float(x)
        return None if math.isnan(x) or math.isinf(x) else x
    except Exception:
        return None


class Pump:
    """Centrifugal pump layer: RPM + preload -> flow, with drainage collapse.

    Pulse models the pump as an ideal flow source, so we compute the flow a real
    centrifugal head would deliver and prescribe it. Collapse rises when the
    preload (central venous pressure) falls below ~4 mmHg or the drainage
    cannula resistance multiplier is high (malposition / kink).
    """
    A, B, R_TOTAL = 3.306e-5, 10.0, 80.0

    def __init__(self):
        self.rpm = 3500
        self.rd_mul = 1.0
        self.collapse = 0.0
        self.flow = 0.0
        self.pven = 0.0

    def update(self, cvp, ret_p, t, dt, drain_p=None):
        # Collapse thresholds tuned to Pulse: CVP on VV ECMO sits around 3 mmHg in this patient.
        target = (3.0 * ((2.5 - cvp) / 1.2) ** 2 if cvp < 2.5 else 0.0) + max(0.0, self.rd_mul - 1.6) * 0.7
        target = min(40.0, target)
        self.collapse += (target - self.collapse) * min(1.0, dt / 0.3)
        rd = 15.0 * self.rd_mul * (1.0 + self.collapse)
        q = max(0.0, (cvp - ret_p + self.A * self.rpm ** 2) / (rd + (self.R_TOTAL - 15.0) + self.B))
        if self.collapse > 0.6:
            q *= 1.0 - min(0.45, 0.06 * self.collapse) * (0.5 + 0.5 * math.sin(2 * math.pi * 1.4 * t))
        self.flow = q
        # Drainage pressure: Pulse's own value (cannula + limb resistance, including malposition),
        # plus the extra suction a collapsing vessel adds, which Pulse's linear circuit cannot produce.
        base = drain_p if drain_p is not None else cvp - q * 9.5 * self.rd_mul
        self.pven = base - q * 15.0 * self.collapse
        return q


class SimSession:
    def __init__(self, state_file="Ventilated@0s.json", speed=1.0):
        self.engine = PulseEngine(data_root_dir=PULSE_BIN + "/")
        self.drm = SEDataRequestManager([r for _, r in REQ])
        self.actions = queue.Queue()
        self.frames = queue.Queue(maxsize=50)
        self.speed = speed
        self.running = False
        self.paused = False
        self.t = 0.0
        self.last = {}
        self.wave = []
        self.vent = {"mode": "VC", "peep": 5, "fio2": 0.4, "vt": 480, "rr": 14, "pinsp": 15}
        self.drugs = {"ne": 0.0, "epi": 0.0, "phenyl": 0.0, "vaso": 0.0}
        self.ecmo = {"on": False, "mode": "VV", "sweep": 4.0, "fdo2": 1.0}
        self.pump = Pump()
        self._ecmo_cfg = None
        self._last_flow_set = -1.0
        self._pump_acc = 0.0
        self.dead = False
        self.cvmods = {}
        self.events = []
        self.weight = 70.0
        ok = self.engine.serialize_from_file(os.path.join(PULSE_BIN, "states", state_file), self.drm)
        if not ok:
            raise RuntimeError("Could not load Pulse state " + state_file)
        self.events.append(("info", "Loaded " + state_file))

    # ---------- helpers ----------
    def _pull(self):
        vals = self.engine.pull_data()
        # pull_data returns [sim_time, v1, v2, ...]
        d = {}
        for i, k in enumerate(KEYS):
            d[k] = _f(vals[i + 1]) if i + 1 < len(vals) else None
        return d

    def advance(self, seconds):
        """Fast-forward without streaming (used for setup)."""
        self.engine.advance_time_s(seconds)
        self.t += seconds

    # ---------- actions ----------
    def act(self, a):
        self.actions.put(a)

    def _apply(self, a):
        kind = a.get("type")
        e = self.engine
        if kind == "vent":
            self.vent.update({k: v for k, v in a.items() if k in self.vent})
            self._send_vent()
        elif kind == "intubate":
            it = SEIntubation(); it.set_type(eIntubationType.Tracheal); e.process_action(it)
        elif kind == "drug":
            name = a["drug"]
            self.drugs[name] = float(a["dose"])
            self._send_drug(name)
        elif kind == "fluid":
            inf = SESubstanceCompoundInfusion()
            inf.set_compound(a.get("compound", "Saline"))
            inf.get_bag_volume().set_value(float(a.get("ml", 500)), VolumeUnit.mL)
            inf.get_rate().set_value(float(a.get("rate", 250)), VolumePerTimeUnit.mL_Per_min)
            e.process_action(inf)
        elif kind == "hemorrhage":
            h = SEHemorrhage()
            h.set_compartment(a.get("compartment", "Aorta"))
            h.get_flow_rate().set_value(float(a.get("rate", 0)), VolumePerTimeUnit.mL_Per_min)
            e.process_action(h)
        elif kind == "rhythm":
            r = SEArrhythmia(); r.set_rhythm(eHeartRhythm[a["rhythm"]]); e.process_action(r)
        elif kind == "defib":
            from pulse.cdm.patient_actions import eDefibrillate
            r = SEArrhythmia(); r.set_rhythm(eHeartRhythm.NormalSinus); r.set_defibrillation(eDefibrillate.Unsynchronized)
            e.process_action(r)
        elif kind == "cpr":
            c = SEChestCompressionAutomated()
            c.get_compression_frequency().set_value(110 if a.get("on") else 0, FrequencyUnit.Per_min)
            c.get_force().set_value(450 if a.get("on") else 0, __import__("pulse.cdm.scalars", fromlist=["ForceUnit"]).ForceUnit.N)
            e.process_action(c)
        elif kind == "tension":
            tp = SETensionPneumothorax(); tp.get_severity().set_value(float(a.get("severity", 0.6)))
            tp.set_side(eSide.Right if a.get("side", "Right") == "Right" else eSide.Left); tp.set_type(eGate.Closed)
            e.process_action(tp)
        elif kind == "needle":
            n = SENeedleDecompression(); n.set_side(eSide.Right if a.get("side", "Right") == "Right" else eSide.Left)
            n.set_state(eSwitch.On); e.process_action(n)
        elif kind == "effusion":
            pe = SEPericardialEffusion(); pe.get_effusion_rate().set_value(float(a.get("rate", 0)), VolumePerTimeUnit.mL_Per_min)
            e.process_action(pe)
        elif kind == "ards":
            x = SEAcuteRespiratoryDistressSyndromeExacerbation()
            s = float(a.get("severity", 0.6))
            x.get_severity(eLungCompartment.LeftLung).set_value(s)
            x.get_severity(eLungCompartment.RightLung).set_value(s)
            e.process_action(x)
        elif kind == "cvmod":
            # Pulse resets any multiplier left out, so always send the full current set.
            self.cvmods.update({k: float(v) for k, v in a.items() if k in ("svr", "sv", "hr", "venc", "pvr")})
            a = dict(self.cvmods)
            m = SECardiovascularMechanicsModification()
            mods = m.get_modifiers()
            for k, getter in (("svr", mods.get_systemic_resistance_multiplier),
                              ("sv", mods.get_stroke_volume_multiplier),
                              ("hr", mods.get_heart_rate_multiplier),
                              ("venc", mods.get_venous_compliance_multiplier),
                              ("pvr", mods.get_pulmonary_resistance_multiplier)):
                if k in a:
                    getter().set_value(float(a[k]))
            e.process_action(m)
        elif kind == "ecmo_start":
            self.ecmo.update({"on": True, "mode": a.get("mode", "VV"), "sweep": float(a.get("sweep", 2)),
                              "fdo2": float(a.get("fdo2", 1))})
            self.pump.rpm = float(a.get("rpm", 3000))
            self.pump.rd_mul = 1.0
            self._send_ecmo(force=True)
        elif kind == "ecmo":
            for k in ("sweep", "fdo2"):
                if k in a:
                    self.ecmo[k] = float(a[k])
            if "rpm" in a:
                self.pump.rpm = float(a["rpm"])
            if "rdMul" in a:
                self.pump.rd_mul = float(a["rdMul"])
            self._send_ecmo(force=True)
        elif kind == "ecmo_stop":
            self.ecmo["on"] = False
            self._send_ecmo(force=True)
        elif kind == "speed":
            self.speed = max(0.25, min(8.0, float(a["value"])))
        elif kind == "pause":
            self.paused = bool(a.get("value", True))

    def _send_vent(self):
        v = self.vent
        rr = float(v["rr"])
        ti = 60.0 / rr / 3.0  # I:E 1:2
        if v["mode"] == "PC":
            m = SEMechanicalVentilatorPressureControl()
            m.set_connection(eSwitch.On)
            m.set_mode(eMechanicalVentilator_PressureControlMode.AssistedControl)
            m.get_inspiratory_pressure().set_value(float(v["pinsp"]), PressureUnit.cmH2O)
            m.get_slope().set_value(0.1, TimeUnit.s)
        else:
            m = SEMechanicalVentilatorVolumeControl()
            m.set_connection(eSwitch.On)
            m.set_mode(eMechanicalVentilator_VolumeControlMode.AssistedControl)
            m.get_tidal_volume().set_value(float(v["vt"]), VolumeUnit.mL)
            m.get_flow().set_value(float(v["vt"]) / 1000.0 / ti * 60.0 * 1.0, VolumePerTimeUnit.L_Per_min)
        m.get_fraction_inspired_oxygen().set_value(float(v["fio2"]))
        m.get_inspiratory_period().set_value(ti, TimeUnit.s)
        m.get_positive_end_expired_pressure().set_value(float(v["peep"]), PressureUnit.cmH2O)
        m.get_respiration_rate().set_value(rr, FrequencyUnit.Per_min)
        self.engine.process_action(m)

    DRUGS = {  # ui name -> (Pulse substance, concentration ug/mL)
        "ne": ("Norepinephrine", 16.0),
        "epi": ("Epinephrine", 16.0),
        "phenyl": ("Phenylephrine", 100.0),
        "vaso": ("Vasopressin", 25.0),
    }

    def _send_drug(self, name):
        sub, conc = self.DRUGS[name]
        dose = self.drugs[name]  # mcg/kg/min; vasopressin in U/min, mapped 1 U = 25 mcg so 0.04 U/min gives Pulse a ~+10 mmHg MAP response (calibrated, see README)
        rate_ml_min = dose * self.weight / conc if name != "vaso" else dose  # vaso: 25 mcg/mL bag, 1 mL per U
        inf = SESubstanceInfusion()
        inf.set_substance(sub)
        inf.get_concentration().set_value(conc, MassPerVolumeUnit.ug_Per_mL)
        inf.get_rate().set_value(rate_ml_min, VolumePerTimeUnit.mL_Per_min)
        self.engine.process_action(inf)

    def _send_ecmo(self, force=False):
        """Validated Quadrox PLS + RotaFlow circuit from Pulse's Schmidt et al. digital twins."""
        from pulse.cdm.scalars import VolumePerTimePressureUnit
        cfg = SEExtracorporealMembraneOxygenationDeviceConfiguration()
        st = cfg.get_settings()
        st.set_inlet_location(Cannula.InferiorVenaCava)
        st.set_outlet_location(Cannula.RightAtrium if self.ecmo["mode"] == "VV" else Cannula.RightFemoralArtery)
        on = self.ecmo["on"]
        st.get_pump_flow().set_value(max(0.0, self.pump.flow) if on else 0.0, VolumePerTimeUnit.L_Per_min)
        st.get_sweep_gas_flow().set_value(self.ecmo["sweep"] if on else 0.0, VolumePerTimeUnit.L_Per_min)
        st.get_fraction_of_inspired_oxygen().set_value(self.ecmo["fdo2"])
        st.get_oxygen_membrane_diffusing_capacity().set_value(0.53, VolumePerTimePressureUnit.mL_Per_min_mmHg)
        st.get_carbon_dioxide_membrane_diffusing_capacity().set_value(14.0, VolumePerTimePressureUnit.mL_Per_min_mmHg)
        st.get_supply_pressure().set_value(0.0, PressureUnit.mmHg)
        for getter, ml in ((st.get_pump_volume, 32), (st.get_oxygenator_liquid_volume, 250), (st.get_oxygenator_gas_volume, 215),
                           (st.get_infuser_volume, 0.01), (st.get_drainage_cannula_volume, 18), (st.get_return_cannula_volume, 4),
                           (st.get_drainage_limb_volume, 71), (st.get_return_limb_volume, 71), (st.get_inlet_probe_volume, 5),
                           (st.get_outlet_probe_volume, 5)):
            getter().set_value(ml, VolumeUnit.mL)
        U = PressureTimePerVolumeUnit.mmHg_min_Per_L
        st.get_drainage_cannula_resistance().set_value(8.0 * self.pump.rd_mul, U)
        st.get_return_cannula_resistance().set_value(22.0, U)
        st.get_drainage_limb_resistance().set_value(1.5, U)
        st.get_return_limb_resistance().set_value(1.5, U)
        st.get_oxygenator_resistance().set_value(10.0, U)
        self.engine.process_action(cfg)
        self._last_flow_set = self.pump.flow

    # ---------- main loop ----------
    def snapshot(self):
        d = dict(self.last)
        d["t"] = self.t
        d["lac_mmol"] = (d.get("lac") or 0) / 9.008 if d.get("lac") is not None else None
        d["hco3_mmol"] = (d.get("hco3") or 0) / 0.061 if d.get("hco3") is not None else None
        d["vent"] = dict(self.vent)
        d["drugs"] = dict(self.drugs)
        p = self.pump
        d["ecmo"] = dict(self.ecmo, rpm=p.rpm, flow=d.get("eFlow") if self.ecmo["on"] else 0, pven=p.pven if self.ecmo["on"] else 0,
                         collapse=p.collapse, rdMul=p.rd_mul)
        return d

    def _step(self):
        if self.dead:
            return
        if not self.engine.advance_time():
            self.dead = True
            self.paused = True
            self.events.append(("team", "Pulse stopped: the patient reached an irreversible state. Restart the case.",
                                "Pulse وقف: المريض وصل لحالة لا رجعة فيها. ابدأ الكيس من جديد."))
            return
        self.t += DT
        d = self._pull()
        self.last = d
        r2 = lambda x: None if x is None else round(x, 2)
        self.wave.append((round(self.t, 2), r2(d.get("ecg")), r2(d.get("abp")), r2(d.get("paw")), r2(d.get("cvpInst")), r2(d.get("lvV")), r2(d.get("lvP"))))
        self._pump_acc += DT
        if self.ecmo["on"] and self._pump_acc >= 0.1:
            ret = d.get("map") if self.ecmo["mode"] == "VA" else d.get("cvp")
            self.pump.update(d.get("cvp") if d.get("cvp") is not None else 5.0, ret if ret is not None else 5.0, self.t, self._pump_acc, d.get("eDrain") if d.get("eFlow") else None)
            if abs(self.pump.flow - self._last_flow_set) > 0.05:
                self._send_ecmo()
            self._pump_acc = 0.0

    def run_fast(self, seconds, tick=None):
        """Synchronous stepping without real-time pacing (setup and tests)."""
        n = int(round(seconds / DT))
        for i in range(n):
            while not self.actions.empty():
                self._apply(self.actions.get_nowait())
            self._step()
            if tick and i % 12 == 0:
                tick()
        self.wave = []

    def run(self):
        self.running = True
        self._send_vent()
        wall = time.monotonic()
        sim_budget = 0.0
        last_frame = time.monotonic()
        while self.running:
            now = time.monotonic()
            dt_wall = min(0.25, now - wall)
            wall = now
            while not self.actions.empty():
                try:
                    self._apply(self.actions.get_nowait())
                except Exception as ex:  # report and keep running
                    self.events.append(("error", f"Action failed: {ex}"))
            if self.paused:
                time.sleep(0.05)
                continue
            sim_budget = min(sim_budget + dt_wall * self.speed, 1.0)
            steps = 0
            while sim_budget >= DT and steps < 400:
                self._step()
                sim_budget -= DT
                steps += 1
            if now - last_frame >= 0.2:
                last_frame = now
                frame = {"wave": self.wave, "v": self.snapshot(), "events": self.events}
                self.wave, self.events = [], []
                try:
                    self.frames.put_nowait(frame)
                except queue.Full:
                    pass
            time.sleep(0.005)

    def start(self):
        th = threading.Thread(target=self.run, daemon=True)
        th.start()
        return th

    def stop(self):
        self.running = False
