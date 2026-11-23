import { expect, test } from 'claude-code/testing'

// Живая форма 23.11.2026: оркестратор 4b7053d6 в папке проекта ClaudSoul, запущенная им сессия d356198f — в папке
// проекта мода, её соседка — в третьей. Панель, открытая из дочерней, видела только себя.
const NOW = Date.parse('2026-11-23T12:30:00.000Z')
const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString()
const j = (o: object) => JSON.stringify(o)
const use = (name: string, input: object, s: number, model = 'claude-opus-5-5') =>
  j({ type: 'assistant', timestamp: at(s), message: { model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `u${s}`, name, input }] } })
const launched = (by: string) => j({ type: 'derived-from', sessions: [{ id: by, via: 'launch' }] })

const R = '/h/.claude/projects'
const FILES = new Map<string, string>([
  [`${R}/soul/orch.jsonl`, use('Bash', { description: 'Сверка' }, 1)],
  [`${R}/soul/orch/custom-title.json`, j({ customTitle: 'Оркестратор' })],
  [`${R}/mod/kid.jsonl`, [launched('orch'), use('Edit', { file_path: '/m/register.tsx' }, 2)].join('\n')],
  [`${R}/mod/kid/subagents/agent-a1.meta.json`, j({ agentType: 'lean', description: 'Найди вызовы' })],
  [`${R}/mod/kid/subagents/agent-a1.jsonl`, use('Grep', { pattern: 'collect' }, 3, 'claude-haiku-5-5')],
  [`${R}/rel/sib.jsonl`, [launched('orch'), use('Read', { file_path: '/r/CHANGELOG.md' }, 4)].join('\n')],
  [`${R}/rel/sib/custom-title.json`, j({ customTitle: 'Релиз' })],
  // чужая сессия в том же проекте, что соседка: в семью не входит, но жива — стоит под «Параллельно»
  [`${R}/rel/other.jsonl`, use('Read', { file_path: '/r/x.md' }, 5)],
  [`${R}/rel/other/subagents/agent-b1.meta.json`, j({ agentType: 'lean', description: 'Прогони набор' })],
  [`${R}/rel/other/subagents/agent-b1.jsonl`, use('Bash', { description: 'pytest' }, 6, 'claude-sonnet-5-5')],
  [`/h/Library/Application Support/Claude/claude-code-sessions/acc/org/local_oth1.json`, j({ sessionId: 'local_oth1', cliSessionId: 'other', cwd: '/h/My Project/B2B4U_NEW' })],
  // чужая остывшая: ход кончился два часа назад — не живая, не видна
  [`${R}/old/cold.jsonl`, j({ type: 'assistant', timestamp: new Date(NOW - 2 * 3600_000).toISOString(), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'готово' }] } })],
  [`${R}/old/cold/custom-title.json`, j({ customTitle: 'Остывшая' })],
])

function list(dir: string) {
  const names = new Set<string>()
  for (const path of FILES.keys()) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '')
  if (names.size === 0) throw new Error(`ENOENT ${dir}`)
  return [...names].map(name => {
    const text = FILES.get(`${dir}/${name}`)
    return { name, kind: text === undefined ? ('dir' as const) : ('file' as const), size: text?.length ?? 0, mtimeMs: NOW, isLink: false }
  })
}

test('семья — по всем проектам: из дочерней сессии видны оркестратор, соседка и свой помощник', async ($, on) => {
  on('session.info', () => ({ value: { transcriptPath: `${R}/mod/kid.jsonl` } as never }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', (_, e) => ({ value: list(e.path ?? '') }))
  on('fs.read', (_, e) => {
    const text = FILES.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    const from = e.offset ?? 0
    return { value: text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })

  const ui = await $.ui.mount({
    plugin: 'stukach', component: 'Pane', requestId: 'stukach', surface: 'desktop',
    props: { title: 'Помощники', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /Оркестратор/ }))?.text).toContain('(оркестратор)')
  expect((await ui.find({ type: 'Text', text: /kid/ }))?.text).toContain('(эта сессия)')
  expect((await ui.find({ type: 'Text', text: /правит/ }))?.text).toContain('сейчас: правит — register.tsx')
  expect((await ui.find({ type: 'Text', text: /Релиз/ }))?.text).toContain('Релиз')
  expect((await ui.find({ type: 'Text', text: /поиск · haiku/ }))?.text).toContain('🔍 поиск · haiku')
  await ui.unmount()
})

test('параллельно: живая чужая семья — под своей строкой, с папкой и помощником; остывшая не видна; нажатие открывает её чат', async ($, on) => {
  const opened: string[][] = []
  on('session.info', () => ({ value: { transcriptPath: `${R}/mod/kid.jsonl` } as never }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', (_, e) => ({ value: list(e.path ?? '') }))
  on('fs.read', (_, e) => {
    const text = FILES.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    const from = e.offset ?? 0
    return { value: text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })
  on('process.run', (_, e) => { opened.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } as never } })

  const ui = await $.ui.mount({
    plugin: 'stukach', component: 'Pane', requestId: 'stukach', surface: 'desktop',
    props: { title: 'Помощники', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /Параллельно/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /B2B4U_NEW/ }))?.text).toContain('B2B4U_NEW · other')
  expect((await ui.find({ type: 'Text', text: /x\.md/ }))?.text).toContain('сейчас: читает — x.md')
  expect((await ui.find({ type: 'Text', text: /проверка · sonnet/ }))?.text).toContain('✅ проверка · sonnet')
  expect(await ui.find({ type: 'Text', text: /Остывшая/ })).toBeUndefined()
  // одиночная чужая сессия — не оркестратор, а оркестратор своей семьи остаётся им
  expect((await ui.find({ type: 'Text', text: /B2B4U_NEW/ }))?.text).not.toContain('(оркестратор)')
  await ui.press({ key: 'open-other' })
  expect(opened.pop()).toEqual(['open', 'claude://claude.ai/epitaxy/local_oth1'])
  await ui.unmount()
})
