import fs from "node:fs";
import path from "node:path";

export type Mood = "easy" | "ok" | "hard";

export type ProofState = {
  receivedAt: string;
};

export type DayState = {
  date: string;
  tasks: Record<string, boolean>;
  proofs: Record<string, ProofState | undefined>;
  mood?: Mood;
  tooHard: boolean;
  completedAt?: string;
  completionNotifiedAt?: string;
  updatedAt: string;
};

export type ChildProfile = {
  displayName?: string;
  pendingProofTask?: string;
  days: Record<string, DayState>;
};

export type AppState = {
  childProfiles: Record<string, ChildProfile>;
};

const dataDir = path.resolve(process.cwd(), "data");
const dataFile = path.join(dataDir, "state.json");

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    const initialState: AppState = { childProfiles: {} };
    fs.writeFileSync(dataFile, JSON.stringify(initialState, null, 2), "utf8");
  }
}

export function loadState(): AppState {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(dataFile, "utf8")) as AppState;
}

export function saveState(state: AppState) {
  ensureDataFile();
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
}
