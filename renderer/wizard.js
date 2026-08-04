// 첫 실행 설치 마법사 — **비개발자가 setup.exe 하나로 첫 지시까지 가는 길.**
//
// 지금까지 필요한 것들은 배너로 흩어져 있었다: 설치 안내(#need)·실행 환경(#env)·
// 첫 화면 안내(#welcome). 개발자에게는 충분하지만, 처음 쓰는 사람은 첫 화면에서
// "Node.js를 설치하세요"를 보면 거기서 멈춘다. 무엇을 어디서 받아 어떻게 까는지,
// 깔고 나면 무엇을 해야 하는지가 화면에 없기 때문이다.
//
// 그래서 **한 창 안에서 순서대로** 끝내게 한다. 다만 기존 길을 없애지는 않는다 —
// 마법사를 건너뛴 사람과 이미 쓰던 사람은 그대로 배너를 쓴다. 마법사가 떠 있는
// 동안만 그것들이 자리를 비운다(지우지 않는다).
//
// 여기서 지키는 것 셋:
//   · **가짜를 만들지 않는다.** 설치는 `verified: true`일 때만 완료로 그린다.
//     `ok: true`인데 `verified: false`면 실패다 — 직전에 "Figma가 연결됐습니다"를
//     잘못 띄운 버그가 같은 계열이었다(근거가 갈리면 화면이 거짓말을 한다).
//   · **값은 textContent로만.** 경로·패키지 id·오류 문구는 전부 남의 글자다.
//   · **여닫기는 `hidden`으로만.** display로 덮으면 [hidden]이 지고,
//     "감췄는데 계속 보인다"가 된다(check-ui의 '숨김 실패').

// ---------------------------------------------------------------------------
// 통로
//
// 마법사가 쓰는 통로 중 여럿은 백엔드가 지금 만들고 있다. **없어도 화면이 죽지
// 않아야 한다** — 통로 하나가 없어서 모듈 평가가 멈추면 화면이 통째로 까매진다
// (실제로 preload에 함수를 늦게 추가했다가 그렇게 됐다).

async function call(name, ...args) {
  const fn = window.teamView?.[name]
  if (typeof fn !== 'function') {
    return { ok: false, missing: true, error: '이 기능은 앱을 다시 켠 뒤에 쓸 수 있습니다 (연결 통로가 없습니다)' }
  }
  try {
    return (await fn(...args)) ?? { ok: false, error: '응답이 없습니다' }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

function listen(name, cb) {
  const fn = window.teamView?.[name]
  if (typeof fn !== 'function') return
  try {
    fn(cb)
  } catch {
    // 통로가 있어도 붙이다 실패할 수 있다. 그 소식만 못 받을 뿐 화면은 살아 있어야 한다.
  }
}

// 마쳤다는 표시. 백엔드가 상태에 실어 주면 그것이 우선이고, 아직 안 줄 때를 위해
// 렌더러도 한 벌 남긴다 — 둘 중 하나라도 "마쳤다"면 다시 띄우지 않는다.
const DONE_KEY = 'teamview.firstRunDone'

function localDone() {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return false // 저장을 못 하는 환경이면 이 세션 동안만 기억한다
  }
}

function markLocalDone() {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    // 저장 못 해도 진행은 막지 않는다. 백엔드의 wizardDone이 진짜 기록이다.
  }
}

// ---------------------------------------------------------------------------
// 화면에 쓰는 말
//
// 개발 용어를 그대로 두면 "Node.js"가 무엇인지부터 막힌다. 아는 키에만 쉬운 이름을
// 덧붙이고, **목록 자체는 앱이 주는 것을 그대로 그린다** — 백엔드가 Step 0 실측으로
// 항목을 줄이거나 늘려도 화면이 따라가야 하기 때문이다.
const FRIENDLY = {
  claude: '팀원을 실행하는 프로그램',
  node: '그 프로그램이 필요로 하는 것',
  python: '팀 활동을 화면에 그리는 기록기',
  git: '실수를 되돌리는 장치',
}

// 설치 범위. 백엔드는 코드값(`user`/`machine`)으로 주므로 그대로 화면에 쓸 수 없다.
// **번역만 한다** — 모르는 값이 오면 지어내지 않고 아무 말도 하지 않는다.
const SCOPE_TEXT = {
  user: '내 계정에만 설치',
  machine: '이 컴퓨터 전체에 설치',
}

const PHASE_TEXT = {
  download: '내려받는 중',
  install: '설치 중',
  verify: '확인 중',
}

const STEPS = [
  { n: 1, label: '준비물 확인' },
  { n: 2, label: '프로그램 설치' },
  { n: 3, label: 'Claude 로그인' },
  { n: 4, label: 'Figma 연결', note: '건너뛸 수 있어요' },
  { n: 5, label: '첫 회사 만들기' },
  { n: 6, label: '완료' },
]

const MARK = { done: '✔', now: '●', wait: '○', skip: '–' }
const MARK_TEXT = { done: '끝', now: '진행 중', wait: '대기', skip: '건너뜀' }

// 마법사가 쓰는 요소들. 없으면(옛 index.html) 마법사를 아예 켜지 않는다.
const el = (id) => document.getElementById(id)
const root = el('wizard')

// ---------------------------------------------------------------------------
// 상태
//
// 단계는 여섯 개다. 라우터도 상태관리 라이브러리도 만들지 않는다 — 지금 어느
// 화면이고 각 단계가 어떤 상태인지, 그 둘이면 충분하다.

const WELCOME = 0
const CHECK = 1
const INSTALL = 2
const LOGIN = 3
const FIGMA = 4
const PROJECT = 5
const DONE = 6

