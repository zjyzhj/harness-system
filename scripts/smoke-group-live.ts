/**
 * 真实冒烟：连上正在跑的 Electron（--remote-debugging-port=9333），
 * 经 window.harness 调群聊 IPC，核对按需发言。
 */
const PORT = Number(process.env.CDP_PORT || 9333);
const WS = process.env.CDP_WS || "";

type CdpMsg = { id?: number; method?: string; params?: any; result?: any; error?: any };

async function findMainWs(): Promise<string> {
  if (WS) return WS;
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()) as any[];
  const page = list.find((t) => t.type === "page" && String(t.url || "").includes("index.html"));
  if (!page?.webSocketDebuggerUrl) throw new Error("找不到主面板 CDP target，请用 --remote-debugging-port=9333 启动");
  return page.webSocketDebuggerUrl as string;
}

class Cdp {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  async connect(url: string) {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(String(e)));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMsg;
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    };
  }
  call(method: string, params?: Record<string, unknown>) {
    const id = this.next++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
    return r.result?.value as T;
  }
  close() { try { this.ws.close(); } catch {} }
}

function speakers(msgs: { from: string; role?: string; kind?: string }[], bots: Record<string, string>) {
  return msgs
    .filter((m) => m.kind !== "event" && m.role === "assistant")
    .map((m) => bots[m.from] || m.from);
}

