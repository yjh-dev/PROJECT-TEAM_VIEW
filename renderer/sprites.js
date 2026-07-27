// 쿼터뷰(아이소메트릭) 도트 캐릭터. 16x24 그리드를 코드로 찍는다.
//
// 3D처럼 보이게 하는 핵심은 **한 색을 두 단계로 쓰는 것**이다. 광원을 왼쪽 위에 두고
// 대문자는 밝은 면, 소문자는 그늘진 면으로 칠한다. 그래서 팔레트 키가 쌍으로 있다.
//
//   H/h 머리   F/f 얼굴·피부   E 눈   S/s 상의   A/a 팔   P/p 하의   B/b 신발   K 포인트
//   . 투명
//
// 캐릭터는 화면 오른쪽 아래(남동)를 바라본다. 왼쪽으로 갈 때는 좌우 반전해서 남서를 본다.

const W = 16
const H = 24

const IDLE_A = [
  '......HHHH......',
  '....HHHHHHHh....',
  '...HHHHHHHHhh...',
  '..HHHFFFFFFhh...',
  '..HHFFFFFFFfh...',
  '..HhFFEFFEFff...',
  '...hFFFFFFFff...',
  '...hFFFFFFff....',
  '....fFFFFff.....',
  '.....KKKKK......',
  '...SSSSSSSSs....',
  '..SSSSSSSSSss...',
  '..SSSSSSSSSss...',
  '.ASSSSSSSSSssA..',
  '.ASSSSSSSSSssA..',
  '.aSSSSSSSSSssa..',
  '...SSSSSSSss....',
  '...PPPPPPPpp....',
  '...PPPP.Ppp.....',
  '...PPP..Ppp.....',
  '...PPP..Ppp.....',
  '..BBBB..BBbb....',
  '.BBBBB..BBBbb...',
  '................',
]

// 숨쉬기 — 한 픽셀 내려앉는다
const IDLE_B = ['................', ...IDLE_A.slice(0, 23)]

const WALK_A = [
  '......HHHH......',
  '....HHHHHHHh....',
  '...HHHHHHHHhh...',
  '..HHHFFFFFFhh...',
  '..HHFFFFFFFfh...',
  '..HhFFEFFEFff...',
  '...hFFFFFFFff...',
  '...hFFFFFFff....',
  '....fFFFFff.....',
  '.....KKKKK......',
  '...SSSSSSSSs....',
  '..SSSSSSSSSss...',
  'A.SSSSSSSSSss...',
  'ASSSSSSSSSSssA..',
  'aSSSSSSSSSSssA..',
  '..SSSSSSSSSssa..',
  '...SSSSSSSss....',
  '...PPPPPPPpp....',
  '..PPPP..Ppp.....',
  '..PPP...Pppp....',
  '.PPP.....Ppp....',
  '.BBBB....BBbb...',
  'BBBBB.....BBbb..',
  '................',
]

const WALK_B = [
  '......HHHH......',
  '....HHHHHHHh....',
  '...HHHHHHHHhh...',
  '..HHHFFFFFFhh...',
  '..HHFFFFFFFfh...',
  '..HhFFEFFEFff...',
  '...hFFFFFFFff...',
  '...hFFFFFFff....',
  '....fFFFFff.....',
  '.....KKKKK......',
  '...SSSSSSSSs....',
  '..SSSSSSSSSss...',
  '..SSSSSSSSSssA..',
  '.ASSSSSSSSSssA..',
  '.ASSSSSSSSSssa..',
  '.a.SSSSSSSss....',
  '...SSSSSSSss....',
  '...PPPPPPPpp....',
  '...PPPPPpp......',
  '...PPPPpp.......',
  '...PPPpp........',
  '..BBBBbb........',
  '.BBBBBbb........',
  '................',
]

// 앉아서 타이핑. 하반신은 책상에 가려지므로 그리지 않는다.
const TYPE_A = [
  '................',
  '................',
  '......HHHH......',
  '....HHHHHHHh....',
  '...HHHHHHHHhh...',
  '..HHHFFFFFFhh...',
  '..HHFFFFFFFfh...',
  '..HhFFEFFEFff...',
  '...hFFFFFFFff...',
  '...hFFFFFFff....',
  '....fFFFFff.....',
  '.....KKKKK......',
  '...SSSSSSSSs....',
  '..SSSSSSSSSss...',
  '.ASSSSSSSSSssA..',
  '.AASSSSSSSssAA..',
  '..aa.....aaa....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

const TYPE_B = [
  '................',
  '................',
  '......HHHH......',
  '....HHHHHHHh....',
  '...HHHHHHHHhh...',
  '..HHHFFFFFFhh...',
  '..HHFFFFFFFfh...',
  '..HhFFEFFEFff...',
  '...hFFFFFFFff...',
  '...hFFFFFFff....',
  '....fFFFFff.....',
  '.....KKKKK......',
  '...SSSSSSSSs....',
  '..SSSSSSSSSss...',
  '.ASSSSSSSSSssA..',
  '..AASSSSSSSaA...',
  '...aa...aaa.....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

export const POSES = {
  idle: [IDLE_A, IDLE_B],
  walk: [WALK_A, WALK_B],
  type: [TYPE_A, TYPE_B],
}

export const SPRITE_W = W
export const SPRITE_H = H

/** hex 색을 비율만큼 어둡게(또는 밝게) 만든다. 그늘 색을 손으로 고르지 않기 위해서. */
function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * k))),
  )
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 역할별 팔레트. 밝은 면/그늘 면을 자동으로 짝지어 만든다. */
export function makePalette({ hair, shirt, accent, skin = '#f2caa4' }) {
  const pants = '#414a63'
  const shoes = '#22262f'
  return {
    H: hair,
    h: shade(hair, 0.68),
    F: skin,
    f: shade(skin, 0.74),
    E: '#2a2233',
    S: shirt,
    s: shade(shirt, 0.7),
    A: skin,
    a: shade(skin, 0.74),
    P: pants,
    p: shade(pants, 0.7),
    B: shoes,
    b: shade(shoes, 0.7),
    K: accent,
  }
}

/**
 * 한 프레임을 그린다. (x, y)는 **논리 좌표**의 발밑 중앙이며 배경과 같은 배율로 확대된다.
 * flip=true면 좌우 반전(남서를 바라본다).
 */
export function drawSprite(ctx, frame, palette, x, y, scale, flip = false) {
  const ox = Math.round(x * scale - (W * scale) / 2)
  const oy = Math.round(y * scale - H * scale)

  // 어두운 실루엣을 한 픽셀 밀어 먼저 깔면 바닥·책상과 분리돼 보인다.
  ctx.fillStyle = 'rgba(8,10,18,0.5)'
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
