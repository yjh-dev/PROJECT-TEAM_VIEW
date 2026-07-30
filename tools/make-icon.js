// 앱 아이콘을 **코드로** 그린다.
//
//   node_modules/electron/dist/electron.exe tools/make-icon.js
//
// 이 앱은 캐릭터도 가구도 이미지 파일 없이 픽셀로 찍는다. 아이콘만 그림판에서
// 만들어 붙이면 톤이 어긋나고, 고치려면 원본 파일을 찾아 헤매야 한다. 같은 방식으로
// 그려 두면 색 하나 바꾸는 일이 코드 한 줄이 된다.
//
// 32×32로 그린 뒤 nearest-neighbor로 키운다 — 도트는 뭉개지면 안 된다.
// 결과는 build/icon.ico (16·32·48·64·128·256 여섯 장을 한 파일에).
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT_DIR = path.join(__dirname, '..', 'build')
const SIZES = [16, 32, 48, 64, 128, 256]

// 32×32 도트 그림. 앱의 팔레트를 그대로 쓴다.
const ART = `
(() => {
  const S = 32
  const c = document.createElement('canvas')
  c.width = S; c.height = S
  const x = c.getContext('2d')
  const px = (gx, gy, w, h, fill) => { x.fillStyle = fill; x.fillRect(gx, gy, w, h) }

  // 배경 — 앱 화면과 같은 남색. 모서리를 한 칸씩 깎아 둥글게 보이게 한다.
  px(0, 0, S, S, '#1b2030')
  for (const [ox, oy] of [[0,0],[S-2,0],[0,S-2],[S-2,S-2]]) px(ox, oy, 2, 2, '#00000000')
  x.clearRect(0, 0, 2, 2); x.clearRect(S-2, 0, 2, 2)
  x.clearRect(0, S-2, 2, 2); x.clearRect(S-2, S-2, 2, 2)

  // **요소를 둘로 줄인다.** 처음에는 책상·모니터·캐릭터를 다 넣었더니 16px에서
  // 서로 뭉개져 무엇인지 알 수 없었다. 켜진 모니터 하나면 이 앱이 말하려는 것
  // (지금 팀이 일하는 중)이 전해진다.

  // 모니터 — 화면을 크게. 이 앱에서 켜진 화면은 '일하는 중'이라는 신호다.
  px(5, 5, 22, 16, '#2b3346')      // 프레임
  px(7, 7, 18, 12, '#7dcfff')      // 화면
  px(9, 10, 10, 2, '#1b2030')      // 화면 안 글줄 — 무언가 쓰이는 중
  px(9, 14, 14, 2, '#1b2030')
  px(15, 21, 2, 3, '#2b3346')      // 목

  // 책상 — 아래를 받쳐 화면이 떠 보이지 않게. 두 줄이면 충분하다.
  px(4, 24, 24, 2, '#c9a97e')
  px(4, 26, 24, 1, '#a8875f')

  return c.toDataURL('image/png')
})()
`

/** 32×32 원본을 nearest-neighbor로 키워 PNG 버퍼를 만든다. */
const SCALE = (dataUrl, size) => `
(() => new Promise((res) => {
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = ${size}; c.height = ${size}
    const x = c.getContext('2d')
    x.imageSmoothingEnabled = false
    x.drawImage(img, 0, 0, ${size}, ${size})
    res(c.toDataURL('image/png'))
  }
  img.src = ${JSON.stringify(dataUrl)}
}))()
`

/**
 * PNG 여러 장을 ICO 한 파일로 묶는다.
 *
 * ICO는 Vista부터 PNG를 그대로 담을 수 있어서 별도 인코더가 필요 없다. 이 앱은
 * 런타임 의존성이 0개인데 아이콘 하나 만들자고 라이브러리를 들일 이유가 없다.
 */
function buildIco(pngs) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // 예약
  head.writeUInt16LE(1, 2) // 1 = 아이콘
  head.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 256은 0으로 적는 규칙
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // 팔레트 없음
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4) // 색 평면 수
    e.writeUInt16LE(32, 6) // 32비트
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += buf.length
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.buf)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 })
  await win.loadURL('data:text/html,<body></body>')

  const base = await win.webContents.executeJavaScript(ART)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const pngs = []
  for (const size of SIZES) {
    const url = await win.webContents.executeJavaScript(SCALE(base, size))
    pngs.push({ size, buf: Buffer.from(url.split(',')[1], 'base64') })
  }
  // 256짜리는 미리보기·문서용으로, 16짜리는 **작은 크기에서 뭉개지지 않는지**
  // 눈으로 보려고 따로 남긴다(작업표시줄·탐색기에서 실제로 보이는 크기다).
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngs[pngs.length - 1].buf)
  fs.writeFileSync(path.join(OUT_DIR, 'icon-16.png'), pngs[0].buf)
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(pngs))

  console.log('icon.ico 생성 —', SIZES.join('·'), 'px,', fs.statSync(path.join(OUT_DIR, 'icon.ico')).size, 'bytes')
  app.quit()
})
