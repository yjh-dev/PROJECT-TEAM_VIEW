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
    const start = src.indexOf('\nfunction ' + n + '(')
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

// ── 정리 ───────────────────────────────────────────────────────────────────
fs.rmSync(LAB, { recursive: true, force: true })
if (failed) {
  console.error(`\n로직 검사 실패 — ${failed}건`)
  process.exit(1)
}
console.log('로직 검사 통과')
