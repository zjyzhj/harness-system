/**
 * electron-builder afterSign hook.
 * 有 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID 才公证；否则跳过（开发机 / CI 无证）。
 */
exports.default = async function notarizeIfConfigured(_context) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] 跳过：未配置 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID");
    return;
  }
  // 需要时再装 @electron/notarize；当前只占位，避免无证环境失败
  console.log("[notarize] 已检测到 Apple 凭证环境变量，请接入 @electron/notarize 完成公证");
};
