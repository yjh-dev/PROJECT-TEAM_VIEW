// 도트 캐릭터를 코드로 찍는다. 외부 이미지 에셋이 없으므로 라이선스·경로 문제가 없고,
// 팀원이 늘어나면 팔레트만 추가하면 된다.
//
// 각 프레임은 12x16 문자 그리드다:
//   . 투명   H 머리   F 얼굴   E 눈   S 셔츠   A 팔(피부)   P 바지   B 신발   K 포인트색

const W = 12
const H = 16

// 기본 자세(정면, 서 있음)
const IDLE_A = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  '.ASSSSSSSSA.',
  '.ASSSSSSSSA.',
  '.A.SSSSSS.A.',
  '...PPPPPP...',
  '...PP..PP...',
  '...PP..PP...',
  '..BBB..BBB..',
]

// 살짝 숨쉬는 프레임(1px 내려앉음)
const IDLE_B = [
  '............',
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  '.ASSSSSSSSA.',
  '.ASSSSSSSSA.',
  '...SSSSSS...',
  '...PPPPPP...',
  '...PP..PP...',
  '..BBB..BBB..',
]

// 걷기 1 — 왼발 앞
const WALK_A = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  'ASSSSSSSSS..',
  'ASSSSSSSSSA.',
  '..SSSSSSS.A.',
  '..PPPPPPP...',
  '..PP...PPP..',
  '.PP.....PP..',
  'BBB.....BBB.',
]

// 걷기 2 — 오른발 앞
const WALK_B = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  '..SSSSSSSSA.',
  '.ASSSSSSSSA.',
  '.A.SSSSSSS..',
  '...PPPPPPP..',
  '..PPP...PP..',
  '..PP.....PP.',
  '.BBB.....BBB',
]

// 타이핑 — 앉아서 팔을 앞으로. 아래쪽은 책상에 가려지므로 다리를 그리지 않는다.
const TYPE_A = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  '.SSSSSSSSSS.',
  'ASSSSSSSSSSA',
  '.AA......AA.',
  '............',
  '............',
  '............',
  '............',
]

const TYPE_B = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HFFFFFFH..',
  '..FEFFFFEF..',
  '..FFFFFFFF..',
  '...FFFFFF...',
  '....FFFF....',
  '..KSSSSSSK..',
  '.SSSSSSSSSS.',
  'ASSSSSSSSSSA',
  '..AA....AA..',
  '............',
  '............',
  '............',
  '............',
]

export const POSES = {
  idle: [IDLE_A, IDLE_B],
  walk: [WALK_A, WALK_B],
  type: [TYPE_A, TYPE_B],
}

export const SPRITE_W = W
export const SPRITE_H = H

/**
 * 한 프레임을 그린다. (x, y)는 **논리 좌표**(320x200 기준)의 발밑 중앙이며,
 * 배경·책상과 같은 배율로 확대된다. 여기서 scale을 곱하지 않으면 캐릭터만
 * 1배로 그려져 책상과 어긋난다.
 * flip=true면 좌우 반전(왼쪽으로 걸을 때).
 */
export function drawSprite(ctx, frame, palette, x, y, scale, flip = false) {
  const ox = Math.round(x * scale - (W * scale) / 2)
  const oy = Math.round(y * scale - H * scale)

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

/** 역할별 팔레트. H=머리, S=셔츠, K=포인트가 캐릭터를 구분하는 축이다. */
export function makePalette({ hair, shirt, accent, skin = '#f0c8a0' }) {
  return {
    H: hair,
    F: skin,
    A: skin,
    E: '#2b2233',
    S: shirt,
    K: accent,
    P: '#3b4257',
    B: '#23262f',
  }
}
