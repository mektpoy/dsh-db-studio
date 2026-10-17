# DB Studio

DeepSeek Harness 的数据库管理插件。左侧一个侧边栏入口，主区域一个面板：保存连接、浏览表结构、跑 SQL、看执行计划、翻结果集。模型也能通过 `db` 工具查同一批连接，走同一套只读规则。

支持 SQLite 与 PostgreSQL。SQLite 用运行时自带的 `node:sqlite`，不需要任何依赖；PostgreSQL 需要 `pg`（安装本包时一并装上）。

## 它解决的问题

在对话里让模型查数据库，最难的不是写 SQL，是两件事：

1. **模型不知道自己面对的是哪个库、有哪些表。** 于是它猜表名、编字段，你得来回纠正。
2. **模型有可能改坏数据。** 一次 `DELETE` 没写 `WHERE` 就结束了。

DB Studio 对这两件事各给一个具体机制：把连接和表名直接放进模型每次看到的上下文；把「这条语句会不会改库」在执行前判定一次，只读连接直接拒绝。

## 功能

| 功能 | 说明 |
|---|---|
| 连接管理 | SQLite 文件路径，或 PostgreSQL 的 host / port / 数据库 / 用户 / 密码 / TLS。带名称、只读开关；密码存进 Harness 凭据库，不写进插件库。测试连接返回版本与库大小。 |
| 结构浏览 | 表与视图列表、行数、列类型、主键、非空、默认值、索引、外键、建表语句。SQLite 的行数超过 10 万显示为 10 万+；PostgreSQL 用 `pg_class.reltuples` 的估算值并标注为估算。 |
| 数据浏览 | 分页（25/50/100/200）、点表头排序、整表关键字搜索、CSV / JSON 导出。 |
| SQL 执行 | 多语句、Ctrl+Enter、耗时与行数回报、结果网格、错误原文回传。结果默认最多 200 行，被截断时在结果旁写明只返回前 N 行。 |
| 只读保护 | 连接级只读；语句级判定（`WITH ... DELETE` 也算写）；可写连接还需要显式勾选才执行改动语句。PostgreSQL 上再加一层 `default_transaction_read_only`，由服务器自己拒绝。 |
| 执行计划 | SQLite 用 `EXPLAIN QUERY PLAN`，PostgreSQL 用 `EXPLAIN (FORMAT TEXT)`，结果都进网格。 |
| 查询历史 | 最近 500 条语句，含成功/失败、耗时、行数、错误原文；点一条载入编辑器。 |
| 模型上下文 | 每次组装 prompt 时带上一段连接与表名摘要（1400 字符以内，60 秒内复用）。数据库连不上时写「打不开」，不写空表。 |
| `db` 工具 | 模型可直接调用：列连接、加/删连接、测试、读结构、翻页、跑 SQL、看计划、导出、查历史。 |

## 两种数据库各有什么不同

| 方面 | SQLite | PostgreSQL |
|---|---|---|
| 地址 | 文件路径 | host / port / 数据库 / 用户 / TLS |
| 对象名 | `表名` | `schema.table`；`public` 省略，其他 schema 必须写 |
| 行数 | 精确计数，最多扫 10 万行 | 目录里的估算值；`schema` 里会标 `rowsEstimated` |
| 建表语句 | `sqlite_master` 里存的原文 | 没有原文，按列、主键、外键、索引重建，标注为重建结果 |
| 只读 | 以 `readOnly` 打开文件，同时拒绝写语句 | 拒绝写语句，并设置 `default_transaction_read_only` |
| 超时 | 无（本地文件，查询很快） | `statement_timeout` 30 秒，连接超时 8 秒 |

## 安装

在 DSH 里用插件管理器安装本地目录：

```
plugin_manager
  action: install_bundle
  target: <本仓库的绝对路径>
```

`install_bundle` 会执行 `pnpm install`，把 `pg` 一起装进 profile。安装后侧边栏会出现「数据库」入口。插件主机半的改动需要重启 Host；浏览器半的改动需要重启后刷新页面（打包后的 bundle 按内容哈希缓存）。

