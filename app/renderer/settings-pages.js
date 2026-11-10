// 工具菜单与设置页：模型、图片、用量、语义回想、迁移、记忆、技能、定时任务、MCP、群组、系统授权
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

const PERM_MODE_HINT = {
  ask: "对齐 Grok Ask：敏感操作先问；可用自定义规则收紧/放宽",
  auto: "对齐 Grok Auto Review：Shell / 终端 / Coding CLI 自动过；危险命令与 Ask first 仍问",
  always: "几乎全过（含危险命令）；禁止规则与 Ask first 仍生效",
};

function codingTrustDirs(termPaths = [], cliPaths = []) {
  const seen = new Set();
  const out = [];
  for (const p of [...termPaths, ...cliPaths]) {
    const prefix = typeof p === "string" ? p : p?.prefix;
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    out.push(typeof p === "string" ? { prefix } : p);
  }
  return out;
}

async function revokeCodingDir(botId, prefix) {
  await Promise.all([
    api.consent.revokeTermPath?.(botId, prefix),
    api.consent.revokeCliPath(botId, prefix),
  ]);
}

/** 单个 bot 的权限区：Ask / Auto / Always + 能力批准 + 目录信任 */
function botPermSection(botId, grants, caps, mode = "ask", { linkSys = true, cliPaths = [], termPaths = [] } = {}) {
  const label = (id) => caps.find((c) => c.id === id)?.label || id;
  const m = mode === "auto" || mode === "always" ? mode : "ask";
  const dirs = codingTrustDirs(termPaths, cliPaths);
  const bits = [
    m === "always" ? "Always 全放行" : m === "auto" ? "Auto 安全自动过" : "Ask 逐次问",
    grants.length ? `${grants.length} 项能力` : "无单独能力",
    dirs.length ? `${dirs.length} 个信任目录` : "",
  ].filter(Boolean);
  return `
    <div class="d-sec bot-perm" data-bot="${esc(botId)}">
      <h4>权限 <button class="ghost-btn bp-overview" type="button" title="能力 / 命令 / 目录 / Webhook">总览</button></h4>
      <div class="d-card bp-summary bp-stack">
        <div class="c-main">
          <div class="c-title">当前授权</div>
          <div class="c-sub">${esc(bits.join(" · "))}</div>
        </div>
        <button class="ghost-btn bp-overview" type="button">看详情</button>
      </div>
      <div class="d-card bp-mode-card bp-stack">
        <div class="c-main">
          <div class="c-title">权限模式</div>
          <div class="c-sub">${esc(PERM_MODE_HINT[m])}</div>
        </div>
        <select class="skin-select bp-mode" title="权限模式">
          <option value="ask" ${m === "ask" ? "selected" : ""}>Ask · 每次询问</option>
          <option value="auto" ${m === "auto" ? "selected" : ""}>Auto · 安全自动过</option>
          <option value="always" ${m === "always" ? "selected" : ""}>Always · 全部放行</option>
        </select>
      </div>
      ${grants.map((g) => `
        <div class="d-card bp-stack"><div class="c-main"><div class="c-title">${esc(label(g.cap))}</div>
          <div class="c-sub">${g.once ? "仅一次" : g.expiresAt ? `到 ${esc(fmtTime(g.expiresAt))}` : "长期"}${g.grantedAt ? ` · ${esc(fmtTime(g.grantedAt))}` : ""}</div></div>
          <button class="ghost-btn danger-text" data-revoke="${esc(g.cap)}">撤销</button></div>`).join("") || `<div class="d-empty">尚未单独批准任何能力</div>`}
      ${dirs.length ? `<div class="hint" style="margin-top:8px">信任目录（开终端、打字、派 Coding CLI）</div>${dirs.map((p) => `
        <div class="d-card bp-stack"><div class="c-main"><div class="c-title" title="${esc(p.prefix)}">${esc(p.prefix)}</div>
          <div class="c-sub">开终端、打字、派工${p.createdAt ? ` · ${esc(fmtTime(p.createdAt))}` : ""}</div></div>
          <button class="ghost-btn danger-text" data-revoke-codingpath="${esc(p.prefix)}">撤销</button></div>`).join("")}` : ""}
      <div class="mx-inline sa-grant bot-perm-grant">
        <select class="skin-select bp-cap">${caps.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select>
        <select class="skin-select bp-ttl"><option value="0">长期</option><option value="3600000">1 小时</option><option value="86400000">1 天</option><option value="once">仅一次</option></select>
        <button class="ghost-btn bp-grant">批准</button>
      </div>
      ${linkSys ? `<button class="ghost-btn bp-sysaccess" style="margin-top:4px">命令规则与操作记录…</button>` : ""}
    </div>`;
}

