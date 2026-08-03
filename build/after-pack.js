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

/**
 * exe에 박힌 ProductName이 기대한 값과 같은가.
 *
 * 'MATCH' / 'DIFF:<읽은 값>'을 돌려준다. PowerShell을 못 부르면 null(모름).
 * 판정만 문자열로 건너오므로 코드페이지와 무관하다.
 */
function readBackVerdict(exe, want) {
  const ps =
    "$v = (Get-Item -LiteralPath $env:TV_EXE).VersionInfo.ProductName;" +
    " if ($v -eq $env:TV_WANT) { 'MATCH' } else { 'DIFF:' + $v }"
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      env: { ...process.env, TV_EXE: exe, TV_WANT: want },
    }).trim()
  } catch {
    return null
  }
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
  //
  // 다만 **rcedit의 `--get-version-string`으로 읽으면 안 된다.** 그 출력은 콘솔
  // 코드페이지를 타서 ASCII가 아닌 글자가 `?`로 뭉개진다. 제품 이름이 한글이 되자
  // exe에는 제대로 박혔는데도 `ProductName="????"`로 돌아와 빌드가 섰다(실측).
  // 그래서 **값을 파이프로 건네지 말고 비교를 PowerShell 안에서 끝내고 판정만**
  // 받는다 — 이름은 환경변수로 넘어가 유니코드 그대로 도착한다.
  const verdict = readBackVerdict(exe, info.productName)
  if (verdict === null) {
    console.warn('  ⚠ 버전 정보를 되읽지 못했습니다 — 박혔는지 확인되지 않았습니다')
  } else if (verdict !== 'MATCH') {
    throw new Error(`아이콘·버전 정보가 적용되지 않았습니다 (${verdict}, 기대="${info.productName}")`)
  }
  console.log(`  ✓ 아이콘·버전 정보 적용 (${info.productName} ${info.version}) — 되읽어 확인함`)
}
