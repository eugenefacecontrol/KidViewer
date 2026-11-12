import cron from "node-cron";
import { Context, Markup, Telegraf, TelegramError } from "telegraf";
import { config } from "./config";
import { AppState, ChildProfile, DayState, Mood, loadState, saveState } from "./storage";

const bot = new Telegraf(config.botToken);

const TASK_PREFIX = "task:";
const MOOD_PREFIX = "mood:";
const ACTION_TODAY = "action:today";
const ACTION_TOO_HARD = "action:too_hard";
const ACTION_SUMMARY = "action:summary";
const ACTION_SKIP_PROOF = "action:skip_proof";
const TEST_TASK_PREFIX = "test:task:";
const TEST_MOOD_PREFIX = "test:mood:";
const ACTION_TEST_TODAY = "test:action:today";
const ACTION_TEST_TOO_HARD = "test:action:too_hard";
const ACTION_TEST_SKIP_PROOF = "test:action:skip_proof";
const SUMMARY_SEPARATOR = "\n\n--------------------\n\n";

const BUTTON_TODAY = "📋 Сегодня";
const BUTTON_SUMMARY = "📊 Сводка";
const BUTTON_CHILDREN = "👧 Дети";
const BUTTON_TEST_CHILD = "🧪 Детский тест";
const BUTTON_SET_TODAY = "📝 Задать задачи";

const LEGACY_DEFAULT_TASKS = [
  "Почистить зубы",
  "20 минут математики",
  "Покормить животных",
];

const testChildProfiles = new Map<string, ChildProfile>();

const childCommands = [
  { command: "start", description: "Открыть главное меню" },
  { command: "today", description: "Показать задачи на сегодня" },
];

const parentCommands = [
  { command: "start", description: "Открыть главное меню" },
  { command: "summary", description: "Сводка за сегодня" },
  { command: "children", description: "Список детских профилей" },
  { command: "settoday", description: "Задать задачи ребенку" },
  { command: "testchild", description: "Проверить детский режим" },
];

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

function parentMenu() {
  return Markup.keyboard([
    [BUTTON_SUMMARY, BUTTON_CHILDREN],
    [BUTTON_TEST_CHILD, BUTTON_SET_TODAY],
  ]).resize();
}

function childMenu() {
  return Markup.keyboard([[BUTTON_TODAY]]).resize();
}

function createTestChildProfile(): ChildProfile {
  return { displayName: "Тестовый ребенок", days: {} };
}

function getTestChildProfile(parentChatId: string): ChildProfile {
  const profile = testChildProfiles.get(parentChatId) ?? createTestChildProfile();
  testChildProfiles.set(parentChatId, profile);
  return profile;
}

function resetTestChildProfile(parentChatId: string): ChildProfile {
  const profile = createTestChildProfile();
  testChildProfiles.set(parentChatId, profile);
  return profile;
}

function isMessageNotModified(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    error.response.error_code === 400 &&
    error.response.description.includes("message is not modified")
  );
}

async function editMessageIfChanged(edit: () => Promise<unknown>): Promise<boolean> {
  try {
    await edit();
    return true;
  } catch (error) {
    if (isMessageNotModified(error)) {
      return false;
    }
    throw error;
  }
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
      .map((line) => line.replace(/^\s*(?:[-*•]|⬜️?|✅)\s*/, "").trim())
      .filter(Boolean),
  );
}

