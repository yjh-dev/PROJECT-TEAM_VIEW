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
//
//   상단 사용량. `usage`로 시작하는 갈래는 ui-audit.js가 상단 숫자를 눌러 편다.
//   **여섯 갈래의 초기 조건이 서로 다르다** — 하나라도 같으면 그 조건에서만 나는
//   결함이 원리적으로 발생 불가가 된다(마법사 여섯 갈래가 전부 캐릭터 0명이라
//   가림 결함을 한 번도 못 잡던 것과 같은 사고다).
//   usage-pending  첫 집계가 끝나기 전(ready:false — today/week/days가 전부 null)
//                  0으로 그리면 "안 썼다"는 거짓이 된다. (한 번도 안 돌린 새 PC는
//                  이 상태가 아니라 `empty`처럼 **0이 채워진 ready:true**다.)
//   usage-partial  안 쓴 날(0)과 못 본 날(null)이 한 차트에 섞인 상태 —
//                  **0은 바닥 막대, null은 빈칸**으로 갈려야 한다
//   usage-newday   자정 직후 — 지난 날 기록은 있는데 **오늘은 아직 전부 0**이다.
//                  캐시 읽기가 출력의 몇 배인지 낼 수 없는(0으로 나누는) 유일한 갈래라,
//                  여기서 화면이 배수를 지어내면 잡힌다
//   usage-limit    한도에 걸린 기록이 있는 상태 — 리셋 시각이 보이는지
//   usage-huge     아주 큰 숫자(cacheRead 21.6억, 실측) — 자리수에 레이아웃이 버티는지
//   usage-none     preload가 낡아 `getUsageStats` 통로 자체가 없는 상태 —
//                  **상단 숫자가 숨는 유일한 실제 경로다**(앱은 어떤 경우에도 객체를 준다)
//
//   지금 대화의 무게 · 새 대화로 갈아타기. `session`으로 시작하는 갈래는 ui-audit.js가
//   사용량 화면을 펴고 [새 대화 시작]까지 눌러 본다(확인 창을 거치는지·메모가 실려 가는지).
//   session-heavy    실측 그대로 무거운 대화(198턴 · 0.02M → 0.29M) + 놀고 있는 회사 —
//                    갈아타기가 성공한다. 갈아탄 뒤에는 무게가 null이 된다(앱과 같다)
//   session-light    가벼운 대화 + **지시가 도는 회사** — 앱이 거절하고 이유를 준다
//   session-none     기록이 하나도 없다(값이 null) — 0으로 그리면 "안 썼다"가 된다
//   session-nogrowth 첫 턴에 다시 읽은 것이 없어 배수를 낼 수 없는 대화
//                    (firstRead null → growth null. 0으로 나눠 NaN·Infinity가 뜨는지)
//
//   한도 홀드. 한도로 실패하면 앱이 그 회사의 큐를 리셋 시각까지 붙잡아 둔다.
//   hold-active    붙잡힌 회사 + 대기 지시 2건 — 왜 안 도는지·언제 다시 도는지·대기
//                  지시가 취소된 게 아니라는 것이 화면에 있는가
//   hold-none      붙잡히지 않은 회사 + 대기 지시 1건 — **아무것도 뜨지 않아야 한다**
//
//   첫 실행 설치 마법사. `wizard`로 시작하는 갈래는 ui-audit.js가 단계까지 눌러 준다.
//   **다른 갈래에서는 마법사가 뜨면 안 된다** — 그것을 지키는 것이 `firstRunDone`이다.
//   wizard           아무것도 없는 새 PC (0단계 환영)
//   wizard-installing 설치가 도는 중 — 항목별 단계와 경과 시간이 보이는지
//   wizard-fail      winget은 성공이라는데 실행이 안 되는 경우
//                    (**ok:true / verified:false는 실패다** — 가짜 완료를 막는 갈래)
//   wizard-nowinget  자동 설치를 쓸 수 없는 컴퓨터 — 직접 받는 길이 있는지
//   wizard-login     터미널 창을 띄우고 브라우저를 기다리는 중
//   wizard-project   첫 회사 만들기 (설치·로그인은 이미 끝난 상태)
//   wizard-office    **마법사가 떠 있는데 사무실에 사람이 있는 상태.** 위의 여섯 갈래는
//                    전부 붙은 회사가 0개라 사무실이 비어 있고(`#stage-wrap.empty`가
//                    이름표를 통째로 내린다), 그래서 **이름표가 마법사를 뚫는 결함이
//                    한 번도 안 잡혔다.** 실제로는 두 가지 길로 이 상태가 된다 —
//                    마법사 안에서 첫 회사를 만든 직후, 그리고 이미 쓰던 사람이
//                    ☰에서 마법사를 다시 열 때. 여기서는 회사는 붙었는데 준비물이
//                    빠진 PC로 그 상태를 만든다(그 조건이면 마법사가 저절로 뜬다).
const { contextBridge } = require('electron')

const S = process.env.SCENARIO || 'normal'
const now = Date.now() / 1000
// 마법사 갈래인가. 나머지 갈래는 **이미 쓰던 사람**이라 마법사를 보면 안 된다.
const WIZ = S.startsWith('wizard')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
// 마법사 갈래. 설치가 끝나기 전에는 claude 자체가 없고, 로그인 단계에서는 깔려는
// 있지만 로그인이 안 돼 있고, 회사 만들기 단계에서는 전부 갖춰져 있다.
ENV.wizard = { claude: { installed: false, loggedIn: false }, figma: { connected: false, present: false } }
ENV['wizard-installing'] = ENV['wizard-fail'] = ENV['wizard-nowinget'] = ENV.wizard
ENV['wizard-login'] = { claude: { installed: true, loggedIn: false }, figma: { connected: false, present: false } }
ENV['wizard-project'] = { claude: acctClaude, figma: { connected: true, present: true } }
// 회사는 붙었는데 준비물이 빠진 PC — 마법사가 뜬 채로 사무실에 사람이 앉아 있다.
ENV['wizard-office'] = ENV.wizard
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

