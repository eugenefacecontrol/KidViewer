import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import { config } from "./config";
import { AppState, ChildProfile, DayState, Mood, loadState, saveState } from "./storage";

const bot = new Telegraf(config.botToken);

const TASK_PREFIX = "task:";
const MOOD_PREFIX = "mood:";
const ACTION_TODAY = "action:today";
const ACTION_TOO_HARD = "action:too_hard";
const ACTION_SUMMARY = "action:summary";
const ACTION_SKIP_PROOF = "action:skip_proof";
const SUMMARY_SEPARATOR = "\n\n--------------------\n\n";

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isParentChat(chatId: string) {
  return config.parentChatIds.includes(chatId);
}

function taskMap(): Record<string, boolean> {
  return Object.fromEntries(config.tasks.map((task) => [task, false]));
}

function proofMap(): Record<string, undefined> {
  return Object.fromEntries(config.tasks.map((task) => [task, undefined]));
}

function normalizeTaskList(tasks: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const task of tasks.map((item) => item.trim()).filter(Boolean)) {
    if (seen.has(task)) {
      continue;
    }
    seen.add(task);
    normalized.push(task);
  }

  return normalized;
}

function parseTasksFromText(text: string): string[] {
  return normalizeTaskList(
    text
      .split("\n")
      .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean),
  );
}

function getDayTasks(day: DayState): string[] {
  return day.taskOrder.length > 0 ? day.taskOrder : normalizeTaskList(Object.keys(day.tasks));
}

function withState<T>(updater: (state: AppState) => T): T {
  const state = loadState();
  const result = updater(state);
  saveState(state);
  return result;
}

function ensureChildProfile(state: AppState, chatId: string): ChildProfile {
  if (!state.childProfiles[chatId]) {
    state.childProfiles[chatId] = { days: {} };
  }

  return state.childProfiles[chatId];
}

function ensureDay(profile: ChildProfile, date = todayKey()): DayState {
  if (!profile.days[date]) {
    profile.days[date] = {
      date,
      taskOrder: [...config.tasks],
      tasks: taskMap(),
      proofs: proofMap(),
      tooHard: false,
      updatedAt: nowIso(),
    };
  }

  if (!profile.days[date].taskOrder || profile.days[date].taskOrder.length === 0) {
    profile.days[date].taskOrder = normalizeTaskList(Object.keys(profile.days[date].tasks));
  }

  for (const task of getDayTasks(profile.days[date])) {
    if (!(task in profile.days[date].tasks)) {
      profile.days[date].tasks[task] = false;
    }
    if (!(task in profile.days[date].proofs)) {
      profile.days[date].proofs[task] = undefined;
    }
  }

  return profile.days[date];
}

function rememberDisplayName(state: AppState, chatId: string, displayName?: string) {
  const profile = ensureChildProfile(state, chatId);
  if (displayName) {
    profile.displayName = displayName;
  }
}

function progress(day: DayState) {
  const tasks = getDayTasks(day);
  const done = tasks.filter((task) => day.tasks[task]).length;
  return { done, total: tasks.length };
}

function isAllDone(day: DayState) {
  const tasks = getDayTasks(day);
  return tasks.length > 0 && tasks.every((task) => day.tasks[task]);
}

function taskLabel(day: DayState, task: string) {
  const done = day.tasks[task] ? "✅" : "⬜️";
  const proof = day.proofs[task] ? "📷" : "";
  return `${done}${proof ? ` ${proof}` : ""} ${task}`;
}

function childKeyboard(day: DayState) {
  const taskButtons = getDayTasks(day).map((task) => [
    Markup.button.callback(taskLabel(day, task), `${TASK_PREFIX}${task}`),
  ]);

  return Markup.inlineKeyboard([
    ...taskButtons,
    [
      Markup.button.callback("😊 Легко", `${MOOD_PREFIX}easy`),
      Markup.button.callback("😐 Нормально", `${MOOD_PREFIX}ok`),
      Markup.button.callback("😞 Тяжело", `${MOOD_PREFIX}hard`),
    ],
    [Markup.button.callback("Сегодня было слишком тяжело", ACTION_TOO_HARD)],
    [Markup.button.callback("Обновить статус", ACTION_TODAY)],
  ]);
}