let host = {} // app.js가 준 바깥 연결(진입점)
let open = false
let step = WELCOME
let state = ['wait', 'wait', 'wait', 'wait', 'wait', 'wait'] // 1~6단계
let reqs = [] // 마지막으로 읽은 준비물 목록
let env = null
let queue = [] // 아직 설치하지 않은 항목
let installing = false
// 큐를 만지는 일이 도는 중인가. **한 번에 하나만** — 재시도·건너뛰기·다시 확인이
// 겹치면 `queue.shift()`가 두 번 돌아 안 깐 항목이 조용히 빠진다(실제로 났다).
let busy = false
let autoInfo = null // env:can-auto-install 응답 그대로
// 그 응답의 `packages`를 key로 색인한 것. **동의 화면이 보여 줄 값의 원본이다** —
// 화면에는 여기 있는 것만 적는다(없으면 없다고 적지, 지어내지 않는다).
const pkgByKey = new Map()
let waitingLogin = '' // 'claude' | 'figma' — 창을 띄우고 기다리는 중
let waitStartedAt = 0
let ticker = null
let openedOnce = false
let backendDone = null // 백엔드가 알려 준 firstRunDone
let projectCount = null // 붙어 있는 프로젝트 수(상태가 오면 채워진다)
let sawStatus = false

// 항목별 설치 진행. key -> { state, phase, elapsedMs, at }
const progress = new Map()

export function wizardIsOpen() {
  return open
}

// ---------------------------------------------------------------------------
// 열기·닫기

export function openWizard() {
  if (!root || open) return
  open = true
  // 한 번 열었으면 그것으로 됐다. 닫은 뒤 상태가 또 와도 다시 밀어붙이지 않는다.
  openedOnce = true
  root.hidden = false
  host.onToggle?.()
  if (!ticker) ticker = setInterval(tick, 1000)
  go(step === DONE ? DONE : step)
  focusFirst()
}

/**
 * 닫는다. **마쳤을 때만 '마쳤다'고 기록한다** — [나중에 하기]로 닫은 것은
 * 마친 것이 아니라서, 다음에 켤 때 다시 물어보는 편이 맞다.
 */
function closeWizard(finished) {
  if (!open) return
  open = false
  root.hidden = true
  el('wz-leave').hidden = true
  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
  waitingLogin = ''
  if (finished) {
    markLocalDone()
    call('wizardDone')
  }
  host.onToggle?.()
  host.onClosed?.(finished === true)
}

/**
 * 닫으려 한다. **설치가 도는 중이면 그 자리에서 닫지 않는다.**
 *
 * winget은 창을 닫아도 백그라운드에서 계속 돈다. 예고 없이 창만 사라지면 사람은
 * 취소된 줄 알고 다시 깔려 하고, 같은 패키지에 설치가 두 개 뜬다. 그렇다고 닫기를
 * 아예 막지도 않는다 — 마법사가 앱을 인질로 잡으면 안 된다. **사실을 적고 고르게 한다.**
 */
function requestClose() {
  if (!installing) {
    closeWizard(false)
    return
  }
  const box = el('wz-leave')
  box.hidden = false
  el('wz-leave-stay').focus()
}

/** [계속 지켜보기] — 물음만 걷고 하던 화면으로 돌아간다. */
function cancelClose() {
  const box = el('wz-leave')
  if (box.hidden) return false
  box.hidden = true
  focusFirst()
  return true
}

/** 지금 화면에서 가장 먼저 누를 것으로 초점을 옮긴다(키보드만 쓰는 사람의 시작점). */
function focusFirst() {
  const pane = paneEl(step)
  const first = pane?.querySelector('.wz-primary:not([hidden]), button:not([hidden]), input')
  ;(first ?? el('wz-close'))?.focus()
}

// ---------------------------------------------------------------------------
// 단계 이동

function paneEl(i) {
  const names = ['welcome', 'check', null, 'login', 'figma', 'project', 'done']
  // 2단계는 화면이 둘이다(동의 → 진행). 어느 쪽을 보여 줄지는 그때 정한다.
  const name = i === INSTALL ? (installing || progress.size ? 'install' : 'consent') : names[i]
  return root.querySelector(`.wz-pane[data-pane="${name}"]`)
}

function showPane(name) {
  for (const p of root.querySelectorAll('.wz-pane')) p.hidden = p.dataset.pane !== name
}

function go(i) {
  step = i
  if (i > WELCOME) state[i - 1] = state[i - 1] === 'done' || state[i - 1] === 'skip' ? state[i - 1] : 'now'
  renderSteps()
  if (i === WELCOME) {
    showPane('welcome')
    return
  }
  if (i === CHECK) return enterCheck()
  if (i === INSTALL) return enterInstall()
  if (i === LOGIN) return enterLogin()
  if (i === FIGMA) return enterFigma()
  if (i === PROJECT) return enterProject()
  return enterDone()
}

/** 단계를 마쳤다고 적고 다음으로. */
function finishStep(i, how = 'done') {
  state[i - 1] = how
  go(i + 1)
}

// ---------------------------------------------------------------------------
// 왼쪽 단계 목록 — "지금 어디까지 됐는지"가 항상 보여야 한다

function renderSteps() {
  const list = el('wz-steps')
  if (!list) return
  list.replaceChildren()
  for (const s of STEPS) {
    const st = state[s.n - 1]
    const li = document.createElement('li')
    li.className = `wz-step ${st}`
    if (step === s.n) li.setAttribute('aria-current', 'step')

    const num = document.createElement('span')
    num.className = 'wz-num'
    num.textContent = String(s.n)

    const mk = document.createElement('span')
    mk.className = 'wz-mk'
    mk.setAttribute('aria-hidden', 'true')
    mk.textContent = MARK[st]

    const nm = document.createElement('span')
    nm.className = 'wz-nm'
    nm.textContent = s.label

    const hint = document.createElement('span')
    hint.className = 'wz-hint'
    // 화면 표시는 기호지만 읽어 주는 쪽에는 말로 적는다.
    hint.textContent = stepHint(s) || MARK_TEXT[st]
    if (s.note && st === 'wait') hint.textContent = `대기 (${s.note})`

    li.append(num, mk, nm, hint)
    list.append(li)
  }
}

