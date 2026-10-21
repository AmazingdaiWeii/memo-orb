// 临时诊断脚本：列出 node 进程的 PID 与命令行，判断哪些是本项目的残留。
// wmic 在本机已不可用，改用 PowerShell 的 CIM 查询。
// 用完即可删。
import { execFileSync } from 'node:child_process'

const ps = `$ErrorActionPreference='Stop'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ForEach-Object { "$($_.ProcessId) :: $($_.CommandLine)" }
`

try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  )
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim()
    if (s) console.log(s.slice(0, 170))
  }
} catch (err) {
  console.log(`查询失败：${err.message}`)
}
