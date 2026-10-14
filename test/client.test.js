/**
 * 客户端半身测试
 *
 * 客户端跑在浏览器里，离线的 Node 环境没有 react-dom，所以这里用「可记录调用的
 * 极简 React」驱动组件：hooks 直接返回快照，createElement 产出普通对象树。
 * 这样能真实覆盖的风险是：
 *   - factory 能否被 __ModuleLoader__ 正常执行、导出 apply/inject
 *   - apply 是否按 DSH 的 slots 契约注册了 settings.section
 *   - 组件函数能否无异常执行、产出的树里勾选项数量是否正确
 *   - 勾选 / 切换动作 / 保存 是否写对了配置字段
 * 渲染像素与 React 真实调度不在本测试范围内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* ---------------- 极简 React ---------------- */
function makeReact() {
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat(Infinity).filter(function (c) {
        return c !== null && c !== undefined && c !== false && c !== true
      })
      return { type: type, props: Object.assign({}, props, { children: children }) }
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useId() { return ':r0:' },
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}] },
    useEffect() {},
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
  }
}

/* ---------------- 元素树工具 ---------------- */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  const children = node.props && node.props.children
  const hasChildren = children !== undefined
  visit(node)
  if (hasChildren) walk(children, visit)
}
function findAll(tree, predicate) {
  const out = []
  walk(tree, function (node) { if (predicate(node)) out.push(node) })
  return out
}
const isCheckbox = (n) => n.type === 'input' && n.props && n.props.type === 'checkbox'
const isButton = (n) => n.type === 'button'
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.props && node.props.children) return textOf(node.props.children)
  return ''
}

/* ---------------- 假 ctx ---------------- */
function makeScope(initial) {
  const listeners = new Set()
  const state = { value: Object.assign({}, initial), revision: 1 }
  return {
    writes: [],
    getSnapshot() { return { value: state.value, revision: state.revision } },
    subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } },
    async mutate(ops) {
      this.writes.push(ops)
      for (const op of ops) {
        if (op.op === 'set') state.value[op.path[0]] = op.value
      }
      state.revision += 1
      for (const fn of Array.from(listeners)) fn()
    },
    _set(next) { state.value = Object.assign({}, state.value, next); state.revision += 1; for (const fn of Array.from(listeners)) fn() },
  }
}

function makeCtx(options) {
  const opts = options || {}
  const scope = opts.scope || makeScope({ enabled: true, mode: 'block', scope: 'auto', blockedProviders: [], blockedModels: [] })
  const registered = []
  const effects = []
  let injectedName = null
  const ctx = {
    configForms: { get(name) { ctx._ns = name; return opts.noScope ? undefined : scope } },
    remote: {
      session: {
        modelCatalog() {
          if (opts.catalogError) return Promise.reject(new Error(opts.catalogError))
          return Promise.resolve({ value: { groups: opts.groups || [] } })
        },
      },
    },
    slots: {
      inject(name, callback) { injectedName = name; callback() },
      register(definition, Component) { registered.push({ definition: definition, Component: Component }) },
    },
    effect(fn, label) { effects.push({ label: label, dispose: fn() }) },
  }
  return { ctx: ctx, scope: scope, registered: registered, effects: effects, injectedName: () => injectedName }
}

const GROUPS = [
  { id: 'nvida', models: [{ id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'meta/llama-3.2-90b', name: 'Llama 3.2 90B' }] },
  { id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash' }] },
]

/* ---------------- 载入客户端 bundle ---------------- */
let captured = null
globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition } } }
await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href)

test('客户端 bundle 通过 __ModuleLoader__ 注册，id 与包名一致', () => {
  assert.ok(captured, '应捕获到 load() 调用')
  assert.equal(captured.id, 'dsh-model-guard')
  assert.equal(typeof captured.factory, 'function')
})

test('factory 导出 apply/inject，且注入声明覆盖所需服务', () => {
  const mod = captured.factory((name) => {
    if (name === 'react') return makeReact()
    throw new Error('意外的模块请求: ' + name)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  for (const name of ['slots', 'configForms', 'remote', 'remote.session']) {
    assert.ok(mod.inject.includes(name), '缺少注入：' + name)
  }
})

test('apply 按 DSH 契约注册 settings.section', () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS })
  mod.apply(host.ctx)

  assert.equal(host.injectedName(), 'settings.section')
  assert.equal(host.registered.length, 1)
  const def = host.registered[0].definition
  assert.equal(def.name, 'settings.section')
  assert.equal(def.id, 'model-guard')
  assert.equal(typeof def.label, 'function')
  assert.equal(def.label(), '模型调用守卫')
  assert.ok(typeof def.order === 'number')
  assert.equal(typeof def.inject, 'function')
  assert.equal(typeof host.registered[0].Component, 'function')
  assert.equal(host.ctx._ns, 'model-guard', 'configForms 命名空间应为插件条目 id')
})