## 面板怎么用

- 左栏顶部是连接列表，`+` 新增。类型选 SQLite 或 PostgreSQL，填对应字段。密码框留空表示沿用已保存的密码。
- 点连接会读取结构，下面出现表与视图。
- 点一张表进入「数据」，可以直接搜索、排序、翻页、导出。
- 「结构」显示列、索引、外键和建表语句。
- 「SQL」是编辑器。可写连接上有一个「允许改动语句」勾选框，不勾就只跑读语句。
- 「历史」是这条连接最近的执行记录。

## 模型怎么用

工具名是 `db`，一个 `action` 参数决定操作：

| action | 用途 | 主要参数 |
|---|---|---|
| `connections` | 列出保存的连接 | — |
| `add_connection` | 保存一个连接 | `driver`、`path` 或 `host` / `port` / `database` / `username` / `password` / `ssl`、`name`、`readOnly` |
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

## 密码怎么存

密码不进 `studio.db`。`Studio` 把它交给 Harness 的凭据服务，引用名是 `DB_STUDIO_PASSWORD_<连接 id 大写去横线>`，落盘在 `~/.dsh/.credentials.yaml`；每次操作前重新解析，改了密码下一次操作就生效，不需要重启。

Harness 没有凭据服务时，保存 PostgreSQL 连接会失败并说明原因——不会退回到把密码写进插件库。

## 配置

插件行配置就两项：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH home>/dsh-db-studio` | 连接表与查询历史的存放目录（`studio.db`） |
| `allowWriteByDefault` | `false` | 新增连接默认是否可写。默认只读，写入要你在面板里显式打开。 |

## 加一种数据库要改什么

驱动契约是 `lib/studio.js::openDriver` 选中的那个类，方法都是异步的：

```
open / close / test / objects / describe / preview / run / explain / stats
```

`lib/sqlite-driver.js` 与 `lib/postgres-driver.js` 是两个实现。加 MySQL 之类就是再加一个文件，并在 `openDriver` 里认一个 driver 名；面板的字段与 `db` 工具的 `driver` 枚举各加一项。

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

SQLite、语句判定、连接存储、历史与工具层不需要外部服务。PostgreSQL 用例在给了服务器时才跑：

```
DB_STUDIO_TEST_PG_HOST=... DB_STUDIO_TEST_PG_PORT=5432 \
DB_STUDIO_TEST_PG_DATABASE=... DB_STUDIO_TEST_PG_USER=... \
DB_STUDIO_TEST_PG_PASSWORD=... node --test 'test/postgres.test.mjs'
```

这些用例只读：它们从服务器上找一张已有的表来验证结构、分页和执行计划，唯一的写用例检查的是「写被拒绝」，不会真的改数据。

## English

DB Studio is a database management plugin for DeepSeek Harness. It adds a sidebar panel with saved connections, an object tree, a paged data grid, a schema view, a SQL runner, query plans and query history — and a `db` tool the model can call under the same rules.

It speaks SQLite through the runtime's built-in `node:sqlite` (no dependency) and PostgreSQL through `pg`.

Two mechanisms carry most of the value:

- **The model is told what the database contains.** Every prompt assembly carries a bounded digest of saved connections and their table names, so the model stops guessing table names. The digest refreshes in the background, so a slow server never delays a prompt.
- **Writes have a boundary.** Read-only is per connection, statement classification runs before execution, an unrecognised verb counts as a write, and a writable connection still needs an explicit `allowWrite` per call. PostgreSQL read-only connections also set `default_transaction_read_only`, so the server refuses even if a rule is missed. Multi-statement writes run in one transaction.

Passwords go to the Harness credential store, never to the plugin database.

Install with `plugin_manager action=install_bundle target=<absolute path to this repository>`, then run `node --test 'test/*.test.mjs'` to check it.

MIT licensed.

## 许可

MIT。
