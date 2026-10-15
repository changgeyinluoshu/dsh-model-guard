# dsh-model-guard · 模型调用守卫

**一句话**：禁止 DSH 自动调用某个 API（provider 渠道）或某个模型——命中即拦截、改道或告警。

适用场景：

- 不想让后台的**上下文压缩**、**会话标题生成**偷偷消耗某个渠道的额度；
- 某个模型不稳定/太贵，想彻底禁止它被任何流程调用；
- 想把所有自动调用统一改道到一个便宜的小模型；
- 只想观察（不阻断）：先看看到底是谁在调用什么。

---

## 1. 它拦得住什么

DSH 里**每一次**模型调用都会经过 `llm/stream` 这个 waterfall 事件，
本插件就挂在那个位置，因此以下全部调用都会被判定：

| 调用来源 | 是否经过拦截 | 说明 |
| --- | --- | --- |
| 主对话（agent loop） | ✅ | 用户发起的每一轮 |
| 子 agent（subagent） | ✅ | 包括 Agent Teams 成员 |
| 上下文压缩（compaction） | ✅ | `purpose: 'compaction'` |
| 会话标题生成（session-title） | ✅ | `purpose: 'session-title'` |
| 其它插件的手工调用 | ✅ | 只要走 `ctx.llm.stream()` |
| 直接发 HTTP 到 provider | ❌ | 绕过 `ctx.llm` 的自建请求不在管辖内 |

### 「自动调用」是怎么判定的

DSH 在请求里用 `purpose` 字段标记了后台辅助调用：

- `purpose: 'compaction'` → 上下文压缩
- `purpose: 'session-title'` → 会话标题生成
- `purpose` 缺省 → **用户主动发起**的调用（主对话、子 agent 等）

所以 `scope: auto` 的精确含义是：**只拦带 purpose 的后台调用，用户自己选这个模型时照常可用**。
这正是「禁止自动调用某个模型」最常用的形态。

---

## 2. 拦截点原理（给想改代码的人）

`llm/stream` 是 cordis 的 **waterfall** 事件（`@deepseek-ai/dsh-llm` 内
`ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`）：

- 监听器签名是 `(options, next)`，**必须同步返回 `AsyncIterable<StreamChunk>`**（不能是 async 函数）；
- 调用 `next()` 放行到下游适配器，**不调用 `next()` 即否决**；
- `@deepseek-ai/dsh-llm` 自己有一个 `prepend: true` 的流语法校验器在最外层，
  所以任何自定义分片都必须符合 `StreamChunk` 协议。

本插件的三种动作对应：

| 动作 | 实现 | 结果 |
| --- | --- | --- |
| `block` | 不调用 `next()`，直接产出一条终止 `finish` 分片 | 调用失败，失败码 `POLICY_BLOCKED`，**不会发出任何网络请求** |
| `redirect` | 用 `ctx.llm.stream({...options, provider, model})` 改道并转发分片 | 调用成功，但换到了别的渠道/模型 |
| `warn` | 记录日志后调用 `next()` | 完全不影响调用 |

> 注：waterfall 回调拿到的 `next` 不接受参数，请求对象（agent loop 构建的）是
> 深度冻结的、按设计不许改写。所以「改道」是**发一次新请求**而不是修改原请求；
> 插件用一个 `WeakSet` 标记已改道的请求，彻底杜绝递归。

失败码 `POLICY_BLOCKED` 刻意不在 `dsh-llm-retry` 的默认可重试集合
（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）内，
因此被拦的调用不会被反复重试 5 次。

---

## 3. 安装

插件是一个标准的 DSH bundle 包（Host 半身，无客户端半身）。

### 方式 A：一键脚本（推荐）

```powershell
# 最常用：禁止后台自动调用走 nvida 渠道，用户手动选用时仍然可用
.\install.cmd -BlockedProviders nvida -Scope auto

# 彻底禁止某个模型被任何流程调用
.\install.cmd -Scope all -BlockedModels 'deepseek-ai/deepseek-v4.1-flash'

# 先只观察不阻断
.\install.cmd -Mode warn -BlockedProviders '*'
```

脚本只做两件事，全部可一键回滚：

1. 在 `<profile>\node_modules` 下建立指向本仓库的目录联接（Junction）；
2. 在 `<profile>\cordis.patch.yml` 末尾追加一个带标记的 managed block。

写文件前自动备份；重复执行会替换 managed block 而不是叠加；
`.cmd` 包装器已绕过 PowerShell 执行策略（否则会报「未对文件进行数字签名」）。

回滚：

```powershell
.\uninstall.cmd
```