function renderToday(day: DayState) {
  const { done, total } = progress(day);
  const tasks = getDayTasks(day).map((task) => taskLabel(day, task)).join("\n");

  const moodLine =
    day.mood === "easy"
      ? "Настроение: 😊 Легко"
      : day.mood === "ok"
        ? "Настроение: 😐 Нормально"
        : day.mood === "hard"
          ? "Настроение: 😞 Тяжело"
          : "Настроение: не отмечено";

  const tooHardLine = day.tooHard
    ? "\nСигнал: сегодня было слишком тяжело. Лучше перейти к спокойному разговору."
    : "";

  const doneLine = total > 0 && isAllDone(day)
    ? "\n\nВсе базовые дела закрыты. Итог уже можно показать взрослым."
    : "";

  return [
    "<b>План на сегодня</b>",
    `Прогресс: ${done}/${total}`,
    "",
    escapeHtml(tasks),
    "",
    moodLine,
    tooHardLine,
    doneLine,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderChildSummary(chatId: string, profile: ChildProfile, day: DayState) {
  const { done, total } = progress(day);
  const taskLines = getDayTasks(day).map((task) => taskLabel(day, task)).join("\n");
  const mood =
    day.mood === "easy"
      ? "Легко"
      : day.mood === "ok"
        ? "Нормально"
        : day.mood === "hard"
          ? "Тяжело"
          : "Не отмечено";
  const childName = profile.displayName ? `${profile.displayName} (${chatId})` : chatId;

  return [
    `Ребенок: ${childName}`,
    `Сводка за ${day.date}`,
    `Выполнено: ${done}/${total}`,
    `Настроение: ${mood}`,
    `Слишком тяжело: ${day.tooHard ? "Да" : "Нет"}`,
    "",
    taskLines,
  ].join("\n");
}

function renderAllSummaries(state: AppState, date = todayKey()) {
  const summaries = Object.entries(state.childProfiles)
    .map(([chatId, profile]) => {
      const day = profile.days[date];
      return day ? renderChildSummary(chatId, profile, day) : undefined;
    })
    .filter((item): item is string => Boolean(item));

  if (summaries.length === 0) {
    return `Сводка за ${date}\n\nСегодня пока нет активных детских профилей.`;
  }

  return summaries.join(SUMMARY_SEPARATOR);
}

function renderChildrenList(state: AppState) {
  const children = Object.entries(state.childProfiles);

  if (children.length === 0) {
    return "Пока нет ни одного детского профиля.";
  }

  return children
    .map(([chatId, profile], index) => {
      const name = profile.displayName || "Без имени";
      const day = profile.days[todayKey()];
      const progressText = day ? `${progress(day).done}/${progress(day).total}` : "нет задач";
      return `${index + 1}. ${name}\nchat_id: ${chatId}\nСегодня: ${progressText}`;
    })
    .join("\n\n");
}

function setTasksForToday(profile: ChildProfile, tasks: string[]) {
  const normalizedTasks = normalizeTaskList(tasks);
  const day = ensureDay(profile);

  day.taskOrder = normalizedTasks;
  day.tasks = Object.fromEntries(normalizedTasks.map((task) => [task, day.tasks[task] ?? false]));
  day.proofs = Object.fromEntries(normalizedTasks.map((task) => [task, day.proofs[task]]));
  day.updatedAt = nowIso();
  day.completedAt = isAllDone(day) ? nowIso() : undefined;
  day.completionNotifiedAt = undefined;

  if (profile.pendingProofTask && !normalizedTasks.includes(profile.pendingProofTask)) {
    delete profile.pendingProofTask;
  }

  return day;
}

async function sendToday(chatId: string) {
  const day = withState((state) => {
    const profile = ensureChildProfile(state, chatId);
    return ensureDay(profile);
  });

  await bot.telegram.sendMessage(chatId, renderToday(day), {
    parse_mode: "HTML",
    ...childKeyboard(day),
  });
}

async function sendParentSummary(chatId: string) {
  const summary = withState((state) => renderAllSummaries(state));
  await bot.telegram.sendMessage(chatId, summary);
}

async function notifyParents(text: string) {
  for (const parentChatId of config.parentChatIds) {
    await bot.telegram.sendMessage(parentChatId, text);
  }
}

async function notifyParentsIfReady(childChatId: string) {
  const result = withState((state) => {
    const profile = ensureChildProfile(state, childChatId);
    const day = ensureDay(profile);
    if (!isAllDone(day) || day.completionNotifiedAt) {
      return undefined;
    }

    day.completionNotifiedAt = nowIso();
    return renderChildSummary(childChatId, profile, day);
  });

  if (!result) {
    return;
  }

  await notifyParents(`База дня закрыта.\n\n${result}`);
}

bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (isParentChat(chatId)) {
    await ctx.reply(
      [
        "Это родительский режим.",
        "",
        "Доступно:",
        "/summary - сводка по всем детским профилям за сегодня",
        "/children - список детей и их chat_id",
        "/settoday <chat_id> - задать задачи на сегодня, по одной на строку",
      ].join("\n"),
    );
    return;
  }

  withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
  });

  await ctx.reply(
    [
      "Это детский режим.",
      "",
      "Команды:",
      "/today - показать задачи на сегодня",
      "",
      "Взрослые функции в этом чате недоступны.",
    ].join("\n"),
  );
});

