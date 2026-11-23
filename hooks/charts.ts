// Столбчатые графики статистики: SVG-строка для элемента Svg (рабочий стол рисует её картинкой).
// Цвета — эталонная палитра скилла dataviz: серия 1 и чернила текста, свои шаги для тёмной темы.

export type Column = { label: string; value: number; tip: string; isCurrent?: boolean }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STYLE =
  '<style>.bar{fill:#2a78d6}.now{fill:#2a78d6;opacity:.5}.ink{fill:#52514e}.base{stroke:#d6d5d0}' +
  '@media (prefers-color-scheme: dark){.bar,.now{fill:#3987e5}.ink{fill:#c3c2b7}.base{stroke:#3a3a38}}' +
  'text{font:11px -apple-system,system-ui,sans-serif}.t{font-weight:600}</style>'

/** Колонки с заголовком: одна серия, без легенды; подписаны самая большая и текущая (её столбец бледнее и подписан «идёт»). */
export function columnsSvg(title: string, cols: Column[], format: (n: number) => string, width = 380): string {
  const height = 132
  const top = 34 // заголовок и подпись над самым высоким столбцом
  const bottom = 18 // подписи периодов
  const plot = height - top - bottom
  const band = width / Math.max(1, cols.length)
  const barW = Math.min(24, band - 2)
  const max = Math.max(...cols.map(c => c.value), 0)
  const maxAt = cols.findIndex(c => c.value === max && max > 0)
  const every = Math.ceil(cols.length / 7) // подписи периодов не налезают: не больше семи, шаг — от последнего столбца
  const parts: string[] = [`<text class="ink t" x="0" y="13">${esc(title)}</text>`]
  // подпись у края прижимается к краю столбца, а не центрируется: иначе её режет рамка картинки
  const anchor = (i: number, x: number, cx: number) =>
    i === 0 ? `x="${x}" text-anchor="start"` : i === cols.length - 1 ? `x="${x + barW}" text-anchor="end"` : `x="${cx}" text-anchor="middle"`
  cols.forEach((c, i) => {
    const h = max > 0 ? Math.max(c.value > 0 ? 1 : 0, (c.value / max) * plot) : 0
    const x = i * band + (band - barW) / 2
    const y = top + plot - h
    const r = Math.min(4, h)
    const cx = x + barW / 2
    if (h > 0) {
      parts.push(
        `<path class="${c.isCurrent ? 'now' : 'bar'}" d="M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z"><title>${esc(c.tip)}</title></path>`,
      )
    }
    // невидимая полоса на всю высоту — подсказка ловится и над низким столбцом
    parts.push(`<rect x="${i * band}" y="${top}" width="${band}" height="${plot}" fill="transparent"><title>${esc(c.tip)}</title></rect>`)
    // подписи значений — одним рядом над графиком (над соседним высоким столбцом подпись низкого налезала бы на него);
    // подпись самого большого уступает текущей, если им тесно: его число есть в таблице и подсказке
    const isCrowded = i === maxAt && cols.some((d, k) => d.isCurrent && k !== i && Math.abs(k - i) * band < 110)
    if ((i === maxAt && !isCrowded) || c.isCurrent) {
      parts.push(`<text class="ink" ${anchor(i, x, cx)} y="${top - 6}">${esc(c.isCurrent ? `${format(c.value)} · идёт` : format(c.value))}</text>`)
    }
    if ((cols.length - 1 - i) % every === 0) {
      parts.push(`<text class="ink" ${anchor(i, x, cx)} y="${height - 4}">${esc(c.label)}</text>`)
    }
  })
  parts.push(`<line class="base" x1="0" x2="${width}" y1="${top + plot + 0.5}" y2="${top + plot + 0.5}" stroke-width="1"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${STYLE}${parts.join('')}</svg>`
}

/** Тот же ряд текстом — для терминала, где нет Svg. */
export function columnsText(cols: Column[], format: (n: number) => string, width = 16): string[] {
  const max = Math.max(...cols.map(c => c.value), 0)
  const labelW = Math.max(...cols.map(c => c.label.length), 0)
  return cols.map(c => {
    const n = max > 0 ? Math.round((c.value / max) * width) : 0
    return `${c.label.padEnd(labelW)} ${'█'.repeat(n)}${'░'.repeat(width - n)} ${format(c.value)}${c.isCurrent ? ' · идёт' : ''}`
  })
}