两者都支持 `-ProfilePath`（默认 `%USERPROFILE%\.dsh-beta\profiles\desktop`）
和 `-Force`。完整的参数说明在 `install.ps1` 头部注释里。

### 方式 B：手工安装

```powershell
$profile = "$env:USERPROFILE\.dsh-beta\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-model-guard" -Target "<本仓库绝对路径>"
```

再往 `$profile\cordis.patch.yml` 顶层追加：

```yaml
- insert:
    - id: model-guard
      name: 'dsh-model-guard'
      config:
        enabled: true
        scope: auto
        blockedProviders: [nvida]
```

也可以用 DSH 自带命令登记：`dsh plugin --profile desktop add link:<本仓库绝对路径>`。

> **无论哪种方式，都必须重启 DSH 桌面端才会加载。**

---

## 4. 设置界面（图形化禁用模型）

插件自带浏览器半身，在 **设置 → 插件 → 模型调用守卫** 里提供可视化选择器，不用手写 YAML：

```
模型调用守卫
在 DSH 每一次模型调用的必经之路上做名单判定……

  启用守卫                                    [✓]
  ────────────────────────────────────────────────
  命中后的动作
  [ 拦截        ] [ 改道        ] [ 仅告警      ]
  [ 直接失败，不 ] [ 换到备用模型 ] [ 只写日志    ]
  [ 发网络请求   ] [             ] [            ]

  作用域
  [ 仅自动调用 ✓ ] [ 所有调用    ]
  [ 后台压缩、会话 ] [ 含你手动发起 ]
  [ 标题生成       ] [ 的对话       ]

  禁止清单                          已选 2 项   [重新读取]
  ┌──────────────────────────────────────────────┐
  │ [ ] nvida                          3 个模型  │
  │     [x] DeepSeek V4.1 Flash                  │
  │     [ ] Llama 3.2 90B                        │
  │ [x] deepseek-official              1 个模型  │
  │     [ ] deepseek-v4-flash                    │
  └──────────────────────────────────────────────┘

  [保存]  [放弃改动]        已保存并生效
```

界面行为：

| 操作 | 效果 |
| --- | --- |
| 勾选**渠道名** | 该渠道整个拉黑 → 写入 `blockedProviders` |
| 勾选**具体模型** | 只拉黑这一个模型 → 写入 `blockedModels` |
| 渠道已整体勾选时 | 其下模型显示为已禁并锁定，避免留下「看不见但仍生效」的规则 |
| 保存 | 经 DSH 的 settings 服务写回 profile 的 Cordis patch，**改完即生效**（无需重启） |
| 重新读取 | 重新向 host 请求当前可路由的 provider / 模型目录 |

模型清单来自 `ctx.remote.session.modelCatalog()`，也就是界面上模型选择器用的同一份实时目录，
所以这里列出的就是**真正能被调用的**模型。

> 界面上只能配置 `enabled` / `mode` / `scope` / `blockedProviders` / `blockedModels` 五项。
> `rules`、`fallback`、`allowed*` 这些进阶字段仍写在 `cordis.patch.yml` 里——两边可以共存，
> 界面上没动的字段不会被覆盖。

---

## 5. 配置速查

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。装好但想先不生效就设 `false` |
| `mode` | `block` | 命中后的默认动作：`block` / `redirect` / `warn` |
| `scope` | `all` | `all`=拦一切；`auto`=只拦自动调用（带 purpose） |
| `blockedProviders` | `[]` | 禁止的 API 渠道，支持 `*` 通配 |
| `blockedModels` | `[]` | 禁止的模型 id，支持 `*` 通配 |
| `blockedPurposes` | `[]` | 禁止的用途，如 `compaction`、`session-title` |
| `allowedProviders` | `[]` | 白名单，**优先级高于黑名单** |
| `allowedModels` | `[]` | 白名单，**优先级高于黑名单** |
| `autoPurposes` | `[compaction, session-title]` | 哪些 purpose 算「自动调用」 |
| `fallback` | 空 | `redirect` 的默认改道目标 |
| `rules` | `[]` | 精确规则表（见下），可与上面简洁字段共存 |
| `log` | `true` | 是否输出 `[model-guard]` 日志 |
| `blockMessage` | 内置中文 | 自定义拦截提示语 |

### 进阶字段（v1.1 新增）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `policy` | `blocklist` | 名单策略。`allowlist` = **只放行名单内的，其余全拦** |
| `scopes` | `[]` | **按 Agent 预设 / 会话**独立起的规则，命中的第一条整体接管该次调用 |
| `softRules` | `[]` | **权重软调度**：命中后按 `weight` 抽一条路线（allow / redirect / block） |
| `breaker` | 关闭 | **API 熔断**：服务商连续报错后临时拦截，冷却到点自动恢复 |
| `audit` | 开启 | **拦截审计**：内存环形缓冲 + 会话日志 + 可选 JSONL 文件 |
| `conflictCheck` | `true` | 检测是否有职责重叠的守卫类插件同时挂在 `llm/stream` 上 |

