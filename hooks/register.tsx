import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import { SILENT_MS, ago, describeCall, familyOf, finishedIn, parseHead, parseOr, parseTail, roleOf, scanBackground, shortModel, stateOf } from './board'
import type { Background, BgMemo, Role, State, Tail, Wait } from './board'
import { columnsSvg, columnsText } from './charts'
import type { Column } from './charts'
import { ledgerRefresh, ledgerTick, ledgerView } from './ledger'
import { dateShort, limitWeeks, money, payMonths, sumHours, workTime } from './stats'
import type { Hours, Period } from './stats'
import { BAR, CONFIRM_MS, LIMIT_LABEL, cacheLeftMs, coldText, decide, rank, rereadUsd, tokens, usd, weather, weatherModEnabled } from './weather'
import type { Armed, CacheMark } from './weather'

const cacheRef = atom({ plugin: 'stukach', key: 'cache' } as const, null as CacheMark | null)
const armedRef = atom({ plugin: 'stukach', key: 'armed' } as const, null as Armed | null)
const expandedRef = atom({ plugin: 'stukach', key: 'expanded' } as const, false)
const gearRef = atom({ plugin: 'stukach', key: 'gear' } as const, false)

const PANE = 'stukach'
const TITLE = 'Помощники'
const DAY = 24 * 3600 * 1000
const TAIL_BYTES = 128 * 1024
const HEAD_BYTES = 8 * 1024
// ponytail: строк работающих помощников в группе (сессия, волна); в волне их бывают десятки — сверх предела только число
const MAX_HELPERS = 8

type $ = EngineInterface
type Helper = { id: string; role: Role; model?: string; description: string; state: State; tail: Tail }
type Group = { live: Helper[]; done: number; total: number } // live — все незаконченные, ждущие разрешения первыми
type Wave = Group & { name: string }
type SessionView = {
  id: string; link?: string; depth: number; title: string; model?: string; state: State; tail: Tail; own: Group; waves: Wave[]; isMe: boolean
  isOrchestrator: boolean; isParallel: boolean; project?: string // isParallel — из чужой семьи, project — папка сессии в приложении
}
type Entry = Awaited<ReturnType<$['fs']['list']>>[number]

// Кеш на время жизни модуля: начало файла не меняется, хвост перечитывается при смене размера.
const heads = new Map<string, ReturnType<typeof parseHead>>()
const tails = new Map<string, { size: number; tail: Tail }>()
const bgs = new Map<string, { offset: number; carry: string; pending: Background; memo: BgMemo }>()
const parsed = new Map<string, { size: number; mtime: number; value: unknown }>()
type Meta = { agentType?: string; description?: string; model?: string; finished?: boolean }
type Run = { status?: string; workflowName?: string } // workflows/<wf_id>.json: пишется, когда волна кончилась

const appIds = new Map<string, string>() // запись приложения local_….json -> номер сессии в файлах
const appCwds = new Map<string, string>() // номер сессии в файлах -> её папка из записи приложения
const waiting = new Map<string, Wait>() // ожидания разрешения в ЭТОЙ сессии, по агенту
let me = ''
let waitFile = ''
let home = ''

async function head($: $, path: string) {
  let h = heads.get(path)
  if (!h) {
    h = parseHead(await $.fs.read(path, { length: HEAD_BYTES }))
    heads.set(path, h)
  }
  return h
}

async function tailOf($: $, path: string, size: number) {
  const hit = tails.get(path)
  if (hit && hit.size === size) return hit.tail
  const offset = Math.max(0, size - TAIL_BYTES)
  const tail = parseTail(await $.fs.read(path, { offset, length: size - offset }), offset > 0)
  tails.set(path, { size, tail })
  return tail
}

// Фоновые задачи видны только по всей расшифровке: дочитываем её с места, где остановились.
async function backgroundOf($: $, path: string, size: number) {
  let st = bgs.get(path)
  if (!st || size < st.offset) {
    st = { offset: 0, carry: '', pending: new Map(), memo: { ended: new Set(), stops: new Map() } }
    bgs.set(path, st)
  }
  while (st.offset < size) {
    const length = Math.min(size - st.offset, 2 * 1024 * 1024)
    const lines = (st.carry + (await $.fs.read(path, { offset: st.offset, length }))).split('\n')
    st.offset += length
    st.carry = lines.pop() ?? ''
    scanBackground(lines, st.pending, st.memo)
  }
  return [...st.pending.values()]
}

