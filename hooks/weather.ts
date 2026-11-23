// Погода контекста: перенесена из мода context-weather 0.2.0 (Nugnii/mod-weather), поведение то же.
// Без обращений к $, поэтому тест проверяет это напрямую.

import type { Armed, CacheMark } from '../types'
import { WRITE_SHARE, rates } from './stats'

export type { Armed, CacheMark }

export const BAR = 12
export const CONFIRM_MS = 2 * 60_000
const TTL_MS = { '5m': 300_000, '1h': 3_600_000 } as const
// Окна лимитов: известные первыми под короткими именами, остальные — под своими.
export const LIMIT_LABEL: Record<string, string> = { five_hour: '5ч', seven_day: 'неделя' }
export const rank = (kind: string) => {
  const i = Object.keys(LIMIT_LABEL).indexOf(kind)
  return i < 0 ? 99 : i
}

export type Weather = { name: string; icon: string; color: 'error' | 'warning' | 'text' | 'suggestion' | 'success' }

// ponytail: шкала постоянная; уровень наступает рано или поздно — сдвинуть пороги здесь.
export function weather(percent: number): Weather {
  if (percent >= 85) return { name: 'Пора сжимать', icon: '⚠', color: 'error' }
  if (percent >= 70) return { name: 'Гроза', icon: '⚡', color: 'error' }
  if (percent >= 55) return { name: 'Дождь', icon: '☂', color: 'warning' }
  if (percent >= 40) return { name: 'Облачно', icon: '☁', color: 'text' }
  if (percent >= 20) return { name: 'Малооблачно', icon: '⛅', color: 'suggestion' }
  return { name: 'Ясно', icon: '☀', color: 'success' }
}

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

export const cacheLeftMs = (mark: CacheMark, now: number) => mark.at + TTL_MS[mark.ttl] - now

/** send — кеш тёплый или ещё не записан; hold — остыл, сначала предупредить; confirm — предупреждали меньше 2 минут назад. */
export function decide(mark: CacheMark | null, armed: Armed | null, now: number): 'send' | 'hold' | 'confirm' {
  if (mark === null || cacheLeftMs(mark, now) > 0) return 'send'
  if (armed !== null && now - armed.at < CONFIRM_MS) return 'confirm'
  return 'hold'
}

/** Во что обойдётся отправка сейчас: весь диалог заново пишется в кеш (остыл) — против чтения из тёплого кеша. */
export function rereadUsd(model: string, count: number, ttl: '5m' | '1h') {
  const r = rates(model, count)
  if (r === undefined) return undefined
  const perToken = r.input / 1_000_000
  return { cold: count * perToken * WRITE_SHARE[ttl], warm: count * perToken * r.readShare }
}

/** Включён ли отдельный мод погоды context-weather (из любого маркетплейса): тогда Enter придерживает он,
 *  а Stukach уступает — иначе на остывшем кеше Enter пришлось бы нажать трижды, оба мода держат по очереди. */
export function weatherModEnabled(enabledPlugins: unknown): boolean {
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null) return false
  return Object.entries(enabledPlugins).some(([id, isOn]) => isOn === true && id.startsWith('context-weather@'))
}

export const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`

export const coldText = (minutes: number, count: number, cost?: { cold: number; warm: number }) =>
  `Кеш, скорее всего, остыл: с последнего ответа прошло ${minutes} мин. ` +
  `Это сообщение заново прочитает весь диалог, около ${tokens(count)} токенов` +
  (cost === undefined
    ? ''
    : ` — это ≈ ${usd(cost.cold)} по ценам API (с тёплым кешем было бы ${usd(cost.warm)})`) +
  '. Нажмите Enter ещё раз, чтобы отправить.'
