// 비개발자 PC에 필요한 프로그램을 대신 깔아 주는 부분.
//
// main.js가 이미 180KB다. 설치는 성격이 다른 일이고(외부 명령·레지스트리·검증),
// 무엇보다 **검사에서 통째로 불러올 수 있어야** 해서 따로 뒀다. 이 파일은
// electron을 부르지 않는다 — `node -e "require('./install.js')"`로 그냥 열린다.
// 그래서 tools/check-logic.js가 원본 그대로를 실행해 확인할 수 있다.
//
// ── 이 파일의 전제는 전부 실측이다(2026-08, Windows 11 / winget v1.29.280) ──
//
// 1. **Claude Code는 Node가 필요 없다.** 공식 설치 스크립트
//    `https://claude.ai/install.ps1`(→ downloads.claude.ai/.../bootstrap.ps1)는
//    PowerShell만 쓴다: Invoke-RestMethod로 버전·manifest를 받고, claude.exe를
//    내려받아 SHA256을 맞춰 보고, `claude.exe install`로 런처를 앉힌다.
//    npm도 node도 등장하지 않는다. 그래서 REQUIREMENTS에서 Node를 뺐다 —
//    비개발자에게 "런타임을 먼저 까세요"라고 말할 이유가 사라졌다.
//
// 2. **winget 포터블은 이 PC에서 PATH에 안 잡힐 수 있다.** winget은 포터블 패키지를
//    풀고 `%LOCALAPPDATA%\Microsoft\WinGet\Links`에 심볼릭 링크를 건다. 그런데
//    심볼릭 링크는 관리자이거나 개발자 모드일 때만 만들 수 있다. 실측:
//        New-Item -ItemType SymbolicLink → "이 작업에는 관리자 권한이 필요합니다"
//    비개발자 PC의 기본값이 바로 이 상태다(개발자 모드 꺼짐, 관리자 아님).
//    winget은 그래도 **exit 0을 준다.** 깔렸는데 없다고 나오는 바로 그 상황이다.
//    → 그래서 exit 0을 믿지 않고, 링크가 실패했으면 우리가 PATH를 고친다(repairPortablePath).
//
// 3. **`\WindowsApps\` 경로를 스토어 스텁으로 몰아서 막으면 틀린다.** 실측한 이 PC의
//    `where python` 첫 줄은 `...\WindowsApps\python.exe`인데, 이건 스텁이 아니라
//    **정상 동작하는 스토어판 Python 3.13.14**다(훅을 끝까지 돌려 이벤트 줄까지 썼다).
//    경로로 판단했으면 멀쩡한 python을 없다고 했을 것이다.
//    → 경로가 아니라 **행동으로 판단한다.** 진짜 훅을 한 번 돌려 결과 파일이
//      생기는지 본다. 스텁은 그걸 못 한다.

const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 무인 설치가 5분을 넘기면 실패로 본다. 아무도 안 보고 있으므로 영원히 기다리면 안 된다. */
const INSTALL_TIMEOUT_MS = 5 * 60_000

/**
 * 관리자 확인 창(UAC)이 뜨는 설치는 더 기다린다.
 *
 * 근거: Python 3.13은 **burn 번들**이다. (1) 번들이 자기 손으로 페이로드를 더
 * 내려받고, (2) `--scope user`로 걸어도 UAC 확인 창이 뜬다. UAC 창은 **사람이
 * 누를 때까지 설치를 붙잡는다** — 그 시간까지 5분 안에 욱여넣으면, 사용자가 창을
 * 못 보고 있던 1~2분 때문에 멀쩡한 설치가 "5분 안에 끝나지 않았습니다"로 끊긴다.
 * 끊는 쪽이 이제 트리째 죽이므로(killTree) 잘못 끊는 비용이 예전보다 크다.
 * 그래서 UAC를 예고하는 항목(needsAdmin)만 10분으로 둔다. 나머지는 그대로 5분이다.
 */
const ADMIN_INSTALL_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 20_000
const REG_TIMEOUT_MS = 20_000

/**
 * 무인 설치 플래그. **넷 다 없으면 안 된다.**
 *
 * 하나라도 빠지면 winget이 "원본 계약에 동의하십니까?"를 묻고 **입력을 기다리며 멈춘다.**
 * 우리는 창 없이 돌리므로 그 물음을 볼 사람이 없다 — 5분 타임아웃까지 그냥 서 있는다.
 * 그래서 이 배열은 상수로 못 박고 check-logic이 매번 확인한다.
 */
const SILENT_FLAGS = [
  '--silent',
  '--accept-source-agreements',
  '--accept-package-agreements',
  '--disable-interactivity',
]

/** 명령을 찾을 수 없다는 응답인가. 셸·언어마다 문구가 달라 넓게 본다. */
const NOT_FOUND =
  /not recognized|command not found|ENOENT|없는 명령|찾을 수 없습니다|is not recognized|was not found/i

/** 패키지 id는 우리 목록에서만 온다. 그래도 명령줄에 넣기 전에 한 번 더 본다. */
const SAFE_PKG_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/

// ---------------------------------------------------------------------------
// 명령 실행
// ---------------------------------------------------------------------------

