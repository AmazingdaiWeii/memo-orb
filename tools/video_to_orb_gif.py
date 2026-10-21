#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
video_to_orb_gif.py · 把视频（mp4/webm）截成球体可用的 GIF

为什么要这个：视频站生成的是 5 秒 / 24fps（约 120 帧），而球只需要 3~3.5 秒 / 15fps
（约 50 帧）。直接用会让体积翻三倍，且多余帧没有任何信息量。

用法：
  # 从第 0.3 秒开始截 3.4 秒，15fps，输出 512 GIF
  python tools/video_to_orb_gif.py --video in.mp4 --out out/ball.gif --start 0.3 --dur 3.4

  # 先只看看"从哪切循环接缝最小"，不产 GIF
  python tools/video_to_orb_gif.py --video in.mp4 --scan

  # 顺带出 72px 对照图
  python tools/video_to_orb_gif.py --video in.mp4 --out out/ball.gif --sheet

依赖：ffmpeg 在 PATH 里（本机已有），Pillow（本机已有）。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageChops, ImageStat
except ImportError:
    sys.exit("需要 Pillow")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_orb_gif import save_gif, make_sheet, harden_alpha, fit_square  # noqa: E402


def extract(video, start, dur, fps, size, outdir):
    """用 ffmpeg 抽帧到 outdir，返回按顺序的 PNG 路径。"""
    pattern = os.path.join(outdir, "f%05d.png")
    # scale 到覆盖 size×size 再居中裁切（等价 object-fit: cover）
    vf = (f"fps={fps},"
          f"scale={size}:{size}:force_original_aspect_ratio=increase,"
          f"crop={size}:{size}")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", video]
    if dur:
        cmd += ["-t", str(dur)]
    cmd += ["-vf", vf, pattern]
    subprocess.run(cmd, check=True)
    files = sorted(f for f in os.listdir(outdir) if f.startswith("f") and f.endswith(".png"))
    return [os.path.join(outdir, f) for f in files]


def seam(path_a, path_b, thumb=64):
    a = Image.open(path_a).convert("L").resize((thumb, thumb), Image.LANCZOS)
    b = Image.open(path_b).convert("L").resize((thumb, thumb), Image.LANCZOS)
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0] / 255.0


def scan(video, fps, size, dur=3.4, step=0.2, max_start=8.0):
    """扫一遍起点，找「首尾最像」的那一段 —— 循环接缝越小，播放越顺。"""
    tmp = tempfile.mkdtemp(prefix="orb-scan-")
    best = []
    need = max(4, int(fps * dur * 0.8))  # 太短的段不参与评比（否则会推荐片尾那几帧）
    try:
        t = 0.0
        while t <= max_start:
            try:
                frames = extract(video, t, dur, fps, size, tmp)
            except subprocess.CalledProcessError:
                break
            if len(frames) < need:
                break
            s = seam(frames[0], frames[-1])
            best.append((s, t, len(frames)))
            print(f"  起点 {t:>4.1f}s → {len(frames)} 帧，循环接缝 {s:.4f}")
            for f in frames:
                os.remove(f)
            t += step
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not best:
        print("扫描失败：这段视频抽不出帧")
        return
    best.sort()
    print(f"\n最顺的接缝：起点 {best[0][1]}s（{best[0][2]} 帧，接缝 {best[0][0]:.4f}）")
    print("接缝 < 0.02 基本看不出跳；0.02~0.05 轻微；>0.05 会明显卡一拍。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", help="输出 GIF（--scan 时可省）")
    ap.add_argument("--start", type=float, default=0.0, help="起始秒（默认 0）")
    ap.add_argument("--dur", type=float, default=3.4, help="截取时长秒（默认 3.4，实测原片规格）")
    ap.add_argument("--fps", type=int, default=15, help="抽帧帧率（默认 15，与原片一致）")
    ap.add_argument("--size", type=int, default=512, help="输出边长（默认 512）")
    ap.add_argument("--colors", type=int, default=128, help="调色板色数（默认 128）")
    ap.add_argument("--scan", action="store_true", help="只扫描最佳循环起点，不输出 GIF")
    ap.add_argument("--pingpong", action="store_true",
                    help="正放+倒放拼接：循环接缝恒为 0（适合呼吸/发丝这类可逆动作）")
    ap.add_argument("--sheet", action="store_true", help="额外输出 72px 对照图")
    a = ap.parse_args()

    if a.scan:
        scan(a.video, a.fps, a.size, a.dur)
        return
    if not a.out:
        sys.exit("没有 --out（要么给输出路径，要么加 --scan）")

    tmp = tempfile.mkdtemp(prefix="orb-frames-")
    try:
        files = extract(a.video, a.start, a.dur, a.fps, a.size, tmp)
        if not files:
            sys.exit("抽帧失败：检查 ffmpeg 是否能读这个文件")
        frames = [harden_alpha(fit_square(Image.open(f).convert("RGBA"), a.size), 128) for f in files]
        if a.pingpong and len(frames) > 2:
            frames = frames + frames[-2:0:-1]   # 正放 + 倒放（去掉重复的两个端点）
        size, has_alpha = save_gif(frames, a.out, a.fps, a.colors, False, None)
        s = 0.0 if a.pingpong else seam(files[0], files[-1])
        print(f"输出 {a.out}")
        print(f"  {a.size}x{a.size} · {len(frames)} 帧 · {a.fps}fps · "
              f"{len(frames) / a.fps:.2f}s · {size / 1048576:.2f} MB · "
              f"{'带透明' if has_alpha else '不透明'}")
        print(f"  循环接缝 {s:.4f}" + ("（顺）" if s < 0.02 else "（建议 --scan 换个起点）" if s < 0.05 else "（会卡一拍）"))
        if a.sheet:
            print("  对照图", make_sheet(frames, a.out))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
