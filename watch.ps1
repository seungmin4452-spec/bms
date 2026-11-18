# 봇 진행 상황 실시간 보기
# 사용법: powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\SMSHIN\pigon-chat-bot\watch.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = $PSScriptRoot
$lock = Join-Path $root 'state\poll.lock'
$progress = Join-Path $root 'state\progress.log'

if (Test-Path $lock) {
  $botPid = (Get-Content $lock -Raw).Trim()
  $alive = Get-Process -Id $botPid -ErrorAction SilentlyContinue
  if ($alive) { Write-Host "봇 실행 중 (PID $botPid, 시작 $($alive.StartTime))" -ForegroundColor Green }
  else { Write-Host "lock 은 있으나 PID $botPid 종료됨 (다음 폴링에서 정리)" -ForegroundColor Yellow }
} else {
  Write-Host '지금 실행 중인 봇 없음. 마지막 실행 기록을 보여줍니다.' -ForegroundColor DarkGray
}
$info = Get-ScheduledTaskInfo -TaskName PigonChatBot -ErrorAction SilentlyContinue
if ($info) { Write-Host "다음 폴링: $($info.NextRunTime)" -ForegroundColor DarkGray }
Write-Host '---- 진행 로그 (Ctrl+C 로 종료) ----' -ForegroundColor DarkGray

if (-not (Test-Path $progress)) { New-Item -ItemType File $progress | Out-Null }
Get-Content $progress -Tail 60 -Wait -Encoding UTF8