function sameTaskList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((task, index) => task === right[index]);
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

  if (
    sameTaskList(profile.days[date].taskOrder, LEGACY_DEFAULT_TASKS) &&
    !sameTaskList(config.tasks, LEGACY_DEFAULT_TASKS)
  ) {
    profile.days[date].taskOrder = [...config.tasks];
    profile.days[date].tasks = taskMap();
    profile.days[date].proofs = proofMap();
    profile.days[date].completedAt = undefined;
    profile.days[date].completionNotifiedAt = undefined;
    profile.days[date].updatedAt = nowIso();
    delete profile.pendingProofTask;
  }

  for (const task of getDayTasks(profile.days[date])) {
    if (!(task in profile.days[date].tasks)) {
      profile.days[date].tasks[task] = false;
    }
    if (!(task in profile.days[date].proofs)) {
      profile.days[date].proofs[task] = undefined;
    }
    if (profile.days[date].tasks[task] && !profile.days[date].proofs[task]) {
      profile.days[date].tasks[task] = false;
      profile.days[date].completedAt = undefined;
      profile.days[date].completionNotifiedAt = undefined;
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
  const done = tasks.filter((task) => day.tasks[task] && day.proofs[task]).length;
  return { done, total: tasks.length };
}

function isAllDone(day: DayState) {
  const tasks = getDayTasks(day);
  return tasks.length > 0 && tasks.every((task) => day.tasks[task] && day.proofs[task]);
}

function taskLabel(day: DayState, task: string) {
  const done = day.tasks[task] && day.proofs[task] ? "✅" : "⬜️";
  const proof = day.proofs[task] ? "📷" : "";
  return `${done}${proof ? ` ${proof}` : ""} ${task}`;
}

function childKeyboard(day: DayState, testMode = false) {
  const taskPrefix = testMode ? TEST_TASK_PREFIX : TASK_PREFIX;
  const moodPrefix = testMode ? TEST_MOOD_PREFIX : MOOD_PREFIX;
  const tooHardAction = testMode ? ACTION_TEST_TOO_HARD : ACTION_TOO_HARD;
  const todayAction = testMode ? ACTION_TEST_TODAY : ACTION_TODAY;
  const taskButtons = getDayTasks(day).map((task) => [
    Markup.button.callback(taskLabel(day, task), `${taskPrefix}${task}`),
  ]);

  return Markup.inlineKeyboard([
    ...taskButtons,
    [
      Markup.button.callback("😊 Легко", `${moodPrefix}easy`),
      Markup.button.callback("😐 Нормально", `${moodPrefix}ok`),
      Markup.button.callback("😞 Тяжело", `${moodPrefix}hard`),
    ],
    [Markup.button.callback("Сегодня было слишком тяжело", tooHardAction)],
    [Markup.button.callback("Обновить статус", todayAction)],
  ]);
}

function renderToday(day: DayState, testMode = false) {
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
    testMode ? "<b>🧪 Тестовый детский режим</b>" : undefined,
    testMode ? "Данные не сохраняются и уведомления не отправляются.\n" : undefined,
    "<b>План на сегодня</b>",
    `Прогресс: ${done}/${total}`,
    "Задача засчитывается только после фото.",
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
    try {
      await bot.telegram.sendMessage(parentChatId, text);
    } catch (error) {
      console.error(`Failed to notify parent chat ${parentChatId}:`, error);
    }
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

async function showToday(ctx: Context) {
  const chatId = String(ctx.chat?.id ?? "");
  if (!chatId) {
    return;
  }
  if (isParentChat(chatId)) {
    await ctx.reply("Для проверки детского экрана используй /testchild.", parentMenu());
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
}

async function showParentSummary(ctx: Context) {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  const summary = withState((state) => renderAllSummaries(state));
  await ctx.reply(
    summary,
    Markup.inlineKeyboard([[Markup.button.callback("Обновить сводку", ACTION_SUMMARY)]]),
  );
}

async function showChildren(ctx: Context) {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  const children = withState((state) => renderChildrenList(state));
  await ctx.reply(children);
}

async function showTestChild(ctx: Context) {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.reply("Тестовый детский режим доступен только родителям.");
    return;
  }

  const profile = resetTestChildProfile(chatId);
  const day = ensureDay(profile);
  await ctx.reply(renderToday(day, true), {
    parse_mode: "HTML",
    ...childKeyboard(day, true),
  });
}

async function showSetTodayHelp(ctx: Context) {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.reply("В этом чате взрослые команды недоступны.");
    return;
  }

  await ctx.reply(
    [
      "Отправь сообщение в таком формате:",
      "",
      "/settoday <child_chat_id>",
      "Задача 1",
      "Задача 2",
      "Задача 3",
      "",
      "Идентификаторы детей можно посмотреть кнопкой «👧 Дети».",
    ].join("\n"),
  );
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
        "/testchild - безопасно проверить детский режим",
      ].join("\n"),
      parentMenu(),
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
    childMenu(),
  );
});

bot.command("today", showToday);
bot.command("summary", showParentSummary);
bot.command("children", showChildren);
bot.command("testchild", showTestChild);

bot.hears(BUTTON_TODAY, showToday);
bot.hears(BUTTON_SUMMARY, showParentSummary);
bot.hears(BUTTON_CHILDREN, showChildren);
bot.hears(BUTTON_TEST_CHILD, showTestChild);
bot.hears(BUTTON_SET_TODAY, showSetTodayHelp);

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
  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(day), {
      parse_mode: "HTML",
      ...childKeyboard(day),
    }),
  );
  await ctx.answerCbQuery(changed ? "Статус обновлен." : "Статус уже актуален.");
});

bot.action(ACTION_SUMMARY, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате взрослые команды недоступны.");
    return;
  }

  const summary = withState((state) => renderAllSummaries(state));
  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(
      summary,
      Markup.inlineKeyboard([[Markup.button.callback("Обновить сводку", ACTION_SUMMARY)]]),
    ),
  );
  await ctx.answerCbQuery(changed ? "Сводка обновлена." : "Сводка уже актуальна.");
});