/**
 * 명령을 한 번 돌린다. **던지지 않는다** — 설치 실패가 앱을 멈추면 안 된다.
 *
 * `shell`은 부르는 쪽이 정한다. 이게 중요한데, 실측으로 둘이 갈렸다:
 *   · `claude`는 npm 설치본이 `claude.cmd`라 shell 없이는 ENOENT다 → 탐지는 shell:true
 *   · `winget`·`reg`는 실행 파일이라 shell 없이 돈다 → 인용 사고가 없는 shell:false
 * 설치·레지스트리처럼 **문자열을 만드는 쪽은 셸을 태우지 않는다.**
 */
function run(cmd, args, { timeoutMs = PROBE_TIMEOUT_MS, shell = false, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { shell, cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 22 },
      (err, stdout, stderr) =>
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
          timedOut: Boolean(err && err.killed),
          out: String(stdout ?? ''),
          errOut: String(stderr ?? ''),
        }),
    )
  })
}

/** stdin으로 무언가를 흘려 넣어야 하는 명령(훅은 훅 JSON을 stdin으로 받는다). */
function runWithStdin(cmd, args, input, { timeoutMs = PROBE_TIMEOUT_MS, cwd, env, shell = false } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, shell })
    } catch (e) {
      return finish({ code: -1, timedOut: false, out: '', errOut: String(e.message) })
    }
    let out = ''
    let errOut = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 이미 죽었으면 그만이다 */
      }
      finish({ code: -1, timedOut: true, out, errOut })
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (errOut += d))
    child.on('error', (e) => finish({ code: -1, timedOut: false, out, errOut: String(e.message) }))
    child.on('close', (code) => finish({ code: code ?? -1, timedOut: false, out, errOut }))
    try {
      child.stdin.end(input)
    } catch {
      /* 상대가 stdin을 안 읽고 끝냈을 수 있다. close에서 결과를 받는다. */
    }
  })
}

/**
 * PowerShell을 **절대 경로로** 찾는다.
 *
 * PATH에서 찾으면 안 된다. 이 함수를 쓰는 쪽이 하는 일이 바로 "PATH가 낡았거나
 * 망가졌을 때 고치는 것"이라, PATH에 기대면 정작 필요할 때 못 쓴다.
 * (검사에서 PATH를 비워 두고 불러 보니 실제로 ENOENT로 실패했다.)
 */
function powerShellPath() {
  return systemExe(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell')
}

/** System32 아래의 실행 파일을 절대 경로로. 못 찾으면 이름으로라도 시도해 본다. */
function systemExe(rel, fallback) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const abs = path.join(root, 'System32', rel)
  try {
    if (fs.existsSync(abs)) return abs
  } catch {
    // 볼 수 없으면 이름으로라도 시도해 본다
  }
  return fallback
}

/**
 * 프로세스를 **트리째** 죽인다.
 *
 * `child.kill()`은 윈도우에서 직계 자식만 죽인다. winget이 띄운 msiexec이나
 * burn 번들(Python 3.13이 burn이다)은 그대로 살아남아 설치를 계속한다. 사용자가
 * [다시 시도]를 누르면 설치 프로그램 두 개가 같은 파일을 두고 겹친다.
 *
 * **pid로만 죽인다.** 창 제목으로 찾으면 안 된다 — 이 저장소가 예전에 그 방식으로
 * 사용자의 WindowsTerminal을 통째로 죽일 뻔했다(같은 제목의 남의 창을 잡았다).
 */
function killTree(child) {
  const pid = child && child.pid
  const fallback = () => {
    try {
      child.kill()
    } catch {
      /* 이미 죽었으면 그만이다 */
    }
  }
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return fallback()
  try {
    execFile(
      systemExe('taskkill.exe', 'taskkill'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 15_000 },
      (err) => {
        // taskkill이 없거나 권한이 모자라면 적어도 직계 자식은 끊는다.
        if (err) fallback()
      },
    )
  } catch {
    fallback()
  }
}

/**
 * PowerShell 한 줄을 돌린다.
 *
 * 출력 인코딩을 **스크립트 안에서** UTF-8로 고정한다. 실측: powershell이 뱉는 한국어
 * 오류가 그냥은 CP949로 나와 깨졌다(`reg query`도 마찬가지였다). 깨진 글자를 사용자에게
 * 보여 주면 원인을 물어볼 수도 없다.
 * (winget은 파이프로 받으면 스스로 UTF-8을 쓴다 — 실측 확인. 그래서 감싸지 않는다.)
 */
