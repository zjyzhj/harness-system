// 工具菜单与设置页：模型、图片、用量、语义回想、迁移、记忆、技能、定时任务、MCP、群组、编排、系统授权
/* ---------- 工具菜单：统一外观的面板 ---------- */
function sheet({ icon, title, sub = "", body = "", wide = false }) {
  const modal = openModal(`
    <div class="mx-head"><span class="mx-icon">${icon}</span><div class="mx-title"><b>${esc(title)}</b>${sub ? `<span class="hint">${esc(sub)}</span>` : ""}</div><button class="icon-btn mx-close" title="关闭">✕</button></div>
    <div class="mx-body">${body}</div>`);
  modal.classList.add("mx");
  if (wide) modal.classList.add("wide");
  modal.querySelector(".mx-close").onclick = closeModal;
  return modal;
}
const botOptions = (selected) => bots.map((b) => `<option value="${esc(b.id)}" ${b.id === selected ? "selected" : ""}>${esc(b.name)}</option>`).join("");
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** 单个 bot 的权限区（详情页 / 更多设置共用）：批准能力、撤销、信任模式、Coding CLI 目录 */
function botPermSection(botId, grants, caps, trusted, { linkSys = true, cliPaths = [] } = {}) {
  const label = (id) => caps.find((c) => c.id === id)?.label || id;
  return `
    <div class="d-sec bot-perm" data-bot="${esc(botId)}">
      <h4>权限</h4>
      <div class="hint">默认不能动你的电脑；需要时会在会话里请你批准，也可在此预先批准。</div>
      ${grants.map((g) => `
        <div class="d-card"><div class="c-main"><div class="c-title">${esc(label(g.cap))}</div>
          <div class="c-sub">${g.once ? "仅一次" : g.expiresAt ? `到 ${esc(fmtTime(g.expiresAt))}` : "长期"}${g.grantedAt ? ` · ${esc(fmtTime(g.grantedAt))}` : ""}</div></div>
          <button class="ghost-btn danger-text" data-revoke="${esc(g.cap)}">撤销</button></div>`).join("") || `<div class="d-empty">尚未批准任何能力</div>`}
      ${cliPaths.length ? `<div class="hint" style="margin-top:8px">Coding CLI 已信任目录（同前缀派工可免再问）</div>${cliPaths.map((p) => `
        <div class="d-card"><div class="c-main"><div class="c-title" title="${esc(p.prefix)}">${esc(p.prefix)}</div>
          <div class="c-sub">${p.createdAt ? esc(fmtTime(p.createdAt)) : ""}</div></div>
          <button class="ghost-btn danger-text" data-revoke-clipath="${esc(p.prefix)}">撤销</button></div>`).join("")}` : ""}
      <div class="mx-inline sa-grant bot-perm-grant">
        <select class="skin-select bp-cap">${caps.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select>
        <select class="skin-select bp-ttl"><option value="0">长期</option><option value="3600000">1 小时</option><option value="86400000">1 天</option><option value="once">仅一次</option></select>
        <button class="ghost-btn bp-grant">批准</button>
      </div>
      <div class="d-card"><div class="c-main"><div class="c-title">信任模式</div>
        <div class="c-sub">${trusted ? "命令直接执行（危险命令仍要确认）" : "每个新命令先问你"}</div></div>
        <label class="switch" title="信任模式"><input type="checkbox" class="bp-trust" ${trusted ? "checked" : ""}/><span></span></label></div>
      ${linkSys ? `<button class="ghost-btn bp-sysaccess" style="margin-top:4px">命令规则与操作记录…</button>` : ""}
    </div>`;
}

function bindBotPerm(root, botId, onChange) {
  const sec = root.querySelector?.(".bot-perm") || root;
  sec.querySelectorAll("[data-revoke]").forEach((btn) => (btn.onclick = async () => {
    await api.consent.revoke(botId, btn.dataset.revoke);
    onChange?.();
  }));
  sec.querySelectorAll("[data-revoke-clipath]").forEach((btn) => (btn.onclick = async () => {
    await api.consent.revokeCliPath(botId, btn.dataset.revokeClipath);
    onChange?.();
  }));
  const grantBtn = sec.querySelector(".bp-grant");
  if (grantBtn) grantBtn.onclick = async () => {
    const ttl = sec.querySelector(".bp-ttl")?.value || "0";
    const cap = sec.querySelector(".bp-cap")?.value;
    if (!cap) return;
    await api.consent.grant(botId, cap, ttl === "once" ? { once: true } : Number(ttl) ? { ttlMs: Number(ttl) } : undefined);
    onChange?.();
  };
  const trust = sec.querySelector(".bp-trust");
  if (trust) trust.onchange = async () => {
    if (trust.checked && !confirm(`打开信任模式后，${botById(botId)?.name || "这个 bot"} 执行命令不再逐个询问（危险命令除外）。确定吗？`)) {
      trust.checked = false;
      return;
    }
    await api.consent.setTrusted(botId, trust.checked);
    onChange?.();
  };
  const sys = sec.querySelector(".bp-sysaccess");
  if (sys) sys.onclick = () => { closeModal(); sysaccessFlow(); };
}

/* ---- 模型设置 ---- */
async function settingsFlow() {
  const modal = sheet({ icon: "⚙", title: "模型设置", sub: "bot 没单独指定模型时用「默认」；每个 bot 也可在右侧详情里单独选", wide: true });
  const body = modal.querySelector(".mx-body");
  let editing = null; // null = 不在编辑；{} = 新建；provider = 编辑
  const caps = await api.providers.capabilities().catch(() => ({}));
  const render = async () => {
    const providers = await api.providers.list();
    const usage = (p) => bots.filter((b) => effectiveProvider(b, providers)?.id === p.id).length;
    body.innerHTML = `
      <div class="d-sec"><h4>本机 CLI <button class="ghost-btn" id="cli-refresh" title="重新探测">刷新</button></h4>
        <div class="mx-chips">${["claude", "codex", "cursor"].map((c) => `<span class="mx-chip ${caps[c]?.installed ? "ok" : ""}">${caps[c]?.installed ? "✓" : "✕"} ${c}${caps[c]?.version ? ` · ${esc(caps[c].version.split(" ")[0])}` : ""}${caps[c]?.account ? ` · ${esc(caps[c].account)}` : ""}</span>`).join("")}</div>
        <div class="hint">探测结果供「对话用 CLI Provider」与「写代码派工 cli.agent」共用。对话 Provider 选 CLI 时是问答模式，不会改仓库；改工程请让 bot 调 <code>cli.agent</code>（bot 详情可设默认工程目录）。Cursor CLI 与 IDE 共用钥匙串：<code>cursor-agent logout</code> 只清 CLI 配置；彻底换号见钥匙串 <code>cursor-access-token</code>。</div>
      </div>
      <div class="d-sec"><h4>Provider <button class="list-add" id="pv-new" title="添加">＋</button></h4>
        ${providers.map((p) => `
          <div class="d-card" data-id="${esc(p.id)}">
            <div class="c-main"><div class="c-title">${esc(p.name)} ${isDefaultProvider(p, providers) ? '<span class="tag on">默认</span>' : ""}</div>
              <div class="c-sub">${p.kind === "cli" ? `CLI · ${esc(p.cliName ?? "")}` : `API · ${esc(p.baseUrl ?? "")}`}${p.model ? ` · ${esc(p.model)}` : ""} · ${usage(p)} 个 bot 在用</div>
              <div class="pv-test c-sub"></div></div>
            <span class="mx-ops">
              <button class="ghost-btn" data-op="test">测试</button>
              <button class="ghost-btn" data-op="edit">编辑</button>
              ${isDefaultProvider(p, providers) ? "" : `<button class="ghost-btn" data-op="def">设为默认</button>`}
              <button class="ghost-btn danger-text" data-op="del">删除</button>
            </span>
          </div>`).join("") || `<div class="d-empty">还没有 provider，点 ＋ 添加一个</div>`}
      </div>
      ${editing ? providerForm(editing) : ""}
      <div id="ig-sec"></div>
      <div id="em-sec"></div>
      <div id="us-sec"></div>`;
    renderImageGen(body.querySelector("#ig-sec"));
    renderEmbedding(body.querySelector("#em-sec"));
    renderUsage(body.querySelector("#us-sec"));
    body.querySelector("#cli-refresh")?.addEventListener("click", async () => {
      Object.assign(caps, await api.providers.capabilities().catch(() => caps));
      render();
    });
    body.querySelector("#pv-new").onclick = () => { editing = {}; render(); };
    body.querySelectorAll(".d-card[data-id]").forEach((card) => (card.onclick = async (e) => {
      const op = e.target.closest("button")?.dataset.op;
      const p = providers.find((x) => x.id === card.dataset.id);
      if (!op || !p) return;
      if (op === "edit") { editing = p; return render(); }
      if (op === "def") { await api.providers.setDefault(p.id); if (currentBot) renderDetails(currentBot); return render(); }
      if (op === "del") {
        const n = usage(p);
        if (!confirm(`删除「${p.name}」？${n ? `\n有 ${n} 个 bot 在用它，删除后会改用默认模型。` : ""}`)) return;
        await api.providers.remove(p.id);
        return render();
      }
      if (op === "test") {
        const el = card.querySelector(".pv-test");
        el.textContent = "测试中…";
        const r = await api.providers.test(p.id).catch((err) => ({ ok: false, detail: errText(err) }));
        el.className = `pv-test c-sub ${r.ok ? "ok" : "bad"}`;
        el.textContent = `${r.ok ? "✓ 连接成功" : "✕ 连接失败"}${r.detail ? `：${r.detail}` : ""}`;
      }
    }));
    if (editing) bindProviderForm(body, editing, providers, async () => { editing = null; await render(); if (currentBot) renderDetails(currentBot); }, () => { editing = null; render(); });
  };
  render();
}

/* ---- 图片生成接口（image.generate / image.edit 用） ---- */
const IMAGE_PRESETS = {
  custom: { name: "自定义", baseUrl: "", model: "", editModel: "" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", editModel: "gpt-image-1" },
  siliconflow_cn: { name: "SiliconFlow 国内", baseUrl: "https://api.siliconflow.cn/v1", model: "Kwai-Kolors/Kolors", editModel: "Qwen/Qwen-Image-Edit-2509" },
  siliconflow: { name: "SiliconFlow 国际", baseUrl: "https://api.siliconflow.com/v1", model: "Tongyi-MAI/Z-Image-Turbo", editModel: "Qwen/Qwen-Image-Edit" },
};
async function renderImageGen(box, editing = false) {
  const cfg = await api.config.get("imageGen");
  if (!editing) {
    box.innerHTML = `<div class="d-sec"><h4>图片生成</h4>
      <div class="d-card"><span class="ws-dot ${cfg?.baseUrl ? "ok" : ""}"></span>
        <div class="c-main"><div class="c-title">${cfg?.baseUrl ? esc(cfg.model) : "未配置"}</div>
          <div class="c-sub">${cfg?.baseUrl ? `${esc(cfg.baseUrl)}${cfg.editModel ? ` · 改图 ${esc(cfg.editModel)}` : ""}` : "任意 OpenAI 兼容 /images/generations；预设只是快捷填充"}</div></div>
        <button class="ghost-btn" id="ig-edit">${cfg?.baseUrl ? "编辑" : "配置"}</button>
      </div></div>`;
    box.querySelector("#ig-edit").onclick = () => renderImageGen(box, true);
    return;
  }
  box.innerHTML = `<div class="d-sec mx-form"><h4>图片生成接口</h4>
    <div class="hint">不限供应商：填该服务的 Base URL、Key、模型名即可（协议兼容 OpenAI <code>/images/generations</code>；改图另可走 <code>/images/edits</code>）。下面预设仅快捷填表。</div>
    <div class="mx-seg">${Object.entries(IMAGE_PRESETS).map(([k, v]) => `<button data-preset="${k}">${v.name}</button>`).join("")}</div>
    <div class="mx-grid">
      <label>Base URL</label><input id="ig-url" value="${esc(cfg?.baseUrl ?? "")}" placeholder="https://你的中转或官方/v1" />
      <label>API Key</label><input id="ig-key" type="password" placeholder="${cfg?.apiKey ? "已保存，留空不修改" : "sk-..."}" />
      <label>生成模型</label><input id="ig-model" value="${esc(cfg?.model ?? "")}" placeholder="供应商提供的模型 id" />
      <label>改图模型</label><input id="ig-edit-model" value="${esc(cfg?.editModel ?? "")}" placeholder="可选，不填用生成模型" />
      <label>尺寸</label><input id="ig-size" value="${esc(cfg?.size ?? "")}" placeholder="默认 1024x1024" />
    </div>
    <div class="actions">${cfg?.baseUrl ? `<button class="ghost-btn danger-text" id="ig-clear">清除</button>` : ""}<button class="ghost-btn" id="ig-cancel">取消</button><button class="primary-btn" id="ig-save">保存</button></div>
  </div>`;
  const $b = (s) => box.querySelector(s);
  box.querySelectorAll("[data-preset]").forEach((btn) => (btn.onclick = () => {
    const p = IMAGE_PRESETS[btn.dataset.preset];
    $b("#ig-url").value = p.baseUrl; $b("#ig-model").value = p.model; $b("#ig-edit-model").value = p.editModel;
    box.querySelectorAll("[data-preset]").forEach((x) => x.classList.toggle("on", x === btn));
  }));
  $b("#ig-cancel").onclick = () => renderImageGen(box);
  if ($b("#ig-clear")) $b("#ig-clear").onclick = async () => { await api.config.set("imageGen", null); renderImageGen(box); };
  $b("#ig-save").onclick = async () => {
    const baseUrl = $b("#ig-url").value.trim(), model = $b("#ig-model").value.trim(), key = $b("#ig-key").value.trim();
    if (!baseUrl || !model) return alert("填 Base URL 和生成模型");
    if (!key && !cfg?.apiKey) return alert("填 API Key");
    await api.config.set("imageGen", { baseUrl, model, editModel: $b("#ig-edit-model").value.trim() || undefined, size: $b("#ig-size").value.trim() || undefined, apiKey: key || "__keep__" });
    renderImageGen(box);
  };
  box.scrollIntoView({ block: "nearest" });
}

/* ---- 模型用量（每轮所有调用合计：工具轮、推理预想、自检、压缩） ---- */
function fmtTok(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); }
async function renderUsage(box) {
  const u = await api.usage.summary().catch(() => null);
  const card = (title, rows) => {
    const list = Object.entries(rows ?? {});
    const tot = list.reduce((a, [, r]) => ({ input: a.input + r.input, output: a.output + r.output, calls: a.calls + r.calls, turns: a.turns + r.turns, cached: a.cached + (r.cached ?? 0) }), { input: 0, output: 0, calls: 0, turns: 0, cached: 0 });
    const hit = tot.cached && tot.input ? `（${Math.round((tot.cached / tot.input) * 100)}% 命中缓存，这部分按约 1/10 计费）` : "";
    return `<div class="d-card"><div class="c-main"><div class="c-title">${title}：${fmtTok(tot.input + tot.output)} token</div>
      <div class="c-sub">${tot.turns} 轮回复 · ${tot.calls} 次模型调用 · 输入 ${fmtTok(tot.input)}${hit} / 输出 ${fmtTok(tot.output)}${list.length > 1 ? `<br>${list.map(([k, r]) => `${esc(k)}：${fmtTok(r.input + r.output)}`).join("<br>")}` : ""}</div></div></div>`;
  };
  box.innerHTML = `<div class="d-sec"><h4>用量</h4>${u ? card("今天", u.today) + card("本月", u.month) : `<div class="d-empty">暂无统计</div>`}</div>`;
}

