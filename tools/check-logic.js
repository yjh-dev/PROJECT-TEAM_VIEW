// 로직 검사 — 화면이 아니라 **동작**을 확인한다.
//
//   pnpm run check:logic
//
// main.js는 2000줄이 넘는데 그동안 자동 검사가 하나도 없었다. 여기서 보는 것들은
// 전부 실제로 한 번씩 어긋났던 자리다:
//
//   스냅샷    git 명령이 성공해도 출력이 없어서(add·update-ref) 결과를 참·거짓으로
//             보면 전부 실패로 처리된다 — 스냅샷이 아예 안 만들어졌다
//   되돌리기   새로 생긴 파일을 지우고 고쳐진 파일을 되살려야 한다. 무시 목록(.gitignore)은
//             건드리면 안 된다
//   훅        되돌릴 수 없는 명령이 44자에서 잘려 `rm -rf boar`가 됐다 —
//             무엇을 지웠는지 확인할 수 없었다
//
// main.js를 통째로 불러오면 앱이 켜지므로, 필요한 함수 블록만 떼어 검사한다.
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let failed = 0
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, detail) => {
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  failed++
}
const eq = (label, got, want) => (String(got) === String(want) ? ok(label) : bad(label, `${got} ≠ ${want}`))

// ── main.js에서 함수만 떼어 온다 ────────────────────────────────────────────
// 원본 코드를 그대로 쓴다(복사본을 검사하면 검사가 거짓말을 한다).
function loadFrom(file, names, prelude = '') {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  let code = prelude
  for (const n of names) {
    // async 함수도 그대로 떼어 온다(검사에서 await로 부르면 된다).
    let start = src.indexOf('\nfunction ' + n + '(')
    if (start < 0) start = src.indexOf('\nasync function ' + n + '(')
    if (start < 0) throw new Error(`${file}에서 ${n}을 찾지 못했습니다`)
    const end = src.indexOf('\n}\n', start)
    code += src.slice(start, end + 3) + '\n'
  }
  code += 'module.exports = { ' + names.join(', ') + ' }\n'
  const f = path.join(os.tmpdir(), 'tv-check-' + path.basename(file) + '.js')
  fs.writeFileSync(f, code, 'utf8')
  delete require.cache[require.resolve(f)]
  return require(f)
}

const M = loadFrom(
  'main.js',
  ['git', 'writeWorkTree', 'takeSnapshot', 'pruneSnapshots', 'snapshotDiff', 'restoreSnapshot', 'pruneEmptyDirs', 'gitRoot', 'runScriptFor'],
  [
    "const { execFileSync } = require('child_process')",
    "const fs = require('fs')",
    "const path = require('path')",
    "const SNAP_REF_PREFIX = 'refs/teamview/snap'",
    'const SNAP_KEEP = 30',
    '',
  ].join('\n'),
)

