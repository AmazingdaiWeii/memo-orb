# perf-test.ps1 - Orb Performance Test
# Monitors CPU, Memory, GPU usage over time
# Usage: powershell -ExecutionPolicy Bypass -File perf-test.ps1 -Duration 300

param(
    [int]$Duration = 300,  # seconds
    [int]$Interval = 2,     # sample interval in seconds
    [string]$ProcessName = "node",  # main process name
    [string]$OutputFile = "perf-results.csv"
)

$ErrorActionPreference = "Continue"

Write-Host "=== Orb Performance Test ===" -ForegroundColor Cyan
Write-Host "Duration: $Duration seconds"
Write-Host "Interval: $Interval seconds"
Write-Host "Output: $OutputFile"
Write-Host ""

# Check for NVIDIA GPU
$hasNvidia = $false
try {
    $nvidia = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
    if ($nvidia) {
        $hasNvidia = $true
        Write-Host "GPU detected: $nvidia" -ForegroundColor Green
    }
} catch {
    Write-Host "No NVIDIA GPU detected (GPU monitoring skipped)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting monitoring in 3 seconds... (start the app now)" -ForegroundColor Yellow
Start-Sleep -Seconds 3

# CSV header
$header = "Timestamp,CPUPercent,MemoryMB,Handles,Threads,GPUUtilPercent,GPUMemoryMB"
Set-Content -Path $OutputFile -Value $header -Encoding UTF8

$samples = [math]::Floor($Duration / $Interval)
$startTime = Get-Date

for ($i = 0; $i -lt $samples; $i++) {
    $timestamp = Get-Date -Format "HH:mm:ss"
    
    # Get node processes (main + legacy server)
    $nodeProcs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    $electronProcs = Get-Process -Name "electron" -ErrorAction SilentlyContinue
    $allProcs = @($nodeProcs) + @($electronProcs) | Where-Object { $_ -ne $null }
    
    $cpuPercent = 0
    $memoryMB = 0
    $handles = 0
    $threads = 0
    
    if ($allProcs.Count -gt 0) {
        $cpuPercent = ($allProcs | Measure-Object -Property CPU -Sum).Sum
        # CPU percent needs to be calculated relative to elapsed time
        # For simplicity, use WorkingSet64 for memory
        $memoryMB = [math]::Round(($allProcs | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB, 1)
        $handles = ($allProcs | Measure-Object -Property HandleCount -Sum).Sum
        $threads = ($allProcs | Measure-Object -Property Threads -Sum).Sum
    }
    
    # GPU monitoring (NVIDIA only)
    $gpuUtil = 0
    $gpuMem = 0
    if ($hasNvidia) {
        try {
            $gpuData = & nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>$null
            if ($gpuData) {
                $parts = $gpuData -split ","
                $gpuUtil = [int]$parts[0].Trim()
                $gpuMem = [int]$parts[1].Trim()
            }
        } catch {}
    }
    
    $row = "$timestamp,$cpuPercent,$memoryMB,$handles,$threads,$gpuUtil,$gpuMem"
    Add-Content -Path $OutputFile -Value $row
    
    # Progress
    $elapsed = ((Get-Date) - $startTime).TotalSeconds
    $percent = [math]::Round(($elapsed / $Duration) * 100, 1)
    Write-Host "`r[$('=' * [math]::Floor($percent/2))$(' ' * (50 - [math]::Floor($percent/2)))] $percent%  CPU:${cpuPercent}%  MEM:${memoryMB}MB  GPU:${gpuUtil}%" -NoNewline
    
    Start-Sleep -Seconds $Interval
}

Write-Host ""
Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Green
Write-Host "Results saved to: $OutputFile"

# Generate summary
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$data = Import-Csv $OutputFile
$memValues = $data | ForEach-Object { [double]$_.MemoryMB }
$cpuValues = $data | ForEach-Object { [double]$_.CPUPercent }

Write-Host ("Memory - Min: {0:N1} MB, Max: {1:N1} MB, Avg: {2:N1} MB" -f ($memValues | Measure-Object -Minimum).Minimum, ($memValues | Measure-Object -Maximum).Maximum, ($memValues | Measure-Object -Average).Average)
Write-Host ("CPU - Min: {0:N1}%, Max: {1:N1}%, Avg: {2:N1}%" -f ($cpuValues | Measure-Object -Minimum).Minimum, ($cpuValues | Measure-Object -Maximum).Maximum, ($cpuValues | Measure-Object -Average).Average)

# Memory leak detection: compare first 10% vs last 10%
$earlyCount = [math]::Floor($data.Count * 0.1)
$lateCount = [math]::Floor($data.Count * 0.1)
$earlyAvg = ($data | Select-Object -First $earlyCount | ForEach-Object { [double]$_.MemoryMB } | Measure-Object -Average).Average
$lateAvg = ($data | Select-Object -Last $lateCount | ForEach-Object { [double]$_.MemoryMB } | Measure-Object -Average).Average
$memGrowth = $lateAvg - $earlyAvg

Write-Host ""
Write-Host "=== Memory Leak Check ===" -ForegroundColor Cyan
Write-Host ("Early avg (first 10%): {0:N1} MB" -f $earlyAvg)
Write-Host ("Late avg (last 10%): {0:N1} MB" -f $lateAvg)
Write-Host ("Growth: {0:N1} MB ({1:N1}%)" -f $memGrowth, ($memGrowth / $earlyAvg * 100))
if ($memGrowth -gt 50) {
    Write-Host "WARNING: Potential memory leak detected (growth > 50MB)" -ForegroundColor Red
} elseif ($memGrowth -gt 20) {
    Write-Host "NOTE: Moderate memory growth observed" -ForegroundColor Yellow
} else {
    Write-Host "OK: No significant memory leak detected" -ForegroundColor Green
}

Write-Host ""
Write-Host "To test window switching cache release:"
Write-Host "  1. Run this script in background"
Write-Host "  2. Rapidly open/close the dialog 20+ times"
Write-Host "  3. Check if memory returns to baseline after switching"