test('组件能渲染出渠道与模型勾选项', async () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS })
  mod.apply(host.ctx)
  const props = host.registered[0].definition.inject()
  await new Promise((r) => setTimeout(r, 10))
  const tree = host.registered[0].Component(props)

  const checkboxes = findAll(tree, isCheckbox)
  // 1 个总开关 + 2 个渠道 + 3 个模型 = 6
  assert.equal(checkboxes.length, 6)

  const buttons = findAll(tree, isButton)
  const labels = buttons.map((b) => textOf(b))
  assert.ok(labels.some((l) => l.includes('拦截')))
  assert.ok(labels.some((l) => l.includes('仅自动调用')))
  assert.ok(labels.some((l) => l.includes('保存')))

  const text = textOf(tree)
  assert.ok(text.includes('模型调用守卫'))
  assert.ok(text.includes('nvida'), '应显示渠道名')
  assert.ok(text.includes('DeepSeek V4.1 Flash'), '应显示模型名')
})

test('勾选渠道后保存，写入 blockedProviders', async () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))
  const def = host.registered[0].definition

  let tree = host.registered[0].Component(def.inject())
  const rows = findAll(tree, (n) => n.props && n.props['data-mg-row'] === 'provider')
  assert.equal(rows.length, 2, '应有 2 个渠道行')
  const providerInput = findAll(tree, (n) => n.props && n.props['data-mg'] === 'provider' && n.props['data-mg-id'] === 'nvida')[0]
  assert.ok(providerInput, '应找到 nvida 渠道复选框')
  providerInput.props.onChange({ target: { checked: true } })

  tree = host.registered[0].Component(def.inject())
  const saveButton = findAll(tree, (n) => n.props && n.props['data-mg-action'] === 'save')[0]
  await saveButton.props.onClick()

  assert.equal(host.scope.writes.length, 1)
  const ops = host.scope.writes[0]
  const byPath = {}
  for (const op of ops) byPath[op.path[0]] = op.value
  assert.deepEqual(byPath.blockedProviders, ['nvida'])
  assert.deepEqual(byPath.blockedModels, [])
  assert.equal(byPath.mode, 'block')
  assert.equal(byPath.scope, 'auto')
})

test('勾选具体模型后保存，写入 blockedModels', async () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))
  const def = host.registered[0].definition

  let tree = host.registered[0].Component(def.inject())
  const modelRows = findAll(tree, (n) => n.props && n.props['data-mg-row'] === 'model')
  assert.equal(modelRows.length, 3, '应有 3 个模型行')
  const firstModelBox = findAll(tree, (n) => n.props && n.props['data-mg'] === 'model' && n.props['data-mg-id'] === 'deepseek-ai/deepseek-v4.1-flash')[0]
  assert.ok(firstModelBox, '应找到目标模型复选框')
  firstModelBox.props.onChange({ target: { checked: true } })

  tree = host.registered[0].Component(def.inject())
  const saveButton = findAll(tree, (n) => n.props && n.props['data-mg-action'] === 'save')[0]
  await saveButton.props.onClick()

  const ops = host.scope.writes[0]
  const byPath = {}
  for (const op of ops) byPath[op.path[0]] = op.value
  assert.deepEqual(byPath.blockedModels, ['deepseek-ai/deepseek-v4.1-flash'])
  assert.deepEqual(byPath.blockedProviders, [])
})

test('切换动作与作用域，保存后写入 mode/scope', async () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))
  const def = host.registered[0].definition

  let tree = host.registered[0].Component(def.inject())
  findAll(tree, (n) => n.props && n.props['data-mg-option'] === 'warn')[0].props.onClick()
  tree = host.registered[0].Component(def.inject())
  findAll(tree, (n) => n.props && n.props['data-mg-option'] === 'all')[0].props.onClick()

  tree = host.registered[0].Component(def.inject())
  const saveButton = findAll(tree, (n) => n.props && n.props['data-mg-action'] === 'save')[0]
  await saveButton.props.onClick()

  const byPath = {}
  for (const op of host.scope.writes[0]) byPath[op.path[0]] = op.value
  assert.equal(byPath.mode, 'warn')
  assert.equal(byPath.scope, 'all')
})