function bindBotPerm(root, botId, onChange) {
  const sec = root.querySelector?.(".bot-perm") || root;
  sec.querySelectorAll("[data-revoke]").forEach((btn) => (btn.onclick = async () => {
    await api.consent.revoke(botId, btn.dataset.revoke);
    onChange?.();
  }));
  sec.querySelectorAll("[data-revoke-codingpath], [data-revoke-clipath], [data-revoke-termpath]").forEach((btn) => (btn.onclick = async () => {
    const prefix = btn.dataset.revokeCodingpath || btn.dataset.revokeClipath || btn.dataset.revokeTermpath;
    await revokeCodingDir(botId, prefix);
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
  const modeSel = sec.querySelector(".bp-mode");
  if (modeSel) modeSel.onchange = async () => {
    const next = modeSel.value === "auto" || modeSel.value === "always" ? modeSel.value : "ask";
    const prev = modeSel.dataset.prev || "ask";
    if (next === "always" && !confirm(`Always 模式下，${botById(botId)?.name || "这个 bot"} 将可直接执行危险命令（sudo、删目录等），禁止规则仍生效。确定吗？`)) {
      modeSel.value = prev;
      return;
    }
    if (next === "auto" && prev === "ask" && !confirm(`Auto 模式下，${botById(botId)?.name || "这个 bot"} 的 Shell / 开终端 / 派 Coding CLI 不再逐个询问（危险命令除外）。确定吗？`)) {
      modeSel.value = prev;
      return;
    }
    await api.consent.setMode(botId, next);
    modeSel.dataset.prev = next;
    onChange?.();
  };
  if (modeSel) modeSel.dataset.prev = modeSel.value;
  const sys = sec.querySelector(".bp-sysaccess");
  if (sys) sys.onclick = () => { closeModal(); sysaccessFlow(); };
  sec.querySelectorAll(".bp-overview").forEach((btn) => (btn.onclick = () => botAccessFlow(botId)));
}

/** 「这个 bot 还能干什么」一页总览：模式 / 能力 / 命令 / 目录 / 例行 URL / 网关 */
async function botAccessFlow(botId) {
  const bot = botById(botId);
  if (!bot) return;
  const modal = sheet({
    icon: "🛡",
    title: `${bot.name} · 授权总览`,
    sub: "累计授权、命令规则、工程目录与例行能力 URL",
    wide: true,
  });
  const body = modal.querySelector(".mx-body");
  const render = async () => {
    const ov = await api.consent.overview(botId).catch((e) => ({ error: errText(e) }));
    if (ov?.error) {
      body.innerHTML = `<div class="d-empty">${esc(ov.error)}</div>`;
      return;
    }
    const modeName = ov.mode === "always" ? "Always" : ov.mode === "auto" ? "Auto" : "Ask";
    const hooks = (ov.routines || []).filter((r) => r.hasWebhook);
    body.innerHTML = `
      ${ov.warnings?.length ? `<div class="notify-hint">${ov.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
      <div class="d-sec"><h4>还能干什么</h4>
        <ul class="ba-list">${(ov.canDo || []).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      </div>
      <div class="d-sec"><h4>权限模式</h4>
        <div class="d-card"><div class="c-main"><div class="c-title">${esc(modeName)}</div>
          <div class="c-sub">${esc(ov.modeHint || "")}</div></div>
          <button class="ghost-btn" id="ba-edit-perm">改权限</button></div>
      </div>
      <div class="d-sec"><h4>已批准能力 · ${(ov.grants || []).length}</h4>
        ${(ov.grants || []).map((g) => `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(g.label)}</div>
            <div class="c-sub">${g.once ? "仅一次" : g.expiresAt ? `到 ${esc(fmtTime(g.expiresAt))}` : "长期"} · ${esc(fmtTime(g.grantedAt))}</div></div>
            <button class="ghost-btn danger-text" data-ba-revoke="${esc(g.cap)}">撤销</button></div>`).join("")
          || `<div class="d-empty">无单独批准</div>`}
      </div>
      <div class="d-sec"><h4>命令规则</h4>
        ${(ov.allowCommands || []).length ? `<div class="hint">允许：${esc(ov.allowCommands.join("、"))}</div>` : ""}
        ${(ov.denyCommands || []).length ? `<div class="hint">禁止：${esc(ov.denyCommands.join("、"))}</div>` : ""}
        ${!(ov.allowCommands || []).length && !(ov.denyCommands || []).length ? `<div class="d-empty">无命令白名单 / 禁止规则</div>` : ""}
        <button class="ghost-btn" id="ba-rules" style="margin-top:6px">管理命令规则…</button>
      </div>
      <div class="d-sec"><h4>信任目录</h4>
        ${codingTrustDirs(ov.termPaths || [], ov.cliPaths || []).map((p) => `
          <div class="d-card"><div class="c-main"><div class="c-title" title="${esc(p.prefix)}">${esc(p.prefix)}</div><div class="c-sub">开终端、打字、派工</div></div>
            <button class="ghost-btn danger-text" data-ba-coding="${esc(p.prefix)}">撤销</button></div>`).join("")
          || `<div class="d-empty">还没有目录信任</div>`}
      </div>
      <div class="d-sec"><h4>例行能力 URL · ${hooks.length}</h4>
        <div class="hint">POST 即可触发；优先用云服务公网链接（例行 🪝）。本机网关仅备用：${ov.gateway?.enabled
          ? (ov.gateway.loopback ? "本机回环可用" : `监听 ${esc(ov.gateway.host)}`)
          : ov.gateway?.remoteBlocked
            ? "未允许远程（Connect → 本机网关）"
            : "未开启"}。</div>
        ${hooks.map((r) => `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(r.name)}${r.enabled ? "" : " · 已暂停"}</div>
            <div class="c-sub" style="word-break:break-all">${esc(r.capabilityUrl || r.webhookToken || "")}</div></div>
            <button class="ghost-btn" data-ba-copy="${esc(r.capabilityUrl || r.webhookToken || "")}">复制</button></div>`).join("")
          || `<div class="d-empty">没有开通 Webhook 的例行</div>`}
      </div>
      <div class="d-sec"><h4>最近操作</h4>
        ${(ov.recentAudit || []).map((e) => `
          <div class="hint">${esc(fmtTime(e.at))} · ${e.ok ? "✓" : "✕"} ${esc(e.action)}${e.cap ? ` · ${esc(e.cap)}` : ""}${e.detail ? ` · ${esc(e.detail)}` : ""}</div>`).join("")
          || `<div class="d-empty">暂无审计记录</div>`}
      </div>`;
    body.querySelector("#ba-edit-perm")?.addEventListener("click", () => {
      closeModal();
      if (currentBot?.id === botId) toggleDetails(true);
      else selectBot(bot).then(() => toggleDetails(true));
    });
    body.querySelector("#ba-rules")?.addEventListener("click", () => { closeModal(); sysaccessFlow(); });
    body.querySelectorAll("[data-ba-revoke]").forEach((btn) => (btn.onclick = async () => {
      await api.consent.revoke(botId, btn.dataset.baRevoke);
      render();
      if (currentBot?.id === botId) renderDetails(currentBot);
    }));
    body.querySelectorAll("[data-ba-coding], [data-ba-term], [data-ba-cli]").forEach((btn) => (btn.onclick = async () => {
      const prefix = btn.dataset.baCoding || btn.dataset.baTerm || btn.dataset.baCli;
      await revokeCodingDir(botId, prefix);
      render();
      if (currentBot?.id === botId) renderDetails(currentBot);
    }));
    body.querySelectorAll("[data-ba-copy]").forEach((btn) => (btn.onclick = async () => {
      const t = btn.dataset.baCopy;
      if (!t) return;
      try {
        await navigator.clipboard.writeText(t);
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = "复制"), 1200);
      } catch { alert(t); }
    }));
  };
  await render();
}

/** 首启 / 顶条：单独配一个模型，不钻进完整设置页 */
async function quickProviderFlow(opts = {}) {
  const providers = await api.providers.list().catch(() => []);
  const modal = openModal(`
    <div class="cb-head"><h2>接上模型</h2><button class="cb-x" title="关闭">✕</button></div>
    <div class="cb-body">
      <p class="hint" style="margin:0 0 8px">填任意 OpenAI 兼容接口，或选本机已登录的 Claude / Codex / Cursor CLI。保存后就能认真对话。</p>
      ${providerForm({})}
    </div>`);
  modal.classList.add("cb-modal");
  modal.querySelector(".cb-x").onclick = closeModal;
  bindProviderForm(modal, {}, providers, async () => {
    closeModal();
    const bar = $("#setup-banner");
    if (bar) delete bar.dataset.dismissed;
    if (currentBot) await syncSetupBanner();
    else await renderEmptyState();
    if (opts.continueToBot && bots.length === 0 && typeof createBotFlow === "function") createBotFlow();
  }, closeModal);
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
        <div class="mx-chips">${Object.keys(caps).length ? Object.entries(caps).map(([c, info]) => `<span class="mx-chip ${info?.ready ? "ok" : info?.installed ? "" : ""}" title="${esc(info?.bin || c)}">${info?.ready ? "✓" : info?.installed ? "○" : "✕"} ${esc(c)}${info?.ready ? " · 可派工" : info?.installed ? " · 未就绪" : ""}${info?.version ? ` · ${esc(String(info.version).split(" ")[0])}` : ""}${info?.account ? ` · ${esc(info.account)}` : ""}</span>`).join("") : ["claude", "codex", "cursor"].map((c) => `<span class="mx-chip">… ${c}</span>`).join("")}</div>
        <div class="hint">名单来自 Coding Agent 注册表 + 本机实时探测（点刷新更新）。对话选「本地 cursor」是聊天脑（空沙箱，不改你的工程）；改工程走 <code>cli.agent</code> 派工。二者不要混成 Cursor IDE 的 Ask/Agent。</div>
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
      Object.assign(caps, await api.providers.capabilities(true).catch(() => caps));
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
        (r.skippedPlans > 0 ? `；另跳过 ${r.skippedPlans} 条旧编排（已下线，未导入）` : "") +
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
  const [mem, stats, skills, tasks, stList, skins, grants, caps, cmd, cliPaths, termPaths] = await Promise.all([
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
    api.consent.termPaths ? api.consent.termPaths(b.id).catch(() => []) : Promise.resolve([]),
  ]);
  const st = stList.find((x) => x.botId === b.id) || { state: "idle" };
  const card = b.personaCard;
  const permMode = cmd.modes?.[b.id] || (cmd.trusted?.includes(b.id) ? "auto" : "ask");
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
    ${botPermSection(b.id, grants, caps, permMode, { cliPaths, termPaths })}
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
  const modal = sheet({ icon: "🧠", title: "记忆", sub: "优先在对话里说「记住 / 忘掉」。面板用于浏览与从其它助手导入。Primary（主控）bot 的记忆是你的默认入口。", wide: true });
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
    const primary = bots.find((b) => b.isMaster);
    body.innerHTML = `
      <div class="mx-split">
        <div class="mx-nav">${all.map((n) => `<button data-ns="${esc(n)}" class="${n === memoryNs ? "on" : ""}">${esc(nsLabel(n))}${n.startsWith("bot:") && primary && n === `bot:${primary.id}` ? " · 主控" : ""}</button>`).join("")}</div>
        <div class="mx-main">
          <div class="hint">也可直接对 bot 说「你还记得什么」「忘掉…」。下面可从 ChatGPT / Claude 等粘贴导出文本批量导入。</div>
          <div class="mx-inline"><select id="mm-kind" class="skin-select"><option value="rule" ${kindFilter !== "fact" ? "selected" : ""}>规范</option><option value="fact" ${kindFilter === "fact" ? "selected" : ""}>事实/偏好</option></select><input id="mm-add" placeholder="记一条：例如「回答先给结论再展开」" /><button class="primary-btn" id="mm-add-btn">记住</button><button class="ghost-btn" id="mm-import" title="从其它助手导入">导入</button></div>
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
    body.querySelector("#mm-import").onclick = async () => {
      const text = await askInput("导入记忆", "粘贴其它助手导出的要点（每行一条），或 JSON 数组 [{kind,content}]", "");
      if (!text?.trim()) return;
      const owner = memoryNs.startsWith("bot:") ? memoryNs.slice(4) : currentBot?.id ?? bots.find((b) => b.isMaster)?.id ?? bots[0]?.id;
      if (!owner) { alert("没有可写入的 bot"); return; }
      try {
        const r = await api.memory.import(owner, text, { namespace: memoryNs });
        alert(`已导入 ${r.count} 条`);
        render();
      } catch (e) { alert(errText(e)); }
    };
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
  const modal = sheet({ icon: "🛠", title: "技能", sub: "技能是 Grok 式说明书：何时使用 · 输入与权限 · 步骤 · 验收 · 交回什么 · 需要批准", wide: true });
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

/* ---- 例行（定时 / Webhook / 试跑） ---- */
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 入站 Webhook：复制 / 换新 / 关闭 */
/** Grok 同款默认指令：从 body.message 取任务，写回当前对话 */
const DEFAULT_HOOK_PROMPT =
  "当收到 Webhook 请求时：从请求体 JSON 取出 message 字段。message 的内容是用户这次交给你的任务：把它当作用户本人在本对话里提出的请求去完成，再把结果写给用户。仍遵守平时的安全规则：不要擅自对外发邮件或消息、不要付款、不要在用户确认前删除。如果没有 message 字段或请求体不是 JSON，简短告诉用户本次请求没有可执行的 message。把结果发到本对话里给用户。";

/** 对齐 Grok：指令 + 何时跑 + POST/密钥/请求头 + 暂停/编辑/删除 */
async function manageRoutineWebhook(id) {
  const tasks = await api.tasks.list().catch(() => []);
  const task = tasks.find((x) => x.id === id);
  if (!task) return alert("找不到这条例行");
  const bot = botById(task.botId);
  const modal = sheet({
    icon: "🪝",
    title: task.name || "Webhook 例行",
    sub: bot?.name || "",
  });
  const body = modal.querySelector(".mx-body");
  let showKey = false;
  let showHdr = false;
  let msg = "";

  const resolveUrl = async (t, bridge, gw) => {
    if (!t?.webhookToken) return { url: "", kind: "none" };
    if (bridge?.configured && bridge.base) {
      return { url: `${String(bridge.base).replace(/\/$/, "")}/w/${t.webhookToken}`, kind: "cloud" };
    }
    if ((gw?.enabled || gw?.running) && gw.routinesBase) {
      return { url: `${gw.routinesBase}/${t.webhookToken}`, kind: "local" };
    }
    return { url: "", kind: "need-cloud" };
  };

  const render = async () => {
    if (!modal.isConnected) return;
    const [list, bridge, gw] = await Promise.all([
      api.tasks.list().catch(() => []),
      api.connect.shareBridge
        ? api.connect.shareBridge().catch(() => ({ configured: false }))
        : Promise.resolve({ configured: false }),
      api.connect.gateway().catch(() => ({ enabled: false })),
    ]);
    const t = list.find((x) => x.id === id) || task;
    // 未开通：先征得同意，绝不在点开时偷偷 ensureWebhook（定时例行保持无 Webhook）
    if (!t.webhookToken) {
      body.innerHTML = `
        <div class="d-sec wh-sheet">
          <div class="hint" style="line-height:1.6">这条例行目前是<strong>纯定时</strong>，没有入站 Webhook（对齐 Grok：两者分开）。<br/>
            开通后才会生成 POST 链接；外部系统才能触发。定时调度可继续保留，也可改成「仅 Webhook」。</div>
          ${msg ? `<div class="hint">${esc(msg)}</div>` : ""}
          <div class="actions" style="margin-top:12px">
            <button type="button" class="ghost-btn" id="wh-cancel">取消</button>
            <button type="button" class="ghost-btn" id="wh-enable-keep">开通并保留定时</button>
            <button type="button" class="primary-btn" id="wh-enable-only">开通为仅 Webhook</button>
          </div>
        </div>`;
      body.querySelector("#wh-cancel")?.addEventListener("click", () => closeModal());
      const enable = async (schedule) => {
        try {
          Object.assign(t, await api.tasks.ensureWebhook(id));
          if (schedule === false) await api.tasks.update(id, { schedule: false });
          // 若指令仍是普通定时文案，换成 Webhook 默认指令
          const p = (t.prompt || "").trim();
          if (!p || (p.length < 40 && !/message/i.test(p))) {
            await api.tasks.update(id, { prompt: DEFAULT_HOOK_PROMPT });
          }
          msg = schedule === false ? "已开通：仅 Webhook 触发" : "已开通 Webhook（定时仍有效）";
          if (currentBot) renderDetails(currentBot);
          render();
        } catch (e) { msg = errText(e); render(); }
      };
      body.querySelector("#wh-enable-keep")?.addEventListener("click", () => enable(true));
      body.querySelector("#wh-enable-only")?.addEventListener("click", () => enable(false));
      return;
    }
    const { url, kind } = await resolveUrl(t, bridge, gw);
    const key = t.webhookToken || "";
    const header = `Authorization: Bearer ${key}`;
    const mask = (s) => "•".repeat(Math.min(28, Math.max(10, String(s).length)));
    const instr = (t.prompt || "").trim() || DEFAULT_HOOK_PROMPT;
    const whenLine = t.schedule === false
      ? "当 Webhook 触发时（无定时）"
      : kind === "local"
        ? "当 Webhook 触发时（兼定时；本机局域网）"
        : "当 Webhook 触发时" + (t.schedule === false ? "" : "（兼定时）");
    body.innerHTML = `
      <div class="d-sec wh-sheet">
        <div class="wh-instr">${esc(instr)}</div>
        <div class="wh-when">🌐 ${esc(whenLine)}</div>
        ${kind === "need-cloud" ? `
          <div class="d-card bp-stack" style="border-color:var(--acc)">
            <div class="c-main">
              <div class="c-title">还没有公网地址</div>
              <div class="c-sub">粘贴 Cloudflare API Token，点生成。软件会返回你的 <code>*.workers.dev</code>，并给出这条 Webhook 的 POST 链接。</div>
            </div>
          </div>
          <div class="mx-form" style="margin-top:10px">
            <div class="mx-grid">
              <label>API Token</label><input id="wh-cf-token" type="password" placeholder="粘贴 Cloudflare API Token" autocomplete="off" />
            </div>
            <div class="actions">
              <button type="button" class="ghost-btn" id="wh-open-cloud">打开云服务页</button>
              <button type="button" class="primary-btn" id="wh-provision">生成公网链接</button>
            </div>
          </div>` : `
          <div class="wh-fields">
            <div class="wh-row">
              <span class="wh-lab">POST 到</span>
              <code class="wh-val" title="${esc(url)}">${esc(url)}</code>
              <button type="button" class="ghost-btn" data-copy="url" title="复制">复制</button>
            </div>
            <div class="wh-row">
              <span class="wh-lab">密钥</span>
              <code class="wh-val">${showKey ? esc(key) : esc(mask(key))}</code>
              <button type="button" class="ghost-btn" data-toggle-key>${showKey ? "隐藏" : "显示"}</button>
              <button type="button" class="ghost-btn" data-copy="key">复制</button>
            </div>
            <div class="wh-row">
              <span class="wh-lab">请求头</span>
              <code class="wh-val">${showHdr ? esc(header) : esc(mask(header))}</code>
              <button type="button" class="ghost-btn" data-toggle-hdr>${showHdr ? "隐藏" : "显示"}</button>
              <button type="button" class="ghost-btn" data-copy="hdr">复制</button>
            </div>
          </div>
          <div class="hint">公网链接本身就是密钥，POST JSON 即可，例如 <code>{"message":"要做的事"}</code>。电脑在线时几秒内进对话；紧急可加 <code>"priority":"urgent"</code>。
            ${kind === "local" ? "<br/>当前是本机地址；要公网链接请先在上面粘贴 Cloudflare Token 生成。" : ""}</div>
        `}
        ${msg ? `<div class="hint">${esc(msg)}</div>` : ""}
        <div class="wh-foot">
          <button type="button" class="ghost-btn" id="wh-pause">${t.enabled ? "暂停" : "启用"}</button>
          <button type="button" class="ghost-btn" id="wh-edit">编辑</button>
          <button type="button" class="ghost-btn" id="wh-rotate" title="旧链接立刻失效">换新密钥</button>
          <button type="button" class="icon-btn danger-text" id="wh-del" title="删除例行">🗑</button>
        </div>
      </div>`;

    const copy = async (text, ok) => {
      try {
        await navigator.clipboard.writeText(text);
        msg = ok;
        render();
      } catch { alert("复制失败"); }
    };
    body.querySelector('[data-copy="url"]')?.addEventListener("click", () => copy(url, "已复制 POST 链接"));
    body.querySelector('[data-copy="key"]')?.addEventListener("click", () => copy(key, "已复制密钥"));
    body.querySelector('[data-copy="hdr"]')?.addEventListener("click", () => copy(header, "已复制请求头"));
    body.querySelector("[data-toggle-key]")?.addEventListener("click", () => { showKey = !showKey; render(); });
    body.querySelector("[data-toggle-hdr]")?.addEventListener("click", () => { showHdr = !showHdr; render(); });
    body.querySelector("#wh-open-cloud")?.addEventListener("click", () => {
      closeModal();
      vaultFlow("share");
    });
    body.querySelector("#wh-provision")?.addEventListener("click", async () => {
      const apiToken = body.querySelector("#wh-cf-token")?.value.trim();
      if (!apiToken) { msg = "请先粘贴 Cloudflare API Token"; render(); return; }
      const btn = body.querySelector("#wh-provision");
      if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
      msg = "正在用 Token 生成公网地址…";
      try {
        const r = await api.connect.provisionShareBridge({ apiToken });
        if (!r.ok) { msg = [r.error || "生成失败", r.hint].filter(Boolean).join("\n"); render(); return; }
        const base = String(r.base || "").replace(/\/$/, "");
        const post = base && t.webhookToken ? `${base}/w/${t.webhookToken}` : base;
        if (post) await navigator.clipboard.writeText(post).catch(() => {});
        msg = post ? `已生成并复制：${post}` : "已生成公网地址";
        render();
      } catch (e) { msg = errText(e); render(); }
    });
    body.querySelector("#wh-pause")?.addEventListener("click", async () => {
      await api.tasks.setEnabled(id, !t.enabled);
      msg = t.enabled ? "已暂停" : "已启用";
      if (currentBot) renderDetails(currentBot);
      render();
    });
    body.querySelector("#wh-edit")?.addEventListener("click", () => {
      closeModal();
      routineEditFlow(t, bot);
    });
    body.querySelector("#wh-rotate")?.addEventListener("click", async () => {
      if (!confirm("换新后旧链接与密钥立刻失效，确定？")) return;
      try {
        await api.tasks.rotateWebhook(id);
        msg = "已换新密钥";
        showKey = false;
        showHdr = false;
        render();
      } catch (e) { alert(errText(e)); }
    });
    body.querySelector("#wh-del")?.addEventListener("click", async () => {
      if (!confirm("删除这条例行？")) return;
      await api.tasks.remove(id);
      closeModal();
      if (currentBot) renderDetails(currentBot);
    });
  };
  await render();
}

async function routineCreateFlow(bot) {
  if (!bot) return;
  const modal = sheet({ icon: "⏰", title: `新建例行 · ${bot.name}`, sub: "到点或 Webhook 唤醒它做事" });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `
    <div class="mx-form mx-grid">
      <label>名称</label><input id="rc-name" placeholder="每日早报" />
      <label>频率</label><span class="mx-row">
        <select id="rc-freq" class="skin-select"><option value="day">每天</option><option value="work">工作日</option><option value="week">每周</option><option value="cron">自定义 cron</option></select>
        <select id="rc-wd" class="skin-select">${WEEK.map((w, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>周${w}</option>`).join("")}</select>
        <input id="rc-time" type="time" value="09:00" />
        <input id="rc-cron" placeholder="0 9 * * *" style="display:none" />
      </span>
      <label>时区</label>${timezoneSelectHtml("rc-tz", "")}
      <label>要做什么</label><textarea id="rc-prompt" rows="3" placeholder="生成今日早报…"></textarea>
    </div>
    <div class="hint">这是<strong>定时</strong>例行，默认不开 Webhook。需要入站链接请到例行页选「Webhook」页签单独创建。</div>
    <div class="tk-err hint"></div>
    <div class="actions"><button class="ghost-btn" id="rc-cancel">取消</button><button class="primary-btn" id="rc-ok">创建定时</button></div>`;
  const sync = () => {
    const v = body.querySelector("#rc-freq").value;
    body.querySelector("#rc-wd").style.display = v === "week" ? "" : "none";
    body.querySelector("#rc-time").style.display = v === "cron" ? "none" : "";
    body.querySelector("#rc-cron").style.display = v === "cron" ? "" : "none";
  };
  body.querySelector("#rc-freq").onchange = sync; sync();
  body.querySelector("#rc-cancel").onclick = closeModal;
  body.querySelector("#rc-ok").onclick = async () => {
    const err = body.querySelector(".tk-err");
    const prompt = body.querySelector("#rc-prompt").value.trim();
    if (!prompt) { err.textContent = "写一下要做什么"; return; }
    const [hh, mm] = body.querySelector("#rc-time").value.split(":").map(Number);
    const freq = body.querySelector("#rc-freq").value;
    const cron = { day: `${mm} ${hh} * * *`, work: `${mm} ${hh} * * 1-5`, week: `${mm} ${hh} * * ${body.querySelector("#rc-wd").value}`, cron: body.querySelector("#rc-cron").value.trim() }[freq];
    try {
      await api.tasks.create({
        botId: bot.id,
        name: body.querySelector("#rc-name").value.trim() || prompt.slice(0, 16),
        cron, prompt, source: "manual",
        timezone: body.querySelector("#rc-tz")?.value || undefined,
      });
      closeModal();
      if (currentBot) renderDetails(currentBot);
    } catch (e) { err.textContent = errText(e); }
  };
}
async function routineEditFlow(t, bot) {
  const modal = sheet({ icon: "⏰", title: `编辑例行 · ${t.name}`, sub: bot?.name || "" });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `
    <div class="mx-form mx-grid">
      <label>名称</label><input id="re-name" value="${esc(t.name)}" />
      <label>cron</label><input id="re-cron" value="${esc(t.cron)}" ${t.kind === "once" ? "disabled" : ""} />
      <label>时区</label>${timezoneSelectHtml("re-tz", t.timezone || "")}
      <label>指令</label><textarea id="re-prompt" rows="4">${esc(t.prompt || "")}</textarea>
    </div>
    <div class="tk-err hint"></div>
    <div class="actions"><button class="ghost-btn" id="re-cancel">取消</button><button class="primary-btn" id="re-ok">保存</button></div>`;
  body.querySelector("#re-cancel").onclick = closeModal;
  body.querySelector("#re-ok").onclick = async () => {
    try {
      const patch = {
        name: body.querySelector("#re-name").value.trim(),
        prompt: body.querySelector("#re-prompt").value,
        timezone: body.querySelector("#re-tz")?.value || "",
      };
      if (t.kind !== "once") patch.cron = body.querySelector("#re-cron").value.trim();
      await api.tasks.update(t.id, patch);
      closeModal();
      if (currentBot) renderDetails(currentBot);
    } catch (e) { body.querySelector(".tk-err").textContent = errText(e); }
  };
}
async function tasksFlow() {
  const modal = sheet({ icon: "⏰", title: "例行", sub: "到点或 Webhook 唤醒 bot；可试跑、暂停、查看历史", wide: true });
  const body = modal.querySelector(".mx-body");
  let mode = "repeat";
  const stop = () => offTasks?.();
  const render = async () => {
    if (!modal.isConnected) return stop();
    const tasks = await api.tasks.list();
    const sel = currentBot?.id ?? bots[0]?.id;
    body.innerHTML = `${notifyBlocked ? NOTIFY_HINT() : ""}
      <div class="d-sec mx-form">
        <div class="mx-seg">
          <button data-mode="repeat" class="${mode === "repeat" ? "on" : ""}">定时</button>
          <button data-mode="once" class="${mode === "once" ? "on" : ""}">一次性</button>
          <button data-mode="webhook" class="${mode === "webhook" ? "on" : ""}">Webhook</button>
        </div>
        <div class="mx-grid">
          <label>交给</label><select id="tk-bot" class="skin-select">${botOptions(sel)}</select>
          ${mode === "repeat" ? `
          <label>频率</label><span class="mx-row">
            <select id="tk-freq" class="skin-select"><option value="day">每天</option><option value="work">工作日</option><option value="week">每周</option><option value="month">每月</option><option value="hour">每小时</option><option value="every">每隔几分钟</option><option value="cron">自定义 cron</option></select>
            <select id="tk-wd" class="skin-select">${WEEK.map((w, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>周${w}</option>`).join("")}</select>
            <input id="tk-md" type="number" min="1" max="28" value="1" class="mx-num" title="几号" />
            <input id="tk-time" type="time" value="09:00" />
            <input id="tk-min" type="number" min="5" max="59" value="30" class="mx-num" title="每隔几分钟（至少 5）" />
            <input id="tk-cron" placeholder="0 9 * * *" />
          </span>
          <label>任务名</label><input id="tk-name" placeholder="每日早报" />
          <label>要做什么</label><textarea id="tk-prompt" rows="2" placeholder="生成今日早报：国内外要闻 5 条，各一句话"></textarea>` : mode === "webhook" ? `
          <label>名称</label><input id="tk-name" placeholder="Webhook 执行 message 任务" value="Webhook 执行 message 任务" />
          <label>指令</label><textarea id="tk-prompt" rows="4">${esc(DEFAULT_HOOK_PROMPT)}</textarea>
          <label></label><div class="hint">只在收到 Webhook 时跑，不会按点执行。创建后可复制 POST / 密钥。</div>` : `
          <label>多久后</label><span class="mx-row"><input id="tk-after" type="number" min="1" value="15" class="mx-num" /> 分钟</span>
          <label>提醒内容</label><input id="tk-text" placeholder="喝水、起来活动一下" />
          <label></label><label class="chk"><input id="tk-pet" type="checkbox" checked /> 让宠物冒气泡提醒</label>`}
        </div>
        <div class="tk-err hint"></div>
        <div class="actions"><button class="primary-btn" id="tk-add">${mode === "repeat" ? "添加定时" : mode === "webhook" ? "创建 Webhook 例行" : "添加提醒"}</button></div>
      </div>
      <div class="d-sec"><h4>全部例行 · ${tasks.length}</h4>
        <div class="hint" style="margin-bottom:8px">对齐 Grok：<b>定时</b>与 <b>Webhook</b> 分开建。定时默认没有入站链接；Webhook 页签才生成。<br/>
          ⚡ 试跑 · 📋 历史（成功 / 失败）· 🪝 仅已开通时显示 · 开关＝整条例行暂停<br/>
          每个 bot 最多 50 条。定时至少隔 5 分钟。每小时单条 200 次、全部合计 300 次，超了这次不做、也不自动重试。离开超过 14 天会先暂停，打开开关即可继续。</div>
        ${tasks.map((t) => {
          const hist = (t.history || []).slice(-20).reverse();
          const lastLabel = routineResultLabel(t);
          const kindTag = t.webhookToken
            ? (t.schedule === false ? "仅 Webhook" : "定时+Webhook")
            : "定时";
          return `
          <div class="d-card" data-id="${esc(t.id)}" style="flex-wrap:wrap">
            <div class="c-main"><div class="c-title">${esc(t.name)} <span class="tag">${esc(botById(t.botId)?.name ?? "已删除的 bot")}</span> <span class="tag">${esc(kindTag)}</span>${t.source === "demo" ? ' <span class="tag">演示</span>' : ""}</div>
              <div class="c-sub">${esc(routineWhen(t))} · 已运行 ${t.runCount ?? 0} 次${lastLabel ? ` · ${lastLabel}` : ""}</div></div>
            <button class="icon-btn" data-op="run" title="立刻试跑一次（不等到点；后台执行）" ${t.lastResult === "running" ? "disabled" : ""}>⚡</button>
            <button class="icon-btn" data-op="hist" title="查看最近运行记录">📋</button>
            ${t.webhookToken
              ? `<button class="icon-btn" data-op="hook" title="查看 Webhook">🪝</button>`
              : `<button class="icon-btn" data-op="hook" title="可选：为此例行开通 Webhook">＋</button>`}
            <button class="icon-btn" data-op="del" title="删除这条例行">✕</button>
            <label class="switch" title="${t.enabled ? "暂停整条例行" : "启用"}"><input type="checkbox" data-op="toggle" ${t.enabled ? "checked" : ""}/><span></span></label>
            <div class="routine-hist hidden" data-hist="${esc(t.id)}">${hist.length
              ? hist.map((h) => `<div class="hint">${esc(fmtTime(h.ranAt))} · ${esc(routineHistLabel(h))}</div>`).join("")
              : `<div class="hint">还没有运行记录</div>`}</div>
          </div>`;
        }).join("") || `<div class="d-empty">还没有例行。也可以直接对 bot 说「每天早上 9 点给我发早报」</div>`}
      </div>`;
    body.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { mode = b.dataset.mode; render(); }));
    const freq = body.querySelector("#tk-freq");
    const syncFreq = () => {
      if (!freq) return;
      const v = freq.value;
      const show = (id, on) => (body.querySelector(id).style.display = on ? "" : "none");
      show("#tk-wd", v === "week"); show("#tk-md", v === "month"); show("#tk-time", ["day", "work", "week", "month"].includes(v));
      show("#tk-min", v === "every" || v === "hour"); show("#tk-cron", v === "cron");
      const minEl = body.querySelector("#tk-min");
      minEl.title = v === "hour" ? "每小时的第几分" : "每隔几分钟（至少 5）";
      minEl.min = v === "every" ? "5" : "0";
    };
    if (freq) { freq.onchange = syncFreq; syncFreq(); }
    const err = body.querySelector(".tk-err");
    body.querySelector("#tk-add").onclick = async () => {
      const botId = body.querySelector("#tk-bot").value;
      try {
        if (mode === "repeat") {
          const [hh, mm] = body.querySelector("#tk-time").value.split(":").map(Number);
          const rawMin = Number(body.querySelector("#tk-min").value);
          const m = freq.value === "every" ? Math.max(5, rawMin || 30) : (Number.isFinite(rawMin) ? rawMin : 30);
          const cron = { day: `${mm} ${hh} * * *`, work: `${mm} ${hh} * * 1-5`, week: `${mm} ${hh} * * ${body.querySelector("#tk-wd").value}`, month: `${mm} ${hh} ${body.querySelector("#tk-md").value} * *`, hour: `${((m % 60) + 60) % 60} * * * *`, every: `*/${m} * * * *`, cron: body.querySelector("#tk-cron").value.trim() }[freq.value];
          const prompt = body.querySelector("#tk-prompt").value.trim();
          if (!prompt) { err.textContent = "写一下要做什么"; return; }
          // 纯定时：绝不带 webhook
          await api.tasks.create({ botId, name: body.querySelector("#tk-name").value.trim() || prompt.slice(0, 16), cron, prompt });
        } else if (mode === "webhook") {
          const prompt = body.querySelector("#tk-prompt").value.trim() || DEFAULT_HOOK_PROMPT;
          const name = body.querySelector("#tk-name").value.trim() || "Webhook 执行 message 任务";
          // 仅 Webhook：开通令牌 + 关闭到点调度
          const t = await api.tasks.create({
            botId, name, prompt, cron: "0 0 1 1 *", webhook: true, schedule: false, source: "manual",
          });
          render();
          if (currentBot) renderDetails(currentBot);
          if (t?.id) await manageRoutineWebhook(t.id);
          return;
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
      card.querySelector('[data-op="run"]').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "…";
        try { await api.tasks.runNow(id); } catch (err) { alert(errText(err)); }
        render();
      };
      card.querySelector('[data-op="hist"]').onclick = () => card.querySelector(`[data-hist="${id}"]`)?.classList.toggle("hidden");
      card.querySelector('[data-op="hook"]').onclick = async () => {
        await manageRoutineWebhook(id);
        render();
        if (currentBot) renderDetails(currentBot);
      };
      card.querySelector('[data-op="del"]').onclick = async () => {
        if (!confirm("删除这个例行？")) return;
        await api.tasks.remove(id);
        render();
        if (currentBot) renderDetails(currentBot);
      };
      card.querySelector('[data-op="toggle"]').onchange = (e) => api.tasks.setEnabled(id, e.target.checked);
    });
  };
  const offTasks = api.onAppChanged?.((what) => {
    if (what === "tasks" || !what) render();
  });
  const closeBtn = modal.querySelector(".mx-close");
  if (closeBtn) {
    const prev = closeBtn.onclick;
    closeBtn.onclick = () => { stop(); prev?.(); };
  }
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
            ${cu?.enabled && !cu.permissions?.accessibility ? `<div class="hint">辅助功能未生效：系统里勾的「Electron」常是另一份签名。请点「开辅助功能」让当前进程登记，完全退出后再开；若仍不行，把 Electron.app 拖进辅助功能列表。电脑操控点控还会走 Python 运行时，必要时也要给它授权。</div>` : ""}
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
/** 组队模板（与 core/group-onboard.ts 同步；UI 侧不 import core） */
const GROUP_STARTERS_UI = [
  { id: "research-write", name: "调研写作组", blurb: "一人挖资料，一人成文；用 @ 交接。", goal: "先调研再成文：明确主题与受众 → 收集要点与来源 → 提纲确认后写完整稿。成员用 @ 交接，不要假装并行。", roleHints: ["调研", "研究", "搜索", "写作", "文案", "编辑", "报告"] },
  { id: "triage", name: "分诊评审组", blurb: "复述需求 → 谁合适 → 定下一步。", goal: "分诊用户需求：复述约束 → 候选负责人与理由 → 简单任务 bot.ask，多人同场用 @ 交接 → 回执谁负责、下一步、何时更新。", roleHints: ["产品", "工程", "开发", "风险", "评审", "主控", "助手"] },
  { id: "daily-review", name: "日报复盘组", blurb: "主持串场，成员补完成/风险/明日。", goal: "日报复盘：主持人串场收集今日完成、进行中、风险阻塞、明日计划；结构输出 Markdown，不编造未确认事项。", roleHints: ["主持", "记录", "秘书", "助理", "主控", "助手"] },
];

function pickGroupMembersUI(starter, fallbackIds = []) {
  const scored = bots.map((b) => {
    const blob = `${b.name} ${b.role || ""}`.toLowerCase();
    const hits = starter.roleHints.filter((h) => blob.includes(h.toLowerCase())).length;
    return { id: b.id, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  const out = [];
  for (const x of scored) { if (out.length >= 4) break; if (!out.includes(x.id)) out.push(x.id); }
  for (const id of fallbackIds) { if (out.length >= 2) break; if (!out.includes(id)) out.push(id); }
  for (const b of bots) { if (out.length >= 2) break; if (!out.includes(b.id)) out.push(b.id); }
  return out;
}

async function openCreatedGroup(g) {
  await refreshBots();
  const ng = groupList.find((x) => x.id === g.id) ?? g;
  await selectGroup(ng, g.welcomeSessionId || undefined);
}

async function groupsFlow(opts = {}) {
  const GROUP_MAX_MEMBERS = 6;
  if (bots.length < 2) {
    alert("至少需要 2 个 bot 才能建群。先去新建几个 bot。");
    if (typeof createBotFlow === "function") createBotFlow();
    return;
  }
  const modal = sheet({ icon: "👥", title: "群聊", sub: "组队做事：选模板或自建；@ 谁谁回，没 @ 由主持人先说（每群最多 6 人）" });
  const body = modal.querySelector(".mx-body");
  const picked = new Set(opts.memberIds?.length ? opts.memberIds : (currentBot ? [currentBot.id] : []));
  let starterId = opts.starterId || "";
  let goalDraft = opts.goal || "";
  const render = async () => {
    const gs = await api.groups.list();
    const starter = GROUP_STARTERS_UI.find((s) => s.id === starterId);
    body.innerHTML = `
      <div class="d-sec"><h4>组队模板</h4>
        <div class="gf-starters">${GROUP_STARTERS_UI.map((s) => `
          <button type="button" class="gf-starter ${starterId === s.id ? "on" : ""}" data-sid="${esc(s.id)}">
            <b>${esc(s.name)}</b><span>${esc(s.blurb)}</span>
          </button>`).join("")}</div>
        <div class="hint">点模板会预填群名、目标，并按角色关键词建议成员；仍可改。</div>
      </div>
      <div class="d-sec mx-form"><h4>新建群聊</h4>
        <input id="gf-name" placeholder="群名，例如「产品组」" value="${esc(starter?.name || "")}" />
        <textarea id="gf-goal" rows="2" placeholder="群目标（可选，会注入每位成员的提示）">${esc(goalDraft || starter?.goal || "")}</textarea>
        <div class="gf-members">${bots.map((b) => `<button class="gf-m ${picked.has(b.id) ? "on" : ""}" data-id="${esc(b.id)}"><span class="bot-avatar">${avatarHtml(b)}</span>${esc(b.name)}</button>`).join("")}</div>
        <div class="gf-err hint"></div>
        <div class="actions"><button class="primary-btn" id="gf-add">创建（已选 ${picked.size}/${GROUP_MAX_MEMBERS}）</button></div>
      </div>
      <div class="d-sec"><h4>已有群聊 · ${gs.length}</h4>
        ${gs.map((g) => `
          <div class="d-card gf-card" data-id="${esc(g.id)}" style="cursor:pointer">
            <div class="group-avatars">${g.members.map(botById).filter(Boolean).slice(0, 3).map((m) => `<span>${avatarHtml(m)}</span>`).join("") || "<span>👥</span>"}</div>
            <div class="c-main"><div class="c-title">${esc(g.name)}</div><div class="c-sub">${g.settings?.goal ? esc(g.settings.goal.slice(0, 48)) + (g.settings.goal.length > 48 ? "…" : "") : g.members.map((m) => esc(botById(m)?.name || "?")).join("、")}</div></div>
            <button class="ghost-btn danger-text" data-del>解散</button>
          </div>`).join("") || `<div class="d-empty">还没有群聊。用上面的模板组队最快。</div>`}
      </div>`;
    const nameEl = body.querySelector("#gf-name");
    const goalEl = body.querySelector("#gf-goal");
    body.querySelectorAll(".gf-starter").forEach((btn) => (btn.onclick = () => {
      starterId = btn.dataset.sid;
      const s = GROUP_STARTERS_UI.find((x) => x.id === starterId);
      if (s) {
        goalDraft = s.goal;
        picked.clear();
        for (const id of pickGroupMembersUI(s, currentBot ? [currentBot.id] : [])) picked.add(id);
      }
      render();
    }));
    body.querySelectorAll(".gf-m").forEach((b) => (b.onclick = () => {
      if (!picked.has(b.dataset.id) && picked.size >= GROUP_MAX_MEMBERS) {
        body.querySelector(".gf-err").textContent = `一个群最多 ${GROUP_MAX_MEMBERS} 个成员`;
        return;
      }
      picked.has(b.dataset.id) ? picked.delete(b.dataset.id) : picked.add(b.dataset.id);
      goalDraft = goalEl.value;
      const v = nameEl.value;
      const sid = starterId;
      render().then(() => {
        body.querySelector("#gf-name").value = v;
        starterId = sid;
      });
    }));
    body.querySelector("#gf-add").onclick = async () => {
      const name = body.querySelector("#gf-name").value.trim();
      const goal = body.querySelector("#gf-goal").value.trim();
      const err = body.querySelector(".gf-err");
      if (!name) { err.textContent = "起个群名"; return; }
      if (picked.size < 2) { err.textContent = "至少选 2 个成员"; return; }
      if (picked.size > GROUP_MAX_MEMBERS) { err.textContent = `一个群最多 ${GROUP_MAX_MEMBERS} 个成员`; return; }
      const members = bots.map((b) => b.id).filter((id) => picked.has(id));
      let g;
      try {
        g = await api.groups.create(name, members, {
          settings: goal ? { goal, relay: true } : { relay: true },
          starterId: starterId || undefined,
        });
      } catch (e) { err.textContent = e?.message || String(e); return; }
      closeModal();
      await openCreatedGroup(g);
    };
    body.querySelectorAll(".gf-card").forEach((card) => (card.onclick = async (e) => {
      const id = card.dataset.id;
      if (e.target.closest("[data-del]")) {
        if (!confirm("解散这个群聊？（聊天记录保留）")) return;
        await api.groups.remove(id);
        if (currentGroup?.id === id) {
          currentGroup = null;
          currentSession = null;
          renderRelayBar();
          clearMessages();
          $("#chat-bar").classList.add("hidden");
        }
        await refreshBots();
        if (!currentBot && !currentGroup) await renderEmptyState();
        return render();
      }
      closeModal();
      await refreshBots();
      const g = groupList.find((x) => x.id === id);
      if (g) selectGroup(g);
    }));
  };
  if (opts.starterId) {
    const s = GROUP_STARTERS_UI.find((x) => x.id === opts.starterId);
    if (s && picked.size < 2) {
      for (const id of pickGroupMembersUI(s, [...picked])) picked.add(id);
    }
  }
  render();
}

function soLogo(id, size = 28) {
  const brand = id?.brand || "unknown";
  const mark = esc(id?.mark || "·");
  const label = esc(id?.label || "");
  if (id?.iconDataUrl) {
    return `<span class="so-logo so-logo-${size}" title="${label}"><img src="${esc(id.iconDataUrl)}" alt="${label}" /></span>`;
  }
  return `<span class="so-logo so-logo-${size} so-brand-${esc(brand)}" title="${label}" aria-label="${label}"><span class="so-mark">${mark}</span></span>`;
}

function soKindTag(kind) {
  const map = { app: "软件", cli: "命令行", system: "系统盘", unknown: "进程", data: "数据盘", external: "外置", network: "网络", other: "卷" };
  return map[kind] || kind || "";
}

/* ---- 系统能力（本机权限总览；监听名单在 bot 详情） ---- */
async function systemManageFlow() {
  const modal = sheet({ icon: "🖥", title: "系统能力", sub: "本机权限与磁盘；要听哪些 App 请到 bot 详情「系统监听」", wide: false });
  const body = modal.querySelector(".mx-body");
  const render = async () => {
    body.innerHTML = `<div class="d-empty">读取中…</div>`;
    const st = await api.systemObserve?.status?.().catch(() => null);
    if (!st) {
      body.innerHTML = `<div class="d-empty">系统观察未就绪（需重建壳）</div>`;
      return;
    }
    const c = st.caps || {};
    const front = st.snap?.frontmost || {};
    const frontId = front.identity ? { ...front.identity, iconDataUrl: front.iconDataUrl || front.identity.iconDataUrl } : null;
    const disk = (st.snap?.disk || []).filter((d) => d.mount === "/" || d.mount.includes("Data")).slice(0, 2);
    const bot = currentBot;

    body.innerHTML = `
      <div class="d-sec">
        <div class="sw-callout">
          <div class="c-main">
            <div class="c-title">监听名单挂在 bot 上</div>
            <div class="c-sub">每个 bot 自己勾选要盯的 App；sys.* 默认按该名单。不在这里刷全机进程，避免打扰对话。</div>
          </div>
          <button class="primary-btn" id="so-bot-watch" ${bot ? "" : "disabled"}>${bot ? `打开「${esc(bot.name)}」监听` : "先选一个 bot"}</button>
        </div>
      </div>
      <div class="d-sec"><h4>本机权限</h4>
        <div class="so-cap-grid so-cap-compact">
          <div class="so-cap"><span class="so-logo so-logo-28 so-brand-macos"><span class="so-mark">观</span></span><div><div class="so-cap-t">系统观察</div><div class="so-cap-s">sys.*</div></div><span class="tag on">开</span></div>
          <div class="so-cap">${soLogo({ brand: "macos", mark: "AX", label: "辅助功能" }, 28)}<div><div class="so-cap-t">辅助功能</div></div>${c.accessibility ? '<span class="tag on">已授权</span>' : '<button class="ghost-btn" data-pref="accessibility">去授权</button>'}</div>
          <div class="so-cap">${soLogo({ brand: "disk", mark: "SCR", label: "屏幕录制" }, 28)}<div><div class="so-cap-t">屏幕录制</div></div>${c.screen ? '<span class="tag on">已授权</span>' : '<button class="ghost-btn" data-pref="screen">去授权</button>'}</div>
          <div class="so-cap">${soLogo({ brand: "electron", mark: "CU", label: "电脑操控" }, 28)}<div><div class="so-cap-t">电脑操控</div></div>${c.computerUse ? '<span class="tag on">已启用</span>' : '<button class="ghost-btn" id="so-cu">去打开</button>'}</div>
        </div>
      </div>
      <div class="d-sec"><h4>此刻</h4>
        <div class="d-card so-app-card sw-front-slim">
          ${frontId ? soLogo(frontId, 28) : soLogo({ brand: "unknown", mark: "?", label: "未知" }, 28)}
          <div class="c-main">
            <div class="c-title">${esc(frontId?.label || front.name || "—")}</div>
            <div class="c-sub">前台</div>
          </div>
        </div>
        ${disk.map((d) => {
          const warn = d.usedPct >= 85;
          return `<div class="d-card so-disk-card ${warn ? "so-warn" : ""}" style="margin-top:6px">
            ${soLogo({ brand: "disk", mark: "HD", label: d.mount }, 28)}
            <div class="c-main">
              <div class="c-title">${esc(d.mount)} · ${d.usedPct}%</div>
              <div class="so-bar"><i style="width:${Math.min(100, d.usedPct)}%"></i></div>
            </div>
          </div>`;
        }).join("")}
      </div>
      <div class="actions" style="margin-top:10px">
        <button class="ghost-btn" id="so-refresh">刷新</button>
        <button class="ghost-btn" id="so-auth">系统授权</button>
      </div>`;
    body.querySelectorAll("[data-pref]").forEach((b) => (b.onclick = () => api.system.openPrefs(b.dataset.pref)));
    body.querySelector("#so-cu")?.addEventListener("click", () => { closeModal(); mcpFlow(); });
    body.querySelector("#so-refresh")?.addEventListener("click", () => render());
    body.querySelector("#so-auth")?.addEventListener("click", () => { closeModal(); sysaccessFlow(); });
    body.querySelector("#so-bot-watch")?.addEventListener("click", () => {
      if (!currentBot) return;
      closeModal();
      detailsTab = "info";
      if (typeof revealDetailsAdvanced === "function") revealDetailsAdvanced();
      toggleDetails(true);
      requestAnimationFrame(() => document.getElementById("d-watch")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    });
  };
  await render();
}

/** bot 详情：手动勾选要监听的 App */
async function pickWatchAppsFlow(botId) {
  const bot = botById(botId);
  if (!bot || !api.systemWatch) return;
  const modal = sheet({ icon: "👁", title: `选择监听 · ${bot.name}`, sub: "勾选后，这个 bot 的 sys.observe / sys.processes 默认只盯这些 App", wide: true });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `<div class="d-empty">扫描 Applications…</div>`;
  const [watch, installed] = await Promise.all([
    api.systemWatch.get(botId).catch(() => ({ enabled: true, apps: [] })),
    api.systemWatch.installedApps().catch(() => []),
  ]);
  const selected = new Set(watch.apps || []);
  const SUGGEST = ["Cursor", "Codex", "Claude", "Visual Studio Code", "Terminal", "iTerm", "Google Chrome", "Safari", "WeChat", "飞书"];
  const render = () => {
    const q = (body.querySelector("#sw-q")?.value || "").trim().toLowerCase();
    const rows = installed.filter((a) => !q || a.name.toLowerCase().includes(q));
    const suggestHits = SUGGEST
      .map((name) => installed.find((a) => a.name === name) || { name, brand: "unknown", mark: name.slice(0, 2) })
      .filter((a, i, arr) => arr.findIndex((x) => x.name === a.name) === i);
    body.innerHTML = `
      <div class="sw-pick-head">
        <input id="sw-q" class="skin-select" placeholder="搜索 App…" value="${esc(q)}" />
        <span class="hint">已选 ${selected.size}</span>
      </div>
      <div class="sw-suggest">${suggestHits.map((a) => {
        const on = selected.has(a.name);
        return `<button type="button" class="sw-chip ${on ? "on" : ""}" data-toggle="${esc(a.name)}">${soLogo({ brand: a.brand, mark: a.mark || a.name.slice(0, 2), label: a.name, iconDataUrl: a.iconDataUrl }, 20)}<span>${esc(a.name)}</span></button>`;
      }).join("")}</div>
      <div class="sw-pick-list">
        ${rows.map((a) => {
          const on = selected.has(a.name);
          return `<label class="sw-pick-row ${on ? "on" : ""}">
            <input type="checkbox" data-name="${esc(a.name)}" ${on ? "checked" : ""} />
            ${soLogo({ brand: a.brand, mark: a.mark || a.name.slice(0, 2), label: a.name, iconDataUrl: a.iconDataUrl }, 28)}
            <span class="sw-pick-name">${esc(a.name)}</span>
          </label>`;
        }).join("") || `<div class="d-empty">没有匹配的 App</div>`}
      </div>
      <div class="actions" style="margin-top:10px">
        <button class="ghost-btn" id="sw-cancel">取消</button>
        <button class="primary-btn" id="sw-save">保存名单</button>
      </div>`;
    const qEl = body.querySelector("#sw-q");
    let t = null;
    qEl?.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(render, 120);
    });
    qEl?.focus();
    if (q && qEl) qEl.setSelectionRange(q.length, q.length);
    const toggle = (name) => {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      render();
    };
    body.querySelectorAll("[data-toggle]").forEach((btn) => (btn.onclick = () => toggle(btn.dataset.toggle)));
    body.querySelectorAll("input[data-name]").forEach((inp) => (inp.onchange = () => toggle(inp.dataset.name)));
    body.querySelector("#sw-cancel").onclick = () => closeModal();
    body.querySelector("#sw-save").onclick = async () => {
      await api.systemWatch.set(botId, { apps: [...selected] });
      closeModal();
      if (typeof refreshWatchChip === "function") refreshWatchChip();
      if (currentBot?.id === botId && typeof renderDetails === "function") renderDetails(currentBot);
    };
  };
  render();
}


/* ---- 系统授权 ---- */
async function sysaccessFlow() {
  const modal = sheet({ icon: "🛡", title: "系统授权", sub: "bot 默认不能动你的电脑；要用时会在会话里请你批准，所有操作都有记录", wide: true });
  const body = modal.querySelector(".mx-body");
  let auditBot = "";
  const render = async () => {
    const [tcc, grants, caps, events, cmd, actionRules] = await Promise.all([
      api.system.tcc().catch(() => ({})), api.consent.list(), api.consent.caps(), api.audit.list({ limit: 200 }).catch(() => []),
      api.consent.rules().catch(() => ({ rules: [], trusted: [] })),
      api.consent.actionRules?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    const ruleBot = (id) => (id === "*" ? "所有 bot" : botById(id)?.name || id);
    const capLabel = (id) => caps.find((c) => c.id === id)?.label || id;
    const shown = events.filter((ev) => !auditBot || ev.botId === auditBot).slice(0, 60);
    body.innerHTML = `
      <div class="d-sec"><h4>Bot 浏览器</h4>
        <div class="hint">每个 bot 有一块内部浏览器（顶栏 🌐），登录态按 bot 隔离。网页登录、填表用它；电脑操控只留给本机 App，不要去点你的 Chrome。</div>
      </div>
      <div class="d-sec"><h4>电脑操控</h4>
        <div class="d-card"><div class="c-main"><div class="c-title">一键启用</div><div class="c-sub">自动安装运行时并连接；再到下面勾系统权限即可</div></div>
          <button class="primary-btn" id="sa-cu">打开 MCP 里的开关</button></div>
      </div>
      <div class="d-sec"><h4>macOS 权限</h4>
        <div class="d-card"><div class="c-main"><div class="c-title">辅助功能</div><div class="c-sub">bot 操作其他 App（点击、输入）需要${tcc.accessibility ? "" : " · 列表里同名 Electron 开着也可能不是当前这份"}</div></div>
          ${tcc.accessibility ? '<span class="tag on">已授权</span>' : '<span class="mx-row"><button class="ghost-btn" data-pref="accessibility">去授权</button><button class="ghost-btn" id="sa-reveal-e">显示 Electron.app</button></span>'}</div>
        ${!tcc.accessibility && tcc.hint ? `<div class="hint">${esc(tcc.hint)}</div>` : ""}
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
      <div class="d-sec"><h4>自定义规则 · ${(actionRules || []).length}</h4>
        <div class="hint">对齐 Grok Custom Rules：用一句话描述动作。Ask first 命中必问；Allow 命中可跳过常规询问（危险操作仍问）。Ask first 优先于 Allow，各最多 20 条。</div>
        ${(actionRules || []).map((r) => `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(r.text)} <span class="tag ${r.decision === "allow" ? "on" : ""}">${r.decision === "ask_first" ? "Ask first" : "Allow"}</span></div>
            <div class="c-sub">${esc(fmtTime(r.createdAt))}</div></div>
            <button class="ghost-btn danger-text" data-ar-del="${esc(r.id)}">删除</button></div>`).join("") || `<div class="d-empty">还没有自定义规则。例如：「发外部邮件」→ Ask first</div>`}
        <div class="mx-inline sa-grant">
          <input id="sa-ar-text" placeholder="例如：发外部邮件 / webhook / 删除文件" style="flex:1" />
          <select id="sa-ar-dec" class="skin-select"><option value="ask_first">Ask first</option><option value="allow">Allow</option></select>
          <button class="ghost-btn" id="sa-ar-add">添加</button>
        </div>
        <div class="ms-err hint" id="sa-ar-err"></div>
      </div>
      <div class="d-sec"><h4>命令规则 · ${cmd.rules.length}</h4>
        <div class="hint">「总是允许」的命令不再弹卡片；「禁止」的命令直接拦下。Ask/Auto 下危险命令仍每次确认；Always 模式危险命令也会直接跑，除非这里禁止。</div>
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
      <div class="d-sec"><h4>权限模式</h4>
        <div class="hint">Ask 全问 · Auto 安全自动过（危险仍问）· Always 基本全过。禁止规则始终生效，操作照常记录。</div>
        ${bots.map((b) => {
          const m = cmd.modes?.[b.id] || (cmd.trusted?.includes(b.id) ? "auto" : "ask");
          return `
          <div class="d-card"><div class="c-main"><div class="c-title">${esc(b.name)}</div><div class="c-sub">${esc(PERM_MODE_HINT[m] || PERM_MODE_HINT.ask)}</div></div>
            <select class="skin-select" data-mode="${esc(b.id)}" data-prev="${esc(m)}">
              <option value="ask" ${m === "ask" ? "selected" : ""}>Ask</option>
              <option value="auto" ${m === "auto" ? "selected" : ""}>Auto</option>
              <option value="always" ${m === "always" ? "selected" : ""}>Always</option>
            </select></div>`;
        }).join("")}
      </div>
      <div class="d-sec"><h4>操作记录 <span><select id="sa-filter" class="skin-select"><option value="">全部 bot</option>${botOptions(auditBot)}</select><button class="ghost-btn" id="sa-export">导出…</button></span></h4>
        <div class="sa-audit">${shown.map((ev) => `
          <div class="sa-ev ${ev.granted ? "" : "deny"}"><span class="sa-t">${esc(fmtTime(ev.at))}</span><span class="sa-b">${esc(botById(ev.botId)?.name || ev.botId)}</span><span class="sa-c">${esc(capLabel(ev.cap))}</span><span class="sa-a" title="${esc(ev.args || "")}">${esc(ev.action)}${ev.args ? ` · ${esc(String(ev.args).slice(0, 60))}` : ""}</span><span class="sa-r">${ev.granted ? (ev.ok === false ? "失败" : "✓") : "已拒绝"}</span></div>`).join("") || `<div class="d-empty">还没有记录</div>`}</div>
      </div>`;
    body.querySelector("#sa-cu")?.addEventListener("click", () => { closeModal(); mcpFlow(); });
    body.querySelectorAll("[data-pref]").forEach((b) => (b.onclick = () => api.system.openPrefs(b.dataset.pref)));
    body.querySelector("#sa-reveal-e")?.addEventListener("click", () => api.system.revealElectronApp?.());
    body.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => { await api.consent.revoke(b.dataset.revoke, b.dataset.cap); render(); }));
    body.querySelectorAll("[data-rule-cmd]").forEach((b) => (b.onclick = async () => { await api.consent.removeRule(b.dataset.ruleBot, b.dataset.ruleCmd); render(); }));
    body.querySelectorAll("[data-ar-del]").forEach((b) => (b.onclick = async () => { await api.consent.removeActionRule?.(b.dataset.arDel); render(); }));
    body.querySelector("#sa-ar-add")?.addEventListener("click", async () => {
      const text = body.querySelector("#sa-ar-text").value.trim();
      try {
        await api.consent.addActionRule(text, body.querySelector("#sa-ar-dec").value);
        render();
      } catch (e) { body.querySelector("#sa-ar-err").textContent = errText(e); }
    });
    body.querySelector("#sa-rule-add").onclick = async () => {
      const command = body.querySelector("#sa-rule-cmd").value.trim();
      try {
        await api.consent.setRule(body.querySelector("#sa-rule-bot").value, command, body.querySelector("#sa-rule-dec").value);
        render();
      } catch (e) { body.querySelector("#sa-rule-err").textContent = errText(e); }
    };
    body.querySelectorAll("[data-mode]").forEach((el) => (el.onchange = async () => {
      const next = el.value === "auto" || el.value === "always" ? el.value : "ask";
      const prev = el.dataset.prev || "ask";
      const name = botById(el.dataset.mode)?.name || "这个 bot";
      if (next === "always" && !confirm(`Always 模式下，${name} 将可直接执行危险命令。确定吗？`)) { el.value = prev; return; }
      if (next === "auto" && prev === "ask" && !confirm(`Auto 模式下，${name} 的 Shell / 终端 / Coding CLI 不再逐个询问（危险除外）。确定吗？`)) { el.value = prev; return; }
      await api.consent.setMode(el.dataset.mode, next);
      el.dataset.prev = next;
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

/** 关于：GitHub 链接、开源与第三方声明 */
async function aboutFlow() {
  const info = await api.system.appInfo?.().catch(() => ({ version: "?", channel: "stable", schema: "?", update: { message: "" } }));
  const modal = sheet({
    icon: "ℹ",
    title: "关于 Harness Bot",
    sub: `版本 ${info.version} · ${info.channel} · schema ${info.schema} · 本地优先`,
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
        <button type="button" class="ghost-btn" id="about-update">检查更新</button>
      </div>
      <p class="hint about-url"><code>${esc(GITHUB_REPO)}</code></p>
      <p class="hint" id="about-update-msg"></p>
    </div>
    <div class="d-sec">
      <h4>声明</h4>
      <ul class="about-list">
        <li>本项目<strong>开源</strong>（<a class="about-ext" href="${GITHUB_REPO}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>），欢迎 Fork、提 PR 与下载使用；源码与更新以 GitHub 仓库为准。</li>
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
        <li>运行时还可能用到 Electron、PixiJS、Hugging Face Transformers、xterm.js 等依赖，各自遵循其许可证。</li>
      </ul>
    </div>
    <div class="d-sec">
      <h4>参与</h4>
      <p class="hint">提交代码前请跑通 <code>bun test</code>；流程见仓库 <code>CONTRIBUTING.md</code>；大功能建议先阅读 <code>docs/goals/</code> 中对应 Goal 的边界说明。</p>
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
  body.querySelector("#about-update").onclick = async () => {
    const msg = body.querySelector("#about-update-msg");
    msg.textContent = "检查中…";
    try {
      const r = await api.system.checkUpdate();
      msg.textContent = r.message || (r.available ? "有新版本" : "已是最新");
    } catch (e) { msg.textContent = errText(e); }
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
$("#sysaccess-btn").onclick = sysaccessFlow;
$("#sysmanage-btn")?.addEventListener("click", () => systemManageFlow());
$("#env-btn").onclick = () => envFlow();
$("#vault-btn").onclick = () => vaultFlow();
$("#import-bot-btn")?.addEventListener("click", () => importBotFlow());
$("#templates-btn")?.addEventListener("click", () => templatesBrowseFlow(currentBot));
$("#mcp-btn").onclick = mcpFlow;

/** 本地模板库：内置技能模板 + 导入 harnessbot */
async function templatesBrowseFlow(bot) {
  const modal = sheet({ icon: "📦", title: "本地模板", sub: "内置技能模板 · 导入别人分享的 bot（无云端商店）", wide: true });
  const body = modal.querySelector(".mx-body");
  const render = async () => {
    const templates = await api.skills.templates().catch(() => []);
    body.innerHTML = `
      <div class="d-sec"><h4>技能模板</h4>
        ${templates.map((t) => `
          <div class="d-card" data-tk="${esc(t.key)}">
            <div class="c-main"><div class="c-title">${esc(t.name)} ${t.installed ? '<span class="tag">已有</span>' : ""}</div>
              <div class="c-sub">${esc(t.description)}</div></div>
            <button class="ghost-btn" data-op="install">${t.installed ? "再装私有" : "安装"}</button>
            ${bot ? `<button class="ghost-btn" data-op="routine" title="安装并为当前 bot 挂例行">＋例行</button>` : ""}
          </div>`).join("") || `<div class="d-empty">没有模板</div>`}
      </div>
      <div class="d-sec"><h4>Bot 模板</h4>
        <div class="hint">别人分享的 harnessbot:// 链接或 .harnessbot 文件，导入后得到同样设定的 bot。</div>
        <div class="actions"><button class="primary-btn" id="tb-import">导入 bot 模板…</button></div>
      </div>`;
    body.querySelector("#tb-import").onclick = () => { closeModal(); importBotFlow(); };
    body.querySelectorAll("[data-tk]").forEach((card) => {
      const key = card.dataset.tk;
      card.querySelector('[data-op="install"]').onclick = async () => {
        try {
          await api.skills.installTemplate(key, bot?.id);
          alert("已安装");
          render();
          if (currentBot) renderDetails(currentBot);
        } catch (e) { alert(errText(e)); }
      };
      const rbtn = card.querySelector('[data-op="routine"]');
      if (rbtn) rbtn.onclick = async () => {
        if (!bot) return;
        try {
          const skill = await api.skills.installTemplate(key, bot.id);
          await api.tasks.create({
            botId: bot.id,
            name: `例行：${skill.name}`,
            cron: "0 9 * * 1-5",
            prompt: `请按技能 [${skill.name}](app:skill/${skill.key}) 执行一遍，按当前环境调整后汇报。`,
            skillKey: skill.key,
            source: "template",
          });
          alert(`已为 ${bot.name} 安装技能并挂工作日 09:00 例行`);
          closeModal();
          if (currentBot) renderDetails(currentBot);
        } catch (e) { alert(errText(e)); }
      };
    });
  };
  render();
}

/* ---- Connect 应用（本机目录；无 OAuth / 支付 / 云邮箱） ---- */
async function vaultFlow(initialTab) {
  const modal = sheet({ icon: "🔗", title: "Connect", sub: "粘贴 Cloudflare Token，生成你的公网地址 · 出站 Webhook · 本机网关备用", wide: true });
  const body = modal.querySelector(".mx-body");
  const allowed = new Set(["apps", "overview", "logins", "contacts", "webhooks", "gateway", "share", "mcp"]);
  let tab = allowed.has(initialTab) ? initialTab : "apps";
  let catalog = await api.vault.catalog().catch(() => ({ secrets: 0, env: 0, contacts: 0, logins: 0, webhooks: 0, mcp: [], cli: [] }));
  let contactList = await api.contacts.list().catch(() => []);
  let loginList = await api.logins?.list?.().catch(() => []) ?? [];
  let editingLogin = null;
  let hooks = await api.connectors.listWebhooks().catch(() => []);
  let cards = await api.connect.cards().catch(() => []);
  let gw = await api.connect.gateway().catch(() => ({ enabled: false, running: false, port: 8787, host: "127.0.0.1" }));
  let bridge = await api.connect.shareBridge?.().catch(() => ({ configured: false, base: "", hasKey: false, keyHint: "", path: "" }))
    ?? { configured: false, base: "", hasKey: false, keyHint: "", path: "" };
  let bridgeMsg = "";
  let bridgeProvisionSteps = [];
  let gwMsg = "";
  let shareEdit = true; // 配置区默认展开，避免用户找不到密钥/地址
  let shareLinks = { items: [], truncated: false, ttlDays: 90, error: "" };
  let inboundHooks = [];
  let editingContact = null;
  let editingHook = null;
  const loadShareLinks = async () => {
    if (!bridge.configured || !api.connect.listShareLinks) {
      shareLinks = { items: [], truncated: false, ttlDays: 90, error: "" };
      return;
    }
    try {
      const r = await api.connect.listShareLinks();
      shareLinks = { items: r.items || [], truncated: !!r.truncated, ttlDays: r.ttlDays || 90, error: "" };
    } catch (e) {
      shareLinks = { items: [], truncated: false, ttlDays: 90, error: errText(e) };
    }
  };
  const loadInboundHooks = async () => {
    const tasks = await api.tasks.list().catch(() => []);
    const base = String(bridge.base || "").replace(/\/$/, "");
    inboundHooks = (tasks || []).filter((t) => t.webhookToken).map((t) => ({
      id: t.id,
      name: t.name || "Webhook",
      enabled: t.enabled !== false,
      url: base ? `${base}/w/${t.webhookToken}` : "",
    }));
  };
  const refresh = async () => {
    catalog = await api.vault.catalog().catch(() => catalog);
    contactList = await api.contacts.list().catch(() => contactList);
    loginList = await api.logins?.list?.().catch(() => loginList) ?? loginList;
    hooks = await api.connectors.listWebhooks().catch(() => hooks);
    cards = await api.connect.cards().catch(() => cards);
    gw = await api.connect.gateway().catch(() => gw);
    bridge = await api.connect.shareBridge?.().catch(() => bridge) ?? bridge;
    if (tab === "share") {
      await loadShareLinks();
      await loadInboundHooks();
    }
    render();
  };
  const installCard = async (card) => {
    if (card.kind === "computer") { closeModal(); return mcpFlow(); }
    if (card.kind === "secret") { closeModal(); return envFlow(); }
    if (card.kind === "share") { tab = "share"; shareEdit = true; await loadShareLinks(); await loadInboundHooks(); return render(); }
    if (card.kind === "webhook") { tab = "webhooks"; editingHook = { name: "", url: "" }; return render(); }
    if (card.kind === "mcp" && card.mcp) {
      const servers = await (api.mcp.serversAll?.() || api.mcp.servers()).catch(() => []);
      const id = card.mcp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (servers.some((s) => s.id === id || s.name === card.mcp.name)) {
        alert(`「${card.mcp.name}」似乎已添加，打开 MCP 页管理。`);
        closeModal();
        return mcpFlow();
      }
      const env = card.mcp.envHint
        ? Object.fromEntries(card.mcp.envHint.split(";").map((x) => x.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join("=").trim()]))
        : undefined;
      const next = [...servers.filter((s) => s.id !== "computer" || s.builtin !== false), {
        id, name: card.mcp.name, command: card.mcp.command, args: card.mcp.args, ...(env ? { env } : {}),
      }];
      await api.mcp.saveServers(next.map(({ tools: _t, error: _e, connected: _c, ...s }) => s));
      alert(`已添加「${card.name}」。若需 Token，先在环境配置里存密钥，命令里用 {{secret:名字}}。`);
      closeModal();
      return mcpFlow();
    }
  };
  const render = () => {
    const tabs = [
      ["apps", "应用"],
      ["overview", "保险库"],
      ["logins", "登录"],
      ["contacts", "通讯录"],
      ["webhooks", "出站 Webhook"],
      ["share", "云服务"],
      ["gateway", "本机网关"],
      ["mcp", "MCP / CLI"],
    ].map(([id, label]) => `<button class="ghost-btn ${tab === id ? "on" : ""}" data-tab="${id}">${label}</button>`).join("");
    let main = "";
    if (tab === "apps") {
      const installedMcp = new Set((catalog.mcp || []).map((m) => (m.name || "").toLowerCase()));
      main = `
        <div class="d-sec">
          <div class="hint">生成公网地址：打开「云服务」，粘贴 Cloudflare API Token，点「生成公网链接」。返回的 <code>*.workers.dev</code> 就是你的桥；要呼叫某个 bot，再复制下面或例行 🪝 里的 <code>/w/…</code> 链接。云：${bridge.configured ? "已开通" : "未开通"} · 本机网关：${gw.running ? "运行中" : "未开"}。</div>
          <div class="connect-grid">${cards.map((c) => {
            const on = c.kind === "mcp" && installedMcp.has((c.mcp?.name || "").toLowerCase());
            return `<button class="connect-card" data-cid="${esc(c.id)}">
              <div class="cc-title">${esc(c.name)}${c.badge ? ` <span class="tag">${esc(c.badge)}</span>` : ""}${on ? ' <span class="tag">已装</span>' : ""}</div>
              <div class="cc-sub">${esc(c.blurb)}</div>
              <div class="cc-act">${on ? "管理" : c.kind === "mcp" ? "安装" : "打开"}</div>
            </button>`;
          }).join("")}</div>
        </div>`;
    } else if (tab === "overview") {
      main = `
        <div class="d-sec">
          <div class="d-card"><div class="c-main"><div class="c-title">密钥</div><div class="c-sub">${catalog.secrets} 项 · 加密本机</div></div><button class="ghost-btn" id="v-env">打开环境配置</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">环境变量</div><div class="c-sub">${catalog.env} 项 · 明文配置</div></div><button class="ghost-btn" id="v-env2">打开环境配置</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">登录</div><div class="c-sub">${catalog.logins || 0} 项 · 密码不回显</div></div><button class="ghost-btn" data-goto="logins">管理</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">通讯录</div><div class="c-sub">${catalog.contacts} 人 · 无支付</div></div><button class="ghost-btn" data-goto="contacts">管理</button></div>
          <div class="d-card"><div class="c-main"><div class="c-title">出站 Webhook</div><div class="c-sub">${catalog.webhooks} 个端点</div></div></div>
          <div class="hint">密钥用 {{secret:名字}}。网站登录用「登录」页；入站例行触发在「例行」卡片里开通 Webhook 令牌。不做银行卡/支付。</div>
        </div>`;
    } else if (tab === "logins") {
      main = `<div class="d-sec"><h4>网站登录 <button class="list-add" id="lg-new" title="添加">＋</button></h4>
        <div class="hint">对齐 Grok Vault Login：网站 + 用户名 + 密码。密码只进保险库，列表永不回显。bot 用 browser.fillLogin 填充。</div>
        ${loginList.map((l) => `<div class="d-card" data-lid="${esc(l.id)}"><div class="c-main"><div class="c-title">${esc(l.website)}</div><div class="c-sub">${esc([l.username, l.hint, "密码已存"].filter(Boolean).join(" · "))}</div></div>
          <button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button></div>`).join("") || `<div class="d-empty">还没有登录项</div>`}
        ${editingLogin ? `<div class="mx-form"><h4>${editingLogin.id ? "编辑" : "添加"}登录</h4>
          <div class="mx-grid"><label>网站</label><input id="lg-web" value="${esc(editingLogin.website ?? "")}" placeholder="https://example.com" />
          <label>用户名</label><input id="lg-user" value="${esc(editingLogin.username ?? "")}" />
          <label>密码</label><input id="lg-pass" type="password" placeholder="${editingLogin.id ? "留空则不改密码" : "必填"}" autocomplete="new-password" />
          <label>Hints</label><input id="lg-hint" value="${esc(editingLogin.hint ?? "")}" placeholder="何时用，例如工作账号" />
          <label>备注</label><input id="lg-note" value="${esc(editingLogin.note ?? "")}" placeholder="可选" /></div>
          <div class="actions"><button class="ghost-btn" id="lg-cancel">取消</button><button class="primary-btn" id="lg-save">保存</button></div></div>` : ""}
      </div>`;
    } else if (tab === "contacts") {
      main = `<div class="d-sec"><h4>通讯录 <button class="list-add" id="ct-new" title="添加">＋</button></h4>
        ${contactList.map((c) => `<div class="d-card" data-cid="${esc(c.id)}"><div class="c-main"><div class="c-title">${esc(c.name)}</div><div class="c-sub">${esc([c.email, c.phone, c.hint, c.note].filter(Boolean).join(" · ") || "无备注")}</div></div>
          <button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button></div>`).join("") || `<div class="d-empty">还没有联系人</div>`}
        ${editingContact ? `<div class="mx-form"><h4>${editingContact.id ? "编辑" : "添加"}联系人</h4>
          <div class="mx-grid"><label>姓名</label><input id="ct-name" value="${esc(editingContact.name ?? "")}" />
          <label>邮箱</label><input id="ct-email" value="${esc(editingContact.email ?? "")}" placeholder="可选" />
          <label>电话</label><input id="ct-phone" value="${esc(editingContact.phone ?? "")}" placeholder="可选" />
          <label>地址</label><input id="ct-addr" value="${esc(editingContact.address ?? "")}" placeholder="可选" />
          <label>Hints</label><input id="ct-hint" value="${esc(editingContact.hint ?? "")}" placeholder="何时用" />
          <label>备注</label><input id="ct-note" value="${esc(editingContact.note ?? "")}" placeholder="可选" /></div>
          <div class="actions"><button class="ghost-btn" id="ct-cancel">取消</button><button class="primary-btn" id="ct-save">保存</button></div></div>` : ""}
      </div>`;
    } else if (tab === "webhooks") {
      const hdrText = (h) => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
      main = `<div class="d-sec"><h4>出站 HTTP Webhook <button class="list-add" id="wh-new" title="添加">＋</button></h4>
        <div class="hint">把结果 POST 到你的服务。Authorization 等请求头请写 <code>{{secret:名字}}</code>，先在环境配置里用加密框保存真值，不要明文贴 Token。</div>
        ${hooks.map((w) => `<div class="d-card" data-wid="${esc(w.id)}"><div class="c-main"><div class="c-title">${esc(w.name)}</div><div class="c-sub">${esc(w.url)}${w.note ? ` · ${esc(w.note)}` : ""}${w.headers && Object.keys(w.headers).length ? ` · ${Object.keys(w.headers).length} 个头` : ""}</div></div>
          <button class="ghost-btn" data-op="edit">编辑</button><button class="ghost-btn danger-text" data-op="del">删除</button></div>`).join("") || `<div class="d-empty">还没有 Webhook。点 ＋ 添加端点。</div>`}
        ${editingHook ? `<div class="mx-form"><h4>${editingHook.id ? "编辑" : "添加"} Webhook</h4>
          <div class="mx-grid"><label>名称</label><input id="wh-name" value="${esc(editingHook.name ?? "")}" placeholder="例如 飞书机器人" />
          <label>URL</label><input id="wh-url" value="${esc(editingHook.url ?? "")}" placeholder="https://hooks.example/…" />
          <label>请求头</label><textarea id="wh-headers" rows="3" placeholder="每行一个，例如：&#10;Authorization: Bearer {{secret:HOOK_TOKEN}}">${esc(hdrText(editingHook.headers))}</textarea>
          <label>备注</label><input id="wh-note" value="${esc(editingHook.note ?? "")}" placeholder="可选" /></div>
          <div class="actions"><button class="ghost-btn" id="wh-cancel">取消</button><button class="primary-btn" id="wh-save">保存</button></div></div>` : ""}
      </div>`;
    } else if (tab === "gateway") {
      const on = !!gw.running;
      main = `<div class="d-sec">
        <h4>本机网关 <span class="tag">高级 / 备用</span></h4>
        <div class="hint"><b>公网例行 Webhook 不用改这里。</b>日常：到「云服务」用 Cloudflare 开通 → 例行卡片点 🪝 复制链接。<br/>
          本页只给局域网调试或跨机 <code>/bots/msg</code> 用。</div>
        <div class="d-card"><div class="c-main"><div class="c-title">${on ? "● 运行中" : "○ 未开启"}</div>
          <div class="c-sub">${on ? esc(`${gw.host}:${gw.port}`) : "局域网备用；不配也能用云 Webhook"}${gw.routinesBase ? ` · ${esc(gw.routinesBase)}/:token` : ""}</div></div></div>
        <details class="d-adv" ${on || gw.configured ? "open" : ""}>
          <summary class="d-adv-sum">端口与安全<span class="d-adv-hint">监听 · 远程 · HMAC</span><span class="d-adv-caret">›</span></summary>
          <div class="d-adv-body mx-form" style="padding-top:8px">
            <div class="mx-grid">
              <label></label><label class="chk"><input type="checkbox" id="gw-on" ${on || gw.configured ? "checked" : ""}/> 启用本机入站网关</label>
              <label>端口</label><input id="gw-port" type="number" min="1" max="65535" value="${esc(String(gw.port || 8787))}" />
              <label>监听地址</label><input id="gw-host" value="${esc(gw.host || "127.0.0.1")}" placeholder="127.0.0.1" />
              <label></label><label class="chk"><input type="checkbox" id="gw-remote" ${gw.allowRemote ? "checked" : ""}/> 允许远程访问</label>
              <label></label><label class="chk"><input type="checkbox" id="gw-hmac" ${gw.requireHmac ? "checked" : ""}/> 要求 HMAC 签名</label>
            </div>
            ${gw.warning ? `<div class="hint" style="color:var(--danger,#c44)">${esc(gw.warning)}</div>` : ""}
            ${gwMsg ? `<div class="hint">${esc(gwMsg)}</div>` : ""}
            <div class="actions">
              <button class="ghost-btn" id="gw-probe">检测连通</button>
              <button class="primary-btn" id="gw-save">保存并应用</button>
            </div>
          </div>
        </details>
        <h4 style="margin-top:16px">跨机 bot · POST /bots/msg</h4>
        <div class="hint">其它进程用 Bearer 把消息投到本机 bot。与例行 🪝 链接不是一回事。</div>
        <div class="d-card"><div class="c-main"><div class="c-title">${gw.hasMsgToken ? `令牌 ${esc(gw.msgTokenHint || "已生成")}` : "尚无令牌"}</div>
          <div class="c-sub">${gw.botsMsgUrl ? esc(gw.botsMsgUrl) : "启用网关后显示地址"}</div></div>
          <button class="ghost-btn" id="gw-copy-tok" ${gw.running && gw.hasMsgToken ? "" : "disabled"}>复制令牌</button>
          <button class="ghost-btn" id="gw-rot-tok" ${gw.configured ? "" : "disabled"}>换新</button>
        </div>
      </div>`;
    } else if (tab === "share") {
      const fmtWhen = (ts) => {
        if (!ts) return "未知时间";
        try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
      };
      const cf = bridge.cloudflare || {};
      const linkRows = (shareLinks.items || []).map((it) => `
        <div class="d-card" data-sid="${esc(it.id)}">
          <div class="c-main">
            <div class="c-title">${esc(it.name || "未命名 bot")}</div>
            <div class="c-sub">${esc(fmtWhen(it.createdAt))} · 约 ${esc(String(it.expiresInDays || shareLinks.ttlDays || 90))} 天内有效<br/><code style="word-break:break-all">${esc(it.url)}</code></div>
          </div>
          <button class="ghost-btn" data-op="copy">复制</button>
          <button class="ghost-btn danger-text" data-op="del">撤销</button>
        </div>`).join("")
        || `<div class="d-empty">${bridge.configured ? "还没有短链。去任意 bot →「分享」生成一条。" : "先开通云服务后再分享。"}</div>`;
      const statusCard = bridge.configured
        ? `<div class="d-card" style="border-color:var(--ok,#3a7)"><div class="c-main" style="flex:1">
            <div class="c-title">● 你的公网地址</div>
            <textarea class="sb-link" id="sb-base-out" readonly rows="2">${esc(bridge.base)}</textarea>
            <div class="c-sub">由你的 Cloudflare Token 生成。呼叫 bot 请用下面的 POST 链接（<code>/w/…</code>），不要只 POST 这个根地址。</div>
          </div>
          <button class="ghost-btn" id="sb-copy-base">复制地址</button>
          <button class="ghost-btn" id="sb-probe">检测连通</button>
        </div>`
        : `<div class="d-card" style="border-color:var(--acc)"><div class="c-main">
            <div class="c-title">○ 还没有公网地址</div>
            <div class="c-sub">粘贴 Cloudflare API Token，点「生成公网链接」。软件在你的账户里创建 Worker，并把 <code>https://harness-share-bridge.你的子域.workers.dev</code> 返回到这里。</div>
          </div></div>`;
      const hookRows = inboundHooks.map((h) => `
        <div class="d-card" data-hookurl="${esc(h.url)}">
          <div class="c-main">
            <div class="c-title">${esc(h.name)}${h.enabled ? "" : " · 已暂停"}</div>
            <div class="c-sub"><code style="word-break:break-all">${esc(h.url || "先生成上面的公网地址")}</code></div>
          </div>
          <button class="ghost-btn" data-op="copy-hook" ${h.url ? "" : "disabled"}>复制</button>
        </div>`).join("")
        || `<div class="d-empty">还没有呼叫链接。到 bot 详情 → 例行 →「＋ Webhook」，开通后地址会出现在这里。</div>`;
      const stepsHtml = (bridgeProvisionSteps || []).map((s) =>
        `<div class="hint">${s.ok ? "✓" : "✕"} ${esc(s.step)}${s.detail ? ` · ${esc(s.detail)}` : ""}</div>`).join("");
      let currentSub = "";
      try {
        const host = new URL(String(bridge.base || "")).hostname.split(".");
        if (host.length >= 4 && host.at(-2) === "workers" && host.at(-1) === "dev") currentSub = host[1] || "";
      } catch { /* 手动绑的地址不一定是 workers.dev */ }
      main = `<div class="d-sec">
        <h4>生成公网地址</h4>
        <div class="hint" style="line-height:1.65;margin-bottom:10px">
          <b>你提供</b> Cloudflare API Token，并指定子域。<b>软件返回</b> <code>https://harness-share-bridge.子域.workers.dev</code>。<br/>
          权限：Workers Scripts（Edit）、Workers KV Storage（Edit）、Account Settings（Read）。不要用 R2/S3 专用令牌。
          ${bridge.fromEnv ? "<br/><b>注意：</b>短链配置被环境变量覆盖。" : ""}
        </div>
        ${statusCard}
        <div class="mx-form" style="margin-top:12px">
          <div class="mx-grid">
            <label>API Token</label><input id="cf-token" type="password" value="" placeholder="${cf.hasToken ? `已保存（${esc(cf.tokenHint || "••••")}），留空=用已存` : "粘贴 Cloudflare API Token"}" autocomplete="off" />
            <label>子域</label><input id="cf-subdomain" value="${esc(currentSub)}" placeholder="例如 my-bot，留空沿用账号现有子域" autocomplete="off" spellcheck="false" />
          </div>
          <div class="hint">公网地址是 <code>https://harness-share-bridge.子域.workers.dev</code>。这个子域属于整个 Cloudflare 账号，改名后该账号上所有 workers.dev 地址一起变，旧链接失效。</div>
          <details class="d-adv" style="margin-top:8px">
            <summary class="d-adv-sum">可选 · 账户与天数<span class="d-adv-hint">一般留空</span><span class="d-adv-caret">›</span></summary>
            <div class="d-adv-body mx-form" style="padding-top:8px">
              <div class="mx-grid">
                <label>账户 ID</label><input id="cf-account" value="${esc(cf.accountId || "")}" placeholder="留空则用 Token 能看到的第一个账户" />
                <label>短链天数</label><input id="sb-ttl" type="number" min="1" max="365" value="${esc(String(bridge.ttlDays || shareLinks.ttlDays || 90))}" />
              </div>
            </div>
          </details>
          ${bridgeMsg ? `<div class="hint">${esc(bridgeMsg)}</div>` : ""}
          ${stepsHtml}
          <div class="actions">
            <button class="ghost-btn" id="sb-probe" ${bridge.configured ? "" : "disabled"}>检测连通</button>
            <button class="primary-btn" id="cf-provision">${bridge.configured ? "重新生成 / 同步" : "生成公网链接"}</button>
          </div>
        </div>
        <details class="d-adv" style="margin-top:12px">
          <summary class="d-adv-sum">高级 · 手动绑定已有桥<span class="d-adv-hint">运维已 deploy 时</span><span class="d-adv-caret">›</span></summary>
          <div class="d-adv-body mx-form" style="padding-top:8px">
            <div class="mx-grid">
              <label>服务地址</label><input id="sb-base-custom" value="${esc(bridge.base || "")}" placeholder="https://harness-share-bridge.xxx.workers.dev" />
              <label>PUT_KEY</label><input id="sb-key" type="password" value="" placeholder="${bridge.hasKey ? `已保存（${esc(bridge.keyHint || "••••")}），留空=不改` : "粘贴业务密钥"}" autocomplete="off" />
            </div>
            <div class="actions">
              <button class="ghost-btn danger-text" id="sb-clear" ${bridge.configured ? "" : "disabled"}>清除短链配置</button>
              <button class="ghost-btn danger-text" id="cf-clear" ${cf.hasToken ? "" : "disabled"}>清除 CF Token</button>
              <button class="primary-btn" id="sb-save">保存手动配置</button>
            </div>
          </div>
        </details>
        <h4 style="margin-top:16px">呼叫 bot</h4>
        <div class="hint">外部 POST JSON <code>{"message":"要做的事"}</code> 到下面的链接。电脑开着时几秒内进对话。</div>
        ${hookRows}
        <h4 style="margin-top:16px">我分享过的短链 <button class="ghost-btn" id="sb-refresh" ${bridge.configured ? "" : "disabled"}>刷新</button></h4>
        ${shareLinks.error ? `<div class="hint" style="color:var(--danger,#c44)">列表拉取失败：${esc(shareLinks.error)}<br/>
          可点「重新生成 / 同步」把最新 Worker 推上去；临时可用本机网关。</div>` : ""}
        ${shareLinks.truncated ? `<div class="hint">只显示最近一批。</div>` : ""}
        ${linkRows}
        <div class="hint">没开通也能分享：复制 <code>harnessbot://</code> 或 <code>.harnessbot</code> 文件。</div>
      </div>`;
    } else {
      const mcpRows = (catalog.mcp || []).map((m) => `<div class="d-card"><span class="ws-dot ${m.error ? "" : m.tools ? "on" : ""}"></span><div class="c-main"><div class="c-title">${esc(m.name)}</div><div class="c-sub">${m.error ? `✕ ${esc(m.error)}` : `${m.tools} 工具`} · ${esc(m.url ?? [m.command, ...(m.args || [])].filter(Boolean).join(" "))}</div></div></div>`).join("") || `<div class="d-empty">没有 MCP</div>`;
      const cliRows = (catalog.cli || []).map((c) => `<div class="d-card"><span class="ws-dot ${c.ready ? "on" : ""}"></span><div class="c-main"><div class="c-title">${esc(c.name)}</div><div class="c-sub">${esc(c.detail || (c.ready ? "可用" : "未就绪"))}</div></div></div>`).join("");
      main = `<div class="d-sec"><h4>MCP <button class="ghost-btn" id="v-mcp">管理 MCP</button></h4>${mcpRows}</div>
        <div class="d-sec"><h4>CLI 适配器状态</h4>${cliRows}</div>
        <div class="hint">添加连接走现有 mcp.add / 环境配置 / 密钥；不接 OAuth 应用市场。</div>`;
    }
    body.innerHTML = `<div class="actions" style="margin-bottom:12px">${tabs}</div>${main}`;
    body.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = async () => {
      tab = b.dataset.tab;
      editingContact = null;
      editingHook = null;
      if (tab === "share") { await loadShareLinks(); await loadInboundHooks(); }
      render();
    }));
    body.querySelectorAll(".connect-card").forEach((btn) => (btn.onclick = () => {
      const card = cards.find((c) => c.id === btn.dataset.cid);
      if (card) void installCard(card);
    }));
    body.querySelector("#v-env")?.addEventListener("click", () => { closeModal(); envFlow(); });
    body.querySelector("#v-env2")?.addEventListener("click", () => { closeModal(); envFlow(); });
    body.querySelector("#v-mcp")?.addEventListener("click", () => { closeModal(); mcpFlow(); });
    body.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => { tab = b.dataset.goto; render(); }));
    body.querySelector("#lg-new")?.addEventListener("click", () => { editingLogin = { website: "", username: "" }; render(); });
    body.querySelector("#lg-cancel")?.addEventListener("click", () => { editingLogin = null; render(); });
    body.querySelector("#lg-save")?.addEventListener("click", async () => {
      try {
        const pass = body.querySelector("#lg-pass").value;
        await api.logins.upsert({
          id: editingLogin.id,
          website: body.querySelector("#lg-web").value.trim(),
          username: body.querySelector("#lg-user").value.trim(),
          password: pass || undefined,
          hint: body.querySelector("#lg-hint").value.trim() || undefined,
          note: body.querySelector("#lg-note").value.trim() || undefined,
        });
        editingLogin = null;
        await refresh();
      } catch (e) { alert(errText(e)); }
    });
    body.querySelectorAll("[data-lid]").forEach((card) => {
      const id = card.dataset.lid;
      card.querySelector('[data-op="edit"]').onclick = () => { editingLogin = { ...loginList.find((l) => l.id === id) }; render(); };
      card.querySelector('[data-op="del"]').onclick = async () => { if (confirm("删除这个登录项？密码也会从保险库移除。")) { await api.logins.remove(id); await refresh(); } };
    });
    body.querySelector("#ct-new")?.addEventListener("click", () => { editingContact = { name: "" }; render(); });
    body.querySelector("#ct-cancel")?.addEventListener("click", () => { editingContact = null; render(); });
    body.querySelector("#ct-save")?.addEventListener("click", async () => {
      try {
        await api.contacts.upsert({
          id: editingContact.id,
          name: body.querySelector("#ct-name").value.trim(),
          email: body.querySelector("#ct-email").value.trim() || undefined,
          phone: body.querySelector("#ct-phone")?.value.trim() || undefined,
          address: body.querySelector("#ct-addr")?.value.trim() || undefined,
          hint: body.querySelector("#ct-hint")?.value.trim() || undefined,
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
        const rawHdr = body.querySelector("#wh-headers")?.value ?? "";
        const headers = {};
        for (const line of rawHdr.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          const i = t.indexOf(":");
          if (i < 1) continue;
          headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        }
        await api.connectors.upsertWebhook({
          id: editingHook.id,
          name: body.querySelector("#wh-name").value.trim(),
          url: body.querySelector("#wh-url").value.trim(),
          note: body.querySelector("#wh-note").value.trim() || undefined,
          headers: Object.keys(headers).length ? headers : undefined,
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
    body.querySelector("#gw-save")?.addEventListener("click", async () => {
      try {
        const enabled = !!body.querySelector("#gw-on")?.checked;
        const r = await api.connect.setGateway({
          enabled,
          port: Number(body.querySelector("#gw-port")?.value || 8787),
          host: body.querySelector("#gw-host")?.value.trim() || "127.0.0.1",
          allowRemote: !!body.querySelector("#gw-remote")?.checked,
          requireHmac: !!body.querySelector("#gw-hmac")?.checked,
        });
        gw = r.info || gw;
        gwMsg = r.ok
          ? (enabled ? (gw.running ? `已开启 · ${gw.host}:${gw.port}` : "已保存，但未成功监听（见警告）") : "已关闭入站网关")
          : `失败：${r.error || "未知错误"}`;
        render();
      } catch (e) { gwMsg = errText(e); render(); }
    });
    body.querySelector("#gw-probe")?.addEventListener("click", async () => {
      try {
        const r = await api.connect.probeGateway();
        gw = r.info || gw;
        gwMsg = r.ok ? `连通正常（HTTP ${r.status}）` : `不通：${r.error || "网关未运行"}`;
        render();
      } catch (e) { gwMsg = errText(e); render(); }
    });
    body.querySelector("#gw-copy-tok")?.addEventListener("click", async () => {
      try {
        const r = await api.connect.gatewayMsgToken();
        gw = r.info || gw;
        if (!r.ok || !r.token) { gwMsg = r.error || "无令牌"; render(); return; }
        await navigator.clipboard.writeText(r.token).catch(() => {});
        gwMsg = "已复制 /bots/msg Bearer 令牌（请当密码保管）";
        render();
      } catch (e) { gwMsg = errText(e); render(); }
    });
    body.querySelector("#gw-rot-tok")?.addEventListener("click", async () => {
      if (!confirm("换新跨机令牌？旧 Bearer 立刻失效。")) return;
      try {
        const r = await api.connect.rotateGatewayMsgToken();
        gw = r.info || gw;
        if (r.token) await navigator.clipboard.writeText(r.token).catch(() => {});
        gwMsg = r.ok ? "已换新并复制 Bearer 令牌" : (r.error || "换新失败");
        render();
      } catch (e) { gwMsg = errText(e); render(); }
    });
    body.querySelector("#sb-edit")?.addEventListener("click", () => {
      shareEdit = !shareEdit;
      render();
    });
    body.querySelector("#cf-provision")?.addEventListener("click", async () => {
      const btn = body.querySelector("#cf-provision");
      const apiToken = body.querySelector("#cf-token")?.value.trim() || undefined;
      const accountId = body.querySelector("#cf-account")?.value.trim() || undefined;
      const subdomain = body.querySelector("#cf-subdomain")?.value.trim() || undefined;
      const ttlDays = Number(body.querySelector("#sb-ttl")?.value || 90);
      if (!apiToken && !bridge.cloudflare?.hasToken) {
        bridgeMsg = "请先粘贴 Cloudflare API Token";
        render();
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "开通中…"; }
      bridgeMsg = "正在调用 Cloudflare API 开通短链桥…";
      bridgeProvisionSteps = [];
      render();
      // re-disable after re-render
      const btn2 = body.querySelector("#cf-provision");
      if (btn2) { btn2.disabled = true; btn2.textContent = "开通中…"; }
      try {
        if (!api.connect.provisionShareBridge) throw new Error("当前版本不支持一键开通，请更新应用");
        const r = await api.connect.provisionShareBridge({ apiToken, accountId, subdomain, ttlDays });
        bridgeProvisionSteps = r.steps || [];
        if (r.status) bridge = { ...r.status, cloudflare: bridge.cloudflare };
        bridge = await api.connect.shareBridge?.().catch(() => bridge) ?? bridge;
        if (r.ok) {
          const url = r.base || bridge.base || "";
          if (url) await navigator.clipboard.writeText(url).catch(() => {});
          bridgeMsg = r.hint
            ? `已生成 ${url}。${r.hint}`
            : `已生成并复制公网地址：${url}`;
          await loadShareLinks();
          await loadInboundHooks();
        } else {
          bridgeMsg = [r.error || "开通失败", r.hint].filter(Boolean).join("\n");
        }
        render();
      } catch (e) {
        bridgeMsg = errText(e);
        render();
      }
    });
    body.querySelector("#cf-clear")?.addEventListener("click", async () => {
      if (!confirm("清除本机保存的 Cloudflare API Token？")) return;
      try {
        await api.connect.clearCloudflare?.();
        bridge = await api.connect.shareBridge?.().catch(() => bridge) ?? bridge;
        bridgeMsg = "已清除 Cloudflare Token";
        render();
      } catch (e) { bridgeMsg = errText(e); render(); }
    });
    body.querySelector("#sb-save")?.addEventListener("click", async () => {
      try {
        const putKey = body.querySelector("#sb-key")?.value.trim();
        const base = (body.querySelector("#sb-base-custom")?.value.trim() || "").replace(/\/$/, "");
        if (!base) throw new Error("请填写已有桥的服务地址，或改用上方「确认开通」");
        if (!putKey && !bridge.hasKey) throw new Error("请粘贴 PUT_KEY");
        bridge = await api.connect.saveShareBridge({
          base,
          ttlDays: Number(body.querySelector("#sb-ttl")?.value || 90),
          ...(putKey ? { putKey } : {}),
        });
        bridge = await api.connect.shareBridge?.().catch(() => bridge) ?? bridge;
        shareEdit = true;
        bridgeMsg = "已保存手动配置。公网地址见上方。";
        await loadShareLinks();
        await loadInboundHooks();
        render();
      } catch (e) { bridgeMsg = errText(e); render(); }
    });
    body.querySelectorAll("#sb-probe").forEach((btn) => btn.addEventListener("click", async () => {
      try {
        const r = await api.connect.probeShareBridge();
        bridgeMsg = r.ok
          ? `连通正常 · /health OK`
          : `不通：${r.error || `HTTP ${r.status}`}。可点「重新生成 / 同步」。`;
        render();
      } catch (e) { bridgeMsg = errText(e); render(); }
    }));
    body.querySelector("#sb-clear")?.addEventListener("click", async () => {
      if (!confirm("清除本机短链凭证？之后分享将不再生成短链（已发出的短链仍在云端，直到过期或你重新配置后在列表里撤销）。")) return;
      try {
        bridge = await api.connect.clearShareBridge();
        bridge = await api.connect.shareBridge?.().catch(() => bridge) ?? bridge;
        shareEdit = true;
        bridgeMsg = "已清除。要再用，粘贴 Token 重新生成即可。";
        shareLinks = { items: [], truncated: false, ttlDays: 90, error: "" };
        inboundHooks = [];
        render();
      } catch (e) { bridgeMsg = errText(e); render(); }
    });
    body.querySelector("#sb-copy-base")?.addEventListener("click", async () => {
      const url = bridge.base || "";
      if (!url) return;
      await navigator.clipboard.writeText(url).catch(() => {});
      bridgeMsg = "已复制公网地址";
      render();
    });
    body.querySelectorAll("[data-hookurl]").forEach((card) => {
      card.querySelector('[data-op="copy-hook"]')?.addEventListener("click", async () => {
        const url = card.getAttribute("data-hookurl") || "";
        if (!url) return;
        await navigator.clipboard.writeText(url).catch(() => {});
        bridgeMsg = "已复制呼叫链接";
        render();
      });
    });
    body.querySelector("#sb-refresh")?.addEventListener("click", async () => {
      await loadShareLinks();
      await loadInboundHooks();
      bridgeMsg = shareLinks.error ? `刷新失败：${shareLinks.error}` : `已刷新 · ${shareLinks.items.length} 条`;
      render();
    });
    body.querySelectorAll("[data-sid]").forEach((card) => {
      const id = card.dataset.sid;
      const item = (shareLinks.items || []).find((x) => x.id === id);
      card.querySelector('[data-op="copy"]')?.addEventListener("click", async () => {
        if (!item?.url) return;
        await navigator.clipboard.writeText(item.url).catch(() => {});
        bridgeMsg = "已复制短链";
        render();
      });
      card.querySelector('[data-op="del"]')?.addEventListener("click", async () => {
        if (!confirm(`撤销短链「${item?.name || id}」？对方将立刻无法打开。`)) return;
        try {
          await api.connect.deleteShareLink(id);
          bridgeMsg = `已撤销 ${id}`;
          await loadShareLinks();
          render();
        } catch (e) {
          bridgeMsg = errText(e);
          render();
        }
      });
    });
  };
  if (tab === "share") {
    await loadShareLinks();
    await loadInboundHooks();
  }
  render();
}
$("#pet-smart-btn").onclick = petSmartFlow;
$("#about-btn").onclick = aboutFlow;
api.onOpenAbout?.(() => aboutFlow());
$("#realm-btn").onclick = () => { $("#more-menu").classList.add("hidden"); realmListFlow(); };
$("#send-btn").onclick = send;
