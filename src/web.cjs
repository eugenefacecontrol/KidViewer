const { createServer } = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const {
  WEB_ADMIN_USER = 'admin',
  WEB_ADMIN_PASSWORD,
  WEB_PORT = '8080',
  WEB_SECURE_COOKIES = 'true',
  TIMEZONE = 'Europe/Warsaw',
} = process.env;

if (!WEB_ADMIN_PASSWORD || WEB_ADMIN_PASSWORD.length < 12) {
  throw new Error('Укажите WEB_ADMIN_PASSWORD (от 12 символов) по инструкции в README.');
}

const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const today = () => dateFormat.format(new Date());
const hash = (value) => createHash('sha256').update(value).digest();
const matches = (left, right) => timingSafeEqual(hash(left), hash(right));
const sessions = new Map();
const sessionAge = 8 * 60 * 60;
const cookieFlags = '; Path=/; HttpOnly; SameSite=Strict' +
  (WEB_SECURE_COOKIES === 'false' ? '' : '; Secure');
const maxPhotoBytes = 8 * 1024 * 1024;
const maxPhotos = 10;
const maxTotalPhotoBytes = 32 * 1024 * 1024;

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/web.sqlite');
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    title TEXT NOT NULL,
    min_score INTEGER,
    needs_photo INTEGER NOT NULL,
    submitted_at TEXT,
    score INTEGER,
    photo BLOB,
    photo_type TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS tasks_by_day ON tasks(day);
  CREATE TABLE IF NOT EXISTS task_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), last_id INTEGER NOT NULL);
  INSERT OR IGNORE INTO task_sequence SELECT 1, COALESCE(MAX(id), 0) FROM tasks;
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_day TEXT NOT NULL,
    title TEXT NOT NULL,
    min_score INTEGER,
    needs_photo INTEGER NOT NULL,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
    ends_before TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS occurrences (
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    day TEXT NOT NULL,
    task_id INTEGER UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
    PRIMARY KEY (schedule_id, day)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS occurrences_by_day ON occurrences(day);
  CREATE TABLE IF NOT EXISTS task_photos (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    photo BLOB NOT NULL,
    photo_type TEXT NOT NULL,
    PRIMARY KEY (task_id, position)
  ) STRICT;
`);

const seedSchedule = db.prepare(`
  INSERT OR IGNORE INTO schedules(id, start_day, title, needs_photo, frequency) VALUES (?, ?, ?, ?, 'daily')
`);
const firstDay = today();
seedSchedule.run(-3, firstDay, 'Почистить зубы утром', 0);
seedSchedule.run(-2, firstDay, 'Покормить животных', 1);
seedSchedule.run(-1, firstDay, '30 минут занятий', 1);

const listTasks = db.prepare(`
  SELECT tasks.id, title, min_score, needs_photo, submitted_at, score, photo_type, schedule_id
  FROM tasks LEFT JOIN occurrences ON occurrences.task_id = tasks.id
  WHERE tasks.day = ? ORDER BY CASE WHEN schedule_id < 0 THEN schedule_id ELSE 0 END, tasks.id
`);
const getTask = db.prepare(`
  SELECT tasks.day, min_score, needs_photo, submitted_at, score, photo_type, schedule_id
  FROM tasks LEFT JOIN occurrences ON occurrences.task_id = tasks.id WHERE tasks.id = ?
`);
const addTask = db.prepare('INSERT INTO tasks(id, day, title, min_score, needs_photo) VALUES (?, ?, ?, ?, ?)');
const nextTaskId = db.prepare('UPDATE task_sequence SET last_id = last_id + 1 WHERE id = 1 RETURNING last_id');
const editTask = db.prepare('UPDATE tasks SET day = ?, title = ?, min_score = ?, needs_photo = ? WHERE id = ?');
const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const resetTask = db.prepare(`
  UPDATE tasks SET submitted_at = NULL, score = NULL, photo = NULL, photo_type = NULL
  WHERE id = ? AND submitted_at = ?
`);
const submitTask = db.prepare(`
  UPDATE tasks SET submitted_at = ?, score = ?, photo = COALESCE(?, photo), photo_type = COALESCE(?, photo_type)
  WHERE id = ?
`);
const getPhoto = db.prepare('SELECT photo, photo_type FROM tasks WHERE id = ?');
const getExtraPhoto = db.prepare('SELECT photo, photo_type FROM task_photos WHERE task_id = ? AND position = ?');
const listExtraPhotos = db.prepare('SELECT position FROM task_photos WHERE task_id = ? ORDER BY position');
const addExtraPhoto = db.prepare('INSERT INTO task_photos(task_id, position, photo, photo_type) VALUES (?, ?, ?, ?)');
const clearExtraPhotos = db.prepare('DELETE FROM task_photos WHERE task_id = ?');
const listSchedules = db.prepare('SELECT * FROM schedules WHERE start_day <= ? AND (ends_before IS NULL OR ends_before > ?) ORDER BY id');
const activeSchedules = db.prepare('SELECT * FROM schedules WHERE id > 0 AND ends_before IS NULL ORDER BY start_day, id');
const addSchedule = db.prepare('INSERT INTO schedules(start_day, title, min_score, needs_photo, frequency) VALUES (?, ?, ?, ?, ?)');
const stopSchedule = db.prepare('UPDATE schedules SET ends_before = ? WHERE id = ? AND id > 0 AND ends_before IS NULL');
const removeUpcomingTasks = db.prepare(`
  DELETE FROM tasks WHERE submitted_at IS NULL AND day >= ? AND id IN (
    SELECT task_id FROM occurrences WHERE schedule_id = ?
  )
`);
const listOccurrences = db.prepare('SELECT schedule_id, day FROM occurrences WHERE day BETWEEN ? AND ?');
const addOccurrence = db.prepare('INSERT INTO occurrences(schedule_id, day, task_id) VALUES (?, ?, ?)');
const countTasksByDay = db.prepare('SELECT day, COUNT(*) AS count FROM tasks WHERE day BETWEEN ? AND ? GROUP BY day');

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function weekday(day) {
  return new Date(day).getUTCDay();
}

function scheduledOn(schedule, day) {
  return day >= schedule.start_day && (!schedule.ends_before || day < schedule.ends_before) &&
    (schedule.frequency === 'daily' || weekday(schedule.start_day) === weekday(day));
}

function ensureTasksForDay(day) {
  const missing = () => {
    const existing = new Set(listOccurrences.all(day, day).map(({ schedule_id }) => schedule_id));
    return listSchedules.all(day, day).filter((schedule) => !existing.has(schedule.id) && scheduledOn(schedule, day));
  };
  if (!missing().length) return;
  transaction(() => {
    for (const schedule of missing()) {
      const id = nextTaskId.get().last_id;
      addTask.run(id, day, schedule.title, schedule.min_score, schedule.needs_photo);
      addOccurrence.run(schedule.id, day, id);
    }
  });
}

const html = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const validDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
};
const field = (form, name) => String(form.get(name) ?? '').trim();
const readScore = (value) => /^(?:[0-9]{1,2}|100)$/.test(value) ? Number(value) : null;
const monthFormat = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function shiftMonth(start, offset) {
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

function calendar(day, currentDay) {
  const start = day.slice(0, 7) + '-01';
  const date = new Date(start);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const last = end.toISOString().slice(0, 10);
  const schedules = listSchedules.all(last, start);
  const occurrences = new Set(listOccurrences.all(start, last).map((row) => row.schedule_id + ':' + row.day));
  const counts = new Map(countTasksByDay.all(start, last).map((row) => [row.day, row.count]));
  const cells = Array.from({ length: end.getUTCDate() }, (_, index) => {
    const dateKey = start.slice(0, 8) + String(index + 1).padStart(2, '0');
    const count = (counts.get(dateKey) || 0) + schedules.filter((schedule) =>
      scheduledOn(schedule, dateKey) && !occurrences.has(schedule.id + ':' + dateKey)).length;
    return `<a class="calendar-day${dateKey === currentDay ? ' today' : ''}" href="/admin?day=${dateKey}"
      aria-label="${dayFormat.format(new Date(dateKey))}, задач: ${count}" ${dateKey === day ? 'aria-current="date"' : ''}>
      ${index + 1}${count ? `<span aria-hidden="true">${count}</span>` : ''}</a>`;
  });
  const previous = shiftMonth(start, -1);
  const next = shiftMonth(start, 1);
  return `<section class="panel" aria-label="Календарь задач">
    <div class="calendar-header">
      ${validDay(previous) ? `<a href="/admin?day=${previous}" aria-label="Предыдущий месяц">←</a>` : '<span></span>'}
      <h2>${monthFormat.format(date)}</h2>
      ${validDay(next) ? `<a href="/admin?day=${next}" aria-label="Следующий месяц">→</a>` : '<span></span>'}
    </div>
    <div class="calendar-grid">
      ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label) => `<small>${label}</small>`).join('')}
      ${'<span></span>'.repeat((weekday(start) + 6) % 7)}${cells.join('')}
    </div>
    <p><a href="/admin?day=${currentDay}">Сегодня</a></p>
  </section>`;
}

function scheduleList(day) {
  const schedules = activeSchedules.all();
  if (!schedules.length) return '';
  return `<details class="panel"><summary>Повторяющиеся задачи</summary>
    ${schedules.map((schedule) => `<div class="task-actions">
      <p><strong>${html(schedule.title)}</strong><br>${schedule.frequency === 'daily' ? 'Ежедневно' : 'Еженедельно'} · с ${dayFormat.format(new Date(schedule.start_day))}</p>
      <details><summary>Остановить повторение</summary>
        <form method="post" action="/schedules/${schedule.id}/stop">
          <input type="hidden" name="day" value="${day}">
          <p>Сегодняшние и будущие задачи этой серии без отправленного результата будут убраны. История сохранится.</p>
          <button>Остановить</button>
        </form>
      </details>
    </div>`).join('')}
  </details>`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)} · KidViewer</title><style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5ef;color:#17251c;font:16px/1.55 system-ui,sans-serif}
main{max-width:640px;margin:auto;padding:32px 18px 60px}
nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px}
a{color:#205c40}h1{font-size:clamp(1.8rem,7vw,3rem);line-height:1.1;margin:0 0 18px}
h2{font-size:1.12rem;margin:0;overflow-wrap:anywhere}
article,.panel{background:#fff;border:1px solid #dce5db;border-radius:16px;padding:18px;margin:12px 0}
p{margin:8px 0 12px}label{display:block;margin:12px 0}
input,button{font:inherit}input:not([type=checkbox]){display:block;width:100%;min-width:0;padding:8px;border:1px solid #9ba99f;border-radius:8px;background:#fff}
button{background:#205c40;color:#fff;border:0;border-radius:9px;padding:9px 16px;cursor:pointer}
small{display:block;color:#495d50}img{display:block;max-width:100%;max-height:300px;margin-top:10px;border-radius:8px}
.child-task{padding:0;box-shadow:0 4px 12px #17251c0a;scroll-margin:20px}
.task-heading{display:flex;align-items:center;gap:14px;padding:16px}
.task-heading p{margin:2px 0 0;color:#495d50;font-size:.9rem}
.task-check{width:44px;height:44px;flex:none;display:grid;place-items:center;padding:0;border:2px solid #6b8e78;border-radius:14px;background:#f3f8f3;color:#205c40;font-size:1.5rem}
button.task-check:hover{background:#dff0e4;border-color:#205c40}
.task-check[aria-checked=true]{background:#205c40;color:#fff;border-color:#205c40}
.child-task.done{background:#eaf6ed;border-color:#b8d9c1}
.child-task.done:target .task-check{animation:check-in .45s ease-out both}
@keyframes check-in{0%{transform:scale(.6) rotate(-14deg)}55%{transform:scale(1.18) rotate(4deg)}100%{transform:scale(1)}}
@media(prefers-reduced-motion:reduce){.child-task.done:target .task-check{animation:none}}
.task-fields{padding:0 16px 16px}
summary{color:#205c40;cursor:pointer;overflow-wrap:anywhere}
:is(button,summary,a):focus-visible{outline:3px solid #347758;outline-offset:3px}
.task-actions{display:grid;gap:10px;margin-top:14px}
.task-actions details{border-top:1px solid #dce5db;padding-top:10px}
.danger{background:#8c312d}
select{font:inherit;display:block;width:100%;padding:8px;border:1px solid #9ba99f;border-radius:8px;background:#fff;color:inherit}
.calendar-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;text-align:center}
.calendar-header h2:first-letter{text-transform:uppercase}
.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;text-align:center}
.calendar-grid small{font-size:.76rem}
.calendar-day{min-height:44px;display:grid;align-content:center;border-radius:8px;background:#f3f5ef;text-decoration:none;line-height:1.2}
.calendar-day:hover{background:#dff0e4}
.calendar-day.today{box-shadow:inset 0 0 0 2px #6b8e78}
.calendar-day[aria-current=date]{background:#205c40;color:#fff}
.calendar-day span{font-size:.72rem}
.photo-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px}
.photo-gallery img{width:100%;aspect-ratio:1;object-fit:cover;margin-top:0}
</style><main>${body}</main></html>`;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res, location, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.writeHead(303, { Location: location });
  res.end();
}