test('已存在的配置会回填到界面（勾选状态还原）', async () => {
  const scope = makeScope({ enabled: false, mode: 'warn', scope: 'all', blockedProviders: ['nvida'], blockedModels: ['deepseek-v4-flash'] })
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS, scope: scope })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))

  const tree = host.registered[0].Component(host.registered[0].definition.inject())
  assert.equal(findAll(tree, (n) => n.props && n.props['data-mg'] === 'enabled')[0].props.checked, false, '总开关应还原为关闭')
  assert.equal(findAll(tree, (n) => n.props && n.props['data-mg'] === 'provider' && n.props['data-mg-id'] === 'nvida')[0].props.checked, true, 'nvida 渠道应还原为勾选')
  assert.equal(findAll(tree, (n) => n.props && n.props['data-mg'] === 'provider' && n.props['data-mg-id'] === 'deepseek-official')[0].props.checked, false)

  const modelBoxes = findAll(tree, (n) => n.props && n.props['data-mg'] === 'model')
  assert.equal(modelBoxes.length, 3, '应有 3 个模型复选框')
  // nvida 下两个模型随渠道勾选而显示为勾选且禁用；deepseek 的那个按配置单独勾选
  const nvidaModels = modelBoxes.filter((b) => b.props['data-mg-provider'] === 'nvida')
  assert.equal(nvidaModels.length, 2)
  for (const box of nvidaModels) {
    assert.equal(box.props.checked, true, '渠道整体勾选时，其下模型应显示为已禁')
    assert.equal(box.props.disabled, true)
  }
  const solo = modelBoxes.filter((b) => b.props['data-mg-id'] === 'deepseek-v4-flash')[0]
  assert.equal(solo.props.checked, true, '按配置单独勾选的模型应还原')
})

test('配置里的通配规则（不在模型目录中）也会显示并可取消', async () => {
  const scope = makeScope({ enabled: true, mode: 'warn', scope: 'all', blockedProviders: ['*'], blockedModels: ['legacy-*'] })
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS, scope: scope })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))
  const def = host.registered[0].definition

  let tree = host.registered[0].Component(def.inject())
  const orphanGroup = findAll(tree, (n) => n.props && n.props['data-mg-row'] === 'orphan-group')
  assert.equal(orphanGroup.length, 1, '应显示"目录外的已选项"分组')
  const orphans = findAll(tree, (n) => n.props && n.props['data-mg'] === 'orphan')
  assert.equal(orphans.length, 2, '通配渠道与通配模型各一条')
  assert.ok(orphans.every((o) => o.props.checked === true))
  assert.ok(textOf(tree).includes('渠道：*'))
  assert.ok(textOf(tree).includes('模型：legacy-*'))

  // 取消其中一个通配规则后保存
  const wildcardProvider = orphans.filter((o) => o.props['data-mg-id'] === 'p:*')[0]
  wildcardProvider.props.onChange({ target: { checked: false } })
  tree = host.registered[0].Component(def.inject())
  findAll(tree, (n) => n.props && n.props['data-mg-action'] === 'save')[0].props.onClick()
  await new Promise((r) => setTimeout(r, 5))

  const byPath = {}
  for (const op of host.scope.writes[0]) byPath[op.path[0]] = op.value
  assert.deepEqual(byPath.blockedProviders, [], '通配渠道已被取消')
  assert.deepEqual(byPath.blockedModels, ['legacy-*'], '未被取消的规则保留')
})

test('模型目录拉取失败时给出可读提示而不是崩溃', async () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ groups: GROUPS, catalogError: '远程通道未就绪' })
  mod.apply(host.ctx)
  await new Promise((r) => setTimeout(r, 10))
  const tree = host.registered[0].Component(host.registered[0].definition.inject())
  const text = textOf(tree)
  assert.ok(text.includes('读取模型目录失败'), '应显示错误提示')
  assert.ok(text.includes('远程通道未就绪'))
})

test('找不到配置区时不抛异常，仍注册界面', () => {
  const mod = captured.factory((n) => (n === 'react' ? makeReact() : null))
  const host = makeCtx({ noScope: true })
  assert.doesNotThrow(() => mod.apply(host.ctx))
  assert.equal(host.registered.length, 1)
  const tree = host.registered[0].Component(host.registered[0].definition.inject())
  assert.ok(textOf(tree).includes('未找到 model-guard 配置区'))
})
