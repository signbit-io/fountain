import { describe, it, expect, vi, afterEach } from 'vitest'

/*
  iOS file flows (iOS readiness, 2026-11-12). Pins the two rules lib/download.ts and
  lib/platform.ts state in prose:
  - On iOS a save STAGES the real contents before the export dialog opens and removes the staged
    copy afterwards, saved or cancelled. The dialog plugin exports Documents/<name> and makes it
    EMPTY when it is missing, so the order is the whole fix.
  - An iPad (which reports a Mac user agent) is iOS; a Mac is not. Backups and PSBTs show every
    file on iOS, since its pickers filter by file type and know neither extension.
*/
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  saveResult: '/exported/signbit-vault.txt' as string | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { name: string; contents?: string }) => {
    mocks.calls.push(`${cmd}:${args.name}${args.contents !== undefined ? `:${args.contents.length}` : ''}`)
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async (opts: { defaultPath: string; filters?: unknown[] }) => {
    mocks.calls.push(`save:${opts.defaultPath}${opts.filters ? ':filtered' : ''}`)
    return mocks.saveResult
  }),
}))
// The desktop/Android path writes and reads back; an in-memory file is enough for that.
vi.mock('@tauri-apps/plugin-fs', () => {
  const files = new Map<string, string>()
  return {
    writeTextFile: vi.fn(async (path: string, text: string) => void files.set(path, text)),
    readTextFile: vi.fn(async (path: string) => files.get(path) ?? ''),
  }
})

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'

async function loadAs(userAgent: string, maxTouchPoints = 0) {
  vi.resetModules()
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints })
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  mocks.calls.length = 0
  return {
    download: await import('./download'),
    platform: await import('./platform'),
    backup: await import('./backup'),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.saveResult = '/exported/signbit-vault.txt'
})

describe('🚨 iOS save stages the real file before the export dialog', () => {
  it('stages, exports, then removes the staged copy, in that order', async () => {
    const { download } = await loadAs(IPHONE)
    const res = await download.saveTextFile('signbit-vault.txt', 'wsh(sortedmulti(2,...))')
    expect(res).toEqual({ status: 'saved', path: '/exported/signbit-vault.txt' })
    expect(mocks.calls).toEqual([
      'stage_export_file:signbit-vault.txt:23',
      'save:signbit-vault.txt',
      'unstage_export_file:signbit-vault.txt',
    ])
  })

  it('removes the staged copy when the user cancels too', async () => {
    mocks.saveResult = null
    const { download } = await loadAs(IPHONE)
    expect(await download.saveTextFile('signbit-vault.txt', 'x')).toEqual({ status: 'cancelled' })
    expect(mocks.calls[mocks.calls.length - 1]).toBe('unstage_export_file:signbit-vault.txt')
  })
})

describe('which device this is', () => {
  it('an iPad, reporting a Mac user agent with touch, is iOS and takes the iOS save', async () => {
    const { platform, download } = await loadAs(IPAD, 5)
    expect(platform.IS_IOS).toBe(true)
    await download.saveTextFile('a.txt', 'abc')
    expect(mocks.calls[0]).toBe('stage_export_file:a.txt:3')
  })

  it('a Mac (no touch) is not iOS', async () => {
    const { platform } = await loadAs(IPAD, 0)
    expect(platform.IS_IOS).toBe(false)
    expect(platform.IS_MOBILE).toBe(false)
  })

  it('a phone shows every file when picking a backup; a desktop filters to .sbk / .json', async () => {
    expect((await loadAs(IPHONE)).backup.BACKUP_ACCEPT).toBe('')
    expect((await loadAs(IPAD, 0)).backup.BACKUP_ACCEPT).toBe('.sbk,.json')
  })
})

describe('🚨 Android save sends no file-type filter (0.6.5: Export file did nothing)', () => {
  const filters = [{ name: 'SignBit companion key', extensions: ['json'] }]
  it('Android: the save dialog gets no filter', async () => {
    const { download } = await loadAs(ANDROID)
    await download.saveTextFile('signbit-key-a-73c5da0a.json', '{"x":1}', filters)
    expect(mocks.calls).toEqual(['save:signbit-key-a-73c5da0a.json'])
  })
  it('desktop: the filter is kept', async () => {
    const { download } = await loadAs(WINDOWS)
    await download.saveTextFile('signbit-key-a-73c5da0a.json', '{"x":1}', filters)
    expect(mocks.calls).toEqual(['save:signbit-key-a-73c5da0a.json:filtered'])
  })
})