// Малый файл целиком (meta помощника, журнал волны), разобранный заново только при смене размера или времени.
async function parsedOf<T>($: $, path: string, e: Entry, parse: (text: string) => T): Promise<T> {
  const hit = parsed.get(path)
  if (hit && hit.size === e.size && hit.mtime === e.mtimeMs) return hit.value as T
  const value = parse(await $.fs.read(path))
  parsed.set(path, { size: e.size, mtime: e.mtimeMs, value })
  return value
}

type Ctx = { now: number; waits: Record<string, Wait>; hasWaitFile: boolean }

const isLog = (x: Entry) => /^agent-.*\.jsonl$/.test(x.name)

// Помощники одной папки. Законченный — только в числе: его строка владельцу не нужна.
// ponytail: хвост читается у каждого незаконченного, не у восьми свежих — иначе законченный по хвосту и ждущий
// разрешения прятались за пределом; потолок — десятки помощников, одновременно пишущих расшифровки
async function helpersIn($: $, folder: string, entries: Entry[], finished: Set<string>, c: Ctx): Promise<Group> {
  const logs = entries.filter(isLog).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const g: Group = { live: [], done: 0, total: logs.length }
  for (const log of logs) {
    const agentId = log.name.slice(6, -6)
    const metaEntry = entries.find(x => x.name === `agent-${agentId}.meta.json`)
    const meta: Meta = metaEntry ? await parsedOf($, `${folder}/${metaEntry.name}`, metaEntry, t => parseOr<Meta>(t, {})) : {}
    const wait = c.waits[agentId]
    if (!wait && (meta.finished || finished.has(agentId))) { g.done++; continue }
    const path = `${folder}/${log.name}`
    const t = await tailOf($, path, log.size)
    const state = stateOf({ tail: t, now: c.now, isHelper: true, isFinished: meta.finished, wait, hasWaitFile: c.hasWaitFile })
    if (state.kind === 'done') { g.done++; continue }
    const description = meta.description ?? ''
    g.live.push({
      id: agentId,
      role: roleOf(description, meta.agentType ?? '', (await head($, path)).prompt),
      // модель — из ответов помощника; до первого ответа — заказанная (pickedEffortModel с ответами расходится)
      model: shortModel(t.model ?? meta.model),
      description: description || (meta.agentType ?? agentId),
      state,
      tail: t,
    })
  }
  g.live.sort((a, b) => Number(b.state.kind === 'waiting') - Number(a.state.kind === 'waiting')) // порядок по времени сохраняется
  return g
}

// Волны (Workflow): помощники в subagents/workflows/<волна>/. Кончилась волна — есть workflows/<волна>.json
// (completed, killed, failed); кончился помощник — запись result или failed в журнале волны.
async function wavesOf($: $, sessionDir: string, c: Ctx): Promise<Wave[]> {
  const root = `${sessionDir}/subagents/workflows`
  const runs = await listOr($, `${sessionDir}/workflows`)
  const scripts = await listOr($, `${sessionDir}/workflows/scripts`)
  const waves: Wave[] = []
  for (const w of (await listOr($, root)).filter(x => x.kind === 'dir')) {
    const entries = await listOr($, `${root}/${w.name}`)
    const runEntry = runs.find(x => x.name === `${w.name}.json`)
    const run = runEntry ? await parsedOf($, `${sessionDir}/workflows/${runEntry.name}`, runEntry, t => parseOr<Run>(t, {})) : undefined
    const script = scripts.find(x => x.name.endsWith(`-${w.name}.js`))
    const name = run?.workflowName ?? (script ? script.name.slice(0, -(w.name.length + 4)) : w.name)
    if (run?.status && run.status !== 'running') {
      const n = entries.filter(isLog).length
      waves.push({ name, live: [], done: n, total: n })
      continue
    }
    const journal = entries.find(x => x.name === 'journal.jsonl')
    const finished = journal ? await parsedOf($, `${root}/${w.name}/journal.jsonl`, journal, finishedIn) : new Set<string>()
    waves.push({ name, ...(await helpersIn($, `${root}/${w.name}`, entries, finished, c)) })
  }
  return waves
}

const listOr = ($: $, path: string) => $.fs.list(path).catch(() => [])

async function ensureMe($: $) {
  if (me) return
  const info = await $.session.info()
  me = info.transcriptPath.split('/').pop()!.replace(/\.jsonl$/, '')
  home = (await $.env.get('HOME')) ?? ''
  waitFile = `${home}/.claude/stukach/waits/${me}.json`
}

// Настройки — файл, общий для всех окон: галочка, снятая в одном, снята во всех.
type Settings = { weather: boolean; stats: boolean; helpers: boolean; price: number }
const DEFAULTS: Settings = { weather: true, stats: true, helpers: true, price: 200 }
let settings: Settings = DEFAULTS
let settingsMtime = -1
const settingsFile = () => `${home}/.claude/stukach/settings.json`