// 준비물 목록. **필드도 값도 main.js의 checkRequirements가 주는 그대로다** —
// 여기서 지어내면 화면 검사는 통과하고 실물만 어긋난다(check-logic의 "IPC 응답 계약"이
// 이 목록을 main.js의 REQUIREMENTS와 한 줄씩 맞대 본다).
//
// **Node가 없는 것을 눈여겨볼 것.** 예전에는 첫 항목이었지만, 공식 설치 스크립트가
// PowerShell만 쓴다는 것이 실측으로 확인되며 REQUIREMENTS에서 빠졌다. 스텁에 남겨 두면
// 앱이 절대 주지 않는 줄을 화면 검사가 계속 그려 보게 된다.
const req = (key, label, why, installed, version, url, detail = null) => ({
  key, label, why, url,
  // 셋 다 앱이 대신 깔 수 있다(REQUIREMENTS의 세 항목 모두 auto가 있다).
  canInstall: true,
  optional: key === 'git',
  installed,
  version: installed ? version : null,
  // 왜 안 됐는지. 버전은 찍히는데 훅이 못 도는 경우가 있어서(스토어 스텁)
  // "없습니다" 한마디로는 사람이 다음 행동을 정할 수 없다.
  detail: installed ? null : detail,
})
const PY_WHY = '팀 활동을 화면에 기록하는 훅이 python으로 돕니다. 없으면 사무실이 조용합니다'
const CLAUDE_WHY = '팀원이 실제로 일하는 실행기입니다'
const GIT_WHY = '회사는 권한을 묻지 않고 파일을 고칩니다. 되돌릴 수단은 git뿐입니다'
const PY_URL = 'https://www.python.org/downloads/'
const CLAUDE_URL = 'https://docs.claude.com/en/docs/claude-code/setup'
const GIT_URL = 'https://git-scm.com/downloads'
const REQS = {
  normal: [
    req('python', 'Python', PY_WHY, true, 'Python 3.13.14', PY_URL),
    req('claude', 'Claude Code', CLAUDE_WHY, true, '2.1.220', CLAUDE_URL),
    req('git', 'Git', GIT_WHY, true, 'git 2.49.0', GIT_URL),
  ],
  missing: [
    // detail은 **실제로 나오는 문구**를 쓴다. 짧게 지어낸 것으로는 자리가 모자라는지 알 수 없다.
    req('python', 'Python', PY_WHY, false, null, PY_URL, '훅이 아무것도 기록하지 못했습니다'),
    req('claude', 'Claude Code', CLAUDE_WHY, false, null, CLAUDE_URL, '명령을 찾지 못했습니다'),
    req('git', 'Git', GIT_WHY, false, null, GIT_URL, '명령을 찾지 못했습니다'),
  ],
}
REQS.empty = REQS.nologin = REQS.stress = REQS.rundead = REQS.normal
REQS.team = REQS.teamfull = REQS.normal
for (const s of ACCT) REQS[s] = REQS.normal

// 마법사가 보는 준비물. **화면은 이 목록을 그대로 그린다.**
//
// 패키지 id·게시자·설치 범위는 **여기 없다.** 그 값들의 유일한 출처는
// `canAutoInstall().packages`다(아래 WIZ_PACKAGES). 예전에는 이 목록에도 실어 뒀는데,
// 그러다 게시자가 실제와 갈렸다(git을 'Git for Windows'로 적어 뒀는데 앱이 주는 값은
// 'The Git Development Community'다). 출처가 둘이면 반드시 갈린다.
REQS.wizard = [
  req('python', 'Python', PY_WHY, false, null, PY_URL, '명령을 찾지 못했습니다'),
  req('claude', 'Claude Code', CLAUDE_WHY, false, null, CLAUDE_URL, '명령을 찾지 못했습니다'),
  req('git', 'Git', GIT_WHY, false, null, GIT_URL, '명령을 찾지 못했습니다'),
]
REQS['wizard-installing'] = REQS['wizard-fail'] = REQS['wizard-nowinget'] = REQS.wizard
REQS['wizard-office'] = REQS.wizard
// 설치는 끝난 갈래 — 여기서 볼 것은 로그인과 회사 만들기다.
REQS['wizard-login'] = REQS['wizard-project'] = REQS.wizard.map((r) => ({
  ...r,
  installed: true,
  detail: null,
  version: { claude: '2.1.220', python: 'Python 3.13.14', git: 'git 2.49.0' }[r.key] ?? '설치됨',
}))

/**
 * 자동 설치 목록 — `env:can-auto-install`이 돌려주는 `packages` 그대로다.
 *
 * **값을 지어내면 안 된다.** 남의 컴퓨터에 무언가를 넣기 전에 화면이 보여 줄
 * id·게시자·설치 범위·받아 올 주소가 여기서 나온다. 화면은 이제 하드코딩 사전 없이
 * 이 값만 그린다 — 그래서 check-logic의 "IPC 응답 계약"이 main.js가 실제로 만들어 내는
 * packages와 이 배열을 통째로 맞대 본다(하나라도 다르면 검사가 실패한다).
 *
 * `available`은 갈래에 따라 canAutoInstall이 다시 채운다(winget이 없는 PC 갈래).
 */
