// 검사용 preload — 메인 프로세스 없이 **진짜 렌더러**를 띄우기 위한 최소 API.
//
// 화면을 눈으로 훑는 대신 재서 검사하려면 렌더러가 혼자 뜰 수 있어야 한다. 여기서
// 주는 값은 전부 가짜지만, 렌더러는 진짜다 — styles.css와 app.js를 그대로 쓴다.
//
// 시나리오는 환경변수 `SCENARIO`로 고른다. 화면이 달라지는 갈래마다 하나씩 둔다:
//   normal   프로젝트 3개, 팀이 일하는 중
//   empty    붙인 프로젝트 없음(첫 실행)
//   missing  필요한 프로그램이 안 깔린 PC
//   nologin  Claude 로그인 안 됨
//   stress   긴 이름·긴 경로·많은 데이터 (레이아웃이 버티는지)
//   rundead  주소는 주웠지만 서버가 죽은 실행 / 아직 확인 중인 실행
//            (주소만 보고 링크를 내주던 버그를 고치며 생긴 갈래다)
//   team     팀원 관리 패널을 연 상태 (고용·해고·복직·전역 팀원이 한 화면에)
//   teamfull 정원(14명)이 꽉 차고 처리 중이라 아무것도 못 바꾸는 상태 +
//            아주 긴 id — 목록이 버티는지, 버튼이 비활성으로 죽는지
//            (`team`으로 시작하는 갈래는 tools/ui-audit.js가 패널까지 열어 준다)
//   acct     ☰의 연결 — 로그인된 계정이 보이고 바꿀 수 있는 상태
//   acctlong 아주 긴 이메일 + 아주 긴 조직명 (잘리지 않고 줄을 넘기는지)
//   acctout  로그인 안 됨 + Figma 미연결 (점이 꺼지고 [연결하기]가 되는지)
//   acctfigma 로그인은 됐는데 Figma 인증만 풀린 상태(등록은 돼 있어 [다시 연결]이다)
//   acctbusy 지시가 도는 중 — 계정 바꾸기가 **비활성으로 죽고** 이유가 보이는지
//            (`acct`로 시작하는 갈래는 tools/ui-audit.js가 ☰를 열어 준다)
const { contextBridge } = require('electron')

const S = process.env.SCENARIO || 'normal'
const now = Date.now() / 1000

// 옛 메인이 주던 모양 그대로. 이메일은 있고 조직·구독 필드는 이름이 다르다(plan) —
// **이 갈래가 하위 호환을 지키는 검사다.** 새 필드가 없어도 화면이 깨지면 안 된다.
const okEnv = {
  claude: { installed: true, loggedIn: true, email: 'you@example.com', plan: 'max' },
  figma: { connected: true, present: true },
}
// 새 계약. 로그인 계정 정보가 claude에 실려 온다.
const acctClaude = {
  installed: true,
  loggedIn: true,
  email: 'user@example.com',
  orgName: "user@example.com's Organization",
  subscriptionType: 'max',
  authMethod: 'claude.ai',
}
// 회사 계정은 길다. 조직명은 회사 이름과 부서까지 들어가는 경우가 있다(실측 62자).
const longClaude = {
  installed: true,
  loggedIn: true,
  email: 'yoon.jeong-hyeon.developer.account@very-long-company-domain-example.co.kr',
  orgName: '주식회사 아주긴이름 플랫폼개발본부 (Yoon Enterprise Global Platform Organization)',
  subscriptionType: 'enterprise',
  authMethod: 'console.anthropic.com API key',
}
const ENV = {
  normal: okEnv,
  empty: okEnv,
  stress: okEnv,
  rundead: okEnv,
  team: okEnv,
  teamfull: okEnv,
  acct: { claude: acctClaude, figma: { connected: true, present: true } },
  // 긴 계정 + Figma를 아직 한 번도 붙이지 않은 상태([연결하기]가 나오는 갈래).
  acctlong: { claude: longClaude, figma: { connected: false, present: false } },
  // 로그인 전에는 계정 정보가 아예 없다 — null/undefined가 그대로 온다.
  acctout: {
    claude: { installed: true, loggedIn: false, email: null, orgName: null, subscriptionType: null },
    figma: { connected: false, present: false },
  },
  acctfigma: { claude: acctClaude, figma: { connected: false, present: true } },
  acctbusy: { claude: acctClaude, figma: { connected: true, present: true } },
  nologin: {
    claude: { installed: true, loggedIn: false, email: null, plan: null },
    figma: { connected: false, present: false },
  },
  missing: { claude: { installed: false, loggedIn: false }, figma: { connected: false, present: false } },
}
/** ☰의 연결을 보는 갈래들. 표·명단·프로젝트는 같게 두고 **계정만** 달리한다. */
const ACCT = ['acct', 'acctlong', 'acctout', 'acctfigma', 'acctbusy']