bot.action(ACTION_TEST_TODAY, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("Тестовый режим доступен только родителям.");
    return;
  }

  const day = ensureDay(getTestChildProfile(chatId));
  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(day, true), {
      parse_mode: "HTML",
      ...childKeyboard(day, true),
    }),
  );
  await ctx.answerCbQuery(
    changed ? "Тестовый статус обновлен." : "Тестовый статус уже актуален.",
  );
});

bot.action(ACTION_TEST_SKIP_PROOF, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("Тестовый режим доступен только родителям.");
    return;
  }

  await ctx.answerCbQuery("Теперь фото обязательно.");
  await ctx.reply("Тест: без фотографии задача не будет отмечена выполненной.");
});

bot.action(ACTION_TEST_TOO_HARD, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("Тестовый режим доступен только родителям.");
    return;
  }

  const profile = getTestChildProfile(chatId);
  const day = ensureDay(profile);
  day.tooHard = true;
  day.updatedAt = nowIso();

  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(day, true), {
      parse_mode: "HTML",
      ...childKeyboard(day, true),
    }),
  );
  await ctx.answerCbQuery(
    changed
      ? "Тест: сигнал записан, уведомления не отправлены."
      : "Тестовый сигнал уже записан.",
  );
});

bot.action(new RegExp(`^${TEST_TASK_PREFIX}`), async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("Тестовый режим доступен только родителям.");
    return;
  }

  const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
  const task = data.slice(TEST_TASK_PREFIX.length);
  const profile = getTestChildProfile(chatId);
  const day = ensureDay(profile);

  if (!(task in day.tasks)) {
    await ctx.answerCbQuery("Не удалось найти тестовую задачу.");
    return;
  }

  const wasCompleted = Boolean(day.tasks[task] && day.proofs[task]);
  if (wasCompleted) {
    day.tasks[task] = false;
    day.proofs[task] = undefined;
    delete profile.pendingProofTask;
  } else {
    day.tasks[task] = false;
    day.proofs[task] = undefined;
    profile.pendingProofTask = task;
  }
  day.updatedAt = nowIso();
  day.completedAt = undefined;
  day.completionNotifiedAt = undefined;

  if (wasCompleted) {
    await ctx.editMessageText(renderToday(day, true), {
      parse_mode: "HTML",
      ...childKeyboard(day, true),
    });
    await ctx.answerCbQuery("Тест: отметка снята.");
  } else {
    await ctx.answerCbQuery("Тест: теперь пришли фотографию.");
    await ctx.reply(
      `Тест: пришли фотографию для задачи «${task}». Только после фото она станет выполненной.`,
    );
  }
});

bot.action(new RegExp(`^${TEST_MOOD_PREFIX}`), async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isParentChat(chatId)) {
    await ctx.answerCbQuery("Тестовый режим доступен только родителям.");
    return;
  }

  const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
  const mood = data.slice(TEST_MOOD_PREFIX.length) as Mood;
  const allowedMoods: Mood[] = ["easy", "ok", "hard"];
  if (!allowedMoods.includes(mood)) {
    await ctx.answerCbQuery("Неизвестное настроение.");
    return;
  }

  const day = ensureDay(getTestChildProfile(chatId));
  day.mood = mood;
  day.updatedAt = nowIso();

  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(day, true), {
      parse_mode: "HTML",
      ...childKeyboard(day, true),
    }),
  );
  await ctx.answerCbQuery(
    changed
      ? "Тест: настроение сохранено, уведомления не отправлены."
      : "Тестовое настроение уже выбрано.",
  );
});

