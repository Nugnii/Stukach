import type { EngineInterface, Register } from 'claude-code'

import { ago, describeCall, familyOf, parseHead, parseTail, roleOf, scanBackground, shortModel, stateOf } from './board'
import type { Background, Role, State, Tail, Wait } from './board'

const PANE = 'stukach'
const TITLE = 'Помощники'
const DAY = 24 * 3600 * 1000
const TAIL_BYTES = 128 * 1024
const HEAD_BYTES = 8 * 1024
const MAX_HELPERS = 8

type $ = EngineInterface
type Helper = { id: string; role: Role; model?: string; description: string; state: State; tail: Tail }
type SessionView = { id: string; link?: string; depth: number; title: string; model?: string; state: State; tail: Tail; helpers: Helper[]; isMe: boolean }

// Кеш на время жизни модуля: начало файла не меняется, хвост перечитывается при смене размера.
const heads = new Map<string, ReturnType<typeof parseHead>>()
const tails = new Map<string, { size: number; tail: Tail }>()
const bgs = new Map<string, { offset: number; carry: string; pending: Background }>()
const metas = new Map<string, { size: number; mtime: number; meta: Meta }>()
type Meta = { agentType?: string; description?: string; model?: string; pickedEffortModel?: string; finished?: boolean }

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
    st = { offset: 0, carry: '', pending: new Map() }
    bgs.set(path, st)
  }
  while (st.offset < size) {
    const length = Math.min(size - st.offset, 2 * 1024 * 1024)
    const lines = (st.carry + (await $.fs.read(path, { offset: st.offset, length }))).split('\n')
    st.offset += length
    st.carry = lines.pop() ?? ''
    scanBackground(lines, st.pending)
  }
  return [...st.pending.values()]
}

async function metaOf($: $, path: string, size: number, mtime: number) {
  const hit = metas.get(path)
  if (hit && hit.size === size && hit.mtime === mtime) return hit.meta
  const meta = JSON.parse(await $.fs.read(path)) as Meta
  metas.set(path, { size, mtime, meta })
  return meta
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
  const dir = transcriptPath.slice(0, transcriptPath.lastIndexOf('/'))
  const now = await $.clock.now()
  const entries = await $.fs.list(dir)
  const released = new Set(entries.filter(x => x.name.endsWith('.desktop-released.json')).map(x => x.name.split('.')[0]))
  // ponytail: семья ищется среди сессий этого проекта за сутки; дочерняя в другом проекте не видна
  const files = new Map(entries.filter(x => x.kind === 'file' && x.name.endsWith('.jsonl')).map(x => [x.name.slice(0, -6), x]))
  const parents = new Map<string, string | undefined>()
  const started = new Map<string, number>()
  for (const [id, x] of files) {
    if (released.has(id) || (now - x.mtimeMs > DAY && id !== me)) continue
    const h = await head($, `${dir}/${x.name}`)
    parents.set(id, h.parent)
    started.set(id, h.startedAt)
  }
  // предки старше суток: читаем их начало, чтобы найти корень
  for (let p = parents.get(me); p && !parents.has(p) && files.has(p); p = parents.get(p)) {
    parents.set(p, (await head($, `${dir}/${p}.jsonl`)).parent)
  }

  const waitsDir = waitFile.slice(0, waitFile.lastIndexOf('/'))
  const waitNames = new Set((await listOr($, waitsDir)).map(x => x.name))

  const family = familyOf(me, parents, started)
  await appLinks($, waitFile.slice(0, waitFile.indexOf('/.claude/')), family.map(x => x.id)).catch(() => {})
  const views: SessionView[] = []
  for (const { id, depth } of family) {
    const file = files.get(id)
    if (!file) continue
    const own = await listOr($, `${dir}/${id}`)
    const titleFile = own.find(x => x.name === 'custom-title.json')
    const title = titleFile
      ? ((JSON.parse(await $.fs.read(`${dir}/${id}/custom-title.json`)) as { customTitle?: string }).customTitle ?? id.slice(0, 8))
      : id.slice(0, 8)
    const hasWaitFile = waitNames.has(`${id}.json`)
    const waits: Record<string, Wait> = hasWaitFile
      ? JSON.parse(await $.fs.read(`${waitsDir}/${id}.json`).catch(() => '{}'))
      : {}
    const tail = await tailOf($, `${dir}/${file.name}`, file.size)

    const sub = await listOr($, `${dir}/${id}/subagents`)
    const logs = sub.filter(x => /^agent-.*\.jsonl$/.test(x.name)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_HELPERS)
    const helpers: Helper[] = []
    for (const log of logs) {
      const agentId = log.name.slice(6, -6)
      const metaEntry = sub.find(x => x.name === `agent-${agentId}.meta.json`)
      const meta = metaEntry ? await metaOf($, `${dir}/${id}/subagents/${metaEntry.name}`, metaEntry.size, metaEntry.mtimeMs) : {}
      const path = `${dir}/${id}/subagents/${log.name}`
      const t = await tailOf($, path, log.size)
      const description = meta.description ?? ''
      helpers.push({
        id: agentId,
        role: roleOf(description, meta.agentType ?? '', (await head($, path)).prompt),
        model: shortModel(t.model ?? meta.pickedEffortModel ?? meta.model),
        description: description || (meta.agentType ?? agentId),
        state: stateOf({ tail: t, now, isHelper: true, isFinished: meta.finished, wait: waits[agentId], hasWaitFile }),
        tail: t,
      })
    }
    views.push({
      id, depth, title, tail, helpers, isMe: id === me, link: linkOf(id),
      model: shortModel(tail.model),
      state: stateOf({ tail, now, isHelper: false, wait: waits.main, hasWaitFile, background: await backgroundOf($, `${dir}/${file.name}`, file.size) }),
    })
  }
  return views
}

const DOT: Record<State['kind'], string> = { working: '●', waiting: '⏳', done: '✓', idle: '○', silent: '·' }
// работает — фирменный цвет, закончил — зелёный, ждёт разрешения — жёлтый
const COLOR: Partial<Record<State['kind'], 'claude' | 'success' | 'warning' | 'subtle'>> = { working: 'claude', done: 'success', waiting: 'warning', silent: 'subtle' }

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
    const helpers = views.flatMap(v => v.helpers)
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
            {v.helpers.length === 0 && <Text dimColor>{pad(v.depth)}   помощников нет</Text>}
            {v.helpers.map(hp => (
              <Box flexDirection="column">
                <Text color={COLOR[hp.state.kind]} bold={hp.state.kind === 'waiting'} wrap="truncate-end">
                  {pad(v.depth + 1)} {hp.role.icon} {hp.role.name} · {hp.model ?? 'модель ?'} · {DOT[hp.state.kind]} {hp.state.text}
                </Text>
                <Text dimColor wrap="truncate-end">{pad(v.depth + 1)}    {hp.description}</Text>
                {hp.state.kind !== 'done' && <Text dimColor wrap="truncate-end">{pad(v.depth + 1)}    {actionLine(hp.tail, now)}</Text>}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}