/* ---- 语义回想（记忆 + 过往对话的向量检索） ---- */
const EMBED_PRESETS = {
  custom: { name: "自定义", baseUrl: "", model: "" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  siliconflow_cn: { name: "SiliconFlow 国内", baseUrl: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" },
  siliconflow: { name: "SiliconFlow 国际", baseUrl: "https://api.siliconflow.com/v1", model: "BAAI/bge-m3" },
};
async function renderEmbedding(box, editing = false) {
  const cfg = await api.embedding.get().catch(() => ({ mode: "local" }));
  const st = cfg.status;
  const stateText = cfg.mode === "off" ? "已关闭，只按关键词找记忆"
    : st?.error ? `出错：${st.error}`
    : st ? `已建索引 ${st.indexed} / ${st.total} 条${st.indexed < st.total ? "（后台进行中）" : ""}` : "准备中";
  const modeName = { local: "本地模型 · multilingual-e5-small", api: `在线接口 · ${cfg.model ?? ""}`, off: "关闭" }[cfg.mode] ?? cfg.mode;
  if (!editing) {
    box.innerHTML = `<div class="d-sec"><h4>语义回想</h4>
      <div class="d-card"><span class="ws-dot ${cfg.mode === "off" || st?.error ? "" : st && st.indexed < st.total ? "on" : "ok"}"></span>
        <div class="c-main"><div class="c-title">${esc(modeName)}</div>
          <div class="c-sub">${esc(stateText)}。bot 会按意思想起相关的记忆和过往对话${cfg.mode === "local" ? "；首次使用自动下载约 120MB 模型，之后离线" : cfg.mode === "api" && cfg.baseUrl ? ` · ${esc(cfg.baseUrl)}` : ""}。在线模式任意 OpenAI 兼容 /embeddings</div></div>
        <button class="ghost-btn" id="em-edit">修改</button>
      </div></div>`;
    box.querySelector("#em-edit").onclick = () => renderEmbedding(box, true);
    return;
  }
  box.innerHTML = `<div class="d-sec mx-form"><h4>语义回想</h4>
    <div class="mx-seg" id="em-mode">${[["local", "本地模型"], ["api", "在线接口"], ["off", "关闭"]].map(([v, l]) => `<button data-mode="${v}" class="${cfg.mode === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <div id="em-api" style="display:${cfg.mode === "api" ? "block" : "none"}">
      <div class="hint">不限供应商：填该服务的 Base URL、Key、向量模型即可（协议兼容 OpenAI <code>/embeddings</code>）。下面预设仅快捷填表。</div>
      <div class="mx-seg">${Object.entries(EMBED_PRESETS).map(([k, v]) => `<button data-preset="${k}">${v.name}</button>`).join("")}</div>
      <div class="mx-grid">
        <label>Base URL</label><input id="em-url" value="${esc(cfg.baseUrl ?? "")}" placeholder="https://你的中转或官方/v1" />
        <label>API Key</label><input id="em-key" type="password" placeholder="${cfg.apiKey ? "已保存，留空不修改" : "sk-..."}" />
        <label>向量模型</label><input id="em-model" value="${esc(cfg.model ?? "")}" placeholder="供应商提供的 embedding 模型 id" />
      </div>
      <div class="hint">保存时会先测试一次连接；换模型后会在后台重建索引。</div>
    </div>
    <div class="pf-result" id="em-result"></div>
    <div class="actions"><button class="ghost-btn" id="em-cancel">取消</button><button class="primary-btn" id="em-save">保存</button></div>
  </div>`;
  const $b = (s) => box.querySelector(s);
  let mode = cfg.mode;
  box.querySelectorAll("[data-mode]").forEach((btn) => (btn.onclick = () => {
    mode = btn.dataset.mode;
    box.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === btn));
    $b("#em-api").style.display = mode === "api" ? "block" : "none";
  }));
  box.querySelectorAll("[data-preset]").forEach((btn) => (btn.onclick = () => {
    const p = EMBED_PRESETS[btn.dataset.preset];
    $b("#em-url").value = p.baseUrl; $b("#em-model").value = p.model;
    box.querySelectorAll("[data-preset]").forEach((x) => x.classList.toggle("on", x === btn));
  }));
  $b("#em-cancel").onclick = () => renderEmbedding(box);
  $b("#em-save").onclick = async () => {
    const key = $b("#em-key").value.trim();
    const res = $b("#em-result");
    if (mode === "api") {
      const baseUrl = $b("#em-url").value.trim(), model = $b("#em-model").value.trim();
      if (!baseUrl || !model) return alert("填 Base URL 和向量模型");
      if (!key && !cfg.apiKey) return alert("填 API Key");
    }
    res.textContent = mode === "api" ? "测试连接中…" : "保存中…";
    try {
      await api.embedding.set({ mode, baseUrl: $b("#em-url").value.trim(), model: $b("#em-model").value.trim(), apiKey: key || (cfg.apiKey ? "__keep__" : "") });
      renderEmbedding(box);
    } catch (err) {
      res.className = "pf-result bad";
      res.textContent = `✕ ${errText(err)}`;
    }
  };
  box.scrollIntoView({ block: "nearest" });
}

function providerForm(p) {
  const isNew = !p.id;
  const isCli = p.kind === "cli";
  return `
    <div class="d-sec mx-form" id="pv-form">
      <h4>${isNew ? "添加 provider" : `编辑「${esc(p.name)}」`}</h4>
      <div class="mx-grid">
        <label>类型</label><select id="pf-kind" class="skin-select" ${isNew ? "" : "disabled"}><option value="openai-compat" ${isCli ? "" : "selected"}>OpenAI 兼容 API</option><option value="cli" ${isCli ? "selected" : ""}>本机 CLI（claude / codex / cursor）</option></select>
        <label class="pf-cli">CLI</label><select id="pf-cli" class="skin-select pf-cli" ${isNew ? "" : "disabled"}>${["claude", "codex", "cursor"].map((c) => `<option ${p.cliName === c ? "selected" : ""}>${c}</option>`).join("")}</select>
        <label>名称</label><input id="pf-name" value="${esc(p.name ?? "")}" placeholder="例如 DeepSeek" />
        <label>Base URL</label><input id="pf-url" value="${esc(p.baseUrl ?? "")}" placeholder="https://api.deepseek.com/v1" />
        <label>API Key</label><input id="pf-key" type="password" placeholder="${p.apiKey ? "已保存，留空不修改" : "sk-..."}" />
        <label>模型</label><input id="pf-model" value="${esc(p.model ?? "")}" placeholder="deepseek-chat" />
        <label class="pf-api">深度思考模型</label><input id="pf-think" class="pf-api" value="${esc(p.thinkModel ?? "")}" placeholder="可选。开「深度思考」时换用的推理模型；DeepSeek 不填自动用 deepseek-reasoner" />
      </div>
      <div class="pf-result"></div>
      <div class="actions"><button class="ghost-btn" id="pf-cancel">取消</button><button class="ghost-btn" id="pf-test">测试连接</button><button class="primary-btn" id="pf-save">${isNew ? "添加" : "保存"}</button></div>
    </div>`;
}

function bindProviderForm(root, p, providers, onSaved, onCancel) {
  const $f = (s) => root.querySelector(s);
  const sync = () => {
    const cli = $f("#pf-kind").value === "cli";
    root.querySelectorAll(".pf-cli").forEach((el) => (el.style.display = cli ? "" : "none"));
    root.querySelectorAll(".pf-api").forEach((el) => (el.style.display = cli ? "none" : ""));
    $f("#pf-url").placeholder = cli ? "留空 = 用 CLI 本地配置" : "https://api.deepseek.com/v1";
    $f("#pf-model").placeholder = cli ? "留空 = 用 CLI 默认模型" : "deepseek-chat";
    if (!p.id && !$f("#pf-name").value) $f("#pf-name").value = cli ? `本地 ${$f("#pf-cli").value}` : "";
  };
  sync();
  $f("#pf-kind").onchange = () => { $f("#pf-name").value = ""; sync(); };
  $f("#pf-cli").onchange = () => { if (/^本地 /.test($f("#pf-name").value) || !$f("#pf-name").value) $f("#pf-name").value = `本地 ${$f("#pf-cli").value}`; };
  const read = () => {
    const kind = $f("#pf-kind").value;
    return {
      kind,
      name: $f("#pf-name").value.trim() || "未命名",
      baseUrl: $f("#pf-url").value.trim() || undefined,
      apiKey: $f("#pf-key").value.trim() || undefined,
      model: $f("#pf-model").value.trim() || undefined,
      thinkModel: kind === "cli" ? undefined : $f("#pf-think").value.trim() || undefined,
      cliName: kind === "cli" ? $f("#pf-cli").value : undefined,
    };
  };
  const result = $f(".pf-result");
  $f("#pf-cancel").onclick = onCancel;
  $f("#pf-test").onclick = async () => {
    const cfg = read();
    result.className = "pf-result test-result";
    result.textContent = "测试中…";
    const r = await api.providers.testConfig({ ...cfg, apiKey: cfg.apiKey ?? p.apiKey }).catch((e) => ({ ok: false, detail: errText(e) }));
    result.className = `pf-result test-result ${r.ok ? "ok" : "bad"}`;
    result.textContent = `${r.ok ? "✓ 连接成功" : "✕ 连接失败"}${r.detail ? `：${r.detail}` : ""}`;
  };
  $f("#pf-save").onclick = async () => {
    const cfg = read();
    if (cfg.kind === "openai-compat" && !cfg.baseUrl) { result.className = "pf-result test-result bad"; result.textContent = "请填写 Base URL"; return; }
    try {
      if (p.id) await api.providers.update(p.id, { name: cfg.name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, thinkModel: cfg.thinkModel });
      else {
        if (cfg.kind === "cli" && providers.some((x) => x.id === `cli-${cfg.cliName}`) && !confirm(`已经有 ${cfg.cliName} 的 CLI provider，覆盖它？`)) return;
        await api.providers.add({ ...cfg, isDefault: providers.length === 0 });
      }
      onSaved();
    } catch (e) {
      result.className = "pf-result test-result bad";
      result.textContent = errText(e);
    }
  };
  root.querySelector("#pv-form").scrollIntoView({ block: "nearest" });
}

/* ---- 迁移 ---- */
async function migrateFlow() {
  const modal = sheet({ icon: "⇄", title: "迁移", sub: "把 bot、模型配置和形象打包成一个文件，换电脑时导入即可" });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `
    <div class="d-card"><div class="c-main"><div class="c-title">导出</div><div class="c-sub">包含 bot、provider、形象和皮肤</div></div>
      <label class="chk"><input type="checkbox" id="mg-keys" /> 包含 API Key</label><button class="primary-btn" id="mg-export">导出…</button></div>
    <div class="d-card"><div class="c-main"><div class="c-title">导入</div><div class="c-sub">同名 bot 会被覆盖，形象文件会一并复制</div></div>
      <button class="ghost-btn" id="mg-import">选择文件…</button></div>
    <div class="mg-result"></div>`;
  const result = body.querySelector(".mg-result");
  body.querySelector("#mg-export").onclick = async () => {
    const path = await api.system.pickFile({ save: true, title: "导出到", defaultPath: `harness-export-${new Date().toISOString().slice(0, 10)}.json` });
    if (!path) return;
    const keys = body.querySelector("#mg-keys").checked;
    try {
      await api.migration.export(path, !keys);
      result.className = "mg-result test-result ok";
      result.innerHTML = `✓ 已导出${keys ? "（含 API Key，注意保管）" : "（API Key 已脱敏）"} <a href="#" id="mg-reveal">在 Finder 中显示</a>`;
      result.querySelector("#mg-reveal").onclick = (e) => { e.preventDefault(); api.system.reveal(path); };
    } catch (e) { result.className = "mg-result test-result bad"; result.textContent = errText(e); }
  };
  body.querySelector("#mg-import").onclick = async () => {
    const path = await api.system.pickFile({ title: "选择导出文件" });
    if (!path || !confirm(`从 ${path.split("/").pop()} 导入？同名 bot 会被覆盖。`)) return;
    try {
      const r = await api.migration.import(path);
      result.className = "mg-result test-result ok";
      result.textContent = `✓ 导入完成：${r.importedBots} 个 bot、${r.importedProviders} 个 provider、${r.importedPets} 个宠物、${r.importedSkins ?? 0} 个皮肤、${r.importedEnv ?? 0} 项配置、${r.importedProjects ?? 0} 个项目、${r.importedRules ?? 0} 条命令规则` +
        (r.secretsToReenter?.length ? `。密钥绑定原电脑的钥匙串带不过来，需要重新填写：${r.secretsToReenter.map((x) => `${x.label || x.name}${x.bot ? `（${x.bot}）` : ""}`).join("、")}（bot 用到时会弹加密框）` : "");
      await refreshBots();
    } catch (e) { result.className = "mg-result test-result bad"; result.textContent = errText(e); }
  };
}

async function botDetailFlow(b) {
  const reload = () => {
    closeModal();
    botDetailFlow(bots.find((x) => x.id === b.id) || b);
  };
  const [mem, stats, skills, tasks, stList, skins, grants, caps, cmd, cliPaths] = await Promise.all([
    api.memory.list(b.id),
    api.memory.stats(b.id),
    api.skills.list(),
    api.tasks.list(b.id),
    api.status.list().catch(() => []),
    api.skins.list(),
    api.consent.list(b.id).catch(() => []),
    api.consent.caps().catch(() => []),
    api.consent.rules().catch(() => ({ rules: [], trusted: [] })),
    api.consent.cliPaths(b.id).catch(() => []),
  ]);
  const st = stList.find((x) => x.botId === b.id) || { state: "idle" };
  const card = b.personaCard;
  const trusted = !!cmd.trusted?.includes(b.id);
  const modal = openModal(`
    <h2><span class="gd-name" id="bd-name" title="点击改名">${esc(b.name)} <span class="gd-edit">✎</span></span> ${b.petEnabled ? "🐾" : ""}
      <span class="status-dot st-${esc(st.state)}" title="${esc(st.state)}"></span>
    </h2>
    <div class="kv">
      <label>角色</label><span class="gd-name" id="bd-role" title="点击修改">${esc(b.role || "通用助手")} <span class="gd-edit">✎</span></span>
      <label>人设</label><span class="gd-name" id="bd-persona-edit" title="点击修改">${esc(b.persona || "—")} <span class="gd-edit">✎</span></span>
      ${card ? `<label>性格</label><span>${esc(card.traits?.join("、") || "—")}</span>
      ${card.catchphrase ? `<label>口头禅</label><span>${esc(card.catchphrase)}</span>` : ""}
      ${card.background ? `<label>背景</label><span>${esc(card.background)}</span>` : ""}` : ""}
      <label>状态</label><span>${esc(st.state)}${st.currentTask ? " · " + esc(st.currentTask) : ""}</span>
      <label>记忆</label><span>${Object.entries(stats || {}).map(([k, v]) => `${k}:${v}`).join("、") || "无"}</span>
      <label>技能</label><span>${skills.filter((x) => x.enabled).map((x) => esc(x.name)).join("、") || "无"}</span>
      <label>定时</label><span>${tasks.length ? tasks.map((t) => esc(t.name) + "(" + esc(t.cron) + ")").join("、") : "无"}</span>
      <label>宠物皮肤</label>
      <span><select id="bd-skin" class="skin-select">${skins.map((s) => `<option value="${esc(s.id)}"${b.skinId === s.id ? " selected" : ""}>${esc(s.name)}${s.desc ? " — " + esc(s.desc) : ""}</option>`).join("")}</select></span>
    </div>
    ${botPermSection(b.id, grants, caps, trusted, { cliPaths })}
    <div class="actions">
      <button class="ghost-btn" id="bd-persona">✨ 生成形象</button>
      <button class="primary-btn" id="bd-chat">去对话</button>
      <button class="ghost-btn" id="bd-close">关闭</button>
    </div>
    <div class="hint" id="bd-tip"></div>`);
  bindBotPerm(modal, b.id, reload);
  modal.querySelector("#bd-skin").onchange = async (e) => {
    await api.bots.setSkin(b.id, e.target.value);
    const tip = modal.querySelector("#bd-tip");
    tip.textContent = "✅ 已切换皮肤，桌面宠物会立即换上";
    setTimeout(() => (tip.textContent = ""), 2500);
  };
  const tip = () => modal.querySelector("#bd-tip");
  modal.querySelector("#bd-name").onclick = async () => {
    const name = await askInput("Bot 名称", "", b.name);
    if (!name || name.trim() === b.name) return;
    try {
      await api.bots.update(b.id, { name: name.trim() });
      await refreshBots();
      reload();
    } catch (err) { tip().textContent = err?.message || String(err); }
  };
  modal.querySelector("#bd-role").onclick = async () => {
    const role = await askInput("角色", "如：通用助手", b.role || "通用助手");
    if (role == null || role.trim() === (b.role || "")) return;
    await api.bots.update(b.id, { role: role.trim() });
    await refreshBots();
    reload();
  };
  modal.querySelector("#bd-persona-edit").onclick = async () => {
    const persona = await askInput("人设", "一两句话描述性格", b.persona || "");
    if (persona == null || persona.trim() === (b.persona || "")) return;
    await api.bots.update(b.id, { persona: persona.trim() });
    await refreshBots();
    reload();
  };
  modal.querySelector("#bd-persona").onclick = async () => {
    const desc = await askInput("一句话描述形象", "如：一只蓝色狐狸，可爱", "一只蓝色狐狸，可爱");
    if (desc) {
      closeModal();
      await api.persona.generate(b.id, desc);
      await refreshBots();
    }
  };
  modal.querySelector("#bd-chat").onclick = () => { closeModal(); selectBot(b); };
  modal.querySelector("#bd-close").onclick = closeModal;
}

/* ---- 记忆 ---- */
let memoryNs = null;
function nsLabel(ns) {
  if (ns === "global") return "全局共享";
  if (ns.startsWith("bot:")) return botById(ns.slice(4))?.name ?? "已删除的 bot";
  if (ns.startsWith("group:")) return `群：${groupList.find((g) => g.id === ns.slice(6))?.name ?? ns.slice(6, 14)}`;
  return ns;
}
const MEMORY_KIND = { rule: "规范", fact: "事实/偏好", summary: "摘要", note: "笔记", event: "事件" };
const MEMORY_SOURCE = { user: "用户说的", bot: "bot 记下", manual: "手动添加", auto: "自动", "auto-summarize": "自动摘要", "bot-runtime": "bot 记下" };
/** opts.ns 打开指定命名空间；opts.kind 只看某一类（rule / fact / event） */
async function memoryFlow(opts = {}) {
  const modal = sheet({ icon: "🧠", title: "记忆", sub: "规范常驻；事实按相关注入。MEMORY.md 由系统后台蒸馏，只在问到记忆或内容相关时带上（也可手动重写）", wide: true });
  const body = modal.querySelector(".mx-body");
  let filter = "";
  let kindFilter = opts.kind ?? "";
  if (opts.ns) memoryNs = opts.ns;
  const render = async () => {
    const known = await api.memory.namespaces().catch(() => []);
    const all = [...new Set([...bots.map((b) => `bot:${b.id}`), ...known.filter((n) => n.startsWith("group:")), "global"])];
    if (!memoryNs || !all.includes(memoryNs)) memoryNs = currentBot ? `bot:${currentBot.id}` : all[0];
    const [entries, memo] = await Promise.all([api.memory.list(memoryNs).catch(() => []), api.memory.memo(memoryNs).catch(() => "")]);
    const count = (k) => entries.filter((e) => (k === "event" ? !["rule", "fact"].includes(e.kind) : e.kind === k)).length;
    const shown = entries
      .filter((e) => !kindFilter || (kindFilter === "event" ? !["rule", "fact"].includes(e.kind) : e.kind === kindFilter))
      .filter((e) => !filter || e.content.toLowerCase().includes(filter.toLowerCase())).slice().reverse();
    const kindTabs = [["", `全部 ${entries.length}`], ["rule", `规范 ${count("rule")}`], ["fact", `事实 ${count("fact")}`], ["event", `其他 ${count("event")}`]];
    body.innerHTML = `
      <div class="mx-split">
        <div class="mx-nav">${all.map((n) => `<button data-ns="${esc(n)}" class="${n === memoryNs ? "on" : ""}">${esc(nsLabel(n))}</button>`).join("")}</div>
        <div class="mx-main">
          <div class="mx-inline"><select id="mm-kind" class="skin-select"><option value="rule" ${kindFilter !== "fact" ? "selected" : ""}>规范</option><option value="fact" ${kindFilter === "fact" ? "selected" : ""}>事实/偏好</option></select><input id="mm-add" placeholder="记一条：例如「回答先给结论再展开」" /><button class="primary-btn" id="mm-add-btn">记住</button></div>
          <div class="mm-kinds">${kindTabs.map(([k, label]) => `<button data-kind="${k}" class="${k === kindFilter ? "on" : ""}">${label}</button>`).join("")}</div>
          <div class="mx-inline"><input id="mm-filter" placeholder="搜索 ${entries.length} 条记忆" value="${esc(filter)}" /></div>
          <div class="mm-list">${shown.map((e) => `
            <div class="d-card"><div class="c-main"><div class="c-title wrap">${esc(e.content)}</div><div class="c-sub">${esc(MEMORY_KIND[e.kind] || e.kind)}${e.source ? ` · ${esc(MEMORY_SOURCE[e.source] || e.source)}` : ""}${e.createdAt ? ` · ${esc(fmtTime(e.createdAt))}` : ""}</div></div>
              <button class="icon-btn" data-del="${esc(e.id)}" title="删除">✕</button></div>`).join("") || `<div class="d-empty">${filter ? "没有匹配的记忆" : "还没有记忆。对 bot 说「记住：…」，或在上面手动添加"}</div>`}</div>
          <h4 class="mx-h">MEMORY.md 总结 <span><button class="ghost-btn" id="mm-rewrite">✨ 用模型重写</button><button class="ghost-btn" id="mm-merge">🧹 合并重复</button></span></h4>
          <textarea id="mm-memo" rows="7" placeholder="还没有总结">${esc(memo)}</textarea>
          <div class="actions"><button class="primary-btn" id="mm-save" disabled>保存总结</button></div>
        </div>
      </div>`;
    body.querySelectorAll("[data-ns]").forEach((b) => (b.onclick = () => { memoryNs = b.dataset.ns; filter = ""; render(); }));
    body.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { kindFilter = b.dataset.kind; render(); }));
    const add = async () => {
      const v = body.querySelector("#mm-add").value.trim();
      if (!v) return;
      const owner = memoryNs.startsWith("bot:") ? memoryNs.slice(4) : currentBot?.id ?? bots[0]?.id ?? "user";
      await api.memory.add(owner, { kind: body.querySelector("#mm-kind").value, content: v, tags: ["手动"], source: "manual", namespace: memoryNs });
      render();
    };
    body.querySelector("#mm-add-btn").onclick = add;
    body.querySelector("#mm-add").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) add(); };
    const f = body.querySelector("#mm-filter");
    f.oninput = () => { filter = f.value; render().then(() => { const x = body.querySelector("#mm-filter"); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }); };
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { await api.memory.remove(memoryNs, b.dataset.del); render(); }));
    const memoEl = body.querySelector("#mm-memo");
    const save = body.querySelector("#mm-save");
    memoEl.oninput = () => (save.disabled = false);
    save.onclick = async () => { await api.memory.setMemo(memoryNs, memoEl.value); save.textContent = "已保存"; save.disabled = true; };
    body.querySelector("#mm-rewrite").onclick = async (e) => {
      e.target.textContent = "生成中…";
      e.target.disabled = true;
      try { await api.memory.rewriteMemo(memoryNs); } catch (err) { alert(errText(err)); }
      render();
    };
    body.querySelector("#mm-merge").onclick = async () => { await api.memory.merge(memoryNs); render(); };
  };
  render();
}

/* ---- 技能 ---- */
async function skillsFlow() {
  const modal = sheet({ icon: "🛠", title: "技能", sub: "技能是一段说明书（SKILL.md），bot 遇到对应任务时会按它来做", wide: true });
  const body = modal.querySelector(".mx-body");
  const render = async () => {
    const all = await api.skills.list();
    body.innerHTML = `
      <div class="mx-inline"><input id="ms-create" placeholder="一句话描述技能，AI 帮你写：例如「周报，每周五总结本周工作」" /><button class="ghost-btn" id="ms-create-btn">AI 生成</button><button class="primary-btn" id="ms-new">＋ 手动新建</button></div>
      <div class="ms-err hint"></div>
      ${all.map((k) => `
        <div class="d-card skill-card" data-key="${esc(k.key)}">
          <div class="c-main"><div class="c-title">${esc(k.name)} <span class="tag">${k.owner ? `仅 ${esc(botById(k.owner)?.name ?? "某个 bot")}` : "共享"}</span></div><div class="c-sub" title="${esc(k.description)}">${esc(k.description)}</div></div>
          <label class="switch" title="启用"><input type="checkbox" data-on="${esc(k.key)}" ${k.enabled ? "checked" : ""}/><span></span></label>
        </div>`).join("") || `<div class="d-empty">还没有技能</div>`}`;
    const editorBot = currentBot ?? bots[0];
    body.querySelector("#ms-new").onclick = () => skillEditor(null, editorBot, skillsFlow);
    body.querySelectorAll(".skill-card").forEach((card) => (card.onclick = (e) => {
      if (e.target.closest(".switch")) return;
      const k = all.find((x) => x.key === card.dataset.key);
      if (k) skillEditor(k, botById(k.owner) ?? editorBot, skillsFlow);
    }));
    body.querySelectorAll("[data-on]").forEach((inp) => (inp.onchange = () => api.skills.setEnabled(inp.dataset.on, inp.checked)));
    const create = async () => {
      const input = body.querySelector("#ms-create");
      const v = input.value.trim();
      if (!v) {
        body.querySelector(".ms-err").textContent = "先在输入框里写一句话，例如：周报，每周五总结本周工作";
        input.focus();
        return;
      }
      body.querySelector(".ms-err").textContent = "";
      const btn = body.querySelector("#ms-create-btn");
      btn.textContent = "AI 生成中…";
      btn.disabled = true;
      try {
        const k = await api.skills.create(v);
        await render();
        skillEditor(k, botById(k.owner) ?? editorBot, skillsFlow);
      } catch (e) { body.querySelector(".ms-err").textContent = `创建失败：${errText(e)}`; btn.textContent = "AI 生成"; btn.disabled = false; }
    };
    body.querySelector("#ms-create-btn").onclick = create;
    body.querySelector("#ms-create").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) create(); };
  };
  render();
}

/* ---- 定时任务 ---- */
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
function describeCron(cron) {
  const [mi, h, d, mo, w] = String(cron).trim().split(/\s+/);
  const t = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
  if (mi === "*" && h === "*" && d === "*" && mo === "*" && w === "*") return "每分钟";
  if (/^\*\/\d+$/.test(mi) && h === "*" && d === "*" && w === "*") return `每 ${mi.slice(2)} 分钟`;
  if (/^\d+$/.test(mi) && h === "*" && d === "*" && w === "*") return `每小时第 ${mi} 分`;
  if (t && d === "*" && mo === "*" && w === "*") return `每天 ${t}`;
  if (t && d === "*" && mo === "*" && w === "1-5") return `工作日 ${t}`;
  if (t && d === "*" && mo === "*" && /^\d$/.test(w)) return `每周${WEEK[Number(w) % 7]} ${t}`;
  if (t && /^\d+$/.test(d) && mo === "*" && w === "*") return `每月 ${d} 日 ${t}`;
  return cron;
}
async function tasksFlow() {
  const modal = sheet({ icon: "⏰", title: "定时任务", sub: "到点自动唤醒 bot 去做事；一次性提醒会让宠物冒气泡", wide: true });
  const body = modal.querySelector(".mx-body");
  let mode = "repeat";
  const render = async () => {
    const tasks = await api.tasks.list();
    const sel = currentBot?.id ?? bots[0]?.id;
    body.innerHTML = `${notifyBlocked ? NOTIFY_HINT() : ""}
      <div class="d-sec mx-form">
        <div class="mx-seg"><button data-mode="repeat" class="${mode === "repeat" ? "on" : ""}">周期任务</button><button data-mode="once" class="${mode === "once" ? "on" : ""}">一次性提醒</button></div>
        <div class="mx-grid">
          <label>交给</label><select id="tk-bot" class="skin-select">${botOptions(sel)}</select>
          ${mode === "repeat" ? `
          <label>频率</label><span class="mx-row">
            <select id="tk-freq" class="skin-select"><option value="day">每天</option><option value="work">工作日</option><option value="week">每周</option><option value="month">每月</option><option value="hour">每小时</option><option value="every">每隔几分钟</option><option value="cron">自定义 cron</option></select>
            <select id="tk-wd" class="skin-select">${WEEK.map((w, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>周${w}</option>`).join("")}</select>
            <input id="tk-md" type="number" min="1" max="28" value="1" class="mx-num" title="几号" />
            <input id="tk-time" type="time" value="09:00" />
            <input id="tk-min" type="number" min="1" max="59" value="30" class="mx-num" title="分钟" />
            <input id="tk-cron" placeholder="0 9 * * *" />
          </span>
          <label>任务名</label><input id="tk-name" placeholder="每日早报" />
          <label>要做什么</label><textarea id="tk-prompt" rows="2" placeholder="生成今日早报：国内外要闻 5 条，各一句话"></textarea>` : `
          <label>多久后</label><span class="mx-row"><input id="tk-after" type="number" min="1" value="15" class="mx-num" /> 分钟</span>
          <label>提醒内容</label><input id="tk-text" placeholder="喝水、起来活动一下" />
          <label></label><label class="chk"><input id="tk-pet" type="checkbox" checked /> 让宠物冒气泡提醒</label>`}
        </div>
        <div class="tk-err hint"></div>
        <div class="actions"><button class="primary-btn" id="tk-add">${mode === "repeat" ? "添加任务" : "添加提醒"}</button></div>
      </div>
      <div class="d-sec"><h4>全部任务 · ${tasks.length}</h4>
        ${tasks.map((t) => `
          <div class="d-card" data-id="${esc(t.id)}">
            <div class="c-main"><div class="c-title">${esc(t.name)} <span class="tag">${esc(botById(t.botId)?.name ?? "已删除的 bot")}</span></div>
              <div class="c-sub">${t.kind === "once" ? `🔔 一次性 · ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : "已触发"}` : `${esc(describeCron(t.cron))}${t.nextRunAt && t.enabled ? ` · 下次 ${esc(fmtTime(t.nextRunAt))}` : ""}`} · 已运行 ${t.runCount ?? 0} 次${t.lastResult ? ` · 上次${t.lastResult === "ok" ? "成功" : "失败"}` : ""}</div></div>
            <button class="icon-btn" data-op="run" title="立即执行">⚡</button>
            <button class="icon-btn" data-op="del" title="删除">✕</button>
            <label class="switch" title="启用"><input type="checkbox" data-op="toggle" ${t.enabled ? "checked" : ""}/><span></span></label>
          </div>`).join("") || `<div class="d-empty">还没有定时任务。也可以直接对 bot 说「每天早上 9 点给我发早报」</div>`}
      </div>`;
    body.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { mode = b.dataset.mode; render(); }));
    const freq = body.querySelector("#tk-freq");
    const syncFreq = () => {
      if (!freq) return;
      const v = freq.value;
      const show = (id, on) => (body.querySelector(id).style.display = on ? "" : "none");
      show("#tk-wd", v === "week"); show("#tk-md", v === "month"); show("#tk-time", ["day", "work", "week", "month"].includes(v));
      show("#tk-min", v === "every" || v === "hour"); show("#tk-cron", v === "cron");
      body.querySelector("#tk-min").title = v === "hour" ? "每小时的第几分" : "每隔几分钟";
    };
    if (freq) { freq.onchange = syncFreq; syncFreq(); }
    const err = body.querySelector(".tk-err");
    body.querySelector("#tk-add").onclick = async () => {
      const botId = body.querySelector("#tk-bot").value;
      try {
        if (mode === "repeat") {
          const [hh, mm] = body.querySelector("#tk-time").value.split(":").map(Number);
          const m = Number(body.querySelector("#tk-min").value) || 30;
          const cron = { day: `${mm} ${hh} * * *`, work: `${mm} ${hh} * * 1-5`, week: `${mm} ${hh} * * ${body.querySelector("#tk-wd").value}`, month: `${mm} ${hh} ${body.querySelector("#tk-md").value} * *`, hour: `${m % 60} * * * *`, every: `*/${m} * * * *`, cron: body.querySelector("#tk-cron").value.trim() }[freq.value];
          const prompt = body.querySelector("#tk-prompt").value.trim();
          if (!prompt) { err.textContent = "写一下要做什么"; return; }
          await api.tasks.create({ botId, name: body.querySelector("#tk-name").value.trim() || prompt.slice(0, 16), cron, prompt });
        } else {
          const text = body.querySelector("#tk-text").value.trim() || "时间到了";
          await api.tasks.create({ botId, name: `🔔 ${text}`, cron: "* * * * *", prompt: text, kind: "once", alarmAt: Date.now() + Math.max(1, Number(body.querySelector("#tk-after").value) || 15) * 60_000, notifyPet: body.querySelector("#tk-pet").checked });
        }
        render();
        if (currentBot) renderDetails(currentBot);
      } catch (e) { err.textContent = errText(e); }
    };
    body.querySelectorAll(".d-card[data-id]").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-op="run"]').onclick = async (e) => { e.target.textContent = "…"; await api.tasks.runNow(id); render(); };
      card.querySelector('[data-op="del"]').onclick = async () => {
        if (!confirm("删除这个任务？")) return;
        await api.tasks.remove(id);
        render();
        if (currentBot) renderDetails(currentBot);
      };
      card.querySelector('[data-op="toggle"]').onchange = (e) => api.tasks.setEnabled(id, e.target.checked);
    });
  };
  render();
}

