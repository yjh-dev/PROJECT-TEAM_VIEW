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

  await win.loadFile(path.join(RENDERER, 'index.html'))
  await new Promise((r) => setTimeout(r, 2600)) // 상태 반영·첫 렌더 대기

  let out
  try {
    out = await win.webContents.executeJavaScript(SCRIPT)
  } catch (err) {
    clearTimeout(bail)
    console.log(JSON.stringify({ 시나리오: S, 오류: ['검사 스크립트 실패: ' + (err?.message ?? err)] }))
    app.exit(1)
    return
  }
  clearTimeout(bail)

  out.손닿는크기 = out.손닿는크기.filter((i) => !HIT_EXEMPT.has(i.요소))
  out.오류 = errors
  console.log(JSON.stringify({ 시나리오: S, 창: `${W}x${H}`, ...out }))
  app.quit()
})

// 페이지 안에서 도는 검사. 문자열이라 여기 백틱을 쓰면 안 된다(한 번 깨뜨렸다).
const SCRIPT = `(() => {
  const out = { 잘림: [], 줄바꿈: [], 손닿는크기: [], 접근이름없음: [], 겹침: [], 대비: [], 죽은버튼: [], 숨김실패: [], 가로넘침: [] }
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

  return out
})()`
