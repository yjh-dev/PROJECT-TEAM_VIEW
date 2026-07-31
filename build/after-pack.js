// 패키징 직후 실행파일에 아이콘과 버전 정보를 직접 박는다.
//
// electron-builder가 이 일을 대신 해 주는데 이 환경에서는 실패한다. 로그를 보면
// 아이콘 변환(PNG→ICO)까지는 성공하고 rcedit 명령도 만들어지는데, 도구 묶음
// (winCodeSign) 압축을 푸는 중에 `Sub items Errors: 2`가 나면서 실행이 포기된다.
// 캐시를 통째로 지우고 다시 받아도 같았다 — 그 아카이브에 Windows가 못 만드는
// 항목이 섞여 있어 7-Zip이 매번 오류를 낸다.
//
// 그래서 **같은 rcedit를 우리가 직접 부른다.** 실제로 손으로 돌려 보니 아이콘도
// 버전 정보도 정상으로 들어갔다. 도구도 아이콘 파일도 멀쩡했고 호출 경로만 막혀
// 있었다.
//
// 이 훅이 없으면 exe가 `ProductName: Electron`, 기본 원자 아이콘으로 나간다.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** electron-builder가 받아 둔 rcedit를 찾는다. 없으면 null. */
function findRcedit() {
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
  )
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'rcedit-x64.exe')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* 캐시가 없으면 아래에서 건너뛴다 */
  }
  return null
}

exports.default = async (context) => {
  if (context.electronPlatformName !== 'win32') return

  const info = context.packager.appInfo
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`)
  const ico = path.join(context.outDir, '.icon-ico', 'icon.ico')
  const rcedit = findRcedit()

  // **조용히 넘어가지 않는다.** 아이콘이 빠진 채로 배포되는 것이 이번 문제의
  // 시작이었다. 무엇이 없어서 건너뛰는지 빌드 로그에 남긴다.
  if (!rcedit) return console.warn('  ⚠ rcedit를 찾지 못해 아이콘·버전 정보를 건너뜁니다')
  if (!fs.existsSync(ico)) return console.warn(`  ⚠ 변환된 아이콘이 없습니다: ${ico}`)
  if (!fs.existsSync(exe)) return console.warn(`  ⚠ 실행파일이 없습니다: ${exe}`)

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  execFileSync(rcedit, [
    exe,
    '--set-icon', ico,
    '--set-version-string', 'ProductName', info.productName,
    '--set-version-string', 'FileDescription', pkg.description || info.productName,
    '--set-version-string', 'CompanyName', pkg.author || '',
    '--set-version-string', 'InternalName', info.productName,
    '--set-file-version', info.version,
    '--set-product-version', `${info.version}.0`,
  ])
  console.log(`  ✓ 아이콘·버전 정보 적용 (${info.productName} ${info.version})`)
}
