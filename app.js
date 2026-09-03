// Runner PWA — мобильный доступ к проектам, задачам и сессиям Claude.

const KEY_TOKEN = 'runner-token';
const KEY_API = 'runner-api';

// Приложение живёт на постоянном адресе GitHub Pages, а компьютер каждый раз
// получает новый адрес туннеля — он публикуется в origin.json рядом с приложением.
const ORIGIN_POINTER = 'https://raw.githubusercontent.com/pernebye/runner-mobile/main/origin.json';
let apiBase = location.origin.includes('github.io') ? (localStorage.getItem(KEY_API) || '') : '';

// raw отдаётся через CDN и минут пять помнит старый адрес; когда связь потеряна,
// спрашиваем напрямую у API GitHub, чтобы не ждать протухания кэша
const ORIGIN_FRESH = 'https://api.github.com/repos/pernebye/runner-mobile/contents/origin.json';

async function resolveApi(fresh) {
  if (!location.origin.includes('github.io')) return '';
  const sources = fresh
    ? [{ url: ORIGIN_FRESH, raw: true }, { url: ORIGIN_POINTER }]
    : [{ url: ORIGIN_POINTER }];

  for (const source of sources) {
    try {
      const res = await fetch(source.url + '?t=' + Date.now(), {
        cache: 'no-store',
        headers: source.raw ? { 'Accept': 'application/vnd.github.raw' } : {}
      });
      const data = await res.json();
      if (data.origin) {
        apiBase = data.origin.replace(/\/$/, '');
        localStorage.setItem(KEY_API, apiBase);
        return apiBase;
      }
    } catch {
      // пробуем следующий источник
    }
  }
  return apiBase;
}

const state = {
  projects: [],
  workspaces: [],
  tasks: [],
  events: [],
  sessions: [],
  activity: {},
  screen: 'projects',
  scope: 'today',
  workspace: '',
  search: '',
  kind: 'task'
};

// --- токен ---

let keyFromUrl = '';

function readToken() {
  keyFromUrl = new URLSearchParams(location.search).get('k') ||
    new URLSearchParams(location.hash.replace(/^#/, '')).get('k') || '';
  if (keyFromUrl) {
    history.replaceState(null, '', location.pathname);
    return keyFromUrl;
  }
  return localStorage.getItem(KEY_TOKEN) || '';
}

let token = readToken();

// --- вход ---

function showLogin(message) {
  const box = document.getElementById('login');
  const note = document.getElementById('login-note');
  if (message) {
    note.textContent = message;
    note.classList.add('error');
  }
  box.hidden = false;
  document.getElementById('login-code').focus();
}

function hideLogin() {
  document.getElementById('login').hidden = true;
  stopScanner();
}

async function submitCode(raw) {
  const code = (raw || '').trim().replace(/\s+/g, '');
  if (!code) return false;

  const note = document.getElementById('login-note');
  note.classList.remove('error');
  note.textContent = 'Проверяю…';

  try {
    await resolveApi(true);
    const res = await fetch(apiBase + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device: navigator.userAgent.slice(0, 60) })
    });
    const data = await res.json();
    if (!data.token) {
      note.textContent = data.error || 'Код не подошёл';
      note.classList.add('error');
      return false;
    }
    token = data.token;
    localStorage.setItem(KEY_TOKEN, token);
    hideLogin();
    note.textContent = '';
    load();
    return true;
  } catch {
    note.textContent = 'Компьютер недоступен — он должен быть включён';
    note.classList.add('error');
    return false;
  }
}

let scanStream = null;

async function startScanner() {
  if (!('BarcodeDetector' in window)) {
    showLogin('Сканер недоступен в этом браузере — введи код вручную');
    return;
  }
  const video = document.getElementById('scanner-video');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    showLogin('Нет доступа к камере — введи код вручную');
    return;
  }

  document.getElementById('scanner').hidden = false;
  video.srcObject = scanStream;
  await video.play();

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const tick = async () => {
    if (!scanStream) return;
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const value = found[0].rawValue || '';
        // из otpauth-ссылки код не достать, а вот ключ устройства подходит целиком
        const key = value.startsWith('http') ? (new URL(value).searchParams.get('k') || '') : value;
        stopScanner();
        submitCode(key || value);
        return;
      }
    } catch {
      // кадр не распознан — пробуем следующий
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function stopScanner() {
  if (scanStream) {
    scanStream.getTracks().forEach(track => track.stop());
    scanStream = null;
  }
  const scanner = document.getElementById('scanner');
  if (scanner) scanner.hidden = true;
}

async function api(path, method = 'GET', body) {
  const res = await fetch(apiBase + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    localStorage.removeItem(KEY_TOKEN);
    token = '';
    showLogin('Сессия истекла — введи код заново');
    throw new Error('unauthorized');
  }
  return res.json();
}

// --- утилиты ---

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function toDate(value, endOfDay = true) {
  if (!value) return null;
  if (value.includes('T')) return new Date(value);
  const d = new Date(value + 'T00:00:00');
  if (endOfDay) d.setHours(23, 59, 0, 0);
  return d;
}

function dayDiff(value) {
  const d = toDate(value, false);
  if (!d) return null;
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / 86400000);
}