const WIZ_PACKAGES = [
  {
    key: 'python',
    label: 'Python',
    why: PY_WHY,
    optional: false,
    method: 'winget',
    pkg: 'Python.Python.3.13',
    source: null,
    publisher: 'Python Software Foundation',
    scope: 'user',
    // burn 번들이라 사용자 범위로 걸어도 관리자 확인 창이 뜰 수 있다.
    needsAdmin: true,
    command:
      'winget install --id Python.Python.3.13 --exact --source winget --scope user --silent --accept-source-agreements --accept-package-agreements --disable-interactivity',
    available: true,
    url: PY_URL,
  },
  {
    key: 'claude',
    label: 'Claude Code',
    why: CLAUDE_WHY,
    optional: false,
    // 공식 설치 스크립트라 winget이 없어도 깔 수 있다 — available이 winget에 안 묶인다.
    method: 'script',
    pkg: null,
    source: 'https://claude.ai/install.ps1',
    publisher: 'Anthropic PBC',
    scope: 'user',
    needsAdmin: false,
    command: 'powershell -NoProfile -Command "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) stable"',
    available: true,
    url: CLAUDE_URL,
  },
  {
    key: 'git',
    label: 'Git',
    why: GIT_WHY,
    optional: true,
    method: 'winget',
    pkg: 'Git.MinGit',
    source: null,
    publisher: 'The Git Development Community',
    scope: 'user',
    needsAdmin: false,
    command:
      'winget install --id Git.MinGit --exact --source winget --scope user --silent --accept-source-agreements --accept-package-agreements --disable-interactivity',
    available: true,
    url: GIT_URL,
  },
]

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
// 마법사는 붙은 프로젝트가 없을 때 뜬다 — 여섯 갈래 모두 빈 상태에서 본다.
const WIZ_CASES = ['wizard', 'wizard-installing', 'wizard-fail', 'wizard-nowinget', 'wizard-login', 'wizard-project']
for (const s of WIZ_CASES) {
  PROJECTS[s] = []
  USAGE[s] = null
}
// **여기만 다르다** — 마법사가 떠 있는데 사무실이 비어 있지 않다. 붙은 회사가 있으면
// `#stage-wrap.empty`가 풀려 이름표·말풍선이 다시 그려지고, 그때 이름표가 마법사를
// 뚫는지 볼 수 있다. 다른 마법사 갈래는 회사가 0개라 그 자리를 영영 못 본다.
PROJECTS['wizard-office'] = [
  { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'busy', queued: 2,
    health: health({ git: false }), run: { script: null, running: false, url: null } },
]
USAGE['wizard-office'] = null

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
// 마법사 갈래는 아직 아무 일도 없던 컴퓨터다.
for (const s of WIZ_CASES) EVENTS[s] = []
// 다만 `wizard-office`는 사무실이 돌아가는 중이어야 한다 — 이름표뿐 아니라
// **말풍선까지** 떠야 마법사를 뚫는지 제대로 볼 수 있다.
EVENTS['wizard-office'] = EVENTS.normal

// ---------------------------------------------------------------------------
// 상단 사용량 (getUsageStats)
//
// ⚠ **여기 실리는 필드는 계약에 있는 것뿐이고, 값도 프로덕션이 낼 수 있는 것뿐이다.**
// 편의상 하나라도 더 얹으면 화면 검사만 통과하고 실물에서는 그 필드가 없어 자리가
// 비어 버린다. 이 저장소에서 이미 두 번 났다 — 스텁만 `firstRunDone`을 실어서 마법사가
// 죽은 배선 위에 서 있었고, 스텁만 `null`을 돌려줘서 "새 PC에는 상단 숫자가 안 뜬다"는
// **프로덕션에 없는 상태**를 검사가 지켜 주고 있었다(앱은 어떤 경우에도 객체를 준다).
//
// 계약: { ready, plan, today, week, days[], limitHit }
//       ready:false면 **today/week/days가 전부 null**이다 — 0이 아니라 '모른다'.
//       today/week: { input, output, cacheRead, cacheWrite, msgs }
//       days[]:     { date, output, cacheRead, msgs, partial }
//                   partial:true면 output/cacheRead/msgs가 **전부 null**이다.
//       **분모(예산·한도)는 계약에 없다.** 한때 앱이 실측 평균에서 뽑은 눈금을 예산이라
//       부르며 실어 보냈고, 화면은 그것으로 "일간 90%"를 그렸다(그 시각 Claude의 실제
//       세션은 55%였다). 지어낸 분모는 앱에도 스텁에도 두지 않는다.
//
// 그리고 갈래마다 **초기 조건이 서로 달라야 한다.** 마법사 검사 여섯 갈래가 전부
// "캐릭터 0명"이라 가림 결함이 원리적으로 발생 불가였던 전례가 있다. 아래 갈래들은
// 못 본 기록 / 안 쓴 날이 섞인 차트 / 오늘이 아직 0인 자정 직후 / 한도에 걸린 기록 /
// 아주 큰 숫자 / 통로 없음으로 갈린다.
const bucket = (input, output, cacheRead, cacheWrite, msgs) => ({ input, output, cacheRead, cacheWrite, msgs })

// main.js와 같은 값이어야 한다. 다르면 검사가 프로덕션에 없는 모양을 지켜 주게 된다.
const USAGE_SCAN_DAYS = 8 // 앱이 실제로 열어 보는 파일의 범위(mtime 기준)
const USAGE_KEEP_DAYS = 14 // 화면에 넘겨주는 날짜 수

