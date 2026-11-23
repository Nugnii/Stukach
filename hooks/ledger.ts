// Учёт статистики: дочитывает расшифровки всех проектов с места, где остановился, и хранит итоги по часам
// в ~/.claude/stukach/stats.json — расшифровки живут 90 дней, итоги остаются.
// Ведёт одна сессия (замок с отметкой времени), остальные окна читают готовый файл.

import type { EngineInterface } from 'claude-code'

import { parseOr } from './board'
import { scanLines, utf8Bytes } from './stats'
import type { FileState, Hours } from './stats'

type $ = EngineInterface
type Entry = Awaited<ReturnType<$['fs']['list']>>[number]
/** Место в файле (байты) и состояние разбора. */
type Mark = FileState & { o: number }
export type Ledger = { v: 1; files: Record<string, Mark>; hours: Hours; isComplete: boolean; progress?: number }

const CHUNK = 4 * 1024 * 1024 // предел одного чтения
const LOCK_MS = 30_000
const SAVE_MS = 30_000
const WALK_MS = 10 * 60_000
const HOT_MS = 2 * 3600_000
const BACKLOG_OK = 16 * 1024 * 1024 // столько непрочитанного — уже не «история», а то, что пишется сейчас
const TICK_MS = 600 // ponytail: чтение за тик (тик раз в 5 с) — бережём слабый Mac; первый проход по 13 ГБ — около 10 минут фоном

let ledger: Ledger | null = null
let fileMtime = 0
let lastSave = 0
let lastWalk = 0
let known = new Map<string, number>() // файлы и размеры с последнего полного обхода, освежённые частичными
let isDirty = false
let isBusy = false
let total = 0 // байт к разбору в первом проходе — для «считаю историю: N%»
let left = 0

const fresh = (): Ledger => ({ v: 1, files: {}, hours: {}, isComplete: false })

/** Что видит панель: итоги по часам и доля разобранного, пока первый проход не кончился. */
export function ledgerView(): { hours: Hours; progress?: number } {
  const hours = ledger?.hours ?? {}
  if (ledger?.isComplete) return { hours }
  // окно, которое учёт не ведёт, берёт долю из файла учёта
  return { hours, progress: total > 0 ? Math.max(0, Math.min(0.99, 1 - left / total)) : (ledger?.progress ?? 0) }
}

/** Подхватить файл учёта, если его переписала ведущая сессия: панель любого окна видит свежие итоги. */
export async function ledgerRefresh($: $, home: string): Promise<void> {
  if (!isDirty) await load($, `${home}/.claude/stukach/stats.json`)
}

/** Кусок файла с места m.o: учесть целые строки и сдвинуть место на их байты. Без перевода строки — 0, ждать
 *  (строка ещё пишется), а если кусок полный — пропустить его: строка длиннее 4 МБ (картинка) ответом модели не бывает. */
export function consume(m: Mark, text: string, length: number, hours: Hours): number {
  const cut = text.lastIndexOf('\n')
  if (cut < 0) {
    if (length < CHUNK) return 0
    m.o += length
    return length
  }
  const whole = text.slice(0, cut + 1)
  scanLines(whole.split('\n'), m, hours)
  const step = utf8Bytes(whole)
  m.o += step
  return step
}

/** История разобрана: непрочитанного меньше BACKLOG_OK, не считая файлов, которые сейчас дописываются (stalled). */
export function historyDone(queue: [string, number][], files: Record<string, { o: number }>, stalled: Set<string>): boolean {
  const backlog = queue.reduce((n, [k, size]) => n + (stalled.has(k) ? 0 : Math.max(0, size - (files[k]?.o ?? 0))), 0)
  return backlog < BACKLOG_OK
}

async function load($: $, path: string) {
  const st = await $.fs.stat(path).catch(() => undefined)
  if (!st || (ledger && st.mtimeMs === fileMtime)) return
  const read = parseOr<Ledger | null>(await $.fs.read(path).catch(() => ''), null)
  if (read?.v === 1) { ledger = read; fileMtime = st.mtimeMs }
}

function listOr($: $, path: string) {
  return $.fs.list(path).catch(() => [] as Entry[])
}

async function walkAgents($: $, dir: string, out: Map<string, number>, root: string) {
  for (const x of await listOr($, dir)) {
    const p = `${dir}/${x.name}`
    if (x.kind === 'dir') await walkAgents($, p, out, root)
    else if (x.name.startsWith('agent-') && x.name.endsWith('.jsonl')) out.set(p.slice(root.length + 1), x.size)
  }
}

