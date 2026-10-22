本目录自带 3 张自制球形态（本项目作者生成，随包可分发）：
  orb-A.gif      默认头像（环菜单里叫「orb-A（默认）」，也是球的第一帧）
  orb-idle.gif   早期示例球脸
  orb-pat.gif    摸头反应

此前随包的 6 张（smile / cheer / cheeks / heart / point / rice）经 md5 核对来自上游 dsh-orb，
未获再分发授权，已从左下的开源包里剔除；作者本机仓库里仍留着自用。

把自己的 GIF 放进这个目录，环菜单「换形象」里就会自动出现，不需要改任何配置。

要求（不满足会被静默忽略）：
  · 文件名用英文/数字/下划线/连字符，扩展名 .gif，大小写都行
    例：ok → my-orb.gif / orb-A.gif / ball_2.gif      不行 → 我的球.gif / orb final.gif
  · 正方形，建议 512×512（球实际只显示 72×72）
  · 主体居中、四周留 10~15% 空白（会被裁成圆形）
  · 第一帧就是「收起时的静止脸」，因为收起状态只显示第一帧
  · 建议 ≤2MB（体积大冷启动会卡；orb-A.gif 4.1MB 已属偏大）

托盘图标是从当前头像裁脸生成的。换成自己的图之后，如果托盘裁歪了，
改 helper/assets/shell.js 里的 TRAY_FACE_CROP（照 avatars/orb-A.gif 那一行加一条）。
