import { expect, test } from 'claude-code/testing'

import { consume, historyDone } from './ledger'
import { sumHours, utf8Bytes } from './stats'
import type { Hours } from './stats'

// Учёт статистики и новая часть панели (0.2.0): погода первой строкой, статистика, шестерёнка, кнопка над полем ввода.
const NOW = new Date(2026, 10, 23, 12).getTime()
const j = (o: object) => JSON.stringify(o)
const at = (ms: number) => new Date(ms).toISOString()
const said = (ms: number, id: string, usage: object, end = true) =>
  j({ type: 'assistant', timestamp: at(ms), message: { id, model: 'claude-opus-5-5', stop_reason: end ? 'end_turn' : 'tool_use', usage, content: [{ type: 'text', text: 'ок' }] } })
const asked = (ms: number) => j({ type: 'user', timestamp: at(ms), message: { content: 'сделай' } })

type F = Map<string, { text: string; mtime: number }>
function wire(on: any, files: F, transcript: string, extra: { panes?: object[]; usage?: object } = {}) {
  const writes: string[] = []
  const list = (dir: string) => {
    const names = new Set<string>()
    for (const path of files.keys()) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '')
    if (names.size === 0) throw new Error(`ENOENT ${dir}`)
    return [...names].map(name => {
      const f = files.get(`${dir}/${name}`)
      return { name, kind: f === undefined ? ('dir' as const) : ('file' as const), size: f ? utf8Bytes(f.text) : 0, mtimeMs: f?.mtime ?? NOW, isLink: false }
    })
  }
  on('session.info', () => ({ value: { transcriptPath: transcript } as never }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', (_: unknown, e: { path?: string }) => ({ value: list(e.path ?? '') }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    const f = files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: utf8Bytes(f.text), mtimeMs: f.mtime, isLink: false } as never }
  })
  on('fs.read', (_: unknown, e: { path: string; offset?: number; length?: number }) => {
    const f = files.get(e.path)
    if (f === undefined) throw new Error(`ENOENT ${e.path}`)
    // панель читает начало и конец расшифровки; файлы теста короткие — кусок с нуля и шире файла, символы не режутся
    const from = e.offset ?? 0
    return { value: f.text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    const old = files.get(e.path)
    files.set(e.path, { text: e.text, mtime: (old?.mtime ?? NOW) + 1 })
    writes.push(e.path)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: extra.panes ?? [] }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('session.usage', () => ({
    value: extra.usage ?? {
      startedAt: 0,
      context: { tokens: 357_000, window: 1_000_000, percent: 36 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 25, resetsAt: at(new Date(2026, 10, 27, 15).getTime()) }, { kind: 'five_hour', percentUsed: 64 }],
      cost: { usd: 9.72 },
    },
  }))
  return writes
}

const P = '/h/.claude/projects'
const DAY = 24 * 3600_000

test('учёт: кусок за куском — только целые строки, место в байтах, недописанная строка ждёт', async () => {
  // кириллица в строках: место считается в байтах, а не в символах
  const lines = [asked(NOW - 2 * DAY), said(NOW - 2 * DAY + 60_000, 'm1', { input_tokens: 1_000_000 }), asked(NOW - DAY)]
  const whole = lines.join('\n') + '\n'
  const tail = said(NOW - DAY + 30_000, 'm2', { output_tokens: 100_000 }) // без перевода строки: ещё пишется
  const h: Hours = {}
  const m = { o: 0, lastTs: 0, isOpen: false, recent: [] as string[] }
  expect(consume(m, whole + tail, utf8Bytes(whole + tail), h)).toBe(utf8Bytes(whole))
  expect(m.o).toBe(utf8Bytes(whole))
  expect(sumHours(h, 0, Infinity).usd).toBe(4)
  // хвост ещё без перевода строки и кусок не полный — ждать, место не двигается
  expect(consume(m, tail, utf8Bytes(tail), h)).toBe(0)
  expect(m.o).toBe(utf8Bytes(whole))
  // дописан — учтён один раз, вместе с прежним
  expect(consume(m, tail + '\n', utf8Bytes(tail + '\n'), h)).toBe(utf8Bytes(tail + '\n'))
  const t = sumHours(h, 0, Infinity)
  expect(t.usd).toBe(4 + 2)
  expect(t.ms).toBe(60_000 + 30_000)
  // полный кусок без перевода строки (картинка длиннее 4 МБ) пропускается целиком
  const big = { o: 0, lastTs: 0, isOpen: false, recent: [] as string[] }
  expect(consume(big, 'x'.repeat(10), 4 * 1024 * 1024, {})).toBe(4 * 1024 * 1024)
})

