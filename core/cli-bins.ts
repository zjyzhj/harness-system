/** 本机 CLI 可执行名（聊天 ask 与派工 agent 共用，避免双表漂移） */
export const CLI_BINS = {
  cursor: "cursor-agent",
  claude: "claude",
  codex: "codex",
} as const;

export type BuiltinCliId = keyof typeof CLI_BINS;

export function builtinCliBin(id: string): string | undefined {
  return (CLI_BINS as Record<string, string>)[id];
}
