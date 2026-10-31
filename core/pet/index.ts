/** 桌宠娱乐侧车公开面 — Bot 核心不要 import 这里除 attach 以外的实现细节 */
export type { PetHost } from "./host-port";
export type { PetToolDeps } from "./tools";
export { runPetTool } from "./tools";
export { isPetTopic, petSelfBrief, petPlaybook } from "./prompt";
export { attachPetEntertainment, type PetSidecarOpts, type PetEntertainmentTarget } from "./sidecar";