test('учёт: «история разобрана» — по непрочитанному в сумме, без дописываемых сейчас файлов', async () => {
  const MB = 1024 * 1024
  // живое окно 23.11: десятки непрочитанных расшифровок помощников меньше 4 МБ — прежнее условие считало их разобранными
  const queue: [string, number][] = Array.from({ length: 10 }, (_, i) => [`p/s/subagents/agent-${i}.jsonl`, 3 * MB])
  expect(historyDone(queue, {}, new Set())).toBe(false)
  // прочитаны все, кроме одного — 3 МБ: это уже не история
  const files = Object.fromEntries(queue.slice(1).map(([k, size]) => [k, { o: size }]))
  expect(historyDone(queue, files, new Set())).toBe(true)
  // большой файл с недописанной последней строкой — пишется сейчас, историю не держит
  expect(historyDone([['p/big.jsonl', 40 * MB]], { 'p/big.jsonl': { o: 10 * MB } }, new Set(['p/big.jsonl']))).toBe(true)
  expect(historyDone([['p/big.jsonl', 40 * MB]], { 'p/big.jsonl': { o: 10 * MB } }, new Set())).toBe(false)
})

const home = (extra: Record<string, string> = {}): F => new Map(Object.entries({
  [`${P}/p/me.jsonl`]: [asked(NOW - 60_000), said(NOW - 30_000, 'z', { output_tokens: 1 })].join('\n'),
  '/h/.claude.json': j({ oauthAccount: { subscriptionCreatedAt: '2026-02-03T10:06:38.679279Z' } }),
  // итоги учёта: октябрь подписки — $10 583 и 870 ч, ноябрь — $5 404 и 342 ч
  '/h/.claude/stukach/stats.json': j({
    v: 1, files: {}, isComplete: true,
    hours: {
      [String(Math.floor(new Date(2026, 9, 10).getTime() / 3600_000))]: [10583, 870 * 3600_000, 0],
      [String(Math.floor(new Date(2026, 10, 21).getTime() / 3600_000))]: [5404, 342 * 3600_000, 0],
    },
  }),
  ...extra,
}).map(([k, v]) => [k, { text: v, mtime: NOW }]))

const PANE = (surface: 'desktop' | 'terminal') => ({
  plugin: 'stukach', component: 'Pane', requestId: 'stukach', surface,
  props: { title: 'Помощники', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} },
}) as const

test('панель: погода первой строкой, статистика недели и месяца, раскрытие с графиками', async ($, on) => {
  wire(on, home(), `${P}/p/me.jsonl`)
  const ui = await $.ui.mount(PANE('desktop'))
  expect((await ui.find({ type: 'Text', text: /Малооблачно/ }))?.text).toBe('⛅ Малооблачно')
  expect((await ui.find({ type: 'Text', text: /357k/ }))?.text).toBe('36% · 357k/1M')
  expect(await ui.find({ type: 'Text', text: /^неделя 25%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$9\.72$/ })).toBeDefined()
  expect(await ui.find({ key: 'gear' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Месяц подписки/ }))?.text).toBe(
    'Месяц подписки (3 ноя – 2 дек): ≈ $5 404 по ценам API · ×27 к цене подписки ($200) · агенты работали 342 ч ≈ 43 рабочих дня по 8 ч',
  )
  expect((await ui.find({ type: 'Text', text: /^Неделя лимита/ }))?.text).toContain('(20 ноя 15:00 – 27 ноя 15:00): ≈ $5 404 по ценам API')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()

  await ui.press({ key: 'stats' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^3 окт – 2 ноя/ }))?.text).toBe('3 окт – 2 ноя: $10 583 · 870 ч')
  expect((await ui.find({ type: 'Text', text: /^Учёт с/ }))?.text).toContain('Учёт с 10 окт')
  await ui.unmount()
})

test('панель на терминале: графики полосами текста', async ($, on) => {
  wire(on, home(), `${P}/p/me.jsonl`)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'stats' })
  expect((await ui.find({ type: 'Text', text: /^3 окт █/ }))?.text).toBe('3 окт ████████████████ $10 583')
  await ui.unmount()
})

test('шестерёнка: галочки пишут общий файл настроек, снятые части не рисуются', async ($, on) => {
  const files = home()
  wire(on, files, `${P}/p/me.jsonl`)
  let ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ type: 'Text', text: /скептик · 🔍 поиск/ })).toBeDefined()
  await ui.press({ key: 'gear' })
  await ui.press({ key: 'set-helpers' })
  await ui.press({ key: 'set-weather' })
  expect(JSON.parse(files.get('/h/.claude/stukach/settings.json')!.text)).toEqual({ weather: false, stats: true, helpers: false, price: 200 })
  await ui.unmount()

  ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ type: 'Text', text: /скептик · 🔍 поиск/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Малооблачно/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Месяц подписки/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'stukach', component: 'AbovePrompt', surface: 'desktop',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {}, rows: [] },
} as const

test('над полем ввода: кнопка «👥 Помощники», пока панель закрыта', async ($, on) => {
  wire(on, home(), `${P}/p/me.jsonl`)
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ key: 'open-pane' })).toBeDefined()
  await ui.unmount()
})

test('над полем ввода: открытая панель кнопку прячет', async ($, on) => {
  wire(on, home(), `${P}/p/me.jsonl`, { panes: [{ id: 'stukach', title: 'Помощники', isShown: true, isFocused: false, isPlaced: true }] })
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ key: 'open-pane' })).toBeUndefined()
  await ui.unmount()
})
