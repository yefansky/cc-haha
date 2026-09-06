export type SeasunPhase = 'idle' | 'awaiting_login' | 'exchanging' | 'connected' | 'expired' | 'cancelled' | 'error'
export type SeasunStatus = {
  phase: SeasunPhase
  loggedIn: boolean
  pending: boolean
  active: boolean
  identityConnected: boolean
  modelAccess: 'ready' | 'unassigned' | 'unknown'
  providerId?: string
  errorCode?: string
}

/** A second projection at the desktop boundary prevents accidental credential IPC. */
export function parseSeasunStatus(value: unknown): SeasunStatus {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const phases: string[] = ['idle', 'awaiting_login', 'exchanging', 'connected', 'expired', 'cancelled', 'error']
  return {
    phase: phases.includes(String(data.phase)) ? data.phase as SeasunPhase : 'error',
    loggedIn: data.loggedIn === true,
    pending: data.pending === true,
    active: data.active === true,
    identityConnected: data.identityConnected === true,
    modelAccess: data.modelAccess === 'ready' || data.modelAccess === 'unassigned' ? data.modelAccess : 'unknown',
    ...(typeof data.providerId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(data.providerId) ? { providerId: data.providerId } : {}),
    // The UI intentionally shows one safe failure description rather than remote text.
    ...(data.errorCode ? { errorCode: data.errorCode === 'cancel_unconfirmed' ? 'cancel_unconfirmed' : 'login_failed' } : {}),
  }
}

export function localSeasunStatus(phase: SeasunPhase): SeasunStatus {
  return { phase, loggedIn: false, pending: phase === 'awaiting_login' || phase === 'exchanging', active: false, identityConnected: false, modelAccess: 'unknown' }
}
