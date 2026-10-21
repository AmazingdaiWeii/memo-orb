"""probe/qr-decode.py —— 主闸：把 src/qr.mjs 编出来的矩阵画成图，用**两个独立解码器**
（OpenCV `QRCodeDetector` 与 zxing-cpp）读回来，检查解出的文本与原文逐字节一致。

为什么不用「跟 segno 字节级对拍」当主闸：两边都合法，但**填充策略不同** —— segno
在终结符之后会多补一个 0x00 字节再进 0xEC/0x11，我在终结符后直接进 0xEC/0x11。
两者都能被解码器读回（填充区本来就在数据之外），字节级对比只会报「差异」而不代表错。
字节级比对留在 `probe/qr-verify.py` 作诊断。

用法：
  node probe/qr-verify.mjs
  python probe/qr-decode.py logs/qr-mine.json
"""
import json
import sys

import cv2
import numpy as np
import zxingcpp


def render(rows, scale=10, border=6):
    size = len(rows)
    dim = (size + border * 2) * scale
    img = np.full((dim, dim), 255, dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, bit in enumerate(row):
            if bit == "1":
                y0 = (y + border) * scale
                x0 = (x + border) * scale
                img[y0 : y0 + scale, x0 : x0 + scale] = 0
    return img


def decode_cv(img):
    det = cv2.QRCodeDetector()
    text, _points, _ = det.detectAndDecode(img)
    return text or None


def decode_zxing(img):
    results = zxingcpp.read_barcodes(img, formats=zxingcpp.BarcodeFormat.QRCode)
    if not results:
        return None
    return results[0].text or None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "logs/qr-mine.json"
    with open(path, encoding="utf-8") as fh:
        cases = json.load(fh)

    total = 0
    bad = []
    for case in cases:
        if "error" in case:
            continue
        total += 1
        img = render(case["rows"])
        got_cv = decode_cv(img)
        got_zx = decode_zxing(img)
        ok = case["text"] in (got_cv, got_zx)
        if not ok:
            bad.append((case["text"][:24], case["ecc"], case["mask"], case["version"], got_cv and got_cv[:20], got_zx and got_zx[:20]))

    print(f"解码验收 {total} 例：至少被一个解码器读回且内容一致 {total - len(bad)}，失败 {len(bad)}")
    for item in bad[:15]:
        print("  x", item)
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