// 토큰 사용량. 숫자는 **실측에서 가져온다** — 만들어 낸 작은 값으로는 자리가
// 모자라는지 알 수 없다(실제로 캐시 읽기가 1.3억까지 갔다).
const tally = (input, output, cacheWrite, cacheRead) => ({ input, output, cacheWrite, cacheRead })
const realUsage = {
  total: tally(125_825, 1_002_962, 8_768_723, 135_800_963),
  today: tally(125_825, 1_002_962, 8_768_723, 135_800_963),
  run: tally(12_040, 121_388, 690_244, 12_503_991),
  agents: [
    { name: 'backend-dev', ...tally(20_000, 332_100, 2_100_000, 40_000_000) },
    { name: 'lead', ...tally(120, 221_477, 1_553_969, 3_883_739) },
    { name: 'frontend-dev', ...tally(18_000, 210_400, 1_900_000, 38_000_000) },
    { name: 'qa-tester', ...tally(9_000, 121_000, 900_000, 21_000_000) },
    { name: 'code-reviewer', ...tally(4_000, 61_000, 400_000, 9_000_000) },
    { name: 'ux-designer', ...tally(3_000, 41_000, 300_000, 7_000_000) },
  ],
}
const USAGE = {
  normal: realUsage,
  stress: realUsage,
  nologin: realUsage,
  rundead: realUsage,
  team: realUsage,
  teamfull: realUsage,
  empty: null, // 아직 한 번도 안 돌린 프로젝트에는 표시가 없어야 한다
  missing: null,
}
// ☰를 열어 두는 갈래다. 사용량 표가 펴진 채로도 연결 줄이 버티는지 한 번은 봐야 하고,
// 표가 없을 때 그 자리가 제대로 접히는지도 봐야 한다([hidden]이 안 먹던 자리다).
USAGE.acct = realUsage
USAGE.acctlong = USAGE.acctout = USAGE.acctfigma = USAGE.acctbusy = null

const req = (key, label, why, installed, version, url) => ({
  key, label, why, installed, version, canInstall: key === 'claude', optional: key === 'git', url,
})
const REQS = {
  normal: [
    req('node', 'Node.js', 'Claude Code를 설치·실행하는 데 필요합니다', true, 'v22.14.0', null),
    req('python', 'Python', '팀 활동을 화면에 기록하는 훅이 python으로 돕니다', true, 'Python 3.13.14', null),
    req('claude', 'Claude Code', '팀원이 실제로 일하는 실행기입니다', true, '2.1.220', null),
    req('git', 'Git', '회사는 권한을 묻지 않고 파일을 고칩니다. 되돌릴 수단은 git뿐입니다', true, 'git 2.49.0', null),
  ],
  missing: [
    req('node', 'Node.js', 'Claude Code를 설치·실행하는 데 필요합니다', false, null, 'https://nodejs.org'),
    req('python', 'Python', '팀 활동을 화면에 기록하는 훅이 python으로 돕니다. 없으면 사무실이 조용합니다', false, null, 'https://python.org'),
    req('claude', 'Claude Code', '팀원이 실제로 일하는 실행기입니다', false, null, null),
    req('git', 'Git', '회사는 권한을 묻지 않고 파일을 고칩니다. 되돌릴 수단은 git뿐입니다', false, null, 'https://git-scm.com'),
  ],
}
REQS.empty = REQS.nologin = REQS.stress = REQS.rundead = REQS.normal
REQS.team = REQS.teamfull = REQS.normal
for (const s of ACCT) REQS[s] = REQS.normal

const health = (o = {}) => ({ hooks: true, agents: 9, guide: true, git: true, hookStale: false, stale: 0, ...o })
const LONG = 'C:\\dev\\2026\\아주-긴-프로젝트-이름을-가진-폴더-이름이-이렇게까지-길-수도-있다'

