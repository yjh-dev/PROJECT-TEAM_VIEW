// 화면 검사 — **눈으로 훑는 대신 잰다.**
//
//   SCENARIO=normal electron tools/ui-audit.js
//
// 이 파일은 검사 하나(시나리오 하나)를 돌리고 결과를 JSON으로 뱉는다.
// 여러 시나리오를 묶어 돌리는 것은 tools/check-ui.js가 한다.
//
// 여기서 잡는 것들은 전부 **실제로 한 번씩 났던 사고**다:
//   - 대비        배너 위 흐린 글자가 3.81:1까지 떨어져 안 읽혔다
//   - 조준 크기    프로젝트를 떼는 × 버튼이 17x15에 대비 2.01이었다
//   - 잘림        상태 칩이 줄바꿈되며 상단바가 두 줄이 되고 탭이 뭉개졌다
//   - 줄바꿈       `팀 갱신`이 "팀 갱 / 신"으로 쪼개졌다(넘침이 아니라 안 걸렸다)
//   - 숨김 실패    display를 준 요소는 [hidden]이 안 먹는다 — 세 번 반복됐다
//   - 죽은 버튼    프로젝트가 없는데 취소·복사·칩이 전부 눌렸다
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const RENDERER = path.join(__dirname, '..', 'renderer')
const MAIN_JS = path.join(__dirname, '..', 'main.js')
const S = process.env.SCENARIO || 'normal'
const W = Number(process.env.WIN_W || 1820)
const H = Number(process.env.WIN_H || 1120)

// 손이 닿아야 하는 최소 크기. 이보다 작으면 조준이 어렵다.
const MIN_HIT = 24
// 검사에서 빼는 것 — 보이는 폭은 얇지만 ::before로 잡히는 영역을 넓혀 둔 손잡이.
// 가상 요소는 잴 수 없어 늘 걸리는 가짜 경보가 된다.
const HIT_EXEMPT = new Set(['#splitter'])

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-stub.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 숨긴 창은 DOM이 바뀌어도 다시 그리지 않는다. 조작 뒤 상태를 재려면 필요하다.
      backgroundThrottling: false,
    },
  })

  const errors = []
  win.webContents.on('console-message', (...a) => {
    const level = typeof a[1] === 'number' ? a[1] : a[0]?.level
    const message = typeof a[2] === 'string' ? a[2] : a[0]?.message
    if (level === 2 || level === 3 || level === 'warning' || level === 'error') errors.push(message)
  })

  // 페이지 안에서 예외가 나면 await가 거부되고 quit에 닿지 못해 그대로 매달린다.
  const bail = setTimeout(() => {
    console.log(JSON.stringify({ 시나리오: S, 오류: ['검사가 끝나지 않음(시간 초과)'] }))
    app.exit(2)
  }, 60000)

  // 검사끼리 영향을 주면 안 된다. 마법사가 남기는 '마쳤음' 표시(localStorage)가
  // 한 번 찍히면 그다음 검사에서는 마법사가 아예 안 뜬다 — 매번 새 컴퓨터로 시작한다.
  await win.webContents.session.clearStorageData({ storages: ['localstorage'] })

  await win.loadFile(path.join(RENDERER, 'index.html'))
  await new Promise((r) => setTimeout(r, 2600)) // 상태 반영·첫 렌더 대기

  // 열어야 보이는 화면은 **실제로 눌러서** 연다. 스텁이 상태를 꽂아 주는 방식으로는
  // 여는 길 자체(버튼 → 팝오버 위치·hidden 해제)가 검사에서 빠진다.
  if (S.startsWith('team')) {
    await win.webContents.executeJavaScript(OPEN_TEAM)
    await new Promise((r) => setTimeout(r, 900)) // 명단을 읽어 목록을 그릴 때까지
  }
  // 연결(로그인 계정)은 ☰ 안에 있다. 열지 않으면 그 줄은 검사에서 통째로 빠진다.
  if (S.startsWith('acct')) {
    await win.webContents.executeJavaScript(OPEN_MENU)
    await new Promise((r) => setTimeout(r, 600))
  }
  // 사용량은 상단 요약 한 줄과 눌러서 펴는 화면으로 나뉜다. 펴지 않으면 숫자표·
  // 캐시 배수·추이·한도 아님 안내가 통째로 검사에서 빠진다.
  // 지금 대화의 무게와 [새 대화 시작]도 이 화면 안에 있다 — 같은 길로 연다.
  if (S.startsWith('usage') || S.startsWith('session')) {
    await win.webContents.executeJavaScript(OPEN_USAGE)
    await new Promise((r) => setTimeout(r, 700))
  }

  const click = async (id) => {
    await win.webContents.executeJavaScript(
      `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e && !e.hidden && !e.disabled) e.click(); return true })()`,
    )
    await new Promise((r) => setTimeout(r, 900))
  }

  let out
  try {
    // 마법사는 **여러 화면을 거쳐** 흐른다. 단계마다 재고 결과를 합친다 —
    // 마지막 화면만 재면 앞 화면(환영)이 검사에서 통째로 빠진다.
    const stages = WIZ_STAGES[S] ?? [null]
    const shots = []
    for (const stage of stages) {
      if (stage) for (const id of stage) await click(id)
      shots.push(await win.webContents.executeJavaScript(SCRIPT))
    }
    out = shots.reduce(merge)
  } catch (err) {
    clearTimeout(bail)
    console.log(JSON.stringify({ 시나리오: S, 오류: ['검사 스크립트 실패: ' + (err?.message ?? err)] }))
    app.exit(1)
    return
  }

  // **마법사가 뜰 자리에만 뜨는가.** 가장 나쁜 회귀는 이미 쓰던 사람에게 뜨는 것이다.
  // 뜬 동안에는 기존 배너가 겹치지 않아야 한다(지우지는 않고 자리만 비운다).
  try {
    out.마법사 = await win.webContents.executeJavaScript(wizardCheck(S.startsWith('wizard')))
  } catch (err) {
    out.마법사 = ['마법사 확인 실패: ' + (err?.message ?? err)]
  }

  // 재는 것으로는 안 잡히는 것들 — **눌러 보고 시간이 지난 뒤 다시 봐야** 드러난다.
  // (실패가 되살아나기, 닫았다 열면 되감기, 오래 걸리는 버튼의 연타.)
  // 화면 크기 재기가 끝난 뒤에 돌린다 — 여기서 DOM을 만지므로 앞의 측정과 섞이면 안 된다.
  try {
    const probes = await runWizardProbes(win)
    // 흐름 도중에만 뜨는 화면(닫을지 묻는 줄)도 **한 번은 재야 한다.** 안 재면
    // 좁은 창에서 글이 잘리거나 글자가 안 읽혀도 아무도 모른다.
    out = [out, ...probes.shots].reduce(merge)
    if (probes.found.length) out.마법사흐름 = probes.found
    // 무엇을 눌러 봤는지 · 무엇을 못 봤는지. 문자열이라 판정에는 안 들어가고,
    // check-ui.js가 "돌아야 할 흐름이 돌았는지" 대조와 알림 출력에만 쓴다.
    // (문자열은 merge에 넣으면 글자 단위로 쪼개지므로 **합친 뒤에** 붙인다.)
    if (probes.ran.length) out.흐름 = probes.ran.join(' · ')
    if (probes.notes.length) out.알림 = probes.notes.join(' / ')
  } catch (err) {
    out.마법사흐름 = ['마법사 흐름 검사 실패: ' + (err?.message ?? err)]
  }

  // 사용량은 **모양만 재서는 아무것도 못 잡는다.** 제일 나쁜 결함은 화면이 멀쩡히 잘
  // 그려진 채로 없는 숫자를 지어내는 것이다(집계 중인데 0, 분모가 없는데 퍼센트).
  // 그래서 앱이 준 원본과 화면의 글자를 직접 맞대 본다.
  // **어느 갈래에서든** 상단 숫자가 있어야 할 자리에 있는가. 사용량 흐름 검사는
  // `usage-*` 갈래에서만 도는데, 정작 "그 자리가 통째로 사라졌다"는 사고는 다른 갈래에서
  // 났다 — 스텁이 새 PC(empty·missing)에 `null`을 주며 "여기는 없는 게 맞다"고
  // 우겼고, 아무도 그것을 재지 않았다. 앱은 기록이 없어도 객체를 준다.
  try {
    out.사용량자리 = await usagePresence(win)
  } catch (err) {
    out.사용량자리 = ['사용량 자리 확인 실패: ' + (err?.message ?? err)]
  }

  try {
    const probes = await runUsageProbes(win)
    if (probes.found.length) out.사용량 = probes.found
    if (probes.ran.length) out.흐름 = [out.흐름, ...probes.ran].filter(Boolean).join(' · ')
    if (probes.notes.length) out.알림 = [out.알림, ...probes.notes].filter(Boolean).join(' / ')
  } catch (err) {
    out.사용량 = ['사용량 흐름 검사 실패: ' + (err?.message ?? err)]
  }

  // 새 대화로 갈아타기도 **눌러 봐야** 드러난다(확인 없이 바뀌는지, 메모가 실려 가는지,
  // 거절당했을 때 이유가 화면에 오는지). 사용량 검사 다음에 돌린다 — 여기서 확인 창을
  // 띄우므로 앞의 측정과 섞이면 안 된다.
  try {
    const probes = await runSessionProbes(win)
    if (probes.shots.length) {
      // 문자열(흐름·알림)은 merge에 넣으면 **글자 단위로 쪼개진다.** 잠깐 빼 두고 합친다.
      const flow = out.흐름
      const note = out.알림
      delete out.흐름
      delete out.알림
      out = [out, ...probes.shots].reduce(merge)
      if (flow) out.흐름 = flow
      if (note) out.알림 = note
    }
    if (probes.found.length) out.대화갈아타기 = probes.found
    if (probes.ran.length) out.흐름 = [out.흐름, ...probes.ran].filter(Boolean).join(' · ')
    if (probes.notes.length) out.알림 = [out.알림, ...probes.notes].filter(Boolean).join(' / ')
  } catch (err) {
    out.대화갈아타기 = ['새 대화 흐름 검사 실패: ' + (err?.message ?? err)]
  }

  // 한도 홀드도 **모양이 아니라 내용**이다. 안내가 예쁘게 떠 있어도 이유를 화면이
  // 지어냈거나 남은 시간이 앱이 준 시각에서 나온 것이 아니면 아무 쓸모가 없다.
  try {
    const probes = await runHoldProbes(win)
    if (probes.found.length) out.한도홀드 = probes.found
    if (probes.ran.length) out.흐름 = [out.흐름, ...probes.ran].filter(Boolean).join(' · ')
    if (probes.notes.length) out.알림 = [out.알림, ...probes.notes].filter(Boolean).join(' / ')
  } catch (err) {
    out.한도홀드 = ['한도 홀드 검사 실패: ' + (err?.message ?? err)]
  }
  clearTimeout(bail)

  out.손닿는크기 = out.손닿는크기.filter((i) => !HIT_EXEMPT.has(i.요소))
  out.오류 = errors
  console.log(JSON.stringify({ 시나리오: S, 창: `${W}x${H}`, ...out }))
  app.quit()
})

// ☰ → [팀원 관리] → [+ 직접 만들기]까지 눌러 둔다. 만들기 폼은 막혀 있으면
// (처리 중·자리 없음) 열리지 않는 것이 정상이라 눌러 보기만 한다.
// ☰만 연다. 팀원 패널은 열지 않는다 — 그쪽을 열면 ☰가 자리를 내주며 닫혀서
// 연결 줄이 화면에서 사라진다.
const OPEN_MENU = `(() => {
  document.getElementById('menu').click()
  return true
})()`

// 상단 사용량을 눌러 편다. **감춰져 있으면 누르지 않는다** — 아래 흐름 검사가
// "떠야 하는데 안 떴다"로 잡아야 하고, 여기서 억지로 열면 그 결함이 가려진다.
const OPEN_USAGE = `(() => {
  const g = document.getElementById('usage-btn')
  if (g && !g.hidden) g.click()
  return true
})()`

const OPEN_TEAM = `(() => {
  document.getElementById('menu').click()
  document.getElementById('team-manage').click()
  const nw = document.getElementById('team-new')
  if (nw && !nw.disabled) nw.click()
  return true
})()`

