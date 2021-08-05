import { defaultReactVersion } from './shared/constants.ts'

/** `VERSION` managed by https://deno.land/x/publish */
export const VERSION = '0.3.0-alpha.33'

/** `prepublish` will be invoked before publish */
export async function prepublish(version: string): Promise<boolean> {
  const p = Deno.run({
    cmd: ['deno', 'run', '-A', 'build.ts'],
    cwd: './compiler',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const { success } = await p.status()
  p.close()
  if (success) {
    const data = await Deno.readTextFile('./import_map.json')
    const importMap = JSON.parse(data)
    Object.assign(importMap.imports, {
      'aleph/': `https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/`,
      'aleph/types': `https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump//types.ts`,
      'aleph/web': `https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump//framework/core/mod.ts`,
      'aleph/react': `https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump//framework/react/mod.ts`,
      'react': `https://esm.sh/react@experimmental`,
      'react-dom': `https://esm.sh/react-dom@experimmental`,
    })
    await Deno.writeTextFile(
      './import_map.json',
      JSON.stringify(importMap, undefined, 2)
    )
  }
  return success
}
