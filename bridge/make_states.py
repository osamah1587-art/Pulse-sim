"""Generate case starting states that need Pulse *conditions* (run once at image build).
Conditions such as sepsis are applied during engine stabilization, which takes a few
CPU minutes, so we bake them into state files that load instantly at runtime.
"""
import os
import sys

from pulse.engine.PulseEngine import PulseEngine
from pulse.cdm.patient import SEPatientConfiguration

BIN = os.environ.get("PULSE_BIN", "/pulse/bin")
os.chdir(BIN)
os.makedirs("states/sim", exist_ok=True)


def make(name, configure):
    out = f"states/sim/{name}.json"
    if os.path.exists(out):
        print("exists", out)
        return
    pulse = PulseEngine(data_root_dir="./")
    pc = SEPatientConfiguration()
    pc.set_patient_file("./patients/StandardMale.json")
    configure(pc)
    print("stabilizing", name, "(this takes a few minutes)…", flush=True)
    if not pulse.initialize_engine(pc, None):
        print("FAILED", name)
        sys.exit(1)
    pulse.serialize_to_file(out)
    print("wrote", out, flush=True)


def sepsis(pc):
    pc.get_conditions().get_sepsis().get_severity().set_value(0.7)


make("Sepsis", sepsis)