const PROJECTS = {
  normal: [
    { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'busy', queued: 2,
      health: health({ git: false, stack: ['Next.js', 'React', 'Prisma'] }),
      // `ready`는 **주소를 주운 뒤 살아 있는 것까지 확인된** 상태다. url만 주면
      // 화면은 "확인 중…"을 보여 준다(주소만으로 링크를 내주지 않는다).
      run: { script: 'dev', running: true, url: 'http://localhost:3000', ready: true, dead: false } },
    { dir: 'C:\\dev\\2026\\board', exists: true, company: 'open', queued: 0,
      health: health({ agents: 0, guide: false }), run: { script: null, running: false, url: null } },
    { dir: 'C:\\dev\\2026\\landing-page-renewal', exists: false, company: 'closed', queued: 0,
      health: health({ hooks: false, agents: 0, guide: false }), run: { script: null, running: false, url: null } },
  ],
  nologin: [{ dir: 'C:\\dev\\2026\\shop', exists: true, company: 'closed', queued: 1, health: health() }],
  stress: [
    { dir: LONG, exists: true, company: 'busy', queued: 7,
      health: health({ git: false, hookStale: true, stack: ['Next.js', 'React', 'TypeScript', 'Tailwind', 'Prisma', 'SQLite'] }),
      run: { script: 'dev', running: true, url: 'http://localhost:3000/very/long/path/that/keeps/going', ready: true, dead: false } },
  ],
  // 주소를 주웠는지와 서버가 살아 있는지가 **다른 값**이라는 것을 화면이 지키는지 본다.
  // 탭 배지 상태는 normal과 같게 둔다 — 여기서 보려는 것은 **실행 표시**뿐이다.
  rundead: [
    { dir: 'C:\\dev\\2026\\daily', exists: true, company: 'busy', queued: 1, health: health(),
      // 주소를 내놓고 죽었다 — 링크로 내주면 안 된다(실측: vite 5173)
      run: { script: 'dev', running: true, url: 'http://localhost:5173/', ready: false, dead: true } },
    { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'busy', queued: 2, health: health(),
      // 주소는 찾았지만 아직 지켜보는 중
      run: { script: 'dev', running: true, url: 'http://localhost:3000', ready: false, dead: false } },
  ],
  // 팀원 관리 — 붙인 프로젝트 하나. 여기서 보려는 것은 **패널**이다.
  team: [
    { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'open', queued: 0,
      health: health({ agents: 11 }), run: { script: null, running: false, url: null } },
  ],
  // 정원이 꽉 차고 **지시가 도는 중**이라 아무것도 못 바꾸는 상태.
  teamfull: [
    { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'busy', queued: 3,
      health: health({ agents: 14 }), run: { script: null, running: false, url: null } },
  ],
  empty: [],
  missing: [],
}

// ☰의 연결을 보는 갈래. 프로젝트는 하나로 두고 **처리 중인지만** 달리한다.
const ACCT_PROJECT = {
  dir: 'C:\\dev\\2026\\shop', exists: true, company: 'open', queued: 0,
  health: health({ agents: 11 }), run: { script: null, running: false, url: null },
}
for (const s of ACCT) PROJECTS[s] = [ACCT_PROJECT]
// 지시가 도는 중 — 계정 바꾸기가 죽고 **어느 회사 때문인지** 이름이 그대로 떠야 한다.
// 폴더 이름은 사람이 짓는 것이라 길 수도 있어서, 짧은 것과 긴 것을 같이 돌린다.
PROJECTS.acctbusy = [
  { dir: 'C:\\dev\\2026\\ConvertFlow', exists: true, company: 'busy', queued: 2,
    health: health({ agents: 11 }), run: { script: null, running: false, url: null } },
  { dir: LONG, exists: true, company: 'busy', queued: 1,
    health: health({ agents: 11 }), run: { script: null, running: false, url: null } },
]

