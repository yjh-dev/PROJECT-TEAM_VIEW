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
    lead.slice(lead.indexOf('function failureFor'), fj + 3),
    'module.exports = { failureFor }',
  ].join('\n')
  const ff = path.join(os.tmpdir(), 'tv-check-failure.js')
  fs.writeFileSync(ff, ffCode, 'utf8')
  delete require.cache[require.resolve(ff)]
  const { failureFor } = require(ff)

  process.env.WHY = '0'
  failureFor('d', 's', 0, 0) === null ? ok('성공은 실패로 적지 않는다') : bad('성공 판정', 'null이 아니다')
  const unknown = failureFor('d', 's', 0, 1)
  unknown && typeof unknown.message === 'string'
    ? ok('사유를 못 찾아도 실패는 실패로 알린다')
    : bad('실패 판정', '사유가 없으면 성공으로 처리된다 — "작업이 끝났습니다"가 뜬다')
  process.env.WHY = '1'
  failureFor('d', 's', 0, 1)?.label === '토큰 사용량 한도'
    ? ok('사유를 찾으면 그대로 붙인다')
    : bad('사유 전달', '찾은 사유가 버려진다')
}

// ── 정리 ───────────────────────────────────────────────────────────────────
fs.rmSync(LAB, { recursive: true, force: true })
if (failed) {
  console.error(`\n로직 검사 실패 — ${failed}건`)
  process.exit(1)
}
console.log('로직 검사 통과')