function humanDue(value) {
  const d = toDate(value, false);
  if (!d) return '';
  const diff = dayDiff(value);
  const time = value.includes('T') ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  if (diff === 0) return 'сегодня' + time;
  if (diff === 1) return 'завтра' + time;
  if (diff === -1) return 'вчера' + time;
  if (diff < 0) return `${-diff} дн. назад`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}` + time;
}

function ago(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} дн назад` : new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function isOverdue(task) {
  return task.status !== 'done' && task.due && toDate(task.due) < new Date();
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function colorFor(project) {
  if (project.tabColor) return project.tabColor;
  let hash = 0;
  for (const ch of project.name || '') hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 42%, 42%)`;
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// --- загрузка ---

async function load(silent) {
  const btn = document.getElementById('btn-reload');
  if (!silent) btn.classList.add('spinning');
  try {
    let data;
    try {
      data = await api('/api/state');
    } catch (first) {
      if (first.message === 'unauthorized') throw first;
      // компьютер мог перезагрузиться и получить новый адрес туннеля
      await resolveApi(true);
      data = await api('/api/state');
    }
    Object.assign(state, {
      projects: data.projects || [],
      workspaces: data.workspaces || [],
      tasks: data.tasks || [],
      events: data.events || [],
      sessions: data.sessions || [],
      activity: data.activity || {}
    });
    renderAll();
  } catch (err) {
    if (err.message !== 'unauthorized') toast('Компьютер недоступен');
  } finally {
    btn.classList.remove('spinning');
  }
}

function renderAll() {
  renderWorkspaces();
  renderProjects();
  renderTasks();
  renderSessions();
  renderCounts();
}

// --- проекты ---

function lastTouch(project) {
  const launch = (project.launchHistory || [])[0];
  return [state.activity[project.id], launch && launch.timestamp, project.updatedAt].filter(Boolean).sort().pop() || '';
}

function renderWorkspaces() {
  const box = document.getElementById('workspace-chips');
  const chips = [{ id: '', name: 'Все' }, ...state.workspaces];
  box.innerHTML = chips.map(ws => `
    <button class="chip${state.workspace === ws.id ? ' active' : ''}" data-ws="${esc(ws.id)}">${esc(ws.name)}</button>
  `).join('');
}

function renderProjects() {
  const list = document.getElementById('projects-list');
  let items = state.projects.filter(p => p.status !== 'archived');
  if (state.workspace) items = items.filter(p => p.workspaceId === state.workspace);
  if (state.search) {
    const query = state.search.toLowerCase();
    items = items.filter(p => p.name.toLowerCase().includes(query) || (p.path || '').toLowerCase().includes(query));
  }
  items.sort((a, b) => lastTouch(b).localeCompare(lastTouch(a)));

  if (!items.length) {
    list.innerHTML = '<div class="empty">Ничего не нашлось</div>';
    return;
  }

  const openTasks = {};
  for (const task of state.tasks) {
    if (task.status === 'done') continue;
    const key = task.projectId || '';
    openTasks[key] = (openTasks[key] || 0) + 1;
  }

  list.innerHTML = items.map(project => {
    const tasks = openTasks[project.id];
    const hasDev = (project.devCommands || []).length > 0;
    return `
      <article class="card" data-project="${esc(project.id)}">
        <div class="card-head">
          <span class="avatar" style="background:${esc(colorFor(project))}">${esc(initial(project.name))}</span>
          <div class="card-titles">
            <div class="card-name">${esc(project.name)}</div>
            <div class="card-sub">${ago(lastTouch(project))}${tasks ? ` · ${tasks} задач` : ''}</div>
          </div>
          ${project.status === 'active' ? '<span class="badge badge-active">в работе</span>' : ''}
        </div>
        <div class="card-actions">
          <button class="btn btn-run" data-act="launch">Claude</button>
          ${hasDev ? '<button class="btn btn-narrow" data-act="dev">Dev</button>' : ''}
          ${project.prodUrl ? `<a class="btn btn-narrow" href="${esc(project.prodUrl)}" target="_blank" rel="noopener">Сайт</a>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

// --- задачи ---

function scopeTasks() {
  const open = state.tasks.filter(t => t.status !== 'done');
  if (state.scope === 'today') return open.filter(t => t.due && dayDiff(t.due) <= 0);
  if (state.scope === 'week') return open.filter(t => t.due && dayDiff(t.due) <= 7);
  return open;
}

function renderTasks() {
  const list = document.getElementById('tasks-list');

  if (state.scope === 'events') {
    const events = [...state.events]
      .filter(e => e.status === 'planned')
      .sort((a, b) => a.at.localeCompare(b.at));
    list.innerHTML = events.length
      ? events.map(event => taskRow(event, true)).join('')
      : '<div class="empty">Созвонов нет</div>';
    return;
  }

  const tasks = scopeTasks().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">Задач нет — чисто</div>';
    return;
  }

  const groups = { overdue: [], today: [], tomorrow: [], later: [], none: [] };
  for (const task of tasks) {
    if (!task.due) groups.none.push(task);
    else if (isOverdue(task)) groups.overdue.push(task);
    else if (dayDiff(task.due) === 0) groups.today.push(task);
    else if (dayDiff(task.due) === 1) groups.tomorrow.push(task);
    else groups.later.push(task);
  }

  const titles = { overdue: 'Просрочено', today: 'Сегодня', tomorrow: 'Завтра', later: 'Позже', none: 'Без срока' };
  list.innerHTML = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([key, items]) => `
      <div class="group-title${key === 'overdue' ? ' alert' : ''}">${titles[key]}</div>
      ${items.map(task => taskRow(task)).join('')}
    `).join('');
}

function taskRow(item, isEvent) {
  const project = state.projects.find(p => p.id === item.projectId);
  const when = isEvent ? item.at : item.due;
  const meta = [];
  if (when) meta.push(`<span class="task-due">${humanDue(when)}</span>`);
  if (project) meta.push(`<span>${esc(project.name)}</span>`);
  if (isEvent && item.location) meta.push(`<span>${esc(item.location)}</span>`);

  return `
    <article class="task${isOverdue(item) ? ' overdue' : ''}" data-id="${esc(item.id)}">
      <button class="check" data-act="done"></button>
      <div class="task-body">
        <div class="task-title">${item.priority === 'high' ? '<span class="task-flag">● </span>' : ''}${esc(item.title)}</div>
        ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      </div>
    </article>
  `;
}

function renderCounts() {
  const open = state.tasks.filter(t => t.status !== 'done');
  const counts = {
    today: open.filter(t => t.due && dayDiff(t.due) <= 0).length,
    week: open.filter(t => t.due && dayDiff(t.due) <= 7).length,
    all: open.length,
    events: state.events.filter(e => e.status === 'planned' && toDate(e.at, false) >= new Date()).length
  };
  document.querySelectorAll('#task-chips .chip').forEach(chip => {
    const badge = chip.querySelector('span');
    if (badge) badge.textContent = counts[chip.dataset.scope] ?? 0;
  });

  const overdue = open.filter(isOverdue).length;
  const badge = document.getElementById('tab-badge');
  const urgent = overdue || counts.today;
  badge.textContent = urgent;
  badge.hidden = !urgent;
}

// --- сессии ---

function renderSessions() {
  const list = document.getElementById('sessions-list');
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty">Недавних сессий нет</div>';
    return;
  }
  list.innerHTML = state.sessions.map(session => `
    <article class="card" data-session="${esc(session.sessionId)}">
      <div class="card-head">
        <span class="avatar" style="background:${esc(session.tabColor || '#3a3a42')}">${esc(initial(session.projectName))}</span>
        <div class="card-titles">
          <div class="card-name">${esc(session.projectName)}</div>
          <div class="card-sub">${ago(session.at)} · ${esc(session.prompt.slice(0, 60))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-run" data-act="resume">Продолжить сессию</button>
      </div>
    </article>
  `).join('');
}

// --- действия ---

document.getElementById('projects-list').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-project]');
  const action = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !action) return;

  const projectId = card.dataset.project;
  const name = state.projects.find(p => p.id === projectId)?.name || '';
  try {
    if (action === 'launch') {
      await api('/api/launch', 'POST', { projectId });
      toast(`Claude запускается: ${name}`);
    } else if (action === 'dev') {
      await api('/api/dev', 'POST', { projectId });
      toast(`Dev-серверы: ${name}`);
    }
  } catch {
    toast('Не получилось — компьютер недоступен');
  }
});

document.getElementById('sessions-list').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-session]');
  if (!card || !e.target.closest('[data-act="resume"]')) return;
  const session = state.sessions.find(s => s.sessionId === card.dataset.session);
  if (!session) return;
  try {
    await api('/api/session', 'POST', {
      cwd: session.cwd,
      sessionId: session.sessionId,
      title: session.projectName,
      tabColor: session.tabColor
    });
    toast('Сессия открывается');
  } catch {
    toast('Не получилось открыть сессию');
  }
});

document.getElementById('tasks-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-id]');
  if (!row || !e.target.closest('[data-act="done"]')) return;
  row.classList.add('done');
  try {
    await api('/api/done', 'POST', { id: row.dataset.id });
    const task = state.tasks.find(t => t.id === row.dataset.id);
    if (task) task.status = 'done';
    const event = state.events.find(ev => ev.id === row.dataset.id);
    if (event) event.status = 'done';
    renderTasks();
    renderCounts();
    renderProjects();
  } catch {
    row.classList.remove('done');
    toast('Не удалось отметить');
  }
});

document.getElementById('workspace-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-ws]');
  if (!chip) return;
  state.workspace = chip.dataset.ws;
  renderWorkspaces();
  renderProjects();
});

document.getElementById('task-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.scope = chip.dataset.scope;
  document.querySelectorAll('#task-chips .chip').forEach(c => c.classList.toggle('active', c === chip));
  renderTasks();
});

document.getElementById('project-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  renderProjects();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.screen = tab.dataset.target;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === state.screen));
    document.getElementById('screen-title').textContent =
      { projects: 'Проекты', tasks: 'Задачи', sessions: 'Сессии' }[state.screen];
  });
});

document.getElementById('btn-reload').addEventListener('click', () => load());

// --- форма создания ---

function openSheet() {
  const select = document.getElementById('new-project');
  select.innerHTML = '<option value="">Без проекта</option>' +
    state.projects.filter(p => p.status !== 'archived')
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  document.getElementById('new-title').value = '';
  document.getElementById('new-due').value = '';
  document.getElementById('new-priority').checked = false;
  document.getElementById('sheet').hidden = false;
  document.getElementById('sheet-backdrop').hidden = false;
  setTimeout(() => document.getElementById('new-title').focus(), 100);
}

function closeSheet() {
  document.getElementById('sheet').hidden = true;
  document.getElementById('sheet-backdrop').hidden = true;
}

document.getElementById('btn-add').addEventListener('click', openSheet);
document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);

document.querySelectorAll('.sheet-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.kind = tab.dataset.kind;
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('new-title').placeholder = state.kind === 'event' ? 'С кем созвон' : 'Что сделать';
    document.getElementById('priority-row').hidden = state.kind === 'event';
  });
});

document.getElementById('quick-dates').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-due]');
  if (btn) document.getElementById('new-due').value = btn.dataset.due;
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const title = document.getElementById('new-title').value.trim();
  if (!title) return;
  const due = document.getElementById('new-due').value.trim();
  const projectId = document.getElementById('new-project').value;

  try {
    if (state.kind === 'event') {
      if (!due) { toast('У созвона нужна дата'); return; }
      const res = await api('/api/event', 'POST', { title, at: due, projectId });
      if (!res.ok) { toast(res.error || 'Не понял дату'); return; }
      state.events.push(res.event);
      toast('Созвон записан');
    } else {
      const res = await api('/api/task', 'POST', {
        title, due, projectId,
        priority: document.getElementById('new-priority').checked ? 'high' : 'normal'
      });
      if (!res.ok) { toast(res.error || 'Не получилось'); return; }
      state.tasks.push(res.task);
      toast('Задача создана');
    }
    closeSheet();
    renderTasks();
    renderCounts();
    renderProjects();
  } catch {
    toast('Компьютер недоступен');
  }
});

// --- старт ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load(true);
});

document.getElementById('login-submit').addEventListener('click', () => {
  submitCode(document.getElementById('login-code').value);
});

document.getElementById('login-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCode(e.target.value);
});

// шестизначный код отправляем сами — на телефоне это экономит нажатие
document.getElementById('login-code').addEventListener('input', (e) => {
  if (/^\d{6}$/.test(e.target.value.trim())) submitCode(e.target.value);
});

document.getElementById('login-scan').addEventListener('click', startScanner);
document.getElementById('scanner-cancel').addEventListener('click', stopScanner);

(async () => {
  if ('BarcodeDetector' in window) document.getElementById('login-scan').hidden = false;
  await resolveApi();

  // ключ из ссылки сразу меняем на сессию устройства: мастер-ключ на телефоне не храним
  if (keyFromUrl) {
    const entered = await submitCode(keyFromUrl);
    if (entered) return;
    token = '';
  }

  if (!token) {
    showLogin();
    return;
  }
  load();
  setInterval(() => { if (!document.hidden) load(true); }, 60000);
  // адрес туннеля меняется вместе с перезагрузкой компьютера
  setInterval(resolveApi, 300000);
})();
