// 동선 검사 — 갈 수 있어야 할 곳에 **실제로 길이 있는지** 확인한다.
//
//   node tools/check-nav.js
//
// 가구를 하나 옮기거나 키우면 통로가 막혀 방 하나가 통째로 고립될 수 있다.
// 그러면 화면에서는 "그 사람만 안 움직인다"로 나타나 원인을 찾기 어렵다.
// 자리·소품 좌표는 사람이 손으로 넣으므로, 기계가 매번 다시 확인한다.

const path = require('path')
const url = require('url')

const R = (f) => url.pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href

/** 두 경유지를 잇는 선분이 가구 사각형을 통과하면 그 사각형을 돌려준다. */
function crossesFurniture(a, b, rects) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.gx - a.gx, b.gy - a.gy) / 0.08))
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const gx = a.gx + (b.gx - a.gx) * t
    const gy = a.gy + (b.gy - a.gy) * t
    for (const r of rects) {
      if (gx > r.x0 && gx < r.x1 && gy > r.y0 && gy < r.y1) {
        return `(${r.x0.toFixed(2)},${r.y0.toFixed(2)})–(${r.x1.toFixed(2)},${r.y1.toFixed(2)})`
      }
    }
  }
  return null
}

async function main() {
  const layout = await import(R('layout.js'))
  const room = await import(R('room.js'))
  const agentsMod = await import(R('agents.js'))
  const { SPOTS, routeTo, setObstacles, isReachable } = layout

  const agents = agentsMod.buildAgents()
  const rects = room.propFootprints()
  for (const a of agents.values()) {
    rects.push(...room.workstationFootprint(a.desk.gx, a.desk.gy))
  }
  setObstacles(rects)

  // 검사 대상: 모든 자리(의자)와 유휴 행동 목적지
  const targets = []
  for (const a of agents.values()) targets.push({ name: `${a.id} 자리`, p: a.chair })
  for (const [key, v] of Object.entries(SPOTS)) {
    if (Array.isArray(v)) v.forEach((p, i) => targets.push({ name: `${key}[${i}]`, p }))
    else targets.push({ name: key, p: v })
  }

  const problems = []
  const home = agents.get('lead').chair

  for (const t of targets) {
    // 리드 자리 ↔ 그 지점 양방향으로 길이 있어야 한다
    if (!isReachable(home, t.p)) problems.push(`리드 자리 → ${t.name}: 갈 길이 없다`)
    if (!isReachable(t.p, home)) problems.push(`${t.name} → 리드 자리: 돌아올 길이 없다`)

    // 경로가 가구를 관통하지 않는지 — 경유지를 이은 선을 잘게 찍어 확인한다.
    const route = [{ gx: home.gx, gy: home.gy }, ...routeTo(home, t.p)]
    for (let i = 0; i < route.length - 2; i++) {
      // 마지막 구간은 의자·소파로 들어가는 구간이라 가구와 겹치는 게 정상이다
      const hit = crossesFurniture(route[i], route[i + 1], rects)
      if (hit) problems.push(`리드 자리 → ${t.name}: ${hit} 위를 지나간다`)
    }
  }

  // 자리 자체가 가구에 파묻혀 있지 않은지 — 앉으러 갈 수는 있어도
  // 책상 안에 자리가 생기면 화면에서 겹쳐 보인다.
  for (const a of agents.values()) {
    for (const r of rects) {
      const c = a.chair
      if (c.gx > r.x0 && c.gx < r.x1 && c.gy > r.y0 && c.gy < r.y1) {
        problems.push(`${a.id} 의자가 가구 안에 있다 (${c.gx}, ${c.gy})`)
      }
    }
  }

  // **서 있는** 목적지(커피·자판기·창가·배회)가 가구 안이면 안 된다.
  // 소파·빈백·회의 의자는 앉는 자리라 겹치는 게 정상이므로 뺀다.
  for (const t of targets) {
    if (t.p.sit || t.name.endsWith(' 자리')) continue
    for (const r of rects) {
      if (t.p.gx > r.x0 && t.p.gx < r.x1 && t.p.gy > r.y0 && t.p.gy < r.y1) {
        problems.push(`${t.name}이 가구 안이다 — 그 자리에 서면 겹쳐 보인다`)
      }
    }
  }

  if (problems.length) {
    console.error(`동선 문제 ${problems.length}건:`)
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log(`동선 검사 통과 (지점 ${targets.length}곳)`)
}

main().catch((err) => {
  console.error('동선 검사 실패:', err.message)
  process.exit(1)
})