async function settingsOf($: $): Promise<Settings> {
  await ensureMe($)
  const st = await $.fs.stat(settingsFile()).catch(() => undefined)
  if (!st) return (settings = DEFAULTS)
  if (st.mtimeMs !== settingsMtime) {
    settings = { ...DEFAULTS, ...parseOr<Partial<Settings>>(await $.fs.read(settingsFile()).catch(() => ''), {}) }
    settingsMtime = st.mtimeMs
  }
  return settings
}

async function saveSettings($: $, patch: Partial<Settings>) {
  settings = { ...(await settingsOf($)), ...patch }
  await $.fs.write(settingsFile(), JSON.stringify(settings))
  settingsMtime = -1
  $.ui.invalidate('ui.render')
}

// День оплаты подписки — из учётки Claude Code (oauthAccount.subscriptionCreatedAt); без подписки — 1-е число.
let pay: { day: number; isSub: boolean } | undefined
async function payDayOf($: $) {
  if (!pay) {
    const text = await $.fs.read(`${home}/.claude.json`).catch(() => '')
    const at = Date.parse(/"subscriptionCreatedAt":\s*"([^"]+)"/.exec(text)?.[1] ?? '')
    pay = at ? { day: new Date(at).getDate(), isSub: true } : { day: 1, isSub: false }
  }
  return pay
}

async function writeWaits($: $) {
  await $.fs.write(waitFile, JSON.stringify(Object.fromEntries(waiting)))
}

// Номер сессии в приложении (local_…) по номеру в файлах: приложение пишет его в свою запись о сессии.
async function appLinks($: $, home: string, wanted: string[]) {
  const root = `${home}/Library/Application Support/Claude/claude-code-sessions`
  const known = new Set(appIds.values())
  if (wanted.every(id => known.has(id))) return
  for (const account of await listOr($, root)) {
    for (const org of await listOr($, `${root}/${account.name}`)) {
      for (const f of await listOr($, `${root}/${account.name}/${org.name}`)) {
        if (!/^local_.*\.json$/.test(f.name) || appIds.has(f.name)) continue
        const head = await $.fs.read(`${root}/${account.name}/${org.name}/${f.name}`, { length: 1024 }).catch(() => '')
        const cli = /"cliSessionId":\s*"([^"]+)"/.exec(head)?.[1]
        const cwd = /"cwd":\s*"([^"]+)"/.exec(head)?.[1]
        if (cli) appIds.set(f.name, cli)
        if (cli && cwd) appCwds.set(cli, cwd)
      }
    }
  }
}

// Папка сессии коротко: последнее имя пути; рабочая папка, которую приложение завело само, — «без папки».
function projectOf(cliId: string) {
  const cwd = appCwds.get(cliId)
  if (!cwd) return undefined
  return cwd.includes('/scratch-workspaces/') ? 'без папки' : cwd.split('/').filter(Boolean).pop()
}

function linkOf(cliId: string) {
  for (const [file, cli] of appIds) if (cli === cliId) return `claude://claude.ai/epitaxy/${file.slice(0, -5)}`
  return undefined
}

async function openSession($: $, link?: string) {
  if (link) await $.process.run(['open', link]).catch(() => undefined)
}

async function clearWait($: $, agentId?: string) {
  if (!waiting.delete(agentId ?? 'main')) return
  await writeWaits($).catch(() => {})
  $.ui.invalidate('ui.render')
}

