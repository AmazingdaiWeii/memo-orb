import os, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "runtime", "electron", "electron.exe")
PROBE = os.path.join(ROOT, "probe", "tray-final-check.cjs")
OUT = os.path.join(ROOT, "probe", "_tray_final.txt")

if os.path.exists(OUT):
    os.remove(OUT)

env = {k: v for k, v in os.environ.items() if k.upper() != "ELECTRON_RUN_AS_NODE"}
env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "1"

p = subprocess.run(
    [ELECTRON, "--no-sandbox", "--disable-gpu", PROBE],
    cwd=ROOT, env=env, capture_output=True, timeout=120
)
print("exit:", p.returncode)
if p.stdout:
    print("--- stdout ---")
    print(p.stdout.decode("utf-8", "replace")[:3000])
if p.stderr:
    print("--- stderr ---")
    print(p.stderr.decode("utf-8", "replace")[:3000])
print("--- probe/_tray_final.txt ---")
if os.path.exists(OUT):
    with open(OUT, "r", encoding="utf-8") as f:
        print(f.read())
else:
    print("(文件不存在)")