bot.action(ACTION_SKIP_PROOF, async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (isParentChat(chatId)) {
    await ctx.answerCbQuery("В этом чате нет детского режима.");
    return;
  }

  await ctx.answerCbQuery("Теперь фото обязательно.");
  await ctx.reply("Без фотографии задача не будет отмечена выполненной.");
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

  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(result.day), {
      parse_mode: "HTML",
      ...childKeyboard(result.day),
    }),
  );
  await ctx.answerCbQuery(changed ? "Сигнал записан." : "Сигнал уже записан.");

  if (changed) {
    await notifyParents(`Отмечено: сегодня было слишком тяжело.\n\n${result.summary}`);
  }
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

    const wasCompleted = Boolean(day.tasks[task] && day.proofs[task]);
    const wasAlreadyPending = !wasCompleted && profile.pendingProofTask === task;
    if (wasAlreadyPending) {
      return {
        day,
        task,
        wasCompleted,
        wasAlreadyPending,
        summary: renderChildSummary(chatId, profile, day),
      };
    }

    if (wasCompleted) {
      day.tasks[task] = false;
      day.proofs[task] = undefined;
      delete profile.pendingProofTask;
    } else {
      day.tasks[task] = false;
      day.proofs[task] = undefined;
      profile.pendingProofTask = task;
    }

    day.updatedAt = nowIso();
    day.completedAt = undefined;
    day.completionNotifiedAt = undefined;

    return {
      day,
      task,
      wasCompleted,
      wasAlreadyPending,
      summary: renderChildSummary(chatId, profile, day),
    };
  });

  if ("error" in result) {
    await ctx.answerCbQuery("Не удалось найти эту задачу.");
    return;
  }

  if (result.wasAlreadyPending) {
    await ctx.answerCbQuery("Для этой задачи всё ещё ждём фотографию.");
    return;
  }

  if (result.wasCompleted) {
    await ctx.editMessageText(renderToday(result.day), {
      parse_mode: "HTML",
      ...childKeyboard(result.day),
    });
    await ctx.answerCbQuery("Отметка снята.");
    await notifyParents(`Ребенок снял выполнение задачи «${result.task}».\n\n${result.summary}`);
  } else {
    await ctx.answerCbQuery("Теперь пришли фотографию.");
    await ctx.reply(
      `Пришли фотографию для задачи «${result.task}». Только после фото она станет выполненной.`,
    );
    await notifyParents(
      `Ребенок выбрал задачу «${result.task}». Ожидается обязательное фото.\n\n${result.summary}`,
    );
  }
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

  const changed = await editMessageIfChanged(() =>
    ctx.editMessageText(renderToday(result.day), {
      parse_mode: "HTML",
      ...childKeyboard(result.day),
    }),
  );
  await ctx.answerCbQuery(changed ? "Настроение сохранено." : "Это настроение уже выбрано.");

  if (changed) {
    const moodLabel =
      mood === "easy" ? "😊 Легко" : mood === "ok" ? "😐 Нормально" : "😞 Тяжело";
    await notifyParents(`Ребенок отметил настроение: ${moodLabel}.\n\n${result.summary}`);
  }
});

bot.on("photo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (isParentChat(chatId)) {
    const profile = testChildProfiles.get(chatId);
    const pendingTask = profile?.pendingProofTask;
    if (!profile || !pendingTask) {
      return;
    }

    const day = ensureDay(profile);
    day.tasks[pendingTask] = true;
    day.proofs[pendingTask] = { receivedAt: nowIso() };
    day.updatedAt = nowIso();
    day.completedAt = isAllDone(day) ? nowIso() : undefined;
    delete profile.pendingProofTask;

    await ctx.reply(
      `Тест: фото принято, задача «${pendingTask}» отмечена выполненной. Фото не сохранено в реальном профиле и не переслано.`,
    );
    await ctx.reply(renderToday(day, true), {
      parse_mode: "HTML",
      ...childKeyboard(day, true),
    });
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
    day.tasks[pendingTask] = true;
    day.proofs[pendingTask] = { receivedAt: nowIso() };
    day.updatedAt = nowIso();
    day.completedAt = isAllDone(day) ? nowIso() : undefined;
    delete profile.pendingProofTask;

    return {
      pendingTask,
      day,
      summary: renderChildSummary(chatId, profile, day),
    };
  });

  if (!result.pendingTask) {
    await ctx.reply("Фото получил, но сейчас нет задачи, к которой его привязать. Сначала отметь задачу кнопкой.");
    return;
  }

  await ctx.reply(
    `Фото принято. Задача «${escapeHtml(result.pendingTask)}» отмечена выполненной.\n\n${renderToday(result.day)}`,
    {
      parse_mode: "HTML",
      ...childKeyboard(result.day),
    },
  );

  for (const parentChatId of config.parentChatIds) {
    try {
      await bot.telegram.forwardMessage(parentChatId, ctx.chat.id, ctx.message.message_id);
      await bot.telegram.sendMessage(
        parentChatId,
        `Поступил пруф по задаче: ${result.pendingTask}\n\n${result.summary}`,
      );
    } catch (error) {
      console.error(`Failed to deliver proof to parent chat ${parentChatId}:`, error);
    }
  }

  await notifyParentsIfReady(chatId);
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

async function configureCommandMenus() {
  try {
    await bot.telegram.setMyCommands(childCommands, {
      scope: { type: "all_private_chats" },
    });
  } catch (error) {
    console.error("Failed to configure the default command menu:", error);
  }

  for (const parentChatId of config.parentChatIds) {
    try {
      await bot.telegram.setMyCommands(parentCommands, {
        scope: { type: "chat", chat_id: parentChatId },
      });
    } catch (error) {
      console.error(`Failed to configure the parent command menu for ${parentChatId}:`, error);
    }
  }
}

bot.catch((error) => {
  console.error("Bot error:", error);
});

async function main() {
  await configureCommandMenus();
  scheduleJobs();
  await bot.launch();
  console.log("KidViewer bot is running.");
}

main();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
