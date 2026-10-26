export type ProviderKind = "openai-compat" | "cli";

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  isDefault: boolean;
  cliName?: "codex" | "cursor" | "claude";
  createdAt: number;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  persona: string;
  providerId: string;
  model?: string;
  systemPrompt?: string;
  petEnabled: boolean;
  avatarPath?: string;
  personaCard?: PersonaCard;
  createdAt: number;
}

export interface PersonaCard {
  name: string;
  traits: string[];
  catchphrase?: string;
  background?: string;
  interactionStyle?: string;
}

export interface ChatMessage {
  id?: number;
  sessionId: string;
  from: string;
  to: string;
  role: "user" | "assistant" | "system";
  content: string;
  kind: "chat" | "bot-to-bot" | "event";
  createdAt: number;
}

export interface Session {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PetState {
  botId: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface MigrationPayload {
  format: "harness-bot-migration/v1";
  exportedAt: string;
  providers: Provider[];
  bots: Bot[];
  pets: PetState[];
  assets?: Record<string, string>;
}