/** 'YYYY-MM-DD' **로컬 날짜**. 프로덕션 usageDayKey와 같아야 한다 — toISOString을
 *  쓰면 한국에서 오전 9시 이전에 마지막 칸이 어제로 찍힌다. */
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * 오래된 것부터 오늘까지 14칸. `known`에는 **앱이 실제로 세는 8일치만** 넣는다.
 *
 * 앞의 6칸은 `partial: true`다 — 앱은 mtime이 8일 안쪽인 파일만 열기 때문에 그보다
 * 오래된 날은 "안 썼다(0)"가 아니라 **"모른다(null)"**이다. 0으로 채워 보내면 화면이
 * 바닥에 붙은 막대를 그리고, 그 가짜 0이 평균에 섞여 "평소의 2.4배" 같은 틀린 말을 만든다.
 */
const dayList = (known, mul) => {
  if (known.length !== USAGE_SCAN_DAYS) {
    throw new Error(`앱이 실제로 세는 날은 ${USAGE_SCAN_DAYS}일이다 (받은 것: ${known.length}일)`)
  }
  const unknown = USAGE_KEEP_DAYS - known.length
  const at = (i) => {
    const d = new Date()
    d.setHours(12, 0, 0, 0) // 정오에서 빼면 하루 경계·서머타임에 밀리지 않는다
    d.setDate(d.getDate() - (USAGE_KEEP_DAYS - 1 - i))
    return dayKey(d)
  }
  const out = []
  for (let i = 0; i < unknown; i++) {
    out.push({ date: at(i), output: null, cacheRead: null, msgs: null, partial: true })
  }
  known.forEach((output, i) => {
    out.push({
      date: at(unknown + i),
      output,
      cacheRead: Math.round(output * mul),
      msgs: output === 0 ? 0 : Math.max(1, Math.round(output / 900)),
      partial: false,
    })
  })
  return out
}

// 평범한 하루. 숫자는 실측(오늘 출력 100만, 캐시 읽기 1.36억)에서 가져온다.
// **앱이 세는 8일치만** 적는다 — 그보다 오래된 6일은 dayList가 '모른다'로 채운다.
const NORMAL_DAYS = [1_402_900, 310_700, 905_100, 1_060_400, 220_800, 1_333_000, 741_600, 1_002_962]
const normalStats = {
  ready: true,
  plan: 'max',
  today: bucket(125_825, 1_002_962, 135_800_963, 8_768_723, 1_114),
  week: bucket(701_300, 5_465_762, 742_910_400, 47_902_100, 6_082),
  days: dayList(NORMAL_DAYS, 135),
  limitHit: null,
}

/**
 * **첫 집계가 끝나기 전.** 앱은 이때도 객체를 준다 — `ready:false`로 "아직 모른다"고
 * 말할 뿐이다(상단 숫자가 사라지지는 않는다. 사라지는 것은 통로가 없을 때뿐이고, 그건
 * `usage-none`이 본다). 앱을 막 켠 몇 초, 그리고 한도 리셋 뒤 다시 세는 동안이 이 상태다.
 */
const notCountedStats = {
  ready: false,
  plan: null,
  today: null,
  week: null,
  days: null,
  limitHit: null,
}

/**
 * **한 번도 안 돌린 컴퓨터.** 여기가 예전에 스텁이 `null`을 지어내던 자리다 —
 * "상단 숫자가 안 뜬다"고 했지만 실제로는 뜬다. 앱은 기록이 하나도 없어도 집계를 마치고
 * `ready:true`를 준다. 그래서 새 PC가 진짜로 보는 화면은 **'오늘 출력 0' + 아는 8일은 0,
 * 나머지 6일은 빈칸인 차트**다.
 */
const freshStats = {
  ready: true,
  plan: null,
  today: bucket(0, 0, 0, 0, 0),
  week: bucket(0, 0, 0, 0, 0),
  days: dayList([0, 0, 0, 0, 0, 0, 0, 0], 0),
  limitHit: null,
}

const USAGE_STATS = {
  normal: normalStats,
  stress: normalStats,
  nologin: normalStats,
  rundead: normalStats,
  team: normalStats,
  teamfull: normalStats,
  acct: normalStats,
  acctlong: normalStats,
  acctout: normalStats,
  acctfigma: normalStats,
  acctbusy: normalStats,
  // 붙인 프로젝트도 준비물도 없는 컴퓨터 = 쓴 기록이 없는 컴퓨터.
  empty: freshStats,
  missing: freshStats,
}

