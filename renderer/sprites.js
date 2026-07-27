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

// 앉은 자세 — 의자에 앉아 무릎이 앞(화면 아래)으로 나온다.
// 머리 위치가 서 있을 때보다 낮아야 앉은 것으로 읽히므로 위쪽을 비운다.
const SIT_A = [
  '..............',
  '..............',
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
  '.FFSSSSSSSsFF.',
  '..ff......ff..',
  '...PPPPPPpp...',
  '..PPPPPPPppp..',
  '..PPP....ppp..',
  '..BBB....bbb..',
  '..............',
]

const SIT_B = [
  '..............',
  '..............',
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
  '..FFSSSSSSFF..',
  '...ff....ff...',
  '...PPPPPPpp...',
  '..PPPPPPPppp..',
  '..PPP....ppp..',
  '..BBB....bbb..',
  '..............',
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
  const ox = Math.round(x * scale - (W * scale) / 2)
  const oy = Math.round((y + yOffset) * scale - H * scale)

  // 옅은 외곽 — 밝은 바닥 위에서 실루엣이 묻히지 않게 한다
  ctx.fillStyle = 'rgba(70,52,34,0.22)'
  for (let row = 0; row < frame.length; row++) {
    const line = frame[row]
    for (let col = 0; col < line.length; col++) {
      if (line[col] === '.') continue
      const cx = flip ? W - 1 - col : col
      ctx.fillRect(ox + cx * scale + scale, oy + row * scale + scale, scale, scale)
    }
  }

  for (let row = 0; row < frame.length; row++) {
    const line = frame[row]
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (ch === '.') continue
      const color = palette[ch]
      if (!color) continue
      const cx = flip ? W - 1 - col : col
      ctx.fillStyle = color
      ctx.fillRect(ox + cx * scale, oy + row * scale, scale, scale)
    }
  }
}