async function collect($: $): Promise<SessionView[]> {
  await ensureMe($)
  const { transcriptPath } = await $.session.info()
  const here = transcriptPath.slice(0, transcriptPath.lastIndexOf('/'))
  const root = here.slice(0, here.lastIndexOf('/'))
  const now = await $.clock.now()
  // Семья ищется по всем проектам: оркестратор запускает сессии в других папках (замер 23.11: оркестратор
  // в ClaudSoul, его сессии — в папках своих репозиториев). Папка каждой сессии — своя.
  // ponytail: 53 папки читаются за сотые доли секунды; станет тяжело — читать только папки с новым mtime
  const dirs = [here, ...(await listOr($, root)).filter(x => x.kind === 'dir').map(x => `${root}/${x.name}`).filter(d => d !== here)]
  const files = new Map<string, { dir: string; entry: Entry }>()
  const released = new Set<string>()
  for (const d of dirs) {
    for (const x of d === here ? await $.fs.list(d) : await listOr($, d)) {
      const id = x.name.split('.')[0] ?? ''
      if (x.name.endsWith('.desktop-released.json')) released.add(id)
      else if (x.kind === 'file' && x.name.endsWith('.jsonl') && !files.has(id)) files.set(id, { dir: d, entry: x })
    }
  }
  const pathOf = (id: string) => { const f = files.get(id)!; return `${f.dir}/${f.entry.name}` }
  const parents = new Map<string, string | undefined>()
  const started = new Map<string, number>()
  for (const [id, { entry }] of files) {
    if (released.has(id) || (now - entry.mtimeMs > DAY && id !== me)) continue
    const h = await head($, pathOf(id))
    parents.set(id, h.parent)
    started.set(id, h.startedAt)
  }
  // предки старше суток: читаем их начало, чтобы найти корень
  for (let p = parents.get(me); p && !parents.has(p) && files.has(p); p = parents.get(p)) {
    parents.set(p, (await head($, pathOf(p))).parent)
  }

  const waitsDir = waitFile.slice(0, waitFile.lastIndexOf('/'))
  const waitNames = new Set((await listOr($, waitsDir)).map(x => x.name))

  const family = familyOf(me, parents, started)
  // Параллельные семьи — деревья без этой сессии: другие проекты, сессии, открытые вручную. Новые первыми.
  const trees = [family]
  const seen = new Set(family.map(x => x.id))
  for (const id of [...parents.keys()].sort((a, b) => (started.get(b) ?? 0) - (started.get(a) ?? 0))) {
    if (seen.has(id)) continue
    const tree = familyOf(id, parents, started)
    for (const x of tree) seen.add(x.id)
    trees.push(tree)
  }

  const viewOf = async (id: string, depth: number, isOrchestrator: boolean, isParallel: boolean): Promise<SessionView | undefined> => {
    const f = files.get(id)
    if (!f) return undefined
    const { dir, entry: file } = f
    const own = await listOr($, `${dir}/${id}`)
    const titleFile = own.find(x => x.name === 'custom-title.json')
    const title = titleFile
      ? (parseOr<{ customTitle?: string }>(await $.fs.read(`${dir}/${id}/custom-title.json`).catch(() => ''), {}).customTitle ?? id.slice(0, 8))
      : id.slice(0, 8)
    const hasWaitFile = waitNames.has(`${id}.json`)
    const waits: Record<string, Wait> = hasWaitFile
      ? parseOr<Record<string, Wait>>(await $.fs.read(`${waitsDir}/${id}.json`).catch(() => '{}'), {})
      : {}
    const tail = await tailOf($, `${dir}/${file.name}`, file.size)

    const ctx: Ctx = { now, waits, hasWaitFile }
    const direct = await helpersIn($, `${dir}/${id}/subagents`, await listOr($, `${dir}/${id}/subagents`), new Set(), ctx)
    const waves = await wavesOf($, `${dir}/${id}`, ctx)
    return {
      id, depth, title, tail, own: direct, waves, isMe: id === me, isOrchestrator, isParallel,
      model: shortModel(tail.model),
      state: stateOf({ tail, now, isHelper: false, wait: waits.main, hasWaitFile, background: await backgroundOf($, `${dir}/${file.name}`, file.size) }),
    }
  }
  // живая — работает, ждёт разрешения, писала за последние 30 минут или у неё работает помощник
  const isBusy = (s: State) => s.kind === 'working' || s.kind === 'waiting'
  const isLive = (v: SessionView) => isBusy(v.state) || now - v.tail.lastTs < SILENT_MS || [v.own, ...v.waves].some(g => g.live.some(h => isBusy(h.state)))

  // ponytail: разбирается каждая сессия суток на каждом тике (хвосты кешированы по размеру); станет тяжело —
  // отсеивать чужие семьи по mtime расшифровок до разбора
  const views: SessionView[] = []
  for (const [k, tree] of trees.entries()) {
    const part: SessionView[] = []
    for (const { id, depth } of tree) {
      const v = await viewOf(id, depth, depth === 0 && tree.length > 1, k > 0)
      if (v) part.push(v)
    }
    if (k === 0 || part.some(isLive)) views.push(...part)
  }
  await appLinks($, waitFile.slice(0, waitFile.indexOf('/.claude/')), views.map(v => v.id)).catch(() => {})
  for (const v of views) {
    v.link = linkOf(v.id)
    v.project = projectOf(v.id)
  }
  return views
}

const DOT: Record<State['kind'], string> = { working: '●', waiting: '⏳', done: '✓', idle: '○', silent: '·' }
// работает — фирменный цвет, закончил — зелёный, ждёт разрешения — жёлтый
const COLOR: Partial<Record<State['kind'], 'claude' | 'success' | 'warning' | 'subtle'>> = { working: 'claude', done: 'success', waiting: 'warning', silent: 'subtle' }