async function main() {
  const url = await findMainWs();
  const cdp = new Cdp();
  await cdp.connect(url);
  await cdp.call("Runtime.enable");

  const ready = await cdp.eval<boolean>(`typeof window.harness !== 'undefined'`);
  if (!ready) throw new Error("window.harness 未注入");

  const meta = await cdp.eval<{
    groupId: string; groupName: string; members: { id: string; name: string; providerId?: string }[];
    restored?: boolean;
  }>(`(async () => {
    const api = window.harness;
    const groups = await api.groups.list();
    const g = groups.find(x => x.name === '测试') || groups[0];
    if (!g) throw new Error('没有群聊');
    const bots = await api.bots.list();
    const providers = await api.providers.list();
    const apiProv = providers.find(p => p.id === 'deepseek-api') || providers.find(p => p.kind === 'openai-compat' && p.apiKey);
    if (!apiProv) throw new Error('没有可用的 API provider（deepseek-api）');
    const members = [];
    for (const id of g.members) {
      const b = bots.find(x => x.id === id);
      members.push({ id, name: b?.name || id, providerId: b?.providerId || '' });
      // 冒烟期间切到 API，避免卡在本地 Cursor CLI 授权
      await api.bots.update(id, { providerId: apiProv.id });
    }
    const master = bots.find(b => b.isMaster) || bots.find(b => b.name === '灵感助手');
    if (master && g.members.includes(master.id)) {
      await api.groups.update(g.id, { settings: { ...(g.settings||{}), moderator: master.id, relay: true, maxTurns: 6 } });
    }
    return { groupId: g.id, groupName: g.name, members, apiProv: apiProv.id };
  })()`);

  console.log(`群「${meta.groupName}」成员: ${meta.members.map((m) => m.name).join("、")}`);
  console.log(`冒烟期间临时使用 API provider（结束后还原）`);
  const botMap = Object.fromEntries(meta.members.map((m) => [m.id, m.name]));
  const masterName = meta.members.find((m) => m.name === "灵感助手")?.name
    || meta.members.find((m) => m.name.includes("灵感助手") && !m.name.includes("2"))?.name
    || meta.members[0]?.name;

  const results: { name: string; ok: boolean; detail: string }[] = [];
  const restoreProviders = async () => {
    await cdp.eval(`(async () => {
      const api = window.harness;
      const members = ${JSON.stringify(meta.members)};
      for (const m of members) await api.bots.update(m.id, { providerId: m.providerId || '' });
      return true;
    })()`);
  };

  // Case A: 没 @ → 只有主持人先说（可能再交接，但首个必须是主持人；且不应开场齐声）
  {
    const sid = `group-${meta.groupId}-smoke-a-${Date.now()}`;
    console.log("… Case A 没@");
    const r = await cdp.eval<any>(`(async () => {
      const api = window.harness;
      await api.groups.gaze(${JSON.stringify(meta.groupId)}, ${JSON.stringify(sid)});
      const out = await api.groups.chat(${JSON.stringify(meta.groupId)}, ${JSON.stringify("先定本周方向。只说一两句。末尾写【交给】无。")}, ${JSON.stringify(sid)});
      const msgs = await api.messages.list(${JSON.stringify(sid)});
      return { out, msgs };
    })()`);
    const names = speakers(r.msgs || [], botMap);
    const first = names[0];
    const okFirst = first === masterName;
    const ok = okFirst && (r.out?.ok !== false);
    results.push({
      name: "没@ → 主持人先说",
      ok,
      detail: `first=${first} turns=${r.out?.turns} reason=${r.out?.reason} speakers=${names.join("→")}`,
    });
  }

  // Case B: @写作助手
  {
    const writer = meta.members.find((m) => m.name === "写作助手");
    if (!writer) {
      results.push({ name: "@写作助手", ok: false, detail: "群里没有写作助手" });
    } else {
      const sid = `group-${meta.groupId}-smoke-b-${Date.now()}`;
      console.log("… Case B @写作助手");
      const r = await cdp.eval<any>(`(async () => {
        const api = window.harness;
        await api.groups.gaze(${JSON.stringify(meta.groupId)}, ${JSON.stringify(sid)});
        const out = await api.groups.chat(${JSON.stringify(meta.groupId)}, ${JSON.stringify("@写作助手 用一句话说明你能帮什么。末尾写【交给】无。")}, ${JSON.stringify(sid)});
        const msgs = await api.messages.list(${JSON.stringify(sid)});
        return { out, msgs };
      })()`);
      const names = speakers(r.msgs || [], botMap);
      const ok = names[0] === "写作助手";
      results.push({
        name: "@写作助手 → 她先说",
        ok,
        detail: `first=${names[0]} speakers=${names.join("→")} turns=${r.out?.turns}`,
      });
    }
  }

  // Case C: @所有人 — 应多人开口；每人一句，靠显式点名
  {
    const sid = `group-${meta.groupId}-smoke-c-${Date.now()}`;
    console.log("… Case C @所有人");
    const r = await cdp.eval<any>(`(async () => {
      const api = window.harness;
      await api.groups.gaze(${JSON.stringify(meta.groupId)}, ${JSON.stringify(sid)});
      const out = await api.groups.chat(${JSON.stringify(meta.groupId)}, ${JSON.stringify("@所有人 各用一句话介绍你能做什么。禁止调用任何工具。末尾写【交给】无。")}, ${JSON.stringify(sid)});
      const msgs = await api.messages.list(${JSON.stringify(sid)});
      return { out, msgs };
    })()`);
    const names = speakers(r.msgs || [], botMap);
    const unique = [...new Set(names)];
    // 至少 3 个不同成员开口；且不应只剩主持人连发
    const ok = unique.length >= Math.min(3, meta.members.length) && !(unique.length === 1 && unique[0] === masterName);
    results.push({
      name: "@所有人 → 多人开口",
      ok,
      detail: `unique=${unique.length}/${meta.members.length} speakers=${names.join("→")} turns=${r.out?.turns}`,
    });
  }

  // Case D: bot 身份发消息没 @ → 不齐声（post / broadcast）
  {
    const master = meta.members.find((m) => m.name === masterName) || meta.members[0];
    const sid = `group-${meta.groupId}`;
    console.log("… Case D bot 没@发言");
    const before = await cdp.eval<number>(`(async () => (await window.harness.messages.list(${JSON.stringify(sid)})).length)()`);
    const r = await cdp.eval<any>(`(async () => {
      const api = window.harness;
      return api.groups.broadcast(${JSON.stringify(meta.groupId)}, ${JSON.stringify(master.id)}, ${JSON.stringify("大家好，我刚进群打个招呼。请简短回应，末尾【交给】无。")});
    })()`);
    const afterMsgs = await cdp.eval<any[]>(`(async () => {
      const msgs = await window.harness.messages.list(${JSON.stringify(sid)});
      return msgs.slice(${before});
    })()`);
    const names = speakers(afterMsgs || [], botMap).filter((n) => n !== masterName);
    const notAll = names.length < Math.max(1, meta.members.length - 1);
    results.push({
      name: "bot 发消息没@ → 不齐声",
      ok: notAll && names.length <= 2,
      detail: `responders=${names.join(",") || "（无）"} out=${JSON.stringify(r)?.slice(0, 160)}`,
    });
  }

  console.log("\n=== 群聊真实冒烟结果 ===");
  let failed = 0;
  for (const x of results) {
    console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}  ·  ${x.detail}`);
    if (!x.ok) failed++;
  }
  try { await restoreProviders(); console.log("已还原各 bot 的 provider"); } catch (e) {
    console.error("还原 provider 失败:", e instanceof Error ? e.message : e);
  }
  cdp.close();
  if (failed) {
    console.error(`\n${failed}/${results.length} 失败`);
    process.exit(1);
  }
  console.log(`\n全部通过 ${results.length}/${results.length}`);
}

main().catch(async (e) => {
  console.error("SMOKE ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
