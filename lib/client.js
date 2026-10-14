/**
 * dsh-model-guard · 浏览器半身（设置界面的模型选择器）
 *
 * 加载形式与 DSH 官方客户端插件一致：注册到 window.__ModuleLoader__.load 的
 * factory，共享模块（React 等）通过 factory 的 require 取得。
 *
 * 界面位置：设置 → 插件 → 模型调用守卫（slots 的 settings.section）
 * 数据来源：ctx.remote.session.modelCatalog() 拿 provider/模型目录
 * 读写通道：ctx.configForms.get('model-guard') —— 与 Cordis 配置双向同步，
 *           保存后由 DSH 的 settings 服务持久化到 profile 的 patch 里。
 */
window.__ModuleLoader__.load({
  id: "dsh-model-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");
    var h = React.createElement;

    /** 客户端注入：slots 用于挂界面，configForms 读写本插件配置，remote 拉模型目录。 */
    var inject = ["slots", "configForms", "remote", "remote.session"];

    /** 与 cordis.patch.yml 里的插件条目 id 一致，settings 表单以此为命名空间。 */
    var NS = "model-guard";

    /* ---------------- 样式：全部走 DSH 主题变量，深浅色自动适配 ---------------- */
    var S = {
      section: { padding: "24px 0", maxWidth: "760px" },
      heading: { fontSize: "18px", fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)", margin: "0 0 8px" },
      intro: { fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", margin: "0 0 24px" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)", marginBottom: "20px" },
      rowInfo: { display: "flex", flexDirection: "column", gap: "4px" },
      rowLabel: { fontSize: "15px", fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" },
      rowDesc: { fontSize: "13px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" },
      field: { marginBottom: "20px" },
      label: { display: "block", fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: "8px" },
      hint: { fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0" },
      segGroup: { display: "flex", gap: "8px", flexWrap: "wrap" },
      seg: { flex: "1 1 160px", textAlign: "left", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: "13px", lineHeight: 1.5 },
      segActive: { borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)", boxShadow: "inset 0 0 0 1px var(--dsw-alias-brand-primary, #4d6bfe)" },
      segTitle: { display: "block", fontWeight: 600, marginBottom: "2px" },
      segDesc: { display: "block", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
      panel: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", background: "var(--dsw-alias-bg-module-platform)", overflow: "hidden" },
      panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 14px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
      panelTitle: { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      panelBody: { maxHeight: "420px", overflowY: "auto" },
      group: { borderBottom: "1px solid var(--dsw-alias-border-l2)" },
      groupHead: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", background: "var(--dsw-alias-bg-module-platform)" },
      groupName: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", flex: "1 1 auto", wordBreak: "break-all" },
      model: { display: "flex", alignItems: "center", gap: "10px", padding: "7px 14px 7px 32px" },
      modelName: { fontSize: "12.5px", color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))", flex: "1 1 auto", wordBreak: "break-all" },
      modelId: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
      check: { flex: "none", width: "15px", height: "15px", cursor: "pointer" },
      muted: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)", padding: "16px 14px", lineHeight: 1.6 },
      toolbar: { display: "flex", alignItems: "center", gap: "12px", marginTop: "20px", flexWrap: "wrap" },
      btn: { padding: "8px 16px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
      btnPrimary: { padding: "8px 16px", borderRadius: "8px", border: "1px solid transparent", background: "var(--dsw-alias-brand-primary, #4d6bfe)", color: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
      status: { fontSize: "12.5px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" },
      error: { fontSize: "12.5px", lineHeight: 1.5, color: "var(--dsw-alias-label-error, #d64545)" },
      code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11.5px" },
    };

    /* ---------------- 极简外部 store，供 useSyncExternalStore 订阅 ---------------- */
    function createStore(initial) {
      var snapshot = initial;
      var listeners = new Set();
      return {
        getSnapshot: function () { return snapshot; },
        set: function (next) { snapshot = next; for (var fn of Array.from(listeners)) { try { fn(); } catch (e) {} } },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        },
      };
    }

    /* ---------------- 配置读写：对齐 dsh-settings 的 scope 契约 ---------------- */
    function readValue(scope) {
      try {
        var snap = scope.getSnapshot();
        return (snap && snap.value) || {};
      } catch (e) {
        return {};
      }
    }

    function hasLanded(scope, expected) {
      var value = readValue(scope);
      for (var key in expected) {
        var a = JSON.stringify(value[key]);
        var b = JSON.stringify(expected[key]);
        if (a !== b) return false;
      }
      return true;
    }

    async function commit(scope, ops, expected) {
      if (typeof scope.mutate === "function") {
        await scope.mutate(ops);
      } else if (typeof scope.set === "function") {
        for (var i = 0; i < ops.length; i++) await scope.set(ops[i].path[0], ops[i].value);
      }
      return { ok: hasLanded(scope, expected) };
    }

    /* ---------------- 选择状态 ↔ 配置字段的相互转换 ---------------- */
    /** 勾选集合：渠道用 "p:<provider>"，单个模型用 "m:<modelId>"。 */
    function selectionFrom(value) {
      var set = new Set();
      var providers = Array.isArray(value.blockedProviders) ? value.blockedProviders : [];
      var models = Array.isArray(value.blockedModels) ? value.blockedModels : [];
      for (var i = 0; i < providers.length; i++) set.add("p:" + providers[i]);
      for (var j = 0; j < models.length; j++) set.add("m:" + models[j]);
      return set;
    }

    function arraysFrom(set) {
      var providers = [];
      var models = [];
      for (var key of Array.from(set).sort()) {
        if (key.indexOf("p:") === 0) providers.push(key.slice(2));
        else if (key.indexOf("m:") === 0) models.push(key.slice(2));
      }
      return { blockedProviders: providers, blockedModels: models };
    }

    /* ---------------- 设置区组件 ---------------- */
    function Section(props) {
      var store = props.store;
      var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      var id = React.useId();
      var t = state.text;
      var disabled = state.saving === true;

      var toggle = function (key) {
        var next = new Set(state.draft);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        props.onDraft(next);
      };

      var toggleProvider = function (provider, on) {
        var next = new Set(state.draft);
        var prefix = "p:" + provider;
        if (on) {
          next.add(prefix);
        } else {
          next.delete(prefix);
          // 关掉整个渠道时，顺手清掉它下面逐个勾选的模型，避免留下"看不见但仍生效"的规则
          var group = state.byProvider[provider] || [];
          for (var i = 0; i < group.length; i++) next.delete("m:" + group[i].id);
        }
        props.onDraft(next);
      };

      var setMode = function (mode) { props.onField("mode", mode); };
      var setScope = function (scope) { props.onField("scope", scope); };

      var segments = function (options, active, onPick) {
        return h("div", { style: S.segGroup }, options.map(function (opt) {
          var isActive = active === opt.value;
          return h("button", {
            key: opt.value,
            type: "button",
            "data-mg-option": opt.value,
            style: Object.assign({}, S.seg, isActive ? S.segActive : {}),
            onClick: function () { onPick(opt.value); },
            disabled: disabled,
          }, [
            h("span", { key: "t", style: S.segTitle }, opt.title),
            h("span", { key: "d", style: S.segDesc }, opt.desc),
          ]);
        }));
      };

      var groups = state.groups.map(function (group) {
        var allModels = (state.byProvider[group.id] || []);
        var providerChecked = state.draft.has("p:" + group.id);
        var models = allModels.map(function (model) {
          var checked = providerChecked || state.draft.has("m:" + model.id);
          return h("label", { key: model.id, style: S.model, "data-mg-row": "model", "data-mg-id": model.id, "data-mg-provider": group.id }, [
            h("input", {
              key: "c",
              type: "checkbox",
              "data-mg": "model",
              "data-mg-id": model.id,
              "data-mg-provider": group.id,
              style: S.check,
              checked: checked,
              disabled: disabled || providerChecked,
              onChange: function () { toggle("m:" + model.id); },
            }),
            h("span", { key: "n", style: S.modelName }, [
              model.label || model.id,
              model.label && model.label !== model.id
                ? h("span", { key: "i", style: S.modelId }, "  " + model.id)
                : null,
            ].filter(Boolean)),
          ]);
        });
        return h("div", { key: group.id, style: S.group }, [
          h("div", { key: "h", style: S.groupHead, "data-mg-row": "provider", "data-mg-id": group.id }, [
            h("input", {
              key: "c",
              type: "checkbox",
              "data-mg": "provider",
              "data-mg-id": group.id,
              style: S.check,
              checked: providerChecked,
              disabled: disabled,
              onChange: function (event) { toggleProvider(group.id, event.target.checked); },
            }),
            h("span", { key: "n", style: S.groupName }, group.id),
            h("span", { key: "c2", style: S.modelId }, t.providerCount.replace("{n}", String(allModels.length))),
          ]),
          models.length > 0 ? h("div", { key: "b" }, models) : h("div", { key: "b", style: S.muted }, t.noModels),
        ]);
      });

      // 配置里存在、但当前模型目录里找不到的规则（典型是手写的通配 '*'）也要显示出来，
      // 否则它会在后台生效却无法在界面上取消。
      var orphanKeys = Array.from(state.draft).filter(function (key) { return !state.knownKeys.has(key); });
      var orphanGroup = orphanKeys.length === 0 ? null : h(
        "div",
        { key: "orphans", style: S.group, "data-mg-row": "orphan-group" },
        [
          h("div", { key: "h", style: S.groupHead }, [
            h("span", { key: "n", style: S.groupName }, t.orphanTitle),
            h("span", { key: "c", style: S.modelId }, t.orphanHint),
          ]),
        ].concat(orphanKeys.map(function (key) {
          return h("label", { key: key, style: S.model, "data-mg-row": "orphan", "data-mg-id": key }, [
            h("input", {
              key: "c",
              type: "checkbox",
              "data-mg": "orphan",
              "data-mg-id": key,
              style: S.check,
              checked: true,
              disabled: disabled,
              onChange: function () { toggle(key); },
            }),
            h("span", { key: "n", style: S.modelName },
              key.indexOf("p:") === 0 ? t.orphanProvider + key.slice(2) : t.orphanModel + key.slice(2)),
          ]);
        }))
      );

      var catalogBody;
      if (state.catalogStatus === "loading") catalogBody = h("div", { style: S.muted }, t.loading);
      else if (state.catalogStatus === "error") catalogBody = h("div", { style: S.muted }, t.catalogError + " " + (state.catalogError || ""));
      else if (groups.length === 0 && orphanGroup === null) catalogBody = h("div", { style: S.muted }, t.noProviders);
      else catalogBody = h("div", null, [orphanGroup].concat(groups).filter(Boolean));

      return h("div", { style: S.section }, [
        h("h2", { key: "h", style: S.heading }, t.title),
        h("p", { key: "i", style: S.intro }, t.intro),

        h("div", { key: "en", style: S.row }, [
          h("div", { key: "a", style: S.rowInfo }, [
            h("span", { key: "l", style: S.rowLabel }, t.enabledLabel),
            h("span", { key: "d", style: S.rowDesc }, t.enabledDesc),
          ]),
          h("label", { key: "b", style: { position: "relative", display: "inline-block", cursor: "pointer" } }, [
            h("input", {
              key: "c",
              type: "checkbox",
              "data-mg": "enabled",
              checked: state.enabled,
              disabled: disabled,
              style: { width: "18px", height: "18px", cursor: "pointer" },
              onChange: function (event) { props.onField("enabled", event.target.checked); },
            }),
          ]),
        ]),

        h("div", { key: "m", style: S.field }, [
          h("label", { key: "l", style: S.label, htmlFor: id + "-mode" }, t.modeLabel),
          segments([
            { value: "block", title: t.modeBlock, desc: t.modeBlockDesc },
            { value: "redirect", title: t.modeRedirect, desc: t.modeRedirectDesc },
            { value: "warn", title: t.modeWarn, desc: t.modeWarnDesc },
          ], state.mode, setMode),
          h("p", { key: "h", style: S.hint }, t.modeHint),
        ]),

        h("div", { key: "s", style: S.field }, [
          h("label", { key: "l", style: S.label }, t.scopeLabel),
          segments([
            { value: "auto", title: t.scopeAuto, desc: t.scopeAutoDesc },
            { value: "all", title: t.scopeAll, desc: t.scopeAllDesc },
          ], state.scope, setScope),
          h("p", { key: "h", style: S.hint }, t.scopeHint),
        ]),

        h("div", { key: "list", style: S.field }, [
          h("label", { key: "l", style: S.label }, t.listLabel),
          h("p", { key: "h", style: S.hint }, t.listHint),
          h("div", { key: "p", style: Object.assign({ marginTop: "10px" }, S.panel) }, [
            h("div", { key: "ph", style: S.panelHead }, [
              h("span", { key: "t", style: S.panelTitle }, t.selectedCount.replace("{n}", String(state.draft.size))),
              h("button", {
                key: "r",
                type: "button",
                style: S.btn,
                disabled: disabled || state.catalogStatus === "loading",
                onClick: function () { props.onReload(); },
              }, t.reload),
            ]),
            h("div", { key: "pb", style: S.panelBody }, catalogBody),
          ]),
        ]),

        h("div", { key: "tb", style: S.toolbar }, [
          h("button", {
            key: "save",
            type: "button",
            "data-mg-action": "save",
            style: Object.assign({}, S.btnPrimary, disabled ? { opacity: 0.6, cursor: "default" } : {}),
            disabled: disabled || !state.dirty,
            onClick: function () { props.onSave(); },
          }, state.saving ? t.saving : t.save),
          h("button", {
            key: "discard",
            type: "button",
            "data-mg-action": "discard",
            style: S.btn,
            disabled: disabled || !state.dirty,
            onClick: function () { props.onDiscard(); },
          }, t.discard),
          state.failed
            ? h("span", { key: "f", style: S.error }, t.saveFailed)
            : (state.saved ? h("span", { key: "ok", style: S.status }, t.saved) : null),
        ]),

        h("p", { key: "note", style: S.hint }, t.writeNote),
      ]);
    }

    /* ---------------- 中文界面文案 ---------------- */
    var TEXT = {
      title: "模型调用守卫",
      intro: "在 DSH 每一次模型调用的必经之路上做名单判定：勾选下面的渠道或模型即可禁止调用。作用域选「仅自动调用」时，后台的上下文压缩与会话标题生成会被拦下，而你在界面上手动选择该模型时照常可用。",
      enabledLabel: "启用守卫",
      enabledDesc: "关闭后插件完全放行，不记录也不拦截",
      modeLabel: "命中后的动作",
      modeBlock: "拦截",
      modeBlockDesc: "直接失败，不发出任何网络请求",
      modeRedirect: "改道",
      modeRedirectDesc: "换到备用模型（需在配置文件里设置 fallback）",
      modeWarn: "仅告警",
      modeWarnDesc: "只写日志，不影响调用",
      modeHint: "「改道」需要在 cordis.patch.yml 的 fallback 里配好备用 provider/model，否则会自动降级为拦截。",
      scopeLabel: "作用域",
      scopeAuto: "仅自动调用",
      scopeAutoDesc: "后台压缩、会话标题生成",
      scopeAll: "所有调用",
      scopeAllDesc: "含你手动发起的对话",
      scopeHint: "DSH 用 purpose 字段标记后台辅助调用（compaction / session-title），没有该标记的就是你亲自发起的调用。",
      listLabel: "禁止清单",
      listHint: "勾选渠道名等于整个渠道拉黑；勾选具体模型只拉黑该模型。保存后立即写入 profile 配置。",
      providerCount: "{n} 个模型",
      noModels: "该渠道没有已启用的模型",
      noProviders: "当前没有可用的模型目录（尚未连接或 provider 未配置）。",
      loading: "正在读取模型目录…",
      catalogError: "读取模型目录失败：",
      selectedCount: "已选 {n} 项",
      orphanTitle: "目录外的已选项",
      orphanHint: "不在当前模型目录里，通常来自配置文件中的通配规则",
      orphanProvider: "渠道：",
      orphanModel: "模型：",
      reload: "重新读取",
      save: "保存",
      saving: "保存中…",
      discard: "放弃改动",
      saved: "已保存并生效",
      saveFailed: "写入未落盘，改动已保留，可重试。",
      writeNote: "保存会通过 DSH 的 settings 服务写回 profile 的 Cordis patch；模型列表来自当前实际可路由的 provider 目录。",
    };

    /**
     * 客户端入口。
     * @param ctx - 客户端上下文（已注入 slots / configForms / remote）。
     */
    function apply(ctx) {
      var t = TEXT;

      var scope = null;
      try {
        scope = ctx.configForms.get(NS);
      } catch (error) {
        scope = null;
      }

      var state = {
        enabled: true,
        mode: "block",
        scope: "auto",
        draft: new Set(),
        groups: [],
        byProvider: {},
        knownKeys: new Set(),
        catalogStatus: "loading",
        catalogError: "",
        saving: false,
        saved: false,
        failed: false,
        dirty: false,
        text: t,
      };

      var store = createStore(state);

      var publish = function (patch) {
        var next = Object.assign({}, store.getSnapshot(), patch);
        store.set(next);
      };

      /** 配置里的值 → 界面状态。 */
      var syncFromScope = function () {
        var value = scope ? readValue(scope) : {};
        publish({
          enabled: value.enabled !== false,
          mode: typeof value.mode === "string" && value.mode ? value.mode : "block",
          scope: typeof value.scope === "string" && value.scope ? value.scope : "auto",
          draft: selectionFrom(value),
          dirty: false,
          failed: false,
        });
      };

      var unsubscribe = null;
      if (scope && typeof scope.subscribe === "function") {
        try {
          unsubscribe = scope.subscribe(function () { syncFromScope(); });
        } catch (error) {
          unsubscribe = null;
        }
        ctx.effect(function () {
          return function () { if (typeof unsubscribe === "function") unsubscribe(); };
        }, "model-guard: settings subscription");
      }

      syncFromScope();

      /** 拉取可路由的 provider / 模型目录。 */
      var loadCatalog = async function () {
        publish({ catalogStatus: "loading", catalogError: "" });
        try {
          var response = await ctx.remote.session.modelCatalog();
          var groups = (response && response.value && response.value.groups) || [];
          var normalized = [];
          var byProvider = {};
          for (var i = 0; i < groups.length; i++) {
            var group = groups[i] || {};
            var models = [];
            var list = group.models || [];
            for (var j = 0; j < list.length; j++) {
              var model = list[j] || {};
              if (!model.id) continue;
              models.push({ id: model.id, label: model.name || model.id });
            }
            normalized.push({ id: group.id, count: models.length });
            byProvider[group.id] = models;
          }
          // 记录"目录里存在"的键，用于识别配置里那些不在目录中的规则（如通配 '*'），
          // 否则用户在界面上看不到它们，也就无法取消。
          var known = new Set();
          for (var k = 0; k < normalized.length; k++) {
            known.add("p:" + normalized[k].id);
            var list2 = byProvider[normalized[k].id] || [];
            for (var m = 0; m < list2.length; m++) known.add("m:" + list2[m].id);
          }
          publish({ groups: normalized, byProvider: byProvider, knownKeys: known, catalogStatus: "ready" });
        } catch (error) {
          publish({ catalogStatus: "error", catalogError: String((error && error.message) || error) });
        }
      };

      var actions = {
        onField: function (key, value) {
          var apply = {};
          apply[key] = value;
          if (key === "enabled" || key === "mode" || key === "scope") {
            apply.dirty = true;
            apply.saved = false;
            apply.failed = false;
          }
          publish(apply);
        },
        onDraft: function (nextSet) {
          publish({ draft: nextSet, dirty: true, saved: false, failed: false });
        },
        onReload: function () { loadCatalog(); },
        onDiscard: function () { syncFromScope(); },
        onSave: async function () {
          if (!scope) {
            publish({ failed: true });
            return;
          }
          if (store.getSnapshot().saving) return;
          publish({ saving: true, failed: false, saved: false });
          try {
            var current = store.getSnapshot();
            var arrays = arraysFrom(current.draft);
            var expected = {
              enabled: current.enabled,
              mode: current.mode,
              scope: current.scope,
              blockedProviders: arrays.blockedProviders,
              blockedModels: arrays.blockedModels,
            };
            var ops = [
              { op: "set", path: ["enabled"], value: expected.enabled },
              { op: "set", path: ["mode"], value: expected.mode },
              { op: "set", path: ["scope"], value: expected.scope },
              { op: "set", path: ["blockedProviders"], value: expected.blockedProviders },
              { op: "set", path: ["blockedModels"], value: expected.blockedModels },
            ];
            var outcome = await commit(scope, ops, expected);
            if (!outcome.ok) {
              console.error("model-guard: settings write did not land", { ops: ops, revision: scope.getSnapshot && scope.getSnapshot().revision });
              publish({ saving: false, failed: true });
              return;
            }
            publish({ saving: false, saved: true, dirty: false, failed: false });
          } catch (error) {
            console.error("model-guard: failed to save settings section", error);
            publish({ saving: false, failed: true });
          }
        },
      };

      if (scope) loadCatalog();
      else publish({ catalogStatus: "error", catalogError: "未找到 model-guard 配置区（profile 条目 id 需为 " + NS + "）" });

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "model-guard",
          order: 70,
          label: function () { return "模型调用守卫"; },
          inject: function () {
            return {
              store: store,
              onField: actions.onField,
              onDraft: actions.onDraft,
              onSave: actions.onSave,
              onDiscard: actions.onDiscard,
              onReload: actions.onReload,
            };
          },
        }, Section);
      });
    }

    module.exports = { apply: apply, inject: inject };
    return module.exports;
  },
});