// 첫 실행 마법사를 **실제로 눌러서** 그 단계까지 몰고 간다. 갈래마다 눌러야 할
// 버튼이 다르고, `wizard`는 두 화면(환영 → 준비물 확인)을 모두 잰다.
const WIZ_STAGES = {
  // 환영 → 준비물 확인 → 설치 동의. 동의 화면은 **남의 PC에 무엇을 까는지 적는 자리**라
  // 여기서 한 번 재고, 아래 흐름 검사가 그 값이 앱이 준 것과 같은지 대조한다.
  wizard: [[], ['wz-start'], ['wz-check-next']],
  'wizard-nowinget': [['wz-start', 'wz-check-next']],
  'wizard-installing': [['wz-start', 'wz-check-next', 'wz-install-go']],
  'wizard-fail': [['wz-start', 'wz-check-next', 'wz-install-go']],
  // 설치는 이미 끝난 갈래 — 2단계는 깔 것이 없어 저절로 지나간다.
  'wizard-login': [['wz-start', 'wz-check-next', 'wz-login-go']],
  'wizard-project': [['wz-start', 'wz-check-next']],
  // 사무실에 사람이 있는 채로 마법사가 뜬 갈래. 이름표가 뚫고 나오는지는 화면마다
  // 따로 봐야 한다 — 마법사 상자는 단계마다 크기가 달라 겹치는 자리도 달라진다.
  'wizard-office': [[], ['wz-start']],
}

/** 화면 여러 장의 결과를 합친다. 값은 전부 배열이라 이어 붙이면 된다. */
function merge(a, b) {
  const out = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = [...(a[k] ?? []), ...(b[k] ?? [])]
  }
  return out
}

/**
 * 마법사가 **뜰 자리에만 뜨는가.**
 *
 * 가장 나쁜 회귀는 이미 쓰던 사람에게 뜨는 것이다(프로그램이 없거나 프로젝트가
 * 없어도, `firstRunDone`이 있으면 떠서는 안 된다). 반대로 새 PC에서 안 뜨는 것도
 * 같은 무게의 실패다. 그리고 떠 있는 동안에는 기존 배너와 겹치지 않아야 한다.
 */
const wizardCheck = (want) => `(() => {
  const bad = []
  const vis = (e) => {
    if (!e) return false
    const s = getComputedStyle(e)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const w = document.getElementById('wizard')
  const open = vis(w)
  if (${want} && !open) bad.push('마법사가 떠야 하는데 안 떴다')
  if (!${want} && open) bad.push('마법사가 뜨면 안 되는데 떴다')
  if (open) {
    for (const id of ['need', 'env', 'welcome']) {
      if (vis(document.getElementById(id))) bad.push('마법사 뒤로 #' + id + '이(가) 겹쳐 보인다')
    }
  }
  return bad
})()`

// ---------------------------------------------------------------------------
// 마법사 흐름 검사 — **재는 것으로는 안 잡히는 것들**
//
// 한 장을 재서 잡는 것(잘림·대비·숨김 실패)과 달리, 아래 것들은 **누른 뒤 시간이
// 지나야** 드러난다. 전부 코드 리뷰에서 실제로 나온 결함이다:
//
//   결함1 실패로 확정된 항목이 뒤늦게 온 진행 이벤트에 덮여 "내려받는 중"으로 되살아난다
//         (백엔드 타이머가 안 꺼지는 버그가 있었다 — 화면 쪽에도 방어가 있어야 한다)
//   결함2 설치 중에 닫았다 다시 열면 동의 화면으로 되감겨 같은 설치가 두 번 돈다
//   결함3 [설치했어요 — 다시 확인]에 잠금이 없어 연타하면 큐가 밀린다
//   결함4 동의 화면이 앱이 주지 않은 게시자·패키지 id를 하드코딩 사전에서 지어낸다
//   결함5 항목별로 다른 자동 설치 가능 여부를 winget 하나로 잘라 버린다
//   결함6 설치 중 닫기·Esc가 아무것도 묻지 않는다(설치는 뒤에서 계속 도는데)
async function runWizardProbes(win) {
  const found = [] // 잡은 것(하나라도 있으면 검사 실패)
  const ran = [] // 실제로 눌러 본 것
  const notes = [] // 이 갈래에서는 확인하지 못한 것(막지는 않되 조용히 넘어가지도 않는다)
  const shots = [] // 흐름 도중에만 뜨는 화면을 잰 것(앞의 측정에 합친다)
  if (!S.startsWith('wizard')) return { found, ran, notes, shots }
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 동의 화면이 떠 있는 갈래에서만 (결함 4·5)
  if (await js(`!document.querySelector('.wz-pane[data-pane="consent"][hidden]')`)) {
    found.push(...(await js(CONSENT_CHECK)))
    ran.push('동의 화면 값 대조')
    // 항목별 자동 설치 판정(`available`)은 앱이 `packages`를 줄 때만 대조할 수 있다.
    // 메인은 주지만(main.js의 env:can-auto-install) 검사용 스텁은 아직 안 준다 —
    // **못 본 것을 봤다고 하지 않는다.** 스텁이 실어 주는 날 이 갈래가 그것까지 본다.
    if (!(await js(`(async () => { const a = await window.teamView.canAutoInstall(); return Array.isArray(a && a.packages) })()`))) {
      notes.push('앱이 packages를 주지 않아 항목별 자동 설치 판정(available)·게시자 원본 대조는 확인하지 못했다 (tools/ui-stub.js의 canAutoInstall에 packages를 실으면 이 갈래가 그것까지 본다)')
    }
  }

  if (S === 'wizard-fail') {
    // 결함 1 — 실패한 항목에 진행 이벤트를 **한 번 더** 흘려 넣는다. autoInstall을
    // 다시 부르면 스텁이 그 항목으로 download/install 소식을 밀어 준다(백엔드 버그와 같은 모양).
    const key = await js(FAILED_KEY)
    if (!key) {
      found.push('설치가 실패했는데 실패로 적힌 줄이 없다')
    } else {
      await js(`window.teamView.autoInstall(${JSON.stringify(key)}); true`)
      await wait(600)
      const a = await js(afterLateProgress(key))
      if (a.st !== '실패') {
        found.push(`실패로 확정된 항목이 뒤늦은 진행 이벤트에 덮여 "${a.st}"로 되살아났다`)
      }
      if (!a.failShown) found.push('실패 상자가 사라졌다 — 실패는 사람이 고르기 전까지 남아 있어야 한다')
      if (/내려받는 중|설치 중|확인 중/.test(a.hint)) {
        found.push(`실패한 항목이 왼쪽 단계 요약에서는 아직 도는 중이라고 적혀 있다 (${a.hint})`)
      }
      ran.push('실패 뒤 진행 이벤트')
    }

    // 결함 3 — [설치했어요 — 다시 확인]은 눌리는 즉시 잠겨야 한다(python 훅 실측은 20초까지 간다).
    const now = await js(CLICK_RECHECK)
    if (now.none) {
      found.push('실패 상자에 [설치했어요 — 다시 확인]이 없다')
    } else {
      if (now.enabled) {
        found.push(`[다시 확인]을 눌렀는데 버튼 ${now.enabled}개가 아직 눌린다 — 연타하면 큐가 밀린다`)
      }
      if (!now.busyShown) found.push('[다시 확인]을 눌렀는데 확인하는 중이라는 표시가 없다')
      await wait(1500)
      const later = await js(AFTER_RECHECK)
      if (later.disabled) found.push(`확인이 끝났는데 버튼 ${later.disabled}개가 죽은 채로 남았다`)
      if (later.busy) found.push('확인이 끝났는데 "확인하는 중" 표시가 남았다')
      ran.push('다시 확인 잠금')
    }
  }

  if (S === 'wizard-installing') {
    // 결함 6 — 설치가 도는 중의 [×]와 Esc
    const c1 = await js(CLICK_CLOSE)
    if (!c1.before) {
      found.push('설치 갈래인데 마법사가 떠 있지 않다')
    } else {
      if (!c1.wizOpen) {
        found.push('설치가 도는 중에 [×]가 아무것도 묻지 않고 창을 닫았다 — 설치는 뒤에서 계속 도는데 사용자는 취소된 줄 안다')
      } else if (!c1.ask) {
        found.push('설치 중 닫기를 눌렀는데 무슨 일이 일어나는지 알려 주지 않는다')
      }
      // 닫을지 묻는 줄이 떠 있는 지금을 잰다(잘림·대비·손닿는 크기).
      if (c1.ask) shots.push(await js(SCRIPT))
      const c2 = await js(PRESS_ESC)
      if (!c2.wizOpen) found.push('설치가 도는 중에 Esc가 곧바로 창을 닫았다')
      ran.push('설치 중 닫기·Esc')

      // 결함 2 — 닫았다 ☰에서 다시 열면 **진행 화면 그대로**여야 한다
      const c3 = await js(LEAVE_NOW)
      if (!c3.closed) {
        found.push('[창만 닫기]를 눌렀는데 창이 닫히지 않는다')
      } else {
        await js(REOPEN)
        await wait(700)
        const c4 = await js(AFTER_REOPEN)
        if (!c4.open) found.push('☰의 [설치 마법사 다시 열기]로 열었는데 안 떴다')
        else if (c4.pane !== 'install') {
          found.push(`설치가 도는 중에 다시 열었더니 '${c4.pane}' 화면으로 되감겼다 — [설치 시작]을 다시 누르면 같은 설치가 두 개 돈다`)
        }
        if (c4.open && !c4.rows.length) found.push('다시 열었더니 설치 진행 목록이 비어 있다')
        if (c4.open && c4.rows.length && !c4.rows.some((t) => /내려받는 중|설치 중|확인 중/.test(t))) {
          found.push('설치가 도는 중인데 다시 연 화면에는 도는 항목이 하나도 없다')
        }
        ran.push('닫았다 다시 열기')
      }
    }
  }
  return { found, ran, notes, shots }
}

/**
 * 동의 화면에 적힌 것이 **앱이 실제로 준 값과 같은가.**
 *
 * 화면이 하드코딩 사전에서 게시자를 지어내던 자리다(git 게시자가 실제와 갈렸고,
 * 사전에 없던 Claude Code는 아무것도 못 보여 줬다). 그래서 여기서는 화면만 보지 않고
 * `canAutoInstall`·`checkRequirements`를 직접 불러 **원본과 한 줄씩 대조한다.**
 * 자동 설치 가능 여부도 같은 원본으로 다시 계산해 화면과 맞춰 본다(결함 5).
 */
const CONSENT_CHECK = `(async () => {
  const bad = []
  const auto = await window.teamView.canAutoInstall()
  const reqs = await window.teamView.checkRequirements()
  const list = (auto && Array.isArray(auto.packages)) ? auto.packages : []
  const pk = new Map(list.filter((p) => p && p.key).map((p) => [p.key, p]))
  const rows = [...document.querySelectorAll('#wz-consent-list .wz-row')]
  if (!rows.length) return ['동의 화면에 설치할 항목이 한 줄도 없다']
  let anyAuto = false
  for (const row of rows) {
    const key = row.dataset.key
    if (!key) { bad.push('동의 화면의 줄에 어느 항목인지가 적혀 있지 않다'); continue }
    const p = pk.get(key) || null
    const r = (reqs || []).find((x) => x.key === key) || null
    const why = ((row.querySelector('.wz-row-why') || {}).textContent || '')
    const id = (((row.querySelector('.wz-row-st') || {}).textContent) || '').trim()

    const m = why.match(/만든 곳: ([^·]+)/)
    const shownBy = m ? m[1].trim() : null
    const trueBy = (p && p.publisher) || (r && r.publisher) || null
    if (shownBy && !trueBy) bad.push(key + ': 앱이 주지 않은 게시자를 화면이 지어냈다 (' + shownBy + ')')
    else if (shownBy && shownBy !== String(trueBy).trim()) bad.push(key + ': 게시자가 앱이 준 값과 다르다 (화면 ' + shownBy + ' / 앱 ' + trueBy + ')')
    else if (!shownBy && !trueBy && !/확인하지 못했습니다/.test(why)) bad.push(key + ': 만든 곳을 모르면서 모른다고 적지도 않았다')

    const trueId = (p && p.pkg) || (r && r.pkgId) || (r && r.pkg) || null
    if (id && id !== '권장' && id !== '설치 스크립트') {
      if (!trueId) bad.push(key + ': 앱이 주지 않은 패키지 id를 화면이 지어냈다 (' + id + ')')
      else if (id !== String(trueId).trim()) bad.push(key + ': 패키지 id가 앱이 준 값과 다르다 (화면 ' + id + ' / 앱 ' + trueId + ')')
    }
    if (p && p.method === 'script' && p.source && why.indexOf(p.source) < 0) {
      bad.push(key + ': 원격 스크립트를 받아 실행하는 항목인데 그 주소를 보여 주지 않는다')
    }

    const can = p ? p.available !== false : (auto && auto.winget === true && !(r && r.canInstall === false))
    if (can) anyAuto = true
    const dl = row.querySelector('button')
    if (!can && !dl && r && r.url) bad.push(key + ': 앱이 못 까는 항목인데 직접 받으러 갈 길도 없다')
    if (can && dl) bad.push(key + ': 앱이 깔아 줄 수 있는데 직접 받으라고만 한다')
  }
  const go = document.getElementById('wz-install-go')
  if (anyAuto && go.hidden) bad.push('앱이 깔아 줄 수 있는 항목이 있는데 [설치 시작]이 없다')
  if (!anyAuto && !go.hidden) bad.push('앱이 깔아 줄 수 있는 항목이 없는데 [설치 시작]이 떠 있다')
  return bad
})()`

