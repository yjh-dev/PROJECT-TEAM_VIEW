// 쿼터뷰 도트 캐릭터. 14x20 그리드를 코드로 찍는다.
//
// 단순한 실루엣이 아이소메트릭 배경에서 더 잘 읽힌다. 그래서 얼굴 이목구비는
// 눈 두 점만 남기고, 부피는 **밝은 면/그늘 면 두 단계**로만 표현한다.
// 광원은 왼쪽 위. 대문자가 밝은 면, 소문자가 그늘.
//
//   H/h 머리   F/f 얼굴·팔   E 눈   S/s 상의   P/p 하의   B/b 신발   K 포인트(옷깃)
//   . 투명
//
// 캐릭터는 화면 오른쪽 아래(남동)를 본다. 왼쪽으로 갈 때는 좌우 반전.

const W = 14
const H = 20

const IDLE_A = [
  '....HHHHHH....',
  '...HHHHHHHh...',
  '..HHHHHHHHhh..',
  '..HHFFFFFFhh..',
  '..HhFFFFFFfh..',
  '..HhFEFFEFff..',
  '...hFFFFFFff..',
  '....fFFFFff...',
  '....KKKKKK....',
  '..SSSSSSSSss..',
  '.FSSSSSSSSssF.',
  '.FSSSSSSSSssF.',
  '.fSSSSSSSSssf.',
  '...SSSSSSss...',
  '...PPPPPPpp...',
  '...PPP.Ppp....',
  '...PPP.Ppp....',
  '...PPP.Ppp....',
  '..BBBB.BBbb...',
  '..BBBB.BBbb...',
]

const IDLE_B = ['..............', ...IDLE_A.slice(0, 19)]

const WALK_A = [
  '....HHHHHH....',
  '...HHHHHHHh...',
  '..HHHHHHHHhh..',
  '..HHFFFFFFhh..',
  '..HhFFFFFFfh..',
  '..HhFEFFEFff..',
  '...hFFFFFFff..',
  '....fFFFFff...',
  '....KKKKKK....',
  '..SSSSSSSSss..',
  'F.SSSSSSSSss..',
  'FSSSSSSSSSssF.',
  'fSSSSSSSSSssf.',
  '...SSSSSSss...',
  '...PPPPPPpp...',
  '..PPPP.Ppp....',
  '..PPP..Pppp...',
  '.PPP....Ppp...',
  '.BBBB...BBbb..',
  'BBBB.....BBbb.',
]

const WALK_B = [
  '....HHHHHH....',
  '...HHHHHHHh...',
  '..HHHHHHHHhh..',
  '..HHFFFFFFhh..',
  '..HhFFFFFFfh..',
  '..HhFEFFEFff..',
  '...hFFFFFFff..',
  '....fFFFFff...',
  '....KKKKKK....',
  '..SSSSSSSSss..',
  '..SSSSSSSSssF.',
  '.FSSSSSSSSssF.',
  '.fSSSSSSSSssf.',
  '...SSSSSSss...',
  '...PPPPPPpp...',
  '...PPPPpp.....',
  '...PPPpp......',
  '...PPpp.......',
  '..BBBbb.......',
  '..BBBbb.......',
]

// 앉은 자세 — 엉덩이가 좌판에, 종아리가 앞(화면 아래)으로 내려와 발이 바닥에 닿는다.
//
// 전에는 위 두 줄을 비우고 종아리를 두 줄만 뒀다. 그러면 **엉덩이를 좌판에 맞추면
// 발이 공중에 뜨고, 발을 바닥에 맞추면 몸이 등받이 높이로 올라간다** — 실제로
// "등받이에 앉은 것 같다"는 모양이 그래서 나왔다. 위 여백을 걷어 몸을 올리고
// 그만큼 종아리를 늘려, 한 자세에서 두 조건이 동시에 맞게 했다.
//
//   허벅지 밑면 = 아래에서 4px(= 좌판 윗면) · 신발 바닥 = 맨 아랫줄(= 바닥)
//   → 좌석 높이가 다른 소파·빈백도 app.js의 SEAT_LIFT 값 하나로 맞출 수 있다.
//
// 몸통은 **서 있을 때와 같은 5줄**이다. 앉는다고 상체가 줄지는 않는다.
// 전에는 몸통 3줄에 손만 있는 빈 줄을 끼워 넣어, 배 부분이 뚫린 채로 의자에
// 파묻힌 것처럼 보였다.
const SIT_A = [
  '....HHHHHH....',
  '...HHHHHHHh...',
  '..HHHHHHHHhh..',
  '..HHFFFFFFhh..',
  '..HhFFFFFFfh..',
  '..HhFEFFEFff..',
  '...hFFFFFFff..',
  '....fFFFFff...',
  '....KKKKKK....',
  '..SSSSSSSSss..',
  '.FSSSSSSSSssF.',
  '.FSSSSSSSSssF.',
  '.FFSSSSSSSsFF.',
  '..ffSSSSSSff..',
  '...PPPPPPpp...',
  '..PPPPPPPppp..',
  '..PPP....ppp..',
  '..PPP....ppp..',
  '..PPP....ppp..',
  '..BBB....bbb..',
]

