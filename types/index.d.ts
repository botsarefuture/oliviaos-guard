declare module 'claude-code' {
  interface PluginState {
    'oliviaos-guard': {
      logged: Shaped<number>
      blocked: Shaped<number>
      tiered: Shaped<number>
      sent: Shaped<number>
      mapLoaded: Shaped<boolean>
      mapNoted: Shaped<string[]>
      pending: Shaped<{ title: string; summary: string; what: string; project: string }[]>
    }
  }
}
export type Count = number
