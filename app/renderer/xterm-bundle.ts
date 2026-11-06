import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const w = window as unknown as { HarnessXterm?: { Terminal: typeof Terminal; FitAddon: typeof FitAddon } };
w.HarnessXterm = { Terminal, FitAddon };
