/**
 * 项目：一组会话共用的自定义指令和资料文件；加上全局自定义指令，一起注入 bot 的系统提示。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { basename, join } from "node:path";
import { ingestFiles, type FileBlock } from "./attachments";

export interface Project {
  id: string;
  name: string;
  instructions: string;
  files: FileBlock[];
  createdAt: number;
  updatedAt: number;
}

export interface GlobalInstructions {
  /** 关于我：bot 应该知道的用户背景 */
  about?: string;
  /** 回复方式：语气、长度、格式偏好 */
  style?: string;
}

/** 项目资料随系统提示注入的总字数上限，超出的让 bot 用 fs.read 读全文 */
const PROJECT_FILES_BUDGET = 24_000;

export class ProjectRegistry {
  private path: string;
  private items: Project[];
  constructor(private home: string) {
    this.path = join(home, "projects.json");
    const items = readJsonSafe<Project[]>(this.path, []);
    this.items = Array.isArray(items) ? items : [];
  }
  private save() { writeJsonAtomic(this.path, this.items); }
  dirOf(id: string) { return join(this.home, "workspace", "projects", id); }

  list(): Project[] { return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id?: string | null): Project | null { return (id && this.items.find((p) => p.id === id)) || null; }

  create(name: string, instructions = ""): Project {
    const p: Project = { id: `p-${Date.now().toString(36)}`, name: name.trim() || "未命名项目", instructions, files: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.items.push(p);
    this.save();
    return p;
  }

  update(id: string, patch: { name?: string; instructions?: string }): Project {
    const p = this.get(id);
    if (!p) throw new Error("项目不存在");
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.instructions !== undefined) p.instructions = patch.instructions;
    p.updatedAt = Date.now();
    this.save();
    return p;
  }

  async addFiles(id: string, paths: string[]): Promise<Project> {
    const p = this.get(id);
    if (!p) throw new Error("项目不存在");
    const blocks = await ingestFiles(paths, this.dirOf(id));
    for (const b of blocks) if (b.type === "file") p.files.push(b);
    p.updatedAt = Date.now();
    this.save();
    return p;
  }

  removeFile(id: string, path: string): Project {
    const p = this.get(id);
    if (!p) throw new Error("项目不存在");
    const f = p.files.find((x) => x.path === path);
    p.files = p.files.filter((x) => x.path !== path);
    for (const x of [f?.path, f?.textPath]) if (x) rmSync(x, { force: true });
    p.updatedAt = Date.now();
    this.save();
    return p;
  }

  /** 迁移导入：新建项目并把资料文件复制到本机项目目录；源文件不存在的跳过 */
  importProject(src: Pick<Project, "name" | "instructions" | "files">): Project {
    const p = this.create(src.name, src.instructions);
    const dir = this.dirOf(p.id);
    mkdirSync(join(dir, ".text"), { recursive: true });
    for (const f of src.files ?? []) {
      if (!f.path || !existsSync(f.path)) continue;
      const path = join(dir, basename(f.path));
      copyFileSync(f.path, path);
      let textPath: string | undefined;
      if (f.textPath && existsSync(f.textPath)) {
        textPath = join(dir, ".text", basename(f.textPath));
        copyFileSync(f.textPath, textPath);
      }
      p.files.push({ ...f, path, ...(textPath ? { textPath } : {}) });
    }
    this.save();
    return p;
  }

  remove(id: string) {
    this.items = this.items.filter((p) => p.id !== id);
    rmSync(this.dirOf(id), { recursive: true, force: true });
    this.save();
  }
}

/** 全局 + 项目指令 → 系统提示片段 */
export function instructionsPrompt(global: GlobalInstructions | undefined, project: Project | null): string {
  const parts: string[] = [];
  if (global?.about?.trim()) parts.push(`【关于用户】\n${global.about.trim()}`);
  if (global?.style?.trim()) parts.push(`【用户希望的回复方式】\n${global.style.trim()}`);
  if (project) {
    const lines = [`【当前项目：${project.name}】`];
    if (project.instructions.trim()) lines.push(project.instructions.trim());
    let budget = PROJECT_FILES_BUDGET;
    for (const f of project.files) {
      const text = f.textPath && existsSync(f.textPath) ? readFileSync(f.textPath, "utf8") : "";
      if (!text) { lines.push(`- 资料「${f.name}」（读不出文字）`); continue; }
      const take = Math.max(0, Math.min(text.length, budget));
      budget -= take;
      lines.push(take >= text.length
        ? `资料「${f.name}」：\n<<<\n${text}\n>>>`
        : `资料「${f.name}」（共 ${text.length} 字${take ? "，以下是开头" : ""}；全文 ${f.textPath}，需要时用 fs.read 读）${take ? `：\n<<<\n${text.slice(0, take)}\n>>>` : ""}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}
