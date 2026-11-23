// Статистика: сколько стоила бы работа по ценам Claude API и сколько часов работали сессии и помощники.
// Без обращений к $, поэтому тест проверяет это напрямую.

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

// ponytail: прейскурант Claude API (справочник от 3 ноября 2026), $ за 1M токенов: вход, выход, чтение кеша долей входа.
// Модель не из списка цены не получает и считается отдельно; обновляется вместе с модом.
type Row = [id: string, input: number, output: number, readShare: number]
const ROWS: Row[] = [
  ['claude-fable-5-2', 8, 40, 0.025], ['claude-mythos-5-2', 8, 40, 0.025],
  ['claude-fable-5-1', 10, 50, 0.025], ['claude-mythos-5-1', 10, 50, 0.025],
  ['claude-fable-5', 10, 50, 0.1], ['claude-mythos-5', 10, 50, 0.1],
  ['claude-opus-5-5', 4, 20, 0.05], ['claude-opus-5', 5, 25, 0.1],
  ['claude-opus-4-8', 5, 25, 0.1], ['claude-opus-4-7', 5, 25, 0.1], ['claude-opus-4-6', 5, 25, 0.1],
  ['claude-sonnet-5-5', 2, 10, 0.05], ['claude-sonnet-5', 2, 10, 0.1], ['claude-sonnet-4-6', 3, 15, 0.1],
  ['claude-haiku-5-5', 0.1, 0.5, 0.1], ['claude-haiku-4-5', 1, 5, 0.1],
]
const PRICES = [...ROWS].sort((a, b) => b[0].length - a[0].length) // самый длинный префикс первым: opus-5-5 не читается как opus-5

/** Цены модели, $ за 1M: вход, выход, чтение кеша долей входа; Haiku 5.5 дороже на запросе длиннее 100K. */
export function rates(model: string, promptTokens = 0): { input: number; output: number; readShare: number } | undefined {
  const row = PRICES.find(([id]) => model.startsWith(id))
  if (!row) return undefined
  const [id, input, output, readShare] = row
  return id === 'claude-haiku-5-5' && promptTokens > 100_000 ? { input: 0.5, output: 2.5, readShare } : { input, output, readShare }
}

/** Доля цены входа за запись в кеш по сроку жизни записи. */
export const WRITE_SHARE = { '5m': 1.25, '1h': 2 } as const

/** Цена одного ответа модели по токенам из расшифровки; undefined — модель без цены. */
export function priceUsd(model: string, u: Usage): number | undefined {
  const read = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : written
  const plain = u.input_tokens ?? 0
  const r = rates(model, plain + read + written)
  if (!r) return undefined
  const fast = u.speed === 'fast' ? 2 : 1 // быстрый режим — вдвое по всем строкам
  const inputUnits = plain + w5m * WRITE_SHARE['5m'] + w1h * WRITE_SHARE['1h'] + read * r.readShare
  return (fast * (r.input * inputUnits + r.output * (u.output_tokens ?? 0))) / 1_000_000
}

const HOUR = 3_600_000
// ponytail: пауза внутри хода (команда, ожидание ответа модели) считается работой до 15 минут; дольше — простой
// (зависшее разрешение, прерванный ход). Пауза после конца хода — ожидание человека, не работа.
const GAP_CAP = 15 * 60_000

/** Накопленное по часам: номер часа (мс / 3600000) → [$ по ценам API, мс работы, ответов без цены]. */
export type Hours = Record<string, [number, number, number]>
/** Состояние разбора одного файла между кусками: время прошлой записи, идёт ли ход, ждёт ли сессия
 *  помощника или человека (это не её работа), последние учтённые ответы. */
export type FileState = { lastTs: number; isOpen: boolean; isWaiting?: boolean; recent: string[] }

// Пока сессия ждёт помощника, работает помощник, и его время уже в его файле; вопрос ждёт человека.
const WAITS = new Set(['Agent', 'Task', 'AskUserQuestion'])
// ponytail: один ответ модели пишется подряд несколькими строками с одним id — хватает помнить последние;
// между файлами id повторяются редко (замер 23.11: 196 из 288 тыс., одна копия сессии) — не сверяются
const RECENT = 8

type Line = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  message?: { id?: string; model?: string; stop_reason?: string; usage?: Usage; content?: unknown }
}

