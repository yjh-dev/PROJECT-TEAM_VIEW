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
    { ts: now - 5, type: 'reply', agent: 'lead', detail: '기획안을 Figma에 만들었습니다. 링크: https://www.figma.com/design/abc123' },
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
  onReset: noop,
  onEvents: (cb) => setTimeout(() => cb({ dir: PROJECTS[S][0]?.dir ?? null, events: EVENTS[S] }), 300),
  onStatus: (cb) =>
    setTimeout(() => cb({
      projects: PROJECTS[S],
      activeDir: PROJECTS[S][0]?.dir ?? null,
      max: 3,
      chatWidth: S === 'stress' ? 520 : null,
    }), 150),
})
