#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_orb_gif.py · 把「一张静态图」搓成球体可用的微动 GIF

为什么是"一张图 → 程序化微动"，而不是"生成 12 张静态帧"：
图像模型无法保证同一角色连续 8 帧不变（越生成越不像）。而球只有 72px，
真正看得见的只是**轮廓的轻微起伏**，用程序做缩放/浮动就够了，一致性 100%。

用法：
  # 从现有 GIF 取首帧，做 12 帧呼吸
  python tools/make_orb_gif.py --from-gif helper/assets/deepseek-avatar-square.gif \
      --out generated-images/gif-demo/breath.gif

  # 从一张 PNG 做，10fps、128 色，并输出 72px 对照图
  python tools/make_orb_gif.py --src art/ball.png --out out/ball.gif --fps 10 --colors 128 --sheet

  # 立绘带透明底、又不想看到锯齿：给一个底色拍平
  python tools/make_orb_gif.py --src art/ball.png --out out/ball.gif --bg 111111

约束（GIF 本身的硬限制，脚本只能规避、不能消除）：
  · 透明是 1-bit：要么全透、要么不透。边缘半透明会被压成锯齿 → 用 --bg 拍平，或 --outline 加描边
  · 帧延迟最小 10ms；10fps（100ms）对微动够用
  · 首帧会被 orb 当作「收起态静止脸」→ --hold-first 让首帧多停一会儿
  · 球体底色跟主题走（暗 #111111 / 亮 #f9fafb），所以 --bg 只适合"你确定只用一个主题"的场合
