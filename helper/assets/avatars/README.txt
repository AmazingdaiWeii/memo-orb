本目录自带 6 张球形态（作者自制：smile / cheer / cheeks / heart / point / rice），
它们的托盘裁切参数已标定在 shell.js 的 TRAY_FACE_CROP 里。开源分发时想只留示例，
把这 6 张删掉即可，程序会自动回落 orb-idle.gif，不会报错。

把自己的 GIF 放进这个目录，环菜单「换形象」里就会自动出现，不需要改任何配置。

要求（不满足会被静默忽略）：
  · 文件名只能用小写英文字母、数字、下划线、连字符，扩展名 .gif
    例：ok → my-orb.gif / ball_2.gif      不行 → Ball.gif / 我的球.gif / orb final.gif
  · 正方形，建议 512×512（球实际只显示 72×72）
  · 主体居中、四周留 10~15% 空白（会被裁成圆形）
  · 第一帧就是「收起时的静止脸」，因为收起状态只显示第一帧
  · 建议 ≤2MB（体积大冷启动会卡）

托盘图标是从当前头像裁脸生成的。换成自己的图之后，如果托盘裁歪了，
改 helper/assets/shell.js 里的 TRAY_FACE_CROP（照 orb-idle.gif 那一行加一条）。
