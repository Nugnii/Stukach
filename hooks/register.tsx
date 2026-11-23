import type { EngineInterface, Register } from 'claude-code'

import { ago, describeCall, familyOf, finishedIn, parseHead, parseOr, parseTail, roleOf, scanBackground, shortModel, stateOf } from './board'
import type { Background, BgMemo, Role, State, Tail, Wait } from './board'

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
type SessionView = { id: string; link?: string; depth: number; title: string; model?: string; state: State; tail: Tail; own: Group; waves: Wave[]; isMe: boolean }
type Entry = Awaited<ReturnType<$['fs']['list']>>[number]

// Кеш на время жизни модуля: начало файла не меняется, хвост перечитывается при смене размера.
const heads = new Map<string, ReturnType<typeof parseHead>>()
const tails = new Map<string, { size: number; tail: Tail }>()
const bgs = new Map<string, { offset: number; carry: string; pending: Background; memo: BgMemo }>()
const parsed = new Map<string, { size: number; mtime: number; value: unknown }>()
type Meta = { agentType?: string; description?: string; model?: string; finished?: boolean }
type Run = { status?: string; workflowName?: string } // workflows/<wf_id>.json: пишется, когда волна кончилась

const appIds = new Map<string, string>() // запись приложения local_….json -> номер сессии в файлах
const waiting = new Map<string, Wait>() // ожидания разрешения в ЭТОЙ сессии, по агенту
let me = ''
let waitFile = ''

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
  waitFile = `${await $.env.get('HOME')}/.claude/stukach/waits/${me}.json`
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
        if (cli) appIds.set(f.name, cli)
      }
    }
  }
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
  await appLinks($, waitFile.slice(0, waitFile.indexOf('/.claude/')), family.map(x => x.id)).catch(() => {})
  const views: SessionView[] = []
  for (const { id, depth } of family) {
    const f = files.get(id)
    if (!f) continue
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
    views.push({
      id, depth, title, tail, own: direct, waves, isMe: id === me, link: linkOf(id),
      model: shortModel(tail.model),
      state: stateOf({ tail, now, isHelper: false, wait: waits.main, hasWaitFile, background: await backgroundOf($, `${dir}/${file.name}`, file.size) }),
    })
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stukach', description: 'Панель «Помощники»: сессии этой группы, их помощники, роли, модели, действия' })
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(4000, () => $.ui.invalidate('ui.render'))
    await ensureMe($).then(() => writeWaits($)).catch(() => {}) // сброс: прошлый модуль мог оставить ожидания
    return next(e)
  })

  on('command.run', { command: 'stukach' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Панель «Помощники» открыта.' }
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
    const { Box, Text, Button } = $.ui.resolve(e)
    let views: SessionView[]
    try {
      views = await collect($)
    } catch (err) {
      return <Text color="error">Не прочитать сессии: {String(err)}</Text>
    }
    const now = await $.clock.now()
    const helpers = views.flatMap(v => [...v.own.live, ...v.waves.flatMap(w => w.live)])
    const count = (k: State['kind']) => [...views, ...helpers].filter(x => x.state.kind === k).length

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text>{views.length} сесс. · {helpers.length} помощн.</Text>
          <Text color="success">работают: {count('working')}</Text>
          {count('waiting') > 0 && <Text color="warning" bold>ждут разрешения: {count('waiting')}</Text>}
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
        <Text dimColor wrap="wrap">🧐 скептик · 🔍 поиск · 🛠 исполнитель · ✅ проверка · 🗺 план · ❔ роль не ясна</Text>
        {count('waiting') > 0 && <Text color="warning" bold>⏳ Ждут вашего разрешения: {count('waiting')}</Text>}
        {views.map(v => (
          <Box flexDirection="column" marginTop={1}>
            <Button key={`open-${v.id}`} plain onPress={() => openSession($, v.link)}>
              <Text bold color={COLOR[v.state.kind]} wrap="truncate-end">
                {pad(v.depth)}{DOT[v.state.kind]} {v.title}{v.isMe ? ' (эта сессия)' : ''}{v.depth === 0 && views.length > 1 ? ' (оркестратор)' : ''}
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