const add = (h: Hours, ts: number, usd: number, ms: number, unpriced: number) => {
  const k = String(Math.floor(ts / HOUR))
  const v = (h[k] ??= [0, 0, 0])
  v[0] += usd; v[1] += ms; v[2] += unpriced
}

/** Целые строки расшифровки: деньги — по ответам модели (один ответ — несколько строк с одним id, берётся первая),
 *  часы — по паузам внутри хода, кроме ожидания помощника или человека. */
export function scanLines(lines: string[], f: FileState, hours: Hours): void {
  for (const line of lines) {
    if (!line.includes('"timestamp"')) continue
    let d: Line
    try { d = JSON.parse(line) } catch { continue }
    const ts = Date.parse(d.timestamp ?? '') || 0
    if (!ts || (d.type !== 'user' && d.type !== 'assistant')) continue
    if (f.isOpen && !f.isWaiting && f.lastTs && ts > f.lastTs) add(hours, ts, 0, Math.min(ts - f.lastTs, GAP_CAP), 0)
    if (ts > f.lastTs) f.lastTs = ts
    const m = d.message
    if (d.type === 'assistant') {
      f.isOpen = m?.stop_reason !== 'end_turn'
      const uses = Array.isArray(m?.content) ? (m!.content as { type?: string; name?: string }[]).filter(b => b?.type === 'tool_use') : []
      if (uses.length > 0) f.isWaiting = uses.some(b => WAITS.has(b.name ?? ''))
      const id = m?.id
      if (!id || f.recent.includes(id) || !m?.usage || !m.model || m.model === '<synthetic>') continue
      f.recent.push(id)
      if (f.recent.length > RECENT) f.recent.shift()
      const usd = priceUsd(m.model, m.usage)
      add(hours, ts, usd ?? 0, 0, usd === undefined ? 1 : 0)
    } else if (!d.isMeta) {
      f.isOpen = true // запрос человека или ответ инструмента (помощник вернулся): ход идёт, ожидание кончилось
      f.isWaiting = false
    }
  }
}

/** Длина строки в байтах UTF-8: смещение в файле считается в байтах, а строка — в символах. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}

export type Total = { usd: number; ms: number; unpriced: number }

/** Сумма часов в промежутке [from, to). */
export function sumHours(h: Hours, from: number, to: number): Total {
  const t: Total = { usd: 0, ms: 0, unpriced: 0 }
  for (const [k, [usd, ms, unpriced]] of Object.entries(h)) {
    const at = Number(k) * HOUR
    if (at >= from && at < to) { t.usd += usd; t.ms += ms; t.unpriced += unpriced }
  }
  return t
}

export type Period = { from: number; to: number }
const WEEK = 7 * 24 * HOUR

/** Недели лимита, старые первыми: последняя кончается сбросом недельного окна; без него — следующим часом. */
export function limitWeeks(resetsAt: number | undefined, now: number, count: number): Period[] {
  const end = resetsAt ?? Math.ceil(now / HOUR) * HOUR
  return Array.from({ length: count }, (_, k) => ({ from: end - WEEK * (count - k), to: end - WEEK * (count - k - 1) }))
}

/** Месяцы подписки с дня оплаты, старые первыми: последний — тот, в котором сейчас. День за концом месяца — его последний. */
export function payMonths(day: number, now: number, count: number): Period[] {
  const at = (y: number, m: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate())).getTime()
  const d = new Date(now)
  const y = d.getFullYear()
  const m = at(y, d.getMonth()) > now ? d.getMonth() - 1 : d.getMonth()
  return Array.from({ length: count }, (_, k) => ({ from: at(y, m - count + 1 + k), to: at(y, m - count + 2 + k) }))
}

const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
/** «3 ноя»; с временем — «20 ноя 15:00». */
export function dateShort(ms: number, withTime = false): string {
  const d = new Date(ms)
  const t = withTime ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
  return `${d.getDate()} ${MON[d.getMonth()]}${t}`
}

const groups = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
/** «$5 404», до сотни — с центами: «$7.78». */
export const money = (usd: number) => (usd < 100 ? `$${usd.toFixed(2)}` : `$${groups(usd)}`)
/** «342 ч», меньше часа — «23 мин». */
export const workTime = (ms: number) => (ms < HOUR ? `${Math.round(ms / 60_000)} мин` : `${groups(ms / HOUR)} ч`)