/** 그 단계의 한 줄 요약. 설치 단계는 항목마다 어디까지 됐는지 적는다. */
function stepHint(s) {
  if (s.n !== INSTALL || !progress.size) return ''
  const parts = []
  for (const r of reqs) {
    const p = progress.get(r.key)
    if (!p) continue
    parts.push(`${shortName(r)} ${p.state === 'done' ? '완료' : p.state === 'fail' ? '실패' : p.state === 'run' ? PHASE_TEXT[p.phase] ?? '설치 중' : '대기'}`)
  }
  return parts.join(' · ')
}

/** 목록에 쓰는 짧은 이름. 앱이 준 이름을 그대로 쓴다. */
function shortName(r) {
  return r.label || r.key
}

/** 사람이 읽는 이름. 아는 항목이면 쉬운 말을 앞에 둔다. */
function fullName(r) {
  const easy = FRIENDLY[r.key]
  return easy ? `${easy} (${shortName(r)})` : shortName(r)
}

// ---------------------------------------------------------------------------
// 1단계 · 준비물 확인
//
// **목록을 하드코딩하지 않는다.** 백엔드가 실측으로 항목을 줄이거나 늘려도
// (예: claude 네이티브 빌드가 있으면 Node가 빠진다) 화면이 그대로 따라가야 한다.

async function loadReqs() {
  // 백엔드가 env에 준비물을 실어 주면 그것을 쓰고, 아니면 기존 통로로 묻는다.
  if (Array.isArray(env?.requirements)) return env.requirements
  const res = await call('checkRequirements')
  return Array.isArray(res) ? res : []
}

async function enterCheck() {
  showPane('check')
  const stateEl = el('wz-check-state')
  stateEl.textContent = '확인하는 중…'
  el('wz-check-next').hidden = true
  el('wz-check-again').hidden = true
  reqs = await loadReqs()
  renderCheckList()
  const missing = missingItems()
  const required = missing.filter((r) => !r.optional)
  stateEl.textContent = !reqs.length
    ? '무엇이 필요한지 확인하지 못했습니다 — 다시 확인해 주세요.'
    : missing.length
      ? `${missing.length}가지가 이 컴퓨터에 없습니다. 다음 화면에서 무엇을 깔지 보여 드립니다.`
      : '필요한 것이 전부 있습니다.'
  state[CHECK - 1] = reqs.length ? 'done' : 'now'
  el('wz-check-next').hidden = false
  el('wz-check-again').hidden = false
  el('wz-check-next').textContent = required.length ? '다음 — 무엇을 깔지 보기' : '다음'
  renderSteps()
  focusFirst()
}

function missingItems() {
  return reqs.filter((r) => !r.installed)
}

function renderCheckList() {
  const list = el('wz-check-list')
  list.replaceChildren()
  for (const r of reqs) {
    const row = document.createElement('div')
    row.className = `wz-row ${r.installed ? 'ok' : r.optional ? 'warn' : 'bad'}`

    const mk = document.createElement('span')
    mk.className = 'wz-row-mk'
    mk.setAttribute('aria-hidden', 'true')
    mk.textContent = r.installed ? '✔' : '·'

    const nm = document.createElement('span')
    nm.className = 'wz-row-nm'
    nm.textContent = fullName(r)

    const st = document.createElement('span')
    st.className = 'wz-row-st'
    // 버전은 앱이 실제로 실행해 확인한 값이다. 있으면 그대로 적는다.
    st.textContent = r.installed ? (r.version ? `있음 · ${r.version}` : '있음') : r.optional ? '없음 (권장)' : '없음'

    const why = document.createElement('p')
    why.className = 'wz-row-why'
    why.textContent = r.why ?? ''

    row.append(mk, nm, st, why)
    list.append(row)
  }
}

// ---------------------------------------------------------------------------
// 2단계 · 설치 동의 → 진행

async function enterInstall() {
  // 닫았다 다시 연 경우다. **되돌리지 않는다** — 뒤에서 winget이 계속 돌고 있는데
  // 동의 화면으로 되감으면 사람 눈에는 시작조차 안 한 것처럼 보이고, [설치 시작]을
  // 다시 눌러 같은 패키지에 설치가 두 개 뜬다.
  if (installing) {
    showPane('install')
    renderInstallList()
    renderSteps()
    focusFirst()
    return
  }
  const missing = missingItems()
  if (!missing.length) {
    // 깔 것이 없으면 물어볼 것도 없다. 끝난 것으로 적고 다음으로 넘어간다.
    progress.clear()
    return finishStep(INSTALL)
  }
  progress.clear()
  showPane('consent')
  const auto = await call('canAutoInstall')
  autoInfo = auto
  // **항목 정보는 이 응답에만 있다.** 예전에는 winget 여부만 읽고 나머지를 버린 뒤
  // 화면이 하드코딩 사전으로 게시자를 지어냈다 — 그러다 git 게시자가 실제와 갈렸고,
  // 사전에 없던 Claude Code는 아무것도 못 보여 줬다(하필 원격 스크립트를 받는 항목이다).
  pkgByKey.clear()
  for (const p of Array.isArray(auto?.packages) ? auto.packages : []) {
    if (p?.key) pkgByKey.set(p.key, p)
  }
  renderConsent(missing)
  focusFirst()
}