const FAILED_KEY = `(() => {
  const rows = [...document.querySelectorAll('#wz-install-list .wz-row')]
  const f = rows.find((r) => (((r.querySelector('.wz-row-st') || {}).textContent) || '').trim() === '실패')
  return f ? f.dataset.key : null
})()`

const afterLateProgress = (key) => `(() => {
  const k = ${JSON.stringify(key)}
  const row = [...document.querySelectorAll('#wz-install-list .wz-row')].find((r) => r.dataset.key === k)
  const st = row ? (((row.querySelector('.wz-row-st') || {}).textContent) || '').trim() : '(줄이 사라졌다)'
  const step = [...document.querySelectorAll('#wz-steps .wz-step')][1]
  return {
    st,
    failShown: !document.getElementById('wz-install-fail').hidden,
    hint: step ? (((step.querySelector('.wz-hint') || {}).textContent) || '') : '',
  }
})()`

// 누른 **그 순간** 잠겼는지 본다. 한 번 더 오가면 이미 확인이 끝나 버려 못 잡는다.
const CLICK_RECHECK = `(() => {
  const acts = document.getElementById('wz-fail-acts')
  const btn = [...acts.querySelectorAll('button')].find((b) => /다시 확인/.test(b.textContent))
  if (!btn) return { none: true }
  btn.click()
  const line = document.getElementById('wz-fail-busy')
  const shown = !line.hidden && getComputedStyle(line).display !== 'none' && (line.textContent || '').trim().length > 0
  return { none: false, enabled: [...acts.querySelectorAll('button')].filter((b) => !b.disabled).length, busyShown: shown }
})()`

const AFTER_RECHECK = `(() => {
  const acts = document.getElementById('wz-fail-acts')
  return {
    disabled: [...acts.querySelectorAll('button')].filter((b) => b.disabled).length,
    busy: !document.getElementById('wz-fail-busy').hidden,
  }
})()`

const CLICK_CLOSE = `(() => {
  const w = document.getElementById('wizard')
  const before = !w.hidden
  document.getElementById('wz-close').click()
  return { before, wizOpen: !w.hidden, ask: !document.getElementById('wz-leave').hidden }
})()`

const PRESS_ESC = `(() => {
  document.getElementById('wz-leave-stay').click() // 물음을 걷고 Esc로 다시 해 본다
  const w = document.getElementById('wizard')
  w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return { wizOpen: !w.hidden, ask: !document.getElementById('wz-leave').hidden }
})()`

const LEAVE_NOW = `(() => {
  const go = document.getElementById('wz-leave-go')
  if (!go.hidden) go.click()
  else document.getElementById('wz-close').click()
  return { closed: document.getElementById('wizard').hidden }
})()`

const REOPEN = `(() => {
  document.getElementById('menu').click()
  document.getElementById('wz-open').click()
  return true
})()`

const AFTER_REOPEN = `(() => {
  const pane = [...document.querySelectorAll('.wz-pane')].find((p) => !p.hidden)
  const rows = [...document.querySelectorAll('#wz-install-list .wz-row')]
    .map((r) => (((r.querySelector('.wz-row-st') || {}).textContent) || '').trim())
  return { open: !document.getElementById('wizard').hidden, pane: pane ? pane.dataset.pane : null, rows }
})()`