function runPowerShell(script, { timeoutMs = REG_TIMEOUT_MS } = {}) {
  const prefixed = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; " + script
  return run(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', prefixed], { timeoutMs })
}

// ---------------------------------------------------------------------------
// winget이 있는가
// ---------------------------------------------------------------------------

/**
 * 이 PC가 자동 설치를 할 수 있는가.
 *
 * **없는 것은 고장이 아니다.** 회사 PC는 그룹 정책으로 winget을 막아 두는 일이 흔하고,
 * 윈도우가 낡으면 애초에 없다. 그런 PC도 정상 경로다 — 화면은 다운로드 안내로 바뀐다.
 */
async function detectWinget() {
  const res = await run('winget', ['--version'], { timeoutMs: 15_000 })
  const m = /v?(\d+\.\d+[\w.-]*)/.exec(String(res.out).trim())
  const ok = res.code === 0 && Boolean(m)
  return { winget: ok, version: ok ? m[1] : null }
}

// ---------------------------------------------------------------------------
// PATH 다시 읽기
// ---------------------------------------------------------------------------

/**
 * 레지스트리에서 진짜 PATH를 읽는다.
 *
 * **앱이 켜질 때 물려받은 PATH는 설치가 끝나도 그대로다.** 윈도우는 이미 떠 있는
 * 프로세스의 환경을 고쳐 주지 않는다. 그래서 방금 깐 프로그램이 앱 눈에는 영원히
 * 안 보인다 — 깔고도 "없습니다"가 뜨는 그 자리이고, 비개발자가 가장 잘 포기하는 곳이다.
 *
 * `[Environment]::GetEnvironmentVariable(...,'User'|'Machine')`을 쓰는 이유는
 * REG_EXPAND_SZ의 `%VAR%`를 알아서 풀어 주기 때문이다. `reg query`로 읽으면 우리가
 * 직접 풀어야 하고, 게다가 출력이 콘솔 코드페이지라 한글 사용자명이 깨진다(실측).
 */
async function readRegistryPath() {
  const res = await runPowerShell(
    [
      "$u=[Environment]::GetEnvironmentVariable('Path','User')",
      "$m=[Environment]::GetEnvironmentVariable('Path','Machine')",
      "Write-Output ('MACHINE=' + $m)",
      "Write-Output ('USER=' + $u)",
    ].join('; '),
  )
  if (res.code !== 0) return { ok: false, machine: null, user: null }
  const pick = (tag) => {
    const line = String(res.out)
      .split(/\r?\n/)
      .find((l) => l.startsWith(tag + '='))
    return line == null ? null : line.slice(tag.length + 1).trim()
  }
  return { ok: true, machine: pick('MACHINE'), user: pick('USER') }
}

/** `a;b;;c` → ['a','b','c']. 빈 칸과 꼬리 백슬래시 차이는 같은 경로로 본다. */
function splitPath(s) {
  return String(s ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
}

/** 대소문자·꼬리 슬래시를 무시한 비교용 열쇠. 윈도우 경로는 대소문자를 안 가린다. */
function pathKey(p) {
  return String(p).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * `process.env.PATH`를 레지스트리 기준으로 다시 만든다.
 *
 * **아무것도 잃지 않는다.** 레지스트리에 있는 것(머신 → 유저 순, 윈도우가 합치는 순서)을
 * 앞에 두고, 지금 프로세스에만 있던 항목은 뒤에 붙여 둔다. Electron이나 우리가 방금
 * 끼워 넣은 경로를 갱신이 지워 버리면, 고치려던 문제를 갱신이 다시 만든다.
 */
async function refreshPath() {
  const before = String(process.env.PATH ?? '')
  const reg = await readRegistryPath()
  if (!reg.ok) return { ok: false, changed: false, error: '환경 변수를 읽지 못했습니다' }

  const seen = new Set()
  const merged = []
  const push = (p) => {
    const k = pathKey(p)
    if (!k || seen.has(k)) return
    seen.add(k)
    merged.push(p)
  }
  for (const p of splitPath(reg.machine)) push(p)
  for (const p of splitPath(reg.user)) push(p)
  // 레지스트리에 없지만 지금 프로세스에 있던 것들(잃으면 안 된다)
  for (const p of splitPath(before)) push(p)

  const next = merged.join(';')
  process.env.PATH = next
  // Windows의 환경 변수는 대소문자를 안 가리지만 node의 process.env는 가린다.
  // `Path`로 들어와 있는 경우가 있어 같이 맞춰 준다(안 맞추면 자식이 옛 PATH를 본다).
  if (Object.prototype.hasOwnProperty.call(process.env, 'Path')) process.env.Path = next

  // **집합으로 견준다.** 문자열로 견주면 순서나 꼬리 백슬래시만 달라도 "바뀌었다"가
  // 된다 — 우리가 머신·유저 순으로 다시 세우므로 거의 매번 참이었다. 그러면 화면은
  // 아무것도 안 생겼는데 "다시 켜세요"를 되풀이한다.
  // (merged는 before의 항목을 하나도 버리지 않으므로 before ⊆ seen이다. 그래서
  //  크기만 같으면 두 집합은 같다.)
  const beforeKeys = new Set(splitPath(before).map(pathKey))
  const changed = beforeKeys.size !== seen.size
  return { ok: true, changed, count: merged.length }
}

/**
 * 사용자 PATH(HKCU)에 폴더 하나를 덧붙인다. **관리자 권한이 필요 없다.**
 *
 * 여기까지 오는 경우는 하나뿐이다: winget이 포터블을 풀어 놓고 심볼릭 링크를 못 걸어
 * 아무 데서도 안 보일 때. 프로세스 PATH만 고치면 앱을 끄는 순간 도로 사라진다 —
 * 다음에 켜면 또 "없습니다"가 뜬다. 그래서 남긴다.
 *
 * 규칙: **덧붙이기만 한다.** 지우지 않고, 못 읽으면 아예 쓰지 않는다.
 * 남의 PATH를 날리는 것은 설치 실패보다 훨씬 나쁘다.
 *
 * 읽기와 쓰기는 **한 PowerShell 안에서** 끝낸다. 예전에는 둘을 따로 돌렸는데,
 * 그 사이(프로세스 두 번 = 수백 ms)에 남이 HKCU Path를 바꾸면 우리가 읽어 둔
 * 낡은 값으로 덮어써서 그 변경이 사라진다. 하필 이 함수가 불리는 자리가
 * **winget 포터블 설치 직후**다 — winget이 Path를 만지는 바로 그 순간이다.
 */
async function persistUserPath(dir) {
  if (!dir || typeof dir !== 'string') return { ok: false, error: '경로가 없습니다' }

  // 값은 인용 사고가 나기 쉬운 자리라 **명령줄에 넣지 않고** base64로 건넨다.
  // (경로에 `;` `'` `%` `&`가 섞여도 명령줄 파싱에 걸리지 않는다.)
  const b64 = Buffer.from(dir, 'utf8').toString('base64')
  const res = await runPowerShell(
    [
      `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
      "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
      "if($k -eq $null){ Write-Output 'ERR=no-key'; exit 0 }",
      // 원본 그대로 읽는다(DoNotExpandEnvironmentNames). 풀어서 다시 쓰면 사용자의
      // `%USERPROFILE%\...` 같은 항목이 고정 경로로 굳어 버린다.
      "$cur=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "if($cur -eq $null){ $cur='' }",
      // 대소문자·꼬리 슬래시를 무시하고 견준다(JS의 pathKey와 같은 규칙이다).
      "$parts=@($cur -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })",
      "$keys=@($parts | ForEach-Object { $_.TrimEnd('\\','/').ToLowerInvariant() })",
      "if($keys -contains $d.Trim().TrimEnd('\\','/').ToLowerInvariant()){ Write-Output 'ALREADY'; exit 0 }",
      "$next=(($parts + $d) -join ';')",
      // 레지스트리 문자열 한계에 가까워지면 손대지 않는다. 넘치면 PATH가 잘려
      // 사용자의 다른 프로그램이 통째로 안 보이게 된다.
      "if($next.Length -gt 8000){ Write-Output 'TOOLONG'; exit 0 }",
      // ExpandString으로 써야 기존 `%VAR%` 항목이 계속 풀린다. 기본값(String)으로
      // 쓰면 REG_SZ가 돼 사용자의 `%USERPROFILE%` 항목이 문자 그대로 굳는다.
      "$k.SetValue('Path',$next,[Microsoft.Win32.RegistryValueKind]::ExpandString)",
      '$k.Close()',
      "Write-Output 'OK'",
    ].join('; '),
  )
  const out = String(res.out)
  if (/(^|\n)\s*ALREADY\s*(\r?\n|$)/.test(out)) return { ok: true, already: true }
  if (/(^|\n)\s*TOOLONG\s*(\r?\n|$)/.test(out)) {
    return { ok: false, error: 'PATH가 너무 길어 덧붙이지 않았습니다' }
  }
  if (/ERR=no-key/.test(out)) return { ok: false, error: '현재 PATH를 읽지 못했습니다' }
  if (res.code !== 0 || !/(^|\n)\s*OK\s*(\r?\n|$)/.test(out)) {
    return { ok: false, error: 'PATH에 폴더를 추가하지 못했습니다' }
  }
  return { ok: true, added: dir }
}

// ---------------------------------------------------------------------------
// winget 포터블이 PATH에 안 잡혔을 때 고치기
// ---------------------------------------------------------------------------

/** winget이 포터블 패키지를 푸는 곳들. */
function portableRoots() {
  const la = process.env.LOCALAPPDATA
  if (!la) return []
  return [path.join(la, 'Microsoft', 'WinGet', 'Packages'), path.join(la, 'Microsoft', 'WinGet', 'Links')]
}

/**
 * 풀려 있는 폴더에서 실행 파일을 찾는다. 깊이를 막아 둔다 — 못 찾을 때
 * 디스크를 훑고 앉아 있으면 설치가 끝나도 화면이 안 넘어간다.
 */
function findExeUnder(root, exeName, depth = 4) {
  if (depth < 0) return null
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null // 없거나 권한이 없으면 그냥 못 찾은 것이다
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === exeName.toLowerCase()) return path.join(root, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = findExeUnder(path.join(root, e.name), exeName, depth - 1)
    if (hit) return hit
  }
  return null
}

/**
 * "깔리긴 했는데 아무 데서도 안 보이는" 상태를 고친다.
 *
 * 개발자 모드가 꺼진 PC에서 winget 포터블은 심볼릭 링크를 못 만든다(실측). winget은
 * 그래도 exit 0을 준다. 파일은 `%LOCALAPPDATA%\Microsoft\WinGet\Packages\<id>_...\`에
 * 멀쩡히 있으므로, 우리가 그 폴더를 PATH에 넣어 주면 그대로 쓸 수 있다.
 */
async function repairPortablePath(spec) {
  const exeName = spec.auto && spec.auto.portableExe
  const pkg = spec.auto && spec.auto.pkg
  if (!exeName || !pkg) return { ok: false, reason: 'portable-not-applicable' }

  for (const root of portableRoots()) {
    let names
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of names) {
      // winget은 `Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe` 식으로 푼다.
      if (!d.isDirectory()) continue
      const lower = d.name.toLowerCase()
      if (lower !== pkg.toLowerCase() && !lower.startsWith(pkg.toLowerCase() + '_')) continue
      const exe = findExeUnder(path.join(root, d.name), exeName)
      if (!exe) continue
      const dir = path.dirname(exe)
      // 이번 실행에서 바로 쓸 수 있게 앞에 붙이고,
      process.env.PATH = dir + ';' + String(process.env.PATH ?? '')
      if (Object.prototype.hasOwnProperty.call(process.env, 'Path')) process.env.Path = process.env.PATH
      // 다음에 앱을 켰을 때도 보이도록 남긴다.
      const kept = await persistUserPath(dir)
      return { ok: true, dir, exe, persisted: Boolean(kept.ok) }
    }
  }
  return { ok: false, reason: 'not-found-on-disk' }
}

// ---------------------------------------------------------------------------
// 검증 — **이 파일에서 제일 중요한 부분**
// ---------------------------------------------------------------------------

/**
 * 실제로 돌려 보고 버전 문자열을 받아 낸다.
 *
 * `shell: true`인 이유: npm으로 깐 `claude`는 `claude.cmd`라 셸 없이는 ENOENT다(실측).
 */
async function probeVersion(spec) {
  const [cmd, args] = spec.probe
  const res = await run(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS, shell: true })
  const text = `${res.out}\n${res.errOut}`
  if (NOT_FOUND.test(text)) return { ok: false, version: null, why: '명령을 찾지 못했습니다' }
  const m = spec.versionRe.exec(text)
  if (!m) {
    // exit 0이어도 버전이 안 나오면 통과시키지 않는다. 스토어 스텁이 딱 이렇게 군다.
    return { ok: false, version: null, why: '버전을 확인하지 못했습니다' }
  }
  return { ok: true, version: m[1] }
}

/**
 * **python이 진짜 우리 훅을 돌릴 수 있는가.** 버전이 찍히는 것만으로는 모자라다.
 *
 * 훅은 규칙상 무슨 일이 있어도 exit 0으로 끝난다(개발을 막으면 안 되니까). 뒤집으면
 * **훅이 아무 일도 못 했어도 조용히 성공처럼 보인다.** 새 PC에서 python 자리에
 * 마이크로소프트 스토어 스텁이 잡히면 훅은 매번 헛돌고, 화면은 텅 빈 채로
 * 아무도 이유를 모른다. 사무실이 조용해지는데 아무도 고장이라고 말해 주지 않는다.
 *
 * 그래서 **눈에 보이는 흔적**을 요구한다: 임시 폴더에 진짜 훅을 한 번 돌려서
 * `team-events.jsonl`에 우리가 심은 임의 표식이 적혀 나와야 통과다.
 * 스텁은 이걸 흉내 낼 수 없다.
 *
 * 경로로 거르지 않는 이유는 실측 때문이다 — 이 PC의 `where python` 첫 줄은
 * `...\WindowsApps\python.exe`인데 스텁이 아니라 정상 스토어판이고, 이 검사를 통과한다.
 * 경로를 막았으면 멀쩡한 python을 없다고 했을 것이다.
 *
 * **원본을 읽어 사본을 돌린다.** 설치본에서 훅은 `app.asar` 안에 있는데, asar는
 * Electron이 fs를 패치해 줘야만 보이는 가짜 폴더다. `fs.existsSync`는 true를 주지만
 * **spawn된 python은 asar 안을 못 연다** — 실측:
 *     python: can't open file '...\resources\app.asar\hooks\team_events.py': [Errno 2]
 * 그래서 설치본에서는 python 검증이 **항상** 실패했다. 사용자는 Python을 깔고 또 깔아도
 * "훅이 아무것도 기록하지 못했습니다"를 보고 마법사에 갇힌다.
 * `fs.readFileSync`는 asar 안에서도 정상 동작하므로, 읽어서 검사용 폴더에 써 놓고
 * 그 사본을 돌린다. (빌드 설정(asarUnpack)에 기대지 않고, 사용자 폴더도 건드리지 않는다.)
 */
async function verifyHookRuns(spec, { hookPath } = {}) {
  let source
  try {
    // asar 안이어도 읽힌다(Electron이 fs를 패치한다). 못 읽으면 그때가 진짜 "없음"이다.
    source = fs.readFileSync(hookPath)
  } catch {
    return { ok: false, why: '훅 파일을 찾지 못했습니다' }
  }
  const token = 'teamview-probe-' + crypto.randomBytes(4).toString('hex')
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'teamview-verify-'))
  try {
    // 훅은 `.claude`가 있는 곳만 자기 프로젝트로 본다. 없으면 조용히 돌아가 버려서
    // 검사가 "성공"과 구별되지 않는다.
    fs.mkdirSync(path.join(lab, '.claude'), { recursive: true })
    const payload = JSON.stringify({
      session_id: token,
      cwd: lab,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ' + token },
    })
    // **셸을 태워야 한다.** python이 `.bat`/`.cmd` 껍데기인 설치본이 있다(pyenv-win).
    // 셸 없이 부르면 CreateProcess가 `.exe`만 찾아 ENOENT가 나고, 멀쩡한 python을
    // "훅을 실행하지 못했습니다"로 몰아붙이게 된다. probeVersion도 같은 이유로 셸을 쓴다.
    //
    // 셸을 쓰면 인용이 문제가 된다 — Node는 shell:true일 때 인자를 대신 감싸 주지 않는다.
    // 그래서 **경로를 명령줄에 싣지 않는다.** cwd를 사본이 있는 폴더로 두고 이름만
    // 넘긴다(`team_events.py` — 공백도 특수문자도 없다). 임시 폴더 경로에 공백이나
    // 한글이 있어도 cwd는 명령줄이 아니라 spawn 옵션으로 가므로 안전하다.
    //
    // 이름은 우리가 정한다 — 원본 이름이 이상하면 그대로 쓰지 않는다(인용 사고 방지).
    const hookName = /^[\w.-]+$/.test(path.basename(hookPath)) ? path.basename(hookPath) : 'team_events.py'
    fs.writeFileSync(path.join(lab, hookName), source)
    const res = await runWithStdin(spec.probe[0], [hookName, 'pre'], payload, {
      timeoutMs: PROBE_TIMEOUT_MS,
      shell: true,
      cwd: lab,
      // 훅은 CLAUDE_PROJECT_DIR을 cwd보다 먼저 믿는다. 검사용 폴더로 못 박아 둬야
      // 사용자의 진짜 프로젝트에 검사 흔적이 섞이지 않는다.
      env: { ...process.env, CLAUDE_PROJECT_DIR: lab },
    })
    if (res.code !== 0) return { ok: false, why: 'python이 훅을 실행하지 못했습니다' }

    const log = path.join(lab, '.claude', 'team-events.jsonl')
    if (!fs.existsSync(log)) return { ok: false, why: '훅이 아무것도 기록하지 못했습니다' }
    const body = fs.readFileSync(log, 'utf8')
    if (!body.includes(token)) return { ok: false, why: '훅 기록에 확인 표식이 없습니다' }
    return { ok: true }
  } catch (e) {
    return { ok: false, why: '훅 확인 중 오류: ' + e.message }
  } finally {
    try {
      fs.rmSync(lab, { recursive: true, force: true })
    } catch {
      // 임시 폴더 하나 못 지운 것으로 설치를 실패시킬 이유는 없다.
    }
  }
}

/**
 * "깔렸다"고 말해도 되는가. **winget의 exit 0은 근거가 아니다.**
 *
 * 순서가 곧 규칙이다:
 *   1. PATH를 레지스트리에서 다시 읽는다 (안 하면 방금 깐 것이 안 보인다)
 *   2. 실제로 실행해 버전 문자열을 받는다
 *   3. python은 한 단계 더 — 진짜 훅이 돌아 기록을 남기는지 본다
 * 셋 다 지나야 verified: true다.
 *
 * 1번은 **부르는 쪽이 끌 수 있다**(`refreshPath: false`). 여러 항목을 잇달아 보는
 * 쪽(checkRequirements)이 항목마다 켜 두면 레지스트리 조회가 항목 수만큼 돈다 —
 * 실측으로 PowerShell이 앱 시작마다 네 번 떴다. 그 사이에 아무것도 설치되지 않으므로
 * 앞에서 한 번만 읽으면 된다. 설치 직후처럼 정말 다시 읽어야 하는 자리는 기본값(켬)이다.
 */
async function verifyInstalled(spec, opts = {}) {
  if (opts.refreshPath !== false) await refreshPath()
  let hit = await probeVersion(spec)

  // 아직 안 보이면, 포터블이 링크를 못 걸었을 수 있다. 파일을 직접 찾아 PATH를 고친 뒤 한 번 더.
  let repaired = null
  if (!hit.ok && spec.auto && spec.auto.portableExe) {
    repaired = await repairPortablePath(spec)
    if (repaired.ok) hit = await probeVersion(spec)
  }
  if (!hit.ok) return { verified: false, version: null, why: hit.why, repaired }

  if (spec.deepVerify === 'hook') {
    const deep = await verifyHookRuns(spec, opts)
    if (!deep.ok) return { verified: false, version: hit.version, why: deep.why, repaired }
  }
  return { verified: true, version: hit.version, repaired }
}

// ---------------------------------------------------------------------------
// 설치
// ---------------------------------------------------------------------------

/** winget 설치 인자. 상수 조합만 들어간다 — 사용자가 준 문자열은 여기 닿지 않는다. */
function wingetArgs(auto) {
  if (!SAFE_PKG_ID.test(String(auto.pkg))) throw new Error('패키지 id가 올바르지 않습니다')
  const args = ['install', '--id', auto.pkg, '--exact', '--source', 'winget']
  if (auto.scope) args.push('--scope', auto.scope)
  return args.concat(SILENT_FLAGS)
}

/** 동의 화면에 그대로 띄울 명령 문자열. 사람이 무엇이 도는지 볼 수 있어야 한다. */
function commandText(auto) {
  if (auto.method === 'winget') return 'winget ' + wingetArgs(auto).join(' ')
  if (auto.method === 'script') return auto.command
  return null
}

/**
 * 설치 프로그램을 돌리며 진행 단계를 흘려보낸다.
 *
 * `timeoutMs`를 받는 이유: 5분을 기다리는 검사는 아무도 안 돌린다. 검사에서 짧게
 * 줄여 **타임아웃이 실제로 걸리는지** 확인할 수 있어야 한다. 기본값은 그대로 5분이다.
 */
function runInstaller(auto, onTick, timeoutMs = INSTALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let cmd
    let args
    if (auto.method === 'winget') {
      cmd = 'winget'
      args = wingetArgs(auto)
    } else {
      // 공식 설치 스크립트를 받아 그대로 실행한다. 스크립트가 자기 손으로
      // SHA256을 맞춰 보므로(실측) 우리가 따로 검증할 것은 없다.
      // 여기서도 절대 경로다 — PATH가 낡아서 설치를 시작하는 판에 PATH를 믿을 수 없다.
      cmd = powerShellPath()
      args = ['-NoProfile', '-NonInteractive', '-Command', auto.psCommand]
    }

    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, shell: false })
    } catch (e) {
      return resolve({ code: -1, timedOut: false, out: '', errOut: String(e.message) })
    }

    let out = ''
    let errOut = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      // 설치 프로그램은 자식을 또 낳는다(winget → msiexec / burn 번들). 트리째 끊지
      // 않으면 우리만 손을 떼고 설치는 계속 돌아, [다시 시도]에서 두 개가 겹친다.
      killTree(child)
      finish({ code: -1, timedOut: true, out, errOut })
    }, timeoutMs)

    const sniff = (chunk) => {
      // **본 것만 말한다.** 실제로 설치 단계 표시가 나왔을 때만 단계를 올린다.
      // 시간으로 추측해 올리면 화면이 사실이 아닌 것을 말하게 된다.
      if (/Installing|설치 중|安装中|インストール/i.test(chunk)) onTick('install')
    }
    child.stdout.on('data', (d) => {
      const s = String(d)
      out += s
      sniff(s)
    })
    child.stderr.on('data', (d) => (errOut += String(d)))
    child.on('error', (e) => finish({ code: -1, timedOut: false, out, errOut: String(e.message) }))
    child.on('close', (code) => finish({ code: code ?? -1, timedOut: false, out, errOut }))
  })
}

/**
 * 하나를 깔고 **깔렸는지 확인까지** 한다.
 *
 * `ok`는 `verified`와 같은 값이다. 일부러 그렇게 뒀다 — 둘이 다르면 화면 어딘가는
 * 반드시 `ok`만 보고 "완료"를 그린다. 설치 프로그램이 뭐라고 했든, 실제로 돌려 보고
 * 답이 온 것만 성공이다.
 *
 * 설치가 실패하거나 시간이 초과돼도 **검증은 그대로 해 본다.** 우리가 놓친 것일 뿐
 * 실제로는 깔렸을 수 있고, 판단 근거는 언제나 설치 프로그램의 말이 아니라 실측이다.
 */
async function installOne(spec, opts = {}) {
  const started = Date.now()
  const auto = spec.auto
  if (!auto) return { ok: false, verified: false, version: null, error: '자동 설치를 지원하지 않는 항목입니다' }
  // UAC 창이 뜨는 설치는 사람이 누를 때까지 붙잡힌다(ADMIN_INSTALL_TIMEOUT_MS 참고).
  const timeoutMs =
    Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : auto.needsAdmin
        ? ADMIN_INSTALL_TIMEOUT_MS
        : INSTALL_TIMEOUT_MS

  let phase = 'download'
  const emit = () => {
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ key: spec.key, phase, elapsedMs: Date.now() - started })
    }
  }
  // 1초마다 같은 단계를 다시 보낸다. 화면이 "몇 초째 진행 중"을 그릴 수 있어야
  // 사람이 멈춘 것과 도는 것을 구별한다. 무인 설치는 몇 분씩 걸린다.
  const ticker = setInterval(emit, 1000)
  emit()

  // **여기서부터 끝까지가 한 덩어리다.** 어느 길로 빠져나가도 타이머가 꺼져야 한다.
  // 예전에는 "winget이 없다"로 돌아가는 길만 clearInterval을 건너뛰었는데, 그 하나로
  // 앱이 꺼질 때까지 1초마다 진행 소식이 나갔다 — 화면에 "설치 실패" 상자와
  // "내려받는 중 · 7분 경과"가 나란히 떴다. winget이 정책으로 막힌 회사 PC가
  // 정확히 그 길을 밟는다. 그래서 return을 세지 않고 finally 하나로 못 박는다.
  try {
    let res
    try {
      if (auto.method === 'winget') {
        const have = await detectWinget()
        if (!have.winget) {
          return { ok: false, verified: false, version: null, error: 'winget이 없어 자동 설치를 할 수 없습니다' }
        }
      }
      res = await runInstaller(
        auto,
        (next) => {
          if (phase === 'download' && next === 'install') {
            phase = 'install'
            emit()
          }
        },
        timeoutMs,
      )
      phase = 'verify'
      emit()
    } catch (e) {
      return { ok: false, verified: false, version: null, error: e.message }
    }

    // 타이머는 검증(phase='verify') 동안에도 살아 있어야 한다 — 훅을 실제로 돌려 보는
    // 구간이라 몇 초씩 걸리고, 그동안 화면이 멈춘 것처럼 보이면 안 된다.
    const check = await verifyInstalled(spec, opts)

    if (check.verified) {
      return {
        ok: true,
        verified: true,
        version: check.version,
        pathAdded: check.repaired && check.repaired.ok ? check.repaired.dir : null,
      }
    }

    // 여기서부터는 전부 실패다. **왜인지를 정확히 말한다.**
    const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)}분` : `${Math.round(timeoutMs / 1000)}초`
    const why = res.timedOut
      ? `${limit} 안에 끝나지 않았습니다`
      : res.code !== 0
        ? lastMeaningfulLine(res.errOut || res.out) || `설치 프로그램이 오류로 끝났습니다 (코드 ${res.code})`
        : check.why || '설치 후에도 확인되지 않았습니다'

    // 설치 프로그램은 성공했는데 확인만 안 되면, 껐다 켜면 보일 수 있다.
    // (윈도우는 이미 떠 있는 프로세스의 환경을 안 고쳐 준다.)
    const needsRestart = res.code === 0 && !res.timedOut
    return { ok: false, verified: false, version: check.version ?? null, error: why, needsRestart }
  } finally {
    clearInterval(ticker)
  }
}

/** 오류 문구는 마지막 줄이 제일 쓸모 있다. 길면 화면을 덮으므로 자른다. */
function lastMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length ? lines[lines.length - 1].slice(0, 200) : null
}

// ---------------------------------------------------------------------------
// 무엇을 어떻게 까는가 — 동의 화면이 그대로 읽어 갈 목록
// ---------------------------------------------------------------------------

/**
 * 남의 컴퓨터에 무언가를 넣는 일이다. **id·게시자·범위를 숨기지 않는다.**
 * 화면은 이 값을 그대로 보여 주고, 사람이 누른 뒤에만 설치가 시작된다.
 *
 * Node가 없는 것을 눈여겨볼 것 — 예전에는 `npm i -g @anthropic-ai/claude-code`라
 * Node가 먼저 필요했다. 공식 설치 스크립트는 PowerShell만 쓰므로(실측) 비개발자가
 * 넘어야 할 단계가 통째로 두 개 사라졌다.
 */
const PACKAGES = {
  claude: {
    method: 'script',
    // winget에도 `Anthropic.ClaudeCode`가 있고 실측으로 같은 파일을 받는다
    // (SHA256 af5bf1f1… = 공식 manifest의 win32-x64 값). 그런데 그건 **포터블**이라
    // 심볼릭 링크를 걸고, 개발자 모드가 꺼진 PC에서는 그 링크가 실패한다.
    // 공식 스크립트는 `claude.exe install`이 런처를 직접 앉히므로 그 함정이 없다.
    publisher: 'Anthropic PBC',
    scope: 'user',
    needsAdmin: false,
    source: 'https://claude.ai/install.ps1',
    // `| iex`로 통째로 흘리지 않고 스크립트 블록으로 만들어 인자를 준다.
    // `stable`을 고른 이유: 비개발자 PC에 최신판을 밀어 넣을 이유가 없다.
    psCommand: "& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://claude.ai/install.ps1'))) stable",
    command: "powershell -NoProfile -Command \"& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) stable\"",
  },
  python: {
    method: 'winget',
    pkg: 'Python.Python.3.13',
    publisher: 'Python Software Foundation',
    scope: 'user',
    // 설치 관리자 유형이 burn(번들)이다 — 사용자 범위로 걸어도 UAC 창이 뜰 수 있다.
    // 화면은 이 값을 보고 "관리자 확인 창이 뜰 수 있습니다"를 미리 알려 준다.
    needsAdmin: true,
  },
  git: {
    method: 'winget',
    pkg: 'Git.MinGit',
    publisher: 'The Git Development Community',
    scope: 'user',
    needsAdmin: false,
    // 포터블이라 링크가 실패할 수 있다. 실패하면 이 이름으로 파일을 직접 찾아
    // PATH를 고친다(repairPortablePath).
    portableExe: 'git.exe',
  },
}

module.exports = {
  INSTALL_TIMEOUT_MS,
  ADMIN_INSTALL_TIMEOUT_MS,
  SILENT_FLAGS,
  NOT_FOUND,
  PACKAGES,
  detectWinget,
  readRegistryPath,
  refreshPath,
  persistUserPath,
  repairPortablePath,
  findExeUnder,
  probeVersion,
  verifyHookRuns,
  verifyInstalled,
  wingetArgs,
  commandText,
  installOne,
  splitPath,
  pathKey,
}
