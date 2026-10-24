import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface GodotIntegrationStatus {
  plugin: 'dsh-godot-plugin'
  phase: 'worker'
  runtimeEmbedded: boolean
  producers: string[]
  workers: string[]
}

interface RuntimeManifest {
  protocol: number
  producer: string
  worker: string
  executable: string
  extensions: string[]
  files: Record<string, string>
  editorMode?: boolean
  /** Editor project relative to the package root; args are built at registration time. */
  projectDir?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    godotIntegration: GodotIntegration
  }
}

function loadManifest(file: string): RuntimeManifest | null {
  try {
    const url = new URL(`../${file}`, import.meta.url)
    if (!existsSync(url)) return null
    return JSON.parse(readFileSync(url, 'utf8')) as RuntimeManifest
  } catch {
    return null
  }
}

const MANIFESTS = ['runtime-manifest.json', 'runtime-manifest.editor.json']

export default class GodotIntegration extends Service {
  constructor(ctx: Context) {
    super(ctx, 'godotIntegration')
    const logger = ctx.logger('dsh-godot-plugin')
    ctx.effect(() => {
      const manifests = MANIFESTS.map(loadManifest).filter((m): m is RuntimeManifest => m !== null)
      if (manifests.length === 0) {
        logger.error('runtime-manifest.json missing; run `pnpm run godot:stage` (scons build + post-process) before starting DSH. Editor variant: `pnpm run godot:stage:editor`.')
        return () => {}
      }
      for (const manifest of manifests) {
        logger.info(`Godot ${manifest.editorMode ? 'editor' : 'runtime'} worker ready (${manifest.worker}); native viewport protocol ${manifest.protocol}`)
      }
      if (process.env.DSH_DESKTOP_NATIVE_VIEWPORT !== '1' || !process.connected || !process.send) return () => {}
      const packageRoot = fileURLToPath(new URL('../', import.meta.url))
      const registered: string[] = []
      for (const manifest of manifests) {
        const id = manifest.producer
        // The editor worker only becomes an editor with its launch arguments;
        // without them the same binary falls back to the built-in demo scene.
        const args = manifest.editorMode && manifest.projectDir ? ['-e', '--path', join(packageRoot, manifest.projectDir)] : []
        process.send({ type: 'native-viewport-register', producer: {
          id, packageRoot, executable: manifest.executable,
          sha256: manifest.files[manifest.executable], protocol: manifest.protocol, args, extensions: manifest.extensions,
        } })
        registered.push(id)
        logger.info(`Godot producer registered: ${id} (args: ${args.length ? args.join(' ') : '(none)'})`)
      }
      return () => {
        for (const id of registered) {
          if (process.connected) process.send?.({ type: 'native-viewport-revoke', id })
          logger.info(`Godot producer revoked: ${id}`)
        }
      }
    })
  }

  status(): GodotIntegrationStatus {
    const manifests = MANIFESTS.map(loadManifest).filter((m): m is RuntimeManifest => m !== null)
    return {
      plugin: 'dsh-godot-plugin',
      phase: 'worker',
      runtimeEmbedded: manifests.length > 0,
      producers: manifests.map(manifest => manifest.producer),
      workers: manifests.map(manifest => manifest.worker),
    }
  }
}
