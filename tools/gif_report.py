#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gif_report.py · 量一遍 GIF：有多少帧、多快、帧间到底变了多少

回答的问题是「我要生成多少张图才连贯」：
  · 帧数（n_frames）= 播放出去的画格数，不等于你需要画的图数
  · 有效姿态（keyframes）= 帧间差超过阈值的次数 + 1，这才是「需要多少张不同的画」
  · 帧间差（diff）= 归一化的平均像素差，用来判断动作幅度（太小就是"看起来静态"）

用法：
  python tools/gif_report.py helper/assets/avatars/heart.gif
  python tools/gif_report.py helper/assets/avatars/*.gif helper/assets/deco/*.gif
  python tools/gif_report.py --sheet out/heart-72.png helper/assets/avatars/heart.gif
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageChops, ImageStat
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")


def frame_stats(path, threshold=0.02, thumb=64):
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    durations = []
    frames = []
    for i in range(n):
        im.seek(i)
        durations.append(im.info.get("duration", 0))
        frames.append(im.convert("RGBA"))

    size = frames[0].size
    # 帧间差：缩到 thumb×thumb 的灰度再比，避免大图噪声
    grays = [f.convert("L").resize((thumb, thumb), Image.LANCZOS) for f in frames]
    diffs = []
    for i in range(1, n):
        d = ImageChops.difference(grays[i], grays[i - 1])
        diffs.append(ImageStat.Stat(d).mean[0] / 255.0)
    # 循环接缝：最后一帧 → 第一帧
    seam = 0.0
    if n > 1:
        d = ImageChops.difference(grays[0], grays[-1])
        seam = ImageStat.Stat(d).mean[0] / 255.0

    total_ms = sum(durations) or 0
    avg_ms = (total_ms / n) if n else 0
    keyframes = 1 + sum(1 for x in diffs if x > threshold)
    return {
        "path": path,
        "size": size,
        "bytes": os.path.getsize(path),
        "n": n,
        "total_ms": total_ms,
        "avg_ms": avg_ms,
        "fps": (1000.0 / avg_ms) if avg_ms else 0,
        "diffs": diffs,
        "max_diff": max(diffs) if diffs else 0.0,
        "mean_diff": (sum(diffs) / len(diffs)) if diffs else 0.0,
        "seam": seam,
        "keyframes": keyframes,
        "transparent": im.info.get("transparency") is not None,
        "loop": im.info.get("loop"),
    }


def sheet(path, out, preview=72, cols=8, max_frames=32):
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    step = max(1, n // max_frames)
    picks = list(range(0, n, step))[:max_frames]
    cols = min(cols, len(picks))
    rows = (len(picks) + cols - 1) // cols
    pad = 6
    cell = preview + pad * 2
    canvas = Image.new("RGBA", (cols * cell, rows * cell), (20, 20, 24, 255))
    for i, idx in enumerate(picks):
        im.seek(idx)
        f = im.convert("RGBA").resize((preview, preview), Image.LANCZOS)
        canvas.alpha_composite(f, ((i % cols) * cell + pad, (i // cols) * cell + pad))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    canvas.save(out)
    print(f"对照图 {out}（{len(picks)}/{n} 帧，每格 {preview}px）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--threshold", type=float, default=0.02,
                    help="判定「这一帧是新的姿态」的帧间差阈值（默认 0.02）")
    ap.add_argument("--sheet", help="输出 72px 逐帧对照图（仅对第一个文件）")
    a = ap.parse_args()

    rows = []
    for p in a.files:
        if not os.path.isfile(p):
            print(f"跳过（不存在）{p}")
            continue
        s = frame_stats(p, a.threshold)
        rows.append(s)
        print(f"\n{s['path']}")
        print(f"  {s['size'][0]}x{s['size'][1]} · {s['n']} 帧 · 每帧 {s['avg_ms']:.0f}ms "
              f"({s['fps']:.1f}fps) · 循环 {s['total_ms'] / 1000:.2f}s · "
              f"{s['bytes'] / 1048576:.2f}MB · {'透明' if s['transparent'] else '不透明'}")
        print(f"  帧间差 平均 {s['mean_diff']:.4f} / 最大 {s['max_diff']:.4f} · "
              f"循环接缝 {s['seam']:.4f} · 有效姿态 ≈ {s['keyframes']}")

    if a.sheet and rows:
        sheet(a.files[0], a.sheet)


if __name__ == "__main__":
    main()