// 1) 기록을 못 봤다. **자리는 잡되 숫자는 없다** — 0으로 그리면 "안 썼다"가 된다.
USAGE_STATS['usage-pending'] = notCountedStats
// 2) **안 쓴 날(0)과 못 본 날(null)이 한 차트에 섞인 상태.** 둘을 같게 그리면
//    "6일 내리 안 썼다"는 거짓 그림이 되고, 가짜 0이 평균에 섞여 배수도 틀려진다.
USAGE_STATS['usage-partial'] = {
  ready: true,
  plan: 'max',
  today: bucket(112_400, 902_100, 121_800_400, 7_902_100, 1_002),
  week: bucket(402_800, 2_562_700, 344_200_900, 22_400_500, 2_848),
  days: dayList([0, 0, 1_020_400, 0, 0, 640_200, 0, 902_100], 134),
  limitHit: null,
}
// 3) **자정 직후.** 지난 날 기록은 있는데 오늘은 아직 전부 0이다(매일 실제로 지나가는
//    상태다). 캐시 읽기를 출력으로 나눌 수 없는 유일한 갈래라, 화면이 배수를 지어내거나
//    0으로 나눈 Infinity를 적으면 여기서 잡힌다. 플랜도 없다(로그인 정보를 못 읽은 PC).
USAGE_STATS['usage-newday'] = {
  ready: true,
  plan: null,
  today: bucket(0, 0, 0, 0, 0),
  week: bucket(588_100, 4_462_800, 602_110_300, 39_002_400, 4_968),
  days: dayList([1_402_900, 310_700, 905_100, 1_060_400, 220_800, 1_333_000, 741_600, 0], 135),
  limitHit: null,
}
// 4) 한도에 걸렸던 기록이 있는 상태. 리셋 시각이 화면에 나와야 한다.
USAGE_STATS['usage-limit'] = {
  ready: true,
  plan: 'max',
  today: bucket(98_200, 1_240_800, 168_400_500, 10_204_000, 1_388),
  week: bucket(612_400, 8_902_300, 1_180_400_000, 71_002_000, 9_774),
  days: dayList([1_302_000, 1_188_000, 640_000, 1_500_400, 1_010_000, 1_260_000, 998_000, 1_240_800], 136),
  limitHit: {
    at: new Date(Date.now() - 96 * 60_000).toISOString(),
    resetAt: new Date(Date.now() + 86 * 60_000).toISOString(),
  },
}
// 5) 아주 큰 숫자. `cacheRead: 2165974000`은 실측값이다 — 자리수 때문에 레이아웃이
//    가장 먼저 무너지는 자리다(응답 건수도 4만 건대라 한 줄이 길어진다).
USAGE_STATS['usage-huge'] = {
  ready: true,
  plan: 'max',
  today: bucket(1_882_004, 4_212_337, 2_165_974_000, 61_300_912, 41_882),
  week: bucket(9_440_118, 22_004_551, 11_820_663_004, 318_772_400, 214_663),
  days: dayList([4_004_000, 3_880_200, 2_220_000, 4_512_000, 3_090_400, 2_808_000, 4_102_600, 4_212_337], 514),
  limitHit: null,
}
// 6) `usage-none`은 값이 아니라 **통로가 없는** 갈래다(설치본을 덮어쓰다 만 PC —
//    preload가 화면보다 낡다). 상단 숫자가 숨는 경로는 이것뿐이라, 값을 두지 않고
//    파일 끝에서 api.getUsageStats 자체를 지운다.

/** 사용량 갈래. 화면의 **나머지는 `normal`과 같게** 둔다 — 여러 가지가 같이 달라지면
 *  무엇 때문에 깨졌는지 알 수 없다. */
const USAGE_CASES = ['usage-pending', 'usage-partial', 'usage-newday', 'usage-limit', 'usage-huge', 'usage-none']
for (const s of USAGE_CASES) {
  ENV[s] = okEnv
  REQS[s] = REQS.normal
  PROJECTS[s] = PROJECTS.normal
  EVENTS[s] = EVENTS.normal
  USAGE[s] = realUsage
}

// ---------------------------------------------------------------------------
// 지금 대화의 무게 (getSessionCost) · 새 대화로 갈아타기 (startNewSession)
//
// ⚠ **여기 실리는 필드도 계약에 있는 것뿐이다**(main.js `sessionCostFrom`의 반환 그대로):
//     { turns, firstRead, lastRead, growth, heavy, sizeBytes } | null
//   `firstRead`는 첫 턴이 0일 때 **0이 아니라 null**이고, 그러면 `growth`도 null이다
//   (0으로 나눌 수 없다). 값이 통째로 null인 것은 **기록이 하나도 없을 때**다 —
//   갈아탄 직후가 실제로 그 상태다. 여기서 0을 지어내면 "안 썼다"는 거짓이 된다.
//
//   heavy도 지어내지 않는다. main.js의 기준(lastRead ≥ 0.2M 또는 growth ≥ 10)으로
//   계산해 둔 값이고, ui-audit.js가 그 상수를 main.js에서 떼어 와 다시 맞대 본다.
//
// 갈래마다 **초기 조건이 서로 다르다**(마법사 여섯 갈래가 전부 캐릭터 0명이라 가림
// 결함을 못 잡던 전례가 있다):
//   session-heavy    실측 그대로 무거운 대화 + 놀고 있는 회사 → 갈아타기가 성공한다
//   session-light    가벼운 대화 + **지시가 도는 회사** → 앱이 거절한다(이유가 보이는지)
//   session-none     기록이 하나도 없다(값이 null) → 0으로 그리면 잡힌다
//   session-nogrowth 첫 턴에 다시 읽은 것이 없어 배수를 낼 수 없다 → NaN·Infinity가 뜨는지
const SESSION_HEAVY = { turns: 198, firstRead: 20_400, lastRead: 291_600, growth: 14.3, heavy: true, sizeBytes: 2_411_008 }
const SESSION_LIGHT = { turns: 12, firstRead: 21_200, lastRead: 46_600, growth: 2.2, heavy: false, sizeBytes: 184_320 }

