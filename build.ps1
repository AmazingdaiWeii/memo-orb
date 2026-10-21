# build.ps1 - Package Orb into portable release directory
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1 [-Root <项目根>] [-SkipDistCopy]
#
#   -Root        项目根目录，默认取脚本自身所在目录（不再硬编码盘符，
#                这样从 E:\Memo orb 或 D:\Orb 都能直接跑）。
#   -SkipDistCopy  只做「拷贝 + 生成 config + 泄漏检查」，跳过 runtime/node_modules
#                这些大目录的复制（本轮只改 config/泄漏逻辑、不想重拷 1GB 时用）。

param(
    [string]$Root = "",
    [switch]$SkipDistCopy,
    [switch]$LeakCheckOnly
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$root = $Root.TrimEnd('\')
$dist = "$root\dist"

# ============================================================
# 泄漏检查（抽成函数：主流程调用，也可用 -LeakCheckOnly 单独复审）
# 返回 $true = 通过；$false = 有泄漏（调用方决定 exit 1）
# ============================================================
function Test-DistLeak {
    param([string]$Dist)

    Write-Host "Leak check ..."

    $cfgPath = Join-Path $Dist "config.json"
    if (Test-Path $cfgPath) {
        $distCfg = Get-Content $cfgPath -Raw
        if ($distCfg -match 'agent-local-') {
            Write-Host "ERROR: dist/config.json 里还留着 agent id。中止。" -ForegroundColor Red
            return $false
        }
        if ($distCfg -match '(?i)[A-Z]:\\Users\\') {
            Write-Host "ERROR: dist/config.json 里出现本机绝对路径（含用户名）。中止。" -ForegroundColor Red
            return $false
        }
    }

    # 个人数据 / 运行态：任何一处出现在 dist 里都算泄漏
    foreach ($bad in @("logs", "exports", ".workbuddy", "locks.json", "personas")) {
        if (Test-Path (Join-Path $Dist $bad)) {
            Write-Host "ERROR: dist/$bad 不该随发布包分发。中止。" -ForegroundColor Red
            return $false
        }
    }

    # ★ 模型 / 立绘资源：记忆泄漏是尴尬，模型泄漏是法律问题（纪要 §6.5 / §17 #10）。
    #   将来用户导入的 VRM 立绘（别人买的、带授权的）若被打进发布包，是直接的版权风险。
    #   注意：helper/assets/avatars/*.gif 与 helper/assets/deco/*.gif 是**球自己的内置表情**，
    #   由 main.js 硬引用、运行时必需，属于程序资产，**不在拦截范围**（2026-10-08 修正：
    #   初版误把 avatars/ 也算进来，结果把自己的 build 拦了）。
    #   VRM 目录当前还不存在，检查写成「存在且非空即拦」，将来目录一出现就自动生效。
    $legalDirs = @("helper\assets\vrm")
    foreach ($d in $legalDirs) {
        $full = Join-Path $Dist $d
        if (Test-Path $full) {
            $n = (Get-ChildItem $full -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
            if ($n -gt 0) {
                Write-Host "ERROR: dist/$d 含 $n 个文件。VRM 立绘可能带第三方授权，" -ForegroundColor Red
                Write-Host "       不能随发布包分发。先确认授权范围，或把该目录加进豁免名单。" -ForegroundColor Red
                return $false
            }
        }
    }

    # 兜底：整个 dist 里扫一遍典型的个人标识串
    $hits = Get-ChildItem $Dist -Recurse -File -Include *.json,*.md,*.txt -ErrorAction SilentlyContinue |
            Select-String -Pattern 'agent-local-[0-9a-f]{8}' -List -ErrorAction SilentlyContinue
    if ($hits) {
        Write-Host "ERROR: dist 内这些文件含 agent id：" -ForegroundColor Red
        $hits | ForEach-Object { Write-Host ("       " + $_.Path) -ForegroundColor Red }
        return $false
    }

    Write-Host "Leak check passed (无 agent id / 无本机路径 / 无 logs·exports·locks / 无 personas / 无 vrm)" -ForegroundColor Green
    return $true
}

if ($LeakCheckOnly) {
    Write-Host "=== Orb Leak Check (only) ===" -ForegroundColor Cyan
    if (-not (Test-Path $dist)) { Write-Host "ERROR: dist/ 不存在。" -ForegroundColor Red; exit 1 }
    if (Test-DistLeak -Dist $dist) { exit 0 } else { exit 1 }
}

Write-Host "=== Orb Build Script ===" -ForegroundColor Cyan
Write-Host "Root: $root"

# 1. Clean old dist
if (Test-Path $dist) {
    Write-Host "Cleaning old dist/ ..."
    Remove-Item $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# 2. Copy directories
#
# ★ 不拷 deco-plan/ —— 它是「情绪素材的制作过程目录」（raw/ 原图、preview/ 预览、
#   output/ 成品、reference/ 参考），运行时不读它（只有 tools/copy-deco.mjs 和
#   probe/mood-test.mjs 这类工具读）。运行时要的是 helper/assets/deco/*.gif，
#   那 6 个文件已经在 helper/ 里了。
#   拷进去的代价：+56.7 MB，且 deco-plan/backup/src/main.mjs 里带着一个真实
#   conversation id（2026-10-08 审计发现）。
$dirs = @("runtime", "node_modules", "src", "helper")
if ($SkipDistCopy) {
    # 只补拷源码目录（极快），大目录 runtime/node_modules 假定已在 dist 里
    $dirs = @("src", "helper")
    Write-Host "-SkipDistCopy: 跳过 runtime/ 与 node_modules/（假定 dist 里已有）" -ForegroundColor Yellow
}
foreach ($d in $dirs) {
    $src = "$root\$d"
    if (Test-Path $src) {
        Write-Host "Copying $d/ ..."
        Copy-Item $src -Destination "$dist\$d" -Recurse -Force
    }
}

# 3. Copy root files
#
# ★ 别把开发机的 config.json 拷进去 —— 它带着自己的 agentId / legacyUrl，
#   发出去就等于「收件人一启动就接到我家 agent 上」。这里改成从
#   config.example.json 生成一份干净的（agentId=null / legacyUrl=null），
#   首次启动时 orb 会自己新建 agent 并把 persona 烤进 system。
$files = @("package.json", "package-lock.json")
foreach ($f in $files) {
    $src = "$root\$f"
    if (Test-Path $src) {
        Copy-Item $src -Destination "$dist\$f" -Force
    }
}

$exampleCfg = "$root\config.example.json"
if (-not (Test-Path $exampleCfg)) {
    Write-Host "ERROR: config.example.json is missing - refusing to ship a config with personal ids." -ForegroundColor Red
    exit 1
}
$shipCfg = Get-Content $exampleCfg -Raw | ConvertFrom-Json
$shipCfg.agentId = $null
$shipCfg.agents  = @{}
$shipCfg.legacyUrl = $null
# ★ 必须用 .NET 的 UTF8Encoding($false) 写 —— 不能沿用 PowerShell 的
#   `Set-Content -Encoding UTF8`：Windows PowerShell 5.1 下它会写 **带 BOM** 的
#   UTF-8，而 `JSON.parse` 遇到 BOM 直接抛错。后果是「用户改了 config.json 却
#   全部不生效」，只在日志留一行「解析失败」（已实测 + 已在 src/main.mjs 里加了
#   剥 BOM 兜底，但此处仍不该生产带 BOM 的文件）。
$json = $shipCfg | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$dist\config.json", $json, $utf8NoBom)
Write-Host "Wrote clean config.json (agentId=null, legacyUrl=null, no BOM) from config.example.json"

# 4. Create start.bat
$batLines = @(
    "@echo off",
    "chcp 65001 >nul",
    "cd /d ""%~dp0""",
    "echo Starting Orb...",
    "node src\launch.mjs",
    "if errorlevel 1 (",
    "    echo.",
    "    echo Start failed. Please ensure Node.js 22+ is installed.",
    "    pause",
    ")"
)
Set-Content -Path "$dist\start.bat" -Value $batLines -Encoding ASCII

# 5. Create README.txt
$readmeLines = @(
    "Orb - Desktop Floating Ball Assistant",
    "============================================",
    "",
    "QUICK START",
    "-----------",
    "Double-click start.bat to run.",
    "",
    "REQUIREMENTS",
    "------------",
    "- Windows 10/11",
    "- Node.js 22+ (for start.bat)",
    "",
    "CONFIGURATION",
    "-------------",
    "Edit config.json before first run:",
    "- model: model name (default: deepseek/deepseek-flash)",
    "- agentId: leave null to auto-create an agent on first run",
    "- legacyUrl: (optional) URL of an already-running legacy backend; leave null",
    "",
    "DIRECTORY STRUCTURE",
    "-------------------",
    "  start.bat       - Launcher",
    "  runtime/        - Electron runtime (bundled)",
    "  node_modules/   - Dependencies",
    "  src/            - Main process",
    "  helper/         - Renderer (incl. assets/deco/*.gif)",
    "  config.json     - Configuration",
    "",
    "TROUBLESHOOTING",
    "---------------",
    "Q: Nothing happens on double-click?",
    "A: Right-click start.bat -> Run as administrator, or check Node.js installation.",
    "",
    "Q: Cannot find electron.exe?",
    "A: Ensure runtime/electron/electron.exe exists.",
    "",
    "Q: Where is the API key stored?",
    "A: In data/providers/auth.json next to this app (plain text). Set it from the settings panel."
)
Set-Content -Path "$dist\README.txt" -Value $readmeLines -Encoding UTF8

# 6. Leak check (fail loudly rather than ship someone's data)
if (-not (Test-DistLeak -Dist $dist)) { exit 1 }

# 7. Report size
$size = (Get-ChildItem $dist -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Output: $dist"
Write-Host ("Total size: {0:N2} MB" -f ($size / 1MB))
Write-Host ""
Write-Host "To run: double-click dist\start.bat"
Write-Host ""
Write-Host "To build a double-clickable orb.exe, use the dedicated builder:"
Write-Host "  node tools/build-runtime.mjs --apply --dest D:\Orb"
Write-Host "  (zero npm dependencies - do NOT run npm install)"