// ---------------------------------------------------------------------------
// 팀 명단 (고용·해고)
//
// 화면이 봐야 하는 갈래를 한 번에 담는다: 프로젝트 팀원 / 전역 팀원(해고 불가) /
// 카탈로그의 미고용·해고자 / 정원 참 / 처리 중. 설명은 **실제 정의만큼 길게** 둔다 —
// 짧은 문구로는 목록이 버티는지 알 수 없다.
const member = (id, desc, seat, opts = {}) => ({
  id,
  desc,
  tools: opts.tools ?? ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  scope: opts.scope ?? 'project',
  seat,
  fireable: opts.fireable ?? (opts.scope ?? 'project') === 'project',
  file: `C:\\dev\\2026\\shop\\.claude\\agents\\${id}.md`,
})
const LEAD_MEMBER = { id: 'lead', desc: '팀을 이끌고 일을 나눈다', tools: [], scope: 'lead', seat: null, fireable: false, file: null }
const cat = (id, desc, state, tools) => ({ id, desc, tools: tools ?? ['Read', 'Edit', 'Write'], state })

// 아주 긴 id — 메인의 SAFE_AGENT_ID가 허용하는 40자에 맞춘 최악의 경우.
const LONG_ID = 'data-pipeline-observability-analyst-x'

const TEAM_MEMBERS = [
  LEAD_MEMBER,
  member('planner', '기획안·요구사항 정리·작업 분해. 무엇을 만들지 정하고 순서를 세운다', 0),
  member('ux-designer', '화면 설계·Figma 시안. 사용자가 실제로 보게 될 것을 먼저 그린다', 1),
  member('frontend-dev', '웹 화면 구현. 접근성과 반응형을 기본으로 챙긴다', 2),
  member('backend-dev', '서버·API·DB. 경계 타입과 입력 검증을 놓치지 않는다', 3),
  member('data-analyst', '데이터 분석·지표 설계 · 직접 만든 팀원입니다', 4, { tools: ['Read', 'Grep', 'Glob'] }),
  member('code-reviewer', '변경 검토. 되돌릴 수 없는 것과 놓친 경계를 먼저 본다', 5),
  member('qa-tester', '실제로 눌러 보고 확인한다. 통과했다고 말하기 전에 증거를 남긴다', 6),
  member('seo-writer', '검색 노출·문구 다듬기', 7),
  member('release-manager', '배포·릴리스 노트. 되돌릴 수단을 먼저 확인한다', 8),
  member('scout', '묻는 말에 답하는 조사역', 9, { scope: 'user' }),
  member('growth-pm', '실험 설계·지표 추적', 10),
]

// 자리 14칸을 하나도 남기지 않고 채운다(0..13). free가 0인 화면을 보려면 그래야 한다.
const TEAM_FULL_MEMBERS = [
  LEAD_MEMBER,
  ...TEAM_MEMBERS.filter((m) => m.id !== 'lead'),
  member('debugger', '버그·런타임 실패의 원인을 추적한다', 11),
  member(LONG_ID, '데이터 파이프라인 관측·지표 수집·이상 탐지까지 한 사람이 맡는다. 이름이 아주 길다', 12),
  member('doc-writer', '문서 정리 — 이 컴퓨터 전체의 팀원이라 여기서는 해고할 수 없다', 13, { scope: 'user' }),
]

const TEAM = {
  team: {
    ok: true,
    busy: false,
    capacity: 14,
    free: 3,
    members: TEAM_MEMBERS,
    catalog: [
      cat('mobile-dev', '앱 화면 구현', 'available', ['Read', 'Edit', 'Write']),
      cat('debugger', '버그·런타임 실패의 원인을 추적한다', 'fired'),
      cat('old-analytics-helper', '예전에 쓰던 분석 보조 — 정의를 손으로 고쳐 두었다', 'fired', ['Read', 'Grep']),
      ...TEAM_MEMBERS.filter((m) => m.id !== 'lead').map((m) => cat(m.id, m.desc, 'employed', m.tools)),
    ],
  },
  teamfull: {
    ok: true,
    busy: true, // 지시가 도는 중 — 패널 머리에 이유가 뜨고 모든 버튼이 죽어야 한다
    capacity: 14,
    free: 0,
    members: TEAM_FULL_MEMBERS,
    catalog: [
      cat('mobile-dev', '앱 화면 구현', 'available', ['Read', 'Edit', 'Write']),
      cat('legacy-migration-helper', '옛 데이터 옮기기 — 끝나서 해고했다', 'fired'),
      ...TEAM_FULL_MEMBERS.filter((m) => m.id !== 'lead').map((m) => cat(m.id, m.desc, 'employed', m.tools)),
    ],
  },
}

for (const s of ACCT) TEAM[s] = TEAM.team