**白名单模式**——只允许少数模型可用：

```yaml
policy: allowlist
allowedModels:
  - 'deepseek-ai/deepseek-v4.1-flash'
  - 'deepseek-ai/deepseek-v4.1'
```

**按 Agent 预设 / 会话分流**——命中的第一条作用域整体接管，未命中才用全局配置：

```yaml
scopes:
  - match: { preset: ptc }              # 该预设下一律白名单
    policy: allowlist
    allowedModels: ['deepseek-ai/*']
  - match: { session: 'auto-*' }        # 自动化任务会话整段收紧
    blockedModels: ['*']
    mode: warn
```

预设名取自会话头的 `agentPreset`，会话匹配 `sessionId`，两者都支持 `*` 通配。

**权重软调度**——不是硬拦，而是按比例分流：

```yaml
softRules:
  - match: { model: 'expensive-*' }
    routes:
      - { action: allow, weight: 70 }
      - { action: redirect, provider: nvida, model: 'cheap-model', weight: 20 }
      - { action: block, weight: 10 }
```

**API 熔断**——服务商连续报错时自动止损：

```yaml
breaker:
  enabled: true
  failureThreshold: 3       # 连续 3 次失败后开路
  cooldownMs: 60000         # 暂停 60 秒，到点自动恢复（无需重启）
  codes: [SERVER, TRANSPORT, TIMEOUT, RATE_LIMIT]
```

熔断期间该 provider 的调用直接以 `PROVIDER_CIRCUIT_OPEN` 失败，其它 provider 不受影响；
成功一次即清零计数。判定基于时间戳，因此**不需要任何定时器**。

**拦截审计**——排查自动化任务时看这里：

```yaml
audit:
  enabled: true
  toSession: true           # 写进会话日志，在 DSH 会话里直接可见
  file: ''                  # 可选：同时追加 JSONL
  maxEntries: 200
```

每条记录包含 `action / provider / model / purpose / preset / rule / 时间`，
写入会话日志的事件类型是 `model-guard/blocked`。

**配置热重载**——改完即生效，不用重启 DSH：

配置以「惰性取值器」形式保留，每次模型调用时实时解包，所以设置界面点保存、
或直接改 `cordis.patch.yml`，**下一次调用立刻按新规则走**。
只有新增/删除插件本身才需要重启。

### 匹配语法

- `*` 匹配任意字符，`?` 匹配单个字符，**大小写不敏感**；
- 简洁字段（`blockedProviders` 等）里的多个值是 **或**；
- `rules` 里一条规则的多个条件是 **与**，同一条件的多个值是 **或**。

### rules 单条规则的字段

| 字段 | 说明 |
| --- | --- |
| `provider` / `model` / `purpose` | 匹配条件（字符串或字符串数组），至少写一个 |
| `scope` | 覆盖顶层 scope |
| `action` | 覆盖顶层 mode |
| `fallback` | 覆盖顶层 fallback（`{provider, model}`） |
| `allowPurposeless` | `true` 时只匹配**没有 purpose**（用户主动发起）的调用 |
| `note` | 备注，会打印在启动日志里 |

---

## 6. 四个典型场景

### 场景 1：不让后台自动调用消耗 NVIDIA 渠道（用户手动选用时仍可用）

```yaml
- id: model-guard
  name: 'dsh-model-guard'
  config:
    enabled: true
    scope: auto          # 只拦自动调用
    blockedProviders: [nvida]
```

效果：上下文压缩、会话标题生成不再走 `nvida`；你在界面里手动选 `nvida` 的模型时照常可用。

### 场景 2：彻底禁止某个模型被任何流程调用

```yaml
- id: model-guard
  name: 'dsh-model-guard'
  config:
    enabled: true
    scope: all
    blockedModels:
      - 'deepseek-ai/deepseek-v4.1-flash'
      - 'meta/*'         # 整族都禁
```

### 场景 3：所有自动调用统一改道到便宜的小模型

```yaml
- id: model-guard
  name: 'dsh-model-guard'
  config:
    enabled: true
    scope: auto
    mode: redirect
    rules:
      - provider: '*'
        scope: auto
        action: redirect
        fallback:
          provider: nvida
          model: deepseek-ai/deepseek-v4.1-flash
```

> 注意：`fallback` 必须是一个**真实可用**的 provider/model，否则改道后的调用会以
> `NO_ADAPTER` 之类的失败码结束。插件已防止改道目标再次命中同一条规则造成死循环。

