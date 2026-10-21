import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "runtime", "electron", "electron.exe")
PROBE = os.path.join(ROOT, "probe", "ring-shadow-clip-probe.cjs")

# ELECTRON_RUN_AS_NODE 就算是空串也算「有定义」，会把 electron.exe 降级成纯 Node
# （症状是一堆 `bad option: --xxx`）——必须整条键删掉。
env = {k: v for k, v in os.environ.items() if k.upper() != "ELECTRON_RUN_AS_NODE"}
env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "1"

proc = subprocess.run(
    [ELECTRON, PROBE, "--no-sandbox"],
    cwd=ROOT,
    env=env,
    capture_output=True,
    timeout=180,
)
print("exit:", proc.returncode)
print("stdout:", proc.stdout.decode("utf-8", "replace")[-8000:])
print("stderr:", proc.stderr.decode("utf-8", "replace")[-3000:])
