const { createServer } = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const {
  WEB_ADMIN_USER = 'admin',
  WEB_ADMIN_PASSWORD,
  WEB_CHILD_KEY,
  WEB_PORT = '8080',
  WEB_SECURE_COOKIES = 'true',
  TIMEZONE = 'Europe/Warsaw',
} = process.env;

if (!WEB_ADMIN_PASSWORD || WEB_ADMIN_PASSWORD.length < 12 ||
    !/^[a-f0-9]{32,128}$/.test(WEB_CHILD_KEY || '')) {
  throw new Error('Укажите WEB_ADMIN_PASSWORD (от 12 символов) и WEB_CHILD_KEY по инструкции в README.');
}

const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const today = () => dateFormat.format(new Date());
const hash = (value) => createHash('sha256').update(value).digest();
const matches = (left, right) => timingSafeEqual(hash(left), hash(right));
const childSession = hash('child session:' + WEB_CHILD_KEY).toString('hex');
const sessions = new Map();
const sessionAge = 8 * 60 * 60;
const cookieFlags = '; Path=/; HttpOnly; SameSite=Strict' +
  (WEB_SECURE_COOKIES === 'false' ? '' : '; Secure');
const maxPhotoBytes = 8 * 1024 * 1024;

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/web.sqlite');
db.exec(`
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
`);

const listTasks = db.prepare(`
  SELECT id, title, min_score, needs_photo, submitted_at, score, photo_type
  FROM tasks WHERE day = ? ORDER BY id
`);
const getTask = db.prepare(`
  SELECT min_score, needs_photo, submitted_at FROM tasks WHERE id = ? AND day = ?
`);
const addTask = db.prepare('INSERT INTO tasks(day, title, min_score, needs_photo) VALUES (?, ?, ?, ?)');
const submitTask = db.prepare(`
  UPDATE tasks SET submitted_at = ?, score = ?, photo = ?, photo_type = ?
  WHERE id = ? AND day = ? AND (submitted_at IS NULL OR score < min_score)
`);
const getPhoto = db.prepare('SELECT photo, photo_type FROM tasks WHERE id = ?');

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

function taskCard(task, admin) {
  const done = task.submitted_at && (task.min_score === null || task.score >= task.min_score);
  const status = done ? 'Выполнено' : task.submitted_at ? 'Нужно повторить' : 'К выполнению';
  return `<article><h2>${html(task.title)}</h2><p>${status}${task.score === null ? '' : ` · ${task.score}%`}</p>
  ${task.min_score === null ? '' : `<small>Минимум ${task.min_score}%</small>`}
  ${admin && task.photo_type ? `<a href="/photo/${task.id}"><img src="/photo/${task.id}" alt="Фото выполнения" loading="lazy"></a>` : ''}
  ${admin || done ? '' : `<form action="/submit/${task.id}" method="post" enctype="multipart/form-data">
    <input type="hidden" name="day" value="${today()}">
    ${task.min_score === null ? '' : '<label>Результат, %<input name="score" type="number" min="0" max="100" inputmode="numeric" required></label>'}
    <label>Фото ${task.needs_photo ? '(обязательно)' : '(по желанию)'}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" ${task.needs_photo ? 'required' : ''}></label>
    <button>Отправить результат</button></form>`}
  </article>`;
}

function taskList(day, admin) {
  return listTasks.all(day).map((task) => taskCard(task, admin)).join('') ||
    '<p class="panel">На этот день пока нет задач.</p>';
}

