import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "runtime", "electron", "electron.exe")
PROBE = os.path.join(ROOT, "probe", "ctxmenu-glass-probe.cjs")

env = {k: v for k, v in os.environ.items() if k.upper() != "ELECTRON_RUN_AS_NODE"}
env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "1"

proc = subprocess.run(
    [ELECTRON, PROBE, "--no-sandbox", "--disable-gpu"],
    cwd=ROOT,
    env=env,
    capture_output=True,
    timeout=120,
)
print("exit:", proc.returncode)
print("stdout:", proc.stdout.decode("utf-8", "replace")[:3000])
print("stderr:", proc.stderr.decode("utf-8", "replace")[:3000])

out = os.path.join(ROOT, "probe", "_ctxmenu_glass.txt")
if os.path.exists(out):
    with open(out, "r", encoding="utf-8") as f:
        print("---- 结果 ----")
        print(f.read())
else:
    print("!! 没有产出结果文件")