"""
import argparse
import math
import os
import sys

try:
    from PIL import Image, ImageFilter
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")


def load_first_frame(path):
    im = Image.open(path)
    im.seek(0)
    return im.convert("RGBA")


def fit_square(im, size):
    """居中缩放铺满正方形（等价 CSS object-fit: cover）。"""
    w, h = im.size
    scale = size / min(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    left = (nw - size) // 2
    top = (nh - size) // 2
    return im.crop((left, top, left + size, top + size))


def harden_alpha(im, threshold=128, outline=0, outline_color=(0, 0, 0, 255)):
    """GIF 只有 1-bit 透明：把 alpha 二值化；可选加一圈描边压住锯齿。"""
    r, g, b, a = im.split()
    a = a.point(lambda v: 255 if v >= threshold else 0)
    out = Image.merge("RGBA", (r, g, b, a))
    if outline > 0:
        grown = a.filter(ImageFilter.MaxFilter(outline * 2 + 1))
        ring = Image.new("RGBA", im.size, outline_color)
        ring.putalpha(grown)
        out = Image.alpha_composite(ring, out)
    return out


def breathe_frames(base, frames, amp, bob, supersample=2):
    """
    呼吸 + 轻微上下浮动。
    做法：先放大到 box×box，再**居中裁回** big×big —— 而不是"把大图贴到小画布上"，
    因为后者在 box>canvas 时会从正偏移开始贴，顶部留出一条透明带。
    """
    size = base.size[0]
    big = size * supersample
    src = base.resize((big, big), Image.LANCZOS)
    out = []
    for i in range(frames):
        t = i / frames
        scale = 1.0 + amp * (0.5 - 0.5 * math.cos(2 * math.pi * t))
        dy = -bob * math.sin(2 * math.pi * t) * supersample
        box = max(big, round(big * scale))
        frame = src.resize((box, box), Image.LANCZOS)
        span = box - big
        left = min(max(0, span // 2), span)
        top = min(max(0, span // 2 + round(dy)), span)
        out.append(frame.crop((left, top, left + big, top + big)).resize((size, size), Image.LANCZOS))
    return out


def save_gif(frames, out, fps, colors, hold_first, bg=None):
    delay = max(10, round(1000 / fps))
    has_alpha = any(f.getchannel("A").getextrema()[0] < 255 for f in frames)

    if has_alpha and bg:
        flat = []
        for f in frames:
            canvas = Image.new("RGBA", f.size, bg)
            canvas.alpha_composite(f)
            flat.append(canvas.convert("RGB"))
        base = flat[0].quantize(colors=colors, method=Image.MEDIANCUT)
        indexed = [f.quantize(palette=base, dither=Image.NONE) for f in flat]
    elif has_alpha:
        # 保留透明：逐帧自建调色板，可能有极轻微闪烁
        indexed = [f.quantize(colors=colors, method=Image.FASTOCTREE) for f in frames]
    else:
        # 不透明：首帧建全局调色板，逐帧映射 —— 不会闪
        base = frames[0].convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT)
        indexed = [f.convert("RGB").quantize(palette=base, dither=Image.NONE) for f in frames]

    delays = [delay * (3 if hold_first else 1)] + [delay] * (len(indexed) - 1)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    indexed[0].save(
        out, save_all=True, append_images=indexed[1:],
        duration=delays, loop=0, optimize=True, disposal=2,
    )
    return os.path.getsize(out), has_alpha


def make_sheet(frames, out, preview=72, cols=6):
    """把所有帧按 72px 实际大小排一张对照图，判断这个尺度下动不动看得出来。"""
    n = len(frames)
    rows = math.ceil(n / cols)
    pad = 8
    cell = preview + pad * 2
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (24, 24, 28, 255))
    for i, f in enumerate(frames):
        thumb = f.resize((preview, preview), Image.LANCZOS)
        sheet.alpha_composite(thumb, ((i % cols) * cell + pad, (i // cols) * cell + pad))
    path = os.path.splitext(out)[0] + "-sheet.png"
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--src", help="输入静态图（PNG/JPG/WEBP）")
    g.add_argument("--from-gif", dest="from_gif", help="从一张现有 GIF 取首帧")
    ap.add_argument("--out", required=True, help="输出 GIF 路径")
    ap.add_argument("--size", type=int, default=512, help="输出边长（默认 512）")
    ap.add_argument("--frames", type=int, default=12, help="帧数（默认 12）")
    ap.add_argument("--fps", type=int, default=10, help="帧率（默认 10）")
    ap.add_argument("--amp", type=float, default=0.03, help="呼吸幅度（默认 0.03；72px 下低于 0.02 基本看不出）")
    ap.add_argument("--bob", type=float, default=6.0, help="上下浮动像素（按输出边长计，默认 6；72px 下约 0.8px）")
    ap.add_argument("--colors", type=int, default=128, help="调色板色数（默认 128）")
    ap.add_argument("--alpha-threshold", type=int, default=128, help="alpha 二值化阈值")
    ap.add_argument("--outline", type=int, default=0, help="描边宽度（像素，0=不加）")
    ap.add_argument("--bg", help="给一个底色（如 111111）把透明拍平，绕开 GIF 的锯齿")
    ap.add_argument("--hold-first", action="store_true", help="首帧停留 3 倍时长")
    ap.add_argument("--sheet", action="store_true", help="额外输出 72px 对照图")
    a = ap.parse_args()

    bg = None
    if a.bg:
        h = a.bg.lstrip("#")
        bg = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)

    base = load_first_frame(a.from_gif or a.src)
    base = fit_square(base, a.size)
    base = harden_alpha(base, a.alpha_threshold, a.outline)
    frames = breathe_frames(base, a.frames, a.amp, a.bob)
    frames = [harden_alpha(f, a.alpha_threshold, 0) for f in frames]

    size, has_alpha = save_gif(frames, a.out, a.fps, a.colors, a.hold_first, bg)
    print(f"输出 {a.out}")
    print(f"  {a.size}x{a.size} · {a.frames} 帧 · {a.fps}fps · {a.colors} 色 · "
          f"循环 {a.frames / a.fps:.1f}s · {size / 1048576:.2f} MB · "
          f"{'带透明' if has_alpha and not bg else '不透明'}")
    if size > 2 * 1048576:
        print("  ⚠ 超过 2MB，建议：--frames 8 / --colors 64 / --size 384")
    if a.sheet:
        print("  对照图", make_sheet(frames, a.out))


if __name__ == "__main__":
    main()
