"""生成一个真正有效的 16x16 兜底托盘图标 PNG（纯 Python，不依赖 Pillow）。"""
import base64, io, os, struct, zlib

S = 16
R = 7.0
cx = cy = (S - 1) / 2.0
# Orb 的主色（鲸鱼娘的深蓝）
FG = (43, 74, 158)
BG = (0, 0, 0, 0)  # 透明

rows = []
for y in range(S):
    row = bytearray()
    row.append(0)  # filter type None
    for x in range(S):
        d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        if d <= R - 0.7:
            row += bytes(FG) + b'\xff'
        elif d <= R + 0.4:
            # 边缘抗锯齿
            a = max(0.0, min(1.0, (R + 0.4 - d) / 1.1))
            row += bytes(FG) + bytes([int(a * 255)])
        else:
            row += bytes(BG)
    rows.append(bytes(row))

raw = b''.join(rows)

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')

b64 = base64.b64encode(png).decode()
print("byte length:", len(png))
print("base64 length:", len(b64))
print("---BASE64---")
# 按 76 字符折行，方便粘贴进 JS 字符串数组
for i in range(0, len(b64), 76):
    print(b64[i:i+76])

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_fallback_icon.png"), "wb") as f:
    f.write(png)
print("written: probe/_fallback_icon.png")