/** projects:status에 실리는 명단(활성 프로젝트만). 화면은 이걸로 자리를 잡는다. */
const teamOf = (s) => TEAM[s]?.members.map(({ id, scope, seat }) => ({ id, scope, seat })) ?? null

const tool = (agent, name, detail) => ({ ts: now - 100, type: 'tool', agent, tool: name, detail })
const EVENTS = {
  normal: [
    { ts: now - 300, type: 'command', agent: 'lead', detail: 'B2C 쇼핑몰 기획안 작성해줘' },
    { ts: now - 299, type: 'command_taken', agent: 'lead', snap: 'refs/teamview/snap/1' },
    { ts: now - 290, type: 'agent_start', agent: 'planner' },
    tool('planner', 'mcp__figma__create_new_file'),
    { ts: now - 180, type: 'agent_start', agent: 'ux-designer' },
    tool('ux-designer', 'Write', 'C:\\dev\\2026\\shop\\components\\product\\ProductPurchasePanel.tsx'),
    { ts: now - 60, type: 'agent_start', agent: 'backend-dev' },
    tool('backend-dev', 'Bash', 'npx tsc --noEmit'),
    // 되돌릴 수 없는 명령 — 줄이지도 접지도 않고 붉게 남아야 한다
    tool('backend-dev', 'Bash', 'cd /c/dev/2026 && rm -rf board-scaffold-tmp && rm -rf board/.next'),
    { ts: now - 5, type: 'reply', agent: 'lead', detail: "조사 결과입니다. (묻는 말이라 파일·Figma 산출물은 만들지 않았습니다.)\n\n먼저 확인된 사실 하나 — 지난번 중단된 리뷰 수정은 **실제로 반영돼 있었습니다.** Blocker 2건·Major 6건 전부 고쳐졌고, Minor 8건 중 7건도 반영됐습니다. `tsc --noEmit`, `next build` 모두 경고 0으로 통과합니다.\n\n## 지금 당장 고칠 것\n\n| | 문제 | 위치 |\n|---|---|---|\n| 1 | **UTF-16 BOM 경로로 바이너리가 통과** — UTF-8/EUC-KR은 `fatal:true`로 막았는데 BOM 분기만 남았습니다. gzip 헤더 바이트를 `.txt`로 올리면 예외 없이 깨진 글자 PDF가 200으로 내려옵니다(실측 확인) | `lib/server/txtToPdf.ts:106-111` |\n| 2 | **`/api/convert`에 레이트 리밋·오리진 검사가 전무** — 무인증 공개 엔드포인트가 요청당 20MB + CPU 30초를 씁니다. 게다가 본문이 요청당 4번 복사돼(~60-80MB 상주) OOM 벡터가 됩니다 | `route.ts` 전체, `route.ts:164-197, 269-273, 334` |\n| 3 | `tmp-check/` 스크래치 폴더가 커밋 대기 중 — 파일 자신이 \"끝나면 지운다\"고 적어 둔 것입니다 | `tmp-check/` |\n\n## 다음에\n\n- **지원 포맷의 진실 소스가 둘**입니다. `lib/constants.ts:117-129`가 `'.txt'`를 하드코딩해서, `documentFormats.ts` 매트릭스만 바꾸면 검증은 통과하는데 file input `accept`·라벨·안내 문구는 TXT에 머뭅니다. README가 약속한 \"매트릭스 한 줄만 바꾸면 됨\"이 실제로는 안 지켜집니다 — Phase 2 착수 전 선행 작업입니다.\n- `doc.save()`·`embedFont`(`txtToPdf.ts:270-311`)에 양보 지점이 없어, 루프는 고쳤지만 이 구간에서 타임아웃이 다시 무력해질 수 있습니다.\n- `package.json`에 `\"lint\": \"next lint\"`가 있는데 **ESLint 의존성도 설정도 없습니다.** 테스트도 0건입니다.\n- `README.md:3-4` 첫 문장이 아직 \"파일은 서버로 올라가지 않고\" — 문서 변환이 붙은 지금은 사실과 다릅니다(하단 섹션은 올바름).\n\n## 나중에\n\n`wrapLine` 누적 재계산, Select의 Tab 시 포커스 유실·같은 첫 글자 순환 점프, 완료 행의 개별 재변환 버튼 부재.\n\n**기능 공백**: 이미지 변환은 완결, 문서는 TXT→PDF 1개만 `ready`이고 나머지 6조합(MD/HTML/DOCX→PDF, PDF→PNG/JPG/TXT)은 `planned`입니다. 다만 planned 처리 경로(서버 501 → 클라이언트 사전 차단 → 드롭다운 비활성)는 이미 다 연결돼 있어 구멍은 아닙니다.\n\n브라우저 실제 동작은 확인하지 않았습니다(dev 서버를 띄우지 않음). 직접 보시려면 윤사무실 상단 `▶ 실행` 버튼을 쓰시면 됩니다." },
  ],
  stress: [
    { ts: now - 400, type: 'command', agent: 'lead', detail: '아주 긴 지시문입니다 '.repeat(20) },
    { ts: now - 399, type: 'command_taken', agent: 'lead', snap: 'refs/teamview/snap/1' },
    ...Array.from({ length: 40 }, (_, i) =>
      tool(['backend-dev', 'frontend-dev', 'planner'][i % 3], 'Write',
        `C:\\dev\\2026\\project\\src\\아주\\깊고\\긴\\경로\\components\\VeryLongComponentName${i}.tsx`)),
    tool('backend-dev', 'Bash', 'cd /c/dev && rm -rf ' + 'aaaa/'.repeat(40)),
    { ts: now - 5, type: 'reply', agent: 'lead',
      detail: '답변이 아주 깁니다. '.repeat(60) + ' https://www.figma.com/design/AbCdEf/매우-긴-피그마-파일-이름' },
  ],
  // 팀원 관리 — 여기서 꼭 봐야 하는 것은 **되살아나면 안 되는 이름**이다.
  team: [
    { ts: now - 400, type: 'command', agent: 'lead', detail: '상품 목록 페이지 만들어줘' },
    // 해고자(debugger)가 지난 기록에 남아 있다. 재생으로 들어오므로 대화·결과물에는
    // 쌓이되 **캐릭터가 생기면 안 된다** — 탭만 옮겨도 되살아나는 사고가 그것이다.
    { ts: now - 380, type: 'tool', agent: 'debugger', tool: 'Read', detail: 'C:\\dev\\2026\\shop\\app\\page.tsx', _replay: true },
    { ts: now - 370, type: 'agent_stop', agent: 'debugger', _replay: true },
    { ts: now - 120, type: 'agent_start', agent: 'planner' },
    tool('planner', 'Write', 'C:\\dev\\2026\\shop\\docs\\상품목록-기획안.md'),
    { ts: now - 90, type: 'agent_start', agent: 'data-analyst' },
    tool('data-analyst', 'Grep', 'C:\\dev\\2026\\shop\\lib\\metrics.ts'),
    // 인사 이벤트에는 detail이 없다(작업 배지가 붙으면 안 되기 때문이다).
    { ts: now - 40, type: 'hire', agent: 'growth-pm' },
  ],
  teamfull: [
    { ts: now - 300, type: 'command', agent: 'lead', detail: '지표 수집 파이프라인 점검해줘' },
    { ts: now - 299, type: 'command_taken', agent: 'lead' },
    { ts: now - 200, type: 'agent_start', agent: LONG_ID },
    tool(LONG_ID, 'Bash', 'node scripts/collect-metrics.js'),
  ],
  empty: [],
  missing: [],
  nologin: [],
  rundead: [{ ts: now - 30, type: 'command', agent: 'lead', detail: '개발 서버 띄워줘' }],
}
// 연결 갈래에서 보는 것은 ☰ 안이다. 대화는 한 줄이면 충분하다.
for (const s of ACCT) EVENTS[s] = [{ ts: now - 60, type: 'command', agent: 'lead', detail: '상품 목록 페이지 만들어줘' }]