### 场景 4：先只观察，不阻断

```yaml
- id: model-guard
  name: 'dsh-model-guard'
  config:
    enabled: true
    mode: warn
    scope: all
    blockedProviders: ['*']
    allowedProviders: []   # 全放行，只在日志里打印谁调了什么
```

---

## 7. 怎么确认生效

启动 DSH 后，宿主进程日志里会出现：

```
[model-guard] 已启用：mode=block scope=auto，共 1 条规则
[model-guard] 规则清单：
  - [block/auto] provider=nvida
[model-guard] 已拦截 provider=nvida model=deepseek-ai/deepseek-v4.1-flash purpose=session-title rule=config.blockedProviders
```

插件卸载（DSH 退出或热重载）时会打印本次统计：

```
[model-guard] 已卸载。本次运行统计：
总调用 42：放行 40 / 拦截 2 / 改道 0 / 告警 0
  nvida/deepseek-ai/deepseek-v4.1-flash#session-title x2
```

被拦的调用在界面上会表现为一次失败的模型请求，错误信息里带
`POLICY_BLOCKED` 与命中的规则名，便于定位是哪条配置生效了。

---

## 8. 配置写错了会怎样

不会让 DSH 起不来。插件刻意把 schemastery 配置表写成宽容类型，
所有校验与兜底都在 `lib/matcher.js` 的 `normalizeConfig()` 里做：

- 非法 `mode` / `scope` → 回退为默认值并打印「配置提醒」；
- 没有匹配条件的规则 → 丢弃并提醒；
- 没有任何规则 → 提醒「插件已加载但不会拦截任何调用」；
- `blockedModels` 写成单个字符串（而不是数组）也能识别。

---

## 9. 已知边界

- **不拦截绕过 `ctx.llm` 的请求**：例如某个插件自己发 `fetch` 到 provider；
- **不改写请求内容**：agent loop 的请求是深度冻结的，插件只读；
- **不管理界面上的模型列表**：把某模型从下拉框里移除不在职责内，
  插件只在调用发生的那一刻做判定；
- **改道不等于省钱**：改道后仍会真实发起一次请求。

---

## 10. 开发

```powershell
node scripts/run-tests.mjs      # 48 项单元 / 集成 / 客户端测试
node scripts/verify-load.mjs    # 27 项宿主加载与客户端 bundle 验证
```

不用 `node --test test/`：那个形式会为每个测试文件 spawn 子进程，
在受限运行环境（含 DSH 自身的 pwsh 沙箱）会以 `EPERM` 失败。
本仓库的 runner 在当前进程内加载测试文件。

测试分五层（共 48 项）：

| 文件 | 覆盖内容 |
| --- | --- |
| `test/matcher.test.js` | 通配匹配、**volatile 取值器解包**、配置归一化与容错、决策矩阵（18 项） |
| `test/guard.test.js` | 用**真实 cordis** 的 waterfall 语义验证拦截/透传/改道/递归防护/协议合规（13 项） |
| `test/integration.test.js` | 挂上 **DSH 官方 `dsh-llm` 流语法校验器**，验证自定义分片合法、冻结请求可拦、卸载可恢复（6 项） |
| `test/client.test.js` | **设置界面**：bundle 注册契约、slot 注册、勾选↔配置互转、保存写入、目录外通配规则可见（11 项） |
| `scripts/verify-load.mjs` | 按包名解析入口、schemastery 行为、真实上下文 apply 演练、**客户端 bundle 可加载性**、volatile 回归（27 项） |

`verify-load.mjs` 用 `scripts/hooks.mjs` 这个解析钩子把 `@deepseek-ai/*`
映射到 DSH 应用自带的 node_modules，因此无需安装任何依赖即可复现宿主环境；
DSH 不在默认位置时用环境变量 `DSH_APP_ROOT` 指定。

源码结构：

| 文件 | 职责 |
| --- | --- |
| `lib/matcher.js` | 纯逻辑：glob 匹配、配置归一化、决策 |
| `lib/guard.js` | `llm/stream` 监听器与装配（不依赖 schemastery，可独立测试） |
| `lib/index.js` | 插件入口：元信息 + schemastery 配置表（可 `.volatile()` 字段供设置界面编辑） |
| `lib/client.js` | 浏览器半身：设置界面里的禁用模型选择器（React + DSH 主题变量） |
| `icon.svg` | 插件图标（市场 / 仓库展示用） |
| `install.ps1` / `install.cmd` | 安装：目录联接 + managed block，带备份与 YAML 校验 |
| `uninstall.ps1` / `uninstall.cmd` | 卸载：精确移除上面两项，其余配置不动 |