const doneOf = (v: SessionView) => v.own.done + v.waves.reduce((n, w) => n + w.done, 0)

function actionLine(t: Tail, now: number): string {
  const a = t.action
  if (!a) return 'действий ещё нет'
  return `${a.isPending ? 'сейчас' : 'последнее'}: ${a.tool}${a.what ? ` — ${a.what}` : ''} · ${ago(now - a.ts)} назад`
}

const HOUR = 3_600_000
const plural = (n: number, forms: [string, string, string]) => {
  const k = n % 100, j = n % 10
  return k > 10 && k < 20 ? forms[2] : j === 1 ? forms[0] : j >= 2 && j <= 4 ? forms[1] : forms[2]
}
// «сколько времени сэкономили агенты» — в рабочих днях человека
const workDays = (ms: number) => {
  const d = Math.round(ms / (8 * HOUR))
  return d >= 1 ? ` ≈ ${d} ${plural(d, ['рабочий день', 'рабочих дня', 'рабочих дней'])} по 8 ч` : ''
}
const timesPrice = (usd: number, price: number) =>
  price > 0 && usd > 0 ? ` · ×${(usd / price).toFixed(usd / price >= 10 ? 0 : 1)} к цене подписки ($${price})` : ''
const firstHour = (h: Hours) => Math.min(...Object.keys(h).map(Number)) * HOUR // Infinity, пока учёт пуст

