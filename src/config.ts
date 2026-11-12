import dotenv from "dotenv";

dotenv.config();

type AppConfig = {
  botToken: string;
  parentChatIds: string[];
  timezone: string;
  morningCron: string;
  eveningCron: string;
  tasks: string[];
};

const defaultTasks = [
  "Почистить зубы",
  "первые 25 минут математики",
  "вторые 25 минут математики",
  "Третьи 25 минут",
  "Четвертые",
  "Покормить животных",
];

const legacyDefaultTasks = ["Почистить зубы", "20 минут математики", "Покормить животных"];

function isLegacyDefaultTaskList(tasks: string[]): boolean {
  return (
    tasks.length === legacyDefaultTasks.length &&
    tasks.every((task, index) => task === legacyDefaultTasks[index])
  );
}

function parseTasks(raw?: string): string[] {
  if (!raw) {
    return defaultTasks;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("TASKS_JSON must be a JSON array of strings.");
    }
    return isLegacyDefaultTaskList(parsed) ? defaultTasks : parsed;
  } catch (error) {
    throw new Error(`Failed to parse TASKS_JSON: ${(error as Error).message}`);
  }
}

function parseParentChatIds(raw?: string): string[] {
  const fallback = ["246529522", "246529521"];
  if (!raw) {
    return fallback;
  }

  const ids = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return ids.length > 0 ? ids : fallback;
}

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN is required. Copy .env.example to .env and fill it in.");
}

export const config: AppConfig = {
  botToken,
  parentChatIds: parseParentChatIds(process.env.PARENT_CHAT_IDS),
  timezone: process.env.TIMEZONE || "Europe/Warsaw",
  morningCron: process.env.MORNING_CRON || "0 8 * * *",
  eveningCron: process.env.EVENING_CRON || "0 20 * * *",
  tasks: parseTasks(process.env.TASKS_JSON),
};
