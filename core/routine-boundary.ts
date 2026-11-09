/**
 * 例行在没人时可以做准备、核对、改指定目录里的代码。
 * 发送、删除、发布停在批准点，除非这个 bot 是 Always。
 * 对齐 Grok：Require approval for sending, deleting, publishing, or changing production.
 */

export type ApprovalKind = "发送" | "删除";

const UNATTENDED_APPROVAL: Record<string, ApprovalKind> = {
  "webhook.post": "发送",
  "secret.delete": "删除",
  "skill.delete": "删除",
  "sys.purge": "删除",
  "task.delete": "删除",
  "webhook.remove": "删除",
  "env.delete": "删除",
};

export function unattendedApprovalKind(tool: string): ApprovalKind | null {
  return UNATTENDED_APPROVAL[tool] ?? null;
}