// 타이핑 — 어깨와 손만 한 픽셀 움직인다. 다리는 고정(앉아서 발을 흔들지 않는다).
const SIT_B = [
  '....HHHHHH....',
  '...HHHHHHHh...',
  '..HHHHHHHHhh..',
  '..HHFFFFFFhh..',
  '..HhFFFFFFfh..',
  '..HhFEFFEFff..',
  '...hFFFFFFff..',
  '....fFFFFff...',
  '....KKKKKK....',
  '..SSSSSSSSss..',
  '.FSSSSSSSSssF.',
  '..FSSSSSSSssF.',
  '..FFSSSSSSFF..',
  '...ffSSSSff...',
  '...PPPPPPpp...',
  '..PPPPPPPppp..',
  '..PPP....ppp..',
  '..PPP....ppp..',
  '..PPP....ppp..',
  '..BBB....bbb..',
]

export const POSES = {
  idle: [IDLE_A, IDLE_B],
  walk: [WALK_A, WALK_B],
  sit: [SIT_A, SIT_B],
}

export const SPRITE_W = W
export const SPRITE_H = H

function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * k))),
  )
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function makePalette({ hair, shirt, accent, skin = '#f2caa4' }) {
  const pants = '#414a63'
  const shoes = '#262b36'
  return {
    H: hair,
    h: shade(hair, 0.7),
    F: skin,
    f: shade(skin, 0.76),
    E: '#2a2233',
    S: shirt,
    s: shade(shirt, 0.72),
    P: pants,
    p: shade(pants, 0.72),
    B: shoes,
    b: shade(shoes, 0.72),
    K: accent,
  }
}

/**
 * (x, y)는 **논리 좌표**의 발밑 중앙. 배경과 같은 배율로 확대된다.
 * yOffset은 앉을 때처럼 살짝 내려 그릴 때 쓴다.
 */
export function drawSprite(ctx, frame, palette, x, y, scale, flip = false, yOffset = 0) {
  const ox = x * scale - (W * scale) / 2
  const oy = (y + yOffset) * scale - H * scale

  // 소수 배율에서도 도트가 흐려지지 않게 각 픽셀의 시작·끝을 반올림해서 채운다.
  const px = (i) => Math.round(ox + i * scale)
  const py = (i) => Math.round(oy + i * scale)

  const paint = (color, dx, dy) => {
    ctx.fillStyle = color
    for (let row = 0; row < frame.length; row++) {
      const line = frame[row]
      const y0 = py(row + dy)
      const y1 = py(row + dy + 1)
      for (let col = 0; col < line.length; col++) {
        if (line[col] === '.') continue
        if (color === null) continue
        const cx = flip ? W - 1 - col : col
        const x0 = px(cx + dx)
        const x1 = px(cx + dx + 1)
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
      }
    }
  }

  // 옅은 외곽 — 밝은 바닥 위에서 실루엣이 묻히지 않게 한다
  paint('rgba(70,52,34,0.22)', 0.5, 0.5)

  for (let row = 0; row < frame.length; row++) {
    const line = frame[row]
    const y0 = py(row)
    const y1 = py(row + 1)
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (ch === '.') continue
      const color = palette[ch]
      if (!color) continue
      const cx = flip ? W - 1 - col : col
      const x0 = px(cx)
      const x1 = px(cx + 1)
      ctx.fillStyle = color
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    }
  }
}
