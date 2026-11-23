import { expect, test } from 'claude-code/testing'

import { columnsSvg, columnsText } from './charts'
import { dateShort, limitWeeks, money, payMonths, priceUsd, scanLines, sumHours, workTime } from './stats'
import type { Hours } from './stats'
import { coldText, decide, rereadUsd, tokens, weather, weatherModEnabled } from './weather'

const j = (o: object) => JSON.stringify(o)
const micro = (n: number | undefined) => (n === undefined ? n : Math.round(n * 1_000_000)) // в наборе тестов нет toBeCloseTo
const T0 = Date.parse('2026-11-23T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const prompt = (s: number) => j({ type: 'user', timestamp: at(s), message: { content: 'сделай' } })
const result = (s: number) => j({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: 'ok' }] } })
const answer = (s: number, id: string, o: { tool?: string; end?: boolean; usage?: object; model?: string }) =>
  j({
    type: 'assistant', timestamp: at(s),
    message: {
      id, model: o.model ?? 'claude-opus-5-5', stop_reason: o.end ? 'end_turn' : 'tool_use', usage: o.usage ?? { input_tokens: 0, output_tokens: 0 },
      content: o.tool ? [{ type: 'tool_use', id: 'u', name: o.tool, input: {} }] : [{ type: 'text', text: 'готово' }],
    },
  })