function errorPage(res, status, message, back = '/') {
  send(res, status, page('KidViewer', `<h1>${html(message)}</h1><a href="${html(back)}">Вернуться</a>`));
}

function isDone(task) {
  return Boolean(task.submitted_at &&
    (task.min_score === null || (task.score !== null && task.score >= task.min_score)) &&
    (!task.needs_photo || task.photo_type));
}

function taskFields(day, task = {}) {
  return `<label>Дата<input name="day" type="date" value="${day}" required></label>
    <label>Что нужно сделать<input name="title" value="${html(task.title ?? '')}" maxlength="200" required></label>
    <label>Минимальный результат, %<input name="min_score" type="number" min="0" max="100" value="${task.min_score ?? ''}" placeholder="По желанию"></label>
    <label><input name="needs_photo" type="checkbox" ${task.needs_photo ? 'checked' : ''}> Требовать фото</label>`;
}

function resetForm(task, action) {
  return `<details><summary>Вернуть в невыполненные</summary>
    <form method="post" action="${action}">
      <input type="hidden" name="submitted_at" value="${html(task.submitted_at)}">
      <p>${task.score !== null || task.photo_type
        ? 'Сохранённый результат будет удалён. Задачу можно будет выполнить заново.'
        : 'Отметка о выполнении будет снята.'}</p>
      <button>Снять отметку</button>
    </form>
  </details>`;
}

