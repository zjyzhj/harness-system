import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  bots: {
    list: () => ipcRenderer.invoke("bots:list"),
    create: (text: string) => ipcRenderer.invoke("bots:create", text),
    remove: (id: string) => ipcRenderer.invoke("bots:delete", id),
    setPet: (id: string, enabled: boolean) => ipcRenderer.invoke("bots:setPet", id, enabled),
  },
  persona: {
    generate: (id: string, desc: string) => ipcRenderer.invoke("persona:generate", id, desc),
  },
  chat: {
    send: (botId: string, text: string, sessionId?: string) => ipcRenderer.invoke("chat:send", botId, text, sessionId),
    sendStream: (botId: string, content: string, sessionId?: string) => ipcRenderer.invoke("chat:sendStream", botId, content, sessionId),
    sendRich: (botId: string, content: unknown[], sessionId?: string) => ipcRenderer.invoke("chat:sendStream", botId, content, sessionId),
  },
  bus: {
    send: (fromId: string, toId: string, text: string) => ipcRenderer.invoke("bus:send", fromId, toId, text),
  },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    add: (input: any) => ipcRenderer.invoke("providers:add", input),
    test: (id: string) => ipcRenderer.invoke("providers:test", id),
    remove: (id: string) => ipcRenderer.invoke("providers:delete", id),
    capabilities: () => ipcRenderer.invoke("providers:capabilities"),
  },
  system: {
    notify: (title: string, body: string) => ipcRenderer.invoke("system:notify", title, body),
    copy: (text: string) => ipcRenderer.invoke("system:copy", text),
    readFile: (path: string) => ipcRenderer.invoke("system:readFile", path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke("system:writeFile", path, content),
  },
  migration: {
    export: (filePath: string, mask?: boolean) => ipcRenderer.invoke("migration:export", filePath, mask),
    import: (filePath: string) => ipcRenderer.invoke("migration:import", filePath),
  },
  pets: {
    list: () => ipcRenderer.invoke("pets:list"),
    save: (p: { botId: string; x: number; y: number; visible: boolean }) => ipcRenderer.invoke("pets:save", p),
  },
  sessions: {
    list: (botId?: string) => ipcRenderer.invoke("sessions:list", botId),
    page: (opts?: any) => ipcRenderer.invoke("sessions:page", opts),
    archive: (sessionId: string, archived: boolean) => ipcRenderer.invoke("sessions:archive", sessionId, archived),
    remove: (sessionId: string) => ipcRenderer.invoke("sessions:delete", sessionId),
  },
  messages: {
    list: (sessionId: string) => ipcRenderer.invoke("messages:list", sessionId),
    page: (sessionId: string, opts?: any) => ipcRenderer.invoke("messages:page", sessionId, opts),
    search: (opts?: any) => ipcRenderer.invoke("messages:search", opts),
  },
  memory: {
    list: (botId: string) => ipcRenderer.invoke("memory:list", botId),
    add: (botId: string, entry: any) => ipcRenderer.invoke("memory:add", botId, entry),
    remove: (botId: string, id: string) => ipcRenderer.invoke("memory:delete", botId, id),
    search: (botId: string, q: string) => ipcRenderer.invoke("memory:search", botId, q),
    stats: (botId: string) => ipcRenderer.invoke("memory:stats", botId),
  },
  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    create: (text: string) => ipcRenderer.invoke("skills:create", text),
    createRaw: (key: string, markdown: string) => ipcRenderer.invoke("skills:createRaw", key, markdown),
    setEnabled: (key: string, enabled: boolean) => ipcRenderer.invoke("skills:setEnabled", key, enabled),
    remove: (key: string) => ipcRenderer.invoke("skills:delete", key),
  },
  status: {
    list: () => ipcRenderer.invoke("status:list"),
  },
  tools: {
    run: (tool: string, args: any) => ipcRenderer.invoke("tools:run", tool, args),
  },
  mcp: {
    list: () => ipcRenderer.invoke("mcp:list"),
    call: (serverId: string, tool: string, args: any) => ipcRenderer.invoke("mcp:call", serverId, tool, args),
  },
  tasks: {
    list: (botId?: string) => ipcRenderer.invoke("tasks:list", botId),
    create: (input: any) => ipcRenderer.invoke("tasks:create", input),
    remove: (id: string) => ipcRenderer.invoke("tasks:delete", id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("tasks:setEnabled", id, enabled),
    runNow: (id: string) => ipcRenderer.invoke("tasks:runNow", id),
  },
};

type StreamBlock = { type: string; text?: string; tool?: string; callId?: string; args?: any; result?: string; status?: string };

const onPetEvent = (cb: (event: { type: string; text?: string; title?: string }) => void) => {
  const listener = (_e: IpcRendererEvent, ev: { type: string; text?: string; title?: string }) => cb(ev);
  ipcRenderer.on("pet:event", listener);
  return () => ipcRenderer.removeListener("pet:event", listener);
};

/** 流式会话：注册增量块回调（text/tool_call），返回取消函数 */
const onChatStream = (cb: (chunk: StreamBlock) => void) => {
  const listener = (_e: IpcRendererEvent, ev: StreamBlock) => cb(ev);
  ipcRenderer.on("chat:stream", listener);
  return () => ipcRenderer.removeListener("chat:stream", listener);
};

contextBridge.exposeInMainWorld("harness", { ...api, onPetEvent, onChatStream });
export type { StreamBlock };
export type HarnessApi = typeof api;
