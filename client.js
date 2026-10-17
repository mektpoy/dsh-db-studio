/**
 * dsh-db-studio — Client half.
 *
 * One sidebar entry plus its main-column panel: saved connections, an object
 * tree, a paged data grid, a schema view, a SQL runner and the query history.
 * Every operation goes through /db-studio/api, which the Host half owns.
 */

window.__ModuleLoader__.load({
  id: 'dsh-db-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'db-studio'
    const API = '/db-studio/api'
    const PANEL_ID = 'db-studio'
    const PAGE_SIZES = [25, 50, 100, 200]

    // ---------------------------------------------------------------- locale

    const ZH = {
      panel: '数据库',
      'conn.title': '连接',
      'conn.add': '添加连接',
      'conn.empty': '还没有保存的连接。添加一个 SQLite 文件即可开始。',
      'conn.name': '名称',
      'conn.path': '数据库文件',
      'conn.pathHint': '绝对路径，例如 C:\\Users\\me\\data\\app.db',
      'conn.readOnly': '只读打开',
      'conn.readOnlyHint': '只读连接会拒绝任何改动语句。模型要写入时必须由你在面板里关掉只读。',
      'conn.save': '保存',
      'conn.cancel': '取消',
      'conn.delete': '删除连接',
      'conn.deleteConfirm': '删除连接“{name}”？只删除这条记录，不动数据库文件。',
      'conn.test': '测试',
      'conn.browse': '浏览',
      'conn.edit': '编辑',
      'conn.required': '名称和文件路径都要填。',
      'conn.readonlyBadge': '只读',
      'conn.writeBadge': '可写',
      'objects.title': '对象',
      'objects.empty': '这个库里没有表或视图。',
      'objects.tables': '表',
      'objects.views': '视图',
      'objects.rows': '{n} 行',
      'tabs.data': '数据',
      'tabs.structure': '结构',
      'tabs.sql': 'SQL',
      'tabs.history': '历史',
      'grid.empty': '没有行。',
      'grid.null': 'NULL',
      'grid.blob': '<二进制 {n} 字节>',
      'grid.rows': '{from}–{to} / 共 {total} 行',
      'grid.rowsUnknown': '{from}–{to}',
      'grid.prev': '上一页',
      'grid.next': '下一页',
      'grid.sortAsc': '升序',
      'grid.sortDesc': '降序',
      'data.search': '在整表里搜索…',
      'data.refresh': '刷新',
      'data.exportCsv': '导出 CSV',
      'data.exportJson': '导出 JSON',
      'data.pickTable': '从左侧选一张表。',
      'data.pageSize': '每页',
      'structure.columns': '列',
      'structure.indexes': '索引',
      'structure.foreignKeys': '外键',
      'structure.ddl': '建表语句',
      'structure.primaryKey': '主键',
      'structure.notNull': '非空',
      'structure.default': '默认值',
      'structure.unique': '唯一',
      'structure.noIndexes': '没有索引。',
      'structure.noForeignKeys': '没有外键。',
      'sql.placeholder': '在这里写 SQL，Ctrl+Enter 执行',
      'sql.run': '执行',
      'sql.explain': '执行计划',
      'sql.allowWrite': '允许改动语句',
      'sql.allowWriteHint': '这条连接是可写的；改动语句只在你勾选后执行。',
      'sql.readOnlyHint': '这条连接是只读的，改动语句会被拒绝。',
      'sql.empty': '结果会显示在这里。',
      'sql.summary': '{statements} 条语句，{rows} 行，{ms} ms',
      'sql.changes': '影响 {n} 行',
      'sql.truncated': '只返回前 {n} 行',
      'history.empty': '还没有执行记录。',
      'history.pick': '载入到编辑器',
      'history.clear': '清空历史',
      'history.clearConfirm': '清空这条连接的执行历史？',
      'state.sqliteMissing': '这个运行时没有 node:sqlite，插件无法打开数据库。',
      'state.addFirst': '添加第一个连接',
      'state.toolHint': '模型也能直接查询这些连接：它调用 db 工具，走同一套只读规则。',
      'state.error': '出错了',
      'busy.load': '读取中…',
      'busy.query': '执行中…',
      'busy.schema': '读取结构…',
      'busy.export': '导出中…',
      'busy.save': '保存中…',
      'unit.ms': '毫秒',
      'stats.pages': '{pages} 页 × {size} 字节',
      'stats.version': 'SQLite {version}',
      'stats.bytes': '{n} 字节',
    }

    const EN = {
      panel: 'Database',
      'conn.title': 'Connections',
      'conn.add': 'Add connection',
      'conn.empty': 'No saved connection yet. Add a SQLite file to start.',
      'conn.name': 'Name',
      'conn.path': 'Database file',
      'conn.pathHint': 'Absolute path, for example C:\\Users\\me\\data\\app.db',
      'conn.readOnly': 'Open read-only',
      'conn.readOnlyHint': 'A read-only connection refuses every statement that changes the database. Turn it off here when the model should be able to write.',
      'conn.save': 'Save',
      'conn.cancel': 'Cancel',
      'conn.delete': 'Delete connection',
      'conn.deleteConfirm': 'Delete the connection "{name}"? This removes the entry only, not the database file.',
      'conn.test': 'Test',
      'conn.browse': 'Browse',
      'conn.edit': 'Edit',
      'conn.required': 'A name and a file path are both required.',
      'conn.readonlyBadge': 'read-only',
      'conn.writeBadge': 'writable',
      'objects.title': 'Objects',
      'objects.empty': 'This database has no tables or views.',
      'objects.tables': 'Tables',
      'objects.views': 'Views',
      'objects.rows': '{n} rows',
      'tabs.data': 'Data',
      'tabs.structure': 'Structure',
      'tabs.sql': 'SQL',
      'tabs.history': 'History',
      'grid.empty': 'No rows.',
      'grid.null': 'NULL',
      'grid.blob': '<blob {n} bytes>',
      'grid.rows': '{from}–{to} of {total} rows',
      'grid.rowsUnknown': '{from}–{to}',
      'grid.prev': 'Previous',
      'grid.next': 'Next',
      'grid.sortAsc': 'ascending',
      'grid.sortDesc': 'descending',
      'data.search': 'Search every column…',
      'data.refresh': 'Refresh',
      'data.exportCsv': 'Export CSV',
      'data.exportJson': 'Export JSON',
      'data.pickTable': 'Pick a table on the left.',
      'data.pageSize': 'Per page',
      'structure.columns': 'Columns',
      'structure.indexes': 'Indexes',
      'structure.foreignKeys': 'Foreign keys',
      'structure.ddl': 'Create statement',
      'structure.primaryKey': 'primary key',
      'structure.notNull': 'not null',
      'structure.default': 'default',
      'structure.unique': 'unique',
      'structure.noIndexes': 'No indexes.',
      'structure.noForeignKeys': 'No foreign keys.',
      'sql.placeholder': 'Write SQL here; Ctrl+Enter runs it',
      'sql.run': 'Run',
      'sql.explain': 'Query plan',
      'sql.allowWrite': 'Allow statements that change the database',
      'sql.allowWriteHint': 'This connection is writable; changes run only after you tick this box.',
      'sql.readOnlyHint': 'This connection is read-only, so changes are refused.',
      'sql.empty': 'Results appear here.',
      'sql.summary': '{statements} statements, {rows} rows, {ms} ms',
      'sql.changes': '{n} rows affected',
      'sql.truncated': 'first {n} rows only',
      'history.empty': 'Nothing has run yet.',
      'history.pick': 'Load into editor',
      'history.clear': 'Clear history',
      'history.clearConfirm': 'Clear the query history of this connection?',
      'state.sqliteMissing': 'This runtime has no node:sqlite, so the plugin cannot open a database.',
      'state.addFirst': 'Add the first connection',
      'state.toolHint': 'The model can query these connections too: it calls the db tool, under the same read-only rules.',
      'state.error': 'Something failed',
      'busy.load': 'Reading…',
      'busy.query': 'Running…',
      'busy.schema': 'Reading schema…',
      'busy.export': 'Exporting…',
      'busy.save': 'Saving…',
      'unit.ms': 'ms',
      'stats.pages': '{pages} pages × {size} bytes',
      'stats.version': 'SQLite {version}',
      'stats.bytes': '{n} bytes',
    }

    // ------------------------------------------------------------------ api

    async function action(name, body) {
      const response = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: name, ...(body || {}) }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload.data
    }

    // ----------------------------------------------------------------- atoms

    const color = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const S = {
      root: {
        height: '100%', minHeight: 0, display: 'flex', background: color.base, color: color.text,
        fontFamily: 'inherit', fontSize: 13, overflow: 'hidden',
      },
      rail: {
        width: 250, flex: '0 0 250px', minHeight: 0, display: 'flex', flexDirection: 'column',
        borderRight: `1px solid ${color.border}`, background: color.layer1,
      },
      railHead: {
        padding: '10px 10px 8px', borderBottom: `1px solid ${color.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      },
      railTitle: { fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: color.muted },
      railBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 6 },
      main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      mainHead: {
        padding: '10px 14px', borderBottom: `1px solid ${color.border}`,
        display: 'flex', flexDirection: 'column', gap: 8,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 2, padding: '0 8px', borderBottom: `1px solid ${color.border}` },
      body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      pad: { padding: 14, overflow: 'auto', minHeight: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
      th: {
        position: 'sticky', top: 0, zIndex: 1, background: color.layer1, textAlign: 'left',
        padding: '6px 10px', borderBottom: `1px solid ${color.borderStrong}`, whiteSpace: 'nowrap',
        fontWeight: 600, color: color.muted,
      },
      td: {
        padding: '5px 10px', borderBottom: `1px solid ${color.border}`, whiteSpace: 'nowrap',
        maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis',
      },
      input: {
        background: color.base, color: color.text, border: `1px solid ${color.borderStrong}`,
        borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none',
      },
      hint: { color: color.muted, fontSize: 11, lineHeight: 1.5 },
      card: {
        background: color.layer1, border: `1px solid ${color.border}`, borderRadius: 8,
        padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
      },
    }

    function Btn({ label, onClick, disabled, tone, title, kind }) {
      const primary = kind === 'primary'
      const style = {
        padding: primary ? '5px 12px' : '4px 9px',
        borderRadius: 6,
        border: `1px solid ${primary ? 'transparent' : color.borderStrong}`,
        background: primary ? color.brand : 'transparent',
        color: primary ? color.base : (tone === 'danger' ? color.error : color.text),
        fontSize: 12, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }
      return h('button', { type: 'button', style, onClick, disabled, title: title || label }, label)
    }

    function Badge({ text, tone }) {
      const style = {
        fontSize: 10, padding: '1px 6px', borderRadius: 999, border: `1px solid ${tone === 'warn' ? color.warn : color.borderStrong}`,
        color: tone === 'warn' ? color.warn : tone === 'ok' ? color.ok : color.muted, whiteSpace: 'nowrap',
      }
      return h('span', { style }, text)
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { fontSize: 11, color: color.muted } }, label),
        children,
        hint ? h('span', { style: S.hint }, hint) : null)
    }

    function Empty({ text }) {
      return h('div', { style: { padding: 24, color: color.muted, textAlign: 'center', fontSize: 12 } }, text)
    }

    function ErrorBar({ text, onDismiss }) {
      if (!text) return null
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 12px',
          background: color.layer2, borderBottom: `1px solid ${color.border}`,
          color: color.error, fontSize: 12,
        },
      },
      h('span', { style: { flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text),
      h('button', {
        type: 'button',
        onClick: onDismiss,
        style: { border: 'none', background: 'transparent', color: color.muted, cursor: 'pointer', fontSize: 14 },
      }, '×'))
    }

    // ------------------------------------------------------------------ grid

    /** Cells arrive as arrays from `query` and as objects from `preview`. */
    function toMatrix(columns, rows) {
      if (!Array.isArray(rows) || rows.length === 0) return []
      if (Array.isArray(rows[0])) return rows
      return rows.map(row => columns.map(column => row[column.name]))
    }

    function Cell({ value, blobText, nullText }) {
      if (value === null || value === undefined) {
        return h('span', { style: { color: color.idle, fontStyle: 'italic' } }, nullText)
      }
      if (typeof value === 'object' && value && value.$blob) {
        return h('span', { style: { color: color.muted } }, blobText.replace('{n}', String(value.size)))
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return h('span', { title: text.length > 80 ? text : undefined }, text)
    }

    function DataGrid({ t, columns, rows, order, dir, onSort }) {
      const matrix = toMatrix(columns, rows)
      if (columns.length === 0) return h(Empty, { text: t('grid.empty') })
      const head = h('thead', null, h('tr', null,
        h('th', { key: '_row', style: { ...S.th, width: 44, textAlign: 'right' } }, '#'),
        columns.map(column => h('th', {
          key: column.name,
          style: { ...S.th, cursor: onSort ? 'pointer' : 'default' },
          onClick: onSort ? () => onSort(column.name) : undefined,
          title: column.type ? `${column.name}: ${column.type}` : column.name,
        }, column.name + (order === column.name ? (dir === 'desc' ? ' ↓' : ' ↑') : '')))))
      const body = matrix.length === 0
        ? h('tr', null, h('td', {
          style: { ...S.td, color: color.muted }, colSpan: columns.length + 1,
        }, t('grid.empty')))
        : matrix.map((row, rowIndex) => h('tr', { key: rowIndex },
          h('td', { style: { ...S.td, color: color.idle, textAlign: 'right', ...S.mono } }, String(rowIndex + 1)),
          row.map((cell, cellIndex) => h('td', { key: cellIndex, style: S.td },
            h(Cell, { value: cell, blobText: t('grid.blob'), nullText: t('grid.null') })))))
      return h('div', { style: { overflow: 'auto', flex: 1, minHeight: 0 } },
        h('table', { style: S.table }, head, h('tbody', null, body)))
    }

    // -------------------------------------------------------------- rail

    function ConnectionItem({ t, connection, active, onSelect, onEdit }) {
      const style = {
        width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, cursor: 'pointer',
        background: active ? color.layer2 : 'transparent',
        padding: '7px 8px', display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'inherit',
        color: active ? color.text : color.muted,
      }
      return h('button', { type: 'button', style, onClick: () => onSelect(connection.id), title: connection.path },
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, connection.name),
          h(Badge, {
            text: connection.readOnly ? t('conn.readonlyBadge') : t('conn.writeBadge'),
            tone: connection.readOnly ? 'ok' : 'warn',
          })),
        h('span', {
          style: { fontSize: 10, color: color.idle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          onClick: event => { if (event.altKey) onEdit(connection) },
        }, connection.path))
    }

    function ObjectTree({ t, objects, selected, onSelect }) {
      if (!objects) return null
      if (objects.length === 0) return h('div', { style: { ...S.hint, padding: '6px 8px' } }, t('objects.empty'))
      const groups = [
        { key: 'table', label: t('objects.tables') },
        { key: 'view', label: t('objects.views') },
      ]
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        groups.map(group => {
          const items = objects.filter(object => object.type === group.key)
          if (items.length === 0) return null
          return h('div', { key: group.key, style: { marginTop: 6 } },
            h('div', { style: { ...S.railTitle, padding: '2px 8px' } }, `${group.label} (${items.length})`),
            items.map(object => h('button', {
              key: object.name,
              type: 'button',
              title: object.name,
              onClick: () => onSelect(object.name),
              style: {
                width: '100%', display: 'flex', alignItems: 'center', gap: 6, border: 'none',
                background: selected === object.name ? color.layer2 : 'transparent',
                color: selected === object.name ? color.text : color.muted,
                padding: '4px 8px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, textAlign: 'left',
              },
            },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, object.name),
            object.rows === null ? null : h('span', { style: { fontSize: 10, color: color.idle } }, String(object.rows) + (object.rowsCapped ? '+' : '')))))
        }))
    }

    // ---------------------------------------------------------------- panes

    function DataPane({ t, connection, table, page, busy, onPage, onSort, onSearch, onExport, onRefresh }) {
      const [search, setSearch] = useState('')
      const timer = useRef(null)
      useEffect(() => { setSearch('') }, [table])
      if (!table) return h(Empty, { text: t('data.pickTable') })
      const from = page.rows.length === 0 ? 0 : page.offset + 1
      const to = page.offset + page.rows.length
      const total = page.total
      const changeSearch = value => {
        setSearch(value)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => onSearch(value), 260)
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { ...S.row, padding: '8px 12px', borderBottom: `1px solid ${color.border}` } },
          h('input', {
            style: { ...S.input, width: 240 },
            placeholder: t('data.search'),
            value: search,
            onChange: event => changeSearch(event.target.value),
          }),
          h('span', { style: { flex: 1 } }),
          h('select', {
            style: S.input,
            value: page.limit,
            onChange: event => onPage({ offset: 0, limit: Number(event.target.value) }),
          }, PAGE_SIZES.map(size => h('option', { key: size, value: size }, `${t('data.pageSize')} ${size}`))),
          h(Btn, { label: t('data.refresh'), onClick: onRefresh, disabled: busy }),
          h(Btn, { label: t('data.exportCsv'), onClick: () => onExport('csv'), disabled: busy }),
          h(Btn, { label: t('data.exportJson'), onClick: () => onExport('json'), disabled: busy })),
        h(DataGrid, {
          t, columns: page.columns, rows: page.rows, order: page.order, dir: page.dir, onSort: onSort,
        }),
        h('div', { style: { ...S.row, padding: '6px 12px', borderTop: `1px solid ${color.border}` } },
          h('span', { style: S.hint },
            total === null
              ? t('grid.rowsUnknown', { from, to })
              : t('grid.rows', { from, to, total: total + (page.totalCapped ? '+' : '') })),
          h('span', { style: { flex: 1 } }),
          h(Btn, {
            label: t('grid.prev'),
            disabled: busy || page.offset === 0,
            onClick: () => onPage({ offset: Math.max(0, page.offset - page.limit) }),
          }),
          h(Btn, {
            label: t('grid.next'),
            disabled: busy || page.hasMore !== true,
            onClick: () => onPage({ offset: page.offset + page.limit }),
          })))
    }

    function StructurePane({ t, detail }) {
      if (!detail) return h(Empty, { text: t('data.pickTable') })

      const columnRows = detail.columns.map(column => h('tr', { key: column.name },
        h('td', { style: { ...S.td, ...S.mono } }, column.name),
        h('td', { style: { ...S.td, color: color.muted } }, column.type || '—'),
        h('td', { style: S.td }, [
          column.primaryKey ? h(Badge, { key: 'pk', text: t('structure.primaryKey'), tone: 'ok' }) : null,
          column.notNull ? h(Badge, { key: 'nn', text: t('structure.notNull') }) : null,
        ].filter(Boolean)),
        h('td', { style: { ...S.td, ...S.mono, color: color.muted } },
          column.defaultValue === null ? '—' : String(column.defaultValue))))

      const columnsTable = h('table', { style: S.table },
        h('thead', null, h('tr', null,
          h('th', { style: S.th }, 'name'),
          h('th', { style: S.th }, 'type'),
          h('th', { style: S.th }, 'flags'),
          h('th', { style: S.th }, t('structure.default')))),
        h('tbody', null, columnRows))

      const indexRows = detail.indexes.map(index => h('tr', { key: index.name },
        h('td', { style: { ...S.td, ...S.mono } }, index.name),
        h('td', { style: S.td }, index.unique ? h(Badge, { text: t('structure.unique'), tone: 'ok' }) : null),
        h('td', { style: { ...S.td, color: color.muted } }, index.columns.join(', '))))

      const foreignKeyRows = detail.foreignKeys.map(fk => h('tr', { key: fk.id },
        h('td', { style: { ...S.td, ...S.mono } }, fk.from),
        h('td', { style: S.td }, '→'),
        h('td', { style: { ...S.td, ...S.mono } }, `${fk.table}.${fk.to}`),
        h('td', { style: { ...S.td, color: color.muted } }, `on delete ${fk.onDelete}`)))

      const ddl = h('pre', {
        style: {
          ...S.mono, margin: 0, padding: 10, borderRadius: 6, background: color.layer1,
          border: `1px solid ${color.border}`, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto',
        },
      }, detail.ddl || '—')

      return h('div', { style: { ...S.pad, display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', null,
          h('div', { style: { ...S.railTitle, marginBottom: 6 } },
            `${t('structure.columns')} (${detail.columns.length})`),
          columnsTable),
        h('section', null,
          h('div', { style: { ...S.railTitle, marginBottom: 6 } }, t('structure.indexes')),
          detail.indexes.length === 0
            ? h('div', { style: S.hint }, t('structure.noIndexes'))
            : h('table', { style: S.table }, h('tbody', null, indexRows))),
        h('section', null,
          h('div', { style: { ...S.railTitle, marginBottom: 6 } }, t('structure.foreignKeys')),
          detail.foreignKeys.length === 0
            ? h('div', { style: S.hint }, t('structure.noForeignKeys'))
            : h('table', { style: S.table }, h('tbody', null, foreignKeyRows))),
        h('section', null,
          h('div', { style: { ...S.railTitle, marginBottom: 6 } }, t('structure.ddl')),
          ddl))
    }

    function SqlPane({ t, connection, sql, setSql, result, plan, busy, onRun, onExplain, allowWrite, setAllowWrite }) {
      const editor = useRef(null)
      const statement = result ? result.statements[result.statements.length - 1] : null
      const withColumns = result ? [...result.statements].reverse().find(part => part.columns.length > 0) : null
      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('textarea', {
            ref: editor,
            value: sql,
            spellCheck: false,
            placeholder: t('sql.placeholder'),
            onChange: event => setSql(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onRun() }
            },
            style: {
              ...S.mono, minHeight: 96, resize: 'vertical', padding: 10, borderRadius: 6,
              border: `1px solid ${color.borderStrong}`, background: color.base, color: color.text,
              fontSize: 12, lineHeight: 1.55, outline: 'none',
            },
          }),
          h('div', { style: S.row },
            h(Btn, { label: t('sql.run'), kind: 'primary', onClick: onRun, disabled: busy }),
            h(Btn, { label: t('sql.explain'), onClick: onExplain, disabled: busy }),
            connection && connection.readOnly
              ? h('span', { style: { ...S.hint, marginLeft: 6 } }, t('sql.readOnlyHint'))
              : h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: color.muted } },
                h('input', {
                  type: 'checkbox', checked: allowWrite,
                  onChange: event => setAllowWrite(event.target.checked),
                }),
                t('sql.allowWrite')),
            h('span', { style: { flex: 1 } }),
            result
              ? h('span', { style: S.hint }, t('sql.summary', {
                statements: result.statements.length,
                rows: result.statements.reduce((sum, part) => sum + part.rowCount, 0),
                ms: result.durationMs,
              }))
              : null)),
        h('div', { style: { borderTop: `1px solid ${color.border}`, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          plan
            ? h(DataGrid, { t, columns: plan.columns, rows: plan.rows })
            : result === null
              ? h(Empty, { text: t('sql.empty') })
              : withColumns
                ? h(DataGrid, { t, columns: withColumns.columns, rows: withColumns.rows })
                : h('div', { style: { ...S.pad, ...S.hint } },
                  statement && statement.changes > 0 ? t('sql.changes', { n: statement.changes }) : t('sql.empty'))))
    }

    function HistoryPane({ t, items, onPick, onClear }) {
      if (items.length === 0) return h(Empty, { text: t('history.empty') })
      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { ...S.row, padding: '8px 12px', borderBottom: `1px solid ${color.border}` } },
          h('span', { style: { flex: 1 } }),
          h(Btn, { label: t('history.clear'), tone: 'danger', onClick: onClear })),
        h('div', { style: { overflow: 'auto', flex: 1, minHeight: 0 } },
          items.map(item => h('div', {
            key: item.id,
            style: {
              padding: '8px 12px', borderBottom: `1px solid ${color.border}`,
              display: 'flex', flexDirection: 'column', gap: 4,
            },
          },
          h('div', { style: { ...S.row, gap: 8 } },
            h(Badge, { text: item.ok ? 'ok' : 'error', tone: item.ok ? 'ok' : 'warn' }),
            h('span', { style: { ...S.hint } }, new Date(item.at).toLocaleString()),
            h('span', { style: { ...S.hint } }, `${item.durationMs} ${t('unit.ms')}`),
            h('span', { style: { ...S.hint } }, `${item.rowCount} rows`),
            h('span', { style: { flex: 1 } }),
            h(Btn, { label: t('history.pick'), onClick: () => onPick(item.sql) })),
          h('pre', {
            style: { ...S.mono, margin: 0, fontSize: 12, color: color.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
          }, item.sql),
          item.error ? h('div', { style: { fontSize: 12, color: color.error, whiteSpace: 'pre-wrap' } }, item.error) : null))))
    }

    function ConnectionForm({ t, initial, busy, onSave, onCancel, onDelete }) {
      const [name, setName] = useState(initial?.name || '')
      const [path, setPath] = useState(initial?.path || '')
      const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true)
      const [note, setNote] = useState('')
      const [problem, setProblem] = useState('')
      const submit = () => {
        if (!name.trim() || !path.trim()) { setProblem(t('conn.required')); return }
        setProblem('')
        onSave({ id: initial?.id, name: name.trim(), path: path.trim(), readOnly, note })
      }
      return h('div', { style: { ...S.card, margin: 10 } },
        h('div', { style: { fontSize: 12, fontWeight: 600 } }, initial ? t('conn.edit') : t('conn.add')),
        h(Field, { label: t('conn.name') },
          h('input', { style: S.input, value: name, onChange: event => setName(event.target.value) })),
        h(Field, { label: t('conn.path'), hint: t('conn.pathHint') },
          h('input', { style: S.input, value: path, onChange: event => setPath(event.target.value) })),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
          h('input', { type: 'checkbox', checked: readOnly, onChange: event => setReadOnly(event.target.checked) }),
          t('conn.readOnly')),
        h('div', { style: S.hint }, t('conn.readOnlyHint')),
        problem ? h('div', { style: { color: color.error, fontSize: 12 } }, problem) : null,
        h('div', { style: S.row },
          h(Btn, { label: t('conn.save'), kind: 'primary', onClick: submit, disabled: busy }),
          h(Btn, { label: t('conn.cancel'), onClick: onCancel, disabled: busy }),
          h('span', { style: { flex: 1 } }),
          initial ? h(Btn, { label: t('conn.delete'), tone: 'danger', onClick: onDelete, disabled: busy }) : null))
    }

    // ----------------------------------------------------------------- panel

    function DbStudioPanel(props) {
      const t = props.t || (key => key)
      const [boot, setBoot] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [activeId, setActiveId] = useState('')
      const [schema, setSchema] = useState(null)
      const [detail, setDetail] = useState(null)
      const [table, setTable] = useState('')
      const [tab, setTab] = useState('data')
      const [page, setPage] = useState({ columns: [], rows: [], total: null, totalCapped: false, offset: 0, limit: 50, order: '', dir: 'asc', hasMore: false, search: '' })
      const [sql, setSql] = useState('')
      const [result, setResult] = useState(null)
      const [plan, setPlan] = useState(null)
      const [allowWrite, setAllowWrite] = useState(false)
      const [history, setHistory] = useState([])
      const [form, setForm] = useState(null)

      const connections = boot?.connections || []
      const connection = connections.find(item => item.id === activeId) || null

      const guard = useCallback(async (label, work) => {
        setBusy(label)
        setError('')
        try {
          return await work()
        } catch (problem) {
          setError(problem?.message || String(problem))
          return null
        } finally {
          setBusy('')
        }
      }, [])

      const loadState = useCallback(async () => {
        const next = await guard(t('busy.load'), () => action('state'))
        if (!next) return null
        setBoot(next)
        return next
      }, [guard, t])

      const loadSchema = useCallback(async id => {
        const data = await guard(t('busy.schema'), () => action('schema', { id }))
        if (!data) return
        setSchema(data)
        setDetail(null)
        setTable('')
        setResult(null)
        setPlan(null)
      }, [guard, t])

      const loadPage = useCallback(async (id, name, overrides) => {
        if (!id || !name) return
        const merged = { ...page, ...(overrides || {}) }
        const data = await guard(t('busy.load'), () => action('preview', {
          id, table: name, limit: merged.limit, offset: merged.offset,
          order: merged.order || undefined, dir: merged.dir, search: merged.search || undefined,
        }))
        if (data) {
          setPage({
            columns: data.columns, rows: data.rows, total: data.total, totalCapped: data.totalCapped === true,
            offset: data.offset, limit: data.limit, order: merged.order, dir: merged.dir, hasMore: data.hasMore, search: merged.search,
          })
        }
      }, [guard, page, t])

      const loadHistory = useCallback(async id => {
        const data = await guard('', () => action('history', { id, limit: 50 }))
        if (data) setHistory(data.history)
      }, [guard])

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          const next = await loadState()
          if (cancelled || !next) return
          const first = next.connections[0]
          if (first) {
            setActiveId(first.id)
            setForm(null)
          } else {
            setForm({ mode: 'create' })
          }
        })()
        return () => { cancelled = true }
      }, [loadState])

      useEffect(() => {
        if (!activeId) return
        loadSchema(activeId)
        loadHistory(activeId)
      }, [activeId, loadSchema, loadHistory])

      const pickTable = useCallback(name => {
        setTable(name)
        setTab('data')
        setPage(current => ({ ...current, offset: 0, order: '', dir: 'asc', search: '' }))
        loadPage(activeId, name, { offset: 0, order: '', dir: 'asc', search: '' })
        guard('', () => action('schema', { id: activeId, table: name })).then(data => {
          if (data?.detail) setDetail(data.detail)
        })
      }, [activeId, guard, loadPage])

      const runSql = useCallback(async () => {
        if (!sql.trim() || !activeId) return
        setPlan(null)
        const data = await guard(t('busy.query'), () => action('query', {
          id: activeId, sql, maxRows: 200, allowWrite,
        }))
        if (data) setResult(data)
        loadHistory(activeId)
      }, [activeId, allowWrite, guard, loadHistory, sql, t])

      const explainSql = useCallback(async () => {
        if (!sql.trim() || !activeId) return
        setResult(null)
        const data = await guard(t('busy.query'), () => action('explain', { id: activeId, sql }))
        if (data) setPlan(data)
      }, [activeId, guard, sql, t])

      const exportData = useCallback(async (format, source) => {
        const body = { id: activeId, format, maxRows: 5000 }
        if (source === 'sql') body.sql = sql
        else body.table = table
        const data = await guard(t('busy.export'), () => action('export', body))
        if (!data) return
        const blob = new Blob([data.body], { type: data.contentType })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = data.filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      }, [activeId, guard, sql, t, table])

      const saveConnection = useCallback(async input => {
        const saved = await guard(t('busy.save'), () => action('save', input))
        if (!saved) return
        const next = await loadState()
        setForm(null)
        if (next) {
          if (saved.id) setActiveId(saved.id)
          else if (next.connections[0]) setActiveId(next.connections[0].id)
        }
      }, [guard, loadState, t])

      const deleteConnection = useCallback(async id => {
        const target = connections.find(item => item.id === id)
        if (!target) return
        if (!window.confirm(t('conn.deleteConfirm', { name: target.name }))) return
        const done = await guard(t('busy.save'), () => action('delete', { id }))
        if (!done) return
        setForm(null)
        setActiveId('')
        setSchema(null)
        setTable('')
        setDetail(null)
        const next = await loadState()
        if (next?.connections[0]) setActiveId(next.connections[0].id)
      }, [connections, guard, loadState, t])

      const sortBy = useCallback(name => {
        const dir = page.order === name && page.dir === 'asc' ? 'desc' : 'asc'
        setPage(current => ({ ...current, order: name, dir, offset: 0 }))
        loadPage(activeId, table, { order: name, dir, offset: 0 })
      }, [activeId, loadPage, page.dir, page.order, table])

      // `page` is read by loadPage, so a change through the callback must not
      // depend on the previous render's copy; the guard below keeps the pager honest.
      const changePage = useCallback(overrides => {
        setPage(current => ({ ...current, ...overrides }))
        loadPage(activeId, table, overrides)
      }, [activeId, loadPage, table])

      const tabBtn = (id, label) => h('button', {
        key: id,
        type: 'button',
        onClick: () => setTab(id),
        style: {
          border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 12, padding: '8px 10px', color: tab === id ? color.text : color.muted,
          borderBottom: `2px solid ${tab === id ? color.brand : 'transparent'}`,
        },
      }, label)

      const sqliteMissing = boot && boot.sqlite && boot.sqlite.available === false

      return h('div', { style: S.root },
        h('div', { style: S.rail },
          h('div', { style: S.railHead },
            h('span', { style: S.railTitle }, t('conn.title')),
            h(Btn, { label: '+', title: t('conn.add'), onClick: () => setForm({ mode: 'create' }) })),
          h('div', { style: S.railBody },
            connections.map(item => h(ConnectionItem, {
              key: item.id,
              t,
              connection: item,
              active: item.id === activeId,
              onSelect: id => { setActiveId(id); setForm(null) },
              onEdit: target => setForm({ mode: 'edit', connection: target }),
            })),
            form ? h(ConnectionForm, {
              t,
              initial: form.connection || null,
              busy: busy === t('busy.save'),
              onSave: saveConnection,
              onCancel: () => setForm(null),
              onDelete: form.connection ? () => deleteConnection(form.connection.id) : null,
            }) : null,
            connections.length === 0 && !form
              ? h('div', { style: { ...S.hint, padding: 10 } }, t('conn.empty'))
              : null,
            connection && schema
              ? h('div', { style: { marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 6 } },
                h('div', { style: { ...S.railTitle, padding: '2px 8px' } }, t('objects.title')),
                h(ObjectTree, { t, objects: schema.objects, selected: table, onSelect: pickTable }))
              : null)),
        h('div', { style: S.main },
          h('div', { style: S.mainHead },
            h('div', { style: S.row },
              h('span', { style: { fontSize: 14, fontWeight: 600 } }, connection ? connection.name : t('panel')),
              connection ? h(Badge, {
                text: connection.readOnly ? t('conn.readonlyBadge') : t('conn.writeBadge'),
                tone: connection.readOnly ? 'ok' : 'warn',
              }) : null,
              h('span', { style: { flex: 1 } }),
              boot ? h('span', { style: S.hint }, `v${boot.version}`) : null),
            h('div', { style: { ...S.row, gap: 10 } },
              connection ? h('span', { style: { ...S.hint, ...S.mono, fontSize: 11 } }, connection.path) : null,
              connection && schema?.stats
                ? h('span', { style: S.hint }, t('stats.pages', {
                  pages: schema.stats.pageCount, size: schema.stats.pageSize,
                }))
                : null),
            connections.length === 0
              ? h('div', { style: S.hint }, t('state.toolHint'))
              : null),
          h(ErrorBar, { text: error, onDismiss: () => setError('') }),
          sqliteMissing
            ? h('div', { style: { ...S.pad, color: color.error } }, t('state.sqliteMissing'))
            : h(React.Fragment, null,
              h('div', { style: S.tabs },
                tabBtn('data', t('tabs.data')),
                tabBtn('structure', t('tabs.structure')),
                tabBtn('sql', t('tabs.sql')),
                tabBtn('history', t('tabs.history')),
                h('span', { style: { flex: 1 } }),
                busy ? h('span', { style: { ...S.hint, alignSelf: 'center', paddingRight: 6 } }, busy) : null),
              h('div', { style: S.body },
                tab === 'data'
                  ? h(DataPane, {
                    t,
                    connection,
                    table,
                    page,
                    busy: Boolean(busy),
                    onPage: changePage,
                    onSort: sortBy,
                    onSearch: value => {
                      setPage(current => ({ ...current, search: value, offset: 0 }))
                      loadPage(activeId, table, { search: value, offset: 0 })
                    },
                    onRefresh: () => loadPage(activeId, table, {}),
                    onExport: format => exportData(format, 'table'),
                  })
                  : null,
                tab === 'structure' ? h(StructurePane, { t, detail }) : null,
                tab === 'sql'
                  ? h(SqlPane, {
                    t,
                    connection,
                    sql,
                    setSql,
                    result,
                    plan,
                    busy: Boolean(busy),
                    onRun: runSql,
                    onExplain: explainSql,
                    allowWrite,
                    setAllowWrite,
                  })
                  : null,
                tab === 'history'
                  ? h(HistoryPane, {
                    t,
                    items: history,
                    onPick: text => { setSql(text); setTab('sql') },
                    onClear: async () => {
                      if (!window.confirm(t('history.clearConfirm'))) return
                      await guard('', () => action('clear_history', { id: activeId }))
                      loadHistory(activeId)
                    },
                  })
                  : null))))
    }

    // ---------------------------------------------------------- registration

    function Icon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true,
      },
      h('ellipse', { cx: 12, cy: 5.5, rx: 7.5, ry: 3 }),
      h('path', { d: 'M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6' }),
      h('path', { d: 'M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6' }))
    }

    const dicts = { zh: ZH, en: EN }

    function translator(raw) {
      let language = null
      const detect = () => {
        if (language) return language
        try {
          if (raw('panel') === EN.panel) language = 'en'
          else if (raw('panel') === ZH.panel) language = 'zh'
        } catch {
          /* fall back to zh */
        }
        return language || 'zh'
      }
      return (key, params) => {
        const dict = dicts[detect()] || ZH
        let text = dict[key]
        if (text === undefined) text = ZH[key]
        if (text === undefined) return key
        if (!params) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const disposeZh = ctx.locale.register(NS, 'zh', ZH)
        const disposeEn = ctx.locale.register(NS, 'en', EN)
        ctx.effect(() => () => { disposeZh(); disposeEn() }, 'dsh-db-studio: locale')
        const t = translator(ctx.locale.bind(NS))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 24,
          locale: NS,
          label: () => t('panel'),
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, DbStudioPanel))
      },
    }
  },
})
