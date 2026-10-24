export const inject = ['godotIntegration']

export function apply(ctx) {
  process.send?.({ type: 'godot-bootstrap', status: ctx.godotIntegration.status() })
}
