import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 8000, maxBuffer: 100_000 }, (err, stdout) => {
      if (err && !stdout) resolve("");
      else resolve(String(stdout || "").trim());
    });
  });
}

/** 这一步改完之后，仓库里实际动了哪些文件。失败时给出说明，不抛错。 */
export async function summarizeRepoChanges(cwd: string): Promise<string> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return "【仓库改动】\n这个目录不是 git 仓库，看不到文件改动。";
  const files = await git(cwd, ["status", "--short"]);
  const stat = await git(cwd, ["diff", "--stat"]);
  if (!files && !stat) return "【仓库改动】\n仓库里没有新的文件改动。";
  return `【仓库改动】\n${[files, stat].filter(Boolean).join("\n")}`.slice(0, 4000);
}
