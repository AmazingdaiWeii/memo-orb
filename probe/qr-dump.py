"""probe/qr-dump.py —— 从「我方矩阵」与「segno 矩阵」里按标准扫描序抽出码字，逐字节对比。

用法：python probe/qr-dump.py [logs/qr-mine.json]
"""
import json
import sys

import segno

ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42]}

MASK = [
    lambda y, x: (y + x) % 2 == 0,
    lambda y, x: y % 2 == 0,
    lambda y, x: x % 3 == 0,
    lambda y, x: (y + x) % 3 == 0,
    lambda y, x: (y // 2 + x // 3) % 2 == 0,
    lambda y, x: (y * x) % 2 + (y * x) % 3 == 0,
    lambda y, x: ((y * x) % 2 + (y * x) % 3) % 2 == 0,
    lambda y, x: ((y + x) % 2 + (y * x) % 3) % 2 == 0,
]


def build_reserved(size, version):
    res = [[0] * size for _ in range(size)]

    def mark(y, x):
        if 0 <= y < size and 0 <= x < size:
            res[y][x] = 1

    for cy, cx in ((3, 3), (3, size - 4), (size - 4, 3)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                mark(cy + dy, cx + dx)

    centers = ALIGN.get(version, [])
    for cy in centers:
        for cx in centers:
            near = lambda a, b: abs(a - b) <= 2
            if (
                (near(cy, 6) and near(cx, 6))
                or (near(cy, 6) and near(cx, size - 7))
                or (near(cy, size - 7) and near(cx, 6))
            ):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    mark(cy + dy, cx + dx)

    for i in range(8, size - 8):
        mark(6, i)
        mark(i, 6)

    for i in range(6):
        mark(i, 8)
    mark(7, 8)
    mark(8, 8)
    mark(8, 7)
    for i in range(9, 15):
        mark(8, 14 - i)
    for i in range(8):
        mark(8, size - 1 - i)
    for i in range(8, 15):
        mark(size - 15 + i, 8)
    mark(size - 8, 8)
    return res


def extract(rows, size, version, mask):
    res = build_reserved(size, version)
    bits = []
    upward = True
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for i in range(size):
            y = size - 1 - i if upward else i
            for c in range(2):
                x = right - c
                if res[y][x]:
                    continue
                bits.append(rows[y][x] ^ (1 if MASK[mask](y, x) else 0))
        upward = not upward
        right -= 2
    return bits


def to_hex(bits):
    out = []
    for i in range(0, len(bits) - 7, 8):
        v = 0
        for b in bits[i : i + 8]:
            v = (v << 1) | b
        out.append("%02x" % v)
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "logs/qr-mine.json"
    with open(path, encoding="utf-8") as fh:
        cases = json.load(fh)

    for case in cases[:4]:
        if "error" in case:
            continue
        size, version, mask = case["size"], case["version"], case["mask"]
        mine_rows = [[int(ch) for ch in row] for row in case["rows"]]
        ref = segno.make(
            case["text"], error=case["ecc"], version=version, mask=mask, mode="byte", boost_error=False
        )
        ref_rows = [list(map(int, r)) for r in ref.matrix_iter(scale=1, border=0)]
        mine = to_hex(extract(mine_rows, size, version, mask))
        theirs = to_hex(extract(ref_rows, size, version, mask))
        print("── case", case["text"][:14], case["ecc"], "mask", mask, "v", version, "codewords", len(mine), len(theirs))
        print("  mine:", " ".join(mine))
        print("  ref :", " ".join(theirs))
        diff = [i for i, (a, b) in enumerate(zip(mine, theirs)) if a != b]
        print("  差异字节下标:", diff)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