function renderConsent(missing) {
  const list = el('wz-consent-list')
  list.replaceChildren()

  const autoCount = missing.filter(canAutoFor).length
  if (autoCount < missing.length) {
    // 자동으로 못 까는 것이 있는 컴퓨터(회사 PC는 winget이 정책으로 막혀 있곤 하다).
    // **거짓 희망도, 거짓 절망도 주지 않는다** — 못 까는 것만 직접 받게 안내한다.
    const note = document.createElement('p')
    note.className = 'wz-row-why'
    note.textContent = autoCount
      ? '이 컴퓨터에서는 일부만 자동으로 설치할 수 있습니다. 나머지는 아래 [다운로드 페이지 열기]로 직접 받아 주세요.'
      : '이 컴퓨터에서는 자동 설치를 쓸 수 없습니다. 공식 페이지에서 직접 받아 설치해 주세요.'
    list.append(note)
  }

  for (const r of missing) {
    const pkg = pkgInfo(r)
    const row = document.createElement('div')
    row.className = 'wz-row'
    row.dataset.key = r.key // 어느 항목의 줄인지 — 화면 검사가 앱이 준 값과 대조한다

    const mk = document.createElement('span')
    mk.className = 'wz-row-mk'
    mk.setAttribute('aria-hidden', 'true')
    mk.textContent = '·'

    const nm = document.createElement('span')
    nm.className = 'wz-row-nm'
    nm.textContent = fullName(r)

    const st = document.createElement('span')
    st.className = 'wz-row-st'
    st.textContent = pkg.id ?? (pkg.source ? '설치 스크립트' : r.optional ? '권장' : '')

    const why = document.createElement('p')
    why.className = 'wz-row-why'
    // 게시자·설치 범위·받아 올 주소는 **남의 컴퓨터에 무엇을 넣는지**를 말해 준다.
    // 앱이 준 것만 적고, 모르면 **모른다고 적는다**(빈칸으로 두면 없는 줄 안다).
    const facts = [
      pkg.by ? `만든 곳: ${pkg.by}` : '',
      pkg.scope ?? '',
      // 원격 스크립트를 받아 실행하는 항목은 그 주소까지 보여 준다. 무엇을 실행하는지
      // 모르는 채로 [설치 시작]을 누르게 하지 않는다.
      pkg.source ? `이 주소에서 받아 실행합니다: ${pkg.source}` : '',
    ].filter(Boolean)
    if (!facts.length) facts.push('만든 곳·설치 범위를 앱이 확인하지 못했습니다')
    if (r.why) facts.push(r.why)
    why.textContent = facts.join(' · ')

    row.append(mk, nm, st, why)

    if (!canAutoFor(r) && r.url) {
      row.append(makeBtn('다운로드 페이지 열기', () => call('openExternal', r.url), 'wz-row-act'))
    }
    list.append(row)
  }

  const anyAuto = autoCount > 0
  el('wz-install-go').hidden = !anyAuto
  // UAC 안내는 **정말 뜰 수 있을 때만.** 앱이 깔 항목이 전부 관리자 권한을 안 쓰면
  // (Claude Code 하나만 까는 경우가 그렇다) 겁만 주는 문구가 된다.
  el('wz-uac').hidden = !anyAuto || !missing.some((r) => canAutoFor(r) && needsAdmin(r))
  el('wz-install-skip').textContent = anyAuto ? '건너뛰기 — 직접 설치할게요' : '설치했어요 — 다시 확인'
}

/**
 * 이 항목을 앱이 대신 깔 수 있는가.
 *
 * **항목마다 다르다.** Claude Code는 PowerShell 스크립트라 winget이 없어도 깔 수 있고,
 * Python·Git은 winget이 필요하다. 백엔드가 항목별 `available`로 그 판단을 이미 해 준다 —
 * 전역 winget 하나로 자르면 winget이 막힌 회사 PC에서 깔 수 있는 것까지 막힌다.
 */
function canAutoFor(r) {
  const p = pkgByKey.get(r.key)
  if (p) return p.available !== false
  // 아직 항목별 정보를 안 주는 앱(옛 버전). 그때만 전역 판단으로 물러선다.
  return autoInfo?.winget === true && r.canInstall !== false
}

function needsAdmin(r) {
  const p = pkgByKey.get(r.key)
  // 모르면 물어볼 수 있다고 본다 — UAC는 예고 없이 뜨는 것이 제일 나쁘다.
  return p ? p.needsAdmin === true : true
}

/**
 * 화면에 적을 패키지 id·게시자·설치 범위·받아 올 주소.
 *
 * **앱이 준 값만 쓴다.** 순서는 `can-auto-install`의 packages → 준비물 목록에 실려 온 값.
 * 둘 다 없으면 null이고, 그러면 화면은 "확인하지 못했습니다"라고 적는다.
 */
function pkgInfo(r) {
  const p = pkgByKey.get(r.key)
  return {
    id: p?.pkg ?? r.pkgId ?? r.pkg ?? null,
    by: p?.publisher ?? r.publisher ?? null,
    scope: scopeText(p) ?? r.scope ?? null,
    source: p?.source ?? null,
  }
}

/** 설치 범위를 사람 말로. 아는 코드값만 옮기고, 모르는 값은 옮기지 않는다. */
function scopeText(p) {
  if (!p) return null
  const where = SCOPE_TEXT[p.scope] ?? null
  const admin = p.needsAdmin === true ? '설치 중 Windows가 허용을 물을 수 있습니다' : '관리자 권한 필요 없음'
  return [where, admin].filter(Boolean).join(', ')
}

