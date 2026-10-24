import { Context, Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface GodotIntegrationStatus {
  plugin: 'dsh-godot-plugin'
  phase: 'bootstrap'
  runtimeEmbedded: false
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    godotIntegration: GodotIntegration
  }
}

export default class GodotIntegration extends Service {
  constructor(ctx: Context) {
    super(ctx, 'godotIntegration')
    const logger = ctx.logger('dsh-godot-plugin')
    ctx.effect(() => {
      logger.info('Graphics101 demo ready; Godot runtime is not embedded')
      if (process.env.DSH_DESKTOP_NATIVE_VIEWPORT !== '1' || !process.connected || !process.send) return () => {}
      const manifest = JSON.parse(readFileSync(new URL('../runtime-manifest.json', import.meta.url), 'utf8')) as { executable: string; files: Record<string, string> }
      const id = 'dsh-godot-plugin/graphics101'
      process.send({ type: 'native-viewport-register', producer: {
        id, packageRoot: fileURLToPath(new URL('../', import.meta.url)), executable: manifest.executable,
        sha256: manifest.files[manifest.executable], protocol: 2, args: [], extensions: ['graphics101.camera.v1'],
      } })
      logger.info('Graphics101 producer registered')
      return () => {
        if (process.connected) process.send?.({ type: 'native-viewport-revoke', id })
        logger.info('Graphics101 producer revoked')
      }
    })
  }

  status(): GodotIntegrationStatus {
    return {
      plugin: 'dsh-godot-plugin',
      phase: 'bootstrap',
      runtimeEmbedded: false,
    }
  }
}