bot.command("today", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (isParentChat(chatId)) {
    await ctx.reply("В этом чате доступен только родительский просмотр. Используй /summary.");
    return;
  }

  const day = withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
    return ensureDay(ensureChildProfile(state, chatId));
  });

  await ctx.reply(renderToday(day), {
    parse_mode: "HTML",
    ...childKeyboard(day),
  });
});

bot.command("summary", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  const summary = withState((state) => renderAllSummaries(state));
  await ctx.reply(
    summary,
    Markup.inlineKeyboard([[Markup.button.callback("Обновить сводку", ACTION_SUMMARY)]]),
  );
});

bot.command("children", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  const children = withState((state) => renderChildrenList(state));
  await ctx.reply(children);
});

bot.command("settoday", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  const text = ctx.message.text;
  const commandMatch = text.match(/^\/settoday(?:@\S+)?\s+(\S+)\s*\n?([\s\S]*)$/);

  if (!commandMatch) {
    await ctx.reply(
      [
        "Использование:",
        "/settoday <child_chat_id>",
        "Задача 1",
        "Задача 2",
        "Задача 3",
        "",
        "Сначала можно посмотреть /children.",
      ].join("\n"),
    );
    return;
  }

  const targetChatId = commandMatch[1].trim();
  const rawTasks = commandMatch[2] ?? "";
  const parsedTasks = parseTasksFromText(rawTasks);

  if (parsedTasks.length === 0) {
    await ctx.reply("Не вижу задач. Пришли их после первой строки, по одной на строку.");
    return;
  }

  const result = withState((state) => {
    const profile = ensureChildProfile(state, targetChatId);
    const day = setTasksForToday(profile, parsedTasks);
    return {
      childName: profile.displayName || targetChatId,
      summary: renderChildSummary(targetChatId, profile, day),
    };
  });

  await ctx.reply(
    [
      `Задачи на сегодня обновлены для ${result.childName}.`,
      "",
      result.summary,
    ].join("\n"),
  );

  await notifyParents(
    [
      "Админ обновил задачи на сегодня.",
      "",
      result.summary,
    ].join("\n"),
  );

  try {
    await sendToday(targetChatId);
  } catch (error) {
    await ctx.reply(
      `Задачи сохранены, но не удалось отправить их ребенку в чат ${targetChatId}. Возможно, он еще не писал боту.`,
    );
    console.error("Failed to push updated tasks to child chat:", error);
  }
});

bot.action(ACTION_TODAY, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  const day = withState((state) => ensureDay(ensureChildProfile(state, chatId)));
  await ctx.editMessageText(renderToday(day), {
    parse_mode: "HTML",
    ...childKeyboard(day),
  });
  await ctx.answerCbQuery();
});

bot.action(ACTION_SUMMARY, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате взрослые команды недоступны.");
    return;
  }

  const summary = withState((state) => renderAllSummaries(state));
  await ctx.editMessageText(
    summary,
    Markup.inlineKeyboard([[Markup.button.callback("Обновить сводку", ACTION_SUMMARY)]]),
  );
  await ctx.answerCbQuery();
});

bot.action(ACTION_SKIP_PROOF, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  withState((state) => {
    const profile = ensureChildProfile(state, chatId);
    delete profile.pendingProofTask;
  });

  await ctx.reply("Окей, без фото. Статус по задаче уже сохранен.");
  await ctx.answerCbQuery();
});

bot.action(ACTION_TOO_HARD, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  const result = withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
    const profile = ensureChildProfile(state, chatId);
    const day = ensureDay(profile);
    day.tooHard = true;
    day.updatedAt = nowIso();
    return { day, summary: renderChildSummary(chatId, profile, day) };
  });

  await ctx.editMessageText(renderToday(result.day), {
    parse_mode: "HTML",
    ...childKeyboard(result.day),
  });
  await ctx.answerCbQuery("Сигнал записан.");

  await notifyParents(`Отмечено: сегодня было слишком тяжело.\n\n${result.summary}`);
});