function makeBtn(label, onClick, cls = '') {
  const b = document.createElement('button')
  b.type = 'button'
  if (cls) b.className = cls
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

/** 설치를 시작한다. 항목은 하나씩 — 동시에 돌리면 어디서 막혔는지 알 수 없다. */
function startInstall() {
  if (busy || installing) return // 이미 돌고 있다. 두 번 시작하면 winget이 두 개 뜬다.
  queue = missingItems().filter(canAutoFor)
  installing = true
  progress.clear()
  for (const r of queue) progress.set(r.key, { state: 'wait', phase: null, elapsedMs: 0, at: Date.now() })
  showPane('install')
  el('wz-install-fail').hidden = true
  el('wz-install-next').hidden = true
  renderInstallList()
  runQueue()
}

async function runQueue() {
  if (busy) return // 큐를 만지는 일은 한 번에 하나. 두 개가 돌면 항목이 조용히 빠진다.
  busy = true
  el('wz-install-fail').hidden = true
  el('wz-fail-busy').hidden = true
  try {
    while (queue.length) {
      const r = queue[0]
      const res = await installOne(r)
      renderInstallList()
      renderSteps()
      if (res !== true) {
        // **멈춰서 사람에게 묻는다.** 실패한 채로 다음 항목을 깔면 무엇이 됐고
        // 무엇이 안 됐는지 화면과 실제가 어긋난다.
        showFail(r, res)
        return
      }
      queue.shift()
    }
    installing = false
    reqs = await loadReqs()
    renderInstallList()
    const left = missingItems().filter((r) => !r.optional)
    el('wz-install-next').hidden = false
    el('wz-install-next').textContent = left.length ? '그래도 계속하기' : '다음'
    state[INSTALL - 1] = left.length ? 'skip' : 'done'
    renderSteps()
  } finally {
    busy = false
  }
}

/**
 * 한 항목을 깐다. **`verified`가 참일 때만 완료다.**
 *
 * 백엔드는 winget의 exit 0을 믿지 않고 실제로 실행해 확인한다 — 화면도 같은 근거를
 * 써야 한다. `ok: true`인데 `verified: false`면 실패로 다룬다.
 */
async function installOne(r) {
  mark(r.key, { state: 'run', phase: 'download', elapsedMs: 0, at: Date.now() })
  renderInstallList()
  const res = await call('autoInstall', r.key)
  if (res?.ok && res.verified === true) {
    mark(r.key, { state: 'done', phase: 'verify', elapsedMs: elapsedOf(r.key), at: Date.now() })
    return true
  }
  // 깔리긴 했는데 앱이 못 찾는 경우가 있다(PATH가 앱이 켜진 뒤에 바뀐다).
  // 다시 켜라고 말하기 전에 PATH를 새로 읽어 한 번 더 확인해 본다.
  if (res?.needsRestart) {
    const p = await call('refreshPath')
    if (p?.changed) {
      const again = await loadReqs()
      if (again.find((x) => x.key === r.key)?.installed) {
        reqs = again
        mark(r.key, { state: 'done', phase: 'verify', elapsedMs: elapsedOf(r.key), at: Date.now() })
        return true
      }
    }
  }
  mark(r.key, { state: 'fail', phase: null, elapsedMs: elapsedOf(r.key), at: Date.now() })
  return res ?? { ok: false }
}

function mark(key, patch) {
  progress.set(key, { ...(progress.get(key) ?? {}), ...patch })
}

/** 결론이 난 항목인가. 끝났거나 실패한 것은 **다시 진행 중으로 돌아가지 않는다.** */
function settled(key) {
  const p = progress.get(key)
  return p?.state === 'done' || p?.state === 'fail'
}

function elapsedOf(key) {
  const p = progress.get(key)
  if (!p) return 0
  if (p.state !== 'run') return p.elapsedMs ?? 0
  return (p.elapsedMs ?? 0) + Math.max(0, Date.now() - (p.at ?? Date.now()))
}

function fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}초 경과`
  return `${Math.floor(sec / 60)}분 ${sec % 60}초 경과`
}

function renderInstallList() {
  const list = el('wz-install-list')
  list.replaceChildren()
  for (const r of reqs) {
    const p = progress.get(r.key)
    if (!p) continue
    const row = document.createElement('div')
    row.className = `wz-row ${p.state === 'done' ? 'ok' : p.state === 'fail' ? 'bad' : p.state === 'run' ? 'run' : ''}`
    row.dataset.key = r.key

    const mk = document.createElement('span')
    mk.className = 'wz-row-mk'
    mk.setAttribute('aria-hidden', 'true')
    mk.textContent = p.state === 'done' ? '✔' : p.state === 'fail' ? '×' : p.state === 'run' ? '●' : '○'

    const nm = document.createElement('span')
    nm.className = 'wz-row-nm'
    nm.textContent = fullName(r)

    const st = document.createElement('span')
    st.className = 'wz-row-st'
    st.textContent =
      p.state === 'done' ? '완료' : p.state === 'fail' ? '실패' : p.state === 'run' ? (PHASE_TEXT[p.phase] ?? '설치 중') : '대기'

    // 경과 시간 — winget은 2~5분 동안 아무 말이 없다. 이게 없으면 멈춘 줄 안다.
    const t = document.createElement('p')
    t.className = 'wz-row-why wz-elapsed'
    t.dataset.key = r.key
    t.textContent = p.state === 'wait' ? '차례를 기다리는 중' : fmtElapsed(elapsedOf(r.key))

    row.append(mk, nm, st, t)
    list.append(row)
  }
}

/** 1초마다 경과 시간만 고쳐 쓴다. 목록을 통째로 다시 그리면 화면이 깜빡인다. */
function tick() {
  if (!open) return
  for (const t of root.querySelectorAll('.wz-elapsed')) {
    const p = progress.get(t.dataset.key)
    if (!p || p.state === 'wait') continue
    t.textContent = fmtElapsed(elapsedOf(t.dataset.key))
  }
  if (waitingLogin) renderWaitText()
}

/**
 * 실패 — **평범한 말 한 줄과 할 수 있는 행동 하나.**
 * 무엇이 막혔는지는 백엔드가 준 문구를 그대로 쓴다(여기서 지어내면 실제와 어긋난다).
 */
function showFail(r, res) {
  const box = el('wz-install-fail')
  const msg = el('wz-fail-msg')
  const acts = el('wz-fail-acts')
  acts.replaceChildren()
  box.hidden = false

  const err = String(res?.error ?? '')
  const retry = () => runQueue()
  const skip = () => {
    if (busy) return
    queue.shift()
    runQueue()
  }
  const openPage = r.url ? () => call('openExternal', r.url) : null
  /**
   * [설치했어요 — 다시 확인]. **오래 걸린다** — python 훅은 실제로 한 번 돌려 보므로
   * 20초까지 간다. 그동안 화면이 아무 말도 안 하면 사람은 다시 누르고, 그러면
   * `queue.shift()`가 두 번 돌아 아직 안 깐 항목이 조용히 빠진다(그리고 설치가 두 개 뜬다).
   */
  const recheck = async () => {
    if (busy) return
    busy = true
    failBusy(true, '확인하는 중… (조금 걸릴 수 있습니다)')
    let found = false
    try {
      reqs = await loadReqs()
      found = reqs.find((x) => x.key === r.key)?.installed === true
    } finally {
      busy = false
      failBusy(false)
    }
    if (found) {
      mark(r.key, { state: 'done', phase: 'verify', at: Date.now() })
      queue.shift()
      runQueue()
      return
    }
    renderInstallList()
    msg.textContent = `${shortName(r)}를 아직 찾지 못했습니다. 설치를 마쳤는지 확인해 주세요.`
  }

  if (res?.needsRestart) {
    msg.textContent = '설치는 됐는데 앱이 아직 못 찾고 있습니다. 앱을 한 번 다시 켜면 잡힙니다.'
    acts.append(makeBtn('앱 다시 시작', () => call('relaunch')))
  } else if (/취소|cancel|1602|800704c7/i.test(err)) {
    // UAC에서 [아니요]를 눌렀을 때. 무엇을 잃는지 사실대로 적는다.
    msg.textContent = `설치가 취소됐습니다. ${shortName(r)} 없이도 앱은 켜지지만, ${r.why ?? '이 항목이 하는 일은 빠집니다'}`
    acts.append(makeBtn('다시 시도', retry), makeBtn('건너뛰기', skip))
  } else if (/인터넷|네트워크|network|offline|연결할 수 없|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(err)) {
    msg.textContent = '인터넷에 연결되어 있지 않아 내려받을 수 없습니다.'
    acts.append(makeBtn('다시 시도', retry))
  } else if (res?.missing) {
    // 통로 자체가 없는 경우(앱과 preload 버전이 어긋남). 자동 설치는 못 하지만 길은 있다.
    msg.textContent = `자동 설치를 쓸 수 없습니다: ${err} 공식 페이지에서 직접 받으실 수 있습니다.`
    if (openPage) acts.append(makeBtn('다운로드 페이지 열기', openPage))
    acts.append(makeBtn('설치했어요 — 다시 확인', recheck), makeBtn('건너뛰기', skip))
  } else {
    msg.textContent = `설치가 실패했습니다: ${err || '이유를 알 수 없습니다'}. 공식 페이지에서 직접 받으실 수 있습니다.`
    if (openPage) acts.append(makeBtn('다운로드 페이지 열기', openPage))
    acts.append(makeBtn('설치했어요 — 다시 확인', recheck), makeBtn('건너뛰기', skip))
  }
}

/**
 * 확인이 도는 동안 실패 상자를 잠근다. **버튼을 감추지 않고 죽인다** — 사라지면
 * 무엇을 누르려 했는지도 모르게 된다. 무슨 일이 도는지는 한 줄로 적어 둔다.
 */
function failBusy(on, text = '') {
  const line = el('wz-fail-busy')
  line.hidden = !on
  line.textContent = on ? text : ''
  for (const b of el('wz-fail-acts').querySelectorAll('button')) b.disabled = on
}

// ---------------------------------------------------------------------------
// 3·4단계 · 로그인과 연결
//
// 터미널은 없앨 수 없다(브라우저 OAuth라 TTY가 필요하다). 대신 **누르기 전에**
// 무슨 창이 뜨는지, 거기에 아무것도 입력하지 않아도 된다는 것을 미리 말해 둔다.
// 사후 도움말은 늦다 — 실제로 그 화면을 보고 "url 뭘 입력하라는거지?"라는 질문을 받았다.

function buildTell() {
  const out = []
  const head = document.createElement('p')
  const b1 = document.createElement('b')
  b1.textContent = '곧 검은 창이 하나 열립니다. 그 창은 신경 쓰지 않으셔도 됩니다.'
  head.append(b1)

  const steps = document.createElement('ol')
  const li1 = document.createElement('li')
  li1.textContent = '잠시 뒤 브라우저가 열립니다 → 거기서 로그인하세요.'
  const li2 = document.createElement('li')
  li2.textContent = '로그인이 끝나면 이 화면이 저절로 다음으로 넘어갑니다.'
  steps.append(li1, li2)

  const foot = document.createElement('p')
  const b2 = document.createElement('b')
  b2.textContent = '검은 창에 무언가 입력할 필요는 없습니다.'
  const rest = document.createTextNode(' “Or paste the redirect URL here:” 같은 글이 보여도 그대로 두세요.')
  foot.append(b2, rest)

  out.push(head, steps, foot)
  return out
}

async function enterLogin() {
  showPane('login')
  waitingLogin = ''
  env = await call('checkEnv')
  if (env?.claude?.loggedIn === true) {
    // 이미 돼 있으면 붙잡지 않는다. 다음으로 넘어간다.
    return finishStep(LOGIN)
  }
  setWaitUi('login', false)
  focusFirst()
}

async function enterFigma() {
  showPane('figma')
  waitingLogin = ''
  env = env ?? (await call('checkEnv'))
  if (env?.figma?.connected === true) return finishStep(FIGMA)
  setWaitUi('figma', false)
  focusFirst()
}

/** 기다리는 중인지 아닌지에 따라 버튼을 바꾼다. 버튼은 감추되 죽여 두지 않는다. */
function setWaitUi(kind, waiting) {
  if (kind === 'login') {
    el('wz-login-go').hidden = waiting
    el('wz-login-again').hidden = !waiting
    el('wz-login-check').hidden = !waiting
    el('wz-login-next').hidden = true
    el('wz-login-state').hidden = !waiting
  } else {
    el('wz-figma-go').hidden = waiting
    el('wz-figma-skip').hidden = false
    el('wz-figma-next').hidden = true
    el('wz-figma-state').hidden = !waiting
  }
  renderWaitText()
}

function renderWaitText() {
  if (!waitingLogin) return
  const target = waitingLogin === 'figma' ? el('wz-figma-state') : el('wz-login-state')
  if (!target) return
  target.hidden = false
  target.textContent = `브라우저에서 ${waitingLogin === 'figma' ? '인증' : '로그인'}을 마치기를 기다리는 중… (${fmtElapsed(Date.now() - waitStartedAt)})`
}

/**
 * 창을 띄우고 **끝났는지 지켜본다.** 다 하고 나서 다시 눌러 보라고 하면
 * 어디까지 됐는지 알 수 없다.
 *
 * 성공은 **env가 확인해 줄 때만** 성공이다(`ok`만 믿었더니 배너는 "끊겼습니다",
 * 채팅은 "연결됐습니다"가 한 화면에 같이 떴다).
 */
async function startLoginFlow(what) {
  waitingLogin = what
  waitStartedAt = Date.now()
  setWaitUi(what === 'figma' ? 'figma' : 'login', true)
  const res = await call('login', what)
  const now = res?.env ?? (await call('checkEnv'))
  env = now ?? env
  if (confirmed(what, env)) return succeed(what)
  if (res?.manual) {
    say(what, `앱이 창을 띄우지 못했습니다. 터미널에서 직접 실행하세요: ${res.manual}`)
    return
  }
  // **실패로 단정하지 않는다.** 창은 아직 열려 있을 수 있고 거기서 마치면 성공이다.
  say(what, '아직 끝나지 않았습니다 — 창에서 마쳤으면 [지금 확인]을 눌러 주세요.')
}

function confirmed(what, e) {
  if (!e) return false
  return what === 'figma' ? e.figma?.connected === true : e.claude?.loggedIn === true
}

function say(what, text) {
  const target = what === 'figma' ? el('wz-figma-state') : el('wz-login-state')
  target.hidden = false
  target.textContent = text
}

function succeed(what) {
  waitingLogin = ''
  if (what === 'figma') {
    setWaitUi('figma', false)
    finishStep(FIGMA)
    return
  }
  setWaitUi('login', false)
  finishStep(LOGIN)
}

/** [이미 로그인했어요 — 지금 확인]. 지금 다시 재 본다. */
async function recheckLogin(what) {
  env = await call('checkEnv', { force: true })
  if (confirmed(what, env)) return succeed(what)
  say(what, '아직 확인되지 않았습니다. 브라우저에서 로그인을 마쳤는지 확인해 주세요.')
}

// ---------------------------------------------------------------------------
// 5단계 · 첫 회사 만들기

function enterProject() {
  showPane('project')
  el('wz-project-state').hidden = true
  el('wz-project-done').hidden = true
  el('wz-project-next').hidden = true
  el('wz-create').hidden = false
  el('wz-existing').hidden = false
  renderPath()
  el('wz-name').focus()
  el('wz-name').select()
}

/**
 * 만들어질 위치. **경로를 지어내지 않는다** — 문서 폴더는 옮겨져 있을 수 있어서
 * 앱이 실제로 만든 뒤 돌려주는 경로를 정답으로 삼는다. 그 전에는 어디쯤인지만 적는다.
 */
function renderPath() {
  const name = (el('wz-name').value || '').trim()
  el('wz-path').textContent = name
    ? `만들어질 위치: 내 문서 › 윤사무실 › ${name}`
    : '이름을 적으면 어디에 만들어질지 알려 드립니다.'
}

async function createCompany() {
  const name = (el('wz-name').value || '').trim()
  if (!name) {
    el('wz-project-state').hidden = false
    el('wz-project-state').textContent = '이름을 적어 주세요.'
    return
  }
  el('wz-create').disabled = true
  el('wz-project-state').hidden = false
  el('wz-project-state').textContent = '만드는 중…'
  const res = await call('createProject', name)
  el('wz-create').disabled = false
  if (!res?.ok) {
    el('wz-project-state').textContent = `만들지 못했습니다: ${res?.error ?? '알 수 없는 오류'}`
    return
  }
  el('wz-project-state').textContent = res.dir ? `만들었습니다 — ${res.dir}` : '만들었습니다.'
  const done = el('wz-project-done')
  done.replaceChildren()
  done.hidden = false
  for (const line of Array.isArray(res.done) ? res.done : []) {
    const p = document.createElement('p')
    p.className = 'wz-row-why'
    p.textContent = line
    done.append(p)
  }
  el('wz-create').hidden = true
  el('wz-existing').hidden = true
  el('wz-project-next').hidden = false
  state[PROJECT - 1] = 'done'
  renderSteps()
  el('wz-project-next').focus()
}

/** [이미 있는 폴더를 쓸게요] — 기존 경로 그대로. 개발자 길을 막지 않는다. */
async function useExisting() {
  const ok = await host.addExistingProject?.()
  if (ok !== true) return // 고르지 않았거나 실패했다 — 화면은 그대로 둔다
  state[PROJECT - 1] = 'done'
  go(DONE)
}

// ---------------------------------------------------------------------------
// 6단계 · 완료

function enterDone() {
  showPane('done')
  state[DONE - 1] = 'done'
  renderSteps()
  const list = el('wz-done-list')
  list.replaceChildren()
  // **다 됐다고 말하지 않는다.** 건너뛴 것이 있으면 무엇을 못 쓰는지 적어 둔다.
  const left = []
  if (state[INSTALL - 1] === 'skip') left.push('설치하지 않은 프로그램이 있습니다 — ☰의 [설치 마법사 다시 열기]에서 이어서 할 수 있습니다.')
  if (state[FIGMA - 1] === 'skip') left.push('Figma는 연결하지 않았습니다 — 기획안·화면설계서를 만들 때 ☰에서 연결하면 됩니다.')
  if (state[LOGIN - 1] !== 'done') left.push('Claude 로그인이 아직입니다 — 로그인해야 팀원이 일할 수 있습니다.')
  for (const line of left) {
    const p = document.createElement('p')
    p.className = 'wz-row-why'
    p.textContent = line
    list.append(p)
  }
  list.hidden = left.length === 0
  el('wz-finish').focus()
}

// ---------------------------------------------------------------------------
// 언제 뜨는가 — **하위 호환이 가장 중요하다**
//
// `firstRunDone`이 없고 **동시에** (붙은 프로젝트 0개 또는 필수 항목이 하나라도
// 빠짐)일 때만 뜬다. 이미 쓰던 사람은 두 조건이 모두 거짓이라 한 번도 보지 않는다.

function alreadyDone() {
  return backendDone === true || localDone()
}

function shouldOpen() {
  if (alreadyDone()) return false
  if (projectCount === 0) return true
  return reqs.some((r) => !r.optional && !r.installed)
}

async function decide() {
  if (openedOnce || open || !sawStatus) return
  if (alreadyDone()) return
  if (!reqs.length) reqs = await loadReqs()
  if (!shouldOpen()) return
  openWizard()
}

// ---------------------------------------------------------------------------
// 배선

/**
 * app.js가 부르는 유일한 진입점.
 *
 *   onToggle           마법사가 열리고 닫힐 때 — 기존 배너들이 자리를 비우고 되돌아온다
 *   onClosed(finished) 닫힌 뒤 — 마쳤으면 입력창으로 보낸다
 *   addExistingProject 이미 있는 폴더 붙이기(기존 경로 그대로). 성공하면 true
 */
export function initWizard(opts = {}) {
  host = opts
  if (!root) return // 옛 index.html — 마법사 없이도 앱은 그대로 돈다

  el('wz-start').addEventListener('click', () => go(CHECK))
  el('wz-later').addEventListener('click', () => requestClose())
  el('wz-close').addEventListener('click', () => requestClose())
  el('wz-leave-stay').addEventListener('click', cancelClose)
  el('wz-leave-go').addEventListener('click', () => {
    el('wz-leave').hidden = true
    closeWizard(false)
  })

  el('wz-check-next').addEventListener('click', () => finishStep(CHECK))
  el('wz-check-again').addEventListener('click', enterCheck)

  el('wz-install-go').addEventListener('click', startInstall)
  el('wz-install-skip').addEventListener('click', async () => {
    // [건너뛰기]와 [설치했어요 — 다시 확인]은 같은 버튼이다. 다시 재 보고,
    // 그래도 없으면 건너뛴 것으로 적는다(없는 것을 있다고 하지 않는다).
    reqs = await loadReqs()
    if (!missingItems().length) return finishStep(INSTALL)
    finishStep(INSTALL, 'skip')
  })
  el('wz-install-next').addEventListener('click', () => go(LOGIN))

  el('wz-login-go').addEventListener('click', () => startLoginFlow('claude'))
  el('wz-login-again').addEventListener('click', () => startLoginFlow('claude'))
  el('wz-login-check').addEventListener('click', () => recheckLogin('claude'))
  el('wz-login-next').addEventListener('click', () => finishStep(LOGIN))

  el('wz-figma-go').addEventListener('click', () => startLoginFlow('figma'))
  el('wz-figma-skip').addEventListener('click', () => finishStep(FIGMA, 'skip'))
  el('wz-figma-next').addEventListener('click', () => finishStep(FIGMA))

  el('wz-name').addEventListener('input', renderPath)
  // 이름을 적고 Enter를 누르는 것이 자연스럽다. 버튼을 찾아 누르게 하지 않는다.
  el('wz-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    createCompany()
  })
  el('wz-create').addEventListener('click', createCompany)
  el('wz-existing').addEventListener('click', useExisting)
  el('wz-project-next').addEventListener('click', () => go(DONE))

  el('wz-finish').addEventListener('click', () => closeWizard(true))

  // 사전 고지 문구는 3단계와 4단계가 **같은 글**을 쓴다. 한 곳에서 만들어 둘 다에
  // 넣는다 — 따로 적어 두면 한쪽만 고쳐져 말이 갈린다.
  for (const box of root.querySelectorAll('.wz-tell')) box.append(...buildTell())

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      // 닫을지 묻고 있는 중이었다면 Esc는 "그만 묻기"다(닫기가 아니다).
      if (cancelClose()) return
      requestClose()
      return
    }
    if (e.key === 'Tab') trapTab(e)
  })

  // 설치 진행 소식. winget은 오래 조용하므로 오는 대로 화면에 옮긴다.
  listen('onInstallProgress', (p) => {
    if (!p?.key) return
    // **확정된 것은 덮지 않는다.** 실패로 적힌 항목에 진행 이벤트가 뒤늦게 오면
    // "설치가 실패했습니다" 상자 옆에서 같은 항목이 "내려받는 중"으로 되살아난다 —
    // 화면이 거짓말을 하는 것이고, 이 앱에서 제일 나쁜 고장이다.
    // 큐에 없는 항목(진행 기록이 아예 없는 것)도 무시한다. 시작하지도 않은 설치를
    // 도는 것처럼 그릴 이유가 없다.
    if (!progress.has(p.key) || settled(p.key)) return
    mark(p.key, { state: 'run', phase: p.phase, elapsedMs: p.elapsedMs ?? 0, at: Date.now() })
    if (open) {
      renderInstallList()
      renderSteps()
    }
  })

  // 로그인·연결은 앱 밖(브라우저)에서 끝난다. 상태가 바뀌어 오면 그걸로 넘어간다.
  listen('onEnv', (next) => {
    env = next
    if (!open || !waitingLogin) return
    if (confirmed(waitingLogin, env)) succeed(waitingLogin)
  })

  // 뜰지 말지는 **프로젝트 수와 준비물**로 정한다. 상태에 firstRunDone이 실려 오면
  // 그것이 우선이고, 아직 안 실어 줄 때는 렌더러가 남긴 표시를 본다.
  listen('onStatus', (s) => {
    sawStatus = true
    projectCount = Array.isArray(s?.projects) ? s.projects.length : projectCount
    if (typeof s?.firstRunDone === 'boolean') backendDone = s.firstRunDone
    decide()
  })

  renderSteps()
  showPane('welcome')
}

/**
 * 모달 안에서만 Tab이 돌게 한다. 뒤 화면으로 초점이 새면 키보드만 쓰는 사람은
 * 지금 어디를 만지고 있는지 알 수 없다.
 */
function trapTab(e) {
  const items = [...root.querySelectorAll('button, input, [href]')].filter(
    (n) => !n.hidden && !n.disabled && n.offsetParent !== null,
  )
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}
