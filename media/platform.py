# Reads and checks X-HEEP platform configurations for the X-HEEP IDE platform editor, with X-HEEP's own
# generator (util/xheep_gen), so the editor shows what mcu-gen would build and never reimplements it.
#
#   python platform.py read  <x-heep root> <config>   -> JSON: effective values and what can be chosen
#   python platform.py check <x-heep root> <config>   -> JSON: whether mcu-gen would accept it
#
# Runs in X-HEEP's Python environment. Prints one JSON object on its last line.

import contextlib
import inspect
import io
import json
import sys
from pathlib import PurePath


def catalog():
    """CPUs and user peripherals xheep_gen knows, with their first doc line."""
    import peripherals.user_peripherals as up
    from peripherals.abstractions import UserPeripheral

    def doc(cls):
        return (inspect.getdoc(cls) or "").split("\n")[0].strip()

    periph = sorted(
        {
            obj._name: {"name": obj._name, "cls": name, "doc": doc(obj)}
            for name, obj in vars(up).items()
            if inspect.isclass(obj) and issubclass(obj, UserPeripheral) and obj is not UserPeripheral and getattr(obj, "_name", None)
        }.values(),
        key=lambda p: p["name"],
    )
    return {"cpus": ["cv32e20", "cv32e40p", "cv32e40x", "cv32e40px"], "userPeripherals": periph}


def read(xheep):
    mem = xheep.memory_ss()
    cpu = xheep.cpu()
    il_groups = list(mem.iter_il_groups()) if mem.has_il_ram() else []
    il_idx = {b.name() for g in il_groups for b in g.banks} if il_groups else set()
    return {
        "cpu": cpu.get_name(),
        "fpu": bool(getattr(cpu, "params", {}).get("fpu", False)) if hasattr(cpu, "params") else bool(getattr(cpu, "fpu", False)),
        "bus": xheep.bus_type().value if hasattr(xheep.bus_type(), "value") else str(xheep.bus_type()),
        "banks": [b.size() // 1024 for b in mem.iter_ram_banks() if b.name() not in il_idx],
        "interleaved": [{"num": g.n, "sizeKb": g.size // g.n // 1024} for g in il_groups],
        "sections": [{"name": s.name, "start": s.start, "end": s.end} for s in mem.iter_linker_sections()],
        "stack": xheep.stack_size(),
        "heap": xheep.heap_size(),
        "userPeripherals": [p.get_name() for p in xheep.get_user_peripheral_domain().get_peripherals()],
    }


def main():
    cmd, root, config = sys.argv[1:4]
    sys.path.insert(0, f"{root}/util/xheep_gen")
    out = {"ok": True}
    log = io.StringIO()
    try:
        # xheep_gen prints its own messages: keep stdout for the JSON.
        with contextlib.redirect_stdout(log):
            import load_config

            xheep = load_config.load_cfg_file(PurePath(config))
            if cmd == "read":
                out["platform"] = read(xheep)
                out["catalog"] = catalog()
            else:
                # As mcu-gen does: pads, then build (fills the gaps), then the sanity checks.
                xheep.set_padring(load_config.load_pad_cfg(PurePath(f"{root}/configs/pad_cfg.py"), xheep))
                xheep.build()
                xheep.validate()
    except Exception as e:  # any failure is the user's to read, as mcu-gen would print it
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out["log"] = log.getvalue()[-2000:]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
