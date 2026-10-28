/**
 * shell 命令分析：找出一条命令行里真正会执行的每个命令，以及需要每次单独确认的风险。
 * 宁可多报：解析不了的写法一律算风险，交给用户逐次确认。
 */

export interface CommandAnalysis {
  /** 会执行的命令名（去掉路径）；命令名是变量或子命令结果时记为 "$()" */
  heads: string[];
  /** 需要每次确认、不能「总是允许」的原因 */
  risks: string[];
  /** 危险命令：每次强确认，信任模式也不放过 */
  dangerous: string[];
}

type Tok =
  | { t: "word"; text: string; quoted: boolean; dynamic: boolean }
  | { t: "op"; text: string }
  | { t: "redir"; text: string };

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}", "time", "in"]);
const WRAPPERS: Record<string, { argOpts?: string[] }> = {
  env: { argOpts: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  nohup: {}, command: {}, builtin: {}, exec: { argOpts: ["-a"] }, nice: { argOpts: ["-n"] }, time: {},
  timeout: { argOpts: ["-s", "-k", "--signal", "--kill-after"] }, caffeinate: { argOpts: ["-t", "-w"] },
  xargs: { argOpts: ["-n", "-I", "-i", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"] },
  sudo: { argOpts: ["-u", "-g", "-C", "-p", "-h", "-U"] }, doas: { argOpts: ["-u"] },
};
/** 解释器：执行内容完全由参数决定，不能「总是允许」 */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "eval", "source", ".",
  "python", "python2", "python3", "node", "deno", "ruby", "perl", "php", "lua", "tclsh", "osascript", "swift",
  "awk", "gawk", "nawk", "mawk", "npx", "bunx", "pnpx", "expect",
]);
/** 无副作用的 shell 内置命令，不需要授权 */
export const HARMLESS_BUILTINS = new Set(["cd", "pwd", "true", "false", "test", "[", "[[", ":", "export", "unset", "set", "shift", "return", "exit", "wait", "read", "type", "which", "printf"]);
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/s?bin\/[^/]+$/;

/** 词法：处理引号、转义、$() / 反引号 / <() 子命令、重定向和操作符 */
function lex(src: string, subs: string[]): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  let word = "", quoted = false, dynamic = false, inWord = false;
  /** here-doc：等着读定界符 / 已读到、换行后要跳过正文的定界符 */
  let heredocNext: "" | "<<" | "<<-" = "";
  const heredocs: { delim: string; strip: boolean }[] = [];
  const flush = () => {
    if (inWord) {
      out.push({ t: "word", text: word, quoted, dynamic });
      if (heredocNext) { heredocs.push({ delim: word, strip: heredocNext === "<<-" }); heredocNext = ""; }
    }
    word = ""; quoted = false; dynamic = false; inWord = false;
  };
  /** 换行后跳过 here-doc 正文，返回正文结束后的位置 */
  const skipHeredocs = (pos: number): number => {
    while (heredocs.length) {
      const { delim, strip } = heredocs.shift()!;
      for (;;) {
        if (pos >= src.length) return pos;
        const nl = src.indexOf("\n", pos);
        const line = src.slice(pos, nl < 0 ? src.length : nl);
        pos = nl < 0 ? src.length : nl + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
    return pos;
  };
  /** 从 start（指向开括号之后）读到配对的右括号，返回结束位置 */
  const balanced = (start: number): number => {
    let depth = 1, j = start, q: string | null = null;
    while (j < src.length) {
      const c = src[j];
      if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = null; }
      else if (c === "'" || c === '"') q = c;
      else if (c === "\\") j++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
      j++;
    }
    return -1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue; }
      word += src[i + 1] ?? ""; inWord = true; quoted = true; i += 2; continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      word += src.slice(i + 1, end); inWord = true; quoted = true; i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      inWord = true; quoted = true;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") { word += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "(") {
          const end = balanced(j + 2);
          if (end < 0) return null;
          subs.push(src.slice(j + 2, end)); dynamic = true; word += "\u0001"; j = end + 1; continue;
        }
        if (src[j] === "`") {
          const end = src.indexOf("`", j + 1);
          if (end < 0) return null;
          subs.push(src.slice(j + 1, end)); dynamic = true; word += "\u0001"; j = end + 1; continue;
        }
        if (src[j] === "$") dynamic = true;
        word += src[j]; j++;
      }
      if (j >= src.length) return null;
      i = j + 1; continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = balanced(i + 2);
      if (end < 0) return null;
      subs.push(src.slice(src[i + 2] === "(" ? i + 3 : i + 2, src[i + 2] === "(" ? end - 1 : end));
      word += "\u0001"; inWord = true; dynamic = true; i = end + 1; continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) return null;
      subs.push(src.slice(i + 1, end)); word += "\u0001"; inWord = true; dynamic = true; i = end + 1; continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = balanced(i + 2);
      if (end < 0) return null;
      subs.push(src.slice(i + 2, end)); word += "\u0001"; inWord = true; dynamic = true; i = end + 1; continue;
    }
    if (c === "$") { dynamic = true; word += c; inWord = true; i++; continue; }
    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c) && c !== "\n") { flush(); i++; continue; }
    // 重定向：[n]> [n]>> >| &> &>> [n]< << <<< [n]>&m <&
    const redir = src.slice(i).match(/^(?:&>>?|>>|>\||>&|<<<|<<-?|<&|<>|>|<)/);
    if (redir) {
      const fdPrefix = inWord && /^\d+$/.test(word);
      if (fdPrefix) { word = ""; inWord = false; quoted = false; dynamic = false; }
      else flush();
      out.push({ t: "redir", text: redir[0] });
      if (redir[0] === "<<" || redir[0] === "<<-") heredocNext = redir[0];
      i += redir[0].length;
      continue;
    }
    const op = src.slice(i).match(/^(?:\|\||&&|;;|\|&|[|;&\n()])/);
    if (op) {
      flush();
      out.push({ t: "op", text: op[0] });
      i += op[0].length;
      if (op[0] === "\n") i = skipHeredocs(i);
      continue;
    }
    word += c; inWord = true; i++;
  }
  flush();
  return out;
}

