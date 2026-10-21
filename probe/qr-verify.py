"""probe/qr-verify.py —— 用独立实现 segno 逐位比对 src/qr.mjs 的矩阵。

跑法：
    node probe/qr-verify.mjs
    python probe/qr-verify.py logs/qr-mine.json
"""
import json
import sys

import segno


def rows_from_segno(qr):
    return ["".join(str(bit) for bit in row) for row in qr.matrix_iter(scale=1, border=0)]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "logs/qr-mine.json"
    with open(path, encoding="utf-8") as fh:
        cases = json.load(fh)

    ok = 0
    fail = []
    for case in cases:
        if "error" in case:
            fail.append((case["text"][:30], case["ecc"], case["mask"], "mine-error: " + case["error"]))
            continue
        ref = segno.make(
            case["text"],
            error=case["ecc"],
            version=case["version"],
            mask=case["mask"],
            mode="byte",
            boost_error=False,
        )
        if ref.version != case["version"]:
            fail.append((case["text"][:30], case["ecc"], case["mask"], f"version {case['version']} vs segno {ref.version}"))
            continue
        ref_rows = rows_from_segno(ref)
        if ref_rows == case["rows"]:
            ok += 1
        else:
            # 指出第一处不同的坐标，方便定位
            where = None
            for y, (a, b) in enumerate(zip(case["rows"], ref_rows)):
                if a != b:
                    for x, (ca, cb) in enumerate(zip(a, b)):
                        if ca != cb:
                            where = (x, y)
                            break
                    break
            fail.append((case["text"][:30], case["ecc"], case["mask"], f"matrix differs at {where}"))

    print(f"对拍 {len(cases)} 例：一致 {ok}，不一致 {len(fail)}")
    for item in fail[:20]:
        print("  ✗", item)
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
