import { expect, test } from 'claude-code/testing'

import { familyOf, parseHead, parseTail, roleOf, scanBackground, shortModel, stateOf } from './board'
import type { Background } from './board'

const line = (o: object) => JSON.stringify(o)
const T0 = Date.parse('2026-11-22T20:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const bash = (id: string, s: number, stop = 'tool_use') => line({
  type: 'assistant', timestamp: at(s),
  message: { model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'Прогон набора тестов' } }] },
})
const result = (id: string, s: number) => line({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
const said = (s: number) => line({ type: 'assistant', timestamp: at(s), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'готово' }] } })
const prompt = (s: number) => line({ type: 'user', timestamp: at(s), message: { content: 'дальше' } })

test('роль: по описанию, затем по типу, затем по заданию', () => {
  expect(roleOf('Final opus skeptic for task 12', 'lean', '').name).toBe('скептик')
  expect(roleOf('Найди вызовы parse_config', 'lean', '').name).toBe('поиск')
  expect(roleOf('Почини тест входа', 'lean', '').name).toBe('исполнитель')
  expect(roleOf('Verify fix for issue 7', 'lean', '').name).toBe('проверка')
  expect(roleOf('Прогон набора тестов', 'lean', '').name).toBe('проверка')
  expect(roleOf('', 'Explore', '').name).toBe('поиск')
  expect(roleOf('Задача 3', 'lean', 'Ты — скептик. Докажи, что починка ломается').name).toBe('скептик')
  expect(roleOf('Задача 3', 'lean', 'Привет').name).toBe('роль не ясна')
  expect(shortModel('claude-haiku-5-5')).toBe('haiku')
})

test('хвост: висящая команда, ответ, конец хода, новый запрос', () => {
  const cutPart = '"partial":true}'
  const pending = parseTail([cutPart, bash('u1', 0)].join('\n'), true)
  expect(pending.model).toBe('claude-opus-5-5')
  expect(pending.action).toMatchObject({ tool: 'команда', what: 'Прогон набора тестов', isPending: true })
  expect(pending.isTurnEnded).toBe(false)

  const answered = parseTail([bash('u1', 0), result('u1', 5)].join('\n'), false)
  expect(answered.action?.isPending).toBe(false)
  expect(answered.lastTs).toBe(T0 + 5000)

  const ended = parseTail([bash('u1', 0), result('u1', 5), said(6)].join('\n'), false)
  expect(ended.isTurnEnded).toBe(true)
  expect(ended.action?.what).toBe('Прогон набора тестов')

  expect(parseTail([said(6), prompt(9)].join('\n'), false).isTurnEnded).toBe(false)
})

test('состояние: ожидание разрешения сильнее всего, догадка — только без записи мода', () => {
  const tail = parseTail(bash('u1', 0), false)
  const now = T0 + 5 * 60 * 1000
  const wait = { tool: 'команда', what: 'git push', since: T0 }
  expect(stateOf({ tail, now, isHelper: true, isFinished: true, wait, hasWaitFile: true }).kind).toBe('waiting')
  expect(stateOf({ tail, now, isHelper: true, isFinished: true, hasWaitFile: true }).kind).toBe('done')
  expect(stateOf({ tail, now, isHelper: true, hasWaitFile: false }).text).toContain('возможно, ждёт разрешения')
  expect(stateOf({ tail, now, isHelper: true, hasWaitFile: true }).text).toBe('работает')
  expect(stateOf({ tail: parseTail(said(0), false), now, isHelper: false, hasWaitFile: true }).kind).toBe('idle')
})

