/**
 * 部署 harness-share-bridge Worker（读 appfactory CF token）。
 * 用法：bun run cloud/share-bridge/deploy.ts
 */
import { $ } from "bun";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir);
const envFile = join(homedir(), ".config/appfactory-cloudflare-legal/api_token.env");
const localSecret = join(homedir(), ".config/harness-bot/share-bridge.env");

function loadEnv(path: string) {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

const cf = loadEnv(envFile);
const token = process.env.CLOUDFLARE_API_TOKEN || cf.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID || cf.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（~/.config/appfactory-cloudflare-legal/api_token.env）");
  process.exit(1);
}

const local = loadEnv(localSecret);
let putKey = process.env.PUT_KEY || local.PUT_KEY;
if (!putKey) {
  putKey = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  mkdirSync(join(homedir(), ".config/harness-bot"), { recursive: true });
  writeFileSync(localSecret, `PUT_KEY=${putKey}\nSHARE_BRIDGE_BASE=\n`, { mode: 0o600 });
  console.log("已生成 PUT_KEY →", localSecret);
}

process.env.CLOUDFLARE_API_TOKEN = token;
process.env.CLOUDFLARE_ACCOUNT_ID = account;

console.log("deploying harness-share-bridge…");
await $`npx --yes wrangler@4 deploy`.cwd(root);
const keyFile = join(root, ".put-key.tmp");
writeFileSync(keyFile, putKey, { mode: 0o600 });
try {
  await $`bash -lc ${`npx --yes wrangler@4 secret put PUT_KEY < "${keyFile}"`}`.cwd(root);
} finally {
  try { await $`rm -f ${keyFile}`; } catch { /* ignore */ }
}

const base = "https://harness-share-bridge.harness-zjy.workers.dev";
const ttlDays = local.SHARE_BRIDGE_TTL_DAYS || "90";
mkdirSync(join(homedir(), ".config/harness-bot"), { recursive: true });
writeFileSync(
  localSecret,
  `PUT_KEY=${putKey}\nSHARE_BRIDGE_BASE=${base}\nSHARE_BRIDGE_TTL_DAYS=${ttlDays}\n`,
  { mode: 0o600 },
);
console.log("✅ base:", base);
console.log("✅ credentials:", localSecret);
