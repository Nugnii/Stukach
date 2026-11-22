// Разбор файлов сессий: роль, модель, последнее действие, состояние.
// Без обращений к $, поэтому тест проверяет это напрямую.

export type Role = { icon: string; name: string }
export type Call = { tool: string; what: string }
export type Action = Call & { ts: number; isPending: boolean }
export type Tail = { model?: string; action?: Action; lastTs: number; isTurnEnded: boolean }
export type Wait = Call & { since: number }
export type StateKind = 'waiting' | 'working' | 'done' | 'idle' | 'silent'
export type State = { kind: StateKind; text: string }

export const UNKNOWN_ROLE: Role = { icon: '❔', name: 'роль не ясна' }
const SKEPTIC = { icon: '🧐', name: 'скептик', re: /скептик|критик|адверсар|прожар|опроверг|ревью|\b(skeptic|critic|adversar|review|red.?team)/i }
// ponytail: роль по словам описания; ошибается на описаниях без ролевых слов — тогда «роль не ясна»
const ROLES = [
  { icon: '🔍', name: 'поиск', re: /поиск|ищ[еиу]|найд|найти|разведк|собер[иу] факт|сбор факт|\b(search|explore|find|look ?up|survey|grep|locate|research)/i },
  { icon: '🛠', name: 'исполнитель', re: /исполн|почин|исправ|поправ|правк|напиш|сдела|собер[иу](?! факт)|сборк|мутант|перенес|\b(implement|fix|edit|write|build|mutant|refactor|migrat|apply)/i },
  { icon: '✅', name: 'проверка', re: /провер|прогон|прогна|тест|набор|свер[кь]|воспроизв|\b(verify|check|test|suite|run_all|reproduc|validat)/i },
  { icon: '🗺', name: 'план', re: /план|архитект|\b(plan|design)/i },
]
const ROLE_BY_TYPE: Record<string, string> = { Explore: 'поиск', Plan: 'план', 'claude-code-guide': 'поиск' }

function roleIn(text: string): Role | undefined {
  if (SKEPTIC.re.test(text)) return SKEPTIC
  let best: Role | undefined
  let at = Infinity
  for (const r of ROLES) {
    const m = r.re.exec(text)
    if (m && m.index < at) { at = m.index; best = r }
  }
  return best
}

/** Роль помощника: по описанию вызова, затем по типу агента, затем по началу задания. */
export function roleOf(description: string, type: string, prompt: string): Role {
  const typed = ROLES.find(r => r.name === ROLE_BY_TYPE[type])
  const found = roleIn(description) ?? typed ?? roleIn(prompt.slice(0, 400))
  return found ? { icon: found.icon, name: found.name } : UNKNOWN_ROLE
}

export function shortModel(id?: string): string | undefined {
  if (!id) return undefined
  for (const name of ['opus', 'sonnet', 'haiku', 'fable']) if (id.toLowerCase().includes(name)) return name
  return id
}

const VERBS: Record<string, string> = {
  Bash: 'команда', Read: 'читает', Edit: 'правит', Write: 'пишет', NotebookEdit: 'правит',
  Grep: 'ищет', Glob: 'ищет файлы', Agent: 'зовёт помощника', Task: 'зовёт помощника',
  WebFetch: 'читает страницу', WebSearch: 'ищет в сети', Skill: 'берёт скилл',
  ToolSearch: 'подгружает инструменты', SubagentHandback: 'сдаёт отчёт',
  AskUserQuestion: 'спрашивает вас', SendMessage: 'пишет сессии', Workflow: 'запускает волну',
  mcp__ccd_turn__update_plan: 'обновляет план', mcp__ccd_turn__wrap_up: 'подводит итог',
  mcp__ccd_session__start_session: 'запускает сессию',
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function describeCall(name: string, input: unknown): Call {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  let what = ''
  if (name === 'Bash') what = str('description') || (str('command').split('\n')[0] ?? '')
  else if (str('file_path')) what = str('file_path').split('/').pop() ?? ''
  else if (name === 'Agent' || name === 'Task') what = str('description')
  else what = str('pattern') || str('skill') || str('url') || str('query') || str('description') || str('title')
  const tool = VERBS[name] ?? (name.startsWith('mcp__') ? name.split('__').slice(2).join(' ') : name)
  return { tool, what: cut(what.trim(), 80) }
}

type Line = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  message?: { model?: string; stop_reason?: string; content?: unknown }
}
type Block = { type?: string; id?: string; tool_use_id?: string; name?: string; input?: unknown }