const SESSION_COST = {
  normal: SESSION_LIGHT,
  stress: SESSION_HEAVY,
  nologin: SESSION_LIGHT,
  rundead: SESSION_LIGHT,
  team: SESSION_LIGHT,
  teamfull: SESSION_LIGHT,
  // 붙인 프로젝트도 없는 컴퓨터에는 오간 대화가 없다.
  empty: null,
  missing: null,
  // 실측 그대로(insta-filter 198턴 · 0.02M → 0.29M).
  'session-heavy': SESSION_HEAVY,
  // 실측(shop을 막 시작했을 때). 갈아탈 이유가 없는 대화에서 화면이 조용한지 본다.
  'session-light': { turns: 6, firstRead: 18_900, lastRead: 24_800, growth: 1.3, heavy: false, sizeBytes: 61_440 },
  'session-none': null,
  'session-nogrowth': { turns: 2, firstRead: null, lastRead: 18_400, growth: null, heavy: false, sizeBytes: 38_912 },
}
for (const s of ACCT) SESSION_COST[s] = SESSION_LIGHT
for (const s of WIZ_CASES) SESSION_COST[s] = null
SESSION_COST['wizard-office'] = null
// 사용량 갈래에서도 이 줄이 같이 그려진다 — **퍼센트 금지 검사가 새 문구까지 본다.**
// 무게는 사용량 집계와 다른 곳에서 나오므로 갈래마다 따로 정한다.
SESSION_COST['usage-pending'] = null // 아직 아무것도 세지 못한 상태
SESSION_COST['usage-partial'] = SESSION_LIGHT
SESSION_COST['usage-newday'] = SESSION_HEAVY // 어제부터 이어 온 대화는 자정을 넘어도 무겁다
SESSION_COST['usage-limit'] = SESSION_HEAVY // 한도에 걸릴 만큼 쓴 사람의 대화
SESSION_COST['usage-huge'] = { turns: 812, firstRead: 24_800, lastRead: 402_900, growth: 16.2, heavy: true, sizeBytes: 41_226_240 }
SESSION_COST['usage-none'] = null

/** 새 대화 갈래. 사용량 화면을 펴야 보이므로 **나머지는 사용량 갈래와 같게** 둔다. */
const SESSION_CASES = ['session-heavy', 'session-light', 'session-none', 'session-nogrowth']
for (const s of SESSION_CASES) {
  ENV[s] = okEnv
  REQS[s] = REQS.normal
  EVENTS[s] = EVENTS.normal
  USAGE[s] = realUsage
  USAGE_STATS[s] = normalStats
  // 사무실에 사람이 있는 채로 확인 창을 띄운다 — 이름표가 창을 뚫는지 볼 수 있다.
  PROJECTS[s] = PROJECTS.team
}
// **거절 갈래만 회사가 돌고 있다.** 앱은 실행 중이면 갈아타지 않고 이유를 준다
// (main.js startNewSession). 스텁이 그 조건을 지어내지 않게, 아래 startNewSession은
// 이 프로젝트 목록의 상태를 그대로 보고 판단한다.
PROJECTS['session-light'] = PROJECTS.teamfull

// ---------------------------------------------------------------------------
// 한도 홀드 (`projects[].hold`)
//
// 한도로 실패하면 앱이 **그 회사의 큐를 리셋 시각까지 붙잡아 둔다.** 그 전에는 걸린
// 뒤에도 대기 지시를 하나씩 집어 전부 실패시켰다.
//
// ⚠ **여기 실리는 필드는 계약에 있는 것뿐이다** — `until`과 `reason` 둘뿐이고, 화면이
//   읽기 편하라고 '남은 분'·'멈춤 여부' 같은 편의 필드를 얹지 않는다. 그런 필드를 스텁만
//   싣는 순간 화면 검사는 통과하고 실물에서는 그 자리가 비어 버린다(이 저장소가 두 번
//   당한 사고다). 남은 시간은 **화면이 `until`에서 낸다.**
//
//   hold-active  붙잡힌 회사 + 대기 지시 2건 — 왜 안 도는지·언제 다시 도는지·대기 지시가
//                취소된 게 아니라는 것이 화면에 있는가. `reason`은 앱이 실제로 붙이는 말
//                그대로다(main.js FAILURE_KINDS의 '토큰 사용량 한도').
//   hold-none    붙잡히지 않은 회사 + 대기 지시 1건 — **아무것도 뜨지 않아야 한다.**
//                대기 지시가 있는 것과 붙잡힌 것은 다른 상태다(대기만 보고 안내를 띄우면
//                평소에도 계속 떠 있게 된다).
const HOLD_REASON = '토큰 사용량 한도'
const HOLD_UNTIL = new Date(Date.now() + 170 * 60_000).toISOString()

PROJECTS['hold-active'] = [
  { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'open', queued: 2,
    health: health({ agents: 11 }), run: { script: null, running: false, url: null },
    hold: { until: HOLD_UNTIL, reason: HOLD_REASON } },
  // 다른 회사는 멀쩡하다 — 안내가 **붙잡힌 회사에만** 붙는지 보려면 옆에 성한 회사가 있어야 한다.
  { dir: 'C:\\dev\\2026\\board', exists: true, company: 'busy', queued: 1,
    health: health({ agents: 11 }), run: { script: null, running: false, url: null }, hold: null },
]
PROJECTS['hold-none'] = [
  { dir: 'C:\\dev\\2026\\shop', exists: true, company: 'open', queued: 1,
    health: health({ agents: 11 }), run: { script: null, running: false, url: null }, hold: null },
]
/** 홀드 갈래. 나머지는 `normal`과 같게 둔다 — 여러 가지가 같이 달라지면 무엇 때문에
 *  깨졌는지 알 수 없다. */
const HOLD_CASES = ['hold-active', 'hold-none']
for (const s of HOLD_CASES) {
  ENV[s] = okEnv
  REQS[s] = REQS.normal
  EVENTS[s] = EVENTS.normal
  USAGE[s] = realUsage
  USAGE_STATS[s] = normalStats
  SESSION_COST[s] = SESSION_LIGHT
}