// ---------------------------------------------------------------------------
// 사용량 흐름 검사 — **모양이 아니라 내용을 본다**
//
// 이 화면에서 제일 나쁜 결함은 레이아웃이 무너지는 것이 아니라, 멀쩡히 잘 그려진 채로
// **없는 숫자를 지어내는 것**이다. 실제로 그렇게 됐었다 — 앱이 실측 평균에서 뽑은 눈금
// (하루 1.5M)을 분모로 세워 "일간 90%"를 그렸는데, 같은 시각 Claude의 실제 화면은 세션
// 55% · 주간 44%였다. 기간도(달력 하루 vs 5시간 롤링) 분모도 세는 대상도 달랐다.
//
// 그래서 분모를 통째로 걷어냈고, 이 검사도 "퍼센트가 맞는가"에서 **"퍼센트가 없는가"**로
// 바뀌었다. 여기서 보는 것:
//   - 화면 어디에도 **퍼센트 기호가 없는가** (분모 없는 %는 전부 한도로 읽힌다)
//   - **"이 숫자는 한도가 아니다"가 실제로 그려지는가** · 진짜 한도를 어디서 보는지 적혔는가
//   - 표의 숫자가 **앱이 준 값에서 나온 것인가** (지어낸 숫자인가)
//   - 집계가 안 끝났는데 0을 채워 넣지 않는가
//   - 캐시 읽기가 출력의 몇 배인지 적혀 있는가 — 이 화면이 남은 이유가 그 숫자다
//   - 한도에 걸린 기록의 리셋 시각이 실제로 화면에 있는가
//   - 큰 숫자를 자리수 그대로 쏟아 놓지 않는가
async function runUsageProbes(win) {
  const found = [] // 잡은 것(하나라도 있으면 검사 실패)
  const ran = [] // 실제로 해 본 것
  const notes = [] // 이 갈래에서는 확인하지 못한 것
  if (!S.startsWith('usage')) return { found, ran, notes }
  const js = (code) => win.webContents.executeJavaScript(code)

  // 앱이 실제로 준 값. **화면의 숫자는 전부 여기서 나와야 한다.**
  // 통로가 없는 갈래(usage-none)도 있으므로 없는 함수를 부르지 않는다.
  const st = await js(
    `(async () => { const f = window.teamView && window.teamView.getUsageStats
       if (typeof f !== 'function') return { __noBridge: true }
       try { return await f() } catch (e) { return { __threw: String(e && e.message) } } })()`,
  )
  const seen = await js(READ_USAGE)

  // **상단 숫자가 숨는 유일한 실제 경로.** 앱의 getUsageStats는 기록을 하나도 못 봐도
  // 객체를 준다(ready:false) — 그러니 "값이 없어서 숨었다"는 통로가 없을 때뿐이다.
  // 이 갈래가 없으면 숨김 경로는 검사에서 통째로 빠진다(전에는 스텁이 지어낸 null을
  // 새 PC라고 부르며 그 자리를 채우고 있었다 — 프로덕션에는 없는 상태였다).
  if (st && st.__noBridge) {
    ran.push('사용량 통로 없음 확인')
    if (seen.btnShown) found.push('사용량 통로가 없는데 상단에 숫자가 떠 있다 — 누르면 빈 상자가 열린다')
    if (seen.popShown) found.push('사용량 통로가 없는데 자세히 보기가 열려 있다')
    return { found, ran, notes }
  }
  ran.push('사용량 화면 대조')
  if (st && st.__threw) {
    found.push(`앱이 사용량을 묻자 예외를 던졌다: ${st.__threw}`)
    return { found, ran, notes }
  }

  if (!st) {
    found.push('이 갈래에는 사용량이 있어야 하는데 앱이 아무것도 주지 않았다')
    return { found, ran, notes }
  }
  // 화면을 보기 전에 **스텁부터 의심한다.** 스텁이 지어낸 모양 위에서 도는 검사는
  // 초록불이어도 아무것도 지켜 주지 못한다(이 저장소에서 두 번 그랬다).
  {
    const shape = usageShapeProblems(st)
    found.push(...shape.found)
    notes.push(...shape.notes)
  }

  if (!seen.btnShown) {
    found.push('앱이 사용량을 줬는데 상단에 숫자가 뜨지 않았다')
    return { found, ran, notes }
  }
  if (!seen.popShown) {
    found.push('상단 숫자를 눌렀는데 자세히 보기가 열리지 않았다')
    return { found, ran, notes }
  }

  const all = [seen.popText, seen.sum, seen.tip].join(' ')

  // 1) **퍼센트가 하나도 없는가.** 이 화면에는 분모가 없다. 분모 없는 퍼센트는 사람이
  //    전부 한도로 읽는다 — 실제로 "일간 90%"를 보고 한도 임박으로 읽었다.
  //    (안내 문구까지 % 없이 쓰는 이유가 이것이다. 예외를 하나 두면 규칙이 무너진다.)
  const pct = all.match(/[^\s]{0,12}%/)
  if (pct) {
    found.push(`사용량 화면에 퍼센트가 적혔다: "${pct[0]}" — 견줄 분모가 없어서 전부 한도로 읽힌다`)
  }
  // 1-1) 걷어낸 개념이 화면에 남아 있지 않은가. 문구만 남고 값이 사라지는 쪽이
  //      더 나쁘다("예산의"만 남으면 무엇의 예산인지도 알 수 없다).
  const ghost = all.match(/예산|제안치|한도의|이번 주/)
  if (ghost) {
    found.push(`걷어낸 말이 화면에 남아 있다: "${ghost[0]}" — 분모(예산·제안치)는 이제 없고, 주간은 '최근 7일'이다`)
  }

  // 2) **"이 숫자는 한도가 아니다"가 실제로 그려지는가.**
  //    이 줄이 없으면 나머지가 아무리 정확해도 화면 전체가 한도로 읽힌다. 그리고
  //    아니라고만 말하면 사용자는 갈 곳이 없다 — 어디서 봐야 하는지까지 있어야 한다.
  if (!seen.disclaimShown) {
    found.push('"이 숫자는 한도가 아니다"라는 안내가 화면에 없다 — 숫자만 있으면 누구나 한도로 읽는다')
  } else {
    if (!/한도/.test(seen.disclaim)) {
      found.push(`안내 줄이 한도와 다르다는 말을 하지 않는다: "${seen.disclaim}"`)
    }
    if (!/Claude 설정|설정 →/.test(seen.disclaim)) {
      found.push('안내 줄에 진짜 한도를 어디서 보는지가 없다 — 아니라고만 하면 갈 곳이 없다')
    }
  }

  // 3) 기록을 아직 못 봤다 — **여기서 나오는 숫자는 전부 지어낸 것이다.**
  //    (앱은 이때도 객체를 준다. `ready:false`면 today/week/days가 전부 null이다.)
  if (st.ready === false) {
    if (!/집계/.test(all)) found.push('아직 집계 중인데 화면이 그렇다고 말하지 않는다')
    if (!seen.stateShown) found.push('집계 중이라는 줄이 화면에 없다')
    const madeUp = seen.now.rows.flatMap((r) => r.cells).filter((c) => c && c !== '—')
    if (madeUp.length) {
      found.push(`집계가 안 끝났는데 표에 "${madeUp[0]}"가 적혔다 — 지어낸 숫자다(모르는 칸은 0이 아니라 빈칸이다)`)
    }
    // days가 null인데 기둥을 그리면 **없는 날을 지어낸 것**이다(6에서 수도 대조한다).
    if (st.days === null && seen.days > 0) {
      found.push(`앱이 일별 기록을 주지 않았는데(days:null) 화면에 기둥 ${seen.days}개가 서 있다`)
    }
    // "쌓인 기록이 없다"는 **모른다가 아니라 안 썼다**는 말이다. 아직 못 센 것을
    // 그렇게 적으면 사용자는 자기가 안 썼다고 믿는다.
    if (/기록이 없|안 썼|사용이 없/.test(seen.trend)) {
      found.push(`덜 센 상태인데 추이 설명이 "${seen.trend}"다 — 모르는 것을 없다고 적었다`)
    }
  }

  // 4) **표의 숫자가 앱이 준 값 그대로인가.** 퍼센트가 사라진 뒤로 이 화면의 전부가
  //    이 표다. 한 칸이라도 다른 데서 나온 숫자면 화면 전체를 믿을 수 없다.
  const cols = [
    ['오늘', st.ready ? st.today : null],
    ['최근 7일', st.ready ? st.week : null],
  ]
  const ROWS = [
    ['출력', 'output', false],
    ['캐시 읽기', 'cacheRead', false],
    ['응답', 'msgs', true],
  ]
  cols.forEach(([head], i) => {
    if (seen.now.heads[i] !== head) {
      found.push(`${i + 1}번째 칸 제목이 '${seen.now.heads[i] ?? '없음'}'다. 여기는 '${head}'이다 — 기간 이름이 곧 계약이다`)
    }
  })
  if (seen.now.rows.length !== ROWS.length) {
    found.push(`표가 ${seen.now.rows.length}줄이다 — 출력·캐시 읽기·응답 세 줄이어야 한다`)
  } else {
    ROWS.forEach(([label, key, isCount], i) => {
      const row = seen.now.rows[i]
      if (row.head !== label) found.push(`${i + 1}번째 줄이 '${row.head}'다. 여기는 '${label}' 줄이다`)
      cols.forEach(([head, src], j) => {
        const v = src && typeof src[key] === 'number' && Number.isFinite(src[key]) ? src[key] : null
        const want = v === null ? '—' : isCount ? `${v.toLocaleString('ko-KR')}건` : fmtTokensLike(v)
        const shown = row.cells[j]
        if (shown !== want) found.push(`${head}의 ${label} 칸이 "${shown}"다 — 앱이 준 값은 "${want}"다`)
      })
    })
  }

  // 5) 플랜 — 앱이 준 것만 적고, 안 준 것은 지어내지 않는다
  if (st.plan && !seen.planShown) found.push(`앱이 플랜(${st.plan})을 줬는데 화면에 없다`)
  if (!st.plan && seen.planShown) found.push(`앱이 플랜을 주지 않았는데 화면에 "${seen.plan}"가 떠 있다`)

  // 6) 한도에 걸린 기록 — **리셋 시각이 실제로 화면에 있어야** 언제 다시 되는지 안다
  if (st.limitHit) {
    if (!seen.limitShown) found.push('한도에 걸린 기록이 있는데 화면에 그 줄이 없다')
    const d = st.limitHit.resetAt ? new Date(st.limitHit.resetAt) : null
    if (d && !Number.isNaN(d.getTime())) {
      const mm = String(d.getMinutes()).padStart(2, '0')
      const h12 = String(d.getHours() % 12 || 12).padStart(2, '0')
      const h24 = String(d.getHours()).padStart(2, '0')
      if (!all.includes(`${h12}:${mm}`) && !all.includes(`${h24}:${mm}`)) {
        found.push(`한도가 풀리는 시각(${h24}:${mm})이 화면에 없다 — 언제 다시 되는지 알 길이 없다`)
      }
    }
  } else if (seen.limitShown) {
    found.push('한도에 걸린 기록이 없는데 그 줄이 떠 있다')
  }

  // 7) 최근 14일 추이 — 앱이 준 날 수와 기둥 수가 같은가
  const list = st.ready && Array.isArray(st.days) ? st.days : []
  const dayCount = list.length
  if (seen.days !== dayCount) {
    found.push(`앱이 준 일별 기록은 ${dayCount}일인데 화면 기둥은 ${seen.days}개다`)
  }

  // 7-1) **기록을 다 보지 못한 날(partial)을 0으로 그리지 않는가.**
  //
  //  앱은 오래된 파일을 아예 열지 않는다. 그 범위의 날은 "안 썼다(0)"가 아니라
  //  "모른다(null)"인데, 바닥에 붙은 막대로 그리면 사용자는 그 주에 논 것으로 읽는다.
  //  기둥 수만 세는 검사로는 절대 안 잡힌다 — 수는 똑같고 높이만 0이기 때문이다.
  const unknownIdx = list.map((d, i) => (dayIsUnknown(d) ? i : -1)).filter((i) => i >= 0)
  const knownVals = list.filter((d) => !dayIsUnknown(d)).map((d) => d.output)
  if (unknownIdx.length && seen.cols.length === dayCount) {
    const drawn = unknownIdx.filter((i) => !seen.cols[i].unknown)
    if (drawn.length) {
      found.push(
        `기록을 못 본 날 ${drawn.length}칸(${unknownIdx.length}칸 중)을 아는 날처럼 그렸다 — 빈칸이어야 할 자리가 "안 썼다"로 읽힌다`,
      )
    }
    const flat = unknownIdx.filter((i) => seen.cols[i].unknown && seen.cols[i].h <= 3)
    if (flat.length) found.push(`못 본 날 ${flat.length}칸이 바닥에 붙어 있다 — 0 높이 막대는 "안 썼다"와 구별되지 않는다`)
    const mute = unknownIdx.filter((i) => !/모르|보지 못/.test(seen.cols[i].title))
    if (mute.length) found.push(`못 본 날 ${mute.length}칸에 그 사실을 알리는 설명이 없다`)
    // 안 쓴 날(0)까지 빈칸으로 그리면 반대쪽 거짓말이 된다 — 0은 어엿한 정보다.
    const zeroIdx = list.map((d, i) => (!dayIsUnknown(d) && d.output === 0 ? i : -1)).filter((i) => i >= 0)
    const blanked = zeroIdx.filter((i) => seen.cols[i].unknown)
    if (blanked.length) found.push(`실제로 안 쓴 날 ${blanked.length}칸을 "모른다"로 그렸다 — 0은 아는 값이다`)
    if (!seen.edges) {
      found.push('기록을 다 본 구간과 아닌 구간의 경계 표시가 차트에 없다 — 빈칸이 그냥 바닥으로 읽힌다')
    }
  }

  // 7-2) **가짜 0이 평균에 섞였는가.** 못 본 날을 0으로 세면 평균이 내려가고
  //      "오늘은 평소의 2.4배"처럼 틀린 문장이 나온다(사용자가 실제로 본 문장이다).
  if (knownVals.length > 1 && unknownIdx.length) {
    const past = knownVals.slice(0, -1)
    const sum = past.reduce((a, b) => a + b, 0)
    const wantAvg = fmtTokensLike(Math.round(sum / past.length))
    const fakeAvg = fmtTokensLike(Math.round(sum / (past.length + unknownIdx.length)))
    if (wantAvg !== fakeAvg && seen.trend.includes(fakeAvg)) {
      found.push(`평균에 못 본 날을 0으로 넣었다 — 화면 "${fakeAvg}" / 아는 날만 세면 "${wantAvg}"`)
    }
    const m = seen.trend.match(/(\d+)\s*일 평균/)
    if (m && Number(m[1]) !== past.length) {
      found.push(`평균을 낸 날 수가 다르다 (화면 ${m[1]}일 / 실제로 기록을 본 지난 날 ${past.length}일)`)
    }
    if (!m && seen.trend) notes.push(`추이 설명에서 평균을 낸 날 수를 읽지 못했다: "${seen.trend}"`)
  }

  // 8) **캐시 읽기가 출력의 몇 배인가.** 퍼센트를 걷어낸 뒤 이 화면이 남은 이유가
  //    이 숫자다 — Claude 화면에는 없고, 사용량을 줄이는 데 쓸모 있는 것은 이것뿐이다
  //    (실측: 출력 1.34M에 캐시 읽기 298.74M = 223배).
  //    **툴팁이 아니라 펼친 화면에서** 본다. 마우스를 올려 본 사람만 아는 정보는 없는 것과 같다.
  const times = cacheTimesOf(st.ready ? st.today : null)
  if (times !== null) {
    if (!new RegExp(`${times.toLocaleString('ko-KR')}\\s*배`).test(seen.cache)) {
      found.push(`캐시 읽기가 출력의 몇 배인지(${times}배) 펼친 화면에 없다 — "왜 이렇게 많이 썼지"의 답이 여기 있다`)
    }
    if (!/다시 읽|재사용/.test(seen.cacheNote)) {
      found.push('캐시 읽기가 무엇인지(대화가 길어 매 턴 앞의 내용을 다시 읽는 양) 설명이 없다 — 숫자만으로는 줄일 방법을 모른다')
    }
  } else if (st.ready && st.today) {
    // 출력이 0인 날(자정 직후)에는 **배수를 낼 수 없다.** 0으로 나눈 값을 적으면 안 된다.
    const fake = seen.cache.match(/[\d,]+\s*배|Infinity|NaN/)
    if (fake) found.push(`오늘 출력이 없는데 화면이 "${fake[0]}"라고 적었다 — 0으로는 나눌 수 없다`)
  }

  // 9) 큰 숫자를 자리수 그대로 쏟지 않는가 (좁은 상자에서 제일 먼저 무너지는 자리)
  const raw = st.today && typeof st.today.cacheRead === 'number' ? String(st.today.cacheRead) : ''
  if (raw.length >= 7 && all.includes(raw)) {
    found.push(`큰 숫자를 자리수 그대로 적었다 (${raw}) — 축약해야 한다`)
  }

  // (누를 것이 없어 '눌러 본 흐름'은 이 화면에 없다. 사용자가 정하는 값이 하나도 없기
  //  때문이고, 그것이 이 화면의 설계다 — 앱이 모르는 것을 사용자에게 정하게 하지 않는다.)
  return { found, ran, notes }
}

