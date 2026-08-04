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

const RENDERER = path.join(__dirname, '..', 'renderer')
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
  const COVERS = ['#wizard', '#welcome', '#menu-pop', '#team-pop', '#need', '#env']
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
