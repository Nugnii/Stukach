import { expect, test } from 'claude-code/testing'

// Атаки финального скептика 23.11.2026 (А1–А3, А5, А6, А8, А9): каждая — своя папка проекта, чтобы кеши модуля не пересекались.
const NOW = Date.parse('2026-11-22T21:00:00.000Z')
const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString()
const j = (o: object) => JSON.stringify(o)
const use = (name: string, input: object, s: number, model = 'claude-opus-5-5', id = `u${s}`) =>
  j({ type: 'assistant', timestamp: at(s), message: { model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
const answer = (s: number, id = `u${s}`) => j({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const endTurn = (s: number, model = 'claude-opus-5-5') => j({ type: 'assistant', timestamp: at(s), message: { model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'готово' }] } })
const prompt = (s: number, text: string) => j({ type: 'user', timestamp: at(s), message: { content: text } })

type F = Map<string, { text: string; mtime?: number }>
const mk = (o: Record<string, string | { text: string; mtime: number }>): F =>
  new Map(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? { text: v } : v]))

function wire(on: any, files: F, transcript: string) {
  const list = (dir: string) => {
    const names = new Set<string>()
    for (const path of files.keys()) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '')
    return [...names].map(name => {
      const f = files.get(`${dir}/${name}`)
      return { name, kind: f === undefined ? ('dir' as const) : ('file' as const), size: f?.text.length ?? 0, mtimeMs: f?.mtime ?? NOW, isLink: false }
    })
  }
  on('session.info', () => ({ value: { transcriptPath: transcript } as never }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', (_: unknown, e: { path?: string }) => ({ value: list(e.path ?? '') }))
  on('fs.read', (_: unknown, e: { path: string; offset?: number; length?: number }) => {
    const f = files.get(e.path)
    if (f === undefined) throw new Error(`ENOENT ${e.path}`)
    const from = e.offset ?? 0
    return { value: f.text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })
}

const PANE = {
  plugin: 'stukach',
  component: 'Pane',
  requestId: 'stukach',
  surface: 'terminal',
  props: { title: 'Помощники', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const idle = [prompt(0, 'старт'), endTurn(1)].join('\n')

test('А1: помощник волны с записью failed в журнале (лимит) не «работает»', async ($, on) => {
  // Форма живой волны wf_6af22771-36a: journal {"type":"failed"}, хвост — ответ <synthetic> stop_sequence о лимите.
  const w = '/t1/orch/subagents/workflows/wf_f'
  wire(on, mk({
    '/t1/orch.jsonl': idle,
    '/t1/orch/workflows/scripts/scan-wf_f.js': 'x',
    [`${w}/journal.jsonl`]: [j({ type: 'launched' }), j({ type: 'started', agentId: 'w1' }), j({ type: 'failed', agentId: 'w1' })].join('\n'),
    [`${w}/agent-w1.meta.json`]: j({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    [`${w}/agent-w1.jsonl`]: [prompt(2, 'Найди вызовы'), use('Grep', { pattern: 'x' }, 3, 'claude-haiku-5-5'), answer(4, 'u3'),
      j({ type: 'assistant', timestamp: at(5), error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your session limit" }] } })].join('\n'),
  }), '/t1/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /волна/ }))?.text).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /работает/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('А2: помощники убитой волны (status killed, прерваны) не «идут»', async ($, on) => {
  // Форма живой волны wf_50b79aa2-389: в журнале только started, workflows/<id>.json status killed, хвост — «[Request interrupted by user]».
  const w = '/t2/orch/subagents/workflows/wf_k'
  wire(on, mk({
    '/t2/orch.jsonl': idle,
    '/t2/orch/workflows/scripts/fix-wf_k.js': 'x',
    '/t2/orch/workflows/wf_k.json': j({ runId: 'wf_k', status: 'killed', workflowName: 'fix', error: 'Error: Workflow aborted' }),
    [`${w}/journal.jsonl`]: [j({ type: 'launched' }), j({ type: 'started', agentId: 'k1' })].join('\n'),
    [`${w}/agent-k1.meta.json`]: j({ agentType: 'lean', description: 'site-fix', model: 'sonnet' }),
    [`${w}/agent-k1.jsonl`]: [prompt(2, 'Почини'), use('Edit', { file_path: '/r/a.ts' }, 3, 'claude-sonnet-5-5'),
      j({ type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })].join('\n'),
  }), '/t2/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /волна/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('А3: сверх предела законченный по хвосту помощник считается «ещё работают»', async ($, on) => {
  const s = '/t3/orch/subagents'
  const files: Record<string, string | { text: string; mtime: number }> = { '/t3/orch.jsonl': idle }
  for (let k = 0; k < 8; k++) {
    files[`${s}/agent-r${k}.meta.json`] = j({ agentType: 'lean', description: `Найди ${k}`, model: 'haiku' })
    files[`${s}/agent-r${k}.jsonl`] = { text: [prompt(2, 'Найди'), use('Grep', { pattern: `p${k}` }, 3 + k, 'claude-haiku-5-5')].join('\n'), mtime: NOW - k }
  }
  // старше всех по времени файла, ход закончен, meta без finished (так у 149 живых meta)
  files[`${s}/agent-old.meta.json`] = j({ agentType: 'lean', description: 'Сверка ридми', model: 'sonnet' })
  files[`${s}/agent-old.jsonl`] = { text: [prompt(1, 'Сверь'), endTurn(2, 'claude-sonnet-5-5')].join('\n'), mtime: NOW - 600_000 }
  wire(on, mk(files), '/t3/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /закончили/ }))?.text).toContain('✓ закончили: 1')
  expect((await ui.find({ type: 'Text', text: /ещё работают/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('А5: волна, чей сценарий не в workflows/scripts, названа номером, хотя имя есть в workflows/<id>.json', async ($, on) => {
  // Форма живых волн wf_06947405-7cf, wf_b1ccb740-f54, wf_d5cfa583-28b: scriptPath в scratchpad, workflowName в wf_<id>.json.
  const w = '/t5/orch/subagents/workflows/wf_s'
  wire(on, mk({
    '/t5/orch.jsonl': idle,
    '/t5/orch/workflows/wf_s.json': j({ runId: 'wf_s', status: 'running', workflowName: 'b485-final-skeptic', scriptPath: '/tmp/scratchpad/final-skeptic.js' }),
    [`${w}/journal.jsonl`]: [j({ type: 'launched' }), j({ type: 'started', agentId: 's1' })].join('\n'),
    [`${w}/agent-s1.meta.json`]: j({ agentType: 'lean', description: 'skeptic', model: 'opus' }),
    [`${w}/agent-s1.jsonl`]: [prompt(2, 'Докажи'), use('Read', { file_path: '/r/a.ts' }, 3)].join('\n'),
  }), '/t5/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /волна/ }))?.text).toContain('«b485-final-skeptic»')
  await ui.unmount()
})

test('А6: одна недописанная meta давно законченного помощника волны роняет всю панель', async ($, on) => {
  const w = '/t6/orch/subagents/workflows/wf_e'
  wire(on, mk({
    '/t6/orch.jsonl': idle,
    [`${w}/journal.jsonl`]: [j({ type: 'launched' }), j({ type: 'started', agentId: 'e1' }), j({ type: 'result', agentId: 'e1' })].join('\n'),
    [`${w}/agent-e1.meta.json`]: '',
    [`${w}/agent-e1.jsonl`]: [prompt(2, 'Найди'), endTurn(3)].join('\n'),
  }), '/t6/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Не прочитать сессии/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('А8: помощник, ждущий разрешения, чей файл старше восьми работающих, спрятан в «ещё работают»', async ($, on) => {
  // Пока помощник ждёт разрешения, его расшифровка не пишется: время файла отстаёт от работающих соседей.
  const s = '/t8/orch/subagents'
  const files: Record<string, string | { text: string; mtime: number }> = { '/t8/orch.jsonl': idle }
  for (let k = 0; k < 8; k++) {
    files[`${s}/agent-r${k}.meta.json`] = j({ agentType: 'lean', description: `Найди ${k}`, model: 'haiku' })
    files[`${s}/agent-r${k}.jsonl`] = { text: [prompt(2, 'Найди'), use('Grep', { pattern: `p${k}` }, 3 + k, 'claude-haiku-5-5')].join('\n'), mtime: NOW - k }
  }
  files[`${s}/agent-wt.meta.json`] = j({ agentType: 'lean', description: 'Почини вход', model: 'opus' })
  files[`${s}/agent-wt.jsonl`] = { text: [prompt(1, 'Почини'), use('Bash', { command: 'git push' }, 2)].join('\n'), mtime: NOW - 120_000 }
  files['/h/.claude/stukach/waits/orch.json'] = j({ wt: { tool: 'команда', what: 'git push', since: NOW - 110_000 } })
  wire(on, mk(files), '/t8/orch.jsonl')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Ждут вашего разрешения/ }))?.text).toContain('1')
  await ui.unmount()
})

test('А9 (+проверка рендера): рисунок с волной и числом сверх предела на desktop и в виджете не отвергнут', async ($, on) => {
  const w = '/t9/orch/subagents/workflows/wf_b'
  const files: Record<string, string | { text: string; mtime: number }> = { '/t9/orch.jsonl': idle, '/t9/orch/workflows/scripts/big-wf_b.js': 'x', [`${w}/journal.jsonl`]: j({ type: 'launched' }) }
  for (let k = 0; k < 10; k++) {
    files[`${w}/agent-b${k}.meta.json`] = j({ agentType: 'workflow-subagent', spawnDepth: 1 })
    files[`${w}/agent-b${k}.jsonl`] = { text: [prompt(2, 'Найди'), use('Grep', { pattern: `p${k}` }, 3 + k, 'claude-haiku-5-5')].join('\n'), mtime: NOW - k }
  }
  wire(on, mk(files), '/t9/orch.jsonl')
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /волна/ }))?.text).toContain('идут 10 из 10')
    expect((await ui.find({ type: 'Text', text: /ещё работают/ }))?.text).toContain('2')
    await ui.unmount()
  }
  const wd = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } } as never)
  // А9: в волне идут 10, виджет должен это сказать
  expect((await wd.find({ type: 'Text', text: /помощн/ }))?.text).toContain('10 помощн')
  await wd.unmount()
})