/** Периоды с данными: столбцы стоимости и часов и строки таблицы; периоды раньше начала учёта не показываются. */
function columnsOf(hours: Hours, periods: Period[], label: (p: Period) => string, now: number) {
  const start = firstHour(hours)
  const rows = periods.filter(p => p.to > start).map(p => ({ p, t: sumHours(hours, p.from, p.to), isCurrent: p.from <= now && now < p.to }))
  const usdCols: Column[] = rows.map(({ p, t, isCurrent }) => ({ label: label(p), value: t.usd, isCurrent, tip: `${label(p)}: ${money(t.usd)} по ценам API` }))
  const hourCols: Column[] = rows.map(({ p, t, isCurrent }) => ({ label: label(p), value: t.ms / HOUR, isCurrent, tip: `${label(p)}: агенты работали ${workTime(t.ms)}` }))
  return { rows, usdCols, hourCols }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stukach', description: 'Панель «Помощники»: сессии этой группы и живые параллельные, их помощники, роли, модели, действия' })
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(4000, () => $.ui.invalidate('ui.render'))
    // Учёт статистики дочитывает расшифровки фоном; ведёт одна сессия, остальные читают готовое.
    $.clock.every(5000, async () => {
      try {
        if (!(await settingsOf($)).stats) return
        if (await ledgerTick($, home, me)) $.ui.invalidate('ui.render')
      } catch { /* учёт — не повод ронять сессию */ }
    })
    await ensureMe($).then(() => writeWaits($)).catch(() => {}) // сброс: прошлый модуль мог оставить ожидания
    return next(e)
  })

  on('command.run', { command: 'stukach' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Панель «Помощники» открыта.' }
  })

  // Погода: запросы основной сессии к модели — от каждого считается жизнь кеша, срок — из ответа API.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      await update($, cacheRef, old => {
        const ttl = (usage.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : (usage.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : (old?.ttl ?? '5m')
        return { at, ttl }
      })
    }
    return result
  })

  // Погода: на остывшем кеше первое Enter не отправляет, а называет цену; второе в течение 2 минут — отправляет.
  // Только набранный человеком текст: команда или сообщение с картинкой проходят — в поле ввода их не вернуть целиком.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.command !== undefined || (e.attachments?.length ?? 0) > 0) return next(e)
    if (!(await settingsOf($).catch(() => DEFAULTS)).weather) return next(e)
    // включён и context-weather — Enter придерживает он, второй придержки не нужно
    if (weatherModEnabled(await $.settings.read({ key: 'enabledPlugins' }).catch(() => undefined))) return next(e)
    const now = await $.clock.now()
    const mark = await read($, cacheRef)
    const verdict = decide(mark, await read($, armedRef), now)
    if (verdict === 'send') return next(e)
    if (verdict === 'confirm') {
      await update($, armedRef, () => null)
      return next(e)
    }
    const { context } = await $.session.usage()
    const count = context.tokens ?? 0
    const minutes = mark === null ? 0 : Math.floor((now - mark.at) / 60_000)
    const cost = mark === null ? undefined : rereadUsd(await $.session.model(), count, mark.ttl)
    await update($, armedRef, () => ({ at: now, minutes, tokens: count, ...cost }))
    await $.prompt.fill({ text: e.text })
    return {
      drop: cost === undefined
        ? 'Кеш остыл: Enter ещё раз отправит сообщение.'
        : `Кеш остыл: отправка ≈ ${usd(cost.cold)} по ценам API. Enter ещё раз отправит сообщение.`,
    }
  })

  // Над полем ввода: предупреждение об остывшем кеше и кнопка, открывающая панель, пока она закрыта.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const armed = (await settingsOf($).catch(() => DEFAULTS)).weather ? await read($, armedRef) : null
    const isShown = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE && p.isShown && p.isPlaced)
    const isArmed = armed !== null && now - armed.at < CONFIRM_MS
    if (!isArmed && isShown) return next(e)
    return (
      <Box flexDirection="column">
        {isArmed && (
          <Box borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning">
              {coldText(armed.minutes, armed.tokens, armed.cold === undefined || armed.warm === undefined ? undefined : { cold: armed.cold, warm: armed.warm })}
            </Text>
          </Box>
        )}
        {!isShown && (
          <Button key="open-pane" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: TITLE })}>
            👥 Помощники
          </Button>
        )}
      </Box>
    )
  })

  // Ожидание разрешения видно только изнутри сессии: пишем его в файл, панель любой сессии читает.
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      await ensureMe($)
      waiting.set(e.agent_id ?? 'main', { ...describeCall(e.tool_name, e.tool_input), since: await $.clock.now() })
      await writeWaits($)
      $.ui.invalidate('ui.render')
    } catch { /* панель — не повод ломать запрос разрешения */ }
    return next(e)
  }).catch(($, e, next) => next(e)) // наблюдатель: сбой не меняет исход запроса

  on('tool.run', async ($, e, next) => { await clearWait($, e.agentId); return next(e) })
    .catch(($, e, next) => next(e))
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await clearWait($, e.agentId)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const Svg = e.surface === 'terminal' ? undefined : (els as Elements['desktop']).Svg // на терминале графиков нет — столбцы текстом
    const s = await settingsOf($).catch(() => DEFAULTS)
    const now = await $.clock.now()
    const usage = await $.session.usage().catch(() => undefined)
    let views: SessionView[] = []
    let readError = ''
    if (s.helpers) {
      try {
        views = await collect($)
      } catch (err) {
        readError = String(err)
      }
    }
    const helpers = views.flatMap(v => [...v.own.live, ...v.waves.flatMap(w => w.live)])
    const count = (k: State['kind']) => [...views, ...helpers].filter(x => x.state.kind === k).length

    // Статистика: неделя лимита (по сбросу недельного окна) и месяц подписки (с дня оплаты).
    if (s.stats) await ledgerRefresh($, home).catch(() => {})
    const { hours, progress } = ledgerView()
    const p = await payDayOf($)
    const resetsAt = Date.parse(usage?.rateLimits.find(l => l.kind === 'seven_day')?.resetsAt ?? '') || undefined
    const week = limitWeeks(resetsAt, now, 1)[0]!
    const month = payMonths(p.day, now, 1)[0]!
    const w = sumHours(hours, week.from, week.to)
    const m = sumHours(hours, month.from, month.to)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          {s.helpers && <Text>{views.length} сесс. · {helpers.length} помощн.</Text>}
          {s.helpers && <Text color="success">работают: {count('working')}</Text>}
          {count('waiting') > 0 && <Text color="warning" bold>ждут разрешения: {count('waiting')}</Text>}
          {s.stats && <Text dimColor>≈ {money(m.usd)} за месяц по ценам API</Text>}
        </Box>
      )
    }

    // Первая строка: погода этой сессии (как в моде context-weather) и шестерёнка настроек.
    const mark = await read($, cacheRef)
    const weatherParts = () => {
      if (!usage) return [<Text dimColor>погода: —</Text>]
      const { context, rateLimits, cost } = usage
      const percent = context.percent ?? (context.tokens === undefined ? 0 : (context.tokens / context.window) * 100)
      const sky = weather(percent)
      const filled = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)))
      const left = mark === null ? 0 : cacheLeftMs(mark, now)
      return [
        <Text color={sky.color} bold>{`${sky.icon} ${sky.name}`}</Text>,
        <Box flexDirection="row">
          {filled > 0 && <Text color={sky.color}>{'█'.repeat(filled)}</Text>}
          {filled < BAR && <Text dimColor>{'░'.repeat(BAR - filled)}</Text>}
        </Box>,
        <Text>{context.tokens === undefined ? '—' : `${Math.round(percent)}% · ${tokens(context.tokens)}/${tokens(context.window)}`}</Text>,
        ...[...rateLimits].sort((a, b) => rank(a.kind) - rank(b.kind)).map(l => (
          <Text {...(l.percentUsed >= 80 ? { color: 'warning' as const } : { dimColor: true })}>{`${LIMIT_LABEL[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%`}</Text>
        )),
        cost !== undefined && <Text dimColor>{`$${cost.usd.toFixed(2)}`}</Text>,
        mark !== null && (left > 0 ? <Text dimColor>{`кеш: ещё ${Math.ceil(left / 60_000)} мин`}</Text> : <Text color="error">кеш остыл</Text>),
      ]
    }
    const isGear = await read($, gearRef)
    const box = (isOn: boolean) => (isOn ? '☑' : '☐')
    const topRow = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{s.weather ? weatherParts() : <Text dimColor>{TITLE}</Text>}</Box>
        <Button key="gear" plain onPress={() => update($, gearRef, g => !g)}>⚙</Button>
      </Box>
    )
    const gear = isGear && (
      <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
        <Text bold>Что показывать</Text>
        <Button key="set-weather" plain onPress={() => saveSettings($, { weather: !s.weather })}>{box(s.weather)} Погода контекста</Button>
        <Button key="set-stats" plain onPress={() => saveSettings($, { stats: !s.stats })}>{box(s.stats)} Статистика</Button>
        <Button key="set-helpers" plain onPress={() => saveSettings($, { helpers: !s.helpers })}>{box(s.helpers)} Помощники</Button>
        <Input
          key="set-price"
          label="Подписка, $ в месяц: "
          value={String(s.price)}
          submitLabel="сохранить"
          onSubmit={v => {
            const n = Number(v.trim().replace(',', '.'))
            if (Number.isFinite(n) && n >= 0) void saveSettings($, { price: n })
          }}
        />
        <Button key="gear-done" onPress={() => update($, gearRef, () => false)}>Готово</Button>
      </Box>
    )

    const isExpanded = await read($, expandedRef)
    const weekName = resetsAt ? `Неделя лимита (${dateShort(week.from, true)} – ${dateShort(week.to, true)})` : 'Последние 7 дней'
    const monthName = `${p.isSub ? 'Месяц подписки' : 'Месяц'} (${dateShort(month.from)} – ${dateShort(month.to - 1)})`
    const section = (title: string, periods: Period[], range: (q: Period) => string) => {
      const c = columnsOf(hours, periods, q => dateShort(q.from), now)
      const hoursText = (h: number) => workTime(h * HOUR)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{title}</Text>
          {c.rows.length === 0 && <Text dimColor>данных ещё нет</Text>}
          {c.rows.length > 0 && Svg && [
            <Svg source={columnsSvg('Стоимость по ценам API', c.usdCols, money)} alt={`Стоимость по ценам API: ${c.usdCols.map(x => `${x.label} ${money(x.value)}`).join(', ')}`} isInteractive />,
            <Svg source={columnsSvg('Работа агентов', c.hourCols, hoursText)} alt={`Работа агентов: ${c.hourCols.map(x => `${x.label} ${hoursText(x.value)}`).join(', ')}`} isInteractive />,
          ]}
          {c.rows.length > 0 && !Svg && [
            <Text dimColor>Стоимость по ценам API</Text>,
            ...columnsText(c.usdCols, money).map(line => <Text wrap="truncate-end">{line}</Text>),
            <Text dimColor>Работа агентов</Text>,
            ...columnsText(c.hourCols, hoursText).map(line => <Text wrap="truncate-end">{line}</Text>),
          ]}
          {c.rows.map(({ p: q, t }) => <Text dimColor wrap="truncate-end">{range(q)}: {money(t.usd)} · {workTime(t.ms)}</Text>)}
        </Box>
      )
    }
    const start = firstHour(hours)
    const stats = s.stats && (
      <Box flexDirection="column" marginTop={1}>
        <Button key="stats" plain onPress={() => update($, expandedRef, x => !x)}>
          <Text bold>📊 Статистика {isExpanded ? '▾ свернуть' : '▸ история и графики'}</Text>
        </Button>
        {progress !== undefined && <Text dimColor>считаю историю расшифровок: {Math.round(progress * 100)}% — числа пока неполные</Text>}
        <Text wrap="wrap">{weekName}: ≈ {money(w.usd)} по ценам API · агенты работали {workTime(w.ms)}{workDays(w.ms)}</Text>
        <Text wrap="wrap">{monthName}: ≈ {money(m.usd)} по ценам API{timesPrice(m.usd, s.price)} · агенты работали {workTime(m.ms)}{workDays(m.ms)}</Text>
        {m.unpriced > 0 && <Text dimColor>ответов модели без цены за месяц: {m.unpriced}</Text>}
        {isExpanded && [
          section('По месяцам подписки', payMonths(p.day, now, 6), q => `${dateShort(q.from)} – ${dateShort(q.to - 1)}`),
          section('По неделям лимита', limitWeeks(resetsAt, now, 12), q => `${dateShort(q.from, true)} – ${dateShort(q.to, true)}`),
          Number.isFinite(start) && <Text dimColor wrap="wrap">Учёт с {dateShort(start)}: расшифровки старше 90 дней Claude Code удаляет, дальше мод хранит итоги сам. Цены — справочник Claude API на 3 ноября 2026.</Text>,
        ]}
      </Box>
    )

    if (!s.helpers) {
      return (
        <Box flexDirection="column">
          {topRow}
          {gear}
          {stats}
        </Box>
      )
    }
    if (readError) {
      return (
        <Box flexDirection="column">
          {topRow}
          {gear}
          {stats}
          <Text color="error">Не прочитать сессии: {readError}</Text>
        </Box>
      )
    }

    const pad = (depth: number) => '  '.repeat(depth)
    const rows = (hp: Helper, depth: number) => (
      <Box flexDirection="column">
        <Text color={COLOR[hp.state.kind]} bold={hp.state.kind === 'waiting'} wrap="truncate-end">
          {pad(depth)} {hp.role.icon} {hp.role.name} · {hp.model ?? 'модель ?'} · {DOT[hp.state.kind]} {hp.state.text}
        </Text>
        <Text dimColor wrap="truncate-end">{pad(depth)}    {hp.description}</Text>
        <Text dimColor wrap="truncate-end">{pad(depth)}    {actionLine(hp.tail, now)}</Text>
      </Box>
    )
    // первые MAX_HELPERS строкой, остальные числом
    const group = (g: Group, depth: number) => [
      ...g.live.slice(0, MAX_HELPERS).map(hp => rows(hp, depth)),
      g.live.length > MAX_HELPERS && <Text dimColor>{pad(depth)}    …и ещё работают: {g.live.length - MAX_HELPERS}</Text>,
    ]
    return (
      <Box flexDirection="column">
        {topRow}
        {gear}
        {stats}
        <Text dimColor wrap="wrap">{s.weather || s.stats ? '\n' : ''}🧐 скептик · 🔍 поиск · 🛠 исполнитель · ✅ проверка · 🗺 план · ❔ роль не ясна</Text>
        {count('waiting') > 0 && <Text color="warning" bold>⏳ Ждут вашего разрешения: {count('waiting')}</Text>}
        {views.map((v, k) => (
          <Box flexDirection="column" marginTop={1}>
            {v.isParallel && !views[k - 1]?.isParallel && <Text bold dimColor>── Параллельно, другие сессии ──</Text>}
            <Button key={`open-${v.id}`} plain onPress={() => openSession($, v.link)}>
              <Text bold color={COLOR[v.state.kind]} wrap="truncate-end">
                {pad(v.depth)}{DOT[v.state.kind]} {v.isParallel && v.project ? `${v.project} · ` : ''}{v.title}{v.isMe ? ' (эта сессия)' : ''}{v.isOrchestrator ? ' (оркестратор)' : ''}
              </Text>
            </Button>
            <Text dimColor={v.state.kind !== 'waiting'} color={COLOR[v.state.kind]} wrap="truncate-end">
              {pad(v.depth)}   {v.model ?? 'модель ?'} · {v.state.text}
            </Text>
            <Text dimColor wrap="truncate-end">{pad(v.depth)}   {actionLine(v.tail, now)}</Text>
            {v.waves.filter(w => w.live.length > 0).map(w => (
              <Box flexDirection="column">
                <Text bold wrap="truncate-end">{pad(v.depth + 1)} 🌊 волна «{w.name}» · идут {w.live.length} из {w.total}</Text>
                {group(w, v.depth + 2)}
              </Box>
            ))}
            {group(v.own, v.depth + 1)}
            {doneOf(v) > 0 && <Text color="success" dimColor>{pad(v.depth + 1)} ✓ закончили: {doneOf(v)}</Text>}
            {v.own.total + v.waves.reduce((n, w) => n + w.total, 0) === 0 && <Text dimColor>{pad(v.depth)}   помощников нет</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}

