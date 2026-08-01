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
const { contextBridge } = require('electron')

const S = process.env.SCENARIO || 'normal'
const now = Date.now() / 1000

const okEnv = {
  claude: { installed: true, loggedIn: true, email: 'you@example.com', plan: 'max' },
  figma: { connected: true, present: true },
}
const ENV = {
  normal: okEnv,
  empty: okEnv,
  stress: okEnv,
  nologin: {
    claude: { installed: true, loggedIn: false, email: null, plan: null },
    figma: { connected: false, present: false },
  },
  missing: { claude: { installed: false, loggedIn: false }, figma: { connected: false, present: false } },
}

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
  empty: null, // 아직 한 번도 안 돌린 프로젝트에는 표시가 없어야 한다
  missing: null,
}

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
REQS.empty = REQS.nologin = REQS.stress = REQS.normal

const health = (o = {}) => ({ hooks: true, agents: 9, guide: true, git: true, hookStale: false, stale: 0, ...o })
const LONG = 'C:\\dev\\2026\\아주-긴-프로젝트-이름을-가진-폴더-이름이-이렇게까지-길-수도-있다'

const PROJECTS = {
  normal: [
    { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'busy', queued: 2,
      health: health({ git: false, stack: ['Next.js', 'React', 'Prisma'] }),
      run: { script: 'dev', running: true, url: 'http://localhost:3000' } },
    { dir: 'C:\\dev\\2026\\board', exists: true, company: 'open', queued: 0,
      health: health({ agents: 0, guide: false }), run: { script: null, running: false, url: null } },
    { dir: 'C:\\dev\\2026\\landing-page-renewal', exists: false, company: 'closed', queued: 0,
      health: health({ hooks: false, agents: 0, guide: false }), run: { script: null, running: false, url: null } },
  ],
  nologin: [{ dir: 'C:\\dev\\2026\\shop', exists: true, company: 'closed', queued: 1, health: health() }],
  stress: [
    { dir: LONG, exists: true, company: 'busy', queued: 7,
      health: health({ git: false, hookStale: true, stack: ['Next.js', 'React', 'TypeScript', 'Tailwind', 'Prisma', 'SQLite'] }),
      run: { script: 'dev', running: true, url: 'http://localhost:3000/very/long/path/that/keeps/going' } },
  ],
  empty: [],
  missing: [],
}

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
    { ts: now - 5, type: 'reply', agent: 'lead', detail: "조사 결과입니다. (묻는 말이라 파일·Figma 산출물은 만들지 않았습니다.)\n\n먼저 확인된 사실 하나 — 지난번 중단된 리뷰 수정은 **실제로 반영돼 있었습니다.** Blocker 2건·Major 6건 전부 고쳐졌고, Minor 8건 중 7건도 반영됐습니다. `tsc --noEmit`, `next build` 모두 경고 0으로 통과합니다.\n\n## 지금 당장 고칠 것\n\n| | 문제 | 위치 |\n|---|---|---|\n| 1 | **UTF-16 BOM 경로로 바이너리가 통과** — UTF-8/EUC-KR은 `fatal:true`로 막았는데 BOM 분기만 남았습니다. gzip 헤더 바이트를 `.txt`로 올리면 예외 없이 깨진 글자 PDF가 200으로 내려옵니다(실측 확인) | `lib/server/txtToPdf.ts:106-111` |\n| 2 | **`/api/convert`에 레이트 리밋·오리진 검사가 전무** — 무인증 공개 엔드포인트가 요청당 20MB + CPU 30초를 씁니다. 게다가 본문이 요청당 4번 복사돼(~60-80MB 상주) OOM 벡터가 됩니다 | `route.ts` 전체, `route.ts:164-197, 269-273, 334` |\n| 3 | `tmp-check/` 스크래치 폴더가 커밋 대기 중 — 파일 자신이 \"끝나면 지운다\"고 적어 둔 것입니다 | `tmp-check/` |\n\n## 다음에\n\n- **지원 포맷의 진실 소스가 둘**입니다. `lib/constants.ts:117-129`가 `'.txt'`를 하드코딩해서, `documentFormats.ts` 매트릭스만 바꾸면 검증은 통과하는데 file input `accept`·라벨·안내 문구는 TXT에 머뭅니다. README가 약속한 \"매트릭스 한 줄만 바꾸면 됨\"이 실제로는 안 지켜집니다 — Phase 2 착수 전 선행 작업입니다.\n- `doc.save()`·`embedFont`(`txtToPdf.ts:270-311`)에 양보 지점이 없어, 루프는 고쳤지만 이 구간에서 타임아웃이 다시 무력해질 수 있습니다.\n- `package.json`에 `\"lint\": \"next lint\"`가 있는데 **ESLint 의존성도 설정도 없습니다.** 테스트도 0건입니다.\n- `README.md:3-4` 첫 문장이 아직 \"파일은 서버로 올라가지 않고\" — 문서 변환이 붙은 지금은 사실과 다릅니다(하단 섹션은 올바름).\n\n## 나중에\n\n`wrapLine` 누적 재계산, Select의 Tab 시 포커스 유실·같은 첫 글자 순환 점프, 완료 행의 개별 재변환 버튼 부재.\n\n**기능 공백**: 이미지 변환은 완결, 문서는 TXT→PDF 1개만 `ready`이고 나머지 6조합(MD/HTML/DOCX→PDF, PDF→PNG/JPG/TXT)은 `planned`입니다. 다만 planned 처리 경로(서버 501 → 클라이언트 사전 차단 → 드롭다운 비활성)는 이미 다 연결돼 있어 구멍은 아닙니다.\n\n브라우저 실제 동작은 확인하지 않았습니다(dev 서버를 띄우지 않음). 직접 보시려면 Team View 상단 `▶ 실행` 버튼을 쓰시면 됩니다." },
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
  empty: [],
  missing: [],
  nologin: [],
}

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
  install: async () => ({ ok: false, canceled: true }),
  login: async () => ({ ok: false, timeout: true, env: ENV[S] }),
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
    }), 150),
})
