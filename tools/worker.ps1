# Team View 워커 세션 실행기 (Windows PowerShell).
#
#   tools\worker.ps1 C:\dev\2026\PROJECT-TEMPLATE
#
# 감시 대상 폴더로 이동해 TEAMVIEW_WORKER=1을 세우고 claude를 띄운다.
# 이 환경변수가 붙은 세션만 `.claude/team-worker.json`에 클레임을 적고, 앱이 보낸
# 지시를 집어가고, 이벤트를 기록한다. 사람과 대화하는 세션과 앱 작업을 한 창에서
# 하다가 지시가 대화에 섞이고 그 세션의 도구 호출이 전부 팀뷰 화면에 찍혔다.
#
# 뒤에 붙인 인자는 claude에 그대로 넘어간다. 예: tools\worker.ps1 C:\proj --model opus

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ProjectDir,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) {
  Write-Host "폴더가 없습니다: $ProjectDir" -ForegroundColor Red
  exit 1
}

$root = (Resolve-Path -LiteralPath $ProjectDir).Path

# .claude가 없으면 훅이 조용히 빠져나가 아무것도 기록되지 않는다. 막지는 않되 알린다.
if (-not (Test-Path -LiteralPath (Join-Path $root '.claude') -PathType Container)) {
  Write-Host "경고: '$root'에 .claude 폴더가 없습니다. 훅이 설치된 프로젝트가 맞는지 확인하세요." -ForegroundColor Yellow
}

Set-Location -LiteralPath $root
$env:TEAMVIEW_WORKER = '1'

Write-Host "Team View 워커 세션 — $root" -ForegroundColor Cyan
Write-Host "이 창은 앱 전용입니다. 사람과의 대화는 다른 창에서 하세요." -ForegroundColor DarkGray

if ($ClaudeArgs) { claude @ClaudeArgs } else { claude }
