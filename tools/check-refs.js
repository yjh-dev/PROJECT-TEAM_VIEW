// 렌더러 모듈의 **끊긴 참조**를 실행 전에 잡는다.
//
//   node tools/check-refs.js
//
// 이 앱은 캔버스에 그리는 코드라 참조 하나가 끊기면 draw()가 통째로 죽고
// 화면이 텅 빈다. 원인을 눈으로 찾기 어려워서(벽만 남거나 아무것도 안 보임)
// 실행 전에 기계로 확인한다. 실제로 두 번 당했다: 바닥재 이름 누락, drawTV 삭제.

const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'renderer')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'))

const modules = new Map()
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const exported = new Set([
    ...[...src.matchAll(/export\s+(?:function|const|let)\s+(\w+)/g)].map((m) => m[1]),
    // export { a, b } 형태
    ...[...src.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((m) =>
      m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean),
    ),
  ])
  const imports = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(\w+)\.js'/g)].map((m) => ({
    names: m[1].split(',').map((x) => x.trim()).filter(Boolean),
    from: m[2],
  }))
  const declared = new Set([
    ...[...src.matchAll(/(?:export\s+)?function\s+(\w+)/g)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*(?:export\s+)?(?:const|let)\s+(\w+)/gm)].map((m) => m[1]),
    ...imports.flatMap((i) => i.names),
  ])
  modules.set(f.replace(/\.js$/, ''), { src, exported, imports, declared })
}

const problems = []

for (const [name, m] of modules) {
  // 1) import한 이름을 상대 모듈이 실제로 export 하는가
  for (const imp of m.imports) {
    const target = modules.get(imp.from)
    if (!target) {
      problems.push(`${name}.js: './${imp.from}.js' 모듈이 없다`)
      continue
    }
    for (const n of imp.names) {
      if (!target.exported.has(n)) {
        problems.push(`${name}.js: ${imp.from}.js가 '${n}'을 export 하지 않는다`)
      }
    }
  }

  // 2) 그리기 함수를 부르는데 정의도 import도 없는 경우
  const called = new Set(
    [...m.src.matchAll(/\b(draw[A-Z]\w*|px[A-Z]\w*|boxPal|tint|wallQuad|faceQuad|fillTile|topSeam)\s*\(/g)].map(
      (x) => x[1],
    ),
  )
  for (const c of called) {
    if (!m.declared.has(c)) problems.push(`${name}.js: '${c}'를 부르는데 정의도 import도 없다`)
  }
}

// 3) 방 바닥재 이름이 실제 팔레트에 있는가 (한 번 이걸로 화면이 통째로 죽었다)
const layout = modules.get('layout')?.src ?? ''
const room = modules.get('room')?.src ?? ''
const floors = [...layout.matchAll(/floor:\s*'(\w+)'/g)].map((m) => m[1])
for (const f of new Set(floors)) {
  if (!new RegExp(`^\\s{2}${f}:\\s*\\[`, 'm').test(room)) {
    problems.push(`room.js: 바닥재 '${f}'가 FLOOR_SETS에 없다 (layout.js가 쓰고 있다)`)
  }
}

if (problems.length) {
  console.error(`끊긴 참조 ${problems.length}건:`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(`참조 검사 통과 (모듈 ${modules.size}개)`)