const noop = () => {}
contextBridge.exposeInMainWorld('teamView', {
  addProject: async () => ({ ok: false, canceled: true }),
  removeProject: async () => ({ ok: true }),
  activateProject: async () => ({ ok: true }),
  setupProject: async () => ({ ok: true, done: [] }),
  listProjects: async () => ({ projects: PROJECTS[S], activeDir: PROJECTS[S][0]?.dir ?? null, max: 3 }),
  loadChat: async () => [],
  appendChat: async () => ({ ok: true }),
  sendCommand: async () => ({ ok: true, companyOpen: true, busy: false }),
  cancelAll: async () => ({ ok: true, queued: 0, killed: 0 }),
  copyText: async () => true,
  openExternal: async () => ({ ok: true }),
  revealFile: async () => ({ ok: true }),
  openLog: async () => ({ ok: true }),
  setChatWidth: async () => ({ ok: true }),
  vitals: async () => ({ ok: true }),
  reportError: async () => ({ ok: true }),
  gitInit: async () => ({ ok: true, done: ['저장소 생성', '첫 커밋 (1개)'] }),
  snapshotDiff: async () => ({ ok: true, items: [{ status: 'A', path: 'src/new.tsx' }] }),
  snapshotRestore: async () => ({ ok: true, removed: 1, restored: 0 }),
  runStart: async () => ({ ok: true }),
  runStop: async () => ({ ok: true }),
  runLog: async () => ({ ok: true, lines: [] }),
  checkEnv: async () => ENV[S],
  checkRequirements: async () => REQS[S],
  // 팀원 관리. 검사에서는 **읽기만** 한다 — 쓰기 통로는 눌렀을 때 화면이 어떻게
  // 되는지 보려고 붙여 두지만, 실제로 파일을 만들지는 않는다.
  listTeam: async () => TEAM[S] ?? { ok: false, error: '이 갈래에는 명단이 없습니다' },
  hireAgent: async (_dir, id) => ({ ok: true, id, from: 'template', path: `C:\\dev\\2026\\shop\\.claude\\agents\\${id}.md` }),
  createAgent: async (_dir, spec) => ({ ok: false, code: 'VALIDATION', error: `${spec?.id}은(는) 이미 팀에 있습니다` }),
  fireAgent: async (_dir, id) => ({ ok: true, id, movedTo: `C:\\dev\\2026\\shop\\.claude\\team-fired\\${id}.md`, requeued: 1 }),
  install: async () => ({ ok: false, canceled: true }),
  login: async () => ({ ok: false, timeout: true, env: ENV[S] }),
  // 계정 전환. **갈래마다 다른 답을 준다** — 확인 창·비활성·오류 문구가 각각
  // 화면에서 어떻게 보이는지 눌러서 확인하려면 응답이 갈라져야 한다.
  switchAccount: async (what) => {
    await new Promise((r) => setTimeout(r, 400)) // '바꾸는 중…'이 보이는 시간
    if (S === 'acctbusy') {
      return { ok: false, busy: true, running: ['ConvertFlow'], error: 'ConvertFlow가 지시를 처리 중입니다' }
    }
    // 문구는 **메인이 실제로 주는 것**을 그대로 쓴다. 짧게 지어낸 것으로는 자리가
    // 모자라는지 알 수 없다(실측: 시간 초과 문구가 46자다).
    if (S === 'acctlong') {
      return {
        ok: false,
        timeout: true,
        error: '3분 안에 끝나지 않았습니다 — 창에서 마친 뒤 "다시 확인"을 눌러 주세요',
        env: ENV[S],
      }
    }
    if (S === 'acctfigma') {
      return { ok: false, manual: 'claude auth login', error: '이 OS에서는 터미널을 자동으로 열 수 없습니다' }
    }
    if (S === 'acctout') return { ok: false, error: '로그아웃하지 못했습니다 — claude: command not found' }
    // 성공 — 바뀐 계정이 그대로 화면에 반영돼야 한다.
    return {
      ok: true,
      env: {
        claude: what === 'claude' ? { ...acctClaude, email: 'work@yoon-company.co.kr' } : ENV[S].claude,
        figma: { connected: true, present: true },
      },
    }
  },
  onEnv: noop,
  onRunFailed: noop,
  onCommandFailed: noop,
  onReset: noop,
  onEvents: (cb) => setTimeout(() => cb({ dir: PROJECTS[S][0]?.dir ?? null, events: EVENTS[S] }), 300),
  onStatus: (cb) =>
    setTimeout(() => cb({
      projects: PROJECTS[S],
      activeDir: PROJECTS[S][0]?.dir ?? null,
      max: 3,
      chatWidth: S === 'stress' ? 520 : null,
      usage: USAGE[S],
      // 명단은 활성 프로젝트 것만 실린다. 화면은 이걸로 자리를 잡는다.
      team: teamOf(S),
    }), 150),
})