bot.action(new RegExp(`^${TASK_PREFIX}`), async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
  const task = data.slice(TASK_PREFIX.length);

  const result = withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
    const profile = ensureChildProfile(state, chatId);
    const day = ensureDay(profile);

    if (!(task in day.tasks)) {
      return { error: "unknown_task" as const, day };
    }

    day.tasks[task] = !day.tasks[task];
    if (!day.tasks[task]) {
      day.proofs[task] = undefined;
      delete profile.pendingProofTask;
    } else {
      profile.pendingProofTask = task;
    }

    day.updatedAt = nowIso();
    if (isAllDone(day)) {
      day.completedAt = nowIso();
    } else {
      day.completedAt = undefined;
      day.completionNotifiedAt = undefined;
    }

    return { day, task, turnedOn: day.tasks[task] };
  });

  if ("error" in result) {
    await ctx.answerCbQuery("Не удалось найти эту задачу.");
    return;
  }

  await ctx.editMessageText(renderToday(result.day), {
    parse_mode: "HTML",
    ...childKeyboard(result.day),
  });

  if (result.turnedOn) {
    await ctx.reply(
      `Если хочешь, пришли фото как пруф для задачи: "${result.task}". Это необязательно, но удобно для прозрачности.`,
      Markup.inlineKeyboard([[Markup.button.callback("Без фото", ACTION_SKIP_PROOF)]]),
    );
  }

  await ctx.answerCbQuery("Статус обновлен.");
  await notifyParentsIfReady(chatId);
});

bot.action(new RegExp(`^${MOOD_PREFIX}`), async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
  const mood = data.slice(MOOD_PREFIX.length) as Mood;
  const allowedMoods: Mood[] = ["easy", "ok", "hard"];

  if (!allowedMoods.includes(mood)) {
    await ctx.answerCbQuery("Неизвестное настроение.");
    return;
  }

  const result = withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
    const profile = ensureChildProfile(state, chatId);
    const day = ensureDay(profile);
    day.mood = mood;
    day.updatedAt = nowIso();
    return { day, summary: renderChildSummary(chatId, profile, day) };
  });

  await ctx.editMessageText(renderToday(result.day), {
    parse_mode: "HTML",
    ...childKeyboard(result.day),
  });
  await ctx.answerCbQuery("Настроение сохранено.");

  if (mood === "hard") {
    await notifyParents(`Отмечено настроение: тяжело.\n\n${result.summary}`);
  }
});

bot.on("photo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (isParentChat(chatId)) {
    return;
  }

  const photo = ctx.message.photo.at(-1);
  if (!photo) {
    return;
  }

  const result = withState((state) => {
    rememberDisplayName(state, chatId, ctx.from?.first_name);
    const profile = ensureChildProfile(state, chatId);
    const pendingTask = profile.pendingProofTask;
    if (!pendingTask) {
      return { pendingTask: undefined };
    }

    const day = ensureDay(profile);
    day.proofs[pendingTask] = { receivedAt: nowIso() };
    day.updatedAt = nowIso();
    delete profile.pendingProofTask;

    return {
      pendingTask,
      summary: renderChildSummary(chatId, profile, day),
    };
  });

  if (!result.pendingTask) {
    await ctx.reply("Фото получил, но сейчас нет задачи, к которой его привязать. Сначала отметь задачу кнопкой.");
    return;
  }

  await ctx.reply(`Пруф для задачи "${result.pendingTask}" сохранен.`);

  for (const parentChatId of config.parentChatIds) {
    await bot.telegram.forwardMessage(parentChatId, ctx.chat.id, ctx.message.message_id);
    await bot.telegram.sendMessage(
      parentChatId,
      `Поступил пруф по задаче: ${result.pendingTask}\n\n${result.summary}`,
    );
  }
});

function scheduleJobs() {
  cron.schedule(
    config.morningCron,
    async () => {
      const state = loadState();
      for (const chatId of Object.keys(state.childProfiles)) {
        await sendToday(chatId);
      }
    },
    { timezone: config.timezone },
  );

  cron.schedule(
    config.eveningCron,
    async () => {
      for (const parentChatId of config.parentChatIds) {
        await sendParentSummary(parentChatId);
      }
    },
    { timezone: config.timezone },
  );
}

bot.catch((error) => {
  console.error("Bot error:", error);
});

async function main() {
  scheduleJobs();
  await bot.launch();
  console.log("KidViewer bot is running.");
}

main();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
