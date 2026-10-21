"""
WebView2 路线的占用对照实验（修正版）。

v1 的 bug：
  1. 在 for 循环里调 webview.start()，会重复启动 GUI 主循环
  2. background_color='#00000000' 不是合法 hex triplet，create_window 直接抛错

本机背景噪音：Windows 搜索（SearchHost.exe）本身就常驻 6 个 msedgewebview2 进程、
约 421 MB，创建于 08:42。所以必须用「跑之前 / 跑之后」的差值来算，不能直接读总数。

用法：先记基线，再跑本脚本，25 秒后自动关窗。
"""

import os
import sys
import threading
import time

import webview

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "helper", "assets", "floating.html")
SECONDS = 25


def closer(window):
    time.sleep(SECONDS)
    try:
        window.destroy()
    except Exception as exc:  # noqa: BLE001
        print(f"[probe] destroy failed: {exc}", flush=True)


def main():
    print(f"[probe] python pid = {__import__('os').getpid()}", flush=True)
    window = webview.create_window(
        "orb-webview2-probe",
        url=ASSETS,
        width=380,
        height=560,
        frameless=True,
        on_top=True,
        transparent=True,
    )
    threading.Thread(target=closer, args=(window,), daemon=True).start()
    print("[probe] 窗口已创建，开始 25 秒采样窗口", flush=True)
    webview.start(gui="edgechromium", debug=False)
    print("[probe] 窗口已关闭", flush=True)


if __name__ == "__main__":
    sys.exit(main())
