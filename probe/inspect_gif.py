from PIL import Image
import os

d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "helper", "assets", "avatars")
for f in sorted(os.listdir(d)):
    if f.endswith(".gif"):
        p = os.path.join(d, f)
        im = Image.open(p)
        dur = im.info.get("duration", "?")
        print(f"{f:20s} size={im.size} frames={im.n_frames:3d} dur={dur}ms  {os.path.getsize(p)//1024}KB")