// ---------------------------------------------------------------------------
// 새 대화로 갈아타기 — **누른 뒤에야 드러나는 것들**
//
// 이 기능이 없던 동안 대화는 프로젝트마다 영구 고정이었고, 길어질수록 매 턴 앞 내용을
// 전부 다시 읽어 **같은 질문이 점점 비싸졌다**(실측: 198턴째에 첫 턴의 14배). 그래서
// 화면이 무게를 보여 주고 갈아탈 길을 준다. 여기서 보는 것:
//
//   - 화면의 숫자가 **앱이 준 값에서 나온 것인가** (지어낸 숫자인가)
//   - 기록이 없으면(null) **0으로 그리지 않는가** — 0은 "안 썼다"는 거짓말이다
//   - 첫 턴 값이 없으면 배수를 **적지 않는가** — 0으로 나눈 NaN·Infinity가 새어 나오는지
//   - 퍼센트가 없는가 (이 화면의 규칙 — 분모 없는 퍼센트는 전부 한도로 읽힌다)
//   - **확인 없이 갈아타지 않는가.** 누르자마자 바뀌면 맥락이 말없이 끊긴다
//   - 확인 창이 **무엇이 끊기고 무엇이 남는지** 말하는가 (옛 기록 파일은 지워지지 않는다)
//   - **인수인계 메모가 실제로 실려 가는가.** 이게 안 실리면 갈아타기는 그냥 맥락 삭제다
//   - 앱이 거절하면(`{ok:false, reason}`) **그 이유가 화면에 그대로 오는가**
//   - 갈아탄 뒤 화면이 **옛 무게를 그대로 들고 있지 않은가**
async function runSessionProbes(win) {
  const found = []
  const ran = []
  const notes = []
  const shots = []
  if (!S.startsWith('session')) return { found, ran, notes, shots }
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 앱이 실제로 준 값. **화면의 숫자는 전부 여기서 나와야 한다.**
  // (null과 '통로 없음'은 다른 것이라 감싸서 받는다.)
  const got = await js(
    `(async () => { const f = window.teamView && window.teamView.getSessionCost
       if (typeof f !== 'function') return { __noBridge: true }
       try { return { v: await f() } } catch (e) { return { __threw: String(e && e.message) } } })()`,
  )
  if (got.__noBridge) {
    found.push('이 갈래에는 대화 무게 통로가 있어야 하는데 없다')
    return { found, ran, notes, shots }
  }
  if (got.__threw) {
    found.push(`앱이 대화 무게를 묻자 예외를 던졌다: ${got.__threw}`)
    return { found, ran, notes, shots }
  }
  ran.push('새 대화 화면 대조')

  const cost = got.v ?? null
  // 화면을 보기 전에 **스텁부터 의심한다.** 스텁이 지어낸 모양 위에서 도는 검사는
  // 초록불이어도 아무것도 지켜 주지 못한다(이 저장소에서 두 번 났다).
  {
    const shape = sessionShapeProblems(cost)
    found.push(...shape.found)
    notes.push(...shape.notes)
  }

  // 검사 전용 통로가 화면 코드로 새지 않았는가. 새면 실물에는 없는 것 위에 화면이 선다.
  found.push(...spyLeakProblems())

  let seen = await js(READ_SESSION)
  if (!seen.secShown) {
    found.push('앱이 대화 무게 통로를 주는데 그 자리가 화면에 없다')
    return { found, ran, notes, shots }
  }

  const all = [seen.line, seen.note, seen.btnTitle].join(' ')
  // 1) 이 화면의 규칙 — **퍼센트를 쓰지 않는다.** 예외를 하나 두면 규칙이 무너진다.
  const pct = all.match(/[^\s]{0,12}%/)
  if (pct) found.push(`대화 무게에 퍼센트가 적혔다: "${pct[0]}" — 견줄 분모가 없어서 한도로 읽힌다`)
  // 2) 셈이 새어 나오지 않았는가(0으로 나눈 값·빈 값이 글자로 그대로 뜨는 자리다)
  const junk = all.match(/NaN|Infinity|undefined|\[object/)
  if (junk) found.push(`대화 무게에 셈이 그대로 새어 나왔다: "${junk[0]}"`)

  if (!cost) {
    // 3) **기록이 없다.** 여기서 숫자가 보이면 전부 지어낸 것이다.
    if (!/기록이 없/.test(seen.line)) {
      found.push(`기록이 없는데 화면이 "${seen.line}"라고 적었다 — "아직 기록이 없습니다"여야 한다`)
    }
    if (/\d/.test(seen.line)) found.push(`기록이 없는데 화면에 숫자가 적혔다: "${seen.line}"`)
    if (!seen.btnShown) found.push('[새 대화 시작]이 사라졌다 — 지금 못 하는 것은 감추지 않고 죽인다')
    if (seen.btnShown && !seen.btnDisabled) {
      found.push('시작할 대화가 없는데 [새 대화 시작]이 눌린다 — 눌러도 아무 일이 없는 버튼이 된다')
    }
    // 왜 못 누르는지가 **누르기 전에** 적혀 있어야 한다(툴팁만으로는 마우스를 올린 사람만 안다).
    if (!seen.note) found.push('버튼이 죽어 있는데 왜 안 되는지가 화면에 없다')
    // 눌러도 아무 일이 없어야 한다 — 죽은 버튼이 실제로 죽었는지 확인한다.
    const dead = await js(CLICK_SES_NEW)
    if (dead.dlgShown) found.push('죽어 있어야 할 [새 대화 시작]을 눌렀더니 확인 창이 열렸다')
    const calls = await js(SPY_CALLS)
    if (calls.length) found.push('시작할 대화가 없는데 앱에 갈아타기를 시켰다')
    return { found, ran, notes, shots }
  }

  // 4) **화면의 숫자가 앱이 준 값 그대로인가.**
  const turns = typeof cost.turns === 'number' ? cost.turns : null
  const last = typeof cost.lastRead === 'number' ? cost.lastRead : null
  if (turns !== null && !seen.line.includes(`${turns.toLocaleString('ko-KR')}개`)) {
    found.push(`응답 수가 화면에 없다 (앱 ${turns}개 / 화면 "${seen.line}")`)
  }
  if (last !== null && !seen.line.includes(fmtTokensLike(last))) {
    found.push(`매 턴 다시 읽는 양이 화면에 없다 (앱 ${fmtTokensLike(last)} / 화면 "${seen.line}")`)
  }
  // 5) **배수는 낼 수 있을 때만 적는다.** 첫 턴 값이 없으면(0으로 나눌 수 없으면) 없어야 한다.
  const growth = typeof cost.growth === 'number' && Number.isFinite(cost.growth) ? cost.growth : null
  const shownTimes = seen.line.match(/([\d,.]+)\s*배/)
  if (growth === null && shownTimes) {
    found.push(`첫 턴 값이 없어 배수를 낼 수 없는데 화면이 "${shownTimes[0]}"라고 적었다 — 0으로는 나눌 수 없다`)
  }
  if (growth !== null) {
    const want = growth >= 10 ? Math.round(growth).toLocaleString('ko-KR') : growth.toFixed(1)
    if (!shownTimes) found.push(`처음의 몇 배인지(${want}배)가 화면에 없다 — 이 줄이 갈아탈 이유다`)
    else if (shownTimes[1] !== want) found.push(`배수가 앱이 준 값과 다르다 (화면 ${shownTimes[1]} / 앱 ${want})`)
  }
  // 6) **무거우면 눈에 띄어야 한다.** 흐린 한 줄로 두면 정작 갈아타야 할 사람이 못 본다.
  if (cost.heavy) {
    if (seen.secBg === seen.plainBg && seen.lineColor === seen.plainColor) {
      found.push('무거운 대화인데 다른 줄과 똑같이 그려졌다 — 눈에 띄지 않으면 아무도 안 본다')
    }
    if (!/새 대화/.test(all)) found.push('무거운 대화인데 "새 대화를 시작하면 줄어든다"는 안내가 없다')
  }
  if (!seen.btnShown || seen.btnDisabled) {
    found.push('시작할 대화가 있는데 [새 대화 시작]을 누를 수 없다')
    return { found, ran, notes, shots }
  }

  // 7) **확인 없이 갈아타지 않는가.** 이 한 걸음이 없으면 맥락이 말없이 끊긴다.
  const opened = await js(CLICK_SES_NEW)
  if (!opened.dlgShown) {
    found.push('[새 대화 시작]을 눌렀는데 확인 창이 뜨지 않았다')
    const calls = await js(SPY_CALLS)
    if (calls.length) found.push('묻지도 않고 대화를 갈아탔다 — 맥락이 끊기는 일은 확인을 받아야 한다')
    return { found, ran, notes, shots }
  }
  const before = await js(SPY_CALLS)
  if (before.length) found.push('확인 창을 띄우면서 앱에 갈아타기를 먼저 시켰다 — 물어보나 마나가 된다')
  ran.push('새 대화 확인 창')

  const dlg = await js(READ_SESSION)
  // 무엇이 끊기고 **무엇이 남는지.** 특히 옛 기록이 지워지지 않는다는 말이 없으면
  // 사람은 이 버튼을 영영 안 누른다(지워질까 봐).
  // **"지워지지 않는다"는 말 그 자체**를 본다. '그대로 남는 것' 같은 제목만으로는
  // 무엇이 남는지 알 수 없고, 실제로 그 제목이 검사를 통과시켜 버린 적이 있다.
  if (!/지워지지 않|지우지 않/.test(dlg.dlgText)) {
    found.push('확인 창이 "옛 대화 기록은 지워지지 않는다"를 말하지 않는다 — 그러면 아무도 누르지 않는다')
  }
  // 여기도 **말 그 자체**를 본다('끊기는 것'이라는 제목만으로는 무엇이 끊기는지 모른다).
  if (!/기억하지 못|이어지지 않/.test(dlg.dlgText)) {
    found.push('확인 창이 무엇이 끊기는지(새 대화는 앞의 내용을 기억하지 못한다) 말하지 않는다')
  }
  if (!dlg.memoShown) found.push('확인 창에 인수인계 메모를 적을 칸이 없다 — 이게 없으면 갈아타기는 맥락 삭제일 뿐이다')
  if (!/선택|안 적어도/.test(dlg.dlgText)) found.push('인수인계 메모가 안 적어도 되는 것인지 화면이 말하지 않는다')
  // 왜 요약만 넘기는지 — 이 한 줄이 이 기능의 취지다(맥락을 통째로 끌고 가지 않는다).
  if (!/요약/.test(dlg.dlgText)) {
    found.push('메모가 무엇을 하는 것인지(맥락 대신 요약만 넘긴다) 확인 창에 없다')
  }
  // 확인 창이 떠 있는 지금을 잰다(잘림·대비·손닿는 크기 — 좁은 창에서 제일 먼저 무너진다).
  shots.push(await js(SCRIPT))

  // 8) **[그만두기]가 진짜 그만두는가.** 창만 닫고 갈아타 버리면 최악이다.
  await js(`document.getElementById('ses-cancel').click(); true`)
  await wait(300)
  const off = await js(READ_SESSION)
  if (off.dlgShown) found.push('[그만두기]를 눌렀는데 확인 창이 닫히지 않았다')
  if ((await js(SPY_CALLS)).length) found.push('[그만두기]를 눌렀는데 대화를 갈아탔다')
  ran.push('그만두기')
  const again = await js(CLICK_SES_NEW)
  if (!again.dlgShown) {
    found.push('그만둔 뒤 [새 대화 시작]을 다시 눌렀는데 확인 창이 열리지 않았다')
    return { found, ran, notes, shots }
  }

  // 9) 앱이 거절하는 갈래인가. **화면이 짐작하지 않고 앱의 답을 그대로 보이는지**를 본다.
  //    (거절 조건은 main.js와 같다 — 활성 프로젝트가 돌고 있으면 갈아타지 않는다.)
  const busy = await js(ACTIVE_BUSY)
  const memo = '결제 화면을 만들던 중. 카드사 응답은 흉내(mock)로 두기로 했다.'
  await js(typeMemo(memo))

  if (busy) {
    await js(`document.getElementById('ses-go').click(); true`)
    await wait(700)
    const after = await js(READ_SESSION)
    const calls = await js(SPY_CALLS)
    if (!calls.length) found.push('[새 대화 시작]을 눌렀는데 앱에 아무것도 시키지 않았다')
    if (!after.dlgShown) found.push('거절당했는데 확인 창이 닫혔다 — 적어 둔 메모까지 사라진다')
    if (!after.errShown) found.push('앱이 거절했는데 이유가 화면에 없다 — 왜 안 됐는지 알 길이 없다')
    else {
      const reasons = mainReasons()
      if (reasons.length && !reasons.some((r) => after.err.includes(r))) {
        found.push(`거절 이유가 앱이 주는 말과 다르다 (화면 "${after.err}" / 앱 ${reasons.map((r) => `"${r}"`).join(' · ')})`)
      }
    }
    if (after.memo !== memo) found.push('거절당했더니 적어 둔 인수인계 메모가 사라졌다')
    if (after.lineRaw !== seen.lineRaw) {
      found.push(`갈아타지 못했는데 무게 줄이 바뀌었다 (전 "${seen.lineRaw}" / 후 "${after.lineRaw}")`)
    }
    ran.push('시작 거절 이유 표시')
    return { found, ran, notes, shots }
  }

  // 10) **인수인계 메모가 실제로 실려 가는가.** 이게 안 실리면 새 대화는 아무것도 모른 채
  //    시작하고, 사용자는 같은 설명을 처음부터 다시 하게 된다(그러면 갈아탄 보람이 없다).
  await js(`document.getElementById('ses-go').click(); true`)
  await wait(900)
  const calls = await js(SPY_CALLS)
  if (!calls.length) {
    found.push('확인 창에서 [새 대화 시작]을 눌렀는데 앱에 아무것도 시키지 않았다')
    return { found, ran, notes, shots }
  }
  if (calls.length > 1) found.push(`한 번 눌렀는데 갈아타기를 ${calls.length}번 시켰다`)
  const arg = calls[0]
  if (!arg || typeof arg !== 'object') {
    found.push(`앱에 넘긴 값이 { handoff } 꼴이 아니다: ${JSON.stringify(arg)}`)
  } else if (arg.handoff !== memo) {
    found.push(`적은 인수인계 메모가 앱에 그대로 가지 않았다 (넘긴 것 ${JSON.stringify(arg.handoff)})`)
  }
  ran.push('인수인계 메모 전달')

  const done = await js(READ_SESSION)
  if (done.dlgShown) found.push('갈아탔는데 확인 창이 그대로 떠 있다')
  // 갈아탄 뒤에는 기록이 없다(앱도 그때 null을 준다). 옛 무게를 그대로 들고 있으면
  // 사용자는 갈아타기가 안 먹은 줄 안다.
  if (done.lineRaw === seen.lineRaw) {
    found.push(`갈아탔는데 무게 줄이 옛것 그대로다: "${done.lineRaw}"`)
  }
  return { found, ran, notes, shots }
}

/**
 * **검사 스텁이 프로덕션에 없는 모양을 지어내지 않았는가**(사용량과 같은 이유다).
 *
 * main.js `sessionCostFrom`에서 필드 이름과 heavy 기준을 그대로 떼어 와 맞대 본다.
 * 읽어 내지 못하면 실패로 치지 않고 알림만 남긴다 — 검사가 자기 자신을 속이지 않게.
 */
function sessionShapeProblems(cost) {
  const out = { found: [], notes: [] }
  if (!cost) return out
  let src
  try {
    src = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    out.notes.push('main.js를 읽지 못해 스텁이 계약대로인지는 대조하지 못했다')
    return out
  }
  const at = src.indexOf('turns: f.turns')
  const open = at < 0 ? -1 : src.lastIndexOf('{', at)
  const close = open < 0 ? -1 : src.indexOf('}', open)
  if (close < 0) {
    out.notes.push('main.js에서 대화 무게 필드를 읽지 못해 대조하지 못했다')
  } else {
    const want = src
      .slice(open + 1, close)
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .split(',')
      .map((p) => (p.split(':')[0] || '').trim())
      .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
    const got = Object.keys(cost)
    const invented = got.filter((k) => !want.includes(k))
    const missing = want.filter((k) => !got.includes(k))
    if (invented.length) out.found.push(`스텁이 대화 무게에 앱에 없는 필드를 실었다: ${invented.join(', ')}`)
    if (missing.length) out.found.push(`스텁이 대화 무게에서 앱의 필드를 빠뜨렸다: ${missing.join(', ')}`)
  }
  // 값도 앱이 낼 수 있는 것이어야 한다. 배수와 heavy는 계산으로 나오는 값이라
  // 스텁이 아무 숫자나 적어 두면 화면 대조가 통째로 헛돈다.
  const first = cost.firstRead
  const last = cost.lastRead
  if (first === 0) out.found.push('스텁의 firstRead가 0이다 — 앱은 잴 수 없는 값을 0이 아니라 null로 준다')
  const wantGrowth = first && typeof last === 'number' ? Math.round((last / first) * 10) / 10 : null
  if ((cost.growth ?? null) !== wantGrowth) {
    out.found.push(`스텁의 growth가 앱의 셈과 다르다 (스텁 ${cost.growth} / 셈 ${wantGrowth})`)
  }
  const readAt = mainNumber(src, 'SESSION_HEAVY_READ')
  const growAt = mainNumber(src, 'SESSION_HEAVY_GROWTH')
  if (readAt === null || growAt === null) {
    out.notes.push('main.js에서 heavy 기준을 읽지 못해 스텁의 heavy는 대조하지 못했다')
  } else {
    const wantHeavy = (last ?? 0) >= readAt || (wantGrowth !== null && wantGrowth >= growAt)
    if (Boolean(cost.heavy) !== wantHeavy) {
      out.found.push(`스텁의 heavy가 앱의 기준과 다르다 (스텁 ${cost.heavy} / 기준으로는 ${wantHeavy})`)
    }
  }
  return out
}

/** main.js의 상수 하나. 못 읽으면 null — 지어내지 않는다. */
function mainNumber(src, name) {
  const m = new RegExp(`^const ${name} = ([\\d_]+)`, 'm').exec(src)
  return m ? Number(m[1].replace(/_/g, '')) : null
}

/** 앱이 갈아타기를 거절할 때 쓰는 말. 화면이 다른 말을 지어내지 않았는지 대조한다. */
function mainReasons() {
  try {
    const src = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('function startNewSession(')
    if (at < 0) return []
    const body = src.slice(at, at + 2000)
    return [...body.matchAll(/reason:\s*'([^']+)'/g)].map((m) => m[1])
  } catch {
    return []
  }
}

/**
 * **검사 전용 통로가 화면 코드로 새지 않았는가.**
 *
 * 스텁은 "무엇을 들려 보냈는지"를 `__uiStubSpy`로 내준다. 그것을 렌더러가 쓰기 시작하면
 * 실물에는 없는 통로 위에 화면이 서게 된다 — 스텁만 `firstRunDone`을 실어 마법사가 죽은
 * 배선 위에 서 있던 사고와 같은 모양이다.
 */
function spyLeakProblems() {
  const out = []
  const dir = path.join(__dirname, '..', 'renderer')
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|html|css)$/.test(f)) continue
      if (fs.readFileSync(path.join(dir, f), 'utf8').includes('__uiStubSpy')) {
        out.push(`renderer/${f}가 검사 전용 통로(__uiStubSpy)를 쓰고 있다 — 실물에는 없는 통로다`)
      }
    }
  } catch {
    // 읽지 못했으면 잡을 것도 없다. 여기서 검사를 세우지는 않는다.
  }
  return out
}