test('фон: ход закончен, а фоновая команда без уведомления о конце — сессия работает', () => {
  const launch = (id: string, what: string, s: number) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'run', description: what, run_in_background: true } }] } })
  const done = (id: string) => line({ type: 'attachment', attachment: { prompt: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>` } })
  const pending: Background = new Map()
  scanBackground([launch('toolu_A1', 'Прогон набора', 0), launch('toolu_B2', 'Повтор подсказки', 10), done('toolu_A1'), said(20)], pending)
  expect([...pending.values()].map(b => b.what)).toEqual(['Повтор подсказки'])
  const now = T0 + 5 * 60 * 1000
  const state = stateOf({ tail: parseTail(said(20), false), now, isHelper: false, hasWaitFile: true, background: [...pending.values()] })
  expect(state).toEqual({ kind: 'working', text: 'ход закончен, фоном идёт: Повтор подсказки (5 мин)' })
})

test('фон: копия запроса к модели и отклонённый запуск — не фоновые команды', () => {
  // Форма живой расшифровки 4b7053d6: запуск, отказ стража, затем api-request-blob без времени с копией вызова.
  const call = { type: 'tool_use', id: 'toolu_R1', name: 'Bash', input: { command: 'run', description: 'Прогон после правки', run_in_background: true } }
  const launch = line({ type: 'assistant', timestamp: at(0), message: { content: [call] } })
  const refused = line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', content: 'PreToolUse:Bash hook error: ОТКАЗ', is_error: true, tool_use_id: 'toolu_R1' }] } })
  const edit = { type: 'tool_use', id: 'toolu_E2', name: 'Edit', input: { file_path: '/r/a.md' } }
  const blob = line({ type: 'api-request-blob', hash: 'h', message: { content: [edit, call] } })
  const pending: Background = new Map()
  scanBackground([launch, refused, blob], pending)
  expect([...pending.keys()]).toEqual([])
})

test('фон: команда, остановленная TaskStop, больше не идёт', () => {
  // Форма живой расшифровки 8c2dee72: после TaskStop уведомления о конце нет.
  const launch = line({ type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'toolu_S1', name: 'Bash', input: { command: 'npm start', description: 'Сервер сайта', run_in_background: true } }] } })
  const started = line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_S1', content: 'Command running in background with ID: b4rd7is4b. Output is being written to: /tmp/x' }] } })
  const stop = line({ type: 'assistant', timestamp: at(60), message: { content: [{ type: 'tool_use', id: 'toolu_K2', name: 'TaskStop', input: { task_id: 'b4rd7is4b' } }] } })
  const stopped = line({ type: 'user', timestamp: at(61), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_K2', content: 'Successfully stopped task b4rd7is4b' }] } })
  const pending: Background = new Map()
  const memo = { ended: new Set<string>(), stops: new Map<string, string>() } // память между кусками файла
  scanBackground([launch, started], pending, memo)
  expect([...pending.keys()]).toEqual(['toolu_S1'])
  scanBackground([stop], pending, memo)
  expect([...pending.keys()]).toEqual(['toolu_S1']) // вызов ещё не принят
  scanBackground([stopped], pending, memo)
  expect([...pending.keys()]).toEqual([])
  // TaskStop без номера задачи не снимает запуск, чей номер ещё не прочитан
  const fresh = line({ type: 'assistant', timestamp: at(70), message: { content: [{ type: 'tool_use', id: 'toolu_F3', name: 'Bash', input: { command: 'run', description: 'Новый', run_in_background: true } }] } })
  const blankStop = line({ type: 'assistant', timestamp: at(71), message: { content: [{ type: 'tool_use', id: 'toolu_K4', name: 'TaskStop', input: {} }] } })
  const blankDone = line({ type: 'user', timestamp: at(72), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_K4', content: 'ok' }] } })
  scanBackground([fresh, blankStop, blankDone], pending, memo)
  expect([...pending.keys()]).toEqual(['toolu_F3'])
})

// Атаки финального скептика (А4, А7): формы живых расшифровок.
const skLaunch = line({ type: 'assistant', uuid: '0f03', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'toolu_D1', name: 'Bash', input: { command: 'run', description: 'Контрольный полный набор', run_in_background: true } }] } })
const skStarted = line({ type: 'user', uuid: '3ac7', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_D1', content: 'Command running in background with ID: beznlnf3m. Output is being written to: /tmp/x' }] } })
const skNotif = line({ type: 'user', timestamp: at(60), message: { content: '<task-notification>\n<task-id>beznlnf3m</task-id>\n<tool-use-id>toolu_D1</tool-use-id>\n<status>completed</status>\n</task-notification>' } })

test('фон (А4): запись запуска, переписанная после уведомления о конце, команду не воскрешает', () => {
  // Форма живой расшифровки 983c43c4 (строки 1621/1673/3105): после уведомления история переписана в файл заново.
  const pending: Background = new Map()
  scanBackground([skLaunch, skStarted, skNotif, skLaunch, skStarted], pending)
  expect([...pending.keys()]).toEqual([])
})

test('фон (А7): TaskStop, отклонённый стражем, команду не снимает', () => {
  const stop = line({ type: 'assistant', timestamp: at(30), message: { content: [{ type: 'tool_use', id: 'toolu_K', name: 'TaskStop', input: { task_id: 'beznlnf3m' } }] } })
  const refused = line({ type: 'user', timestamp: at(31), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_K', is_error: true, content: 'PreToolUse:TaskStop hook error: ⛔ ОТКАЗ' }] } })
  const pending: Background = new Map()
  scanBackground([skLaunch, skStarted, stop, refused], pending)
  expect([...pending.keys()]).toEqual(['toolu_D1'])
})

test('фон: незнакомое время запуска показано как незнакомое, а не 57 лет', () => {
  const now = T0 + 5 * 60 * 1000
  const state = stateOf({ tail: parseTail(said(20), false), now, isHelper: false, hasWaitFile: true, background: [{ what: 'Прогон', ts: 0 }] })
  expect(state.text).toBe('ход закончен, фоном идёт: Прогон (время запуска неизвестно)')
})

test('семья: корень — верхний предок, дети по времени запуска', () => {
  const head = parseHead([line({ type: 'derived-from', sessions: [{ id: 'root', via: 'launch' }] }), line({ type: 'queue-operation', timestamp: at(1) })].join('\n'))
  expect(head).toMatchObject({ parent: 'root', startedAt: T0 + 1000 })

  const parents = new Map<string, string | undefined>([['root', undefined], ['late', 'root'], ['early', 'root'], ['grand', 'late'], ['stranger', undefined]])
  const started = new Map([['late', 20], ['early', 10], ['grand', 30]])
  expect(familyOf('grand', parents, started)).toEqual([
    { id: 'root', depth: 0 }, { id: 'early', depth: 1 }, { id: 'late', depth: 1 }, { id: 'grand', depth: 2 },
  ])
})
