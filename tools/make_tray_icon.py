#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一张「圆形徽章」图做成托盘图标素材（PNG + 多尺寸 ICO）。

用法：
    python tools/make_tray_icon.py <源图> <输出目录>

做的事（三步，全部按像素实测，不靠肉眼调参）：
1. 背景色从四角采样得出（这张图是深灰绿 #283234 一类的纯色底）；
2. 以「与背景色的距离 > 阈值」为前景，取前景包围盒 —— 徽章是正圆，包围盒即直径；
3. 裁成正方形 → 缩放到 256 → 乘一张抗锯齿圆形 alpha（外圈透明，托盘里贴任何底色都不发白）。

输出：
- tray.png         256×256 RGBA（托盘运行时用，`.ico` 解不出时的第一顺位退路）
- tray.ico         16/20/24/32/48/64/128/256 多尺寸（托盘首选；exe 图标与托盘都能吃）
- tray-preview.png 256×256 铺在深色底上的预览图（人工核对用，**不进发布包**）

★ 预览图别放在 helper/assets/ 里：那个目录会被整个拷进发布包。
  tools/export-factory.mjs 已把 helper/assets/tray-preview.png 列进 FORBID 兜底，
  但仍建议输出到 probe/ 之类不随包的位置（例如 `python tools/make_tray_icon.py <源图> probe`）。
"""
import sys
import os
from PIL import Image, ImageDraw

BG_TOL = 42.0          # 与背景色的 RGB 距离阈值：大于它算前景
MARGIN_RATIO = 0.02    # 裁剪时四周留的余量（占直径比例），防止边缘被切


def bg_color(im):
    """四角 5×5 小块的中位色当作背景。"""
    w, h = im.size
    pts = []
    for bx, by in ((0, 0), (w - 5, 0), (0, h - 5), (w - 5, h - 5)):
        for x in range(bx, bx + 5):
            for y in range(by, by + 5):
                pts.append(im.getpixel((x, y))[:3])
    pts.sort()
    return tuple(pts[len(pts) // 2][i] for i in range(3))


def bbox_of_foreground(im, bg):
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            d = ((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) ** 0.5
            if d > BG_TOL:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    return minx, miny, maxx, maxy


def circle_alpha(size, ss=4):
    """抗锯齿圆形 alpha：先 4 倍超采样画圆，再缩回去。"""
    big = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(big)
    d.ellipse((0, 0, size * ss - 1, size * ss - 1), fill=255)
    return big.resize((size, size), Image.LANCZOS)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    im = Image.open(src).convert("RGB")
    bg = bg_color(im)
    box = bbox_of_foreground(im, bg)
    minx, miny, maxx, maxy = box
    bw, bh = maxx - minx + 1, maxy - miny + 1
    print(f"源图 {im.size[0]}×{im.size[1]}  背景 rgb{bg}  前景框 ({minx},{miny})-({maxx},{maxy})  {bw}×{bh}")

    # 正方形裁切：以包围盒中心为准，边长取长边 + 余量
    side = int(max(bw, bh) * (1 + MARGIN_RATIO * 2))
    cx, cy = (minx + maxx) // 2, (miny + maxy) // 2
    left, top = cx - side // 2, cy - side // 2
    # 越界就平移回图内（边缘处补背景色）
    left = max(0, min(left, im.size[0] - side)) if side <= im.size[0] else (im.size[0] - side) // 2
    top = max(0, min(top, im.size[1] - side)) if side <= im.size[1] else (im.size[1] - side) // 2
    crop = im.crop((left, top, left + side, top + side))

    size = 256
    sq = crop.resize((size, size), Image.LANCZOS).convert("RGBA")
    sq.putalpha(circle_alpha(size))

    png = os.path.join(outdir, "tray.png")
    sq.save(png)

    ico = os.path.join(outdir, "tray.ico")
    sq.save(ico, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # 预览：贴深色底，肉眼看边缘是否有残留背景
    prev = Image.new("RGB", (size * 2, size), (43, 46, 49))
    prev.paste(sq, (size, 0), sq)
    prev.save(os.path.join(outdir, "tray-preview.png"))
    print(f"写出 {png} / {ico} / tray-preview.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