// ── 임시 저장소 ────────────────────────────────────────────────────────────
const LAB = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-logic-'))
const sh = (args, cwd = LAB) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const write = (rel, text) => {
  const p = path.join(LAB, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}
const read = (rel) => { try { return fs.readFileSync(path.join(LAB, rel), 'utf8').trim() } catch { return null } }
const has = (rel) => fs.existsSync(path.join(LAB, rel))

console.log('로직 검사')

// ── 1. 실행 스크립트 고르기 ────────────────────────────────────────────────
write('package.json', JSON.stringify({ name: 't', scripts: { build: 'x', dev: 'y', start: 'z' } }))
eq('실행 스크립트는 dev를 먼저 고른다', M.runScriptFor(LAB), 'dev')
write('package.json', JSON.stringify({ name: 't', scripts: { start: 'z' } }))
eq('dev가 없으면 start', M.runScriptFor(LAB), 'start')
write('package.json', JSON.stringify({ name: 't', scripts: {} }))
eq('띄울 방법이 없으면 null', M.runScriptFor(LAB), 'null')

// ── 2. git이 아닌 곳 ───────────────────────────────────────────────────────
eq('git이 아니면 최상위는 null', M.gitRoot(LAB), 'null')
eq('git이 아니면 스냅샷은 조용히 넘어간다', M.takeSnapshot(LAB, 'x'), 'null')

// ── 3. 스냅샷 ──────────────────────────────────────────────────────────────
sh(['init', '-q'])
write('.gitignore', 'node_modules/\n')
write('src/a.txt', 'v1\n')
write('src/b.txt', 'keep\n')
sh(['add', '-A'])
execFileSync('git', ['-C', LAB, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { stdio: 'ignore' })

const ref = M.takeSnapshot(LAB, '상품 상세 만들어줘')
ref ? ok('스냅샷이 만들어진다') : bad('스냅샷이 만들어진다', 'null이 돌아왔다(성공한 git 명령을 실패로 보고 있다)')

// 사용자의 git이 오염되면 안 된다
eq('사용자 작업트리 그대로', sh(['status', '--porcelain']).trim().length, 0)
eq('사용자 커밋 이력 그대로', sh(['rev-list', '--count', 'HEAD']).trim(), '1')
eq('stash 건드리지 않음', sh(['stash', 'list']).trim().length, 0)
eq('임시 인덱스 파일 안 남김', has('.git/teamview-index'), 'false')

// ── 4. 팀이 일한 뒤 무엇이 달라졌는지 ──────────────────────────────────────
write('src/a.txt', 'v2\n')          // 고침
write('src/c.txt', 'new\n')          // 새로 만듦
write('src/deep/d.txt', 'new2\n')    // 깊은 곳에 새로 만듦
fs.unlinkSync(path.join(LAB, 'src/b.txt')) // 지움
write('node_modules/x.js', 'junk\n') // 무시 대상

const diff = M.snapshotDiff(LAB, ref) || []
const kind = (p) => diff.find((d) => d.path === p)?.status
eq('고친 파일을 M으로 본다', kind('src/a.txt'), 'M')
eq('지운 파일을 D로 본다', kind('src/b.txt'), 'D')
eq('새 파일을 A로 본다', kind('src/c.txt'), 'A')
eq('깊은 곳의 새 파일도 본다', kind('src/deep/d.txt'), 'A')
eq('무시 대상은 보지 않는다', diff.some((d) => d.path.includes('node_modules')), 'false')

// ── 5. 되돌리기 ────────────────────────────────────────────────────────────
const res = M.restoreSnapshot(LAB, ref)
res.ok ? ok('되돌리기가 끝까지 간다') : bad('되돌리기가 끝까지 간다', JSON.stringify(res.failed))
eq('고친 파일이 원래 내용으로', read('src/a.txt'), 'v1')
eq('지운 파일이 되살아남', has('src/b.txt'), 'true')
eq('새로 만든 파일이 지워짐', has('src/c.txt'), 'false')
eq('빈 폴더까지 정리됨', has('src/deep'), 'false')
eq('무시 대상은 그대로', has('node_modules/x.js'), 'true')
eq('되돌린 뒤 작업트리가 스냅샷과 같음', sh(['status', '--porcelain']).trim().length, 0)
eq('되돌려도 커밋 이력은 그대로', sh(['rev-list', '--count', 'HEAD']).trim(), '1')

// ── 6. 스냅샷 보관 한도 ────────────────────────────────────────────────────
for (let i = 0; i < 35; i++) M.takeSnapshot(LAB, 'bulk ' + i)
const kept = sh(['for-each-ref', '--format=%(refname)', 'refs/teamview/snap']).trim().split('\n').filter(Boolean).length
kept <= 30 ? ok(`스냅샷을 30개까지만 둔다 (지금 ${kept})`) : bad('스냅샷 보관 한도', `${kept}개`)

// ── 6-1. 조각난 출력에서 주소가 온전히 살아남는가 ──────────────────────────
// 실측(renderer.log, 08-02 12:16:12 외 4회):
//     실행 준비됨 — daily http://localhost:
// 진짜 주소는 `http://localhost:5173/`인데 포트가 없다. 링크를 눌러도 안 열린다.
// 자식의 stdout은 줄 단위로 오지 않는다 — `http://localhost:`에서 조각이 끊기면
// sniffUrl의 포트 없는 fallback이 걸리고, `if (!r.url)` 가드 때문에 그 값이 굳는다.
// **색상 코드가 아니라 조각 분할이 원인이다** — 온전한 줄이면 ANSI가 섞여 있어도
// 제대로 주웠다.
{
  const L = loadFrom('main.js', ['makeLineReader', 'sniffUrl'], 'const LINE_BUF_MAX = 64 * 1024\n')
  const ESC = String.fromCharCode(27)
  // 실측 로그 그대로 — vite는 포트를 굵게 칠해서 내보낸다
  const VITE = `  ${ESC}[32m>${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\n`
  const WANT = 'http://localhost:5173/'

  /** 진짜 파이프처럼 조각을 흘려 넣고, 주운 주소와 쌓인 줄 수를 돌려준다. */
  const feed = (chunks) => {
    let url = null
    const lines = []
    const rd = L.makeLineReader((line) => {
      if (line.trim()) lines.push(line)
      if (!url) url = L.sniffUrl(line)
    })
    for (const c of chunks) rd.push(c)
    rd.flush()
    return { url, lines }
  }

  eq('온전한 줄에서 주소를 줍는다', feed(['http://localhost:5173/\n']).url, WANT)
  eq('색상 코드가 섞여도 줍는다', feed([VITE]).url, WANT)
  // 이것이 실제로 났던 실패다
  eq('포트 앞에서 조각이 끊겨도 포트가 살아남는다', feed(['  Local:   http://localhost:', '5173/\n']).url, WANT)
  eq('색상 코드까지 섞여 끊겨도 살아남는다',
    feed([VITE.slice(0, VITE.indexOf('5173')), VITE.slice(VITE.indexOf('5173'))]).url, WANT)
  eq('한 글자씩 들어와도 살아남는다', feed([...VITE]).url, WANT)
  // 한 글자씩 74번 들어온 줄이 74줄이 되면, 실패 원인으로 보여 줄 마지막 200줄이
  // 반토막 난 조각으로 가득 찬다.
  eq('반토막 난 줄이 쌓이지 않는다', feed([...VITE]).lines.length, 1)
  eq('개행 없이 끝난 꼬리도 흘려보낸다', feed(['http://localhost:5173/']).url, WANT)
  eq('CRLF의 \\r가 주소에 붙지 않는다', feed(['http://localhost:5173/\r\n']).url, WANT)
  // **스트림마다 버퍼가 따로여야 한다** — 섞이면 없던 줄이 생긴다.
  {
    const seen = []
    const out = L.makeLineReader((l) => seen.push(l))
    const err = L.makeLineReader((l) => seen.push(l))
    out.push('http://local')
    err.push('경고: 무언가\n')
    out.push('host:5173/\n')
    seen.includes(WANT)
      ? ok('stdout·stderr가 버퍼를 나눠 쓰지 않는다')
      : bad('스트림 분리', `반쪽끼리 이어 붙었다 — ${JSON.stringify(seen)}`)
  }
  // 개행 없이 한없이 들어와도(진행 막대) 메모리를 내주지 않는다
  {
    let got = 0
    const rd = L.makeLineReader(() => got++)
    rd.push('x'.repeat(70 * 1024))
    got > 0 ? ok('개행이 안 와도 무한정 쌓지 않는다') : bad('버퍼 상한', '개행 없는 출력에 메모리가 샌다')
  }
}

// ── 6-1-1. 주소를 봤다고 "준비됨"이라 하지 않는가 ──────────────────────────
// 실측(08-02 12:52:47 준비됨 → 12:57:12 코드 1): vite가 주소를 찍은 **직후** 죽었는데
// 같은 워크스페이스의 dev:server가 살아 있어 `npm run dev`는 4분 25초를 더 버텼다.
// 앱은 그동안 열리지 않는 링크를 "실행 준비됨"으로 들고 있었다.
{
  const src4 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const m = /const RUN_DEAD_RE = \/(.*)\/([a-z]*)\n/.exec(src4)
  if (!m) bad('죽음 신호 규칙', 'RUN_DEAD_RE를 찾지 못했다')
  else {
    const re = new RegExp(m[1], m[2]) // 원본 정규식을 그대로 쓴다(복사본을 검사하면 검사가 거짓말을 한다)
    // 실측 로그 12:57:12에 실제로 찍힌 줄들
    const dead = [
      'dev:web: [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @daily/web@0.1.0 dev: `vite`',
      'dev:web: Exit status 1',
      '[ELIFECYCLE] Command failed with exit code 1.',
    ]
    for (const l of dead) re.test(l) ? ok(`죽음을 알아본다: ${l.slice(0, 40)}…`) : bad('죽음 신호', l)
    // **멀쩡한 줄을 죽음으로 보면 안 된다** — 그러면 되는 실행도 "준비됨"이 안 뜬다.
    const alive = [
      'dev:web:   ➜  Local:   http://localhost:5173/',
      'VITE v6.4.3  ready in 546 ms',
      'dev:server: [daily] server listening on http://localhost:3001/api',
      '2 warnings and 0 errors',
      'Compiled successfully in 1.2s',
    ]
    for (const l of alive) !re.test(l) ? ok(`멀쩡한 줄을 죽음으로 보지 않는다: ${l.slice(0, 32)}…`) : bad('오탐', l)
  }
  const hasReady = /ready: !!r\?\.ready/.test(src4)
  hasReady
    ? ok('주소와 살아 있음을 다른 값으로 내보낸다')
    : bad('준비 판정', 'url만 보면 죽은 서버의 링크가 계속 눌린다')
  const ui = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')
  const linkGated = /r\.running && r\.url && r\.ready/.test(ui)
  linkGated
    ? ok('화면이 확인된 주소만 링크로 내준다')
    : bad('링크 표시', '주소를 본 것만으로 링크를 준다 — 눌러도 열리지 않는다')
}

// ── 6-2. 실패 사유를 사람 말로 옮기는가 ────────────────────────────────────
// claude는 stderr로 아무것도 쓰지 않는다. 실패 사유는 세션 기록에만 남고, 그걸
// 못 읽으면 화면에는 "코드 1로 끝남"만 뜬다 — 실제로 사용량 한도에 걸렸는데
// 원인 불명으로 보였다.
{
  const src2 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const i = src2.indexOf('const FAILURE_KINDS')
  const kinds = src2.slice(i, src2.indexOf('\n]\n', i) + 3)
  const f2 = path.join(os.tmpdir(), 'tv-check-kinds.js')
  fs.writeFileSync(f2, kinds + '\nmodule.exports = { FAILURE_KINDS }\n', 'utf8')
  delete require.cache[require.resolve(f2)]
  const { FAILURE_KINDS } = require(f2)
  const cases = [
    ["You've hit your session limit · resets 5:40pm (Asia/Seoul)", '토큰 사용량 한도'],
    ['API Error: 429 Too Many Requests', '토큰 사용량 한도'],
    ['Error: Overloaded (529)', '서버 혼잡'],
    ['Authentication failed: 401 unauthorized', '로그인 만료'],
    ['insufficient credit balance', '결제·크레딧 문제'],
    ['ENOENT: no such file or directory', null],
  ]
  for (const [msg, want] of cases) {
    const hit = FAILURE_KINDS.find((k) => k.re.test(msg))
    eq('실패 분류: ' + (want ?? '분류 없음'), hit ? hit.label : null, want)
  }
}

// ── 6-2-1. 한도가 언제 풀리는지 문구에서 읽어 내는가 ───────────────────────
// 실측(renderer.log 08-02 08:13:58)에서 사유는 남았는데 결과는 "코드 1"이었다.
// 풀리는 시각은 그 문구 안에 이미 들어 있다 — 사용자가 정말 알고 싶은 값이다.
{
  const K = loadFrom('main.js', ['resetTimeFrom'])
  const cases = [
    ["You've hit your session limit · resets 6:50pm (Asia/Seoul)", '6:50pm (Asia/Seoul)'],
    ['Agent terminated early due to an API error: You\'ve hit your session limit · resets 5:40pm (Asia/Seoul)', '5:40pm (Asia/Seoul)'],
    ["You've hit your session limit · resets 3:50am (Asia/Seoul)", '3:50am (Asia/Seoul)'],
    ['rate limited, resets at 11pm', '11pm'],
    // **없는 시각을 지어내면 안 된다.**
    ['API Error: 429 Too Many Requests', 'null'],
  ]
  for (const [msg, want] of cases) eq(`풀리는 시각: ${want}`, K.resetTimeFrom(msg), want)
}

// ── 6-2-2. 기다릴 실패와 손볼 실패를 가르는가 ──────────────────────────────
// 둘을 똑같이 "코드 1"로 보여 주면, 망가진 것이 없는데도 원인을 찾아 나서게 된다.
{
  const src3 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const i = src3.indexOf('const FAILURE_KINDS')
  const f3 = path.join(os.tmpdir(), 'tv-check-kinds2.js')
  fs.writeFileSync(f3, src3.slice(i, src3.indexOf('\n]\n', i) + 3) + '\nmodule.exports = { FAILURE_KINDS }\n', 'utf8')
  delete require.cache[require.resolve(f3)]
  const { FAILURE_KINDS } = require(f3)
  const waitOf = (msg) => !!FAILURE_KINDS.find((k) => k.re.test(msg))?.wait
  eq('한도는 기다리면 되는 실패다', waitOf("You've hit your session limit · resets 6:50pm (Asia/Seoul)"), 'true')
  eq('서버 혼잡도 기다리면 되는 실패다', waitOf('Error: Overloaded (529)'), 'true')
  eq('로그인 만료는 손봐야 한다', waitOf('401 unauthorized'), 'false')
  eq('결제 문제는 손봐야 한다', waitOf('insufficient credit balance'), 'false')
  // 화면이 그 신호를 실제로 쓰는지. 표시까지 이어지지 않으면 고친 게 아니다.
  const ui = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')
  const showsWait = /why\?\.wait/.test(ui)
  showsWait
    ? ok('화면이 기다릴 실패를 따로 표시한다')
    : bad('한도 표시', '신호가 화면까지 오지 않는다 — 결과는 여전히 "코드 1"이다')
  const showsReset = /why\.resetAt/.test(ui)
  showsReset
    ? ok('화면이 풀리는 시각을 보여 준다')
    : bad('풀림 시각 표시', '문구에 있는 값을 버리고 있다')
}

// ── 6-2-3. 오류 로그에 평상시 기록이 섞이지 않는가 ─────────────────────────
// `renderer.log`는 화면이 까맣게 죽었는데 로그가 텅 비어 있던 일을 겪고 만든 **오류
// 파일**이다. 그런데 `실행 준비됨`·`작업 종료` 같은 정상 상태가 같이 들어오면서
// 실측 89줄 중 34줄이 평상시 기록이 됐고, 정작 화면 크래시 4줄이 그 사이에 묻혔다.
{
  const s = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const calls = s.match(/logRenderer\((?:`[^`]*`|'[^']*')/g) || []
  // 정상 상태를 나타내는 말들. 이 중 하나라도 오류 파일로 가면 다시 묻히기 시작한다.
  const normal = ['실행 준비됨', '실행 중지됨', '실행 시작', '작업 종료', '중지로 끝남', '앱을 켰습니다']
  const leaked = calls.filter((c) => normal.some((n) => c.includes(n)))
  leaked.length === 0
    ? ok('평상시 기록이 오류 파일로 새지 않는다')
    : bad('로그 분리', `오류 파일로 가는 정상 기록: ${leaked.join(', ')}`)
  const hasActivity = /function logActivity\(/.test(s)
  hasActivity
    ? ok('평상시 기록을 담을 곳이 따로 있다')
    : bad('로그 분리', 'logActivity가 없다 — 한 파일에 다시 섞인다')
  const hasActivityPath = /function activityLogPath\(/.test(s)
  hasActivityPath
    ? ok('평상시 기록 파일 경로가 정해져 있다')
    : bad('로그 분리', 'activityLogPath가 없다')
  // 오류 파일 안에서도 어디서 난 오류인지 갈라야 한다 — 자식 프로세스가 뱉은
  // 스택 트레이스 30줄에 화면 크래시 4줄이 묻혔다(실측).
  const tagged = /function logRenderer\(line, where = /.test(s)
  tagged
    ? ok('오류에 출처를 붙인다 (화면·실행·지시)')
    : bad('오류 출처', '화면 크래시가 자식 프로세스 출력에 묻힌다')
}

// ── 6-2-4. 실행을 누가 껐다 켰는지 기록에 남는가 ───────────────────────────
// 실측: 준비↔중지가 몇 초 만에 되풀이됐는데(12:51:13 준비 → 12:52:44 중지 →
// 12:52:47 준비), 기록에 **실행 시작도 앱 켜짐도 없어서** 사람이 껐다 켠 것인지
// 앱이 스스로 그런 것인지 로그만으로는 가릴 수 없었다. 원인 규명이 로그 때문에
// 막히는 일이 다시 없도록 못 박는다.
{
  const s = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const marks = [
    [/logActivity\(`앱을 켰습니다/, '앱을 켠 시각'],
    [/logActivity\(`실행 시작 —/, '실행을 시작한 시각'],
    [/logActivity\(`실행 중지됨 —/, '실행을 멈춘 시각'],
    [/logActivity\(`실행이 스스로 끝났습니다/, '서버가 조용히 끝난 시각'],
  ]
  for (const [re, what] of marks) {
    re.test(s) ? ok(`기록에 ${what}이 남는다`) : bad('실행 기록', `${what}이 없다 — 되풀이의 원인을 가릴 수 없다`)
  }
}

// ── 6-3. 답변을 넉넉히 남기고, 자르면 밝히는가 ─────────────────────────────
// 묻는 말에는 답변이 곧 결과물이다. 실측으로 1,526자짜리 답변이 1,200자에서
// 21% 잘렸고, 사라진 뒷부분에 "브라우저 실제 동작은 확인하지 않았습니다"라는
// 한계 고지가 있었다 — 그 문장이 사라지면 다 검증된 것처럼 읽힌다.
{
  const h = fs.readFileSync(path.join(ROOT, 'hooks', 'team_events.py'), 'utf8')
  const m = /REPLY_KEEP\s*=\s*(\d+)/.exec(h)
  m ? ok('답변 보관 길이가 정의돼 있다') : bad('답변 보관 길이', '상수를 찾지 못했다')
  if (m) {
    Number(m[1]) >= 4000
      ? ok(`답변을 넉넉히 남긴다 (${m[1]}자)`)
      : bad('답변 보관 길이', `${m[1]}자는 짧다 — 실측 답변이 1526자였다`)
  }
  h.includes('줄였습니다')
    ? ok('잘랐으면 잘랐다고 밝힌다')
    : bad('답변 잘림 표시', '조용히 자르면 끝까지 읽은 줄 안다')
}

// ── 7. 훅이 지우는 명령을 자르지 않는가 ────────────────────────────────────
// 훅은 파이썬이라 함수만 떼어 오지 못한다. 규칙(정규식·길이)을 파일에서 읽어 확인한다.
const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'team_events.py'), 'utf8')
const keep = /CMD_KEEP\s*=\s*(\d+)/.exec(hook)
const dkeep = /DESTRUCTIVE_KEEP\s*=\s*(\d+)/.exec(hook)
keep && dkeep ? ok('훅에 명령 기록 길이가 정의돼 있다') : bad('훅 기록 길이', '상수를 찾지 못했다')
if (keep && dkeep) {
  Number(dkeep[1]) > Number(keep[1])
    ? ok(`지우는 명령을 더 길게 남긴다 (${dkeep[1]} > ${keep[1]})`)
    : bad('지우는 명령 기록 길이', `${dkeep[1]} ≤ ${keep[1]} — 잘려서 무엇을 지웠는지 알 수 없다`)
  Number(dkeep[1]) >= 400
    ? ok('실제 사고 사례(111자)를 담을 만큼 길다')
    : bad('지우는 명령 기록 길이', `${dkeep[1]}자는 짧다`)
}
for (const cmd of ['rm -rf board', 'git reset --hard origin/main', 'Remove-Item -Recurse', 'DROP TABLE users']) {
  /DESTRUCTIVE\s*=\s*re\.compile\(/.test(hook) ? null : bad('훅 DESTRUCTIVE 정규식', '정의를 찾지 못했다')
  break
}
;['rm\\s+-', 'Remove-Item', 'reset\\s+--hard', 'DROP\\s+'].forEach((frag) => {
  hook.includes(frag.replace('\\\\', '\\'))
    ? ok(`되돌릴 수 없는 명령으로 ${frag.split('\\')[0]}를 본다`)
    : bad('훅 DESTRUCTIVE 규칙', `${frag} 누락`)
})

// ── 8. 일 순서에 모든 관문이 살아 있는가 ───────────────────────────────────
// 실측: 순서 규칙을 넣을 때 `code-reviewer`만 못 박고 `qa-tester`는 "필요한 규모면"으로
// 남겼다. 그 한 단어 때문에 파일 45개짜리 웹앱에 테스트가 0개로 끝났다 — 판단을
// 넘기면 매번 "아니다"가 된다. **관문이 조용히 빠지는 것을 여기서 잡는다.**
const guide = fs.readFileSync(path.join(ROOT, 'templates', 'CLAUDE.md'), 'utf8')
const lead = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const inLead = (re) => re.test(lead)
for (const [who, 이름] of [['planner', '기획'], ['ux-designer', '설계'], ['code-reviewer', '리뷰'], ['qa-tester', '검수']]) {
  lead.includes(who)
    ? ok(`매번 붙는 지시에 ${이름}(${who}) 단계가 있다`)
    : bad('일 순서', `${who}가 프롬프트에서 빠졌다 — 아무도 그 단계를 밟지 않는다`)
}
// 검수는 규모를 따지지 않는다. 조건을 달면 조건이 안 걸리는 쪽으로 흐른다.
inLead(/qa-tester[^]{0,80}(반드시|무조건)|(반드시|무조건)[^]{0,80}qa-tester/)
  ? ok('검수를 조건 없이 못 박았다')
  : bad('검수 관문', '"필요하면" 식이면 매번 건너뛴다 — 실제로 116분 작업에서 0번 불렸다')
// 문제를 리드가 혼자 고치면 만든 사람은 같은 실수를 반복한다.
inLead(/돌려\s*보내/) && inLead(/planner/) && inLead(/ux-designer/) && /돌려\s*보냅니다/.test(guide)
  ? ok('검수에서 나온 문제를 원래 자리로 되돌려 보낸다')
  : bad('되돌림 경로', '문제를 누구에게 돌려보낼지 없으면 리드가 혼자 덮는다')
// 되돌림이 끝없이 돌면 턴이 안 끝난다.
inLead(/두 번[^]{0,60}남/)
  ? ok('되돌림 횟수에 끝이 있다')
  : bad('되돌림 한계', '멈출 지점이 없으면 고침↔검수를 무한히 돈다')
// 검사물을 남길 자리를 안 정해 주면 임시 폴더에 쓰고 버린다(실측: tmp-check/fixtures).
inLead(/tests\//) && guide.includes('tests/')
  ? ok('검수한 것을 어디에 남길지 정해 준다')
  : bad('검사물 보관 자리', '임시 폴더에 쓰고 버려 다음 검수 때 처음부터 다시 만든다')

guide.includes('qa-tester') && guide.includes('마지막 관문')
  ? ok('프로젝트 지침에도 검수 단계가 적혀 있다')
  : bad('지침 CLAUDE.md', '검수 단계 설명이 없다')

// ── 9. 중지와 실패를 구분하는가, 사유는 이번 것인가 ────────────────────────
// 실측: 사용자가 중지를 눌렀는데 화면에 "지시 실패 — 토큰 사용량 한도"가 떴다.
// 두 가지가 겹친 사고였다. (1) 죽이면 종료코드가 0이 아니라서 중지가 실패로
// 분류됐고, (2) 실패 사유를 세션 기록에서 시간 제한 없이 가져와 **네 시간 전**
// 오류가 붙었다(17:38 오류, 21:37 보고).
{
  const errLine = (ts, msg) =>
    JSON.stringify({ timestamp: ts, message: { content: [{ is_error: true, content: msg }] } })
  const fixture = path.join(os.tmpdir(), 'tv-logic-sess.jsonl')
  fs.writeFileSync(
    fixture,
    [
      errLine('2026-08-01T08:38:47.050Z', "API error: You've hit your session limit · resets 5:40pm"),
      JSON.stringify({ timestamp: '2026-08-01T12:30:00.000Z', message: { content: [{ text: '뒤에 온 새 지시' }] } }),
    ].join('\n') + '\n',
    'utf8',
  )
  // **한도 메시지는 팀원 기록에, 그것도 오류가 아닌 답변 문장으로 남는다.** 실측:
  // 리드 파일에는 아무것도 없어 "이유가 기록에 남지 않았습니다"가 됐다.
  const subFixture = path.join(os.tmpdir(), 'tv-logic-sub.jsonl')
  fs.writeFileSync(
    subFixture,
    JSON.stringify({
      timestamp: '2026-08-01T15:36:13.040Z',
      attributionAgent: 'qa-tester',
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3:50am (Asia/Seoul)" }] },
    }) + '\n',
    'utf8',
  )

  const kindsAt = lead.indexOf('const FAILURE_KINDS')
  const readAt = lead.indexOf('const CLOCK_SLACK_SEC')
  const readEnd = lead.indexOf('\n}\n', lead.indexOf('function readSessionError'))
  const code = [
    "const fs = require('fs')",
    lead.slice(kindsAt, lead.indexOf('\n]\n', kindsAt) + 3),
    'const sessionPath = () => ' + JSON.stringify(fixture),
    'const usageFiles = () => ' + JSON.stringify([fixture, subFixture]),
    lead.slice(readAt, readEnd + 3),
    'module.exports = { readSessionError }',
  ].join('\n')
  const f = path.join(os.tmpdir(), 'tv-check-sesserr.js')
  fs.writeFileSync(f, code, 'utf8')
  delete require.cache[require.resolve(f)]
  const { readSessionError } = require(f)
  const at = Date.parse('2026-08-01T08:38:47.050Z') / 1000

  const later = readSessionError('x', 'y', at + 3600)
  !later?.message.includes('5:40pm')
    ? ok('지난 지시의 오류를 이번 실패 사유로 삼지 않는다')
    : bad('실패 사유 시점', '네 시간 전 오류가 지금 사유로 붙는다')
  readSessionError('x', 'y', Date.parse('2026-08-01T17:00:00Z') / 1000) === null
    ? ok('그 뒤로 아무 일도 없었으면 사유도 없다')
    : bad('시점 제한', '없는 시간대인데 무언가를 집었다')
  const now = readSessionError('x', 'y', at - 60)
  now && now.label === '토큰 사용량 한도'
    ? ok('이번 실행 중 난 오류는 그대로 찾아 분류한다')
    : bad('실패 사유 탐지', JSON.stringify(now))
  const slack = readSessionError('x', 'y', at + 5)
  slack && slack.label === '토큰 사용량 한도'
    ? ok('시계가 몇 초 어긋나도 놓치지 않는다')
    : bad('시계 여유', '여유가 없으면 진짜 사유를 놓친다')

  // 팀원 기록에만, 그것도 오류가 아닌 문장으로 남은 한도 메시지
  const sub = readSessionError('x', 'y', Date.parse('2026-08-01T15:00:00Z') / 1000)
  sub && sub.message.includes('3:50am')
    ? ok('팀원 기록에 남은 한도 메시지도 찾는다')
    : bad('팀원 기록', '리드 파일만 봐서 "이유가 기록에 남지 않았습니다"가 된다')
  sub && sub.label === '토큰 사용량 한도'
    ? ok('오류 표시가 없는 문장도 한도로 분류한다')
    : bad('문장 분류', 'is_error만 보면 한도 메시지를 통째로 놓친다')

  inLead(/child\.teamviewCanceled = true/)
    ? ok('중지할 때 그 프로세스에 표시를 남긴다')
    : bad('중지 표시', '표시가 없으면 중지와 실패를 구분할 수 없다')
  inLead(/if \(code !== 0 && child\.teamviewCanceled\)/)
    ? ok('중지로 죽은 것을 실패로 적지 않는다')
    : bad('중지 처리', '중지를 누를 때마다 "지시 실패"가 뜬다')
  inLead(/if \(child\.teamviewCanceled\) return/)
    ? ok('중지에는 알림을 띄우지 않는다')
    : bad('중지 알림', '방금 자기가 누른 것을 알림으로 다시 알린다')

  // **사유를 못 찾았다고 성공이 되면 안 된다.** 위의 시점 제한을 넣자마자 실측에서
  // 드러났다 — 코드 1로 끝났는데 기록에 오류가 없어 사유가 null이 됐고, 그러자
  // "작업이 끝났습니다"가 떴다. 판정은 종료코드가 한다.
  const fj = lead.indexOf('\n}\n', lead.indexOf('function failureFor'))
  const ffCode = [
    'const readSessionError = () => (process.env.WHY === "1" ? { message: "한도", label: "토큰 사용량 한도", hint: null } : null)',
    // 끝나지 않은 팀원 판정은 아래 10번에서 따로 본다. 여기서는 없다고 둔다.
    'const unfinishedAgents = () => (process.env.LEFT ? process.env.LEFT.split(",") : [])',
    lead.slice(lead.indexOf('function failureFor'), fj + 3),
    'module.exports = { failureFor }',
  ].join('\n')
  const ff = path.join(os.tmpdir(), 'tv-check-failure.js')
  fs.writeFileSync(ff, ffCode, 'utf8')
  delete require.cache[require.resolve(ff)]
  const { failureFor } = require(ff)

  process.env.WHY = '0'
  process.env.LEFT = ''
  failureFor('d', 's', 0, 0) === null ? ok('성공은 실패로 적지 않는다') : bad('성공 판정', 'null이 아니다')
  process.env.LEFT = 'qa-tester'
  failureFor('d', 's', 0, 0)?.label === '팀원 작업이 끊김'
    ? ok('팀원이 일하는 중에 끝났으면 성공이라 하지 않는다')
    : bad('끊김 판정', '"작업 종료"라고 알린다 — 사람은 다 끝난 줄 안다')
  process.env.LEFT = ''
  const unknown = failureFor('d', 's', 0, 1)
  unknown && typeof unknown.message === 'string'
    ? ok('사유를 못 찾아도 실패는 실패로 알린다')
    : bad('실패 판정', '사유가 없으면 성공으로 처리된다 — "작업이 끝났습니다"가 뜬다')
  process.env.WHY = '1'
  failureFor('d', 's', 0, 1)?.label === '토큰 사용량 한도'
    ? ok('사유를 찾으면 그대로 붙인다')
    : bad('사유 전달', '찾은 사유가 버려진다')
}

// ── 10. 팀원이 일하는 중에 끝났으면 "작업 종료"가 아니다 ────────────────────
// 실측: 리드가 `SendMessage`로 QA를 배경에 돌려놓고 "결과를 받은 뒤 최종 보고
// 하겠습니다"라며 턴을 끝냈다. QA는 그 뒤 10분을 더 일했고 보고는 오지 않았는데,
// 종료코드가 0이라 앱은 "작업 종료"라고 알렸다 — 사람은 다 끝난 줄 안다.
{
  const lab2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-unfin-'))
  fs.mkdirSync(path.join(lab2, '.claude'), { recursive: true })
  const ev = (o) => JSON.stringify(o)
  fs.writeFileSync(
    path.join(lab2, '.claude', 'team-events.jsonl'),
    [
      ev({ ts: 1000, type: 'agent_start', agent: 'backend-dev' }),
      ev({ ts: 1100, type: 'agent_stop', agent: 'backend-dev' }),
      ev({ ts: 1200, type: 'agent_start', agent: 'qa-tester' }), // 끝나지 않았다
    ].join('\n') + '\n',
    'utf8',
  )
  const ui = lead.indexOf('function unfinishedAgents')
  const code2 = [
    "const fs = require('fs')",
    "const path = require('path')",
    'const CLOCK_SLACK_SEC = 10',
    'const eventsFileFor = (d) => path.join(d, ".claude", "team-events.jsonl")',
    lead.slice(ui, lead.indexOf('\n}\n', ui) + 3),
    'module.exports = { unfinishedAgents }',
  ].join('\n')
  const f2 = path.join(os.tmpdir(), 'tv-check-unfin.js')
  fs.writeFileSync(f2, code2, 'utf8')
  delete require.cache[require.resolve(f2)]
  const { unfinishedAgents } = require(f2)

  const left = unfinishedAgents(lab2, 900)
  left.length === 1 && left[0] === 'qa-tester'
    ? ok('끝나지 않은 팀원을 잡아낸다')
    : bad('미완료 팀원', JSON.stringify(left) + ' — 못 잡으면 "작업 종료"로 알린다')
  unfinishedAgents(lab2, 2000).length === 0
    ? ok('이번 실행 뒤에 아무 일도 없으면 없다고 한다')
    : bad('미완료 판정', '지난 실행 것을 끌어온다')
  inLead(/배경으로 넘기고 끝내지 마라/)
    ? ok('배경으로 넘기고 답하는 것을 막았다')
    : bad('배경 실행', 'SendMessage로 맡기고 턴을 끝내는 길이 열려 있다')
  // 순서에 이름이 없으면 그 단계는 없는 것이 된다 — QA로 한 번, 릴리스로 또 한 번 겪었다.
  inLead(/release-manager/)
    ? ok('배포를 요구하면 릴리스를 부르라고 적혀 있다')
    : bad('릴리스 단계', '지시에 배포가 있어도 아무도 안 부른다 — 실측 0회')
  inLead(/빠뜨린 것은 밝혀라/)
    ? ok('요구를 빠뜨렸으면 밝히라고 적혀 있다')
    : bad('누락 고지', '조용히 빠뜨리면 사람은 다 됐다고 믿는다')
  fs.rmSync(lab2, { recursive: true, force: true })
}

// ── 11. 팀원 고용·해고 ─────────────────────────────────────────────────────
//
// 여기서 보는 것은 전부 "이게 어긋나면 기능이 통째로 무효가 되는" 자리다:
//   좌석    id가 아니라 순서에 묶으면 한 명 해고에 사무실이 통째로 재배치된다
//   해고    지우면 사람이 고쳐 둔 정의를 되살릴 수단이 없다
//   세팅    갱신이 해고자를 되살리면 해고 기능 자체가 없는 것과 같다
//   대기열  해고한 사람 앞으로 온 지시가 남으면 리드가 없는 사람을 부르다 실패한다
{
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  // 상수는 **원본을 그대로 떼어 온다.** 복사본을 검사하면 검사가 거짓말을 한다.
  const constLine = (name) => {
    const i = src.indexOf('const ' + name + ' =')
    if (i < 0) throw new Error(`main.js에서 ${name}을 찾지 못했습니다`)
    return src.slice(i, src.indexOf('\n', i))
  }
  const presetSrc = (() => {
    const i = src.indexOf('const PRESET_SEATS = [')
    return src.slice(i, src.indexOf('\n]\n', i) + 3)
  })()

  const T = loadFrom(
    'main.js',
    [
      'configPath', 'loadConfig', 'saveConfig', 'loadProjects', 'appendJsonl',
      'agentsDirOf', 'firedDirOf', 'userAgentsDir', 'parseAgentFile', 'firedIds',
      'assignSeats', 'invalidateTeam', 'readTeam', 'freeSeats', 'companyBusy',
      'teamCatalog', 'listTeam', 'teamWriteBlock', 'afterTeamChange',
      'hireAgent', 'yamlValue', 'renderAgentFile', 'createAgent',
      'requeueToLead', 'fireAgent', 'setupProject', 'staleAgents',
      'rosterLine', 'promptFor',
    ],
    [
      "const fs = require('fs')",
      "const path = require('path')",
      // Electron 대신 임시 폴더를 가리킨다(호출할 때마다 읽으므로 뒤에서 바꿔도 된다).
      "const app = { getPath: (k) => process.env['TV_PATH_' + k] }",
      "const CONFIG_NAME = 'config.json'",
      "const COMMANDS_NAME = 'team-commands.jsonl'",
      'const MAX_PROJECTS = 3',
      constLine('FIRED_DIRNAME'),
      constLine('SEAT_CAPACITY'),
      presetSrc,
      constLine('SAFE_AGENT_ID'),
      constLine('SAFE_TOOL'),
      constLine('TEAM_TTL_MS'),
      // 검사에서 손댈 수 있게 밖으로 꺼내 둔다
      'const teamCache = global.__teamCache = new Map()',
      'const companies = global.__companies = new Map()',
      'const healthCache = new Map()',
      'const templateDir = () => ' + JSON.stringify(path.join(ROOT, 'templates')),
      "const eventsFileFor = (d) => path.join(d, '.claude', 'team-events.jsonl')",
      'const pumpStatusAll = () => {}',
      'const logRenderer = () => {}',
      'const mergeHooks = () => 0',
      'const refreshTeamRules = () => null',
      // 프롬프트 본문은 여기서 볼 것이 아니다(위 8번에서 따로 본다)
      "const HANDOFF = ''",
      "const BOUNDARY = ''",
      "const DELIVERABLE = ''",
      '',
    ].join('\n'),
  )

  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-home-'))
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-data-'))
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-prjA-'))
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-prjB-'))
  const C = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-prjC-'))
  process.env.TV_PATH_userData = DATA
  process.env.TV_PATH_home = HOME
  for (const d of [A, B, C]) fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ projects: [A, B, C] }), 'utf8')

  const TPL = path.join(ROOT, 'templates', 'agents')
  const agentsOf = (d) => path.join(d, '.claude', 'agents')
  const fresh = () => global.__teamCache.clear() // 파일을 손으로 바꿨으면 캐시를 버린다
  const mkAgent = (folder, id, desc, tools) => {
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(
      path.join(folder, id + '.md'),
      `---\nname: ${id}\ndescription: ${desc}\ntools: ${tools}\n---\n\n너는 ${id}다.\n`,
      'utf8',
    )
  }
  const seatOf = (dir, id) => readOf(dir).find((m) => m.id === id)?.seat
  const readOf = (dir) => T.readTeam(dir)

  // (1) 세 명을 읽어 오는가
  mkAgent(agentsOf(A), 'planner', '기획을 맡는다', 'Read, Write')
  mkAgent(agentsOf(A), 'backend-dev', '서버를 만든다', 'Read, Write, Bash')
  mkAgent(agentsOf(A), 'data-analyst', '지표를 본다', 'Read, Bash')
  fresh()
  {
    const team = readOf(A)
    eq('명단에 리드가 항상 있다', team[0].id, 'lead')
    eq('리드는 해고할 수 없다', team[0].fireable, 'false')
    const ids = team.map((m) => m.id)
    eq('디스크에 있는 세 명을 읽는다', ids.filter((i) => i !== 'lead').length, 3)
    const be = team.find((m) => m.id === 'backend-dev')
    eq('설명을 읽는다', be.desc, '서버를 만든다')
    eq('도구를 읽는다', be.tools.join('|'), 'Read|Write|Bash')
    eq('프로젝트 팀원은 해고할 수 있다', be.fireable, 'true')
  }

  // (2) frontmatter가 깨져도 파일명으로 살아나는가 — 한 장 때문에 사무실이 비면 안 된다
  fs.writeFileSync(path.join(agentsOf(A), 'ghost.md'), '아무 형식도 없는 메모\n', 'utf8')
  fresh()
  {
    const team = readOf(A)
    const g = team.find((m) => m.id === 'ghost')
    g ? ok('frontmatter가 없어도 파일명으로 살아난다') : bad('frontmatter 없음', 'ghost가 명단에서 사라졌다')
    eq('설명이 없으면 빈 문자열(던지지 않는다)', g ? g.desc : null, '')
    eq('깨진 파일 하나가 나머지를 죽이지 않는다', team.length, 5) // 리드 + 4
  }

  // (2-1) 같은 id가 전역에도 있으면 프로젝트가 이긴다 (Claude Code와 같은 규칙)
  mkAgent(path.join(HOME, '.claude', 'agents'), 'backend-dev', '전역 백엔드', 'Read')
  mkAgent(path.join(HOME, '.claude', 'agents'), 'global-only', '이 컴퓨터 전체의 팀원', 'Read')
  fresh()
  {
    const team = readOf(A)
    eq('같은 id면 프로젝트가 이긴다', team.find((m) => m.id === 'backend-dev').desc, '서버를 만든다')
    const go = team.find((m) => m.id === 'global-only')
    eq('전역 팀원도 명단에 든다', go ? go.scope : null, 'user')
    eq('전역 팀원은 여기서 해고할 수 없다', go ? go.fireable : null, 'false')
    const res = T.fireAgent(A, 'global-only')
    eq('전역 팀원 해고는 거절된다', res.ok, 'false')
    eq('전역 팀원 파일은 그대로다', fs.existsSync(path.join(HOME, '.claude', 'agents', 'global-only.md')), 'true')
  }

  // (3) **프리셋 10명의 자리가 오늘 값과 정확히 같은가** ← 회귀의 핵심
  // 이 값이 바뀌면 이미 돌아가는 회사의 사무실이 통째로 재배치된다.
  const WANT_SEATS = {
    planner: 0, 'ux-designer': 1, 'frontend-dev': 2, 'backend-dev': 3, 'mobile-dev': 4,
    'code-reviewer': 5, 'qa-tester': 6, debugger: 7, 'release-manager': 8, scout: 9,
  }
  fs.mkdirSync(agentsOf(B), { recursive: true })
  for (const f of fs.readdirSync(TPL)) fs.copyFileSync(path.join(TPL, f), path.join(agentsOf(B), f))
  fresh()
  {
    let wrong = []
    for (const [id, want] of Object.entries(WANT_SEATS)) {
      const got = seatOf(B, id)
      if (got !== want) wrong.push(`${id}: ${got} ≠ ${want}`)
    }
    wrong.length === 0
      ? ok('프리셋 10명의 자리가 오늘 값 그대로다')
      : bad('좌석 프리셋', wrong.join(', '))
    // 전역 팀원(global-only)도 이 프로젝트에서 부를 수 있으니 자리를 차지한다: 14 - 10 - 1
    eq('전역 팀원까지 세어 남은 자리를 낸다', T.listTeam(B).free, 3)
    eq('전역 팀원도 자리를 받는다', seatOf(B, 'global-only'), 10)
  }

  // (3-1) 프리셋에 없는 사람은 가장 낮은 빈 번호를 받고 그 자리에 굳는다
  mkAgent(agentsOf(B), 'data-analyst', '지표를 본다', 'Read, Bash')
  fresh()
  {
    eq('새 팀원은 가장 낮은 빈 번호를 받는다', seatOf(B, 'data-analyst'), 11)
    const saved = (T.loadConfig().seats ?? {})[B] ?? {}
    eq('그 자리를 앱 설정에 적어 둔다', saved['data-analyst'], 11)
    eq('프리셋은 설정에 적지 않는다(코드가 진실)', saved.planner, 'undefined')
    eq('프로젝트 폴더에는 쓰지 않는다', fs.existsSync(path.join(B, '.claude', 'seats.json')), 'false')
  }

  // (3-2) 장부 번호가 프리셋과 부딪히면 프리셋이 이기고 장부를 다시 적는다
  {
    const cfg = T.loadConfig()
    cfg.seats[B]['data-analyst'] = 3 // backend-dev 자리
    T.saveConfig(cfg)
    fresh()
    eq('프리셋 자리는 뺏기지 않는다', seatOf(B, 'backend-dev'), 3)
    const moved = seatOf(B, 'data-analyst')
    moved !== 3 && moved !== null ? ok(`부딪힌 쪽이 빈 자리로 비켜난다 (${moved}번)`) : bad('좌석 충돌', String(moved))
    eq('비켜난 자리를 장부에 다시 적는다', (T.loadConfig().seats[B] ?? {})['data-analyst'], moved)
  }

  // (7) 해고 전에 대기열을 만들어 둔다 — 그 사람 앞으로 온 지시가 리드로 가야 한다
  const queueFile = path.join(B, '.claude', 'team-commands.jsonl')
  fs.writeFileSync(
    queueFile,
    [
      JSON.stringify({ ts: 1, agent: 'mobile-dev', text: '앱 화면 고쳐줘', status: 'pending' }),
      JSON.stringify({ ts: 2, agent: 'planner', text: '기획 정리해줘', status: 'pending' }),
      JSON.stringify({ ts: 3, agent: 'mobile-dev', text: '빌드 확인해줘', status: 'pending' }),
      '{ 깨진 줄 }',
    ].join('\n') + '\n',
    'utf8',
  )

  // (4)(5)(7) 해고
  const before = Object.fromEntries(Object.keys(WANT_SEATS).map((id) => [id, seatOf(B, id)]))
  const fired = T.fireAgent(B, 'mobile-dev')
  eq('해고가 성공한다', fired.ok, 'true')
  {
    fresh()
    const moved = Object.entries(before).filter(([id, s]) => id !== 'mobile-dev' && seatOf(B, id) !== s)
    moved.length === 0
      ? ok('한 명을 해고해도 나머지 자리는 그대로다')
      : bad('좌석 고정', moved.map(([id]) => id).join(', ') + '가 밀렸다')
    eq('해고한 사람은 명단에서 빠진다', readOf(B).some((m) => m.id === 'mobile-dev'), 'false')
    // 프리셋 10 + 전역 1 + data-analyst 1 = 12명이었고, 한 명이 나가 11명이 남는다
    eq('해고는 그 번호 하나만 비운다', T.listTeam(B).free, 3)
  }
  eq('정의 파일을 지우지 않는다(원래 자리에서만 사라진다)', fs.existsSync(path.join(agentsOf(B), 'mobile-dev.md')), 'false')
  eq('team-fired/로 옮겨졌다', fs.existsSync(path.join(B, '.claude', 'team-fired', 'mobile-dev.md')), 'true')
  eq('옮긴 경로를 응답에 담는다', fired.movedTo, path.join(B, '.claude', 'team-fired', 'mobile-dev.md'))
  eq('대기열에서 그 사람 앞 지시를 리드로 돌린다', fired.requeued, 2)
  {
    const lines = fs.readFileSync(queueFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())
    const agents = lines.map((l) => { try { return JSON.parse(l).agent } catch { return '깨짐' } })
    eq('해고한 사람 앞으로 온 지시가 남지 않는다', agents.includes('mobile-dev'), 'false')
    eq('다른 사람 지시는 건드리지 않는다', agents.filter((a) => a === 'planner').length, 1)
    eq('지시 내용은 그대로 남는다', lines.length, 4)
    eq('깨진 줄도 버리지 않는다', agents.includes('깨짐'), 'true')
  }
  {
    const ev = fs.readFileSync(path.join(B, '.claude', 'team-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const last = ev[ev.length - 1]
    eq('해고를 이벤트 한 줄로 남긴다', `${last.type}:${last.agent}`, 'fire:mobile-dev')
    eq('작업 배지가 붙을 detail을 넣지 않는다', last.detail, 'undefined')
  }

  // (6) 세팅(갱신)이 해고자를 되살리지 않는가 — 이게 빠지면 기능 자체가 무효다
  {
    const res = T.setupProject(B, { agents: true, update: true })
    eq('갱신이 끝까지 간다', res.ok, 'true')
    eq('갱신이 해고자를 되살리지 않는다', fs.existsSync(path.join(agentsOf(B), 'mobile-dev.md')), 'false')
    eq('해고자는 "낡음"으로 세지 않는다', T.staleAgents(B), 0)
  }

  // (1-1) 해고자를 다시 부르면 **그 파일이 그대로 돌아온다**(사람이 고쳐 둔 내용이 산다)
  {
    const firedFile = path.join(B, '.claude', 'team-fired', 'mobile-dev.md')
    fs.appendFileSync(firedFile, '\n## 사람이 덧붙인 규칙\n손으로 고친 내용이다.\n', 'utf8')
    const res = T.hireAgent(B, 'mobile-dev')
    eq('다시 고용이 성공한다', res.ok, 'true')
    eq('해고자 파일을 우선 복원한다', res.from, 'fired')
    const back = fs.readFileSync(path.join(agentsOf(B), 'mobile-dev.md'), 'utf8')
    eq('사람이 고쳐 둔 내용이 살아 돌아온다', back.includes('사람이 덧붙인 규칙'), 'true')
    eq('해고자 폴더에서는 사라진다', fs.existsSync(firedFile), 'false')
    fresh()
    eq('돌아온 사람은 원래 자리로 앉는다', seatOf(B, 'mobile-dev'), 4)
  }

  // (8) promptFor에 실제 팀원 목록이 들어가는가 — 문서에만 있는 사람을 부르면 실패한다
  {
    fresh()
    const p = T.promptFor({ agent: 'lead', text: '무언가 해줘' }, B)
    eq('프롬프트에 실제 팀원 목록이 들어간다', /이 회사의 팀원/.test(p), 'true')
    eq('명단에 있는 사람이 프롬프트에 적힌다', p.includes('qa-tester'), 'true')
    eq('없는 사람은 없는 사람이라고 못 박는다', /없으면 없는 사람/.test(p), 'true')
    // 해고한 사람이 프롬프트에 남으면 리드가 그 사람을 부른다
    T.fireAgent(B, 'debugger')
    fresh()
    eq('해고한 사람은 프롬프트에서도 빠진다', T.promptFor({ agent: 'lead', text: 'x' }, B).includes('debugger'), 'false')
  }

  // (9) 자리가 꽉 차면
  {
    for (let i = 1; i <= 14; i++) mkAgent(agentsOf(C), 'x' + String(i).padStart(2, '0'), `${i}번`, 'Read')
    fresh()
    const list = T.listTeam(C)
    eq('열네 명까지는 모두 자리가 있다', list.members.filter((m) => m.seat !== null).length, 14)
    eq('남은 자리가 0이다', list.free, 0)
    eq('상한을 응답에 담는다', list.capacity, 14)
    const res = T.hireAgent(C, 'planner')
    eq('자리가 없으면 고용을 거절한다', res.ok, 'false')
    eq('자리가 없다고 알린다', res.full, 'true')
    eq('거절했으면 파일도 만들지 않는다', fs.existsSync(path.join(agentsOf(C), 'planner.md')), 'false')
    const cr = T.createAgent(C, { id: 'one-more', description: '한 명 더', tools: ['Read'] })
    eq('직접 만들기도 자리가 없으면 거절한다', cr.full, 'true')
    // 사람이 파일을 손으로 넣으면 열다섯 번째가 생길 수 있다. 없는 칸에 그리지 않게 비워 보낸다.
    mkAgent(agentsOf(C), 'x15', '열다섯 번째', 'Read')
    fresh()
    eq('열다섯 번째는 자리가 없다(seat: null)', T.readTeam(C).find((m) => m.id === 'x15').seat, 'null')
  }

  // (10) 직접 만들기 — id 검증과 뼈대
  {
    const V = (label, spec) => {
      const r = T.createAgent(A, spec)
      r.ok === false && r.code === 'VALIDATION' ? ok(`직접 만들기 거절: ${label}`) : bad('id 검증', `${label} — ${JSON.stringify(r)}`)
    }
    V('빈 id', { id: '   ', description: '무언가' })
    V('대문자·공백이 섞인 id', { id: 'Data Analyst', description: '무언가' })
    V('경로가 섞인 id', { id: '../evil', description: '무언가' })
    V('이미 있는 팀원', { id: 'planner', description: '무언가' })
    V('카탈로그에 있는 팀원', { id: 'qa-tester', description: '무언가' })
    V('설명이 비었음', { id: 'ops-runner', description: '  ' })
    V('이상한 도구 이름', { id: 'ops-runner', description: '운영', tools: ['rm -rf /'] })
    V('lead라는 이름', { id: 'lead', description: '리드' })
    {
      // 해고자와 같은 id도 막는다 — 새로 만들면 고쳐 둔 정의가 묻힌다
      const r = T.createAgent(B, { id: 'debugger', description: '새 디버거' })
      eq('해고자와 같은 id는 거절한다', r.code, 'VALIDATION')
    }

    const made = T.createAgent(A, {
      id: 'ops-runner',
      label: '운영',
      description: '배포 후 운영 지표를 본다',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    })
    eq('직접 만들기가 성공한다', made.ok, 'true')
    eq('label을 응답으로 돌려준다', made.label, '운영')
    made.basedOn ? ok(`무엇을 본으로 삼았는지 밝힌다 (${made.basedOn})`) : bad('본 파일', 'basedOn이 없다')
    const text = fs.readFileSync(made.path, 'utf8')
    eq('빈 파일을 만들지 않는다', text.length > 400, 'true')
    eq('frontmatter로 시작한다', text.startsWith('---\n'), 'true')
    eq('name이 들어간다', /\nname: ops-runner\n/.test(text), 'true')
    eq('description이 들어간다', text.includes('배포 후 운영 지표를 본다'), 'true')
    eq('tools가 들어간다', /\ntools: Read, Grep, Glob, Bash\n/.test(text), 'true')
    eq('label을 파일에 새 키로 넣지 않는다', /\nlabel\s*:/.test(text), 'false')
    // **같은 뼈대인가.** 본 정의의 문단이 통째로 빠지면 품질 기준이 같이 빠진다.
    const baseText = fs.readFileSync(path.join(TPL, made.basedOn), 'utf8').replace(/\r\n/g, '\n')
    const heads = (s) => (s.match(/^## .*$/gm) || []).map((h) => h.trim())
    const missing = heads(baseText).filter((h) => !heads(text).includes(h))
    missing.length === 0
      ? ok(`본 정의의 규칙 문단을 모두 물려받는다 (${heads(baseText).length}개)`)
      : bad('뼈대', `빠진 문단: ${missing.join(', ')}`)
    eq('본 정의의 역할 선언은 갈아 끼운다', text.includes('너는 운영 담당이다'), 'true')
    // 만든 파일을 다시 읽어 명단에 서는지 — 못 읽으면 화면에 안 뜬다
    fresh()
    const m = T.readTeam(A).find((x) => x.id === 'ops-runner')
    eq('만든 팀원이 명단에 선다', m ? m.desc : null, '배포 후 운영 지표를 본다')
    eq('만든 팀원도 도구가 읽힌다', m ? m.tools.length : 0, 4)
  }

  // (11) 처리 중이면 전부 막는다
  {
    global.__companies.set(A, { dir: A, child: { pid: 1 } })
    for (const [label, res] of [
      ['고용', T.hireAgent(A, 'scout')],
      ['직접 만들기', T.createAgent(A, { id: 'busy-one', description: '무언가' })],
      ['해고', T.fireAgent(A, 'planner')],
    ]) {
      res.ok === false && res.busy === true ? ok(`처리 중 거절: ${label}`) : bad('처리 중 차단', `${label} — ${JSON.stringify(res)}`)
    }
    eq('거절했으면 파일도 만들지 않는다', fs.existsSync(path.join(agentsOf(A), 'scout.md')), 'false')
    eq('거절했으면 해고도 일어나지 않는다', fs.existsSync(path.join(agentsOf(A), 'planner.md')), 'true')
    eq('목록은 처리 중임을 알려 준다', T.listTeam(A).busy, 'true')
    global.__companies.delete(A)
  }

  // (12) 카탈로그
  {
    fresh()
    const cat = T.teamCatalog(B)
    const state = (id) => cat.find((c) => c.id === id)?.state
    eq('있는 사람은 employed', state('planner'), 'employed')
    eq('해고한 사람은 fired', state('debugger'), 'fired')
    eq('카탈로그 순서는 자리 순', cat[0].id, 'planner')
    const catA = T.teamCatalog(A)
    eq('아직 안 부른 사람은 available', catA.find((c) => c.id === 'release-manager')?.state, 'available')
  }

  // (13) 앱이 팀원 정의를 지우는 경로를 만들지 않았는가
  {
    const at = src.indexOf('function fireAgent(')
    const fireSrc = src.slice(at, src.indexOf('\n}\n', at))
    const movesOnly = /renameSync/.test(fireSrc) && !/unlink|rmSync/.test(fireSrc)
    movesOnly
      ? ok('해고는 옮기기만 한다(지우는 코드가 없다)')
      : bad('해고 방식', '정의 파일을 지우는 경로가 생겼다 — 사람이 고쳐 둔 내용을 되살릴 수단이 없다')
  }

  // (14) 화면과 메인이 **같은 좌석표**를 보고 있는가.
  //
  // 자리를 고르는 쪽은 메인이고 그리는 쪽은 화면이다. 표가 어긋나면 아무 오류 없이
  // 엉뚱한 자리에 앉는다 — 그건 화면을 봐야만 알 수 있는 종류의 고장이다.
  {
    const ui = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8').replace(/\r\n/g, '\n')
    const i = ui.indexOf('PRESET_SEATS = [')
    const uiPreset = i < 0 ? null : (ui.slice(i, ui.indexOf('\n]', i)).match(/'([a-z0-9-]+)'/g) || []).map((s) => s.slice(1, -1))
    if (!uiPreset) {
      console.log('  · (알림) renderer/agents.js에서 PRESET_SEATS를 찾지 못했다 — 좌석표 대조를 건너뛴다')
    } else {
      const mine = (presetSrc.match(/'([a-z0-9-]+)'/g) || []).map((s) => s.slice(1, -1))
      eq('화면과 메인의 좌석표가 같다', uiPreset.join(','), mine.join(','))
    }
    const cells = (ui.slice(ui.indexOf('const DESK_CELLS = ['), ui.indexOf('\n]', ui.indexOf('const DESK_CELLS = ['))).match(/\{ gx:/g) || []).length
    if (!cells) console.log('  · (알림) renderer/agents.js의 DESK_CELLS를 세지 못했다 — 정원 대조를 건너뛴다')
    else eq('화면의 책상 수와 메인의 정원이 같다', cells, 14)
    // 인사 이벤트를 화면이 따로 받지 않으면 default 가지에 걸려 **가짜 활동**으로 뜬다.
    const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')
    if (!/'hire'/.test(app)) {
      console.log("  · (알림) renderer가 아직 'hire'·'fire' 이벤트를 다루지 않는다 — 그대로 두면 작업 배지가 붙는다")
    }
  }

  for (const d of [HOME, DATA, A, B, C]) fs.rmSync(d, { recursive: true, force: true })
}

// ── 15. 로그인 계정 표시·전환 ──────────────────────────────────────────────
//
// 여기서 보는 것도 전부 실제로 어긋났던(또는 어긋나면 조용히 위험한) 자리다:
//
//   계정 표시   `claude auth status`가 JSON을 안 줄 수 있다(설치 안 됨·버전 변경·안내
//               문구). 그때 던지면 환경 확인이 앱을 통째로 막는다
//   개인정보    email·orgName은 화면과 IPC 응답에만 쓴다. orgId는 아예 읽지 않는다
//   전환        로그아웃하면 **돌고 있는 claude가 인증을 잃어 지시가 전부 실패한다** —
//               처리 중이면 메인에서 거절해야 한다(화면만 믿으면 늦는다)
//   반쯤 나간 상태  logout이 실패했는데 로그인 창을 띄우면 무엇이 참인지 알 수 없다
//   figma 인증   **`mcp add`는 등록만 하고 끝난다 — 인증을 시작하지 않는다.** 실제로
//               `Figma 연결`을 눌러도 "Added HTTP MCP server figma …" 두 줄만 찍히고
//               아무 일도 안 일어났다. 브라우저를 여는 명령은 `mcp login`이다.
//               그래서 **어떤 명령이 어떤 순서로 불리는가**를 여기서 못 박는다.
async function accountChecks() {
  console.log('\n로그인 계정 표시·전환')
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const constLine = (name) => {
    const i = src.indexOf('const ' + name + ' =')
    if (i < 0) throw new Error(`main.js에서 ${name}을 찾지 못했습니다`)
    return src.slice(i, src.indexOf('\n', i))
  }

  const E = loadFrom(
    'main.js',
    ['parseAuthStatus', 'checkEnv', 'openAndWatch', 'runningCompanies', 'firstLine', 'figmaRegistered', 'connectFigma', 'switchAccount'],
    [
      "const path = require('path')",
      'let envCache = null',
      'const ENV_TTL_MS = 300000',
      // 떼어 낸 코드는 임시 폴더에서 돌아 상대 require가 안 통한다. 뿌리를 박아 준다.
      'const ROOT_DIR = ' + JSON.stringify(ROOT),
      // NOT_FOUND는 install.js 것을 그대로 쓴다(main.js가 그렇게 가져다 쓴다).
      "const installer = require(path.join(ROOT_DIR, 'install.js'))",
      constLine('NOT_FOUND'),
      // 명령줄 자체가 검사 대상이다 — 여기서 다시 적으면 main.js와 어긋나도 모른다.
      constLine('FIGMA_URL'),
      constLine('FIGMA_ADD'),
      constLine('FIGMA_LOGIN'),
      // **성공 판정표도 main.js 것을 그대로 쓴다.** 여기서 다시 적으면 판정이 바뀌어도 모른다.
      constLine('WATCH_DONE'),
      // 감시는 실제로 몇 초씩 기다린다. 검사에서는 흐름만 보면 되므로 짧게 줄인다.
      // (진짜 간격이 맞는지는 아래 watchBackoffChecks가 main.js 원본으로 따로 본다.)
      'const WATCH_DELAYS_MS = [1, 1]',
      'const companies = global.__envCompanies = new Map()',
      'const calls = global.__calls = []',
      'const replies = global.__replies = new Map()',
      "const runClaude = async (args) => { const k = args.join(' '); calls.push(k); return replies.get(k) ?? { err: null, out: '', errOut: '' } }",
      // 창은 **핸들**을 돌려준다(닫으려면 pid가 필요하다). 못 여는 OS는 false 그대로.
      "const openInTerminal = (args) => { calls.push('창: ' + args.join(' ')); return global.__terminalOk === false ? false : { pid: 4242, exe: 'claude' } }",
      "const closeTerminal = (w) => { if (w && w.pid) calls.push('창닫기: ' + w.pid) }",
      'const send = () => {}',
      '',
    ].join('\n'),
  )

  const LIVE = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'someone@example.com',
    // 값은 가짜여야 한다(nil UUID). 이 픽스처는 저장소에 남고, 남으면 공개된다 —
    // 검사의 뜻은 "이 문자열이 응답 어디에도 없다"이지 실제 조직을 쓰는 게 아니다.
    orgId: '00000000-0000-0000-0000-000000000000',
    orgName: "someone@example.com's Organization",
    subscriptionType: 'max',
  }
  const reset = (replies = {}) => {
    global.__calls.length = 0
    global.__replies.clear()
    global.__envCompanies.clear()
    global.__terminalOk = true
    for (const [k, v] of Object.entries(replies)) {
      global.__replies.set(k, { err: null, out: '', errOut: '', ...v })
    }
  }
  const said = (needle) => global.__calls.some((c) => c.includes(needle))

  // (1) 계정 정보를 읽어 오는가
  {
    const p = E.parseAuthStatus(JSON.stringify(LIVE))
    eq('로그인 여부를 읽는다', p.loggedIn, 'true')
    eq('이메일을 읽는다', p.email, LIVE.email)
    eq('조직명을 읽는다', p.orgName, LIVE.orgName)
    eq('요금제를 읽는다', p.subscriptionType, 'max')
    eq('인증 방식을 읽는다', p.authMethod, 'claude.ai')
    // CLI가 JSON 앞뒤로 안내 문구를 붙여도 읽어야 한다.
    const noisy = E.parseAuthStatus(`알림: 새 버전이 있습니다\n${JSON.stringify(LIVE)}\n끝.`)
    eq('앞뒤 잡소리가 섞여도 읽는다', noisy.email, LIVE.email)
  }

  // (2) 깨진 입력에서 던지지 않는가 — 환경 확인은 무슨 일이 있어도 앱을 막으면 안 된다
  {
    const junk = ['', '   ', null, undefined, '{', '}', '{"loggedIn":', 'Error: connect ECONNREFUSED', '{"a":1}', '[]', 'null', '{ }']
    let threw = null
    let leaked = false
    for (const t of junk) {
      try {
        const r = E.parseAuthStatus(t)
        if (r.loggedIn !== false || r.email !== null) leaked = true
      } catch (e) {
        threw = `${JSON.stringify(t)} → ${e.message}`
      }
    }
    threw ? bad('깨진 출력에서 던지지 않는다', threw) : ok(`깨진 출력 ${junk.length}가지에서 던지지 않는다`)
    eq('깨진 출력은 "로그인 안 됨"으로 떨어진다', !leaked, 'true')
  }

  // (3) 로그인 안 된 상태에서 계정 정보가 새지 않는가.
  //     CLI가 로그아웃 뒤에도 지난 값을 남겨 줄 수 있다. loggedIn을 먼저 본다.
  {
    const p = E.parseAuthStatus(JSON.stringify({ ...LIVE, loggedIn: false }))
    eq('로그아웃 상태는 loggedIn:false', p.loggedIn, 'false')
    eq('로그아웃 상태에서 이메일이 없다', p.email, 'null')
    eq('로그아웃 상태에서 조직명이 없다', p.orgName, 'null')
    eq('로그아웃 상태에서 요금제가 없다', p.subscriptionType, 'null')
  }

  // (4) checkEnv 결과에 계정 정보가 실리는가
  {
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': { out: 'figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected\n' } })
    const env = await E.checkEnv({ force: true })
    eq('설치됨으로 본다', env.claude.installed, 'true')
    eq('로그인됨으로 본다', env.claude.loggedIn, 'true')
    eq('checkEnv가 이메일을 담는다', env.claude.email, LIVE.email)
    eq('checkEnv가 조직명을 담는다', env.claude.orgName, LIVE.orgName)
    eq('checkEnv가 요금제를 담는다', env.claude.subscriptionType, 'max')
    eq('checkEnv가 인증 방식을 담는다', env.claude.authMethod, 'claude.ai')
    // 예전부터 화면이 쓰던 이름. 이 기능을 안 쓰는 화면도 그대로 돌아야 한다.
    eq('예전 plan 필드도 그대로 채운다', env.claude.plan, 'max')
    eq('figma 판정은 그대로다', env.figma.connected, 'true')
  }

  // (5) 명령이 실패하거나 출력이 비어도 checkEnv가 던지지 않는가
  {
    for (const [label, reply] of [
      ['출력이 비었을 때', { out: '' }],
      ['JSON이 아닐 때', { out: 'claude: 로그인이 필요합니다' }],
      ['오류로 끝났을 때', { err: new Error('exit 1'), errOut: '알 수 없는 오류' }],
    ]) {
      reset({ 'auth status': reply })
      let env = null
      try {
        env = await E.checkEnv({ force: true })
      } catch (e) {
        bad('checkEnv가 던지지 않는다', `${label} — ${e.message}`)
      }
      if (env) {
        env.claude.loggedIn === false && env.claude.email === null
          ? ok(`${label} 안전하게 떨어진다`)
          : bad('안전한 실패', `${label} — ${JSON.stringify(env.claude)}`)
      }
    }
    // 설치 자체가 안 됐으면 installed:false. 예전 판정을 깨지 않았는지 본다.
    reset({ 'auth status': { err: new Error('x'), errOut: "'claude' is not recognized as an internal or external command" } })
    const env = await E.checkEnv({ force: true })
    eq('설치 안 됨을 그대로 가려낸다', env.claude.installed, 'false')
    eq('로그인 안 됐으면 MCP를 물어보지 않는다', said('mcp list'), 'false')
  }

  // (6) orgId는 어디에도 담기지 않는가 — 읽지 않으면 샐 수도 없다
  {
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': { out: 'figma: - ✔ Connected' } })
    const env = await E.checkEnv({ force: true })
    eq('checkEnv 결과에 orgId가 없다', JSON.stringify(env).includes(LIVE.orgId), 'false')
    eq('parseAuthStatus 결과에 orgId 키가 없다', 'orgId' in E.parseAuthStatus(JSON.stringify(LIVE)), 'false')
    eq('main.js가 orgId를 읽는 코드가 없다', /j\.orgId|orgId\s*:|\['orgId'\]/.test(src), 'false')
    // 계정 정보를 만지는 자리는 parseAuthStatus·checkEnv 둘뿐이어야 한다. 다른 데서
    // 손대기 시작하면 이벤트 로그(team-events.jsonl)로 흘러 들어가는 건 시간 문제다.
    const from = src.indexOf('function parseAuthStatus(')
    const to = src.indexOf('\n}\n', src.indexOf('async function checkEnv('))
    const stray = []
    for (const m of src.matchAll(/orgName|authMethod/g)) {
      if (m.index < from || m.index > to) stray.push(src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index)).trim())
    }
    stray.length === 0
      ? ok('계정 정보는 parseAuthStatus·checkEnv 안에서만 다룬다')
      : bad('계정 정보 유출 경로', stray.join(' / '))
  }

  // (7) 처리 중이면 전환을 거절하는가.
  //     로그아웃 = 돌고 있는 claude의 인증이 사라진다 = 그 지시가 통째로 실패한다.
  {
    for (const what of ['claude', 'figma']) {
      reset()
      global.__envCompanies.set('/tmp/윤사무실', { dir: '/tmp/윤사무실', child: { pid: 1 } })
      const res = await E.switchAccount(what)
      res.ok === false && res.busy === true ? ok(`처리 중 거절: ${what}`) : bad('처리 중 차단', `${what} — ${JSON.stringify(res)}`)
      eq(`거절 이유에 회사 이름이 실린다 (${what})`, (res.running || []).join(','), '윤사무실')
      eq(`거절했으면 명령을 하나도 안 돌린다 (${what})`, global.__calls.length, 0)
    }
    // 처리 중인 회사가 없으면 막지 않는다(빈 child는 처리 중이 아니다).
    reset({ 'auth status': { out: JSON.stringify(LIVE) } })
    global.__envCompanies.set('/tmp/쉬는회사', { dir: '/tmp/쉬는회사', child: null })
    const res = await E.switchAccount('claude')
    eq('노는 회사만 있으면 막지 않는다', res.busy, 'undefined')
  }

  // (8) figma 첫 연결 — **등록(add)과 인증(login)은 다른 명령이다.**
  //     `mcp add`만 부르면 등록만 되고 `! Needs authentication`에서 멈춘다. 실제로
  //     이 상태로 나가서 "버튼을 눌러도 아무 일도 안 일어난다"가 됐다.
  const ADD = 'mcp add -s user --transport http figma https://mcp.figma.com/mcp'
  const CONNECTED = { out: 'figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected' }
  const NOT_REGISTERED = { 'mcp get figma': { err: new Error('exit 1'), errOut: 'No MCP server named "figma".' } }
  {
    // 등록이 없을 때: add(조용히) → login(창). 사람이 마쳐야 하는 것은 login뿐이다.
    reset({ ...NOT_REGISTERED, 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': CONNECTED })
    const res = await E.connectFigma('윤사무실 - Figma 연결')
    eq('등록이 없으면 add를 부른다', said(ADD), 'true')
    eq('add 다음에 login을 부른다', said('창: mcp login figma'), 'true')
    eq('add가 login보다 먼저다', global.__calls.indexOf(ADD) < global.__calls.indexOf('창: mcp login figma'), 'true')
    eq('add는 창을 띄우지 않는다(사람 손이 필요 없다)', said('창: mcp add'), 'false')
    eq('스코프는 user다(회사 폴더에서도 보여야 한다)', /-s user/.test(ADD) && said(ADD), 'true')
    eq('인증까지 되면 성공으로 끝난다', res.ok, 'true')

    // 이미 등록돼 있으면 add를 **다시 부르지 않는다.** 같은 이름이 있으면 exit 1로
    // 실패한다(실측: "MCP server figma already exists in user config").
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': CONNECTED })
    await E.connectFigma('윤사무실 - Figma 연결')
    eq('이미 등록돼 있으면 add를 안 부른다', said('mcp add'), 'false')
    eq('등록돼 있어도 login은 부른다', said('창: mcp login figma'), 'true')

    // add가 실패하면 인증 창을 띄우지 않는다 — 등록도 안 된 채로 창만 뜨면 헛수고다.
    reset({ ...NOT_REGISTERED, [ADD]: { err: new Error('exit 1'), errOut: '네트워크에 연결할 수 없습니다' } })
    const bad2 = await E.connectFigma('윤사무실 - Figma 연결')
    eq('add 실패는 실패로 돌려준다', bad2.ok, 'false')
    eq('add 실패면 창을 안 띄운다', said('창:'), 'false')
    eq('왜 실패했는지 알려 준다', bad2.error.includes('네트워크'), 'true')
  }

  // (8-b) figma 다시 연결 — logout → login.
  //       등록 정보(~/.claude.json)와 OAuth 토큰(~/.claude/.credentials.json의 mcpOAuth)은
  //       **다른 파일**에 산다. 그래서 remove/add로는 토큰이 안 지워져 같은 계정으로
  //       도로 붙는다 — 계정을 바꾸려면 logout이어야 한다.
  {
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': CONNECTED })
    const good = await E.switchAccount('figma')
    eq('logout이 먼저다', global.__calls.indexOf('mcp logout figma') < global.__calls.indexOf('창: mcp login figma'), 'true')
    eq('logout 뒤에 인증 창을 띄운다', said('창: mcp login figma'), 'true')
    eq('등록은 건드리지 않는다(remove 금지)', said('mcp remove'), 'false')
    eq('이미 등록돼 있으면 add도 안 부른다', said('mcp add'), 'false')
    eq('다시 인증되면 성공으로 끝난다', good.ok, 'true')

    // 앞 단계가 실패하면 다음을 실행하지 않는다 — 지난 계정이 남은 채 창만 뜨면
    // 같은 계정으로 다시 붙고도 "바꿨다"고 믿게 된다.
    reset({ 'mcp logout figma': { err: new Error('exit 1'), errOut: '자격증명을 지울 수 없습니다' } })
    const bad3 = await E.switchAccount('figma')
    eq('logout 실패는 실패로 돌려준다', bad3.ok, 'false')
    eq('logout 실패면 login을 안 부른다', said('mcp login'), 'false')
    eq('logout 실패면 창도 안 띄운다', said('창:'), 'false')
    eq('왜 실패했는지 알려 준다', bad3.error.includes('자격증명'), 'true')

    // 등록조차 없으면 지울 것도 없다 — logout을 건너뛰고 add → login.
    reset({ ...NOT_REGISTERED, 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': CONNECTED })
    await E.switchAccount('figma')
    eq('등록이 없으면 logout을 건너뛴다', said('mcp logout'), 'false')
    eq('등록이 없으면 add부터 한다', global.__calls.indexOf(ADD) < global.__calls.indexOf('창: mcp login figma'), 'true')
  }

  // (8-c) 창으로 띄우는 명령은 login뿐이다. add를 창으로 띄우면 예전 고장이 그대로
  //       돌아온다(등록만 하고 프롬프트로 돌아가 3분 뒤 timeout).
  {
    eq('main.js가 mcp login을 쓴다', /'mcp',\s*'login',\s*'figma'/.test(src), 'true')
    eq('main.js에 mcp remove figma가 더는 없다', /'mcp',\s*'remove',\s*'figma'/.test(src), 'false')
    eq('창에 건네는 figma 인자는 FIGMA_LOGIN뿐이다', /openAndWatch\('figma',\s*FIGMA_LOGIN,/.test(src), 'true')
    eq('env:login이 figma를 connectFigma로 보낸다', /if \(what === 'figma'\) return connectFigma\(/.test(src), 'true')
    eq('switchAccount도 같은 함수를 쓴다', /connectFigma\('윤사무실 - Figma 다시 연결', \{ relogin: true \}\)/.test(src), 'true')
  }

  // (8-d) checkEnv는 **앱이 만든 `figma`만** 연결로 센다. 같은 목록에 claude.ai 커넥터
  //       `claude.ai Figma`가 ✔ Connected로 떠 있어도 인정하면 안 된다 — 커넥터의 도구는
  //       `mcp__claude_ai_Figma__*`로 붙는데 ux-designer는 `mcp__figma__*`만 허용한다.
  //       인정해 버리면 배너는 초록인데 팀원은 "Figma가 연결되지 않았습니다"를 보고한다.
  {
    const LIST_CONNECTOR_ONLY =
      'claude.ai Figma: https://mcp.figma.com/mcp - ✔ Connected\n' +
      'claude.ai Canva: https://mcp.canva.com/mcp - ! Needs authentication\n'
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': { out: LIST_CONNECTOR_ONLY } })
    const only = await E.checkEnv({ force: true })
    eq('claude.ai 커넥터만 있으면 연결로 세지 않는다', only.figma.connected, 'false')
    eq('등록됨으로도 세지 않는다', only.figma.present, 'false')

    reset({
      'auth status': { out: JSON.stringify(LIVE) },
      'mcp list': { out: LIST_CONNECTOR_ONLY + 'figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\n' },
    })
    const both = await E.checkEnv({ force: true })
    eq('둘 다 있으면 앱 항목의 상태를 따른다', both.figma.connected, 'false')
    eq('앱 항목이 있으면 등록됨이다', both.figma.present, 'true')

    // ux-designer가 실제로 무엇을 부르는지가 이 판단의 근거다. 여기가 바뀌면 위 규칙도
    // 다시 봐야 한다 — 그래서 같이 못 박는다.
    const ux = fs.readFileSync(path.join(ROOT, 'templates/agents/ux-designer.md'), 'utf8')
    eq('ux-designer는 mcp__figma__* 도구를 쓴다', /mcp__figma__whoami/.test(ux), 'true')
    eq('claude.ai 커넥터 도구는 허용 목록에 없다', /mcp__claude_ai_Figma__/.test(ux), 'false')
  }

  // (8-e) **가짜 성공.** 사용자가 한 화면에서 서로 다른 두 말을 봤다:
  //         상단 배너  `Figma 연결이 끊겼습니다` + [Figma 연결]   ← 맞는 말
  //         채팅       `— Figma를 다시 연결했습니다 —`            ← 거짓말
  //       (대화 기록에 그대로 남아 있다.) 그때 실제 상태는 `! Needs authentication`,
  //       저장된 accessToken 길이는 0이었다.
  //
  //       판정이 `what === 'figma' ? env.figma.connected : env.claude.loggedIn`이라
  //       **`figma`가 아닌 것은 전부 "claude 로그인됨"으로 성공**이 됐다. 이미
  //       로그인돼 있으면(늘 그렇다) 첫 확인에서 곧장 ok:true다. 기본값으로 성공하는
  //       길을 여기서 막는다 — 모르면 모른다고 해야 한다.
  const NEEDS_AUTH = { out: 'figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication' }
  {
    // 인증이 안 됐으면 창을 띄웠어도 성공이 아니다.
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': NEEDS_AUTH })
    const res = await E.connectFigma('윤사무실 - Figma 연결')
    eq('인증 안 됐으면 성공이 아니다', res.ok, 'false')
    eq('인증 안 됐으면 timeout으로 말한다', res.timeout, 'true')
    eq('돌려주는 env도 연결 안 됨이다', res.env.figma.connected, 'false')

    // 재현했던 구멍 그대로: `figma`가 아닌 이름으로 들어오면 claude 로그인만 보고
    // 곧장 성공했다. 이제는 **창조차 띄우지 않는다.**
    for (const what of [undefined, null, '', 'Figma', 'figma ', 'mcp', 0]) {
      reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': NEEDS_AUTH })
      const r = await E.openAndWatch(what, ['auth', 'login'], '윤사무실 - 시험')
      if (r.ok !== false || said('창:')) {
        bad('모르는 항목은 성공이 아니다', `${JSON.stringify(what)} — ${JSON.stringify(r)}`)
      }
    }
    ok('모르는 항목은 창도 안 띄우고 성공도 아니다')

    // claude 쪽 판정이 figma를 대신 답하지 않는지도 못 박는다.
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': NEEDS_AUTH })
    const f = await E.openAndWatch('figma', ['mcp', 'login', 'figma'], '윤사무실 - Figma 연결')
    eq('claude 로그인만으로 figma를 성공이라 하지 않는다', f.ok, 'false')
  }

  // (8-f) 화면도 **같은 근거**를 보는가. 배너는 env를, 채팅은 ok만 보고 있었다 —
  //       근거가 갈린 것이 두 문구가 어긋난 이유다.
  {
    const R = loadFrom('renderer/app.js', ['envConfirms'])
    const OFF = { claude: { loggedIn: true }, figma: { connected: false, present: true } }
    const ON = { claude: { loggedIn: true }, figma: { connected: true, present: true } }
    eq('연결 안 됐으면 확인해 주지 않는다', R.envConfirms('figma', OFF), 'false')
    eq('연결됐을 때만 확인해 준다', R.envConfirms('figma', ON), 'true')
    eq('env가 없으면 확인해 주지 않는다', R.envConfirms('figma', null), 'false')
    eq('claude는 로그인 여부로 본다', R.envConfirms('claude', { claude: { loggedIn: false }, figma: {} }), 'false')

    const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8').replace(/\r\n/g, '\n')
    // 성공 문구 두 곳이 **모두** envConfirms를 거쳐야 한다. 하나만 고치면 또 갈린다.
    eq('채팅 줄은 envConfirms를 거친다', /res\?\.ok && envConfirms\(what, res\.env\)\)\s*\{\s*\n\s*\/\/[\s\S]{0,200}?addMsg\('sys'/.test(app), 'true')
    eq('배너 아래 안내도 envConfirms를 거친다', /if \(res\?\.ok && envConfirms\(what, res\.env\)\) \{\s*\n\s*renderEnv\(res\.env\)\s*\n\s*hintEl/.test(app), 'true')
    eq('ok만 보고 성공을 적는 곳이 없다', /if \(res\?\.ok\) \{/.test(app), 'false')
    // 배너가 보는 것과 같은 값인지 — 둘 다 env.figma.connected다.
    eq('배너도 같은 값을 본다', /if \(!env\.figma\.connected\) \{/.test(app), 'true')
  }

  // (8-g) **창을 닫는다.** `cmd /k`라 인증이 끝나도 빈 프롬프트 창이 남았다.
  //       여러 번 누르면 쌓인다(실제로 네 개까지). 성공했으면 읽을 것이 없으니 닫는다.
  //       실패·시간 초과면 **닫지 않는다** — 실패는 이유를 봐야 하고, 시간 초과는
  //       아직 브라우저에서 마치는 중일 수 있다.
  {
    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': CONNECTED })
    await E.connectFigma('윤사무실 - Figma 연결')
    eq('figma 인증이 끝나면 창을 닫는다', said('창닫기: 4242'), 'true')

    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': NEEDS_AUTH })
    await E.connectFigma('윤사무실 - Figma 연결')
    eq('시간이 지났으면 창을 두고 온다', said('창닫기'), 'false')

    reset({ 'auth logout': {}, 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': { out: '' } })
    await E.switchAccount('claude')
    eq('claude 계정 전환도 끝나면 창을 닫는다', said('창닫기: 4242'), 'true')

    reset({ 'auth logout': {}, 'auth status': { out: JSON.stringify({ ...LIVE, loggedIn: false }) } })
    await E.switchAccount('claude')
    eq('로그인이 안 끝났으면 창을 두고 온다', said('창닫기'), 'false')
  }

  // (9) claude — logout이 실패하면 로그인 창을 띄우지 않는다(반쯤 나간 상태 금지)
  {
    reset({ 'auth logout': { err: new Error('exit 1'), errOut: '네트워크에 연결할 수 없습니다' } })
    const res = await E.switchAccount('claude')
    eq('logout 실패는 실패로 돌려준다', res.ok, 'false')
    eq('logout 실패면 로그인 창을 안 띄운다', said('창:'), 'false')
    eq('logout 실패면 login도 안 부른다', said('auth login'), 'false')
    eq('왜 실패했는지 알려 준다', res.error.includes('네트워크'), 'true')

    reset({ 'auth status': { out: JSON.stringify(LIVE) }, 'mcp list': { out: '' } })
    const good = await E.switchAccount('claude')
    eq('logout이 먼저다', global.__calls[0], 'auth logout')
    eq('logout 뒤에 로그인 창을 띄운다', said('창: auth login'), 'true')
    eq('로그인이 확인되면 성공', good.ok, 'true')
    eq('바뀐 계정을 응답에 실어 준다', good.env.claude.email, LIVE.email)
  }

  // (10) 터미널을 못 여는 OS에서는 명령을 알려 준다(조용히 성공하지 않는다)
  {
    reset()
    global.__terminalOk = false
    const res = await E.switchAccount('claude')
    eq('창을 못 띄우면 실패로 돌려준다', res.ok, 'false')
    eq('직접 칠 명령을 알려 준다', res.manual, 'claude auth login')
    eq('창을 못 띄우면 왜인지도 알려 준다', Boolean(res.error), 'true')
  }

  // (10-b) 끝까지 안 끝나면 timeout으로 돌려준다 — 성공으로 위장하지 않는다
  {
    reset({ 'auth logout': {}, 'auth status': { out: JSON.stringify({ ...LIVE, loggedIn: false }) } })
    const res = await E.switchAccount('claude')
    eq('안 끝나면 성공이 아니다', res.ok, 'false')
    eq('안 끝나면 timeout을 세운다', res.timeout, 'true')
    eq('실패 응답에는 error가 늘 있다', Boolean(res.error), 'true')
    eq('안 끝났으면 계정 정보를 지어내지 않는다', res.env.claude.email, 'null')
  }

  // (11) 알 수 없는 대상은 아무것도 하지 않는다
  {
    for (const what of [undefined, null, '', 'claude ', 'auth', { what: 'claude' }]) {
      reset()
      const res = await E.switchAccount(what)
      if (res.ok !== false || global.__calls.length) bad('알 수 없는 대상', `${JSON.stringify(what)} — ${JSON.stringify(res)}`)
    }
    ok('알 수 없는 대상은 명령을 돌리지 않는다')
  }

  // (12) 배선 — 화면이 부를 길이 실제로 뚫려 있는가
  {
    eq('main이 env:switch를 받는다', /ipcMain\.handle\('env:switch'/.test(src), 'true')
    eq('첫 연결 경로(env:login)를 없애지 않았다', /ipcMain\.handle\('env:login'/.test(src), 'true')
    eq('감시는 한 벌만 둔다', (src.match(/setTimeout\(r, waitMs\)/g) || []).length, 1)
    const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
    eq('preload가 switchAccount를 노출한다', /switchAccount:\s*\(what\)\s*=>\s*ipcRenderer\.invoke\('env:switch'/.test(pre), 'true')
    eq('preload의 login도 그대로다', /login:\s*\(what\)\s*=>\s*ipcRenderer\.invoke\('env:login'/.test(pre), 'true')
  }

  // (13) 실물 — 이 컴퓨터의 claude가 정말 이 모양으로 답하는가.
  //      **로그아웃은 절대 부르지 않는다.** 사용자 계정이다. 읽기만 한다.
  {
    let out = null
    try {
      out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', shell: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      out = e && typeof e.stdout === 'string' ? e.stdout : null
    }
    if (out === null) {
      console.log('  · (알림) 이 컴퓨터에 claude가 없다 — 실물 대조를 건너뛴다')
    } else {
      const p = E.parseAuthStatus(out)
      // **값은 찍지 않는다.** 이메일·조직명은 개인정보라 검사 출력에도 남기지 않는다.
      eq('실물 출력에서 loggedIn을 읽는다', typeof p.loggedIn, 'boolean')
      if (p.loggedIn) {
        eq('실물에서 이메일이 읽힌다', Boolean(p.email && p.email.includes('@')), 'true')
        eq('실물에서 조직명이 읽힌다', typeof p.orgName === 'string' && p.orgName.length > 0, 'true')
        eq('실물에서 요금제가 읽힌다', typeof p.subscriptionType === 'string' && p.subscriptionType.length > 0, 'true')
        eq('실물 결과에 orgId가 없다', /orgId/.test(JSON.stringify(p)), 'false')
        eq('원본에는 orgId가 있었다(읽고도 안 담은 것이다)', /"orgId"/.test(out), 'true')
      } else {
        console.log('  · (알림) 로그인돼 있지 않다 — 계정 필드 대조를 건너뛴다')
      }
    }
  }
}

// ── 16. 로그인·연결 창을 띄우는 명령줄 ──────────────────────────────────────
//
// 실제로 터진 자리다. 사용자가 `Figma 연결`을 눌렀더니 창 대신 Windows 오류가 떴다:
//
//   '-'을(를) 찾을 수 없습니다. 이름을 올바르게 입력했는지 확인하고 다시 시도하십시오.
//
// spawn(shell:false)이 인자를 libuv 규칙으로 **한 번 더** 인용해 준다. 그래서 제목을
// `"${title}"`로 감싸 두면 `"\"윤사무실 - Figma 연결\""`가 되는데, cmd는 `\"`를
// 이스케이프로 읽지 않고 따옴표 토글로만 읽는다. 제목이 첫 공백에서 잘리면서 그 뒤의
// `-`가 start의 "실행할 명령" 자리로 밀렸다.
//
// 그래서 여기서는 **완성된 명령줄 문자열 자체**를 본다. 인자 배열만 보면 이 고장이
// 보이지 않는다 — 어긋나는 곳이 배열을 문자열로 합치는 그 지점이기 때문이다.
function terminalChecks() {
  console.log('\n로그인·연결 창 명령줄')
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const i = src.indexOf('const CMD_UNSAFE =')
  if (i < 0) return bad('main.js에서 CMD_UNSAFE를 찾지 못했다')

  const T = loadFrom(
    'main.js',
    ['quoteForCmd', 'openInTerminal'],
    [
      'const calls = global.__spawnCalls = []',
      'const spawn = (file, args, opts) => { calls.push({ file, args, opts }); return { pid: 1234, on() {}, unref() {} } }',
      // 실물 findWindowPid는 PowerShell을 부른다. 여기서 보는 것은 명령줄이므로 세워만 둔다.
      'const findWindowPid = async (ppid, exe) => { calls.push({ find: [ppid, exe] }); return 4242 }',
      src.slice(i, src.indexOf('\n', i)),
      '',
    ].join('\n'),
  )
  const spawned = () => global.__spawnCalls
  const reset = () => (global.__spawnCalls.length = 0)
  // openInTerminal이 cmd.exe에 실제로 건네는 한 줄. 여기가 어긋나면 창이 안 뜬다.
  const lineOf = (args, title, exe) => {
    reset()
    const rv = T.openInTerminal(args, title, exe)
    const c = spawned().find((x) => x.args)
    return { rv, line: c ? c.args[1] : null, opts: c ? c.opts : null, count: spawned().filter((x) => x.args).length }
  }

  // 창으로 띄우는 figma 명령은 **인증(login)뿐이다.** 등록(`mcp add`)은 사람 손이 필요
  // 없어 조용히 돌리고, 애초에 `add`는 인증을 시작하지도 않는다(그래서 창을 띄워 봐야
  // 등록 문구 두 줄만 찍히고 프롬프트로 돌아갔다 — 이 고장의 본체다).
  const FIGMA = ['mcp', 'login', 'figma']

  // (1) 사용자가 실제로 눌렀던 그 버튼 — 제목에 `-`가 들어 있다(예전에 여기서 터졌다)
  {
    const r = lineOf(FIGMA, '윤사무실 - Figma 연결')
    eq('Figma 연결 창을 띄운다', Boolean(r.rv), 'true')
    // 창을 닫으려면 **누구인지**를 알아야 한다 — 핸들을 돌려주고 손자 pid를 찾아 둔다.
    eq('창 핸들을 돌려준다', typeof r.rv, 'object')
    eq('손자 pid를 찾으러 간다', spawned().some((x) => x.find), 'true')
    eq('Figma 명령줄이 그대로다', r.line, 'start "윤사무실 - Figma 연결" cmd /k claude mcp login figma')
    // 이 셋이 이 고장의 본체다.
    eq('제목을 두 겹으로 감싸지 않는다', /\\"/.test(r.line), 'false')
    eq('libuv가 다시 인용하지 못하게 한다', r.opts.windowsVerbatimArguments, 'true')
    eq('창이 남는다(cmd /k)', / cmd \/k /.test(r.line), 'true')
  }

  // (2) 나머지 호출부 — 한 함수를 넷이 같이 쓴다. 하나만 고쳐 놓고 끝내면 안 된다.
  {
    eq(
      'Claude 로그인',
      lineOf(['auth', 'login'], '윤사무실 - Claude 로그인').line,
      'start "윤사무실 - Claude 로그인" cmd /k claude auth login',
    )
    eq(
      'Figma 다시 연결(계정 전환)',
      lineOf(FIGMA, '윤사무실 - Figma 다시 연결').line,
      'start "윤사무실 - Figma 다시 연결" cmd /k claude mcp login figma',
    )
    // 등록 명령에는 `--transport` 같은 `-`로 시작하는 인자와 URL이 섞여 있다. 지금은
    // 창으로 띄우지 않지만, 누가 다시 창으로 돌려도 명령줄이 깨지지는 않아야 한다.
    eq(
      'Figma 등록 명령줄(창으로 띄우지는 않는다)',
      lineOf(['mcp', 'add', '-s', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp'], '윤사무실 - Figma 등록').line,
      'start "윤사무실 - Figma 등록" cmd /k claude mcp add -s user --transport http figma https://mcp.figma.com/mcp',
    )
    eq(
      'Claude 계정 전환',
      lineOf(['auth', 'login'], '윤사무실 - Claude 계정 전환').line,
      'start "윤사무실 - Claude 계정 전환" cmd /k claude auth login',
    )
    eq(
      'Claude Code 설치(exe가 npm)',
      lineOf(['i', '-g', '@anthropic-ai/claude-code'], '윤사무실 - Claude Code 설치', 'npm').line,
      'start "윤사무실 - Claude Code 설치" cmd /k npm i -g @anthropic-ai/claude-code',
    )
  }

  // (3) 제목은 **항상** 감싼다. start는 인용된 첫 토큰만 제목으로 보고,
  //     안 감싸면 그것을 실행할 명령으로 삼는다 — 공백 없는 제목에서 그대로 터진다.
  {
    const r = lineOf(['auth', 'login'], '설치')
    eq('공백 없는 제목도 감싼다', r.line, 'start "설치" cmd /k claude auth login')
  }

  // (4) 명령 주입. 지금은 전부 고정 문자열이지만, 나중에 사용자 입력이 섞여도
  //     cmd가 `&`·`|`를 만나 명령을 갈라 버리는 일은 없어야 한다.
  {
    for (const [label, args, title] of [
      ['인자에 &', ['auth', 'login & calc'], '윤사무실 - T'],
      ['인자에 |', ['auth', 'login | calc'], '윤사무실 - T'],
      ['인자에 따옴표', ['auth', 'lo"gin'], '윤사무실 - T'],
      ['제목에 &', ['auth', 'login'], '윤사무실 - T & calc'],
    ]) {
      const r = lineOf(args, title)
      eq(`${label} → 띄우지 않는다`, Boolean(r.rv), 'false')
      eq(`${label} → spawn을 부르지도 않는다`, r.count, '0')
    }
  }

  // (5) 실패를 삼키지 않는다 — falsy를 돌려줘야 호출부가 `manual` 문구를 띄운다.
  {
    const m = src.slice(src.indexOf('async function openAndWatch('), src.indexOf('\n}\n', src.indexOf('async function openAndWatch(')))
    eq('창을 못 띄우면 호출부가 manual을 준다', /const win = openInTerminal\([\s\S]*?if \(!win\)[\s\S]*?manual:/.test(m), 'true')
  }

  // (6) 창을 **어떻게 짚는가.** 여기가 이 고장의 위험한 쪽이다.
  //
  //     실측: 이 PC의 기본 콘솔이 Windows Terminal이라
  //     `tasklist /FI "WINDOWTITLE eq 윤사무실 - 제목시험"`이 우리 cmd가 아니라
  //     **사용자의 다른 탭까지 들고 있는 WindowsTerminal.exe(pid 39648, 우리 창보다
  //     17분 먼저 떠 있던 것)**를 가리켰다. 제목으로 죽였으면 사용자가 쓰던 터미널이
  //     통째로 날아갔다. 그래서 제목으로 찾는 길은 **다시 생기면 안 된다.**
  {
    // 주석에는 남겨 둔다(왜 안 되는지가 근거다). **코드에만** 없어야 한다.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    eq('창을 제목으로 찾지 않는다', /WINDOWTITLE/i.test(code), 'false')
    eq('왜 안 되는지는 주석에 남아 있다', /WINDOWTITLE/i.test(src), 'true')
    eq('창은 pid로만 닫는다', /taskkill'?,\s*\['\/PID'/.test(src), 'true')
    eq('pid가 없으면 아무것도 죽이지 않는다', /if \(!win \|\| typeof win !== 'object' \|\| !win\.pid\) return/.test(src), 'true')
    // 부모 pid만 맞으면 남의 창을 잡을 수 있다(pid는 재사용된다). 명령줄까지 본다.
    eq('부모 pid와 명령줄을 함께 맞춘다', /ParentProcessId=\$\{Number\(parentPid\)\}/.test(src) && /includes\(exe\)/.test(src), 'true')
  }
}

// ── 17. 설치 자동화 ─────────────────────────────────────────────────────────
//
// 비개발자 PC에 필요한 것을 대신 깔아 주는 길. 여기서 지켜야 할 것은 하나다:
// **깔리지 않았는데 "완료"라고 말하지 않는다.**
//
// 직전에 같은 계열로 한 번 데였다 — 연결이 안 됐는데 "Figma가 연결됐습니다"를 띄웠다.
// 설치는 더 나쁘다. 사무실이 조용해지는데 아무도 고장이라고 말해 주지 않고,
// 사용자는 앱이 "완료"라고 했으니 자기가 뭘 잘못했다고 생각한다.
//
// install.js는 electron을 안 부르므로 **원본 그대로 require해서** 돌린다.
// 떼어 낸 복사본이 아니라 진짜 코드가 답하는 것을 본다.
async function installChecks() {
  console.log('\n설치 자동화')
  const I = require(path.join(ROOT, 'install.js'))
  const installSrc = fs.readFileSync(path.join(ROOT, 'install.js'), 'utf8').replace(/\r\n/g, '\n')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const preSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const savedPath = process.env.PATH

  /** 검사용 가짜 실행 파일을 만든다. 셸이 찾아 주는 `.cmd`라 진짜처럼 불린다. */
  const fakeBin = (name, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-bin-'))
    fs.writeFileSync(path.join(dir, name + '.cmd'), '@echo off\r\n' + body + '\r\n', 'utf8')
    return dir
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /**
   * installOne이 **돌려준 뒤에도** 진행 소식이 계속 오는지 본다.
   *
   * 진행 타이머(setInterval)를 안 끄고 빠져나가는 길이 하나라도 있으면, 그 뒤로
   * 1초마다 `onProgress`가 앱이 꺼질 때까지 나간다 — 화면에는 "설치 실패" 상자와
   * "내려받는 중 · 7분 경과"가 나란히 뜬다. 실물에서 실제로 그랬다.
   */
  const ticksAfterReturn = async (spec, opts = {}) => {
    const seen = []
    const r = await I.installOne(spec, { ...opts, onProgress: (p) => seen.push(p) })
    const atReturn = seen.length
    await sleep(2200)
    return { r, before: atReturn, after: seen.length - atReturn }
  }

  try {
    // (1) 무인 설치 플래그. **하나라도 빠지면 winget이 동의를 물으며 멈춘다.**
    //     아무도 안 보는 창에서 멈추므로 5분 타임아웃까지 그냥 서 있게 된다.
    {
      const REQUIRED = [
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--disable-interactivity',
      ]
      for (const [key, pkg] of Object.entries(I.PACKAGES)) {
        if (pkg.method !== 'winget') continue
        const args = I.wingetArgs(pkg)
        for (const f of REQUIRED) eq(`${key}: 무인 플래그 ${f}`, args.includes(f), 'true')
        eq(`${key}: 사용자 범위로 깐다`, args.join(' ').includes('--scope user'), 'true')
        // id를 정확히 짚는다. --exact가 없으면 검색어가 여러 개를 물어 온다.
        eq(`${key}: id를 정확히 짚는다`, args.includes('--exact'), 'true')
      }
      eq('Git은 MinGit 포터블로 간다', I.PACKAGES.git.pkg, 'Git.MinGit')
      eq('Python 설치는 관리자 창을 예고한다(burn 번들)', I.PACKAGES.python.needsAdmin, 'true')
    }

    // (2) **Claude Code는 Node가 필요 없다.** 공식 설치 스크립트가 PowerShell만 쓴다
    //     (실측: claude.ai/install.ps1을 받아 읽었다). npm 경로로 되돌아가면
    //     비개발자가 넘어야 할 관문이 두 개 되살아난다.
    {
      eq('claude 설치에 npm이 없다', /npm/i.test(I.PACKAGES.claude.command), 'false')
      eq('claude 설치는 공식 스크립트를 쓴다', /claude\.ai\/install\.ps1/.test(I.PACKAGES.claude.command), 'true')
      eq('REQUIREMENTS에 Node가 없다', /key: 'node'/.test(mainSrc), 'false')
      eq('왜 뺐는지는 주석에 남아 있다', /Node\.js가 여기 없는 이유/.test(mainSrc), 'true')
    }

    // (3) ★ 핵심 회귀 시험 ★
    //     **설치 프로그램이 exit 0을 줘도, 실제로 돌려 보고 답이 없으면 실패다.**
    //     설치 프로그램 자리에 성공만 하는 스크립트를 두고, probe는 없는 명령으로 둔다.
    {
      const ghost = {
        key: 'ghost',
        probe: ['teamview-이런-명령은-없다-xyz', ['--version']],
        versionRe: /(\d+\.\d+\.\d+)/,
        auto: { method: 'script', publisher: '검사', scope: 'user', psCommand: 'exit 0' },
      }
      const r = await I.installOne(ghost)
      eq('설치가 0을 줘도 확인 못 하면 verified:false', r.verified, 'false')
      eq('그때 ok도 false다 (화면이 ok만 봐도 안전하다)', r.ok, 'false')
      eq('버전을 지어내지 않는다', r.version, 'null')
      eq('왜 실패했는지 남긴다', Boolean(r.error), 'true')
      // 설치 프로그램은 잘 끝났으니 껐다 켜면 보일 수도 있다 — 그 힌트는 줘야 한다.
      eq('껐다 켜 보라는 힌트를 준다', r.needsRestart, 'true')

      // 위 시험이 의미가 있으려면 **반대쪽도 확인돼야 한다.** 늘 false를 주는
      // 검사는 시험이 아니다. 같은 길로 진짜 있는 것을 넣으면 통과해야 한다.
      const real = {
        key: 'real',
        probe: ['cmd', ['/c', 'echo', '9.9.9']],
        versionRe: /(\d+\.\d+\.\d+)/,
        auto: { method: 'script', publisher: '검사', scope: 'user', psCommand: 'exit 0' },
      }
      const r2 = await I.installOne(real)
      eq('확인되면 verified:true', r2.verified, 'true')
      eq('그때 버전이 실린다', r2.version, '9.9.9')
    }

    // (4) 진행 단계는 **본 것만** 말한다. 그리고 화면이 초를 셀 수 있어야 한다.
    {
      const seen = []
      await I.installOne(
        {
          key: 'tick',
          probe: ['cmd', ['/c', 'echo', '1.0.0']],
          versionRe: /(\d+\.\d+\.\d+)/,
          auto: { method: 'script', publisher: '검사', scope: 'user', psCommand: 'Start-Sleep -Milliseconds 1200' },
        },
        { onProgress: (p) => seen.push(p) },
      )
      eq('진행 상황을 밀어 준다', seen.length > 1, 'true')
      eq('항목 이름이 실린다', seen[0].key, 'tick')
      eq('경과 시간이 실린다', typeof seen[0].elapsedMs, 'number')
      eq('처음은 download다', seen[0].phase, 'download')
      eq('마지막은 verify다', seen[seen.length - 1].phase, 'verify')
      // 설치 단계 표시를 본 적이 없으면 install이라고 하지 않는다(지어내지 않는다).
      eq('보지 못한 단계를 말하지 않는다', seen.some((p) => p.phase === 'install'), 'false')
    }

    // (4-b) ★ 가짜 활동 ★ **어느 길로 끝나도 진행 타이머가 꺼지는가.**
    //
    //   실물 사고: winget이 없어 곧장 돌아가는 길만 clearInterval을 건너뛰었다.
    //   그 하나 때문에 화면에 "설치 실패"와 "내려받는 중 · 7분 경과"가 같이 떴다.
    //   winget이 정책으로 막힌 회사 PC가 정확히 그 길을 밟는다.
    //   여기서는 **끝나는 길마다** 돌려준 뒤 2초 동안 소식이 더 오는지 센다.
    {
      const psOk = { method: 'script', publisher: '검사', scope: 'user', psCommand: 'exit 0' }
      const cases = [
        // 확인까지 성공하는 길
        ['성공', { key: 'ok', probe: ['cmd', ['/c', 'echo', '1.2.3']], versionRe: /(\d+\.\d+\.\d+)/, auto: psOk }, {}],
        // 설치는 끝났는데 확인이 안 되는 길
        ['확인 실패', { key: 'ng', probe: ['teamview-이런-명령은-없다-xyz', ['--version']], versionRe: /(\d+\.\d+\.\d+)/, auto: psOk }, {}],
        // 자동 설치를 아예 못 하는 길(auto가 없다)
        ['자동 설치 불가', { key: 'noauto', probe: ['cmd', ['/c', 'echo', '1.2.3']], versionRe: /(\d+\.\d+\.\d+)/ }, {}],
        // 던지는 길 — 패키지 id가 규칙에 안 맞으면 wingetArgs가 던진다
        ['던지는 길', { key: 'boom', probe: ['cmd', ['/c', 'echo', '1.2.3']], versionRe: /(\d+\.\d+\.\d+)/, auto: { method: 'winget', pkg: '나쁜 id!', publisher: '검사', scope: 'user' } }, {}],
        // 시간이 초과되는 길
        ['시간 초과', { key: 'slow', probe: ['teamview-이런-명령은-없다-xyz', ['--version']], versionRe: /(\d+\.\d+\.\d+)/, auto: { ...psOk, psCommand: 'Start-Sleep -Seconds 60' } }, { timeoutMs: 1500 }],
      ]
      for (const [label, spec, opts] of cases) {
        const t = await ticksAfterReturn(spec, opts)
        t.after === 0
          ? ok(`돌려준 뒤에는 진행 소식이 멈춘다: ${label}`)
          : bad('가짜 활동', `${label} — 돌려준 뒤에도 ${t.after}번 더 왔다(타이머가 안 꺼진다)`)
      }

      // **winget이 없는 PC가 바로 그 길이다.** 실제로 없는 상태를 만들어 다시 본다.
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-nowinget-'))
      process.env.PATH = empty
      const t = await ticksAfterReturn({
        key: 'git',
        probe: ['git', ['--version']],
        versionRe: /git version\s+(\S+)/,
        auto: I.PACKAGES.git,
      })
      process.env.PATH = savedPath
      if (/winget이 없어/.test(t.r.error || '')) {
        t.after === 0
          ? ok('winget이 없어 돌아가는 길에서도 타이머가 꺼진다')
          : bad('가짜 활동', `winget 없음 — 돌려준 뒤에도 ${t.after}번 더 왔다`)
      } else {
        console.log('  · (알림) PATH를 비웠는데도 winget이 잡혔다 — 이 길은 건너뛴다')
      }
    }

    // (5) 타임아웃이 실제로 걸리는가. 5분을 기다리는 검사는 아무도 안 돌리므로
    //     같은 기계를 짧은 시간으로 돌려 본다(기본값이 5분인 것은 따로 확인한다).
    {
      eq('기본 타임아웃은 5분이다', I.INSTALL_TIMEOUT_MS, String(5 * 60 * 1000))
      const began = Date.now()
      const r = await I.installOne(
        {
          key: 'slow',
          probe: ['teamview-이런-명령은-없다-xyz', ['--version']],
          versionRe: /(\d+\.\d+\.\d+)/,
          auto: { method: 'script', publisher: '검사', scope: 'user', psCommand: 'Start-Sleep -Seconds 60' },
        },
        { timeoutMs: 2000 },
      )
      const took = Date.now() - began
      eq('시간이 지나면 끊는다', took < 30_000, 'true')
      eq('끊겼으면 성공이라고 하지 않는다', r.verified, 'false')
      eq('시간 초과라고 말해 준다', /끝나지 않았습니다/.test(r.error || ''), 'true')
      // 끊긴 것은 "설치 프로그램이 잘 끝났다"가 아니다 — 껐다 켜라고 하면 안 된다.
      eq('시간 초과에는 재시작을 권하지 않는다', Boolean(r.needsRestart), 'false')

      // UAC 창이 뜨는 설치(Python은 burn 번들이다)는 사람이 창을 누를 때까지 붙잡힌다.
      // 그 시간을 5분에 욱여넣으면 멀쩡한 설치를 우리가 끊는다 — 이제 트리째 죽이므로
      // 잘못 끊는 비용이 크다.
      eq('UAC를 예고하는 설치는 10분을 준다', I.ADMIN_INSTALL_TIMEOUT_MS, String(10 * 60 * 1000))
      eq('그 판단은 needsAdmin으로 한다', /auto\.needsAdmin[\s\S]{0,60}ADMIN_INSTALL_TIMEOUT_MS/.test(installSrc), 'true')
      eq('python이 그 대상이다', I.PACKAGES.python.needsAdmin, 'true')
    }

    // (5-b) ★ 시간이 초과되면 **손자까지** 죽는가 ★
    //
    //   `child.kill()`은 윈도우에서 직계 자식만 죽인다. winget이 띄운 msiexec이나
    //   burn 번들은 그대로 살아 설치를 계속하고, 사용자가 [다시 시도]를 누르면
    //   설치 프로그램 두 개가 겹친다. 그래서 진짜로 손자를 하나 낳아 놓고,
    //   시간이 초과된 뒤 그 손자가 죽었는지 **pid로** 확인한다.
    {
      const sys = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name)
      const alive = (pid) => {
        try {
          const out = execFileSync(sys('tasklist.exe'), ['/FI', 'PID eq ' + pid, '/NH'], {
            encoding: 'latin1',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          return new RegExp('\\b' + pid + '\\b').test(out)
        } catch {
          return false
        }
      }
      const pidFile = path.join(os.tmpdir(), 'tv-tree-' + process.pid + '-' + Date.now() + '.txt')
      const psCommand =
        "$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -PassThru -WindowStyle Hidden; " +
        `Set-Content -LiteralPath '${pidFile}' -Value $p.Id; ` +
        'Start-Sleep -Seconds 120'
      const r = await I.installOne(
        {
          key: 'tree',
          probe: ['teamview-이런-명령은-없다-xyz', ['--version']],
          versionRe: /(\d+\.\d+\.\d+)/,
          auto: { method: 'script', publisher: '검사', scope: 'user', psCommand },
        },
        { timeoutMs: 4000 },
      )
      eq('(전제) 시간이 초과된 것이 맞다', /끝나지 않았습니다/.test(r.error || ''), 'true')
      let pid = null
      try {
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      } catch {
        pid = null
      }
      if (!pid) {
        console.log('  · (알림) 손자 프로세스를 못 만들었다 — 트리 종료 대조를 건너뛴다')
      } else {
        let dead = false
        for (let i = 0; i < 16 && !dead; i++) {
          if (!alive(pid)) dead = true
          else await sleep(500)
        }
        dead
          ? ok('시간이 초과되면 손자 프로세스까지 죽는다')
          : bad('트리 종료', `손자(pid ${pid})가 살아남았다 — [다시 시도]에서 설치가 겹친다`)
        // 살아남았으면 우리가 치운다. 검사가 남의 프로세스를 남기면 안 된다.
        if (!dead) {
          try {
            execFileSync(sys('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
          } catch {
            /* 이미 죽었으면 그만이다 */
          }
        }
      }
      try {
        fs.rmSync(pidFile, { force: true })
      } catch {
        /* 임시 파일 하나 못 지운 것으로 검사를 실패시키지 않는다 */
      }
      // **제목으로 찾지 않는다.** 예전에 그 방식이 사용자의 WindowsTerminal을 잡았다.
      eq('설치도 pid로만 죽인다', /'\/PID', String\(pid\), '\/T', '\/F'/.test(installSrc), 'true')
      eq('창 제목으로 찾는 코드가 없다', /WINDOWTITLE/i.test(installSrc), 'false')
    }

    // (6) winget이 없는 PC. **고장이 아니라 정상 경로다**(회사 PC는 그룹 정책으로 막는다).
    //     비어 있는 폴더만 PATH에 두면 winget을 못 찾는 상태가 그대로 재현된다.
    {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-nopath-'))
      process.env.PATH = empty
      const det = await I.detectWinget()
      eq('winget이 없으면 false로 답한다', det.winget, 'false')
      eq('없는 버전을 지어내지 않는다', det.version, 'null')

      const r = await I.installOne({
        key: 'git',
        probe: ['git', ['--version']],
        versionRe: /git version\s+(\S+)/,
        auto: I.PACKAGES.git,
      })
      eq('winget이 없으면 설치를 시도하지 않는다', /winget이 없어/.test(r.error || ''), 'true')
      eq('그래도 성공이라고 하지 않는다', r.verified, 'false')
      process.env.PATH = savedPath
    }

    // (7) PATH 다시 읽기. **깔고도 "없다"고 나오는 자리**를 막는 장치다.
    //     앱이 물려받은 PATH는 설치가 끝나도 그대로라, 레지스트리에서 다시 읽어야 한다.
    {
      const only = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-onlydir-'))
      process.env.PATH = only // 물려받은 PATH가 빈약한 상태를 흉내 낸다
      const r = await I.refreshPath()
      eq('PATH를 다시 읽는다', r.ok, 'true')
      eq('바뀌었으면 바뀌었다고 한다', r.changed, 'true')
      // 레지스트리에 있던 경로가 실제로 들어와야 한다(없던 경로가 생기는 것이 요점이다).
      eq('레지스트리의 경로가 들어온다', /system32/i.test(process.env.PATH), 'true')
      // 그러면서 원래 있던 것을 잃지 않는다 — 갱신이 고치려던 문제를 다시 만들면 안 된다.
      eq('원래 있던 경로를 잃지 않는다', process.env.PATH.includes(only), 'true')
      // 한 번 고른 뒤에는 더 바뀔 것이 없어야 한다(계속 "바뀌었다"고 하면
      // 화면이 매번 다시 그리거나 "다시 켜세요"를 반복하게 된다).
      process.env.PATH = savedPath
      await I.refreshPath()
      const again = await I.refreshPath()
      eq('바뀐 게 없으면 바뀌었다고 하지 않는다', again.changed, 'false')

      // **문자열로 견주면 여기서 걸린다.** 우리가 머신·유저 순으로 다시 세우므로
      // 같은 항목이라도 순서·꼬리 슬래시·빈 칸이 달라지고, `before !== next`는 거의
      // 매번 참이 된다 — 아무것도 안 생겼는데 화면이 "다시 켜세요"를 되풀이한다.
      const same = I.splitPath(process.env.PATH)
      process.env.PATH = same
        .slice()
        .reverse()
        .map((p) => p + '\\')
        .join(';;')
      const shuffled = await I.refreshPath()
      eq('순서·꼬리 슬래시만 달라도 바뀐 것이 아니다', shuffled.changed, 'false')
      // 반대쪽 — **레지스트리에는 있는데 프로세스에는 없던** 항목이 돌아오면 그때는
      // 정말 바뀐 것이다(늘 false를 주는 검사는 시험이 아니다). 깔고도 "없습니다"가
      // 뜨는 자리가 정확히 이 모양이다.
      const reg = await I.readRegistryPath()
      const one = I.splitPath(reg.machine)[0] ?? I.splitPath(reg.user)[0]
      if (!one) {
        console.log('  · (알림) 레지스트리 PATH가 비어 있다 — 반대쪽 대조를 건너뛴다')
      } else {
        process.env.PATH = I.splitPath(savedPath)
          .filter((p) => I.pathKey(p) !== I.pathKey(one))
          .join(';')
        eq('빠져 있던 항목이 돌아오면 바뀌었다고 한다', (await I.refreshPath()).changed, 'true')
      }
      process.env.PATH = savedPath
    }

    // (7-b) PATH 다시 읽기를 **부르는 쪽이 끌 수 있는가.**
    //       verifyInstalled가 항목마다 레지스트리를 읽으면 앱을 켤 때마다 PowerShell이
    //       항목 수 + 1번 뜬다(실측 4번). 여러 항목을 잇달아 보는 쪽은 앞에서 한 번만
    //       읽는다 — main.js의 주석이 그렇게 말하고 있으니 코드도 그래야 한다.
    {
      const echoSpec = { key: 'echo', probe: ['echo', ['1.0.0']], versionRe: /(\d+\.\d+\.\d+)/ }
      const only = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-norefresh-'))
      process.env.PATH = only
      await I.verifyInstalled(echoSpec, { refreshPath: false })
      eq('refreshPath:false면 PATH를 건드리지 않는다', process.env.PATH, only)
      // 반대쪽 — 기본값은 켜져 있어야 한다(설치 직후에는 정말 다시 읽어야 한다).
      await I.verifyInstalled(echoSpec)
      eq('기본값은 다시 읽는 것이다', /system32/i.test(process.env.PATH), 'true')
      process.env.PATH = savedPath
      eq(
        'checkRequirements는 항목마다 다시 읽지 않는다',
        /verifyInstalled\(r, \{[^}]*refreshPath: false/.test(mainSrc),
        'true',
      )
      eq('그 이유가 주석에 남아 있다', /한 번만.*다시 읽는다/.test(mainSrc), 'true')
    }

    // (7-c) 사용자 PATH에 덧붙이기 — 읽기와 쓰기가 **한 PowerShell 안에서** 끝나는가.
    //       둘로 나뉘어 있으면 그 사이(프로세스 두 번)에 winget이 HKCU Path를 바꿔도
    //       우리가 낡은 값으로 덮어써서 그 변경이 사라진다. 하필 이 함수가 불리는
    //       자리가 winget 포터블 설치 **직후**다.
    {
      const at = installSrc.indexOf('async function persistUserPath(')
      const body = installSrc.slice(at, installSrc.indexOf('\n}\n', at))
      eq('PowerShell을 한 번만 부른다', (body.match(/runPowerShell\(/g) || []).length, '1')
      eq('읽기와 쓰기가 같은 스크립트에 있다', /GetValue\('Path'/.test(body) && /SetValue\('Path'/.test(body), 'true')
      // 잘 돼 있던 것들은 그대로 지킨다.
      eq('원본 그대로 읽는다(%VAR%를 굳히지 않는다)', /DoNotExpandEnvironmentNames/.test(body), 'true')
      eq('ExpandString으로 쓴다', /RegistryValueKind\]::ExpandString/.test(body), 'true')
      eq('값은 base64로 건넨다(인용 사고 방지)', /FromBase64String/.test(body), 'true')
      eq('8000자 상한이 살아 있다', /8000/.test(body), 'true')
      eq('지우는 코드가 없다(덧붙이기만 한다)', /DeleteValue|Remove-ItemProperty/.test(body), 'false')

      // 실물 — **이미 있는 항목**을 주면 아무것도 쓰지 않고 already로 답해야 한다.
      // (읽기 경로를 실제 레지스트리로 한 번 밟아 본다. 쓰기는 하지 않는다.)
      const reg = await I.readRegistryPath()
      const first = I.splitPath(reg.user)[0]
      if (!first) {
        console.log('  · (알림) 이 계정의 사용자 PATH가 비어 있다 — 실물 대조를 건너뛴다')
      } else {
        const res = await I.persistUserPath(first)
        eq('이미 있는 폴더는 다시 넣지 않는다', `${res.ok}:${res.already}`, 'true:true')
        eq('그때는 added를 말하지 않는다', res.added, 'undefined')
      }
    }

    // (8) ★ 스토어 스텁을 걸러내는가 ★
    //     새 PC에서 `python`이 마이크로소프트 스토어 스텁으로 잡히면, 훅은 매번 헛돌고
    //     화면은 텅 빈 채로 아무도 이유를 모른다(훅은 규칙상 무조건 exit 0이다).
    {
      const pySpec = { key: 'python', probe: ['python', ['--version']], versionRe: /Python\s+(\d+\.\d+\.\d+)/ }

      // 8-a. 진짜 스텁: 안내만 찍고 9009로 끝난다.
      const stub = fakeBin('python', 'echo Python was not found; run without arguments to install from the Microsoft Store.\r\nexit /b 9009')
      process.env.PATH = stub + ';' + savedPath
      const a = await I.probeVersion(pySpec)
      eq('스토어 스텁을 설치된 것으로 보지 않는다', a.ok, 'false')
      eq('스텁에서 버전을 지어내지 않는다', a.version, 'null')

      // 8-b. 더 고약한 쪽: **exit 0인데 아무 말이 없다.** 종료 코드만 보면 통과한다.
      const quiet = fakeBin('python', 'exit /b 0')
      process.env.PATH = quiet + ';' + savedPath
      const b = await I.probeVersion(pySpec)
      eq('조용히 0으로 끝나도 통과시키지 않는다', b.ok, 'false')

      // 8-c. 심층 검증: 버전은 그럴듯하게 찍는데 **훅을 못 돌리는** python.
      //      여기가 이 검사의 핵심이다 — 훅은 무슨 일이 있어도 exit 0이라
      //      종료 코드로는 영원히 구별되지 않는다. 기록이 남았는지로만 가른다.
      const liar = fakeBin('python', 'echo Python 3.13.0\r\nexit /b 0')
      process.env.PATH = liar + ';' + savedPath
      const c = await I.probeVersion(pySpec)
      eq('(대조) 버전만 보면 통과해 버린다', c.ok, 'true')
      const deep = await I.verifyHookRuns(pySpec, { hookPath: path.join(ROOT, 'hooks', 'team_events.py') })
      eq('훅이 기록을 못 남기면 통과시키지 않는다', deep.ok, 'false')
      eq('무엇이 안 됐는지 말해 준다', Boolean(deep.why), 'true')
      process.env.PATH = savedPath

      // 8-d. 반대쪽 — 이 PC의 진짜 python은 통과해야 한다. 안 그러면 이 검사는
      //      "무조건 실패"일 뿐이고, 멀쩡한 python을 없다고 몰아붙이게 된다.
      //      (실측 주의: 이 PC의 `where python` 첫 줄은 WindowsApps 아래인데
      //       스텁이 아니라 정상 스토어판이다. 경로로 걸렀으면 여기서 틀렸다.)
      const here = await I.probeVersion(pySpec)
      if (here.ok) {
        const good = await I.verifyHookRuns(pySpec, { hookPath: path.join(ROOT, 'hooks', 'team_events.py') })
        eq('진짜 python은 훅을 돌려 통과한다', good.ok, 'true')
      } else {
        console.log('  · (알림) 이 컴퓨터에 python이 없다 — 반대쪽 대조를 건너뛴다')
      }

      // 8-e. ★ 설치본(asar)에서도 훅을 돌릴 수 있는가 ★
      //
      //   설치본에서 훅은 `resources\app.asar\hooks\team_events.py`에 있다. asar는
      //   Electron이 fs를 패치해 줘야만 보이는 가짜 폴더라 `fs.existsSync`는 true를
      //   주지만, **spawn된 python은 그 경로를 못 연다.** 실측:
      //     python: can't open file '...\app.asar\hooks\team_events.py': [Errno 2]
      //   그래서 설치본에서는 python이 영원히 installed:false였고, 사용자는 Python을
      //   깔고 또 깔아도 "훅이 아무것도 기록하지 못했습니다"를 보며 마법사에 갇혔다.
      //
      //   여기서는 **경로를 python에 넘기지 않는다**는 것을 코드로 못 박고(원본을 읽어
      //   사본을 돌린다), 파일을 못 여는 폴더에서도 통과하는지 실제로 돌려 본다.
      //   (asar 그 자체는 electron이 있어야 흉내 낼 수 있다 — 실물 확인은 따로 한다.)
      {
        const v = installSrc.slice(
          installSrc.indexOf('async function verifyHookRuns('),
          installSrc.indexOf('\n}\n', installSrc.indexOf('async function verifyHookRuns(')),
        )
        eq('훅 원본을 읽어서 확인한다(existsSync로 때우지 않는다)', /readFileSync\(hookPath\)/.test(v), 'true')
        eq('훅 경로를 python 인자로 넘기지 않는다', /\[hookPath/.test(v), 'false')
        eq('훅 폴더를 cwd로 삼지 않는다', /dirname\(hookPath\)/.test(v), 'false')
        eq('사본을 검사용 폴더에 쓴다', /writeFileSync\(path\.join\(lab, hookName\)/.test(v), 'true')

        // 실물에 가까운 재현: 원본이 **파일 시스템에 없는** 자리를 가리켜도,
        // 내용만 읽을 수 있으면 검증이 통과해야 한다. fs를 잠깐 갈아 끼워
        // "읽히지만 열리지는 않는" asar를 흉내 낸다.
        if (here.ok) {
          const real = fs.readFileSync(path.join(ROOT, 'hooks', 'team_events.py'))
          const ghostPath = path.join(ROOT, 'app.asar', 'hooks', 'team_events.py') // 디스크에 없다
          const origRead = fs.readFileSync
          fs.readFileSync = (p, ...rest) => (p === ghostPath ? real : origRead(p, ...rest))
          let deep
          try {
            deep = await I.verifyHookRuns(pySpec, { hookPath: ghostPath })
          } finally {
            fs.readFileSync = origRead
          }
          eq('디스크에 없는 경로(asar)여도 훅이 돌아간다', deep.ok, 'true')
          eq('(대조) 그 경로는 실제로 디스크에 없다', fs.existsSync(ghostPath), 'false')
        }
      }
    }

    // (9) 로그인 감시 간격 — 처음에는 촘촘하게. main.js 원본을 그대로 계산해 본다.
    {
      const from = mainSrc.indexOf('const WATCH_EVERY_MS')
      const to = mainSrc.indexOf('})()', from)
      if (from < 0 || to < 0) {
        bad('감시 간격 상수를 찾지 못했다')
      } else {
        const block = mainSrc.slice(from, to + 4)
        const delays = new Function(block + '\nreturn WATCH_DELAYS_MS')()
        eq('첫 확인은 3초 뒤다', delays[0], '3000')
        eq('백오프로 늘어난다', delays.slice(0, 5).join(','), '3000,5000,8000,13000,21000')
        eq('그 뒤로는 30초로 고정된다', delays.slice(5).every((d) => d === 30_000), 'true')
        eq('3분은 지켜본다', delays.reduce((a, b) => a + b, 0) >= 180_000, 'true')
        // 요점은 이것이다 — 15초 만에 끝낸 사람이 30초를 기다리지 않는다.
        eq('첫 확인이 30초보다 빠르다', delays[0] < 30_000, 'true')
      }
    }

    // (10) 마법사 조건. **하위 호환이 걸린 자리다.**
    //      `firstRunDone`은 새로 생긴 키라, 이미 잘 쓰던 사람에게는 아예 없다.
    //      그것만 보고 띄우면 업데이트한 순간 사용자 전원이 마법사에 갇힌다.
    //      **화면의 함수를 그대로 떼어 와서 시험한다.** 예전에는 main.js의
    //      `firstRunState()`를 시험했는데, 그 함수는 아무도 부르지 않는 죽은 코드였다 —
    //      여섯 개가 전부 초록인 채로 실제 게이트는 한 번도 검사되지 않았다.
    {
      const W = loadFrom('renderer/wizard.js', ['localDone', 'alreadyDone', 'shouldOpen', 'missingItems'], [
        'let __local = false',
        'let backendDone = null',
        'let projectCount = null',
        'let reqs = []',
        'const localStorage = { getItem: () => (__local ? "1" : null) }',
        'global.__set = (done, rs, projects) => { __local = false; backendDone = done; reqs = rs; projectCount = projects }',
        '',
      ].join('\n'))
      const ALL_OK = [
        { key: 'python', optional: false, installed: true },
        { key: 'claude', optional: false, installed: true },
        { key: 'git', optional: true, installed: true },
      ]
      const NO_PY = ALL_OK.map((r) => (r.key === 'python' ? { ...r, installed: false } : r))
      const NO_GIT = ALL_OK.map((r) => (r.key === 'git' ? { ...r, installed: false } : r))

      global.__set(null, ALL_OK, 1)
      eq('다 갖췄으면 표시가 없어도 마법사를 띄우지 않는다', W.shouldOpen(), 'false')

      global.__set(null, NO_PY, 1)
      eq('필수가 빠졌으면 띄운다', W.shouldOpen(), 'true')

      global.__set(null, NO_GIT, 1)
      eq('git만 없는 것은 막지 않는다(선택 항목)', W.shouldOpen(), 'false')

      global.__set(null, ALL_OK, 0)
      eq('붙은 프로젝트가 없으면 띄운다', W.shouldOpen(), 'true')

      global.__set(true, NO_PY, 0)
      eq('끝냈다고 한 사람은 다시 가두지 않는다', W.shouldOpen(), 'false')

      global.__set(null, NO_PY, 1)
      eq('무엇이 빠졌는지 알려 준다', W.missingItems().map((r) => r.key).join(','), 'python')
    }

    // (11) 계약 동결. 화면(마법사)이 이것만 믿고 따로 만들어지고 있다 —
    //      이름이 하나만 어긋나도 양쪽이 조용히 못 만난다.
    {
      for (const ch of [
        'env:can-auto-install',
        'env:install-auto',
        'env:path-refresh',
        'app:relaunch',
        'project:create',
        'wizard:done',
      ]) {
        eq(`main이 ${ch}를 받는다`, mainSrc.includes(`ipcMain.handle('${ch}'`), 'true')
      }
      eq('설치 진행 상황을 밀어 준다', /send\('env:install-progress'/.test(mainSrc), 'true')
      for (const api of [
        'canAutoInstall',
        'autoInstall',
        'onInstallProgress',
        'refreshPath',
        'relaunch',
        'createProject',
        'wizardDone',
      ]) {
        eq(`preload가 ${api}를 노출한다`, new RegExp('\\b' + api + ':\\s').test(preSrc), 'true')
      }
      // 예전 화면이 쓰던 것도 그대로 있어야 한다(업데이트로 버튼이 사라지면 안 된다).
      eq('예전 env:install 경로가 살아 있다', /ipcMain\.handle\('env:install'/.test(mainSrc), 'true')
      eq('예전 install()도 그대로다', /\binstall:\s*\(key\)/.test(preSrc), 'true')

      // 다시 켜기는 **정상 종료**여야 한다. `app.exit(0)`은 before-quit/will-quit을
      // 건너뛴다 — 돌고 있는 claude 세션과 띄워 둔 개발 서버 정리가 통째로 빠져,
      // 다시 켠 앱이 남의 포트와 남의 클레임(10분 TTL)을 마주한다.
      const relaunch = mainSrc.slice(
        mainSrc.indexOf("ipcMain.handle('app:relaunch'"),
        mainSrc.indexOf('})', mainSrc.indexOf("ipcMain.handle('app:relaunch'")),
      )
      eq('다시 켜기는 app.quit()으로 끝낸다', /app\.quit\(\)/.test(relaunch), 'true')
      eq('app.exit로 건너뛰지 않는다', /app\.exit\(/.test(relaunch), 'false')
      eq('정리할 것이 실제로 걸려 있다', (mainSrc.match(/app\.on\('before-quit'/g) || []).length > 0, 'true')
    }

    // (12) 프로젝트 만들기 — 이름은 사람이 자유롭게 치는 값이다. 그대로 경로에
    //      붙이면 엉뚱한 곳에 폴더가 생긴다(`..\..\Windows` 같은 것).
    {
      const block = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('project:create'"))
      // 폴더 이름으로 못 쓰는 글자와 경로 구분자를 막고 있는가.
      eq('쓸 수 없는 글자를 막는다', block.includes('x00-\\x1f') && block.includes('?*'), 'true')
      eq('상위 폴더로 못 올라간다', block.includes("clean === '..'"), 'true')
      eq('git이 없으면 건너뛴다(실패가 아니다)', /probeVersion\(gitReq\)/.test(block), 'true')
      eq('기본 자리는 문서 폴더다', /getPath\('documents'\)/.test(block), 'true')

      // (12-b) 구성이 실패하면 **빈 폴더를 남기지 않는다.** 남기면 재시도가
      //        "같은 이름의 폴더가 이미 있습니다"에 막혀 그 이름을 영영 못 쓴다.
      //        되돌리는 것은 **우리가 방금 만든 것일 때만**이다 — 사람이 미리 만들어 둔
      //        빈 폴더를 우리가 지우면 그게 더 나쁘다.
      const create = block.slice(0, block.indexOf("ipcMain.handle('wizard:done'"))
      eq('우리가 만든 것인지 기억해 둔다', /created = !existed/.test(create), 'true')
      eq('실패하면 되돌린다', /if \(created\)[\s\S]{0,200}rmSync\(dir/.test(create), 'true')
      // 지우는 자리는 그 가드 안 하나뿐이어야 한다(다른 데서 또 지우면 가드가 무의미하다).
      eq('폴더를 지우는 자리는 하나뿐이다', (create.match(/rmSync\(dir/g) || []).length, '1')
      eq('못 지웠으면 어디를 치우면 되는지 알려 준다', /폴더가 남아 있습니다: \$\{dir\}/.test(create), 'true')
      eq('되돌렸는지도 응답에 담는다', /rolledBack/.test(create), 'true')
    }
  } finally {
    process.env.PATH = savedPath
  }
}

/**
 * 객체 리터럴의 **최상위 키**만 뽑는다(중첩 객체·문자열·주석 안은 세지 않는다).
 * `braceIdx`는 여는 `{`의 자리. `key: 값`도 `key,`(단축 표기)도 키로 센다.
 */
function keysOfObject(src, braceIdx) {
  const keys = []
  let depth = 0
  let prev = ''
  let i = braceIdx
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl < 0) break
      i = nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      i++
      prev = c
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++
      prev = c
      i++
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) break
      prev = c
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (depth === 1 && (prev === '{' || prev === ',') && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*[:,}]/.exec(src.slice(i))
      if (m) {
        keys.push(m[1])
        i += m[1].length
        continue
      }
    }
    prev = c
    i++
  }
  return keys
}

// ── 18-b. 스텁의 **IPC 응답**이 실제 핸들러와 같은가 ────────────────────────
//
// 같은 병의 다른 자리다. 화면(마법사)은 이제 게시자·패키지 id·설치 범위를 하드코딩
// 사전 없이 `canAutoInstall().packages`에서만 가져온다 — 화면이 값을 지어내지 못하게
// 하려는 것이다. 그런데 스텁이 그 필드를 아예 안 주면, 화면 검사는 "대조할 것이 없어서"
// 조용히 통과한다(실제로 결함을 심었을 때 못 잡았다).
//
// 그래서 여기서는 **스텁을 진짜로 불러 응답을 받아** main.js가 만들어 내는 응답과
// 통째로 맞대 본다. 값 하나가 달라도 실패한다 — 그 값이 곧 사용자가 설치 전에 보는
// "누가 만든 무엇을 어디서 받아 오는가"이기 때문이다.
async function ipcContractChecks() {
  console.log('\nIPC 응답 계약 (프로덕션 ↔ 검사 스텁)')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const installer = require(path.join(ROOT, 'install.js'))

  /** 검사 스텁을 진짜로 불러 온다 — electron 자리에만 가짜를 끼운다. */
  const loadStub = (scenario) => {
    const Module = require('module')
    const stubPath = require.resolve(path.join(ROOT, 'tools', 'ui-stub.js'))
    const origLoad = Module._load
    const savedScenario = process.env.SCENARIO
    let api = null
    process.env.SCENARIO = scenario
    Module._load = function (request, ...rest) {
      if (request === 'electron') {
        return { contextBridge: { exposeInMainWorld: (_name, exposed) => (api = exposed) } }
      }
      return origLoad.call(this, request, ...rest)
    }
    try {
      delete require.cache[stubPath]
      require(stubPath)
    } finally {
      Module._load = origLoad
      delete require.cache[stubPath]
      if (savedScenario === undefined) delete process.env.SCENARIO
      else process.env.SCENARIO = savedScenario
    }
    return api
  }

  // main.js의 REQUIREMENTS와 핸들러의 매핑을 **원본 그대로** 돌린다.
  // (여기서 다시 적으면 검사가 거짓말을 한다.)
  const rAt = mainSrc.indexOf('const REQUIREMENTS = [')
  const REQUIREMENTS = new Function(
    'installer',
    mainSrc.slice(rAt, mainSrc.indexOf('\n]\n', rAt) + 3) + '\nreturn REQUIREMENTS',
  )(installer)
  const hAt = mainSrc.indexOf("ipcMain.handle('env:can-auto-install'")
  const handler = mainSrc.slice(hAt, mainSrc.indexOf('\n})\n', hAt))
  const from = handler.indexOf('REQUIREMENTS.filter(')
  const mapExpr = handler.slice(from, handler.indexOf('\n  }', from)).trim().replace(/,$/, '')
  const prodPackages = (found) =>
    new Function('REQUIREMENTS', 'installer', 'found', 'return ' + mapExpr)(REQUIREMENTS, installer, found)

  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
  const diff = (got, want) => {
    if (got.length !== want.length) return `항목 수가 다르다 (스텁 ${got.length} / 앱 ${want.length})`
    for (let i = 0; i < want.length; i++) {
      const g = sortKeys(got[i] ?? {})
      const w = sortKeys(want[i])
      for (const k of new Set([...Object.keys(g), ...Object.keys(w)])) {
        if (JSON.stringify(g[k]) !== JSON.stringify(w[k])) {
          return `${w.key ?? i}.${k}: 스텁 ${JSON.stringify(g[k])} ≠ 앱 ${JSON.stringify(w[k])}`
        }
      }
    }
    return null
  }

  // (1) 자동 설치 목록 — winget이 있는 PC
  {
    const got = await loadStub('wizard').canAutoInstall()
    eq('canAutoInstall이 packages를 준다', Array.isArray(got.packages), 'true')
    const want = prodPackages({ winget: true, version: '1.11.400' })
    const d = diff(got.packages ?? [], want)
    d === null
      ? ok(`설치 목록이 앱이 주는 값과 같다 (${want.length}개, 게시자·id·범위·명령까지)`)
      : bad('설치 목록 계약', `${d} — 화면이 지어낸 값을 검사가 그대로 통과시키게 된다`)
  }

  // (2) winget이 막힌 회사 PC. **claude는 공식 스크립트라 여전히 깔 수 있다** —
  //     available이 항목마다 갈리는지가 여기서 갈린다(전부 false로 두면 결함을 못 잡는다).
  {
    const got = await loadStub('wizard-nowinget').canAutoInstall()
    eq('winget이 없는 갈래는 winget:false', got.winget, 'false')
    eq('없는 버전을 지어내지 않는다', got.version, 'null')
    const want = prodPackages({ winget: false, version: null })
    const d = diff(got.packages ?? [], want)
    d === null ? ok('winget이 없을 때의 항목별 판정도 앱과 같다') : bad('설치 목록 계약(winget 없음)', d)
    const can = (k) => (got.packages ?? []).find((p) => p.key === k)?.available
    eq('winget이 없어도 claude는 깔 수 있다', can('claude'), 'true')
    eq('winget이 필요한 항목은 못 깐다', `${can('python')}/${can('git')}`, 'false/false')
  }

  // (3) 준비물 목록 — **앱이 절대 주지 않는 항목을 그리지 않는가.**
  //     Node는 REQUIREMENTS에서 빠졌다(공식 스크립트가 PowerShell만 쓴다). 스텁에만
  //     남아 있으면 화면 검사가 있지도 않은 줄을 계속 확인하게 된다.
  {
    const cAt = mainSrc.indexOf('async function checkRequirements(')
    const outKeys = keysOfObject(mainSrc, mainSrc.indexOf('{', mainSrc.indexOf('out.push(', cAt)))
    const known = new Map(REQUIREMENTS.map((r) => [r.key, r]))
    for (const scenario of ['normal', 'missing', 'wizard', 'wizard-login']) {
      const list = await loadStub(scenario).checkRequirements()
      const strays = list.filter((r) => !known.has(r.key)).map((r) => r.key)
      const fields = [...new Set(list.flatMap((r) => Object.keys(r)))].sort()
      const problems = []
      if (strays.length) problems.push(`앱에 없는 항목: ${strays.join(', ')}`)
      const extra = fields.filter((f) => !outKeys.includes(f))
      const gone = outKeys.filter((f) => !fields.includes(f))
      if (extra.length) problems.push(`지어낸 필드: ${extra.join(', ')}`)
      if (gone.length) problems.push(`빠뜨린 필드: ${gone.join(', ')}`)
      for (const r of list) {
        const real = known.get(r.key)
        if (!real) continue
        // 값이 바뀌지 않는 것들은 앱이 주는 그대로여야 한다(화면이 이 문구를 그린다).
        for (const [k, want] of [
          ['label', real.label],
          ['why', real.why],
          ['url', real.url ?? null],
          ['optional', Boolean(real.optional)],
          ['canInstall', Boolean(real.auto)],
        ]) {
          if (JSON.stringify(r[k]) !== JSON.stringify(want)) {
            problems.push(`${r.key}.${k}: 스텁 ${JSON.stringify(r[k])} ≠ 앱 ${JSON.stringify(want)}`)
          }
        }
      }
      problems.length === 0
        ? ok(`준비물 목록이 앱과 같다: ${scenario}`)
        : bad(`준비물 목록 계약(${scenario})`, problems.join(' / '))
    }
  }
}

// ── 18. 검사 스텁이 **없는 계약을 지어내지 않는가** ─────────────────────────
//
// 실물 사고: 마법사(renderer/wizard.js)는 상태 이벤트에서 `firstRunDone`을 받길
// 기다렸는데, 정작 `pumpStatusAll`의 payload에는 그 필드가 **없었다.** 저장소에서
// 그 필드를 status에 싣는 곳은 검사 스텁(tools/ui-stub.js) 하나뿐이었다 —
// **검사 스텁이 프로덕션에 없는 계약을 지어내서** 화면 검사(check-ui)를 통과시켰다.
// 화면은 초록불인데 실물은 배선이 끊겨 있던 것이다.
//
// 그래서 여기서 **두 payload의 필드 집합을 맞대 본다.** 스텁이 지어내도 잡히고,
// 프로덕션이 새 필드를 늘렸는데 스텁이 안 따라와도 잡힌다.
function statusContractChecks() {
  console.log('\n상태 payload 계약 (프로덕션 ↔ 검사 스텁)')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const stubSrc = fs.readFileSync(path.join(ROOT, 'tools', 'ui-stub.js'), 'utf8').replace(/\r\n/g, '\n')

  const mainKeys = keysOfObject(
    mainSrc,
    mainSrc.indexOf('{', mainSrc.indexOf('const payload = {', mainSrc.indexOf('function pumpStatusAll('))),
  )
  const stubKeys = keysOfObject(stubSrc, stubSrc.indexOf('{', stubSrc.indexOf('cb(', stubSrc.indexOf('onStatus:'))))

  if (mainKeys.length < 3 || stubKeys.length < 3) {
    bad('상태 payload를 읽지 못했다', `main ${mainKeys.length}개 / stub ${stubKeys.length}개`)
  } else {
    const only = (a, b) => a.filter((k) => !b.includes(k))
    const invented = only(stubKeys, mainKeys)
    const missing = only(mainKeys, stubKeys)
    invented.length === 0
      ? ok(`스텁이 없는 필드를 지어내지 않는다 (${stubKeys.length}개)`)
      : bad('지어낸 계약', `스텁에만 있다: ${invented.join(', ')} — 화면 검사만 통과하고 실물은 끊긴다`)
    missing.length === 0
      ? ok('스텁이 실제 필드를 빠뜨리지 않는다')
      : bad('빠진 계약', `프로덕션에만 있다: ${missing.join(', ')} — 그 갈래는 화면에서 한 번도 안 그려진다`)
  }

  // 이번 사고의 본체. 셋이 다 있어야 배선이 산다.
  eq('상태에 firstRunDone이 실린다', mainKeys.includes('firstRunDone'), 'true')
  eq('그 값은 설정에서 온다', /firstRunDone: Boolean\(cfg\.firstRunDone\)/.test(mainSrc), 'true')
  const wiz = fs.readFileSync(path.join(ROOT, 'renderer', 'wizard.js'), 'utf8')
  eq('화면이 그 값을 실제로 읽는다', /firstRunDone/.test(wiz), 'true')
  // 표시를 남기는 쪽도 같은 키여야 한다(wizard:done이 config에 적는 그 키다).
  eq('마법사를 끝내면 그 키를 적는다', /saveConfig\(\{ \.\.\.loadConfig\(\), firstRunDone: true \}\)/.test(mainSrc), 'true')
}

// ── 정리 ───────────────────────────────────────────────────────────────────
// 계정 검사는 비동기(명령 실행·감시 흐름)라 끝난 뒤에 정리한다.
statusContractChecks()
terminalChecks()
accountChecks()
  .catch((e) => bad('계정 검사가 던졌다', e && e.message))
  .then(() => installChecks())
  .catch((e) => bad('설치 검사가 던졌다', (e && e.stack) || (e && e.message)))
  .then(() => ipcContractChecks())
  .catch((e) => bad('IPC 계약 검사가 던졌다', (e && e.stack) || (e && e.message)))
  .then(() => {
    fs.rmSync(LAB, { recursive: true, force: true })
    if (failed) {
      console.error(`\n로직 검사 실패 — ${failed}건`)
      process.exit(1)
    }
    console.log('로직 검사 통과')
  })