/** 스텁이 받아 둔 갈아타기 요청. 문자열로 오므로 되돌려 읽는다. */
const SPY_CALLS = `(() => {
  const s = window.__uiStubSpy
  if (!s || typeof s.newSessionCalls !== 'function') return []
  return s.newSessionCalls().map((t) => { try { return JSON.parse(t) } catch { return t } })
})()`

/** 지금 보고 있는 회사가 돌고 있는가. 앱이 갈아타기를 거절하는 조건과 같은 값이다. */
const ACTIVE_BUSY = `(async () => {
  const r = await window.teamView.listProjects()
  const list = (r && r.projects) || []
  const p = list.find((x) => x.dir === (r && r.activeDir)) || list[0]
  return Boolean(p && p.company === 'busy')
})()`

const CLICK_SES_NEW = `(() => {
  const b = document.getElementById('usage-ses-new')
  const d = document.getElementById('ses-confirm')
  b.click()
  const s = getComputedStyle(d)
  return { dlgShown: !d.hidden && s.display !== 'none' && d.getBoundingClientRect().width > 0 }
})()`

const typeMemo = (memo) => `(() => {
  const ta = document.getElementById('ses-handoff')
  ta.value = ${JSON.stringify(memo)}
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return ta.value
})()`

/** 화면에서 읽어 오는 것. **보이는 글자만** 모은다(감춘 줄의 글이 섞이면 판정이 뒤집힌다). */
const READ_SESSION = `(() => {
  const vis = (e) => {
    if (!e) return false
    const s = getComputedStyle(e)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const visText = (root) => {
    if (!root) return ''
    let s = ''
    for (const n of root.childNodes) {
      if (n.nodeType === 3) { s += ' ' + n.textContent; continue }
      if (n.nodeType !== 1 || !vis(n)) continue
      s += ' ' + visText(n)
    }
    return s.replace(/\\s+/g, ' ').trim()
  }
  const sec = document.getElementById('usage-ses-sec')
  const line = document.getElementById('usage-ses')
  const btn = document.getElementById('usage-ses-new')
  const dlg = document.getElementById('ses-confirm')
  const err = document.getElementById('ses-err')
  const ta = document.getElementById('ses-handoff')
  // 무거운 대화가 **다른 줄과 다르게 보이는지**는 색으로 잰다(클래스 이름이 아니라).
  const plainSec = document.getElementById('usage-cache-sec')
  const plainLine = document.getElementById('usage-cache')
  return {
    secShown: vis(sec),
    secBg: sec ? getComputedStyle(sec).backgroundColor : '',
    plainBg: plainSec ? getComputedStyle(plainSec).backgroundColor : '',
    lineColor: line ? getComputedStyle(line).color : '',
    plainColor: plainLine ? getComputedStyle(plainLine).color : '',
    line: visText(line),
    // 확인 창이 떠 있는 동안에는 사용량 화면이 자리를 내주므로 보이는 글자가 비어 있다.
    // '갈아탄 뒤 옛 무게가 그대로인가'는 **보이든 말든 적힌 글자**로 견줘야 한다.
    lineRaw: line ? (line.textContent || '').trim() : '',
    note: visText(document.getElementById('usage-ses-note')),
    btnShown: vis(btn),
    btnDisabled: btn ? btn.disabled : null,
    btnTitle: (btn && btn.title) || '',
    dlgShown: vis(dlg),
    dlgText: visText(dlg),
    errShown: vis(err),
    err: visText(err),
    memoShown: vis(ta),
    memo: ta ? ta.value : null,
  }
})()`