// 사용자가 예산을 바꾸면 **다음에 물어볼 때 답이 달라져야 한다.** 늘 같은 답을 주면
// "저장했다는데 화면은 그대로"를 검사가 볼 수 없다.
// 갈래에 따로 적지 않았으면 **기록을 아직 못 본 상태**다. `null`로 두면 안 된다 —
// 앱은 어떤 경우에도 객체를 준다(마법사 갈래처럼 아무것도 없는 새 PC도 마찬가지다).
let usageStats = USAGE_STATS[S] ?? notCountedStats

// 지금 대화의 무게. **갈아타면 이 값이 null이 된다** — 앱도 그렇다(새 세션에는 기록이
// 아직 없다). 늘 같은 답을 주면 "갈아탔다는데 화면은 옛 무게 그대로"를 검사가 볼 수 없다.
let sessionCost = SESSION_COST[S] ?? null
// 앱이 갈아타기를 거절하는 조건은 하나뿐이다 — **활성 프로젝트가 돌고 있을 때**
// (main.js `startNewSession`의 `companyBusy(dir)`). 스텁이 조건을 지어내지 않게
// 프로젝트 목록에 적힌 상태를 그대로 본다.
const sessionBusy = (PROJECTS[S] ?? [])[0]?.company === 'busy'
// 검사가 "무엇을 들려 보냈는지" 되짚기 위한 기록. **`teamView`에는 손대지 않는다** —
// 앱의 계약에 편의 필드를 하나라도 얹으면 검사만 통과하고 실물에서 그 자리가 비는
// 사고가 난다(이 저장소에서 두 번 났다). 그래서 이름이 다른 별도 창구로 낸다.
// **렌더러는 이것을 쓰면 안 된다** — tools/ui-audit.js가 renderer/*.js에 이 이름이
// 나오면 실패로 잡는다(검사에만 있는 통로 위에 화면이 서는 것을 막는다).
const newSessionCalls = []

