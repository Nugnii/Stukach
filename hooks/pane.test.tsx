import { expect, test } from 'claude-code/testing'

// Поддельный проект той же формы, что настоящий: оркестратор, дочерняя сессия, у неё скептик.
const NOW = Date.parse('2026-11-22T21:00:00.000Z')
const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString()
const j = (o: object) => JSON.stringify(o)
const use = (name: string, input: object, s: number, model = 'claude-opus-5-5') =>
  j({ type: 'assistant', timestamp: at(s), message: { model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `u${s}`, name, input }] } })

const FILES = new Map<string, string>([
  ['/p/orch.jsonl', [j({ type: 'user', timestamp: at(0), message: { content: 'старт' } }), use('Bash', { description: 'Сверка списка' }, 1)].join('\n')],
  ['/p/orch/custom-title.json', j({ customTitle: 'Главная' })],
  ['/p/kid.jsonl', [j({ type: 'derived-from', sessions: [{ id: 'orch', via: 'launch' }] }), use('Edit', { file_path: '/r/src/login.ts' }, 2)].join('\n')],
  ['/p/kid/custom-title.json', j({ customTitle: 'Задача 3: починить вход' })],
  ['/p/kid/subagents/agent-a1.meta.json', j({ agentType: 'lean', description: 'Opus skeptic for task 3', model: 'opus' })],
  ['/p/kid/subagents/agent-a1.jsonl', [j({ type: 'user', timestamp: at(3), message: { content: 'Докажи, что починка ломается' } }), use('Bash', { command: 'git push' }, 4)].join('\n')],
  // законченный помощник: в списке его строки нет, он только в числе законченных
  ['/p/kid/subagents/agent-a2.meta.json', j({ agentType: 'lean', description: 'Сверка ридми', model: 'sonnet', finished: true })],
  ['/p/kid/subagents/agent-a2.jsonl', use('Read', { file_path: '/r/README.md' }, 5, 'claude-sonnet-5-5')],
  // волна (Workflow): помощники лежат глубже, законченный отмечен в журнале волны, имя — в имени файла сценария
  ['/p/kid/workflows/scripts/audit-wf_1.js', 'export const meta = {}'],
  ['/p/kid/subagents/workflows/wf_1/journal.jsonl', [j({ type: 'launched' }), j({ type: 'started', agentId: 'w1' }), j({ type: 'started', agentId: 'w2' }), j({ type: 'result', agentId: 'w2', result: {} })].join('\n')],
  ['/p/kid/subagents/workflows/wf_1/agent-w1.meta.json', j({ agentType: 'lean', description: 'Найди вызовы parse_config', workflowPhase: 'Search' })],
  ['/p/kid/subagents/workflows/wf_1/agent-w1.jsonl', use('Grep', { pattern: 'parse_config' }, 6, 'claude-haiku-5-5')],
  ['/p/kid/subagents/workflows/wf_1/agent-w2.meta.json', j({ agentType: 'lean', description: 'Найди тесты входа', workflowPhase: 'Search' })],
  ['/p/kid/subagents/workflows/wf_1/agent-w2.jsonl', use('Glob', { pattern: 'tests/**' }, 7, 'claude-haiku-5-5')],
  ['/p/old.desktop-released.json', '{}'],
  ['/h/Library/Application Support/Claude/claude-code-sessions/acc/org/local_kid1.json', j({ sessionId: 'local_kid1', cliSessionId: 'kid' })],
  ['/h/.claude/stukach/waits/kid.json', j({ a1: { tool: 'команда', what: 'git push', since: NOW - 30_000 } })],
])

function list(dir: string) {
  const names = new Set<string>()
  for (const path of FILES.keys()) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '')
  return [...names].map(name => {
    const text = FILES.get(`${dir}/${name}`)
    return { name, kind: text === undefined ? ('dir' as const) : ('file' as const), size: text?.length ?? 0, mtimeMs: NOW, isLink: false }
  })
}

const PANE = {
  plugin: 'stukach',
  component: 'Pane',
  requestId: 'stukach',
  props: { title: 'Помощники', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('панель: оркестратор, дочерняя сессия, её скептик, ждущий разрешения, и волна; законченные — только числом', async ($, on) => {
  // Под плагином никто не отвечает на вызовы $: каждый вызов отрисовки отвечен здесь.
  on('session.info', () => ({ value: { transcriptPath: '/p/orch.jsonl' } as never }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', (_, e) => ({ value: list(e.path ?? '') }))
  const opened: string[][] = []
  on('process.run', (_, e) => { opened.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } as never } })
  on('fs.read', (_, e) => {
    const text = FILES.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    const from = e.offset ?? 0
    return { value: text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Главная/ }))?.text).toContain('(оркестратор)')
    expect((await ui.find({ type: 'Text', text: /Задача 3/ }))?.text).toContain('Задача 3: починить вход')
    expect((await ui.find({ type: 'Text', text: /скептик · opus/ }))?.text).toContain('🧐 скептик · opus · ⏳ ждёт разрешения: команда git push')
    expect((await ui.find({ type: 'Text', text: /правит/ }))?.text).toContain('сейчас: правит — login.ts')
    expect((await ui.find({ type: 'Text', text: /Ждут вашего разрешения/ }))?.text).toContain('1')
    expect((await ui.find({ type: 'Text', text: /волна/ }))?.text).toContain('🌊 волна «audit» · идут 1 из 2')
    expect((await ui.find({ type: 'Text', text: /поиск · haiku/ }))?.text).toContain('🔍 поиск · haiku · ● работает')
    expect((await ui.find({ type: 'Text', text: /закончили/ }))?.text).toContain('✓ закончили: 2')
    expect(await ui.find({ type: 'Text', text: /Сверка ридми|Найди тесты входа/ })).toBeUndefined()
    await ui.press({ key: 'open-kid' })
    expect(opened.pop()).toEqual(['open', 'claude://claude.ai/epitaxy/local_kid1'])
    await ui.unmount()
  }
})
