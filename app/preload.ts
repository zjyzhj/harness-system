import { contextBridge, ipcRenderer } from "electron";

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
  },
  messages: {
    list: (sessionId: string) => ipcRenderer.invoke("messages:list", sessionId),
  },
};

contextBridge.exposeInMainWorld("harness", api);
export type HarnessApi = typeof api;