function taskCard(task, day, admin) {
  const done = isDone(task);
  const status = done ? 'Выполнено' : task.submitted_at ? 'Нужно повторить' : 'К выполнению';
  const title = html(task.title);
  const result = `${status}${task.score === null ? '' : ` · ${task.score}%`}`;
  const minimum = task.min_score === null ? '' : `<small>Минимум ${task.min_score}%</small>`;
  if (admin) {
    const photos = task.photo_type ? [`/photo/${task.id}`, ...listExtraPhotos.all(task.id).map(({ position }) => `/photo/${task.id}/${position}`)] : [];
    return `<article><h2>${title}</h2><p>${result}</p>${minimum}
      ${task.schedule_id < 0 ? '<small>Обязательная ежедневная задача</small>' : ''}
      ${photos.length ? `<div class="photo-gallery">${photos.map((url, index) => `<a href="${url}"><img src="${url}" alt="Фото выполнения ${index + 1}" loading="lazy"></a>`).join('')}</div>` : ''}
      <div class="task-actions">
        ${task.schedule_id < 0 ? '' : `<details><summary>Редактировать</summary>
          <form method="post" action="/tasks/${task.id}/edit">${taskFields(day, task)}<button>Сохранить</button></form>
        </details>`}
        ${task.submitted_at ? resetForm(task, `/tasks/${task.id}/reset`) : ''}
        ${task.schedule_id < 0 ? '' : `<details><summary>Удалить</summary>
          <form method="post" action="/tasks/${task.id}/delete">
            <p>Удалить «${title}» на эту дату вместе с результатом и фото?</p>
            <button class="danger">Удалить задачу</button>
          </form>
        </details>`}
      </div></article>`;
  }

  const heading = `<div><h2 id="title-${task.id}">${title}</h2><p>${result}</p>${minimum}</div>`;
  const check = `class="task-check" role="checkbox" aria-checked="${done}" aria-labelledby="title-${task.id}"`;
  if (done) {
    return `<article class="child-task done" id="task-${task.id}">
      <div class="task-heading"><span ${check}>✓</span>${heading}</div>
      <div class="task-fields">${resetForm(task, `/submit/${task.id}/reset`)}</div></article>`;
  }

  const photoRequired = task.needs_photo && !task.photo_type;
  const photo = `<label>Фото${photoRequired ? ' (обязательно)' : ''}<input name="photo" type="file" multiple accept="image/jpeg,image/png,image/webp" ${photoRequired ? 'required' : ''}></label>
    <small>До ${maxPhotos} фото, до 8 МБ каждое и до 32 МБ вместе.</small>`;
  return `<article class="child-task" id="task-${task.id}">
    <form action="/submit/${task.id}" method="post" enctype="multipart/form-data">
      <input type="hidden" name="day" value="${day}">
      <div class="task-heading"><button type="submit" ${check}></button>${heading}</div>
      <div class="task-fields">
        ${task.min_score === null ? '' : '<label>Результат, %<input name="score" type="number" min="0" max="100" inputmode="numeric" required></label>'}
        ${photoRequired ? photo : `<details><summary>${task.photo_type ? 'Заменить фото' : 'Добавить фото'}</summary>${photo}</details>`}
      </div>
    </form></article>`;
}

