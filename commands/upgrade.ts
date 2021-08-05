import { checkVersion } from '../install.ts'
import { VERSION } from '../version.ts'

export const helpMessage = `
Usage:
    aleph upgrade <version>

Options:
        --version <version>  The version to upgrade to
    -h, --help               Prints help message
`

export default async function (v = 'latest') {
  const version = await checkVersion(v)
  if (version === 'v' + VERSION) {
    console.log('Already up-to-date!')
    Deno.exit(0)
  }

  const { install } = await import(`https://raw.githubusercontent.com/denoland/deno_std/main/install.ts`)
  await install(version)
}
