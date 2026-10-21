from PIL import Image
import numpy as np
from collections import deque
import os

# 输入输出路径
src = r'E:\Memo orb\helper\assets\icon-source-clean.png'
out_png = r'E:\Memo orb\helper\assets\orb-icon.png'
out_ico = r'E:\Memo orb\helper\assets\orb-icon.ico'

# 读取图片
img = Image.open(src).convert('RGBA')
data = np.array(img)
h, w = data.shape[:2]
print(f"Source size: {w}x{h}")

# 白色背景 mask：接近纯白的像素
white_mask = (data[:,:,0] > 240) & (data[:,:,1] > 240) & (data[:,:,2] > 240)

# Flood fill 从边缘开始，只标记与边缘连通的白色区域
visited = np.zeros((h, w), dtype=bool)
queue = deque()

# 从四个边缘开始
for x in range(w):
    if white_mask[0, x]:
        queue.append((0, x))
        visited[0, x] = True
    if white_mask[h-1, x]:
        queue.append((h-1, x))
        visited[h-1, x] = True
for y in range(h):
    if white_mask[y, 0]:
        queue.append((y, 0))
        visited[y, 0] = True
    if white_mask[y, w-1]:
        queue.append((y, w-1))
        visited[y, w-1] = True

# BFS
count = 0
while queue:
    y, x = queue.popleft()
    count += 1
    for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
        ny, nx = y+dy, x+dx
        if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and white_mask[ny, nx]:
            visited[ny, nx] = True
            queue.append((ny, nx))

print(f"Flood fill visited {count} pixels (background white)")

# 将与边缘连通的白色区域设为透明
data[visited, 3] = 0

# 裁剪到非透明区域的边界
alpha = data[:,:,3]
rows = np.any(alpha > 0, axis=1)
cols = np.any(alpha > 0, axis=0)
if not np.any(rows) or not np.any(cols):
    print("ERROR: No non-transparent pixels found!")
    exit(1)

rmin, rmax = np.where(rows)[0][[0, -1]]
cmin, cmax = np.where(cols)[0][[0, -1]]

# 加 padding
pad = 15
rmin = max(0, rmin - pad)
rmax = min(h-1, rmax + pad)
cmin = max(0, cmin - pad)
cmax = min(w-1, cmax + pad)

cropped = data[rmin:rmax+1, cmin:cmax+1]
result = Image.fromarray(cropped, 'RGBA')
print(f"Cropped size: {result.size[0]}x{result.size[1]}")

# 保存透明 PNG
result.save(out_png)
print(f"Saved PNG: {out_png} ({os.path.getsize(out_png)} bytes)")

# 生成多尺寸 ICO（Windows 标准尺寸）
sizes = [(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)]
result.save(out_ico, format='ICO', sizes=sizes)
print(f"Saved ICO: {out_ico} ({os.path.getsize(out_ico)} bytes)")
print("Done!")
