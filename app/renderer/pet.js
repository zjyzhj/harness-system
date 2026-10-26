const api = window.harness;
const botId = new URLSearchParams(location.search).get("botId");
const petEl = document.getElementById("pet");
const avatarEl = document.getElementById("pet-avatar");
const nameEl = document.getElementById("pet-name");
const bubble = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const bubbleInput = document.getElementById("bubble-input");
const bubbleSend = document.getElementById("bubble-send");

async function init() {
  const [bots, pets] = await Promise.all([api.bots.list(), api.pets.list()]);
  const bot = bots.find((b) => b.id === botId);
  if (!bot) return;
  nameEl.textContent = bot.name;
  if (bot.avatarPath) {
    avatarEl.innerHTML = `<img src="file://${bot.avatarPath}" />`;
  } else {
    avatarEl.textContent = "🤖";
  }
  const pet = pets.find((p) => p.botId === botId);
  if (pet) {
    const w = window.screen.width, h = window.screen.height;
    // 位置通过 main 的 moved 事件持久化；这里初始位置由 main 决定
  }
  // 保持置顶：点击时短暂提升
  petEl.onclick = () => {
    bubble.classList.toggle("hidden");
  };
  bubbleSend.onclick = async () => {
    const text = bubbleInput.value.trim();
    if (!text) return;
    bubbleText.textContent = "…";
    bubbleInput.value = "";
    const msgs = await api.chat.send(bot.id, text);
    const reply = msgs.filter((m) => m.from === bot.id).pop();
    bubbleText.textContent = reply?.content || "（无回复）";
  };
  bubbleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bubbleSend.click(); } });
}
init();