const QUIET_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|&?\d+|-)$/;
const basename = (s: string) => s.split("/").pop() || s;

/** 某个命令的参数里有没有能执行任意代码 / 改文件的写法 */
function argRisks(head: string, args: string[]): string[] {
  const r: string[] = [];
  const has = (re: RegExp) => args.some((a) => re.test(a));
  if (head === "git" && has(/^(-c|--config-env|--upload-pack|--receive-pack|--exec|--template|-u)(=|$)|^core\.(pager|sshCommand|editor|fsmonitor|hooksPath)/)) r.push("git 带了能执行任意命令的配置参数");
  if (head === "find" && has(/^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/)) r.push("find 带了 -exec / -delete 等会执行或删除的参数");
  if (head === "sed" && (has(/^(-i|--in-place)/) || has(/(^|[;}\s])\d*\s*[we]\s|\/e\s*$/))) r.push("sed 会改写文件或执行命令");
  if (["perl", "ruby"].includes(head) && has(/^-[a-z]*i/)) r.push(`${head} -i 会改写文件`);
  if (["tee", "dd"].includes(head)) r.push(`${head} 会写文件`);
  if (head === "curl" && has(/^(-o|-O|--output|--remote-name|-T|--upload-file|-d|--data.*|-F|--form|-K|--config)(=|$)/)) r.push("curl 会写文件或上传数据");
  if (head === "wget" && has(/^(-O|--output-document|--post-data|--post-file)(=|$)/)) r.push("wget 会写文件或上传数据");
  if (["bun", "deno"].includes(head) && has(/^(-e|--eval|-p|--print|x|run)$/)) r.push(`${head} 会执行任意代码`);
  if (["npm", "pnpm", "yarn"].includes(head) && has(/^(exec|x|dlx|create|init)$/)) r.push(`${head} 会下载并执行包`);
  if (["chmod", "chown"].includes(head) && has(/^-[a-zA-Z]*R/)) r.push(`${head} -R 递归改权限`);
  return r;
}