// ---------------------------------------------------------------------------
// 한도 홀드 — **왜 안 도는지가 화면에 있는가**
//
// 한도로 실패하면 앱이 그 회사의 큐를 리셋 시각까지 붙잡아 둔다. 붙잡힌 동안 화면은
// 그냥 조용한 것과 구별되지 않아서, 사용자는 지시가 씹힌 줄 알고 같은 것을 또 보내거나
// [작업 취소]를 누른다. 여기서 보는 것:
//   - 붙잡혔는데 **화면이 아무 말도 안 하지 않는가**
//   - 멈춘 이유가 **앱이 준 말 그대로인가** (화면이 원인을 지어내지 않는가)
//   - 남은 시간이 **앱이 준 `until`에서 나온 것인가** · 언제 다시 도는지 시각이 있는가
//   - **대기 지시가 취소된 게 아니라는 것**이 분명한가 (이게 없으면 사용자가 취소해 버린다)
//   - 퍼센트가 없는가 · 셈이 글자로 새어 나오지 않는가
//   - 붙잡히지 않았으면 **아무것도 뜨지 않는가** (대기 지시가 있는 것과는 다른 상태다)
async function runHoldProbes(win) {
  const found = []
  const ran = []
  const notes = []
  if (!S.startsWith('hold')) return { found, ran, notes }
  const js = (code) => win.webContents.executeJavaScript(code)

  // 앱이 실제로 준 값. **화면의 글자는 전부 여기서 나와야 한다.**
  const got = await js(ACTIVE_HOLD)
  const seen = await js(READ_HOLD)
  const hold = got.hold ?? null

  if (!hold) {
    ran.push('홀드 없음 확인')
    // 대기 지시가 있는 것과 붙잡힌 것은 다른 상태다. 대기만 보고 안내를 띄우면 평소에도 뜬다.
    if (seen.shown) found.push(`붙잡히지 않았는데 멈춤 안내가 떠 있다: "${seen.text}"`)
    return { found, ran, notes }
  }
  ran.push('한도 홀드 화면 대조')

  // 화면을 보기 전에 **스텁부터 의심한다.** 스텁이 지어낸 모양 위에서 도는 검사는
  // 초록불이어도 아무것도 지켜 주지 못한다(이 저장소에서 두 번 났다).
  {
    const shape = holdShapeProblems(hold)
    found.push(...shape.found)
    notes.push(...shape.notes)
  }

  if (!seen.shown) {
    found.push('앱이 큐를 붙잡아 뒀는데 화면에 아무 말이 없다 — 사용자는 지시가 씹힌 줄 안다')
    return { found, ran, notes }
  }

  // 1) 이 앱의 규칙 — **퍼센트를 쓰지 않는다.** 분모 없는 퍼센트는 전부 한도로 읽힌다.
  const pct = seen.text.match(/[^\s]{0,12}%/)
  if (pct) found.push(`멈춤 안내에 퍼센트가 적혔다: "${pct[0]}" — 견줄 분모가 없어서 잘못 읽힌다`)
  const junk = seen.text.match(/NaN|Infinity|undefined|null|Invalid Date|\[object/)
  if (junk) found.push(`멈춤 안내에 셈이 그대로 새어 나왔다: "${junk[0]}"`)

  // 2) **이유는 앱이 준 말 그대로다.** 화면이 원인을 지어내면 숫자를 지어내는 것보다
  //    나쁘다 — 사용자가 엉뚱한 것을 고치러 간다.
  const reason = typeof hold.reason === 'string' ? hold.reason.trim() : ''
  if (!reason) {
    notes.push('앱이 이유를 주지 않아 이유 대조는 하지 못했다')
  } else {
    if (!seen.text.includes(reason)) {
      found.push(`멈춘 이유가 화면에 없다 (앱 "${reason}" / 화면 "${seen.text}")`)
    } else if (!seen.why.endsWith(reason)) {
      // 앱의 말 뒤에 화면이 자기 진단을 덧붙였다는 뜻이다.
      found.push(`화면이 앱이 준 이유 뒤에 말을 덧붙였다: "${seen.why}" (앱이 준 것은 "${reason}")`)
    }
  }

  // 3) **남은 시간은 `until`에서만 나온다.** 지어낸 시간이면 여기서 갈린다.
  const until = hold.until ? Date.parse(hold.until) : NaN
  if (Number.isNaN(until)) {
    if (!/알지 못|알 수 없/.test(seen.text)) {
      found.push('언제 풀리는지 앱이 주지 않았는데 화면이 그 사실을 말하지 않는다')
    }
  } else {
    // 화면을 그린 순간과 여기서 세는 순간이 1분 경계를 넘을 수 있다. 앞뒤 1분까지 인정한다.
    const wants = [until - Date.now(), until - Date.now() + 60_000, until - Date.now() - 60_000]
      .map(fmtLeftLike)
      .filter(Boolean)
    if (wants.length && !wants.some((w) => seen.text.includes(w))) {
      found.push(`남은 시간이 앱이 준 시각에서 나오지 않았다 (until로 세면 "${wants[0]}" / 화면 "${seen.when}")`)
    }
    const d = new Date(until)
    const mm = String(d.getMinutes()).padStart(2, '0')
    const h12 = String(d.getHours() % 12 || 12).padStart(2, '0')
    const h24 = String(d.getHours()).padStart(2, '0')
    if (!seen.text.includes(`${h12}:${mm}`) && !seen.text.includes(`${h24}:${mm}`)) {
      found.push(`다시 시작하는 시각(${h24}:${mm})이 화면에 없다 — "약 몇 시간 뒤"만으로는 언제인지 모른다`)
    }
  }

  // 4) **대기 중인 지시가 취소된 게 아니라는 것.** 이 말이 없으면 사용자는 [작업 취소]를
  //    누르거나 같은 지시를 다시 보낸다 — 그러면 붙잡아 둔 보람이 없다.
  if (!/취소되지 않|취소하지 않|취소되지는 않/.test(seen.text)) {
    found.push('대기 중인 지시가 취소된 것이 아니라는 말이 화면에 없다')
  }
  if (!/이어서|이어갑니다|이어서 처리/.test(seen.text)) {
    found.push('기다렸다가 그대로 이어서 처리한다는 말이 화면에 없다')
  }
  const queued = Number(got.queued) || 0
  if (queued > 0 && !seen.text.includes(`${queued}건`)) {
    found.push(`대기 중인 지시가 ${queued}건인데 화면에 그 수가 없다`)
  }
  return { found, ran, notes }
}

/**
 * **검사 스텁이 계약에 없는 모양을 지어내지 않았는가.**
 *
 * 홀드의 계약은 `{ until, reason } | null` 둘뿐이다. 화면이 읽기 편하라고 '남은 분' 같은
 * 편의 필드를 스텁만 실으면, 화면 검사는 통과하고 실물에서는 그 자리가 빈다(이 저장소가
 * 두 번 당한 사고다). 프로덕션이 이미 홀드를 내보내고 있으면 그쪽 필드와도 맞대 보고,
 * 아직 없으면 **알림만 남긴다** — 검사가 자기 자신을 속이지 않게.
 */
const HOLD_FIELDS = ['until', 'reason']
function holdShapeProblems(hold) {
  const out = { found: [], notes: [] }
  const got = Object.keys(hold)
  const invented = got.filter((k) => !HOLD_FIELDS.includes(k))
  const missing = HOLD_FIELDS.filter((k) => !got.includes(k))
  if (invented.length) out.found.push(`스텁이 홀드에 계약에 없는 필드를 실었다: ${invented.join(', ')}`)
  if (missing.length) out.found.push(`스텁이 홀드에서 계약 필드를 빠뜨렸다: ${missing.join(', ')}`)
  let src
  try {
    src = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    out.notes.push('main.js를 읽지 못해 홀드 계약을 프로덕션과 대조하지 못했다')
    return out
  }
  const at = src.search(/hold:\s*\{/)
  if (at < 0) {
    out.notes.push('main.js에 아직 홀드가 없어 계약을 프로덕션과 대조하지 못했다(백엔드 작업 중)')
    return out
  }
  const open = src.indexOf('{', at)
  const close = src.indexOf('}', open)
  const want = src
    .slice(open + 1, close)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .split(',')
    .map((p) => (p.split(':')[0] || '').trim())
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const only = (a, b) => a.filter((k) => !b.includes(k))
  if (only(got, want).length) out.found.push(`스텁의 홀드에 앱에 없는 필드가 있다: ${only(got, want).join(', ')}`)
  if (only(want, got).length) out.found.push(`스텁의 홀드가 앱의 필드를 빠뜨렸다: ${only(want, got).join(', ')}`)
  return out
}

/** renderer/app.js의 `fmtLeft`와 같은 셈. 화면에 적힌 남은 시간을 되짚어 보려면 필요하다.
 *  (형식이 어긋나면 이 검사가 시끄럽게 틀린다 — 조용히 통과하는 것보다 낫다.) */
function fmtLeftLike(ms) {
  if (!Number.isFinite(ms)) return null
  const m = Math.round(ms / 60_000)
  if (m <= 0) return null
  if (m < 60) return `약 ${m}분 뒤`
  if (m < 24 * 60) {
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest ? `약 ${h}시간 ${rest}분 뒤` : `약 ${h}시간 뒤`
  }
  return `약 ${Math.round(m / (24 * 60))}일 뒤`
}

/** 지금 보고 있는 회사의 홀드와 대기 건수. 화면이 읽는 것과 **같은 자리**에서 가져온다. */
const ACTIVE_HOLD = `(async () => {
  const r = await window.teamView.listProjects()
  const list = (r && r.projects) || []
  const p = list.find((x) => x.dir === (r && r.activeDir)) || list[0]
  return { hold: (p && p.hold) || null, queued: (p && p.queued) || 0 }
})()`

/** 멈춤 안내에서 읽어 오는 것. **보이는 글자만** 모은다(감춘 줄의 글이 섞이면 판정이 뒤집힌다). */
const READ_HOLD = `(() => {
  const vis = (e) => {
    if (!e) return false
    const s = getComputedStyle(e)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const visText = (root) => {
    if (!root) return ''
    let s = ''
    for (const n of root.childNodes) {
      if (n.nodeType === 3) { s += ' ' + n.textContent; continue }
      if (n.nodeType !== 1 || !vis(n)) continue
      s += ' ' + visText(n)
    }
    return s.replace(/\\s+/g, ' ').trim()
  }
  const box = document.getElementById('hold')
  return {
    shown: vis(box),
    text: visText(box),
    why: visText(document.getElementById('hold-why')),
    when: visText(document.getElementById('hold-when')),
    keep: visText(document.getElementById('hold-keep')),
  }
})()`

/**
 * 상단 사용량이 **있어야 할 자리에 있는가.** 모든 갈래에서 한 번씩 본다.
 *
 * 규칙은 단순하다: 통로(`getUsageStats`)가 있으면 앱은 **어떤 경우에도 객체를 준다**
 * (기록을 하나도 못 봤으면 `ready:false`). 그러니 숫자는 떠 있어야 하고, 통로가
 * 없을 때만 자리를 비운다. 이 한 줄이 없어서, 스텁이 새 PC에 `null`을 주며 지어낸
 * "사용량이 안 뜨는 상태"를 검사 전체가 몇 달 동안 지켜 주고 있었다.
 */
async function usagePresence(win) {
  const r = await win.webContents.executeJavaScript(`(async () => {
    const f = window.teamView && window.teamView.getUsageStats
    const bridge = typeof f === 'function'
    let obj = false
    if (bridge) { try { obj = Boolean(await f()) } catch { obj = false } }
    const g = document.getElementById('usage-btn')
    const s = g && getComputedStyle(g)
    const shown = Boolean(g && s.display !== 'none' && s.visibility !== 'hidden' && g.getBoundingClientRect().width > 0)
    return { bridge, obj, shown }
  })()`)
  const out = []
  // **통로가 있으면 답은 반드시 객체다.** 프로덕션 getUsageStats는 기록을 하나도 못
  // 봐도 `ready:false`인 객체를 돌려준다 — null은 앱이 낼 수 없는 답이고, 그 자리를
  // 검사 스텁이 지어내면 "새 PC에는 사용량이 없다"는 없는 화면을 검사가 지키게 된다.
  if (r.bridge && !r.obj) {
    out.push('통로는 있는데 사용량이 null이다 — 앱은 어떤 경우에도 객체를 준다(기록이 없으면 ready:false)')
  }
  if (r.bridge && r.obj && !r.shown) {
    out.push('앱이 사용량을 주는데 상단 숫자가 이 갈래에서 사라졌다 — 기록이 없어도 앱은 값을 준다')
  }
  if (!r.bridge && r.shown) out.push('사용량 통로가 없는데 상단에 숫자가 떠 있다')
  return out
}

/** 그 날의 값을 **모르는가**. `partial`이거나 output이 null이면 모르는 날이다.
 *  0은 모르는 것이 아니라 "안 썼다"는 아는 값이다 — 둘을 같게 보면 검사가 거짓말한다. */
function dayIsUnknown(d) {
  return !d || d.partial === true || typeof d.output !== 'number'
}

/**
 * **검사 스텁이 프로덕션에 없는 모양을 지어내지 않았는가.**
 *
 * 이 저장소가 이미 두 번 당했다. 스텁만 `firstRunDone`을 실어 마법사가 죽은 배선 위에
 * 서 있었고, 스텁만 `null`을 돌려줘 "새 PC에는 사용량이 안 뜬다"는 **도달 불가능한
 * 동작**을 검사가 지켜 주고 있었다. 화면 검사는 스텁이 준 값만 보므로, 스텁이 거짓말을
 * 하면 이 파일의 다른 검사들이 전부 초록불인 채로 실물만 깨진다.
 *
 * 그래서 main.js에서 **필드 이름을 그대로 떼어** 스텁 응답과 맞대 본다. 읽어 내지
 * 못하면 실패로 치지 않고 알림만 남긴다(검사가 자기 자신을 속이지 않게).
 * 예산이 계약에서 빠진 것도 여기서 지켜진다 — 스텁이 `budget`을 되살리면 앱에 없는
 * 필드로 잡힌다.
 */
function usageShapeProblems(st) {
  const out = { found: [], notes: [] }
  let src
  try {
    src = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    out.notes.push('main.js를 읽지 못해 스텁이 계약대로인지는 대조하지 못했다')
    return out
  }
  /** `from`이 가리키는 객체 리터럴의 키들. `back`이면 앵커 **앞쪽**에서 여는 괄호를 찾는다
   *  (여러 줄 객체는 앵커가 그 안에 있기 때문이다). 주석 줄은 이름 규칙에서 걸러진다. */
  const keysIn = (from, back) => {
    const at = src.indexOf(from)
    if (at < 0) return null
    const open = back ? src.lastIndexOf('{', at) : src.indexOf('{', at)
    const close = src.indexOf('}', open)
    if (open < 0 || close < 0) return null
    const keys = src
      .slice(open + 1, close)
      .replace(/^[ \t]*\/\/.*$/gm, '') // 주석을 먼저 지운다 — 그 안의 쉼표가 다음 키를 삼킨다
      .split(',')
      .map((p) => (p.split(':')[0] || '').trim())
      .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
    return keys.length ? { keys } : null
  }
  const cmp = (want, got, where) => {
    if (!want) {
      out.notes.push(`main.js에서 ${where} 필드를 읽지 못해 대조하지 못했다`)
      return
    }
    const invented = got.filter((k) => !want.keys.includes(k))
    const missing = want.keys.filter((k) => !got.includes(k))
    if (invented.length) out.found.push(`스텁이 ${where}에 앱에 없는 필드를 실었다: ${invented.join(', ')}`)
    if (missing.length) out.found.push(`스텁이 ${where}에서 앱의 필드를 빠뜨렸다: ${missing.join(', ')}`)
  }
  // 최상위는 늘 있다. 날짜 칸은 ready:true인 갈래에서만 볼 수 있다.
  cmp(keysIn('return { ready: false, plan, today: null'), Object.keys(st), '사용량 최상위')
  if (Array.isArray(st.days) && st.days.length) {
    cmp(keysIn('if (!covered.has(date)) return {'), Object.keys(st.days[0]), '못 본 날')
    cmp(keysIn('return { date, output: d.output'), Object.keys(st.days[st.days.length - 1]), '아는 날')
  }
  return out
}

/** renderer/app.js의 `fmtTokens`와 같은 셈. 화면에 적힌 숫자를 되짚어 보려면 필요하다.
 *  (형식이 어긋나면 이 검사가 시끄럽게 틀린다 — 조용히 통과하는 것보다 낫다.) */
function fmtTokensLike(n) {
  const v = Math.max(0, Math.round(n || 0))
  if (v < 10_000) return v.toLocaleString('ko-KR')
  if (v < 100_000_000) return `${(v / 10_000).toFixed(v < 100_000 ? 1 : 0)}만`
  return `${(v / 100_000_000).toFixed(2)}억`
}

/** 캐시 읽기가 출력의 몇 배인가. **출력이 0이면 배수는 없다** — 화면과 같은 셈이다. */
function cacheTimesOf(b) {
  if (!b) return null
  const read = b.cacheRead
  const out = b.output
  if (typeof read !== 'number' || typeof out !== 'number' || !Number.isFinite(read) || !Number.isFinite(out)) return null
  if (out <= 0) return null
  return Math.round(read / out)
}

/**
 * 화면에서 읽어 오는 것. **보이는 글자만 모은다** — textContent를 그대로 쓰면 감춘
 * 줄(집계 중 안내 등)의 글까지 섞여 "떠 있다"와 "숨겨져 있다"를 구별할 수 없다.
 */
const READ_USAGE = `(() => {
  const vis = (e) => {
    if (!e) return false
    const s = getComputedStyle(e)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const visText = (root) => {
    if (!root) return ''
    let s = ''
    for (const n of root.childNodes) {
      if (n.nodeType === 3) { s += ' ' + n.textContent; continue }
      if (n.nodeType !== 1 || !vis(n)) continue
      s += ' ' + visText(n)
    }
    return s.replace(/\\s+/g, ' ').trim()
  }
  const g = document.getElementById('usage-btn')
  const pop = document.getElementById('usage-pop')
  const spark = document.getElementById('usage-spark')
  // 차트 칸을 **하나하나** 본다. 개수만 세면 "못 본 날을 0으로 그렸다"가 안 잡힌다 —
  // 기둥 수는 똑같고 높이만 바닥에 붙기 때문이다.
  const cols = [...(spark ? spark.querySelectorAll('.usage-day') : [])].map((c) => ({
    unknown: c.classList.contains('unknown'),
    h: Math.round(c.getBoundingClientRect().height),
    title: c.title || '',
  }))
  // 숫자표. 첫 줄은 기간 이름(오늘 / 최근 7일), 나머지는 항목별 한 줄이다.
  const trs = [...document.querySelectorAll('#usage-now tr')]
  const heads = trs.length ? [...trs[0].querySelectorAll('th')].slice(1).map(visText) : []
  const rows = trs.slice(1).map((tr) => {
    const tds = [...tr.querySelectorAll('td')]
    return { head: visText(tds[0]), cells: tds.slice(1).map(visText) }
  })
  const disclaim = document.getElementById('usage-disclaim')
  return {
    btnShown: vis(g),
    sum: visText(document.getElementById('usage-sum')),
    tip: (g && g.title) || '',
    popShown: vis(pop),
    popText: visText(pop),
    plan: visText(document.getElementById('usage-plan')),
    planShown: vis(document.getElementById('usage-plan')),
    stateShown: vis(document.getElementById('usage-state')),
    disclaimShown: vis(disclaim),
    disclaim: visText(disclaim),
    limitShown: vis(document.getElementById('usage-limit')),
    now: { heads, rows },
    cache: visText(document.getElementById('usage-cache')),
    cacheNote: visText(document.getElementById('usage-cache-note')),
    days: cols.length,
    cols,
    edges: spark ? spark.querySelectorAll('.usage-edge').length : 0,
    sparkLabel: (spark && spark.getAttribute('aria-label')) || '',
    trend: visText(document.getElementById('usage-trend-note')),
  }
})()`

// 페이지 안에서 도는 검사. 문자열이라 여기 백틱을 쓰면 안 된다(한 번 깨뜨렸다).
const SCRIPT = `(() => {
  const out = { 잘림: [], 줄바꿈: [], 손닿는크기: [], 접근이름없음: [], 겹침: [], 대비: [], 죽은버튼: [], 숨김실패: [], 가로넘침: [], 가림: [] }
  const vis = (e) => {
    const s = getComputedStyle(e)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const name = (e) => (e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName.toLowerCase())
  const text = (e) => (e.textContent || '').trim().slice(0, 30)

  // 1) 내용이 상자보다 커서 잘리는가
  for (const e of document.querySelectorAll('button, .tab, .target, .msg, #status, #now, .out-title, .out-path, h2, p')) {
    if (!vis(e)) continue
    const cut = e.scrollWidth - e.clientWidth
    if (cut > 1 && getComputedStyle(e).overflow !== 'visible') out.잘림.push({ 요소: name(e), 넘침px: cut, 글: text(e) })
  }

  // 2) 버튼 글자가 두 줄로 쪼개지는가 (넘침이 아니라 줄바꿈이라 1)에 안 걸린다)
  for (const e of document.querySelectorAll('#bar button, .send-row button, .chat-tools button, .target')) {
    if (!vis(e)) continue
    const cs = getComputedStyle(e)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const inner = e.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    if (inner > lh * 1.6) out.줄바꿈.push({ 요소: name(e), 글: text(e) })
  }

  // 3) 누르는 것이 손에 닿는 크기인가
  for (const e of document.querySelectorAll('button, [role="button"], a[href], [tabindex]')) {
    if (!vis(e) || e.tabIndex < 0) continue
    const r = e.getBoundingClientRect()
    if (r.height < ${MIN_HIT} || r.width < ${MIN_HIT}) {
      out.손닿는크기.push({ 요소: name(e), 크기: Math.round(r.width) + 'x' + Math.round(r.height), 글: text(e) })
    }
  }

  // 4) 스크린리더가 읽을 이름이 있는가
  for (const e of document.querySelectorAll('button, [role="button"], [role="separator"], a[href]')) {
    if (!vis(e)) continue
    if (!text(e) && !e.getAttribute('aria-label') && !e.title) out.접근이름없음.push(name(e))
  }

  // 5) 상단바 요소끼리 겹치는가
  const bar = [...document.querySelector('#bar').children].filter(vis).map((e) => ({ n: name(e), r: e.getBoundingClientRect() }))
  for (let i = 0; i < bar.length; i++) for (let j = i + 1; j < bar.length; j++) {
    const a = bar[i].r, b = bar[j].r
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (ox > 1 && oy > 1) out.겹침.push(bar[i].n + ' ↔ ' + bar[j].n)
  }

  // 6) 글자 대비 (WCAG AA — 본문 4.5:1, 큰 글자 3:1)
  //    **반투명 배경을 합성해서** 재야 한다. 알파를 무시하면 배너 위 글자가
  //    대비 1.00으로 나오는 가짜 경보가 뜬다.
  const parse = (c) => {
    const m = (c || '').match(/[0-9.]+/g)
    return m ? { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] } : null
  }
  const over = (f, b) => ({ r: f.r*f.a + b.r*(1-f.a), g: f.g*f.a + b.g*(1-f.a), b: f.b*f.a + b.b*(1-f.a), a: 1 })
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4) }
    return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b)
  }
  const bgOf = (e) => {
    const stack = []
    let n = e
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) { stack.push(c); if (c.a === 1) break }
      n = n.parentElement
    }
    let base = { r: 17, g: 19, b: 26, a: 1 }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base)
    return base
  }
  for (const e of document.querySelectorAll('button, .target, .msg, #status, #now, .out-meta, .out-who, .out-dir, p, span, a')) {
    if (!vis(e)) continue
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    const cs = getComputedStyle(e)
    const fg = parse(cs.color)
    if (!fg) continue
    const l1 = lum(fg), l2 = lum(bgOf(e))
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5
    if (ratio < need) out.대비.push({ 요소: name(e), 비율: ratio.toFixed(2), 필요: need, 크기: size, 글: text(e) })
  }

  // 7) 프로젝트가 없는데 눌리는 버튼이 있는가
  if (document.querySelectorAll('#tabs .tab').length === 0) {
    for (const id of ['chat-cancel', 'copy-all', 'toggle-tools']) {
      const e = document.getElementById(id)
      if (e && vis(e) && !e.disabled) out.죽은버튼.push('#' + id)
    }
    const chips = [...document.querySelectorAll('#targets .target')].filter((e) => !e.disabled)
    if (chips.length) out.죽은버튼.push('팀원 칩 ' + chips.length + '개')
  }

  // 8) hidden인데 화면에 남아 있는가 (display를 주면 [hidden]이 안 먹는다)
  for (const e of document.querySelectorAll('[hidden]')) {
    if (vis(e)) out.숨김실패.push({ 요소: name(e), display: getComputedStyle(e).display })
  }

  // 9) 창 밖으로 삐져나가는가
  const d = document.documentElement
  if (d.scrollWidth > d.clientWidth + 1) out.가로넘침.push(d.scrollWidth + ' > ' + d.clientWidth)

  // 10) 이름표가 **위에 떠야 할 것**을 뚫고 나오는가
  //     app.js는 이름표가 서로를 덮지 않게 z-index를 매긴다. 그 규칙은 사무실 안에서만
  //     통해야 하는데, 가둬 두지 않으면 그 숫자가 문서 최상위에서 경쟁해 마법사·☰·
  //     팀원 패널·안내를 뚫는다(실측: 마법사 z 90을 이름표 17개가 전부 가렸다).
  //     한 장을 재는 방식으로는 안 잡힌다 — **칠하는 순서**를 봐야 한다.
  //     #overlay가 pointer-events:none이라 hit-test에 안 잡히므로 재는 동안만 켠다.
  //     (pointer-events는 칠하는 순서를 바꾸지 않으므로 이 방법은 정직하다.)
  const COVERS = ['#wizard', '#ses-confirm', '#welcome', '#menu-pop', '#team-pop', '#usage-pop', '#need', '#env']
  const ovl = document.getElementById('overlay')
  const tags = [...document.querySelectorAll('#overlay .tag, #overlay .bubble')].filter(vis)
  if (ovl && tags.length) {
    const keep = ovl.style.pointerEvents
    ovl.style.pointerEvents = 'auto'
    for (const sel of COVERS) {
      const cover = document.querySelector(sel)
      if (!cover || !vis(cover)) continue
      const cr = cover.getBoundingClientRect()
      for (const t of tags) {
        const r = t.getBoundingClientRect()
        const x1 = Math.max(r.left, cr.left), x2 = Math.min(r.right, cr.right)
        const y1 = Math.max(r.top, cr.top), y2 = Math.min(r.bottom, cr.bottom)
        if (x2 - x1 <= 1 || y2 - y1 <= 1) continue // 겹치지 않으면 볼 것이 없다
        const stack = document.elementsFromPoint((x1 + x2) / 2, (y1 + y2) / 2)
        const ti = stack.indexOf(t)
        const ci = stack.findIndex((e) => e === cover || cover.contains(e))
        if (ti >= 0 && ci >= 0 && ti < ci) {
          // 덮개 하나당 한 줄만 적는다 — 열일곱 줄이 쏟아지면 읽히지 않는다.
          out.가림.push({ 가린것: sel, 이름표: text(t), zIndex: t.style.zIndex, 겹친이름표수: tags.length })
          break
        }
      }
    }
    ovl.style.pointerEvents = keep
  }

  return out
})()`