/* ---- MCP ---- */
async function mcpFlow() {
  const modal = sheet({ icon: "🔌", title: "MCP 工具", sub: "电脑操控一键开关即可；其它 MCP 可按需添加", wide: true });
  const body = modal.querySelector(".mx-body");
  let servers = await (api.mcp.serversAll?.() || api.mcp.servers()).catch(() => []);
  let tools = await api.mcp.list().catch(() => []);
  let cu = await api.computerUse.status().catch(() => null);
  let editing = null;
  let busy = false;
  let cuBusy = false;
  let cuProgress = "";
  const refresh = async () => {
    if (!modal.isConnected) return stop();
    if (busy || editing || cuBusy) return;
    servers = await (api.mcp.serversAll?.() || api.mcp.servers()).catch(() => servers);
    tools = await api.mcp.list().catch(() => tools);
    cu = await api.computerUse.status().catch(() => cu);
    render();
  };
  const off = api.onAppChanged((what) => { if (what === "mcp") refresh(); });
  const offProg = api.computerUse.onProgress?.((msg) => { cuProgress = msg; if (cuBusy) render(); });
  function stop() { off?.(); offProg?.(); }
  const save = async (next) => {
    busy = true; render();
    servers = await api.mcp.saveServers(next.map(({ tools: _t, error: _e, connected: _c, ...s }) => s)).catch((e) => { alert(errText(e)); return servers; });
    servers = await (api.mcp.serversAll?.() || api.mcp.servers()).catch(() => servers);
    tools = await api.mcp.list().catch(() => []);
    busy = false; editing = null; render();
  };
  const toggleCu = async (on) => {
    cuBusy = true; cuProgress = on ? "正在配置…" : "正在关闭…"; render();
    try {
      cu = await api.computerUse.setEnabled(on);
      tools = await api.mcp.list().catch(() => tools);
      servers = await (api.mcp.serversAll?.() || api.mcp.servers()).catch(() => servers);
    } catch (e) {
      alert(`电脑操控配置失败：${errText(e)}`);
      cu = await api.computerUse.status().catch(() => cu);
    }
    cuBusy = false; cuProgress = ""; render();
  };
  const render = () => {
    const others = servers.filter((s) => s.id !== "computer");
    const steps = cu?.steps?.length
      ? `<div class="cu-steps">${cu.steps.map((s) => `<div class="cu-step ${s.ok ? "ok" : ""}"><span class="cu-dot">${s.ok ? "✓" : "·"}</span><div><b>${esc(s.label)}</b><em>${esc(s.detail || "")}</em></div></div>`).join("")}</div>`
      : "";
    body.innerHTML = `
      <div class="d-sec">
        <div class="d-card" style="align-items:flex-start">
          <div class="c-main"><div class="c-title">电脑操控 <span class="tag">内置</span></div>
            <div class="c-sub">看屏幕、点按钮、打字（辅助功能树，不抢鼠标）。打开开关会自动装好运行时、自检，并引导开权限。</div>
            ${cuBusy ? `<div class="hint">${esc(cuProgress || "处理中…")}</div>` : steps}
            ${cu?.doctor && cu.enabled ? `<div class="hint" title="${esc(cu.doctor)}">自检：${esc(cu.doctor.slice(0, 120))}${cu.doctor.length > 120 ? "…" : ""}</div>` : ""}
            ${cu?.error && cu.enabled ? `<div class="hint" style="color:#b42318">✕ ${esc(cu.error)}</div>` : ""}
          </div>
          <label class="switch" title="电脑操控"><input type="checkbox" id="cu-on" ${cu?.enabled ? "checked" : ""} ${cuBusy ? "disabled" : ""}/><span></span></label>
        </div>
        ${cu?.enabled ? `<div class="actions" style="margin-top:8px">${!cu.permissions?.accessibility ? `<button class="ghost-btn" id="cu-acc">开辅助功能</button>` : ""}${!cu.permissions?.screen ? `<button class="ghost-btn" id="cu-screen">开屏幕录制</button>` : ""}<button class="ghost-btn" id="cu-recheck">重新检测</button></div>` : ""}
      </div>
      <div class="d-sec"><h4>其它 Server <button class="list-add" id="mc-new" title="添加">＋</button></h4>
        ${busy ? `<div class="d-empty">正在连接…</div>` : ""}
        ${others.map((s, i) => {
          const idx = servers.indexOf(s);
          return `
          <div class="d-card mc-card" data-i="${idx}">
            <span class="ws-dot ${s.error ? "" : s.tools ? "on" : ""}"></span>
            <div class="c-main"><div class="c-title">${esc(s.name)} <span class="tag">${s.url ? "HTTP" : "本地命令"}</span></div>
              <div class="c-sub">${s.enabled === false ? "已关闭" : s.error ? `✕ ${esc(s.error)}` : `${s.tools} 个工具`} · ${esc(s.url ?? [s.command, ...(s.args ?? [])].join(" "))}</div></div>
            <button class="ghost-btn" data-op="tools">工具</button><button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button>
          </div>
          <div class="mc-tools hidden" data-tools="${idx}">${tools.filter((t) => t.serverId === s.id).map((t) => `<div class="mc-tool"><b>${esc(t.name)}</b><span>${esc(t.description || "")}</span></div>`).join("") || `<div class="d-empty">没有工具</div>`}</div>`;
        }).join("") || (busy ? "" : `<div class="d-empty">还没有其它 MCP。点 ＋ 添加</div>`)}
      </div>
      ${editing ? `
      <div class="d-sec mx-form">
        <h4>${editing.id ? `编辑「${esc(editing.name)}」` : "添加 MCP server"}</h4>
        <div class="mx-seg"><button data-t="cmd" class="${editing.url === undefined ? "on" : ""}">本地命令</button><button data-t="url" class="${editing.url !== undefined ? "on" : ""}">HTTP 地址</button></div>
        <div class="mx-grid">
          <label>名称</label><input id="mc-name" value="${esc(editing.name ?? "")}" placeholder="filesystem" />
          ${editing.url !== undefined ? `<label>URL</label><input id="mc-url" value="${esc(editing.url)}" placeholder="http://localhost:3000/mcp" />
          <label>请求头</label><input id="mc-headers" value="${esc(Object.entries(editing.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("; "))}" placeholder="Authorization: Bearer {{secret:GITHUB_TOKEN}}（可选，多个用 ; 隔开）" />`
          : `<label>命令</label><input id="mc-cmd" value="${esc([editing.command, ...(editing.args ?? [])].filter(Boolean).join(" "))}" placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents" />
          <label>环境变量</label><input id="mc-env" value="${esc(Object.entries(editing.env ?? {}).map(([k, v]) => `${k}=${v}`).join("; "))}" placeholder="GITHUB_TOKEN={{secret:GITHUB_TOKEN}}（可选，多个用 ; 隔开）" />`}
        </div>
        <div class="hint">Token 不要明文填：先在 [环境配置] 里让 bot 用加密框保存，这里写 {{secret:名字}}，连接时才解密，config.json 里只存占位。</div>
        <div class="actions"><button class="ghost-btn" id="mc-cancel">取消</button><button class="primary-btn" id="mc-save">保存并连接</button></div>
      </div>` : ""}`;
    body.querySelector("#cu-on")?.addEventListener("change", (e) => { void toggleCu(e.target.checked); });
    body.querySelector("#cu-acc")?.addEventListener("click", () => api.system.openPrefs("accessibility"));
    body.querySelector("#cu-screen")?.addEventListener("click", () => api.system.openPrefs("screen"));
    body.querySelector("#cu-recheck")?.addEventListener("click", async () => {
      cuBusy = true; cuProgress = "正在检测…"; render();
      cu = await (api.computerUse.doctor?.() || api.computerUse.status()).catch(() => api.computerUse.status());
      cuBusy = false; cuProgress = ""; render();
    });
    body.querySelector("#mc-new").onclick = () => { editing = { name: "" }; render(); };
    body.querySelectorAll(".mc-card").forEach((card) => (card.onclick = (e) => {
      const i = Number(card.dataset.i);
      const op = e.target.closest("button")?.dataset.op;
      if (op === "tools") body.querySelector(`[data-tools="${i}"]`).classList.toggle("hidden");
      if (op === "edit") { editing = { ...servers[i] }; render(); }
      if (op === "del" && confirm(`删除 MCP server「${servers[i].name}」？`)) save(servers.filter((_, k) => k !== i));
    }));
    if (!editing) return;
    body.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => {
      editing.name = body.querySelector("#mc-name").value;
      if (b.dataset.t === "url") editing.url = editing.url ?? ""; else delete editing.url;
      render();
    }));
    body.querySelector("#mc-cancel").onclick = () => { editing = null; render(); };
    body.querySelector("#mc-save").onclick = () => {
      const name = body.querySelector("#mc-name").value.trim();
      if (!name) return alert("填一个名称");
      const s = { id: editing.id ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now()}`), name };
      if (editing.url !== undefined) {
        s.url = body.querySelector("#mc-url").value.trim();
        if (!s.url) return alert("填 URL");
        const headers = Object.fromEntries(body.querySelector("#mc-headers").value.split(";").map((x) => x.split(":")).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(":").trim()]));
        if (Object.keys(headers).length) s.headers = headers;
      } else {
        const parts = body.querySelector("#mc-cmd").value.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((x) => x.replace(/^["']|["']$/g, "")) ?? [];
        if (!parts.length) return alert("填启动命令");
        s.command = parts[0];
        s.args = parts.slice(1);
        const env = Object.fromEntries(body.querySelector("#mc-env").value.split(";").map((x) => x.split("=")).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
        if (Object.keys(env).length) s.env = env;
      }
      const next = editing.id ? servers.map((x) => (x.id === editing.id ? s : x)) : [...servers.filter((x) => x.id !== s.id), s];
      save(next);
    };
  };
  render();
}

/* ---- 群组 ---- */
async function groupsFlow() {
  const modal = sheet({ icon: "👥", title: "群聊", sub: "拉几个 bot 建群：你发一句，成员轮流接话，可以互相 @ 接力讨论" });
  const body = modal.querySelector(".mx-body");
  const picked = new Set(currentBot ? [currentBot.id] : []);
  const render = async () => {
    const gs = await api.groups.list();
    body.innerHTML = `
      <div class="d-sec mx-form"><h4>新建群聊</h4>
        <input id="gf-name" placeholder="群名，例如「产品组」" />
        <div class="gf-members">${bots.map((b) => `<button class="gf-m ${picked.has(b.id) ? "on" : ""}" data-id="${esc(b.id)}"><span class="bot-avatar">${avatarHtml(b)}</span>${esc(b.name)}</button>`).join("")}</div>
        <div class="gf-err hint"></div>
        <div class="actions"><button class="primary-btn" id="gf-add">创建（已选 ${picked.size} 个）</button></div>
      </div>
      <div class="d-sec"><h4>已有群聊 · ${gs.length}</h4>
        ${gs.map((g) => `
          <div class="d-card gf-card" data-id="${esc(g.id)}" style="cursor:pointer">
            <div class="group-avatars">${g.members.map(botById).filter(Boolean).slice(0, 3).map((m) => `<span>${avatarHtml(m)}</span>`).join("") || "<span>👥</span>"}</div>
            <div class="c-main"><div class="c-title">${esc(g.name)}</div><div class="c-sub">${g.members.map((m) => esc(botById(m)?.name || "?")).join("、")}</div></div>
            <button class="ghost-btn danger-text" data-del>解散</button>
          </div>`).join("") || `<div class="d-empty">还没有群聊</div>`}
      </div>`;
    const nameEl = body.querySelector("#gf-name");
    body.querySelectorAll(".gf-m").forEach((b) => (b.onclick = () => {
      picked.has(b.dataset.id) ? picked.delete(b.dataset.id) : picked.add(b.dataset.id);
      const v = nameEl.value;
      render().then(() => (body.querySelector("#gf-name").value = v));
    }));
    body.querySelector("#gf-add").onclick = async () => {
      const name = body.querySelector("#gf-name").value.trim();
      const err = body.querySelector(".gf-err");
      if (!name) { err.textContent = "起个群名"; return; }
      if (picked.size < 2) { err.textContent = "至少选 2 个成员"; return; }
      const members = bots.map((b) => b.id).filter((id) => picked.has(id));
      const g = await api.groups.create(name, members);
      closeModal();
      await refreshBots();
      selectGroup(groupList.find((x) => x.id === g.id) ?? g);
    };
    body.querySelectorAll(".gf-card").forEach((card) => (card.onclick = async (e) => {
      const id = card.dataset.id;
      if (e.target.closest("[data-del]")) {
        if (!confirm("解散这个群聊？（聊天记录保留）")) return;
        await api.groups.remove(id);
        if (currentGroup?.id === id) { currentGroup = null; currentSession = null; clearMessages(); $("#chat-bar").classList.add("hidden"); $("#empty-state").style.display = ""; }
        await refreshBots();
        return render();
      }
      closeModal();
      await refreshBots();
      const g = groupList.find((x) => x.id === id);
      if (g) selectGroup(g);
    }));
  };
  render();
}

/* ---- 编排 ---- */
async function plansFlow() {
  const modal = sheet({ icon: "🧩", title: "编排", sub: "一句话让几个 bot 按阶段接力完成一件事，前一阶段的产出交给下一阶段", wide: true });
  const body = modal.querySelector(".mx-body");
  const STATUS = { done: "已完成", error: "失败", running: "进行中", pending: "未开始" };
  const ICON = { done: "✓", error: "✕", running: "", pending: "○" };
  /** 用户手动展开的结果 / 阶段产出（plan.id 或 stage.id），刷新时保持 */
  const opened = new Set();
  const cardErr = new Map();
  let plans = [];
  const sigs = new Map();
  body.innerHTML = `
    <div class="d-sec mx-form">
      <textarea id="pl-text" rows="2" placeholder="例如：让 ${esc(bots[0]?.name || "A")} 调研竞品，${esc(bots[1]?.name || "B")} 总结要点，${esc(bots[2]?.name || "C")} 写成报告"></textarea>
      <div class="mx-chips">${bots.map((b) => `<button class="mx-chip" data-name="${esc(b.name)}">＋ ${esc(b.name)}</button>`).join("")}</div>
      <div class="pl-err hint"></div>
      <div class="actions"><button class="primary-btn" id="pl-go">拆解并运行</button></div>
    </div>
    <div class="d-sec"><h4>计划 · <span id="pl-count">0</span></h4><div id="pl-list"></div></div>`;
  const ta = body.querySelector("#pl-text");
  const list = body.querySelector("#pl-list");
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };
  const liveText = (t) => (t || "").replace(/```tool[\s\S]*?(```|$)/g, "").trim();
  const sigOf = (p) => JSON.stringify([p.status, p.result, p.stages.map((st) => [st.status, st.error, !!st.result])]);

  const stepHtml = (p, st, i) => {
    const bot = botById(st.botId);
    const time = st.status === "running" && st.startedAt ? `<span class="pl-time" data-since="${st.startedAt}">${dur(Date.now() - st.startedAt)}</span>`
      : st.startedAt && st.finishedAt ? `<span class="pl-time">${dur(st.finishedAt - st.startedAt)}</span>` : "";
    let extra = "";
    if (st.status === "running") {
      const t = liveText(st.live);
      extra = `<div class="pl-activity" data-act="${esc(st.id)}">${esc(st.activity || (t ? "正在写…" : "思考中…"))}</div>
        <div class="pl-live ${t ? "" : "empty"}" data-live="${esc(st.id)}">${esc(t)}</div>`;
    } else if (st.status === "error" && st.error) {
      extra = `<div class="pl-step-err">${esc(st.error)}</div>`;
    } else if (st.status === "done" && st.result) {
      extra = `<details class="pl-out" data-key="${esc(st.id)}" ${opened.has(st.id) ? "open" : ""}><summary>这一步的产出</summary><div class="pl-md">${renderMarkdown(esc(st.result))}</div></details>`;
    }
    const ownerId = st.ownerBotId || st.botId;
    const owner = botById(ownerId);
    const ownerTag = ownerId !== st.botId
      ? `<span class="tag" title="已移交">负责人 ${esc(owner?.name || ownerId)}</span>`
      : "";
    const note = st.handOffNote ? `<div class="hint">移交：${esc(st.handOffNote)}</div>` : "";
    return `<div class="pl-step s-${esc(st.status)}">
      <div class="pl-step-row"><span class="pl-dot">${ICON[st.status] ?? "○"}</span>
        <span class="pl-step-bot">${i + 1}. ${esc(bot?.name || "已删除的 bot")}${st.mode === "fan" ? '<span class="tag">并行</span>' : ""}${ownerTag}</span>
        <span class="pl-step-prompt" title="${esc(st.prompt || "")}">${esc(st.prompt || "")}</span>${time}</div>${note}${extra}</div>`;
  };

  const cardHtml = (p) => {
    const running = p.status === "running";
    const doneN = p.stages.filter((st) => st.status === "done").length;
    const label = p.status === "error" && p.result === "（已取消）" ? "已取消" : STATUS[p.status] ?? p.status;
    const total = p.startedAt && p.finishedAt ? ` · 用时 ${dur(p.finishedAt - p.startedAt)}` : "";
    const failed = p.status === "error";
    const result = !p.result ? "" : failed
      ? `<div class="pl-step-err">${esc(p.result)}</div>`
      : `<details class="pl-result" data-key="${esc(p.id)}" ${opened.has(p.id) ? "open" : ""}><summary>最终结果</summary><div class="pl-md">${renderMarkdown(esc(p.result))}</div><button class="ghost-btn" data-op="copy">复制结果</button></details>`;
    return `<div class="pl-card ${running ? "running" : ""}" data-id="${esc(p.id)}">
      <div class="pl-head"><b title="${esc(p.title)}">${esc(p.title)}</b>
        <span class="pl-st st-${esc(p.status)}">${esc(label)}${running ? ` · ${doneN}/${p.stages.length}` : ""}${(() => {
          const cur = p.stages.find((s) => s.status === "running") || p.stages.find((s) => s.status === "pending");
          if (!cur) return "";
          const oid = cur.ownerBotId || cur.botId;
          const on = botById(oid)?.name || oid;
          return ` · 当前负责人 ${esc(on)}`;
        })()}</span>
        ${running && p.startedAt ? `<span class="pl-time" data-since="${p.startedAt}">${dur(Date.now() - p.startedAt)}</span>` : total ? `<span class="pl-time">${esc(total.slice(3))}</span>` : ""}
        <span class="mx-ops">${running ? `<button class="ghost-btn" data-op="cancel">停止</button>` : `<button class="ghost-btn" data-op="run">${p.status === "pending" ? "运行" : "重新运行"}</button><button class="icon-btn" data-op="del" title="删除">✕</button>`}</span></div>
      ${running ? `<div class="pl-bar"><i style="width:${Math.round((doneN / p.stages.length) * 100)}%"></i></div>` : ""}
      <div class="pl-steps">${p.stages.map((st, i) => stepHtml(p, st, i)).join("")}</div>
      ${result}
      ${cardErr.get(p.id) ? `<div class="pl-step-err">${esc(cardErr.get(p.id))}</div>` : ""}
    </div>`;
  };

  const bindCard = (card) => {
    card.querySelectorAll("details[data-key]").forEach((d) => d.addEventListener("toggle", () => {
      if (d.open) opened.add(d.dataset.key); else opened.delete(d.dataset.key);
    }));
    card.querySelectorAll(".pl-live").forEach((el) => (el.scrollTop = el.scrollHeight));
  };
  const renderCard = (p) => {
    sigs.set(p.id, sigOf(p));
    const old = list.querySelector(`.pl-card[data-id="${CSS.escape(p.id)}"]`);
    if (!old) return renderAll();
    old.outerHTML = cardHtml(p);
    bindCard(list.querySelector(`.pl-card[data-id="${CSS.escape(p.id)}"]`));
  };
  const renderAll = () => {
    body.querySelector("#pl-count").textContent = plans.length;
    list.innerHTML = plans.map(cardHtml).join("") || `<div class="d-empty">还没有编排计划</div>`;
    plans.forEach((p) => sigs.set(p.id, sigOf(p)));
    list.querySelectorAll(".pl-card").forEach(bindCard);
  };
  /** 只有实时产出变了：原地更新文字，不重画卡片（不打断阅读和滚动） */
  const patchLive = (p) => {
    for (const st of p.stages) {
      if (st.status !== "running") continue;
      const t = liveText(st.live);
      const el = list.querySelector(`[data-live="${CSS.escape(st.id)}"]`);
      if (el && el.textContent !== t) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        el.textContent = t;
        el.classList.toggle("empty", !t);
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
      const act = list.querySelector(`[data-act="${CSS.escape(st.id)}"]`);
      if (act) act.textContent = st.activity || (t ? "正在写…" : "思考中…");
    }
  };
  const apply = (p) => {
    const i = plans.findIndex((x) => x.id === p.id);
    const prev = plans[i];
    if (i < 0) { plans.unshift(p); return renderAll(); }
    plans[i] = p;
    if (prev.status === "running" && p.status === "done") opened.add(p.id);
    if (sigs.get(p.id) !== sigOf(p)) renderCard(p); else patchLive(p);
  };
  const refresh = async () => { plans = await api.plans.list(); renderAll(); };

  const start = async (id) => {
    cardErr.delete(id);
    const p = plans.find((x) => x.id === id);
    if (p) {
      p.status = "running";
      p.result = undefined;
      p.startedAt = Date.now();
      p.finishedAt = undefined;
      p.stages = p.stages.map((st) => ({ ...st, status: "pending", result: undefined, error: undefined, startedAt: undefined, finishedAt: undefined, live: undefined, activity: undefined }));
      opened.delete(id);
      p.stages.forEach((st) => opened.delete(st.id));
      renderCard(p);
    }
    try { apply(await api.plans.run(id)); }
    catch (x) { cardErr.set(id, errText(x)); await refresh(); }
  };

  body.querySelectorAll("[data-name]").forEach((b) => (b.onclick = () => { ta.value += (ta.value && !/[，,\s]$/.test(ta.value) ? "，" : "") + `让 ${b.dataset.name} `; ta.focus(); }));
  const go = body.querySelector("#pl-go");
  go.onclick = async () => {
    const text = ta.value.trim();
    const err = body.querySelector(".pl-err");
    err.textContent = "";
    if (!text) { err.textContent = "写一下要做什么、交给谁"; return; }
    go.disabled = true;
    go.textContent = "正在拆解成阶段…";
    try {
      const plan = await api.plans.createFromText(text);
      ta.value = "";
      plans.unshift(plan);
      renderAll();
      list.scrollIntoView({ block: "start", behavior: "smooth" });
      void start(plan.id);
    } catch (x) { err.textContent = errText(x); }
    go.disabled = false;
    go.textContent = "拆解并运行";
  };
  list.onclick = async (e) => {
    const btn = e.target.closest("button[data-op]");
    if (!btn) return;
    const id = btn.closest(".pl-card").dataset.id;
    const op = btn.dataset.op;
    if (op === "copy") { api.system.copy(plans.find((p) => p.id === id)?.result ?? ""); btn.textContent = "已复制"; }
    if (op === "cancel") { btn.disabled = true; btn.textContent = "正在停止…"; await api.plans.cancel(id); }
    if (op === "del") { if (!confirm("删除这个计划？")) return; await api.plans.remove(id); await refresh(); }
    if (op === "run") void start(id);
  };

  const offUpdate = api.onPlanUpdate((p) => { if (!modal.isConnected) return stop(); apply(p); });
  const tick = setInterval(() => {
    if (!modal.isConnected) return stop();
    list.querySelectorAll("[data-since]").forEach((el) => (el.textContent = dur(Date.now() - Number(el.dataset.since))));
  }, 1000);
  function stop() { offUpdate(); clearInterval(tick); }
  await refresh();
}

/* ---- 系统授权 ---- */
async function sysaccessFlow() {
  const modal = sheet({ icon: "🛡", title: "系统授权", sub: "bot 默认不能动你的电脑；要用时会在会话里请你批准，所有操作都有记录", wide: true });
  const body = modal.querySelector(".mx-body");
  let auditBot = "";
  const render = async () => {
    const [tcc, grants, caps, events, cmd] = await Promise.all([
      api.system.tcc().catch(() => ({})), api.consent.list(), api.consent.caps(), api.audit.list({ limit: 200 }).catch(() => []),
      api.consent.rules().catch(() => ({ rules: [], trusted: [] })),
    ]);
    const ruleBot = (id) => (id === "*" ? "所有 bot" : botById(id)?.name || id);
    const capLabel = (id) => caps.find((c) => c.id === id)?.label || id;
    const shown = events.filter((ev) => !auditBot || ev.botId === auditBot).slice(0, 60);
    body.innerHTML = `
      <div class="d-sec"><h4>电脑操控</h4>
        <div class="d-card"><div class="c-main"><div class="c-title">一键启用</div><div class="c-sub">自动安装运行时并连接；再到下面勾系统权限即可</div></div>
          <button class="primary-btn" id="sa-cu">打开 MCP 里的开关</button></div>
      </div>
      <div class="d-sec"><h4>macOS 权限</h4>
        <div class="d-card"><div class="c-main"><div class="c-title">辅助功能</div><div class="c-sub">bot 操作其他 App（点击、输入）需要</div></div>
          ${tcc.accessibility ? '<span class="tag on">已授权</span>' : '<button class="ghost-btn" data-pref="accessibility">去授权</button>'}</div>
        <div class="d-card"><div class="c-main"><div class="c-title">屏幕录制</div><div class="c-sub">bot 截屏看屏幕需要</div></div>
          ${tcc.screen ? '<span class="tag on">已授权</span>' : '<button class="ghost-btn" data-pref="screen">去授权</button>'}</div>
      </div>
      <div class="d-sec"><h4>已批准的能力 · ${grants.length}</h4>
        ${grants.map((g) => `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(botById(g.botId)?.name || g.botId)} · ${esc(capLabel(g.cap))}</div>
            <div class="c-sub">${g.once ? "仅一次" : g.expiresAt ? `到 ${esc(fmtTime(g.expiresAt))}` : "长期"}${g.grantedAt ? ` · 批准于 ${esc(fmtTime(g.grantedAt))}` : ""}</div></div>
            <button class="ghost-btn danger-text" data-revoke="${esc(g.botId)}" data-cap="${esc(g.cap)}">撤销</button></div>`).join("") || `<div class="d-empty">还没有批准过任何能力</div>`}
        <div class="mx-inline sa-grant">
          <select id="sa-bot" class="skin-select">${botOptions(currentBot?.id)}</select>
          <select id="sa-cap" class="skin-select">${caps.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select>
          <select id="sa-ttl" class="skin-select"><option value="0">长期</option><option value="3600000">1 小时</option><option value="86400000">1 天</option><option value="once">仅一次</option></select>
          <button class="ghost-btn" id="sa-grant">预先批准</button>
        </div>
      </div>
      <div class="d-sec"><h4>命令规则 · ${cmd.rules.length}</h4>
        <div class="hint">「总是允许」的命令不再弹卡片；「禁止」的命令直接拦下。sudo、rm -rf / 这类危险命令不受规则影响，每次都要确认。</div>
        ${cmd.rules.map((r) => `
          <div class="d-card"><div class="c-main"><div class="c-title"><code>${esc(r.command)}</code> <span class="tag ${r.decision === "allow" ? "on" : ""}">${r.decision === "allow" ? "总是允许" : "禁止"}</span></div>
            <div class="c-sub">${esc(ruleBot(r.botId))} · ${esc(fmtTime(r.createdAt))}</div></div>
            <button class="ghost-btn danger-text" data-rule-bot="${esc(r.botId)}" data-rule-cmd="${esc(r.command)}">删除</button></div>`).join("") || `<div class="d-empty">还没有命令规则，bot 请求执行命令时点「总是允许」就会加到这里</div>`}
        <div class="mx-inline sa-grant">
          <select id="sa-rule-bot" class="skin-select"><option value="*">所有 bot</option>${botOptions(currentBot?.id)}</select>
          <input id="sa-rule-cmd" placeholder="命令名，例如 cursor" />
          <select id="sa-rule-dec" class="skin-select"><option value="allow">总是允许</option><option value="deny">禁止</option></select>
          <button class="ghost-btn" id="sa-rule-add">添加</button>
        </div>
        <div class="ms-err hint" id="sa-rule-err"></div>
      </div>
      <div class="d-sec"><h4>信任模式</h4>
        <div class="hint">打开后这个 bot 执行命令不再逐个询问。禁止规则仍然生效，危险命令仍要你确认，所有操作照常记录。</div>
        ${bots.map((b) => `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(b.name)}</div><div class="c-sub">${cmd.trusted.includes(b.id) ? "命令直接执行" : "每个新命令先问你"}</div></div>
            <label class="switch" title="信任模式"><input type="checkbox" data-trust="${esc(b.id)}" ${cmd.trusted.includes(b.id) ? "checked" : ""}/><span></span></label></div>`).join("")}
      </div>
      <div class="d-sec"><h4>操作记录 <span><select id="sa-filter" class="skin-select"><option value="">全部 bot</option>${botOptions(auditBot)}</select><button class="ghost-btn" id="sa-export">导出…</button></span></h4>
        <div class="sa-audit">${shown.map((ev) => `
          <div class="sa-ev ${ev.granted ? "" : "deny"}"><span class="sa-t">${esc(fmtTime(ev.at))}</span><span class="sa-b">${esc(botById(ev.botId)?.name || ev.botId)}</span><span class="sa-c">${esc(capLabel(ev.cap))}</span><span class="sa-a" title="${esc(ev.args || "")}">${esc(ev.action)}${ev.args ? ` · ${esc(String(ev.args).slice(0, 60))}` : ""}</span><span class="sa-r">${ev.granted ? (ev.ok === false ? "失败" : "✓") : "已拒绝"}</span></div>`).join("") || `<div class="d-empty">还没有记录</div>`}</div>
      </div>`;
    body.querySelector("#sa-cu")?.addEventListener("click", () => { closeModal(); mcpFlow(); });
    body.querySelectorAll("[data-pref]").forEach((b) => (b.onclick = () => api.system.openPrefs(b.dataset.pref)));
    body.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => { await api.consent.revoke(b.dataset.revoke, b.dataset.cap); render(); }));
    body.querySelectorAll("[data-rule-cmd]").forEach((b) => (b.onclick = async () => { await api.consent.removeRule(b.dataset.ruleBot, b.dataset.ruleCmd); render(); }));
    body.querySelector("#sa-rule-add").onclick = async () => {
      const command = body.querySelector("#sa-rule-cmd").value.trim();
      try {
        await api.consent.setRule(body.querySelector("#sa-rule-bot").value, command, body.querySelector("#sa-rule-dec").value);
        render();
      } catch (e) { body.querySelector("#sa-rule-err").textContent = errText(e); }
    };
    body.querySelectorAll("[data-trust]").forEach((b) => (b.onchange = async () => {
      if (b.checked && !confirm(`打开信任模式后，${botById(b.dataset.trust)?.name || "这个 bot"} 执行命令不再逐个询问（危险命令除外）。确定吗？`)) { b.checked = false; return; }
      await api.consent.setTrusted(b.dataset.trust, b.checked);
      render();
    }));
    body.querySelector("#sa-grant").onclick = async () => {
      const ttl = body.querySelector("#sa-ttl").value;
      await api.consent.grant(body.querySelector("#sa-bot").value, body.querySelector("#sa-cap").value, ttl === "once" ? { once: true } : Number(ttl) ? { ttlMs: Number(ttl) } : undefined);
      render();
    };
    body.querySelector("#sa-filter").onchange = (e) => { auditBot = e.target.value; render(); };
    body.querySelector("#sa-export").onclick = async () => {
      const path = await api.system.pickFile({ save: true, title: "导出操作记录", defaultPath: `harness-audit-${new Date().toISOString().slice(0, 10)}.json` });
      if (!path) return;
      const n = await api.audit.export(path);
      body.querySelector("#sa-export").textContent = `已导出 ${n} 条`;
      api.system.reveal(path);
    };
  };
  render();
}

/* ---- 桌面宠物智能：用户掌舵的自主开关 ---- */
async function petSmartFlow() {
  const modal = sheet({
    icon: "🐾",
    title: "桌面宠物智能",
    sub: "桌宠是娱乐层，不干扰 bot 干活。进阶能力按需打开；打开后模型带着记忆表演，规则只兜底。",
    wide: true,
  });
  const body = modal.querySelector(".mx-body");
  const viaLabel = (v) => (v === "model" ? "模型" : v === "rule" ? "规则" : v === "user" ? "你" : "系统");
  const render = async () => {
    const [p, activity] = await Promise.all([
      api.pet.prefs(),
      api.pet.activity(undefined, 12).catch(() => []),
    ]);
    const actHtml = activity.length
      ? activity.map((a) => {
          const t = new Date(a.at).toLocaleString();
          const block = a.blocked ? " · 未执行" : "";
          return `<div class="hud-row" style="font-size:12px;margin:4px 0"><span>${t} · ${viaLabel(a.via)} · ${a.kind}${block}</span><b style="font-weight:500;max-width:55%;text-align:right">${esc(a.note || "")}</b></div>`;
        }).join("")
      : `<div class="hint">还没有自主行动记录。打开开关后点「立即试跑」，或等空闲触发。</div>`;
    body.innerHTML = `
      <div class="d-sec"><h4>进阶能力（默认全关）</h4>
        <div class="hint">开了会读人设/记忆/最近对话再行动；同宠间隔≈「空闲多久」分钟，不再干等数小时。基础：上台、气泡、任务提醒、手动换装、XP 始终可用。</div>
        <div class="d-card"><div class="c-main"><div class="c-title">空闲搭话</div><div class="c-sub">闲着时按记忆主动说一句（模型优先）</div></div>
          <label class="switch"><input type="checkbox" data-k="companionChat" ${p.companionChat ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">主动跟进</div><div class="c-sub">悬而未决的事轻推一句（会打模型）</div></div>
          <label class="switch"><input type="checkbox" data-k="proactiveFollowup" ${p.proactiveFollowup ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">空闲做事</div><div class="c-sub">只读观察未完成事项并汇报（模型 + 心智）</div></div>
          <label class="switch"><input type="checkbox" data-k="idleWork" ${p.idleWork ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">自动换装</div><div class="c-sub">按话题与心智从候选选形象；可说「换回去」</div></div>
          <label class="switch"><input type="checkbox" data-k="autoAppearance" ${p.autoAppearance ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">允许召唤/创建桌宠</div><div class="c-sub">权限闸门：对话里可「把某某叫出来 / 再做一个伙伴」</div></div>
          <label class="switch"><input type="checkbox" data-k="agentMaySpawn" ${p.agentMaySpawn ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">自进化提议</div><div class="c-sub">观察聊天后提议改习惯/人设；回「好」才变</div></div>
          <label class="switch"><input type="checkbox" data-k="selfEvolve" ${p.selfEvolve ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">自动接受进化</div><div class="c-sub">需先开「自进化提议」；开了则提议自动生效</div></div>
          <label class="switch"><input type="checkbox" data-k="autoEvolve" ${p.autoEvolve ? "checked" : ""}/><span></span></label></div>
        <div class="d-card"><div class="c-main"><div class="c-title">多宠互访</div><div class="c-sub">按亲密度选伴，台词带人设与共同记忆</div></div>
          <label class="switch"><input type="checkbox" data-k="petVisit" ${p.petVisit ? "checked" : ""}/><span></span></label></div>
      </div>
      <div class="d-sec"><h4>立即试跑</h4>
        <div class="hint">跳过「空闲多久」等待，用当前已开开关立刻跑一轮，方便验证聪不聪明。</div>
        <div class="actions" style="flex-wrap:wrap;gap:8px">
          <button class="primary-btn" id="pp-trial">按已开开关试跑</button>
          <button class="ghost-btn" id="pp-trial-visit" ${p.petVisit ? "" : "disabled"}>试互访</button>
          <button class="ghost-btn" id="pp-trial-evolve" ${p.selfEvolve ? "" : "disabled"}>试进化提议</button>
        </div>
        <div class="hint" id="pp-trial-msg"></div>
      </div>
      <div class="d-sec mx-form"><h4>节奏</h4>
        <div class="mx-grid">
          <label>空闲多久才开口（分钟）</label><input id="pp-idle" type="number" min="5" max="1440" value="${p.idleMinutes}" />
          <label>每天最多搭话</label><input id="pp-chat" type="number" min="0" max="48" value="${p.maxChatPerDay}" />
          <label>每天最多做事</label><input id="pp-work" type="number" min="0" max="24" value="${p.maxWorkPerDay}" />
          <label>每周最多自动换装</label><input id="pp-appear" type="number" min="0" max="7" value="${p.maxAppearPerWeek}" />
        </div>
        <div class="actions"><button class="primary-btn" id="pp-save">保存节奏</button></div>
      </div>
      <div class="d-sec"><h4>最近自主行动</h4>
        ${actHtml}
        <div class="actions" style="margin-top:8px"><button class="ghost-btn" id="pp-refresh-act">刷新</button></div>
      </div>
      <div class="hint">气泡里可说：换成咕嘎 / 安静一点 / 半小时后提醒我喝水 / 画个球</div>`;
    body.querySelectorAll("input[data-k]").forEach((el) => {
      el.onchange = async () => {
        await api.config.set("prefs", { pet: { [el.dataset.k]: el.checked } });
        await render();
      };
    });
    const runTrial = async (kind) => {
      const msg = body.querySelector("#pp-trial-msg");
      msg.textContent = "试跑中…";
      try {
        const r = await api.pet.trial(kind);
        msg.textContent = r.ok ? `✓ ${r.message}` : `✗ ${r.message}`;
        setTimeout(() => render(), 600);
      } catch (e) {
        msg.textContent = "✗ " + (e.message || e);
      }
    };
    body.querySelector("#pp-trial").onclick = () => runTrial("auto");
    body.querySelector("#pp-trial-visit").onclick = () => runTrial("visit");
    body.querySelector("#pp-trial-evolve").onclick = () => runTrial("evolve");
    body.querySelector("#pp-refresh-act").onclick = () => render();
    body.querySelector("#pp-save").onclick = async () => {
      await api.config.set("prefs", {
        pet: {
          idleMinutes: Number(body.querySelector("#pp-idle").value),
          maxChatPerDay: Number(body.querySelector("#pp-chat").value),
          maxWorkPerDay: Number(body.querySelector("#pp-work").value),
          maxAppearPerWeek: Number(body.querySelector("#pp-appear").value),
        },
      });
      const tip = document.createElement("div");
      tip.className = "hint";
      tip.textContent = "已保存";
      body.querySelector("#pp-save").after(tip);
      setTimeout(() => tip.remove(), 1500);
    };
  };
  await render();
}

const GITHUB_REPO = "https://github.com/zjyzhj/harness-system";
const APP_VERSION = "0.1.0";

/** 关于：GitHub 链接、开源与第三方声明 */
async function aboutFlow() {
  const modal = sheet({
    icon: "ℹ",
    title: "关于 Harness Bot",
    sub: `版本 ${APP_VERSION} · 本地优先的 AI 智能体指挥中心`,
    wide: true,
  });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `
    <div class="d-sec about-hero">
      <p>一句话创建 bot、主控统一对话；bot 可变成桌面宠物（Live2D / 精灵），多 bot 可协作，统一接入 OpenAI 兼容 API 与主流 CLI。</p>
      <div class="about-actions">
        <a class="primary-btn about-ext" href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer">打开 GitHub 仓库</a>
        <a class="ghost-btn about-ext" href="${GITHUB_REPO}/issues" target="_blank" rel="noopener noreferrer">反馈 Issue</a>
        <button type="button" class="ghost-btn" id="about-copy">复制仓库链接</button>
      </div>
      <p class="hint about-url"><code>${esc(GITHUB_REPO)}</code></p>
    </div>
    <div class="d-sec">
      <h4>声明</h4>
      <ul class="about-list">
        <li>本项目<strong>开源</strong>，欢迎 Fork、提 PR 与下载使用；源码与更新以 GitHub 仓库为准。</li>
        <li><strong>本地优先</strong>：会话、密钥与配置默认保存在本机；不会把你的 API Key 上传到本项目服务器（本项目无云端账号体系）。</li>
        <li>界面风格参考 xAI Grok Bot 桌面端体验，<strong>非</strong> xAI / Grok 官方产品，亦无隶属或背书关系。</li>
        <li>调用第三方模型、CLI 或 MCP 时，请遵守对应服务商的条款与用量规定；风险与费用由你自行承担。</li>
        <li>经你授权后，bot 可能访问通知、剪贴板、文件、截屏等系统能力——请在「系统授权」中按需批准与撤销。</li>
      </ul>
    </div>
    <div class="d-sec">
      <h4>第三方与样本资源</h4>
      <ul class="about-list">
        <li><strong>Live2D</strong>：内置 Cubism 样本模型（Haru / Hiyori / Mao 等）及运行时，遵循 Live2D 开放软件许可 / 专有软件许可；企业用途请自行确认
          <a class="about-ext" href="https://www.live2d.com/eula/live2d-open-software-license-agreement_cn.html" target="_blank" rel="noopener noreferrer">开放软件许可</a>
          与
          <a class="about-ext" href="https://www.live2d.com/zh-CHS/download/cubism-sdk/release-license/" target="_blank" rel="noopener noreferrer">发行许可</a>。
          详情见仓库 <code>app/renderer/live2d/LICENSE-samples.md</code>。</li>
        <li>运行时还可能用到 Electron、PixiJS、Hugging Face Transformers 等依赖，各自遵循其许可证。</li>
      </ul>
    </div>
    <div class="d-sec">
      <h4>参与</h4>
      <p class="hint">提交代码前请跑通 <code>bun test</code>；大功能建议先阅读 <code>docs/goals/</code> 中对应 Goal 的边界说明。</p>
    </div>`;
  body.querySelector("#about-copy").onclick = async () => {
    try {
      await api.system.copy(GITHUB_REPO);
      const tip = document.createElement("span");
      tip.className = "hint";
      tip.textContent = " 已复制";
      body.querySelector("#about-copy").after(tip);
      setTimeout(() => tip.remove(), 1500);
    } catch (e) { alert(errText(e)); }
  };
}

// ---- bind ----
$("#new-bot-btn").onclick = createBotFlow;
$("#settings-btn").onclick = settingsFlow;
$("#migrate-btn").onclick = migrateFlow;
$("#memory-btn").onclick = memoryFlow;
$("#skills-btn").onclick = skillsFlow;
$("#tasks-btn").onclick = tasksFlow;
$("#groups-btn").onclick = groupsFlow;
$("#plans-btn").onclick = plansFlow;
$("#sysaccess-btn").onclick = sysaccessFlow;
$("#env-btn").onclick = () => envFlow();
$("#vault-btn").onclick = () => vaultFlow();
$("#mcp-btn").onclick = mcpFlow;

/* ---- 保险库 / 连接（本机；无 OAuth / 支付 / 云邮箱） ---- */
async function vaultFlow() {
  const modal = sheet({ icon: "🛡", title: "保险库 / 连接", sub: "本机密钥 · 环境 · 通讯录 · MCP / Webhook / CLI（非应用市场）", wide: true });
  const body = modal.querySelector(".mx-body");
  let tab = "overview";
  let catalog = await api.vault.catalog().catch(() => ({ secrets: 0, env: 0, contacts: 0, webhooks: 0, mcp: [], cli: [] }));
  let contactList = await api.contacts.list().catch(() => []);
  let hooks = await api.connectors.listWebhooks().catch(() => []);
  let editingContact = null;
  let editingHook = null;
  const refresh = async () => {
    catalog = await api.vault.catalog().catch(() => catalog);
    contactList = await api.contacts.list().catch(() => contactList);
    hooks = await api.connectors.listWebhooks().catch(() => hooks);
    render();
  };
  const render = () => {
    const tabs = [
      ["overview", "总览"],
      ["contacts", "通讯录"],
      ["webhooks", "Webhook"],
      ["mcp", "MCP / CLI"],
    ].map(([id, label]) => `<button class="ghost-btn ${tab === id ? "on" : ""}" data-tab="${id}">${label}</button>`).join("");
    let main = "";
    if (tab === "overview") {
      main = `
        <div class="d-sec">
          <div class="d-card"><div class="c-main"><div class="c-title">密钥</div><div class="c-sub">${catalog.secrets} 项 · 加密本机</div></div><button class="ghost-btn" id="v-env">打开环境配置</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">环境变量</div><div class="c-sub">${catalog.env} 项 · 明文配置</div></div><button class="ghost-btn" id="v-env2">打开环境配置</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">通讯录</div><div class="c-sub">${catalog.contacts} 人 · 无支付</div></div></div>
          <div class="d-card"><div class="c-main"><div class="c-title">Webhook</div><div class="c-sub">${catalog.webhooks} 个端点</div></div></div>
          <div class="hint">不做：OAuth 应用市场、Shop Pay、云邮箱身份 name+tag@。添加 MCP 走现有 MCP 页；密钥用 {{secret:名字}}。</div>
        </div>`;
    } else if (tab === "contacts") {
      main = `<div class="d-sec"><h4>通讯录 <button class="list-add" id="ct-new" title="添加">＋</button></h4>
        ${contactList.map((c) => `<div class="d-card" data-cid="${esc(c.id)}"><div class="c-main"><div class="c-title">${esc(c.name)}</div><div class="c-sub">${esc([c.email, c.note].filter(Boolean).join(" · ") || "无备注")}</div></div>
          <button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button></div>`).join("") || `<div class="d-empty">还没有联系人</div>`}
        ${editingContact ? `<div class="mx-form"><h4>${editingContact.id ? "编辑" : "添加"}联系人</h4>
          <div class="mx-grid"><label>姓名</label><input id="ct-name" value="${esc(editingContact.name ?? "")}" />
          <label>邮箱</label><input id="ct-email" value="${esc(editingContact.email ?? "")}" placeholder="可选" />
          <label>备注</label><input id="ct-note" value="${esc(editingContact.note ?? "")}" placeholder="可选" /></div>
          <div class="actions"><button class="ghost-btn" id="ct-cancel">取消</button><button class="primary-btn" id="ct-save">保存</button></div></div>` : ""}
      </div>`;
    } else if (tab === "webhooks") {
      main = `<div class="d-sec"><h4>HTTP Webhook <button class="list-add" id="wh-new" title="添加">＋</button></h4>
        ${hooks.map((w) => `<div class="d-card" data-wid="${esc(w.id)}"><div class="c-main"><div class="c-title">${esc(w.name)}</div><div class="c-sub">${esc(w.url)}${w.note ? ` · ${esc(w.note)}` : ""}</div></div>
          <button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button></div>`).join("") || `<div class="d-empty">还没有 Webhook。Token 用 {{secret:名字}}，不要明文。</div>`}
        ${editingHook ? `<div class="mx-form"><h4>${editingHook.id ? "编辑" : "添加"} Webhook</h4>
          <div class="mx-grid"><label>名称</label><input id="wh-name" value="${esc(editingHook.name ?? "")}" />
          <label>URL</label><input id="wh-url" value="${esc(editingHook.url ?? "")}" placeholder="https://…" />
          <label>备注</label><input id="wh-note" value="${esc(editingHook.note ?? "")}" placeholder="可选；Header 里写 {{secret:…}}" /></div>
          <div class="actions"><button class="ghost-btn" id="wh-cancel">取消</button><button class="primary-btn" id="wh-save">保存</button></div></div>` : ""}
      </div>`;
    } else {
      const mcpRows = (catalog.mcp || []).map((m) => `<div class="d-card"><span class="ws-dot ${m.error ? "" : m.tools ? "on" : ""}"></span><div class="c-main"><div class="c-title">${esc(m.name)}</div><div class="c-sub">${m.error ? `✕ ${esc(m.error)}` : `${m.tools} 工具`} · ${esc(m.url ?? [m.command, ...(m.args || [])].filter(Boolean).join(" "))}</div></div></div>`).join("") || `<div class="d-empty">没有 MCP</div>`;
      const cliRows = (catalog.cli || []).map((c) => `<div class="d-card"><span class="ws-dot ${c.ready ? "on" : ""}"></span><div class="c-main"><div class="c-title">${esc(c.name)}</div><div class="c-sub">${esc(c.detail || (c.ready ? "可用" : "未就绪"))}</div></div></div>`).join("");
      main = `<div class="d-sec"><h4>MCP <button class="ghost-btn" id="v-mcp">管理 MCP</button></h4>${mcpRows}</div>
        <div class="d-sec"><h4>CLI 适配器状态</h4>${cliRows}</div>
        <div class="hint">添加连接走现有 mcp.add / 环境配置 / 密钥；不接 OAuth 应用市场。</div>`;
    }
    body.innerHTML = `<div class="actions" style="margin-bottom:12px">${tabs}</div>${main}`;
    body.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; editingContact = null; editingHook = null; render(); }));
    body.querySelector("#v-env")?.addEventListener("click", () => { closeModal(); envFlow(); });
    body.querySelector("#v-env2")?.addEventListener("click", () => { closeModal(); envFlow(); });
    body.querySelector("#v-mcp")?.addEventListener("click", () => { closeModal(); mcpFlow(); });
    body.querySelector("#ct-new")?.addEventListener("click", () => { editingContact = { name: "" }; render(); });
    body.querySelector("#ct-cancel")?.addEventListener("click", () => { editingContact = null; render(); });
    body.querySelector("#ct-save")?.addEventListener("click", async () => {
      try {
        await api.contacts.upsert({
          id: editingContact.id,
          name: body.querySelector("#ct-name").value.trim(),
          email: body.querySelector("#ct-email").value.trim() || undefined,
          note: body.querySelector("#ct-note").value.trim() || undefined,
        });
        editingContact = null;
        await refresh();
      } catch (e) { alert(errText(e)); }
    });
    body.querySelectorAll("[data-cid]").forEach((card) => {
      const id = card.dataset.cid;
      card.querySelector('[data-op="edit"]').onclick = () => { editingContact = contactList.find((c) => c.id === id); render(); };
      card.querySelector('[data-op="del"]').onclick = async () => { if (confirm("删除这个联系人？")) { await api.contacts.remove(id); await refresh(); } };
    });
    body.querySelector("#wh-new")?.addEventListener("click", () => { editingHook = { name: "", url: "" }; render(); });
    body.querySelector("#wh-cancel")?.addEventListener("click", () => { editingHook = null; render(); });
    body.querySelector("#wh-save")?.addEventListener("click", async () => {
      try {
        await api.connectors.upsertWebhook({
          id: editingHook.id,
          name: body.querySelector("#wh-name").value.trim(),
          url: body.querySelector("#wh-url").value.trim(),
          note: body.querySelector("#wh-note").value.trim() || undefined,
        });
        editingHook = null;
        await refresh();
      } catch (e) { alert(errText(e)); }
    });
    body.querySelectorAll("[data-wid]").forEach((card) => {
      const id = card.dataset.wid;
      card.querySelector('[data-op="edit"]').onclick = () => { editingHook = hooks.find((w) => w.id === id); render(); };
      card.querySelector('[data-op="del"]').onclick = async () => { if (confirm("删除这个 Webhook？")) { await api.connectors.removeWebhook(id); await refresh(); } };
    });
  };
  render();
}
$("#pet-smart-btn").onclick = petSmartFlow;
$("#about-btn").onclick = aboutFlow;
api.onOpenAbout?.(() => aboutFlow());
$("#realm-btn").onclick = () => { $("#more-menu").classList.add("hidden"); realmListFlow(); };
$("#send-btn").onclick = send;