/** 危险：删家目录/根目录/系统目录、提权、抹盘、下载即执行 */
function dangerOf(head: string, args: string[]): string | null {
  const homeish = /^(~|~\/|~\/\*|\$HOME|\$\{HOME\}|\$HOME\/\*?|\$\{HOME\}\/\*?|\/|\/\*|\*|\.\.?\/?|\/(Users|System|Library|Applications|bin|sbin|usr|etc|var|private|opt|Volumes)(\/[^/\s]*)?\/?\*?|~\/[^/\s]+\/?\*?|\$HOME\/[^/\s]+\/?)$/;
  if (["sudo", "su", "doas"].includes(head)) return `${head} 会提权`;
  if (head === "rm") {
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const recursive = /r|R|--recursive/.test(flags);
    if (recursive && args.some((a) => !a.startsWith("-") && homeish.test(a))) return "递归删除家目录 / 系统目录";
  }
  if (head === "find" && args.includes("-delete") && args.some((a) => homeish.test(a))) return "在家目录 / 系统目录里批量删除";
  if (["mkfs", "newfs_apfs", "newfs_hfs", "fdisk", "gpt"].includes(head) || /^mkfs\./.test(head)) return "格式化磁盘";
  if (head === "diskutil" && args.some((a) => /^(erase|partition|zero|secureErase|reformat)/i.test(a))) return "抹掉磁盘";
  if (head === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return "直接写磁盘设备";
  if (["shutdown", "reboot", "halt"].includes(head)) return "关机 / 重启";
  if (head === "kill" && args.includes("-1")) return "结束所有进程";
  if (["chmod", "chown"].includes(head) && /R/.test(args.filter((a) => a.startsWith("-")).join("")) && args.some((a) => homeish.test(a))) return "递归改家目录 / 系统目录权限";
  return null;
}

export function analyzeCommand(cmd: string, depth = 0): CommandAnalysis {
  const heads: string[] = [], risks: string[] = [], dangerous: string[] = [];
  const addHead = (h: string) => { if (!heads.includes(h)) heads.push(h); };
  const addRisk = (r: string) => { if (!risks.includes(r)) risks.push(r); };
  if (depth > 4) return { heads: ["$()"], risks: ["子命令嵌套太深"], dangerous };
  if (/:\s*\(\s*\)\s*\{/.test(cmd)) dangerous.push("fork 炸弹");
  const subs: string[] = [];
  const toks = lex(cmd, subs);
  if (!toks) return { heads: ["$()"], risks: ["引号或括号没有配对，无法确认会执行什么"], dangerous };

  // 按操作符切成一个个简单命令
  const simple: { words: Extract<Tok, { t: "word" }>[]; redirs: { op: string; target?: Extract<Tok, { t: "word" }> }[] }[] = [];
  let cur: (typeof simple)[number] = { words: [], redirs: [] };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "op") {
      simple.push(cur); cur = { words: [], redirs: [] };
      if (tk.text === ";;") addRisk("用了 case 语句，无法逐个确认命令");
      continue;
    }
    if (tk.t === "redir") {
      const next = toks[k + 1];
      const target = next?.t === "word" ? next : undefined;
      if (target) k++;
      cur.redirs.push({ op: tk.text, target });
      continue;
    }
    cur.words.push(tk);
  }
  simple.push(cur);

  for (const sc of simple) {
    for (const r of sc.redirs) {
      if (/^<<-?$/.test(r.op)) continue;
      if (/>|<>/.test(r.op) && r.op !== ">&" && !(r.target && QUIET_TARGET.test(r.target.text))) addRisk(`会写入文件 ${r.target?.text ?? ""}`.trim());
    }
    const w = sc.words;
    let i = 0;
    while (i < w.length) {
      // 跳过环境变量赋值和关键字
      if (!w[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w[i].text)) { i++; continue; }
      if (!w[i].quoted && KEYWORDS.has(w[i].text)) {
        if (w[i].text === "in") { i = w.length; break; }
        i++; continue;
      }
      if (!w[i].quoted && w[i].text === "for") { i = w.length; break; }
      if (!w[i].quoted && (w[i].text === "function" || w[i].text === "case" || w[i].text === "select" || w[i].text === "coproc")) { addRisk(`用了 ${w[i].text} 语法，无法逐个确认命令`); i = w.length; break; }
      break;
    }
    if (i >= w.length) continue;
    const word = w[i];
    // 参数里的 $() / `...` / 未加引号的 $VAR：不能靠「总是允许 curl」放行
    if (w.slice(i + 1).some((x) => x.dynamic || x.text.includes("\u0001"))) {
      addRisk("参数含有子命令或变量展开，执行前看不出实际内容");
    }
    if (word.dynamic || word.text.includes("\u0001")) { addHead("$()"); addRisk("要执行的命令名来自变量或子命令，执行前看不出是什么"); continue; }
    if (word.text.includes("/") && !SYSTEM_BIN.test(word.text)) addRisk(`执行本地程序 / 脚本 ${word.text}`);
    let head = basename(word.text);
    let args = w.slice(i + 1).map((x) => x.text);
    if (!head) continue;
    if (/^\(\)$/.test(args[0] ?? "")) { addRisk("定义了 shell 函数，无法逐个确认命令"); continue; }
    // 包装命令：env / nohup / xargs / sudo …，被包装的命令也算
    for (let guard = 0; guard < 6; guard++) {
      addHead(head);
      const d = dangerOf(head, args);
      if (d && !dangerous.includes(d)) dangerous.push(d);
      for (const r of argRisks(head, args)) addRisk(r);
      if (INTERPRETERS.has(head)) addRisk(`${head} 会执行任意代码`);
      const spec = WRAPPERS[head];
      if (!spec) break;
      let j = 0;
      while (j < args.length) {
        const a = args[j];
        if (head === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { j++; continue; }
        if (head === "timeout" && !a.startsWith("-") && /^\d/.test(a)) { j++; continue; }
        if (a === "--") { j++; break; }
        if (!a.startsWith("-") || a === "-") break;
        if (spec.argOpts?.includes(a)) { if (head === "env" && (a === "-S" || a === "--split-string")) addRisk("env -S 会把字符串当命令执行"); j += 2; continue; }
        j++;
      }
      if (j >= args.length) break;
      if (head === "xargs" || head === "sudo") addRisk(`${head} 会以不同方式执行后面的命令`);
      const next = args[j];
      if (/\u0001|\$/.test(next)) { addHead("$()"); addRisk("要执行的命令名来自变量或子命令，执行前看不出是什么"); break; }
      head = basename(next);
      args = args.slice(j + 1);
    }
  }
  // curl ... | sh：下载即执行
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|ruby|perl)\b/.test(cmd)) dangerous.push("下载内容直接交给解释器执行");

  for (const s of subs) {
    const inner = analyzeCommand(s, depth + 1);
    inner.heads.forEach(addHead);
    inner.risks.forEach(addRisk);
    for (const d of inner.dangerous) if (!dangerous.includes(d)) dangerous.push(d);
  }
  return { heads, risks, dangerous };
}

/** 兼容旧接口：命令行里实际会执行的命令名 */
export function commandHeads(cmd: string): string[] {
  return analyzeCommand(cmd).heads;
}

export function isDangerousCommand(cmd: string): boolean {
  return analyzeCommand(cmd).dangerous.length > 0;
}
