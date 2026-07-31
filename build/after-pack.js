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
  const rcedit = findRcedit()

  // **우리가 만든 아이콘을 먼저 쓴다.**
  //
  // 예전에는 electron-builder가 변환해 두는 `<out>/.icon-ico/icon.ico`만 봤는데,
  // 그 파일은 **이 훅이 돈 뒤에** 만들어진다(nsis 타깃을 빌드할 때). 이전 빌드가
  // 남긴 파일이 우연히 있어서 그동안 통했을 뿐이고, release/를 청소하자마자
  // "변환된 아이콘이 없습니다"로 건너뛰며 exe가 `ProductName: Electron`으로 나갔다.
  //
  // `build/icon.ico`는 tools/make-icon.js가 만들어 저장소에 두는 파일이라 순서에
  // 걸리지 않는다. 크기도 6종(16~256)이라 변환본보다 낫다.
  const ours = path.join(__dirname, 'icon.ico')
  const converted = path.join(context.outDir, '.icon-ico', 'icon.ico')
  const ico = fs.existsSync(ours) ? ours : converted

  // **조용히 넘어가지 않는다.** 아이콘이 빠진 채로 배포되는 것이 이번 문제의
  // 시작이었다. 무엇이 없어서 건너뛰는지 빌드 로그에 남긴다.
  if (!rcedit) return console.warn('  ⚠ rcedit를 찾지 못해 아이콘·버전 정보를 건너뜁니다')
  if (!fs.existsSync(ico)) {
    return console.warn(`  ⚠ 아이콘 파일이 없습니다: ${ico} — \`pnpm run icon\`으로 만드세요`)
  }
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
  // **넣었다고 믿지 말고 도로 읽어 본다.**
  //
  // 이 훅이 건너뛰어도 남는 것은 로그 한 줄짜리 경고뿐이라, 긴 빌드 출력에 묻히면
  // `ProductName: Electron`인 exe가 그대로 나간다(실제로 그렇게 나갔다). 값을 도로
  // 읽어 확인하고, 안 박혔으면 빌드를 세운다.
  const got = execFileSync(rcedit, [exe, '--get-version-string', 'ProductName'], {
    encoding: 'utf8',
  }).trim()
  if (got !== info.productName) {
    throw new Error(`아이콘·버전 정보가 적용되지 않았습니다 (ProductName="${got}", 기대="${info.productName}")`)
  }
  console.log(`  ✓ 아이콘·버전 정보 적용 (${info.productName} ${info.version}) — 되읽어 확인함`)
}