function taskList(day, admin) {
  ensureTasksForDay(day);
  return listTasks.all(day).map((task) => taskCard(task, day, admin)).join('') ||
    '<p class="panel">На этот день пока нет задач.</p>';
}

function childPage() {
  return page('Задания', `<nav><strong>KidViewer</strong><a href="/admin">Родитель</a></nav>
    <h1>Задания на сегодня</h1>${taskList(today(), false)}`);
}

async function readForm(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': req.headers['content-type'] || '' },
    }).formData();
  } catch {
    return null;
  }
}

function photoType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const loginPage = page('Вход', `<nav><a href="/">К задачам</a></nav><h1>Вход для родителя</h1>
<form class="panel" method="post" action="/login">
<label>Логин<input name="user" autocomplete="username" required></label>
<label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
<button>Войти</button></form>`);

let failedLogins = 0;
let loginWindowEnds = 0;

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'strict-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((cookie) => cookie.trim().split('=')));
  const now = Date.now();
  const admin = (sessions.get(cookies.kv_admin) || 0) > now;
  if (req.method === 'GET') {
    if (route.startsWith('/child/')) return redirect(res, '/');
    if (route === '/') return send(res, 200, childPage());
    if (route === '/login') return admin ? redirect(res, '/admin') : send(res, 200, loginPage);
    if (route === '/admin') {
      if (!admin) return redirect(res, '/login');
      const selected = url.searchParams.get('day');
      const currentDay = today();
      const day = validDay(selected) ? selected : currentDay;
      return send(res, 200, page('Управление задачами', `
        <nav><a href="/">Задания на сегодня</a><form method="post" action="/logout"><button>Выйти</button></form></nav>
        <h1>Управление задачами</h1>
        ${calendar(day, currentDay)}
        <form class="panel" method="post" action="/tasks">
          <h2>Добавить задачу</h2>
          ${taskFields(day)}
          <label>Повтор<select name="frequency">
            <option value="once">Один раз</option>
            <option value="daily">Каждый день с выбранной даты</option>
            <option value="weekly">Каждую неделю в выбранный день</option>
          </select></label>
          <button>Добавить</button>
        </form>
        ${scheduleList(day)}
        <h2>Задачи на ${dayFormat.format(new Date(day))}</h2>
        ${taskList(day, true)}`));
    }
    const photoMatch = /^\/photo\/(\d+)(?:\/(\d+))?$/.exec(route);
    if (admin && photoMatch) {
      const id = Number(photoMatch[1]);
      const task = photoMatch[2] ? getExtraPhoto.get(id, Number(photoMatch[2])) : getPhoto.get(id);
      if (task?.photo) {
        res.writeHead(200, { 'Content-Type': task.photo_type, 'Content-Length': task.photo.length });
        return res.end(task.photo);
      }
    }
    return errorPage(res, 404, 'Страница не найдена');
  }

  if (req.method !== 'POST') return errorPage(res, 405, 'Метод недоступен');
  const expectedOrigin = (WEB_SECURE_COOKIES === 'false' ? 'http://' : 'https://') + req.headers.host;
  const localHost = `127.0.0.1:${req.socket.localPort}`;
  const localPost = req.headers.host === localHost && req.headers.origin === `http://${localHost}`;
  if (!localPost && req.headers.origin !== expectedOrigin) {
    return errorPage(res, 403, 'Открой страницу сайта и отправь форму снова', admin ? '/admin' : '/');
  }

  if (route === '/login') {
    if (now >= loginWindowEnds) {
      failedLogins = 0;
      loginWindowEnds = now + 60_000;
    }
    if (failedLogins >= 10) return errorPage(res, 429, 'Слишком много попыток. Подожди минуту.', '/login');
    const form = await readForm(req, 8192);
    if (!form || !matches(field(form, 'user'), WEB_ADMIN_USER) ||
        !matches(String(form.get('password') ?? ''), WEB_ADMIN_PASSWORD)) {
      failedLogins++;
      return errorPage(res, 401, 'Проверь логин и пароль', '/login');
    }
    for (const [id, expires] of sessions) {
      if (expires <= now) sessions.delete(id);
    }
    if (admin) sessions.delete(cookies.kv_admin);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, now + sessionAge * 1000);
    return redirect(res, '/admin', `kv_admin=${id}${cookieFlags}; Max-Age=${sessionAge}`);
  }

  if (route === '/logout' && admin) {
    sessions.delete(cookies.kv_admin);
    return redirect(res, '/', `kv_admin=${cookieFlags}; Max-Age=0`);
  }

  const scheduleStop = /^\/schedules\/(\d+)\/stop$/.exec(route);
  if (admin && scheduleStop) {
    const form = await readForm(req, 8192);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать запрос', '/admin');
    const id = Number(scheduleStop[1]);
    const currentDay = today();
    transaction(() => {
      if (stopSchedule.run(currentDay, id).changes) removeUpcomingTasks.run(currentDay, id);
    });
    const selected = field(form, 'day');
    return redirect(res, '/admin?day=' + (validDay(selected) ? selected : currentDay));
  }

  const taskAction = /^\/tasks\/(\d+)\/(edit|delete|reset)$/.exec(route);
  const childReset = /^\/submit\/(\d+)\/reset$/.exec(route);
  const adminReset = admin && taskAction?.[2] === 'reset';
  if (adminReset || childReset) {
    const fallback = adminReset ? '/admin' : '/';
    const form = await readForm(req, 8192);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать запрос', fallback);
    const id = Number((childReset || taskAction)[1]);
    const task = getTask.get(id);
    if (!task || (childReset && task.day !== today())) {
      return errorPage(res, 404, 'Эта задача уже недоступна', fallback);
    }
    const back = adminReset ? '/admin?day=' + task.day : '/#task-' + id;
    const reset = !task.submitted_at || transaction(() => {
      if (!resetTask.run(id, field(form, 'submitted_at')).changes) return false;
      clearExtraPhotos.run(id);
      return true;
    });
    if (!reset) {
      return errorPage(res, 409, 'Результат изменился. Открой задачу и проверь его перед сбросом.', back);
    }
    return redirect(res, back);
  }

  if (admin && taskAction?.[2] === 'delete') {
    const id = Number(taskAction[1]);
    const task = getTask.get(id);
    if (!task) return errorPage(res, 404, 'Задача уже удалена', '/admin');
    if (task.schedule_id < 0) return errorPage(res, 403, 'Это обязательная ежедневная задача', '/admin?day=' + task.day);
    deleteTask.run(id);
    return redirect(res, '/admin?day=' + task.day);
  }

  if (admin && (route === '/tasks' || taskAction?.[2] === 'edit')) {
    const form = await readForm(req, 8192);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать задачу', '/admin');
    const day = field(form, 'day');
    const title = field(form, 'title');
    const minimum = field(form, 'min_score');
    const minScore = readScore(minimum);
    if (!validDay(day) || !title || title.length > 200 || (minimum && minScore === null)) {
      return errorPage(res, 400, 'Проверь дату, название и минимальный результат', '/admin');
    }
    const needsPhoto = Number(form.has('needs_photo'));
    if (taskAction) {
      const id = Number(taskAction[1]);
      const task = getTask.get(id);
      if (!task) return errorPage(res, 404, 'Задача уже удалена', '/admin');
      if (task.schedule_id < 0) return errorPage(res, 403, 'Это обязательная ежедневная задача', '/admin?day=' + task.day);
      editTask.run(day, title, minScore, needsPhoto, id);
    } else {
      const frequency = field(form, 'frequency') || 'once';
      if (frequency === 'daily' || frequency === 'weekly') {
        addSchedule.run(day, title, minScore, needsPhoto, frequency);
      } else if (frequency === 'once') {
        addTask.run(nextTaskId.get().last_id, day, title, minScore, needsPhoto);
      } else {
        return errorPage(res, 400, 'Выбери периодичность задачи', '/admin?day=' + day);
      }
    }
    return redirect(res, '/admin?day=' + day);
  }

  const submitMatch = /^\/submit\/(\d+)$/.exec(route);
  if (submitMatch) {
    const id = Number(submitMatch[1]);
    const back = `/#task-${id}`;
    const form = await readForm(req, maxTotalPhotoBytes + 65536);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать форму. Все фото вместе должны быть до 32 МБ.', back);
    const files = form.getAll('photo').filter((file) => typeof file !== 'string' && file.size > 0);
    if (files.length > maxPhotos || files.reduce((total, file) => total + file.size, 0) > maxTotalPhotoBytes) {
      return errorPage(res, 400, 'Можно отправить до 10 фото общим размером до 32 МБ', back);
    }
    const photos = [];
    for (const file of files) {
      if (file.size > maxPhotoBytes) return errorPage(res, 400, 'Каждое фото должно быть до 8 МБ', back);
      const bytes = Buffer.from(await file.arrayBuffer());
      const type = photoType(bytes);
      if (!type) return errorPage(res, 400, 'Выбери фото JPEG, PNG или WebP', back);
      photos.push({ bytes, type });
    }
    const day = today();
    const task = getTask.get(id);
    if (!task || task.day !== day || field(form, 'day') !== day) {
      return errorPage(res, 404, 'Эта задача уже недоступна');
    }
    if (isDone(task)) return redirect(res, back);
    const score = task.min_score === null ? null : readScore(field(form, 'score'));
    if (task.min_score !== null && score === null) return errorPage(res, 400, 'Введи результат от 0 до 100', back);
    if (task.needs_photo && !photos.length && !task.photo_type) return errorPage(res, 400, 'Прикрепи фото выполнения', back);
    transaction(() => {
      submitTask.run(new Date().toISOString(), score, photos[0]?.bytes ?? null, photos[0]?.type ?? null, id);
      if (photos.length) {
        clearExtraPhotos.run(id);
        for (const [index, photo] of photos.slice(1).entries()) {
          addExtraPhoto.run(id, index + 2, photo.bytes, photo.type);
        }
      }
    });
    return redirect(res, back);
  }

  return errorPage(res, 403, 'Доступ закрыт');
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) errorPage(res, 500, 'Не удалось обработать запрос');
    else res.destroy();
  });
}).listen(Number(WEB_PORT), '127.0.0.1', () => {
  console.log(`KidViewer: http://127.0.0.1:${WEB_PORT}`);
});
