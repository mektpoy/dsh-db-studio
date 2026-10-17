# DB Studio

DeepSeek Harness 的数据库管理插件。左侧一个侧边栏入口，主区域一个面板：保存连接、浏览表结构、跑 SQL、看执行计划、翻结果集。模型也能通过 `db` 工具查同一批连接，走同一套只读规则。

零依赖：只用一个运行时自带的 `node:sqlite`，不安装任何 npm 包。

![traits](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-brightgreen) ![dsh](https://img.shields.io/badge/DSH-plugin-blue)

## 它解决的问题

在对话里让模型查数据库，最难的不是写 SQL，是两件事：

1. **模型不知道自己面对的是哪个库、有哪些表。** 于是它猜表名、编字段，你得来回纠正。
2. **模型有可能改坏数据。** 一次 `DELETE` 没写 `WHERE` 就结束了。

DB Studio 对这两件事各给一个具体机制：把连接和表名直接放进模型每次看到的上下文；把「这条语句会不会改库」在执行前判定一次，只读连接直接拒绝。

## 功能

| 功能 | 说明 |
|---|---|
| 连接管理 | 保存多个 SQLite 文件路径，带名称、备注、只读开关。测试连接会返回 SQLite 版本与文件大小。 |
| 结构浏览 | 表与视图列表、行数（超过 10 万行显示为 10 万+，不扫全表）、列类型、主键、非空、默认值、索引、外键、建表语句。 |
| 数据浏览 | 分页（25/50/100/200）、点表头排序、整表关键字搜索、CSV / JSON 导出。 |
| SQL 执行 | 多语句、Ctrl+Enter、耗时与行数回报、结果网格、错误原文回传。结果默认最多 200 行，被截断时在结果旁写明只返回前 N 行。 |
| 只读保护 | 连接级只读；语句级判定（`WITH ... DELETE` 也算写）；可写连接还需要显式勾选才执行改动语句。 |
| 执行计划 | `EXPLAIN QUERY PLAN` 的结果直接进网格。 |
| 查询历史 | 最近 500 条语句，含成功/失败、耗时、行数、错误原文；点一条载入编辑器。 |
| 模型上下文 | 每次组装 prompt 时带上一段连接与表名摘要（1400 字符以内，60 秒内复用）。 |
| `db` 工具 | 模型可直接调用：列连接、加/删连接、测试、读结构、翻页、跑 SQL、看计划、导出、查历史。 |

## 安装

在 DSH 里用插件管理器安装本地目录：

```
plugin_manager
  action: install_bundle
  target: <本仓库的绝对路径>
```

安装后侧边栏会出现「数据库」入口。插件主机半的改动需要重启 Host；浏览器半的改动需要刷新页面（打包后的 bundle 按内容哈希缓存）。

## 面板怎么用

- 左栏顶部是连接列表，`+` 新增。点连接会读取结构，下面出现表与视图。
- 点一张表进入「数据」，可以直接搜索、排序、翻页、导出。
- 「结构」显示列、索引、外键和建表语句。
- 「SQL」是编辑器。可写连接上有一个「允许改动语句」勾选框，不勾就只跑读语句。
- 「历史」是这条连接最近的执行记录。

## 模型怎么用

工具名是 `db`，一个 `action` 参数决定操作：

| action | 用途 | 主要参数 |
|---|---|---|
| `connections` | 列出保存的连接 | — |
| `add_connection` | 保存一个 SQLite 文件 | `path`、`name`、`readOnly` |
| `remove_connection` | 删除一条连接记录 | `connection` |
| `test` | 打开并回报版本、大小 | `connection` |
| `schema` | 列全部对象，或一张表的完整结构 | `connection`、`table`（可选） |
| `preview` | 翻一页表数据 | `table`、`limit`、`offset`、`order`、`dir` |
| `query` | 执行 SQL | `sql`、`limit`、`allowWrite` |
| `explain` | 执行计划 | `sql` |
| `export` | 导出 CSV / JSON 文本 | `sql` 或 `table`、`format` |
| `history` | 最近的执行记录 | `connection`、`limit` |

`connection` 可以写 id，也可以写名称；只保存了一个连接时可以省略。

## 只读与写操作的确切规则

判定发生在执行之前，规则只有一处（`lib/sql.js::classifyStatement`）：

1. 按分号切语句，字符串字面量和注释里的分号不算分隔符。
2. 每条语句只取主语句的动词：`EXPLAIN` 视为读；`PRAGMA` 含 `=` 视为写；`WITH` 取括号外第一个数据动词，所以 `WITH x AS (SELECT 1) DELETE FROM t` 是写。
3. `SELECT` / `EXPLAIN` / 无赋值的 `PRAGMA` 是读；`INSERT` / `UPDATE` / `DELETE` / `REPLACE` / DDL / 事务控制 / `ATTACH` 是写；**认不出的动词一律按写处理**。
4. 只读连接遇到写语句直接拒绝，并说明是第几条语句。
5. 可写连接上，写语句还要 `allowWrite: true`（面板里就是那个勾选框）。
6. 多条写语句在一个事务里执行，任意一条失败整批回滚。

## 配置

插件行配置就两项：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH home>/dsh-db-studio` | 连接表与查询历史的存放目录（`studio.db`） |
| `allowWriteByDefault` | `false` | 新增连接默认是否可写。默认只读，写入要你在面板里显式打开。 |

## 为什么这一版只支持 SQLite

`node:sqlite` 是 Node 22 起内置的模块，宿主进程直接能用，因此整个插件没有任何 npm 依赖，装完就能跑。Postgres / MySQL 需要各自的驱动和认证协议，会把「零依赖」这条优势换掉，所以这一版没做。

驱动接口留在 `lib/sqlite-driver.js`（`open` / `objects` / `describe` / `preview` / `run` / `explain` / `stats`），加一种数据库就是加一个实现同一个接口的文件。

## 明确不做的

调研了 DBeaver、DataGrip、TablePlus、Navicat、Beekeeper Studio、pgAdmin、HeidiSQL、Adminer、Letos（原 SQLiteStudio）等产品之后，这几项对「让模型看懂库 + 让执行有边界」几乎没有帮助，但成本最高，所以不放进路线：

- ER 图：要图的话把建表语句导出去，交给 ChartDB 或 drawDB。
- 结构与数据 diff：类型映射、列顺序、默认值表达差异，代价远高于收益。
- 用户与权限管理：改错权限的后果比省下的操作重。
- 图表分享与协作：需要账号体系和存储。

行内编辑数据也不做：主键变更、类型转换、并发冲突三件事都要处理，而执行 SQL 已经能改。

## 开发

```
node --test 'test/*.test.mjs'
```

用例覆盖语句切分与读写判定、驱动行为（分页、排序、搜索、只读拒绝、事务回滚、执行计划）、连接存储与历史。

## English

DB Studio is a database management plugin for DeepSeek Harness. It adds a sidebar panel with saved connections, an object tree, a paged data grid, a schema view, a SQL runner, query plans and query history — and a `db` tool the model can call under the same rules.

Two mechanisms carry most of the value:

- **The model is told what the database contains.** Every prompt assembly carries a bounded digest of saved connections and their table names, so the model stops guessing table names.
- **Writes have a boundary.** Read-only is per connection, statement classification runs before execution, an unrecognised verb counts as a write, and a writable connection still needs an explicit `allowWrite` per call. Multi-statement writes run in one transaction.

This version speaks SQLite only, through the runtime's built-in `node:sqlite`, so it has no npm dependencies. The driver interface in `lib/sqlite-driver.js` is what another database would implement.

Install with `plugin_manager action=install_bundle target=<absolute path to this repository>`, then run `node --test 'test/*.test.mjs'` to check it.

MIT licensed.

## 许可

MIT。
