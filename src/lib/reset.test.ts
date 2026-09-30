import { describe, it, expect, vi } from 'vitest'
import { wipeDevice, type ResetEffects } from './reset.js'

/*
  Reset-sequence tests. Like restore.test.ts these drive the REAL wipeDevice with the storage
  effects injected as spies — no transcribed copy of the sequence, so a production regression
  fails here rather than on someone's recovery day.

  What must hold, and what each guards against:
   - keystore FIRST  → a keystore that fails to delete must leave the caches intact (otherwise a
     failed reset destroys the cache AND leaves the user locked out).
   - keystore failure is FATAL → the caches are never touched, and the caller sees the throw.
   - cache failure is SWALLOWED → a completed reset is never reported as failed.
*/

function spyEffects(over: Partial<ResetEffects> = {}): ResetEffects {
  return {
    wipeKeystore: vi.fn().mockResolvedValue(undefined),
    clearVaults: vi.fn(),
    clearSettings: vi.fn(),
    ...over,
  }
}

describe('wipeDevice', () => {
  it('deletes the keystore and clears the side stores', async () => {
    const effects = spyEffects()
    await wipeDevice(effects)

    expect(effects.wipeKeystore).toHaveBeenCalledOnce()
    expect(effects.clearVaults).toHaveBeenCalledOnce()
    expect(effects.clearSettings).toHaveBeenCalledOnce()
  })

  it('deletes the keystore BEFORE touching any side store', async () => {
    // The ordering guarantee, asserted by call sequence rather than by reading the source.
    const order: string[] = []
    const effects = spyEffects({
      wipeKeystore: vi.fn(async () => {
        order.push('keystore')
      }),
      clearVaults: vi.fn(() => {
        order.push('vaults')
      }),
      clearSettings: vi.fn(() => {
        order.push('settings')
      }),
    })

    await wipeDevice(effects)
    expect(order[0]).toBe('keystore')
    expect(order).toEqual(['keystore', 'vaults', 'settings'])
  })

  it('aborts WITHOUT clearing caches when the keystore cannot be deleted', async () => {
    // The failure that matters: the keys are still on disk, so the user is still locked out.
    // Wiping their saved vault descriptors on the way out would be pure loss.
    const effects = spyEffects({
      wipeKeystore: vi.fn().mockRejectedValue(new Error('file in use')),
    })

    await expect(wipeDevice(effects)).rejects.toThrow('file in use')
    expect(effects.clearVaults).not.toHaveBeenCalled()
    expect(effects.clearSettings).not.toHaveBeenCalled()
  })

  it('succeeds even if clearing the caches throws', async () => {
    // By this point the keystore is already gone and the app WILL boot to first run. Reporting
    // failure here would invite the user to re-run a reset that has already happened.
    const effects = spyEffects({
      clearVaults: vi.fn(() => {
        throw new Error('localStorage unavailable')
      }),
    })

    await expect(wipeDevice(effects)).resolves.toBeUndefined()
    expect(effects.wipeKeystore).toHaveBeenCalledOnce()
  })

  it('still succeeds when the settings clear throws after vaults succeeded', async () => {
    const effects = spyEffects({
      clearSettings: vi.fn(() => {
        throw new Error('quota')
      }),
    })

    await expect(wipeDevice(effects)).resolves.toBeUndefined()
    expect(effects.clearVaults).toHaveBeenCalledOnce()
  })
})