/** Хвост расшифровки (JSON по строке): модель, последнее действие, закончен ли ход. */
export function parseTail(text: string, isCut: boolean): Tail {
  const lines = text.split('\n')
  if (isCut) lines.shift()
  const answered = new Set<string>()
  const tail: Tail = { lastTs: 0, isTurnEnded: false }
  let isLatestSeen = false
  for (let k = lines.length - 1; k >= 0; k--) {
    let d: Line
    try { d = JSON.parse(lines[k] ?? '') } catch { continue }
    const ts = Date.parse(d.timestamp ?? '') || 0
    if (!tail.lastTs && ts) tail.lastTs = ts
    const content = Array.isArray(d.message?.content) ? (d.message!.content as Block[]) : undefined
    if (d.type === 'user') {
      const isPrompt = !d.isMeta && (typeof d.message?.content === 'string' || content?.some(b => b?.type === 'text'))
      if (isPrompt && !isLatestSeen) isLatestSeen = true // новый запрос после ответа: ход идёт
      for (const b of content ?? []) if (b?.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id)
      continue
    }
    if (d.type !== 'assistant') continue
    if (!isLatestSeen) { isLatestSeen = true; tail.isTurnEnded = d.message?.stop_reason === 'end_turn' }
    const model = d.message?.model
    if (!tail.model && model && model !== '<synthetic>') tail.model = model
    const use = content?.filter(b => b?.type === 'tool_use').pop()
    if (!tail.action && use?.name) {
      tail.action = { ...describeCall(use.name, use.input), ts, isPending: !answered.has(use.id ?? '') }
    }
    if (tail.model && tail.action) break
  }
  return tail
}

/** Начало расшифровки: от какой сессии запущена, когда, первое задание. */
export function parseHead(text: string): { parent?: string; startedAt: number; prompt: string } {
  let parent: string | undefined
  let startedAt = 0
  let prompt = ''
  for (const raw of text.split('\n')) {
    let d: Line & { sessions?: { id?: string; via?: string }[] }
    try { d = JSON.parse(raw) } catch { continue }
    if (d.type === 'derived-from') parent = d.sessions?.find(s => s.via === 'launch')?.id ?? d.sessions?.[0]?.id
    if (!startedAt) startedAt = Date.parse(d.timestamp ?? '') || 0
    if (!prompt && d.type === 'user') {
      const c = d.message?.content
      prompt = typeof c === 'string' ? c : Array.isArray(c) ? ((c as { text?: string }[]).find(b => b.text)?.text ?? '') : ''
    }
  }
  return { parent, startedAt, prompt }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} с`
  if (s < 3600) return `${Math.round(s / 60)} мин`
  return `${Math.round(s / 3600)} ч`
}

export type Background = Map<string, { what: string; ts: number }>

/** Фоновые команды: запуск — вызов Bash с run_in_background, конец — уведомление с номером вызова. Строки целые. */
export function scanBackground(lines: string[], pending: Background): void {
  for (const line of lines) {
    if (line.includes('<tool-use-id>')) {
      for (const m of line.matchAll(/<tool-use-id>(toolu_[A-Za-z0-9]+)<\/tool-use-id>/g)) pending.delete(m[1] ?? '')
    }
    if (!/"run_in_background":\s*true/.test(line) || !line.includes('"name":"Bash"')) continue
    const id = /"id":"(toolu_[A-Za-z0-9]+)"/.exec(line)?.[1]
    const desc = /"description":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
    const ts = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '') || 0
    if (id) pending.set(id, { what: desc ? (JSON.parse(`"${desc}"`) as string) : 'команда', ts })
  }
}

const HANG_MS = 3 * 60 * 1000
const SILENT_MS = 30 * 60 * 1000

/** Состояние сессии или помощника. Ожидание разрешения — только из записи мода той сессии. */
export function stateOf(o: { tail: Tail; now: number; isHelper: boolean; isFinished?: boolean; wait?: Wait; hasWaitFile: boolean; background?: { what: string; ts: number }[] }): State {
  const { tail, now, wait } = o
  const bg = (o.background ?? []).map(b => `${b.what} (${ago(now - b.ts)})`).join(', ')
  if (wait) return { kind: 'waiting', text: `ждёт разрешения: ${wait.tool} ${wait.what} · ${ago(now - wait.since)}` }
  if (o.isFinished || (o.isHelper && tail.isTurnEnded)) return { kind: 'done', text: 'закончил' }
  if (tail.isTurnEnded) return bg ? { kind: 'working', text: `ход закончен, фоном идёт: ${bg}` } : { kind: 'idle', text: 'ход закончен' }
  if (tail.lastTs && now - tail.lastTs > SILENT_MS) return { kind: 'silent', text: `молчит ${ago(now - tail.lastTs)}` }
  const a = tail.action
  if (a?.isPending && now - a.ts > HANG_MS && !o.hasWaitFile) {
    return { kind: 'working', text: `работает · ответа нет ${ago(now - a.ts)}, возможно, ждёт разрешения` }
  }
  return { kind: 'working', text: bg ? `работает · фоном: ${bg}` : 'работает' }
}

/** Дерево семьи: корень — самый верхний предок, потом потомки по времени запуска. */
export function familyOf(me: string, parents: Map<string, string | undefined>, startedAt: Map<string, number>): { id: string; depth: number }[] {
  let root = me
  const seen = new Set([me])
  for (let p = parents.get(root); p && !seen.has(p); p = parents.get(root)) { seen.add(p); root = p }
  const children = new Map<string, string[]>()
  for (const [id, p] of parents) if (p) children.set(p, [...(children.get(p) ?? []), id])
  const out: { id: string; depth: number }[] = []
  const walk = (id: string, depth: number) => {
    if (out.some(x => x.id === id)) return
    out.push({ id, depth })
    const kids = (children.get(id) ?? []).sort((a, b) => (startedAt.get(a) ?? 0) - (startedAt.get(b) ?? 0))
    for (const k of kids) walk(k, depth + 1)
  }
  walk(root, 0)
  return out
}
