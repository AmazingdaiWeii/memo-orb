using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class OrbLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string electron = Path.Combine(root, @"runtime\electron\electron.exe");
        if (!File.Exists(electron))
        {
            string alt = Path.Combine(root, @"runtime\electron\orb-runtime.exe");
            if (File.Exists(alt)) electron = alt;
            else
            {
                MessageBox.Show(
                    "找不到 Electron 运行时：\r\n" + electron + "\r\n\r\n" +
                    "请确认解压时保留了 runtime 目录（不要只解压一部分文件）。",
                    "鲸鱼娘 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        if (!File.Exists(Path.Combine(root, @"src\launch.mjs")))
        {
            MessageBox.Show("找不到 src\\launch.mjs，压缩包可能没解压完整。", "鲸鱼娘 · 启动失败",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = electron,
            Arguments = "\"" + Path.Combine(root, @"src\launch.mjs") + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
        };
        psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";

        try
        {
            using (var p = Process.Start(psi))
            {
                if (p == null) return 1;
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("拉起运行时失败：\r\n" + ex.Message, "鲸鱼娘 · 启动失败",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