const noop = () => {}
let installCb = null // 설치 진행 소식을 받는 쪽(마법사)
const wizInstalled = new Set() // 이 실행에서 실제로 깔린 것(확인까지 끝난 것만)
const api = {
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
  // 설치가 끝나면 **다음에 물어볼 때 답이 달라져야 한다.** 늘 같은 답을 주면
  // 화면이 "깔았다는데 아직 없다"를 계속 그리게 되어 성공 경로를 볼 수 없다.
  checkRequirements: async () =>
    REQS[S].map((r) => (wizInstalled.has(r.key) ? { ...r, installed: true, version: '설치됨', detail: null } : r)),
  // 팀원 관리. 검사에서는 **읽기만** 한다 — 쓰기 통로는 눌렀을 때 화면이 어떻게
  // 되는지 보려고 붙여 두지만, 실제로 파일을 만들지는 않는다.
  listTeam: async () => TEAM[S] ?? { ok: false, error: '이 갈래에는 명단이 없습니다' },
  hireAgent: async (_dir, id) => ({ ok: true, id, from: 'template', path: `C:\\dev\\2026\\shop\\.claude\\agents\\${id}.md` }),
  createAgent: async (_dir, spec) => ({ ok: false, code: 'VALIDATION', error: `${spec?.id}은(는) 이미 팀에 있습니다` }),
  fireAgent: async (_dir, id) => ({ ok: true, id, movedTo: `C:\\dev\\2026\\shop\\.claude\\team-fired\\${id}.md`, requeued: 1 }),
  install: async () => ({ ok: false, canceled: true }),
  // 상단 사용량. **계약에 있는 필드만** 실려 나간다(위 USAGE_STATS 참고).
  // **쓰기 통로는 없다.** 예전에는 `setUsageBudget`으로 분모를 정하게 했는데, 그 분모가
  // 애초에 한도가 아니었다. 앱이 모르는 것을 사용자에게 정하게 하고 그 결과를 퍼센트로
  // 그린 것이라 통로째로 걷어냈다(main.js에도 없다).
  getUsageStats: async () => usageStats,
  // 지금 대화의 무게. **계약에 있는 필드만** 실려 나간다(위 SESSION_COST 참고).
  getSessionCost: async () => sessionCost,
  // 새 대화로 갈아타기. 앱이 주는 답 그대로 — 성공하면 { ok: true, id }, 실행 중이면
  // { ok: false, reason: '실행 중입니다' }(문구도 main.js가 쓰는 그대로여야 한다).
  startNewSession: async (opts) => {
    newSessionCalls.push(opts)
    if (sessionBusy) return { ok: false, reason: '실행 중입니다' }
    // 갈아탄 직후에는 기록이 없다 — 앱의 sessionCost도 여기서 null을 준다.
    sessionCost = null
    return { ok: true, id: '9f1c2a54-0000-4000-8000-0000000000aa' }
  },
  // 로그인은 브라우저에서 사람이 마쳐야 끝난다. **끝나지 않는 갈래**가 있어야
  // "기다리는 중…"이 화면에서 어떻게 보이는지 잴 수 있다.
  login: async () => {
    if (S === 'wizard-login') await sleep(30_000)
    return { ok: false, timeout: true, env: ENV[S] }
  },
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
  // ── 첫 실행 설치 마법사 ──────────────────────────────────────────────
  // 백엔드가 만드는 통로. 화면 검사에서는 **각 갈래가 보려는 상태**만 만들어 준다.
  canAutoInstall: async () => {
    const winget = S !== 'wizard-nowinget'
    return {
      winget,
      version: winget ? '1.11.400' : null,
      // winget이 필요한 항목만 winget에 묶인다. claude는 공식 스크립트라 winget이
      // 막힌 회사 PC에서도 앱이 깔아 줄 수 있다 — 화면이 그 둘을 가르는지 보는 값이다.
      packages: WIZ_PACKAGES.map((p) => ({ ...p, available: p.method !== 'winget' || winget })),
    }
  },
  autoInstall: async (key) => {
    const at = Date.now()
    const emit = (phase) => installCb?.({ key, phase, elapsedMs: Date.now() - at })
    emit('download')
    await sleep(120)
    emit('install')
    // 설치가 도는 화면을 보려면 **끝나지 않아야 한다.** winget은 실제로 2~5분 동안
    // 아무 말이 없다 — 그 시간을 화면이 어떻게 버티는지가 이 갈래에서 볼 것이다.
    if (S === 'wizard-installing') {
      await sleep(30_000)
      return { ok: false, verified: false, error: '시간이 너무 오래 걸립니다' }
    }
    // **ok는 true인데 verified는 false.** winget이 0으로 끝났지만 실제로는 실행되지
    // 않는 경우다. 화면이 이걸 완료로 그리면 가짜 완료가 된다.
    if (S === 'wizard-fail') {
      return { ok: true, verified: false, version: null, error: 'winget은 0으로 끝났지만 실제로 실행되지 않았습니다' }
    }
    await sleep(80)
    emit('verify')
    // **확인까지 끝난 것만** 깔린 것으로 친다(verified가 곧 근거다).
    wizInstalled.add(key)
    return { ok: true, verified: true, version: '설치됨' }
  },
  onInstallProgress: (cb) => {
    installCb = cb
  },
  refreshPath: async () => ({ ok: true, changed: false }),
  relaunch: () => {},
  createProject: async (name) => ({
    ok: true,
    dir: `C:\\Users\\사용자\\Documents\\윤사무실\\${name}`,
    done: ['직원 9명이 출근했습니다', '활동 기록기를 달았습니다', '되돌릴 지점을 만들었습니다'],
  }),
  wizardDone: async () => ({ ok: true }),
  onEnv: noop,
  onRunFailed: noop,
  onCommandFailed: noop,
  onReset: noop,
  onEvents: (cb) => setTimeout(() => cb({ dir: PROJECTS[S][0]?.dir ?? null, events: EVENTS[S] }), 300),
  // ⚠ 여기 실리는 **필드 집합은 지어낼 수 없다.** `tools/check-logic.js`의
  // "상태 payload 계약"이 main.js `pumpStatusAll`의 payload와 하나씩 맞대 본다.
  // 한때 이 스텁만 `firstRunDone`을 실어서, 화면 검사는 통과하는데 실물에서는
  // 그 값이 렌더러에 영원히 도달하지 않았다(마법사가 죽은 배선 위에 서 있었다).
  // 새 필드를 여기 넣고 싶으면 **프로덕션에 먼저 넣어라.**
  onStatus: (cb) =>
    setTimeout(() => cb({
      projects: PROJECTS[S],
      activeDir: PROJECTS[S][0]?.dir ?? null,
      max: 3,
      chatWidth: S === 'stress' ? 520 : null,
      usage: USAGE[S],
      // 명단은 활성 프로젝트 것만 실린다. 화면은 이걸로 자리를 잡는다.
      team: teamOf(S),
      // **하위 호환의 핵심.** 마법사 갈래가 아니면 이미 첫 실행을 마친 사람이다 —
      // 프로그램이 없든 프로젝트가 없든 마법사가 떠서는 안 된다.
      firstRunDone: !WIZ,
    }), 150),
}

// **통로가 없는 앱**을 흉내 낸다(`OLD_BRIDGE=1`). 설치 통로는 백엔드가 지금 만들고
// 있어서, 설치본을 덮어쓰다 만 경우처럼 preload가 화면보다 낡을 수 있다. 그때
// 화면이 죽지 않고 "직접 받아 설치하는 길"로 빠지는지 눌러서 확인하려면 없는
// 상태를 만들 수 있어야 한다.
if (process.env.OLD_BRIDGE) {
  for (const k of ['canAutoInstall', 'autoInstall', 'onInstallProgress', 'refreshPath', 'relaunch', 'createProject', 'wizardDone', 'getUsageStats', 'getSessionCost', 'startNewSession']) {
    delete api[k]
  }
}

// 사용량 통로만 없는 갈래. **상단 숫자가 숨는 실제 경로는 이것뿐이다** — 앱의
// getUsageStats는 기록을 하나도 못 봐도 객체를 돌려주므로(ready:false), '값이 null'인
// 상태는 프로덕션에 없다. 그 자리를 스텁이 지어내면 "새 PC에는 사용량이 안 뜬다"는
// 도달 불가능한 동작을 검사가 지켜 주게 된다(실제로 그렇게 되어 있었다).
if (S === 'usage-none') delete api.getUsageStats

contextBridge.exposeInMainWorld('teamView', api)

// **검사 전용 창구.** 앱의 계약(`teamView`)과 섞이지 않게 이름부터 다르게 둔다.
// 여기 있는 것은 "무엇을 들려 보냈는가"의 기록뿐이고, 값은 문자열로만 나간다
// (구조를 그대로 넘기면 검사가 스텁 안의 객체를 붙잡고 있게 된다).
contextBridge.exposeInMainWorld('__uiStubSpy', {
  newSessionCalls: () => newSessionCalls.map((c) => JSON.stringify(c ?? null)),
})