test('цена ответа: живой ответ Opus 5.5 с записью в часовой кеш', async () => {
  // строка из этой сессии 23.11: 73 579 токенов записаны в кеш на час (×2 входа), 43 088 прочитаны (×0,05)
  const live = { input_tokens: 2, cache_creation_input_tokens: 73579, cache_read_input_tokens: 43088, output_tokens: 598, cache_creation: { ephemeral_1h_input_tokens: 73579, ephemeral_5m_input_tokens: 0 } }
  expect(Math.round(priceUsd('claude-opus-5-5', live)! * 10_000)).toBe(6092)
  // без разбивки записи по срокам — пятиминутная (×1,25)
  expect(micro(priceUsd('claude-sonnet-5-5', { input_tokens: 1000, cache_creation_input_tokens: 1000, output_tokens: 100 }))).toBe(micro(0.0055))
  // Haiku 5.5 дороже на запросе длиннее 100K
  expect(micro(priceUsd('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1000 }))).toBe(micro(0.0055))
  expect(micro(priceUsd('claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 1000 }))).toBe(micro(0.0775))
  // быстрый режим вдвое; opus-5 не глотает opus-5-5; окно [1m] в имени не мешает; чужая модель — без цены
  expect(priceUsd('claude-opus-5-5', { input_tokens: 1_000_000, speed: 'fast' })).toBe(8)
  expect(priceUsd('claude-opus-5', { input_tokens: 1_000_000 })).toBe(5)
  expect(priceUsd('claude-opus-5-5[1m]', { input_tokens: 1_000_000 })).toBe(4)
  expect(priceUsd('gpt-5', { input_tokens: 1 })).toBeUndefined()
})

test('разбор: ответ из нескольких строк считается раз; работа — паузы внутри хода, без ожидания человека и помощника', async () => {
  const h: Hours = {}
  scanLines([
    prompt(0),
    answer(30, 'A', { tool: 'Bash', usage: { input_tokens: 1_000_000 } }), // $4
    answer(31, 'A', { tool: 'Bash', usage: { input_tokens: 1_000_000 } }), // та же строка ответа — не второй раз
    result(90),
    answer(100, 'B', { end: true, usage: { output_tokens: 1000 } }), // $0,02
    prompt(3600), // час ожидания человека — не работа
    answer(3610, 'C', { tool: 'Agent' }),
    result(3610 + 1200), // 20 минут работал помощник — время в его файле, не здесь
    answer(3610 + 1210, 'D', { end: true }),
  ], { lastTs: 0, isOpen: false, recent: [] }, h)
  const t = sumHours(h, 0, Infinity)
  expect(micro(t.usd)).toBe(micro(4.02))
  expect(t.ms).toBe(120_000) // 100 с первого хода + 10 с до вызова помощника + 10 с после
  expect(t.unpriced).toBe(0)

  // пауза внутри хода длиннее 15 минут — зависшее разрешение, а не работа: засчитано 15 минут
  const long: Hours = {}
  scanLines([prompt(0), answer(40 * 60, 'E', { tool: 'Bash' })], { lastTs: 0, isOpen: false, recent: [] }, long)
  expect(sumHours(long, 0, Infinity).ms).toBe(15 * 60_000)

  // модель без цены — в счётчике, а не нулём в деньгах
  const odd: Hours = {}
  scanLines([prompt(0), answer(5, 'F', { end: true, model: 'some-model', usage: { output_tokens: 5 } })], { lastTs: 0, isOpen: false, recent: [] }, odd)
  expect(sumHours(odd, 0, Infinity).unpriced).toBe(1)
})

test('периоды: месяц подписки с дня оплаты, неделя лимита до сброса', async () => {
  const now = new Date(2026, 10, 23, 12).getTime()
  expect(payMonths(3, now, 2)).toEqual([
    { from: new Date(2026, 9, 3).getTime(), to: new Date(2026, 10, 3).getTime() },
    { from: new Date(2026, 10, 3).getTime(), to: new Date(2026, 11, 3).getTime() },
  ])
  // до дня оплаты — ещё прошлый месяц подписки
  expect(payMonths(3, new Date(2026, 10, 2, 23).getTime(), 1)[0]?.from).toBe(new Date(2026, 9, 3).getTime())
  // день оплаты 31-е: в феврале — его последний день
  expect(payMonths(31, new Date(2026, 1, 15).getTime(), 1)).toEqual([{ from: new Date(2026, 0, 31).getTime(), to: new Date(2026, 1, 28).getTime() }])
  const resets = Date.parse('2026-11-27T14:00:00.000Z')
  const week = 7 * 24 * 3600_000
  expect(limitWeeks(resets, now, 2)).toEqual([{ from: resets - 2 * week, to: resets - week }, { from: resets - week, to: resets }])
  expect(dateShort(new Date(2026, 10, 3).getTime())).toBe('3 ноя')
  expect(dateShort(new Date(2026, 10, 20, 15).getTime(), true)).toBe('20 ноя 15:00')
})

test('числа: деньги с пробелами между тысячами, часы и минуты', async () => {
  expect(money(7.78)).toBe('$7.78')
  expect(money(5404.4)).toBe('$5 404')
  expect(money(34925)).toBe('$34 925')
  expect(workTime(23 * 60_000)).toBe('23 мин')
  expect(workTime(342.3 * 3600_000)).toBe('342 ч')
  expect(workTime(1047.5 * 3600_000)).toBe('1 048 ч')
})

test('погода: цена отправки в остывший кеш — та же, что в моде context-weather', async () => {
  const cost = rereadUsd('claude-opus-5-5[1m]', 430_000, '1h')
  expect(Math.round(cost!.cold * 1000)).toBe(3440)
  expect(Math.round(cost!.warm * 1000)).toBe(86)
  expect(coldText(61, 430_000, cost)).toBe(
    'Кеш, скорее всего, остыл: с последнего ответа прошло 61 мин. Это сообщение заново прочитает ' +
      'весь диалог, около 430k токенов — это ≈ $3.44 по ценам API (с тёплым кешем было бы $0.086). ' +
      'Нажмите Enter ещё раз, чтобы отправить.',
  )
  expect(Math.round(rereadUsd('claude-opus-5', 100_000, '5m')!.cold * 1000)).toBe(625)
  expect(rereadUsd('some-other-model', 100_000, '5m')).toBeUndefined()
  expect(weather(30).name).toBe('Малооблачно')
  expect(weather(91).name).toBe('Пора сжимать')
  expect(tokens(124_000)).toBe('124k')
  const mark = { at: 0, ttl: '5m' } as const
  expect(decide(mark, null, 299_000)).toBe('send')
  expect(decide(mark, null, 301_000)).toBe('hold')
  expect(decide(mark, { at: 301_000, minutes: 5, tokens: 1 }, 400_000)).toBe('confirm')
})

test('погода: при включённом context-weather Enter придерживает он, Stukach уступает', async () => {
  // живая настройка владельца 23.11: "context-weather@mod-weather": true
  expect(weatherModEnabled({ 'context-weather@mod-weather': true, 'stukach@local-mods': true })).toBe(true)
  expect(weatherModEnabled({ 'context-weather@other-market': true })).toBe(true)
  expect(weatherModEnabled({ 'context-weather@mod-weather': false })).toBe(false)
  expect(weatherModEnabled({ 'stukach@local-mods': true })).toBe(false)
  expect(weatherModEnabled(undefined)).toBe(false)
})

test('графики: подписаны самый большой и текущий столбцы, у каждого подсказка; на терминале — полосы', async () => {
  const cols = [
    { label: '3 окт', value: 10583, tip: '3 окт: $10 583 по ценам API' },
    { label: '3 ноя', value: 5404, tip: '3 ноя: $5 404 по ценам API', isCurrent: true },
  ]
  const svg = columnsSvg('Стоимость по ценам API', cols, money)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.match(/<path /g)?.length).toBe(2)
  expect(svg).toContain('>$10 583<')
  expect(svg).toContain('>$5 404 · идёт<')
  expect(svg).toContain('<title>3 окт: $10 583 по ценам API</title>')
  expect(svg).toContain('prefers-color-scheme: dark')
  const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1} ноя`, value: i * 100, tip: `неделя ${i}` }))
  expect(columnsSvg('Работа агентов', twelve, String).length).toBeLessThan(131072)
  expect(columnsText(cols, money, 10)).toEqual(['3 окт ██████████ $10 583', '3 ноя █████░░░░░ $5 404 · идёт'])
})
