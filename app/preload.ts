import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api = {
  skins: {
    list: () => ipcRenderer.invoke("skins:list"),
    setMeta: (id: string, meta: { cellW: number; cellH: number }) => ipcRenderer.invoke("skins:setMeta", id, meta),
    recommended: () => ipcRenderer.invoke("skins:recommended"),
    catalog: (query: string) => ipcRenderer.invoke("skins:catalog", query),
    installPetdex: (slug: string, name?: string) => ipcRenderer.invoke("skins:installPetdex", slug, name),
  },
  bots: {
    list: () => ipcRenderer.invoke("bots:list"),
    previews: () => ipcRenderer.invoke("bots:previews"),
    draft: (text: string) => ipcRenderer.invoke("bots:draft", text) as Promise<{ name: string; role: string; persona: string; systemPrompt?: string; model?: string }>,
    create: (text: string, opts?: { name?: string; role?: string; persona?: string; systemPrompt?: string; avatar?: { shape: string; color: string } }) => ipcRenderer.invoke("bots:create", text, opts),
    remove: (id: string) => ipcRenderer.invoke("bots:delete", id),
    update: (id: string, patch: {
      name?: string; role?: string; persona?: string; providerId?: string; isMaster?: boolean; order?: number;
      pinned?: boolean; hidden?: boolean; section?: string | null; disabledSkills?: string[] | null;
      avatar?: { shape: string; color: string }; reasoning?: string; agentCwd?: string | null; dropAgentCwd?: string | null;
      agentCli?: string | null; agentResume?: "auto" | "always" | "once" | null;
    }) => ipcRenderer.invoke("bots:update", id, patch),
    setPet: (id: string, enabled: boolean) => ipcRenderer.invoke("bots:setPet", id, enabled),
    setSkin: (id: string, skinId: string) => ipcRenderer.invoke("bots:setSkin", id, skinId),
    duplicate: (id: string) => ipcRenderer.invoke("bots:duplicate", id),
    share: (id: string) => ipcRenderer.invoke("bots:share", id),
    parseTemplate: (input: string) => ipcRenderer.invoke("bots:parseTemplate", input),
    diffNeeds: (needs: unknown) => ipcRenderer.invoke("bots:diffNeeds", needs),
    pickTemplate: () => ipcRenderer.invoke("bots:pickTemplate"),
    importTemplate: (tpl: unknown) => ipcRenderer.invoke("bots:importTemplate", tpl),
  },
  persona: {
    generate: (id: string, desc: string, style?: string) => ipcRenderer.invoke("persona:generate", id, desc, style),
  },
  pet: {
    direct: (botId: string, text: string) => ipcRenderer.invoke("pet:direct", botId, text) as Promise<{ handled: boolean; message?: string; chat?: boolean; intent?: string }>,
    prefs: () => ipcRenderer.invoke("pet:prefs") as Promise<{
      companionChat: boolean; proactiveFollowup: boolean; idleWork: boolean; autoAppearance: boolean;
      agentMaySpawn: boolean; selfEvolve: boolean; autoEvolve: boolean; petVisit: boolean;
      idleMinutes: number; maxChatPerDay: number; maxWorkPerDay: number; maxAppearPerWeek: number;
    }>,
    activity: (botId?: string, limit?: number) => ipcRenderer.invoke("pet:activity", botId, limit) as Promise<Array<{
      at: number; botId: string; kind: string; via: string; note: string; blocked?: boolean;
    }>>,
    mind: (botId: string) => ipcRenderer.invoke("pet:mind", botId),
    trial: (kind?: string) => ipcRenderer.invoke("pet:trial", kind) as Promise<{ ok: boolean; kind?: string; message: string }>,
    evolveHistory: (botId?: string) => ipcRenderer.invoke("pet:evolveHistory", botId) as Promise<Array<{
      id: string; botId: string; kind: string; title: string; detail: string; status: string; createdAt: number;
    }>>,
  },
  chat: {
    send: (botId: string, text: string, sessionId?: string) => ipcRenderer.invoke("chat:send", botId, text, sessionId),
    sendStream: (botId: string, content: unknown, sessionId?: string, opts?: { think?: boolean; projectId?: string | null }) => ipcRenderer.invoke("chat:sendStream", botId, content, sessionId, opts),
    sendRich: (botId: string, content: unknown[], sessionId?: string) => ipcRenderer.invoke("chat:sendStream", botId, content, sessionId),
    cancel: (sessionId: string) => ipcRenderer.invoke("chat:cancel", sessionId),
  },
  bus: {
    send: (fromId: string, toId: string, text: string) => ipcRenderer.invoke("bus:send", fromId, toId, text),
  },
  groups: {
    list: (botId?: string) => ipcRenderer.invoke("groups:list", botId),
    create: (name: string, members: string[], opts?: { settings?: { goal?: string; relay?: boolean; maxTurns?: number; moderator?: string }; starterId?: string }) =>
      ipcRenderer.invoke("groups:create", name, members, opts),
    join: (groupId: string, botId: string) => ipcRenderer.invoke("groups:join", groupId, botId),
    leave: (groupId: string, botId: string) => ipcRenderer.invoke("groups:leave", groupId, botId),
    remove: (groupId: string) => ipcRenderer.invoke("groups:remove", groupId),
    broadcast: (groupId: string, fromId: string, text: string) => ipcRenderer.invoke("groups:broadcast", groupId, fromId, text),
    chat: (groupId: string, content: unknown, sessionId?: string) => ipcRenderer.invoke("groups:chat", groupId, content, sessionId),
    gaze: (groupId: string, sessionId: string | null) => ipcRenderer.invoke("groups:gaze", groupId, sessionId),
    peek: (sessionId: string) => ipcRenderer.invoke("groups:peek", sessionId),
    board: (sessionId: string) => ipcRenderer.invoke("groups:board", sessionId),
    interject: (groupId: string, sessionId: string, content: unknown) => ipcRenderer.invoke("groups:interject", groupId, sessionId, content),
    update: (groupId: string, patch: unknown) => ipcRenderer.invoke("groups:update", groupId, patch),
    taskDone: (sessionId: string, msgId: number, index: number, done: boolean) => ipcRenderer.invoke("groups:taskDone", sessionId, msgId, index, done),
    dispatch: (groupId: string, sessionId: string, msgId: number, indexes: number[]) => ipcRenderer.invoke("groups:dispatch", groupId, sessionId, msgId, indexes),
  },
  consent: {
    list: (botId?: string) => ipcRenderer.invoke("consent:list", botId),
    grant: (botId: string, cap: string, opts?: any) => ipcRenderer.invoke("consent:grant", botId, cap, opts),
    revoke: (botId: string, cap?: string) => ipcRenderer.invoke("consent:revoke", botId, cap),
    caps: () => ipcRenderer.invoke("consent:caps"),
    respond: (id: string, decision: string) => ipcRenderer.invoke("consent:respond", id, decision),
    rules: () => ipcRenderer.invoke("consent:rules"),
    setRule: (botId: string, command: string, decision: string) => ipcRenderer.invoke("consent:setRule", botId, command, decision),
    removeRule: (botId: string, command: string) => ipcRenderer.invoke("consent:removeRule", botId, command),
    setTrusted: (botId: string, on: boolean) => ipcRenderer.invoke("consent:setTrusted", botId, on),
    setMode: (botId: string, mode: "ask" | "auto" | "always") => ipcRenderer.invoke("consent:setMode", botId, mode),
    mode: (botId: string) => ipcRenderer.invoke("consent:mode", botId) as Promise<"ask" | "auto" | "always">,
    cliPaths: (botId?: string) => ipcRenderer.invoke("consent:cliPaths", botId),
    revokeCliPath: (botId: string, cwd?: string) => ipcRenderer.invoke("consent:revokeCliPath", botId, cwd),
    termPaths: (botId?: string) => ipcRenderer.invoke("consent:termPaths", botId),
    revokeTermPath: (botId: string, cwd?: string) => ipcRenderer.invoke("consent:revokeTermPath", botId, cwd),
    overview: (botId: string) => ipcRenderer.invoke("consent:overview", botId),
  },
  coding: {
    presence: (botId: string) => ipcRenderer.invoke("coding:presence", botId),
    list: (botId: string) => ipcRenderer.invoke("coding:list", botId),
    focus: (botId: string, cwd: string) => ipcRenderer.invoke("coding:focus", botId, cwd),
    open: (botId: string, cwd: string) => ipcRenderer.invoke("coding:open", botId, cwd),
    replay: (botId: string, cwd?: string) => ipcRenderer.invoke("coding:replay", botId, cwd),
    resize: (botId: string, cols: number, rows: number, cwd?: string) => ipcRenderer.invoke("coding:resize", botId, cols, rows, cwd),
    stop: (botId: string, cwd?: string) => ipcRenderer.invoke("coding:stop", botId, cwd),
    write: (botId: string, data: string, cwd?: string) => ipcRenderer.invoke("coding:write", botId, data, cwd),
    pickDir: () => ipcRenderer.invoke("coding:pickDir"),
  },
  browser: {
    state: (botId: string) => ipcRenderer.invoke("browser:state", botId),
    list: () => ipcRenderer.invoke("browser:list"),
    open: (botId: string, url?: string) => ipcRenderer.invoke("browser:open", botId, url),
    goto: (botId: string, url: string) => ipcRenderer.invoke("browser:goto", botId, url),
    stop: (botId: string) => ipcRenderer.invoke("browser:stop", botId),
    focus: (botId: string) => ipcRenderer.invoke("browser:focus", botId),
    show: (botId: string, on: boolean) => ipcRenderer.invoke("browser:show", botId, on),
    bounds: (botId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("browser:bounds", botId, bounds),
    back: (botId: string) => ipcRenderer.invoke("browser:back", botId),
    reload: (botId: string) => ipcRenderer.invoke("browser:reload", botId),
  },
  audit: {
    list: (opts?: any) => ipcRenderer.invoke("audit:list", opts),
    export: (filePath: string) => ipcRenderer.invoke("audit:export", filePath),
  },
  system: {
    notify: (title: string, body: string) => ipcRenderer.invoke("system:notify", title, body),
    copy: (text: string) => ipcRenderer.invoke("system:copy", text),
    openPath: (path: string) => ipcRenderer.invoke("system:openPath", path),
    reveal: (path: string) => ipcRenderer.invoke("system:reveal", path),
    preview: (path: string) => ipcRenderer.invoke("files:preview", path),
    library: (botId: string | null, groupId?: string) => ipcRenderer.invoke("library:list", botId, groupId),
    workspace: (botId: string) => ipcRenderer.invoke("workspace:info", botId),
    readFile: (path: string) => ipcRenderer.invoke("system:readFile", path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke("system:writeFile", path, content),
    tcc: () => ipcRenderer.invoke("system:tcc"),
    openPrefs: (pane: string) => ipcRenderer.invoke("system:openPrefs", pane),
    revealElectronApp: () => ipcRenderer.invoke("system:revealElectronApp"),
    notifyState: () => ipcRenderer.invoke("system:notifyState"),
    notifyRecheck: () => ipcRenderer.invoke("system:notifyRecheck"),
    notifyMute: () => ipcRenderer.invoke("system:notifyMute"),
    pickFile: (opts: { save?: boolean; defaultPath?: string; title?: string }) => ipcRenderer.invoke("system:pickFile", opts),
    appInfo: () => ipcRenderer.invoke("system:appInfo") as Promise<{ version: string; channel: string; schema: number; update: { available: boolean; message: string } }>,
    checkUpdate: () => ipcRenderer.invoke("system:checkUpdate") as Promise<{ available: boolean; message: string }>,
  },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    add: (input: any) => ipcRenderer.invoke("providers:add", input),
    test: (id: string) => ipcRenderer.invoke("providers:test", id),
    testConfig: (input: any) => ipcRenderer.invoke("providers:testConfig", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("providers:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("providers:delete", id),
    setDefault: (id: string) => ipcRenderer.invoke("providers:setDefault", id),
    capabilities: (force?: boolean) => ipcRenderer.invoke("providers:capabilities", !!force),
  },
  window: {
    openSession: (sessionId?: string) => ipcRenderer.invoke("window:openSession", sessionId),
  },
  migration: {
    export: (filePath: string, mask?: boolean) => ipcRenderer.invoke("migration:export", filePath, mask),
    import: (filePath: string) => ipcRenderer.invoke("migration:import", filePath),
  },
  pets: {
    list: () => ipcRenderer.invoke("pets:list"),
    save: (p: { botId: string; x: number; y: number; visible: boolean }) => ipcRenderer.invoke("pets:save", p),
    addXp: (botId: string, n: number) => ipcRenderer.invoke("pets:addXp", botId, n),
    getLastSession: (botId: string) => ipcRenderer.invoke("pets:getLastSession", botId),
    hide: (botId?: string) => ipcRenderer.invoke("pets:hide", botId),
    show: (botId?: string) => ipcRenderer.invoke("pets:show", botId),
    visit: (fromId: string, toId: string) => ipcRenderer.invoke("pets:visit", fromId, toId),
    visitHistory: (botId?: string) => ipcRenderer.invoke("pets:visitHistory", botId),
    peers: (botId: string) => ipcRenderer.invoke("pets:peers", botId) as Promise<Array<{ id: string; name: string }>>,
    setIgnoreMouse: (ignore: boolean) => ipcRenderer.send("pet:setIgnoreMouse", ignore),
    drag: (phase: "start" | "end") => ipcRenderer.send("pet:drag", phase),
  },
  sessions: {
    list: (botId?: string) => ipcRenderer.invoke("sessions:list", botId),
    page: (opts?: any) => ipcRenderer.invoke("sessions:page", opts),
    archive: (sessionId: string, archived: boolean) => ipcRenderer.invoke("sessions:archive", sessionId, archived),
    remove: (sessionId: string) => ipcRenderer.invoke("sessions:delete", sessionId),
    get: (sessionId: string) => ipcRenderer.invoke("sessions:get", sessionId),
    rename: (sessionId: string, title: string) => ipcRenderer.invoke("sessions:rename", sessionId, title),
    export: (sessionId: string) => ipcRenderer.invoke("sessions:export", sessionId),
  },
  messages: {
    list: (sessionId: string) => ipcRenderer.invoke("messages:list", sessionId),
    page: (sessionId: string, opts?: any) => ipcRenderer.invoke("messages:page", sessionId, opts),
    search: (opts?: any) => ipcRenderer.invoke("messages:search", opts),
    remove: (sessionId: string, ids: number[]) => ipcRenderer.invoke("messages:delete", sessionId, ids),
    answer: (sessionId: string, id: number, choiceId: string, answer: string) => ipcRenderer.invoke("messages:answer", sessionId, id, choiceId, answer),
    formAnswer: (sessionId: string, id: number, formId: string, answer: Record<string, string>) =>
      ipcRenderer.invoke("messages:formAnswer", sessionId, id, formId, answer),
  },
  secrets: {
    save: (sessionId: string, id: number, name: string, value: string, label?: string) => ipcRenderer.invoke("secrets:save", sessionId, id, name, value, label),
    list: () => ipcRenderer.invoke("secrets:list"),
    remove: (name: string) => ipcRenderer.invoke("secrets:remove", name),
    scope: (name: string, botId: string | null) => ipcRenderer.invoke("secrets:scope", name, botId),
  },
  env: {
    list: () => ipcRenderer.invoke("env:list"),
    set: (input: { key: string; value: string; label?: string; note?: string; botId?: string }) => ipcRenderer.invoke("env:set", input),
    remove: (key: string, botId?: string) => ipcRenderer.invoke("env:remove", key, botId),
  },
  vault: {
    list: (query?: string) => ipcRenderer.invoke("vault:list", query),
    catalog: () => ipcRenderer.invoke("vault:catalog"),
  },
  contacts: {
    list: () => ipcRenderer.invoke("contacts:list"),
    upsert: (input: { id?: string; name: string; email?: string; note?: string }) => ipcRenderer.invoke("contacts:upsert", input),
    remove: (id: string) => ipcRenderer.invoke("contacts:remove", id),
  },
  connectors: {
    listWebhooks: () => ipcRenderer.invoke("connectors:listWebhooks"),
    upsertWebhook: (input: { id?: string; name: string; url: string; note?: string; headers?: Record<string, string> }) =>
      ipcRenderer.invoke("connectors:upsertWebhook", input),
    removeWebhook: (id: string) => ipcRenderer.invoke("connectors:removeWebhook", id),
  },
  voice: {
    config: (cfg?: { baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke("voice:config", cfg),
    micAccess: () => ipcRenderer.invoke("voice:micAccess"),
    transcribe: (audio: ArrayBuffer, mime: string) => ipcRenderer.invoke("voice:transcribe", audio, mime),
  },
  realm: {
    consentText: () => ipcRenderer.invoke("realm:consentText") as Promise<string>,
    list: (includeArchived?: boolean) => ipcRenderer.invoke("realm:list", includeArchived),
    get: (id: string) => ipcRenderer.invoke("realm:get", id),
    create: (input: {
      name: string; relation?: string; bio?: string; styleNotes?: string; corpus?: string;
      providerId: string; consentRole: "self" | "with-consent" | "kin"; consentAffirmed: boolean;
    }) => ipcRenderer.invoke("realm:create", input),
    update: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke("realm:update", id, patch),
    archive: (id: string) => ipcRenderer.invoke("realm:archive", id),
    remove: (id: string) => ipcRenderer.invoke("realm:remove", id),
    ttsConfig: (cfg?: {
      baseUrl: string; apiKey: string; model: string;
      cloneMode?: "none" | "upload" | "inline"; uploadPath?: string; defaultVoice?: string;
    }) => ipcRenderer.invoke("realm:ttsConfig", cfg),
    setPresetVoice: (presenceId: string, voiceName: string) => ipcRenderer.invoke("realm:setPresetVoice", presenceId, voiceName),
    cloneVoice: (presenceId: string, refText: string) => ipcRenderer.invoke("realm:cloneVoice", presenceId, refText),
    cloneVoiceBuf: (presenceId: string, audio: ArrayBuffer, mime: string, refText: string) =>
      ipcRenderer.invoke("realm:cloneVoiceBuf", presenceId, audio, mime, refText),
    previewVoice: (presenceId: string, text?: string) => ipcRenderer.invoke("realm:previewVoice", presenceId, text) as Promise<string>,
    chat: (presenceId: string, text: string, sessionId?: string) => ipcRenderer.invoke("realm:chat", presenceId, text, sessionId),
    messages: (sessionId: string) => ipcRenderer.invoke("realm:messages", sessionId),
    sessions: (presenceId: string) => ipcRenderer.invoke("realm:sessions", presenceId),
  },
  memory: {
    list: (botId: string) => ipcRenderer.invoke("memory:list", botId),
    add: (botId: string, entry: any) => ipcRenderer.invoke("memory:add", botId, entry),
    remove: (botId: string, id: string) => ipcRenderer.invoke("memory:delete", botId, id),
    import: (botId: string, payload: string | Array<{ kind?: string; content: string }>, opts?: { namespace?: string }) =>
      ipcRenderer.invoke("memory:import", botId, payload, opts),
    search: (botId: string, q: string) => ipcRenderer.invoke("memory:search", botId, q),
    stats: (botId: string) => ipcRenderer.invoke("memory:stats", botId),
    retrieve: (botId: string, q: string) => ipcRenderer.invoke("memory:retrieve", botId, q),
    namespaces: () => ipcRenderer.invoke("memory:namespaces"),
    memo: (ns: string) => ipcRenderer.invoke("memory:memo", ns),
    setMemo: (ns: string, text: string) => ipcRenderer.invoke("memory:setMemo", ns, text),
    rewriteMemo: (ns: string) => ipcRenderer.invoke("memory:rewriteMemo", ns),
    merge: (ns: string) => ipcRenderer.invoke("memory:merge", ns),
    evict: (ns: string, budget: number) => ipcRenderer.invoke("memory:evict", ns, budget),
  },
  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    create: (text: string) => ipcRenderer.invoke("skills:create", text),
    createRaw: (key: string, markdown: string) => ipcRenderer.invoke("skills:createRaw", key, markdown),
    setEnabled: (key: string, enabled: boolean) => ipcRenderer.invoke("skills:setEnabled", key, enabled),
    remove: (key: string) => ipcRenderer.invoke("skills:delete", key),
    forBot: (botId: string) => ipcRenderer.invoke("skills:forBot", botId),
    save: (input: any) => ipcRenderer.invoke("skills:save", input),
    templates: () => ipcRenderer.invoke("skills:templates"),
    installTemplate: (key: string, botId?: string) => ipcRenderer.invoke("skills:installTemplate", key, botId),
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
    servers: () => ipcRenderer.invoke("mcp:servers"),
    serversAll: () => ipcRenderer.invoke("mcp:serversAll"),
    saveServers: (servers: unknown[]) => ipcRenderer.invoke("mcp:saveServers", servers),
  },
  systemObserve: {
    status: () => ipcRenderer.invoke("systemObserve:status"),
  },
  systemWatch: {
    get: (botId) => ipcRenderer.invoke("systemWatch:get", botId),
    set: (botId, patch) => ipcRenderer.invoke("systemWatch:set", botId, patch),
    status: (botId) => ipcRenderer.invoke("systemWatch:status", botId),
    installedApps: () => ipcRenderer.invoke("systemWatch:installedApps"),
  },
  computerUse: {
    status: () => ipcRenderer.invoke("computerUse:status"),
    setEnabled: (on: boolean) => ipcRenderer.invoke("computerUse:setEnabled", on),
    doctor: () => ipcRenderer.invoke("computerUse:doctor"),
    onProgress: (cb: (msg: string) => void) => {
      const listener = (_: IpcRendererEvent, msg: string) => cb(msg);
      ipcRenderer.on("computerUse:progress", listener);
      return () => ipcRenderer.removeListener("computerUse:progress", listener);
    },
  },
  files: {
    ingest: (paths: string[]) => ipcRenderer.invoke("files:ingest", paths),
    pick: () => ipcRenderer.invoke("files:pickAttachments"),
    /** 拖进来 / 粘贴的 File 对象 → 本机路径（沙箱里 File.path 不可用） */
    pathOf: (f: File) => webUtils.getPathForFile(f),
    save: (path: string, content: string) => ipcRenderer.invoke("files:save", path, content),
    watch: (path: string, on: boolean) => ipcRenderer.invoke("files:watch", path, on),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (name: string, instructions?: string) => ipcRenderer.invoke("projects:create", name, instructions),
    update: (id: string, patch: { name?: string; instructions?: string }) => ipcRenderer.invoke("projects:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("projects:remove", id),
    addFiles: (id: string) => ipcRenderer.invoke("projects:addFiles", id),
    removeFile: (id: string, path: string) => ipcRenderer.invoke("projects:removeFile", id, path),
    setForSession: (sid: string, projectId: string | null) => ipcRenderer.invoke("sessions:setProject", sid, projectId),
  },
  usage: { summary: () => ipcRenderer.invoke("usage:summary") },
  embedding: {
    get: () => ipcRenderer.invoke("embedding:get"),
    set: (value: unknown) => ipcRenderer.invoke("embedding:set", value),
    status: () => ipcRenderer.invoke("embedding:status"),
  },
  config: {
    get: (key: string) => ipcRenderer.invoke("config:get", key),
    set: (key: string, value: unknown) => ipcRenderer.invoke("config:set", key, value),
  },
  share: {
    export: (sessionId: string, format: "png" | "html", msgIds?: number[]) => ipcRenderer.invoke("share:export", sessionId, format, msgIds),
  },
  tasks: {
    list: (botId?: string) => ipcRenderer.invoke("tasks:list", botId),
    create: (input: any) => ipcRenderer.invoke("tasks:create", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("tasks:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("tasks:delete", id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("tasks:setEnabled", id, enabled),
    runNow: (id: string) => ipcRenderer.invoke("tasks:runNow", id),
    ensureWebhook: (id: string) => ipcRenderer.invoke("tasks:ensureWebhook", id),
    rotateWebhook: (id: string) => ipcRenderer.invoke("tasks:rotateWebhook", id),
    clearWebhook: (id: string) => ipcRenderer.invoke("tasks:clearWebhook", id),
  },
  demo: {
    status: (botId: string) => ipcRenderer.invoke("demo:status", botId),
    start: (botId: string, opts?: { title?: string; sessionId?: string }) => ipcRenderer.invoke("demo:start", botId, opts),
    cancel: (botId: string) => ipcRenderer.invoke("demo:cancel", botId),
    finish: (botId: string, opts?: { name?: string; description?: string; cron?: string; in?: string | number; testNow?: boolean; webhook?: boolean }) =>
      ipcRenderer.invoke("demo:finish", botId, opts),
  },
  connect: {
    cards: () => ipcRenderer.invoke("connect:cards"),
    gateway: () => ipcRenderer.invoke("connect:gateway"),
    setGateway: (input: { enabled: boolean; port?: number; host?: string; allowRemote?: boolean }) =>
      ipcRenderer.invoke("connect:setGateway", input),
    probeGateway: () => ipcRenderer.invoke("connect:probeGateway"),
    gatewayMsgToken: () => ipcRenderer.invoke("connect:gatewayMsgToken"),
    rotateGatewayMsgToken: () => ipcRenderer.invoke("connect:rotateGatewayMsgToken"),
    shareBridge: () => ipcRenderer.invoke("connect:shareBridge"),
    saveShareBridge: (input: { base: string; putKey?: string; ttlDays?: number }) =>
      ipcRenderer.invoke("connect:saveShareBridge", input),
    clearShareBridge: () => ipcRenderer.invoke("connect:clearShareBridge"),
    probeShareBridge: () => ipcRenderer.invoke("connect:probeShareBridge"),
    cloudflare: () => ipcRenderer.invoke("connect:cloudflare"),
    saveCloudflare: (input: { apiToken?: string; accountId?: string }) =>
      ipcRenderer.invoke("connect:saveCloudflare", input),
    clearCloudflare: () => ipcRenderer.invoke("connect:clearCloudflare"),
    provisionShareBridge: (input?: { apiToken?: string; accountId?: string; subdomain?: string; ttlDays?: number }) =>
      ipcRenderer.invoke("connect:provisionShareBridge", input),
    listShareLinks: () => ipcRenderer.invoke("connect:listShareLinks"),
    deleteShareLink: (id: string) => ipcRenderer.invoke("connect:deleteShareLink", id),
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

/** 宠物请求打开主面板会话（聚焦 + 跳转） */
const onBotCreated = (cb: (ev: { botId: string; sessionId: string }) => void) => {
  const listener = (_: unknown, ev: { botId: string; sessionId: string }) => cb(ev);
  ipcRenderer.on("bot:created", listener);
  return () => ipcRenderer.removeListener("bot:created", listener);
};
const onOpenSession = (cb: (sessionId: string | null) => void) => {
  const listener = (_e: IpcRendererEvent, sid: string | null) => cb(sid);
  ipcRenderer.on("window:open-session", listener);
  return () => ipcRenderer.removeListener("window:open-session", listener);
};

/** 宠物窗口：全局鼠标位置（相对窗口坐标），用于 Live2D 视线跟随 */
const onPetCursor = (cb: (p: { x: number; y: number }) => void) => {
  const listener = (_e: IpcRendererEvent, p: { x: number; y: number }) => cb(p);
  ipcRenderer.on("pet:cursor", listener);
  return () => ipcRenderer.removeListener("pet:cursor", listener);
};

/** bot.ask 期间被问 bot 的流式输出（parentSessionId = 发起提问的会话） */
const onB2bStream = (cb: (ev: { parentSessionId: string; botId: string; block: StreamBlock }) => void) => {
  const listener = (_e: IpcRendererEvent, ev: { parentSessionId: string; botId: string; block: StreamBlock }) => cb(ev);
  ipcRenderer.on("chat:b2b", listener);
  return () => ipcRenderer.removeListener("chat:b2b", listener);
};

/** 任意新消息落盘（定时任务、bot 间问答、被 @ 回复等后台消息） */
const onStatus = (cb: (st: { botId: string; state: string; currentTask?: string }) => void) => {
  const listener = (_e: IpcRendererEvent, st: { botId: string; state: string; currentTask?: string }) => cb(st);
  ipcRenderer.on("status:changed", listener);
  return () => ipcRenderer.removeListener("status:changed", listener);
};

const onNewMessage = (cb: (m: { sessionId: string; from: string; to: string }) => void) => {
  const listener = (_e: IpcRendererEvent, m: { sessionId: string; from: string; to: string }) => cb(m);
  ipcRenderer.on("messages:new", listener);
  return () => ipcRenderer.removeListener("messages:new", listener);
};

const onAppChanged = (cb: (what: string) => void) => {
  const listener = (_e: IpcRendererEvent, what: string) => cb(what);
  ipcRenderer.on("app:changed", listener);
  return () => ipcRenderer.removeListener("app:changed", listener);
};

const on = (channel: string) => (cb: (p: any) => void) => {
  const listener = (_e: unknown, p: any) => cb(p);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("harness", {
  ...api, onPetEvent, onChatStream, onOpenSession, onBotCreated, onPetCursor, onB2bStream, onNewMessage, onStatus, onAppChanged,
  onConsentRequest: on("consent:request"), onConsentResolved: on("consent:resolved"), onGroupProgress: on("group:progress"), onNotifyState: on("notify:state"),
  onSuggestions: on("chat:suggestions"), onFileChanged: on("files:changed"), onImportLink: on("bots:importLink"),
  onOpenAbout: on("app:openAbout"),
  onCodingScreen: on("coding:screen"),
  onCodingBytes: on("coding:bytes"),
  onBrowserState: on("browser:state"),
});
export type { StreamBlock };
export type HarnessApi = typeof api;