function childPage(admin) {
  return page('Задания', `<nav><strong>KidViewer</strong><a href="/admin">Родитель</a></nav>
    <h1>Задания на сегодня</h1>${taskList(today(), admin)}`);
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
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((cookie) => cookie.trim().split('=')));
  const now = Date.now();
  const admin = (sessions.get(cookies.kv_admin) || 0) > now;
  const child = matches(cookies.kv_child || '', childSession);

  if (req.method === 'GET') {
    if (route.startsWith('/child/') && matches(route.slice(7), WEB_CHILD_KEY)) {
      res.setHeader('Set-Cookie', `kv_child=${childSession}${cookieFlags}; Max-Age=31536000`);
      return send(res, 200, childPage(admin));
    }
    if (route === '/') {
      return send(res, 200, child || admin ? childPage(admin) : page('Задания', `
        <nav><strong>KidViewer</strong><a href="/admin">Родитель</a></nav>
        <h1>Задания на сегодня</h1><p>Открой личную ссылку, которую дал родитель.</p>`));
    }
    if (route === '/login') return admin ? redirect(res, '/admin') : send(res, 200, loginPage);
    if (route === '/admin') {
      if (!admin) return redirect(res, '/login');
      const selected = url.searchParams.get('day');
      const day = validDay(selected) ? selected : today();
      return send(res, 200, page('Управление задачами', `
        <nav><a href="/">Задания на сегодня</a><form method="post" action="/logout"><button>Выйти</button></form></nav>
        <h1>Управление задачами</h1>
        <form class="panel" method="post" action="/tasks">
          <h2>Добавить задачу</h2>
          <label>Дата<input name="day" type="date" value="${day}" required></label>
          <label>Что нужно сделать<input name="title" maxlength="200" required></label>
          <label>Минимальный результат, %<input name="min_score" type="number" min="0" max="100" placeholder="По желанию"></label>
          <label><input name="needs_photo" type="checkbox"> Требовать фото</label>
          <button>Добавить</button>
        </form>
        <form method="get" action="/admin"><label>Задачи за день<input name="day" type="date" value="${day}" required></label><button>Показать</button></form>
        ${taskList(day, true)}`));
    }
    const photoMatch = /^\/photo\/(\d+)$/.exec(route);
    if (admin && photoMatch) {
      const task = getPhoto.get(Number(photoMatch[1]));
      if (task?.photo) {
        res.writeHead(200, { 'Content-Type': task.photo_type, 'Content-Length': task.photo.length });
        return res.end(task.photo);
      }
    }
    return errorPage(res, 404, 'Страница не найдена');
  }

  if (req.method !== 'POST') return errorPage(res, 405, 'Метод недоступен');
  const expectedOrigin = (WEB_SECURE_COOKIES === 'false' ? 'http://' : 'https://') + req.headers.host;
  if (req.headers.origin !== expectedOrigin) return errorPage(res, 403, 'Открой страницу сайта и отправь форму снова');

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

  if (route === '/tasks' && admin) {
    const form = await readForm(req, 8192);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать задачу', '/admin');
    const day = field(form, 'day');
    const title = field(form, 'title');
    const minimum = field(form, 'min_score');
    const minScore = readScore(minimum);
    if (!validDay(day) || !title || title.length > 200 || (minimum && minScore === null)) {
      return errorPage(res, 400, 'Проверь дату, название и минимальный результат', '/admin');
    }
    addTask.run(day, title, minScore, Number(form.has('needs_photo')));
    return redirect(res, '/admin?day=' + day);
  }

  const submitMatch = /^\/submit\/(\d+)$/.exec(route);
  if (submitMatch && child) {
    const form = await readForm(req, maxPhotoBytes + 65536);
    if (!form) return errorPage(res, 400, 'Не удалось прочитать форму. Фото должно быть до 8 МБ.');
    const id = Number(submitMatch[1]);
    const day = today();
    const task = getTask.get(id, day);
    if (!task || field(form, 'day') !== day) return errorPage(res, 404, 'Эта задача уже недоступна');
    const score = task.min_score === null ? null : readScore(field(form, 'score'));
    if (task.min_score !== null && score === null) return errorPage(res, 400, 'Введи результат от 0 до 100');
    const file = form.get('photo');
    let bytes = null;
    let type = null;
    if (file && typeof file !== 'string' && file.size) {
      if (file.size > maxPhotoBytes) return errorPage(res, 400, 'Фото должно быть до 8 МБ');
      bytes = Buffer.from(await file.arrayBuffer());
      type = photoType(bytes);
      if (!type) return errorPage(res, 400, 'Выбери фото JPEG, PNG или WebP');
    }
    if (task.needs_photo && !bytes) return errorPage(res, 400, 'Прикрепи фото выполнения');
    submitTask.run(new Date().toISOString(), score, bytes, type, id, day);
    return redirect(res, '/');
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