/** Файлы расшифровок и их размеры: всё дерево раз в 10 минут, между обходами — помощники только недавних сессий. */
async function discover($: $, root: string, now: number, isFull: boolean) {
  const out = new Map<string, number>()
  for (const p of (await listOr($, root)).filter(x => x.kind === 'dir')) {
    const dir = `${root}/${p.name}`
    const entries = await listOr($, dir)
    const hot = new Set<string>()
    for (const x of entries) {
      if (x.kind !== 'file' || !x.name.endsWith('.jsonl')) continue
      out.set(`${p.name}/${x.name}`, x.size)
      if (now - x.mtimeMs < HOT_MS) hot.add(x.name.slice(0, -6))
    }
    for (const x of entries) if (x.kind === 'dir' && (isFull || hot.has(x.name))) await walkAgents($, `${dir}/${x.name}/subagents`, out, root)
  }
  return out
}

/** Один тик учёта: замок, обход, чтение в пределах TICK_MS, сохранение. Возвращает, изменились ли итоги. */
export async function ledgerTick($: $, home: string, me: string): Promise<boolean> {
  if (isBusy) return false
  isBusy = true
  try {
    const dir = `${home}/.claude/stukach`
    const file = `${dir}/stats.json`
    const lockFile = `${dir}/stats.lock`
    const now = await $.clock.now()
    const lock = parseOr<{ owner?: string; at?: number }>(await $.fs.read(lockFile).catch(() => ''), {})
    if (lock.owner && lock.owner !== me && now - (lock.at ?? 0) < LOCK_MS) {
      const before = fileMtime
      await load($, file)
      return fileMtime !== before
    }
    await $.fs.write(lockFile, JSON.stringify({ owner: me, at: now }))
    if (!ledger) await load($, file)
    const l = (ledger ??= fresh())

    const root = `${home}/.claude/projects`
    const isFull = now - lastWalk > WALK_MS
    // Частичный обход видит помощников только недавних сессий: остальное берётся из полного, иначе файлы,
    // не дочитанные за тик полного обхода, выпали бы из очереди (живой прогон 23.11: 446 файлов из 4822).
    const found = await discover($, root, now, isFull)
    const sizes = isFull ? found : new Map([...known, ...found])
    known = sizes
    if (isFull) {
      lastWalk = now
      for (const k of Object.keys(l.files)) if (!sizes.has(k)) { delete l.files[k]; isDirty = true } // файл удалён через 90 дней — итоги остаются
    }
    const queue = [...sizes].filter(([k, size]) => size > (l.files[k]?.o ?? 0))
    left = queue.reduce((n, [k, size]) => n + size - (l.files[k]?.o ?? 0), 0)
    if (!l.isComplete && total === 0) total = left

    const stalled = new Set<string>() // хвост без перевода строки: файл сейчас дописывается
    for (const [k, size] of queue) {
      if ((await $.clock.now()) - now > TICK_MS) break
      const m = (l.files[k] ??= { o: 0, lastTs: 0, isOpen: false, recent: [] })
      if (size < m.o) { m.o = size; continue } // ponytail: укороченный файл не перечитывается, иначе итоги задвоятся
      while (m.o < size && (await $.clock.now()) - now <= TICK_MS) {
        const length = Math.min(CHUNK, size - m.o)
        const step = consume(m, await $.fs.read(`${root}/${k}`, { offset: m.o, length }).catch(() => ''), length, l.hours)
        if (step === 0) { stalled.add(k); break }
        left -= step
        isDirty = true
      }
    }
    // История разобрана, когда непрочитанного почти нет: дописываемые сейчас расшифровки — не история. Прежнее условие
    // («остаток меньше куска») считало разобранным любой непрочитанный файл меньше 4 МБ — живое окно 23.11 показало
    // «учёт готов» на 483 файлах из 4823. Флаг пересчитывается каждый тик: ошибочная отметка в файле снимется сама.
    const isDone = historyDone(queue, l.files, stalled)
    const isFlipped = l.isComplete !== isDone
    if (isFlipped) {
      l.isComplete = isDone
      if (!isDone && total === 0) total = left
      isDirty = true
    }
    // Файл пишется не чаще раза в SAVE_MS: другие окна видят итоги с отставанием до 30 с, ведущее — сразу (из памяти).
    // Смена «считаю историю ↔ готово» пишется немедленно. Прежнее условие («готово» — пиши) переписывало ~1 МБ каждые 5 с.
    if (isDirty && (isFlipped || now - lastSave > SAVE_MS)) {
      l.progress = l.isComplete ? undefined : ledgerView().progress
      // последние ответы нужны только дописываемому файлу; у затихшего их не хранить — файл учёта в 2,5 раза меньше
      // ponytail: 4823 расшифровки — ~0,9 МБ при пределе записи 4 МБ; вырастет — хранить пути короче (номер проекта)
      for (const m of Object.values(l.files)) if (m.recent.length > 0 && now - m.lastTs > 24 * 3600_000) m.recent = []
      await $.fs.write(file, JSON.stringify(l))
      fileMtime = (await $.fs.stat(file).catch(() => undefined))?.mtimeMs ?? fileMtime
      lastSave = now
      isDirty = false
      return true
    }
    return false
  } finally {
    isBusy = false
  }
}
