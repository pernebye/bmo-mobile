// BMO PWA — проекты, задачи, календарь и сессии Claude с телефона.

const KEY_TOKEN = 'bmo-token';
const KEY_API = 'bmo-api';
const KEY_STATE = 'bmo-state';
const KEY_FAVICONS = 'bmo-favicons';

// Приложение живёт на постоянном адресе GitHub Pages, а компьютер каждый раз
// получает новый адрес туннеля — он публикуется в origin.json рядом с приложением.
const ORIGIN_POINTER = 'https://raw.githubusercontent.com/pernebye/bmo-mobile/main/origin.json';
// raw отдаётся через CDN и минут пять помнит старый адрес; когда связь потеряна,
// спрашиваем напрямую у API GitHub, чтобы не ждать протухания кэша
const ORIGIN_FRESH = 'https://api.github.com/repos/pernebye/bmo-mobile/contents/origin.json';

let apiBase = location.origin.includes('github.io') ? (localStorage.getItem(KEY_API) || '') : '';

const state = {
  projects: [], workspaces: [], tasks: [], events: [], sessions: [], notes: [], notesTrash: [],
  showTrash: false, noteQuery: '', activity: {},
  screen: 'projects', scope: 'all', workspace: '', search: '',
  calCursor: new Date(), calSelected: '',
  sheet: { kind: 'task', item: null, steps: [] },
  // сколько выполненных раскрыто внизу списка: 3, затем «ещё 5» сколько угодно раз
  doneLimit: 3,
  favicons: {},
  offline: false
};

// иконки проектов живут в localStorage: без сети карточки всё равно с картинками
try { state.favicons = (JSON.parse(localStorage.getItem(KEY_FAVICONS) || 'null') || {}).icons || {}; } catch { state.favicons = {}; }

async function loadFavicons(force) {
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(KEY_FAVICONS) || 'null') || {}; } catch {}
  const missing = state.projects.some(p => !(p.id in state.favicons));
  // сервер присылает слепок «какой файл у какого проекта» — сменилась иконка, перечитываем
  const stale = state.faviconsVersion && cached.version !== state.faviconsVersion;
  if (!force && !missing && !stale && Date.now() - (cached.at || 0) < 6 * 3600e3) return;
  try {
    const res = await api('/api/favicons');
    state.favicons = res.icons || {};
    try { localStorage.setItem(KEY_FAVICONS, JSON.stringify({ at: Date.now(), version: state.faviconsVersion || '', icons: state.favicons })); } catch {}
    renderProjects();
    renderSessions();
  } catch {}
}

function avatarHtml(project, color, name) {
  const icon = project && state.favicons[project.id];
  if (icon) return `<span class="avatar avatar-img"><img src="${icon}" alt=""></span>`;
  return `<span class="avatar" style="background:${esc(color)}">${esc(initial(name))}</span>`;
}

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

// --- вход ---

// настроение BMO на экране входа: сосредоточен, пока печатаешь; расстроен от неверного кода; рад входу
function loginMood(mood) {
  const login = document.getElementById('login');
  login.classList.remove('is-typing', 'is-sad', 'is-happy');
  if (mood) login.classList.add(`is-${mood}`);
  if (mood === 'sad') setTimeout(() => login.classList.remove('is-sad'), 800);
}

function showLogin(message) {
  const note = document.getElementById('login-note');
  if (message) {
    note.textContent = message;
    note.classList.add('error');
  }
  document.getElementById('login').hidden = false;
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
      loginMood('sad');
      return false;
    }
    token = data.token;
    localStorage.setItem(KEY_TOKEN, token);
    loginMood('happy');
    note.textContent = '';
    // BMO успевает улыбнуться, прежде чем экран уйдёт
    setTimeout(hideLogin, 550);
    load();
    return true;
  } catch {
    note.textContent = 'Компьютер недоступен — он должен быть включён';
    note.classList.add('error');
    loginMood('sad');
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

// --- утилиты ---

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_HEAD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

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

const SOURCE_TITLES = { trello: 'Trello', ozimiz: 'Админка Ozimiz' };
const STAGE_TITLES = { backlog: 'Бэклог', todo: 'К выполнению', progress: 'В работе', review: 'На проверке', done: 'Готово' };

// «4 сент., 12:35» для комментариев
function humanStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function humanDue(value) {
  const d = toDate(value, false);
  if (!d) return '';
  const diff = dayDiff(value);
  const time = value.includes('T') ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
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

function initial(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

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
  const ptr = document.getElementById('ptr');
  if (!silent) ptr.classList.add('loading');
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
    applyState(data);
    try { localStorage.setItem(KEY_STATE, JSON.stringify({ data, at: Date.now() })); } catch {}
    setOffline(false);
    loadFavicons();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    // компьютер выключен или туннель упал: показываем последнее известное, но ничего не даём менять
    const cached = readCachedState();
    if (cached && !state.projects.length) applyState(cached.data);
    setOffline(true, cached?.at);
  } finally {
    ptr.classList.remove('loading', 'ready', 'pulling');
    ptr.style.transform = '';
    ptr.style.opacity = '';
  }
}

// --- обновление потягиванием вниз ---

const pull = { startY: 0, active: false, distance: 0 };
const PULL_THRESHOLD = 72;

document.addEventListener('touchstart', (e) => {
  if (window.scrollY > 0 || !document.getElementById('sheet').hidden || !document.getElementById('login').hidden) return;
  pull.startY = e.touches[0].clientY;
  pull.active = true;
  pull.distance = 0;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!pull.active) return;
  const dy = e.touches[0].clientY - pull.startY;
  if (dy <= 0 || window.scrollY > 0) { pull.distance = 0; return; }
  // сопротивление: чем дальше тянешь, тем медленнее едет индикатор
  pull.distance = Math.min(dy * 0.55, 110);
  const ptr = document.getElementById('ptr');
  ptr.classList.add('pulling');
  ptr.classList.toggle('ready', pull.distance >= PULL_THRESHOLD);
  ptr.style.transform = `translateY(${pull.distance - 52}px) rotate(${pull.distance * 3}deg)`;
  ptr.style.opacity = Math.min(pull.distance / PULL_THRESHOLD, 1);
}, { passive: true });

document.addEventListener('touchend', () => {
  if (!pull.active) return;
  pull.active = false;
  const ptr = document.getElementById('ptr');
  ptr.classList.remove('pulling');
  if (pull.distance >= PULL_THRESHOLD && token) {
    ptr.style.transform = '';
    load();
  } else {
    ptr.classList.remove('ready');
    ptr.style.transform = '';
    ptr.style.opacity = '';
  }
});

function applyState(data) {
  Object.assign(state, {
    projects: data.projects || [],
    workspaces: data.workspaces || [],
    tasks: data.tasks || [],
    events: data.events || [],
    sessions: data.sessions || [],
    notes: data.notes || [],
    notesTrash: data.notesTrash || [],
    activity: data.activity || {},
    faviconsVersion: data.faviconsVersion || ''
  });
  renderAll();
}

function readCachedState() {
  try {
    return JSON.parse(localStorage.getItem(KEY_STATE) || 'null');
  } catch {
    return null;
  }
}

function setOffline(on, cachedAt) {
  state.offline = on;
  document.body.classList.toggle('offline', on);
  document.getElementById('offline-pill').hidden = !on;
  const bar = document.getElementById('offline-bar');
  bar.hidden = !on;
  if (on && cachedAt) bar.textContent = `Нет связи с компьютером — данные на ${ago(new Date(cachedAt).toISOString())}, изменения недоступны`;
  if (on) sheet.close();
}

function renderAll() {
  renderWorkspaces();
  renderProjects();
  renderTasks();
  renderCalendar();
  renderSessions();
  renderNotes();
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

  list.innerHTML = '<div class="group">' + items.map(project => {
    const tasks = openTasks[project.id];
    const hasDev = (project.devCommands || []).length > 0;
    return `
      <article class="card" data-project="${esc(project.id)}">
        <div class="card-head">
          ${avatarHtml(project, colorFor(project), project.name)}
          <div class="card-titles">
            <div class="card-name">${esc(project.name)}</div>
            <div class="card-sub">${ago(lastTouch(project))}${tasks ? ` · ${tasks} задач` : ''}</div>
          </div>
          ${project.status === 'active' ? '<span class="badge badge-active">в работе</span>' : ''}
        </div>
        <div class="card-actions">
          <button class="btn btn-run" data-act="launch"><i data-icon="claude"></i>Claude</button>
          <div class="card-extra">
            ${hasDev ? '<button class="btn btn-narrow btn-icon-only" data-act="dev" title="Dev-серверы"><i data-icon="play"></i></button>' : ''}
            ${project.prodUrl ? `<a class="btn btn-narrow btn-icon-only" href="${esc(project.prodUrl)}" target="_blank" rel="noopener" title="Сайт"><i data-icon="globe"></i></a>` : ''}
          </div>
        </div>
      </article>
    `;
  }).join('') + '</div>';
  mountIcons(list);
}

// --- задачи ---

function scopeTasks(scope) {
  const open = state.tasks.filter(t => t.status !== 'done');
  if (scope === 'today') return open.filter(t => t.due && dayDiff(t.due) <= 0);
  if (scope === 'week') return open.filter(t => t.due && dayDiff(t.due) <= 7);
  if (scope === 'overdue') return open.filter(isOverdue);
  return open;
}

// выполненные, уместные на текущей странице: «сегодня» — закрытые сегодня или со сроком
// на сегодня, «неделя» — закрытые за последние семь дней, «просрочено» — закрытые после срока
function doneTasks() {
  const done = state.tasks.filter(t => t.status === 'done');
  const daysAgo = (t) => t.doneAt ? -dayDiff(t.doneAt) : Infinity;
  let picked = done;
  if (state.scope === 'today') picked = done.filter(t => daysAgo(t) === 0 || (t.due && dayDiff(t.due) === 0));
  else if (state.scope === 'week') picked = done.filter(t => daysAgo(t) <= 7);
  else if (state.scope === 'overdue') picked = done.filter(t => t.due && t.doneAt && new Date(t.doneAt) > toDate(t.due));
  return picked.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  const tasks = scopeTasks(state.scope).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const done = doneTasks();
  if (!tasks.length && !done.length) {
    list.innerHTML = '<div class="empty">Задач нет — чисто</div>';
    return;
  }

  let html = tasks.length ? openGroups(tasks) : '<div class="empty empty-short">Открытых задач нет</div>';
  if (done.length) {
    const shown = done.slice(0, state.doneLimit);
    const rest = done.length - shown.length;
    html += `<div class="group-title">Выполнено<span>${done.length}</span></div>`
      + `<div class="group">${shown.map(taskRow).join('')}</div>`;
    if (rest > 0 || state.doneLimit > 3) {
      html += '<div class="more-row">'
        + (rest > 0 ? `<button class="more-btn" data-more="more">Ещё ${Math.min(rest, 5)}</button>` : '')
        + (state.doneLimit > 3 ? `<button class="more-btn more-collapse" data-more="less">Свернуть</button>` : '')
        + '</div>';
    }
  }
  list.innerHTML = html;
}

function openGroups(tasks) {
  const groups = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] };
  for (const task of tasks) {
    if (!task.due) groups.none.push(task);
    else if (isOverdue(task)) groups.overdue.push(task);
    else if (dayDiff(task.due) === 0) groups.today.push(task);
    else if (dayDiff(task.due) === 1) groups.tomorrow.push(task);
    else if (dayDiff(task.due) <= 7) groups.week.push(task);
    else groups.later.push(task);
  }
  const titles = { overdue: 'Просрочено', today: 'Сегодня', tomorrow: 'Завтра', week: 'На неделе', later: 'Позже', none: 'Без срока' };
  return Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([key, items]) => `
      <div class="group-title${key === 'overdue' ? ' alert' : ''}">${titles[key]}<span>${items.length}</span></div>
      <div class="group">${items.map(taskRow).join('')}</div>
    `).join('');
}

function taskRow(task) {
  // выполненная задача сворачивается до заголовка и проекта
  const isDone = task.status === 'done';
  const project = state.projects.find(p => p.id === task.projectId);
  const meta = [];
  const taskStage = task.stage || 'todo';
  if (!isDone && taskStage !== 'todo') meta.push(`<span class="task-stage-pill is-${taskStage}">${STAGE_TITLES[taskStage]}</span>`);
  if (task.due && !isDone) meta.push(`<span class="task-due">${humanDue(task.due)}</span>`);
  if (project) meta.push(`<span>${esc(project.name)}</span>`);
  const stage = project && (project.milestones || []).find(s => s.id === task.milestoneId);
  if (stage && !isDone) meta.push(`<span class="task-stage">${esc(stage.title)}</span>`);
  const steps = task.checklist || [];
  if (steps.length && !isDone) {
    const done = steps.filter(st => st.done).length;
    meta.push(`<span class="task-steps${done === steps.length ? ' complete' : ''}"><i style="--p:${Math.round(done / steps.length * 100)}%"></i>${done}/${steps.length}</span>`);
  }
  if (task.external) {
    meta.push(`<span class="task-source">${esc(SOURCE_TITLES[task.external.kind] || task.external.kind)}${task.external.list ? ` · ${esc(task.external.list)}` : ''}</span>`);
  }
  const comments = (task.comments || []).length;
  if (comments && !isDone) meta.push(`<span class="task-comments">${ICONS.chat}${comments}</span>`);
  const row = `
    <article class="task swipe-body${isOverdue(task) ? ' overdue' : ''}${isDone ? ' done' : ''}" data-id="${esc(task.id)}">
      <button class="check" data-act="done"></button>
      <div class="task-body" data-act="open">
        <div class="task-title">${task.priority === 'high' && !isDone ? '<span class="task-flag">● </span>' : ''}${esc(task.title)}</div>
        ${task.notes && !isDone ? `<div class="task-notes">${esc(task.notes)}</div>` : ''}
        ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      </div>
    </article>
  `;
  if (task.external) return row;          // зеркало чужого трекера — менять нечего
  const isHigh = task.priority === 'high';
  const mark = isDone
    ? `<button class="swipe-act" data-swipe="reopen" data-id="${esc(task.id)}" title="Вернуть">${ICONS.reload}</button>`
    : `<button class="swipe-act${isHigh ? ' is-on' : ''}" data-swipe="flag" data-id="${esc(task.id)}" title="${isHigh ? 'Сделать обычной' : 'Сделать важной'}">${ICONS.flag}</button>`;
  return `<div class="swipe">
    <div class="swipe-actions">
      ${mark}
      <button class="swipe-act danger" data-swipe="drop" data-id="${esc(task.id)}" title="Удалить">${ICONS.trash}</button>
    </div>
    ${row}
  </div>`;
}

function renderCounts() {
  const counts = {
    all: scopeTasks('all').length,
    today: scopeTasks('today').length,
    week: scopeTasks('week').length,
    overdue: scopeTasks('overdue').length
  };
  document.querySelectorAll('#task-chips .chip').forEach(chip => {
    const badge = chip.querySelector('span');
    if (badge) badge.textContent = counts[chip.dataset.scope] ?? 0;
  });
  const badge = document.getElementById('tab-badge');
  const urgent = counts.overdue || counts.today;
  badge.textContent = urgent;
  badge.hidden = !urgent;
}

// --- календарь ---

const CAT_LABEL = { work: 'Работа', call: 'Созвон', personal: 'Личное', other: 'Другое', task: 'Задача', milestone: 'Этап проекта' };

// событие или задача на дату в одной форме
function itemsOn(key) {
  const out = [];
  for (const e of state.events) {
    if (e.status === 'canceled' || (e.at || '').slice(0, 10) !== key) continue;
    out.push({ id: e.id, kind: 'event', raw: e, title: e.title, at: e.at, allDay: !!e.allDay,
      minutes: e.durationMin || 60, category: e.category || 'work', done: e.status === 'done', location: e.location });
  }
  for (const t of state.tasks) {
    if (!t.due || t.due.slice(0, 10) !== key) continue;
    out.push({ id: t.id, kind: 'task', raw: t, title: t.title, at: t.due, allDay: !t.due.includes('T'),
      minutes: 30, category: 'task', done: t.status === 'done', overdue: isOverdue(t) });
  }
  // вехи проектов: этапы и общий дедлайн, задаются в настройках проекта на компьютере
  for (const p of state.projects) {
    for (const stage of p.milestones || []) {
      if (stage.due !== key) continue;
      out.push({ id: `ms:${p.id}:${stage.id}`, kind: 'project', raw: p, title: `${p.name}: ${stage.title}`,
        at: key, allDay: true, minutes: 0, category: 'milestone', done: !!stage.done });
    }
    if (p.deadline === key) {
      out.push({ id: `dl:${p.id}`, kind: 'project', raw: p, title: `${p.name}: дедлайн проекта`,
        at: key, allDay: true, minutes: 0, category: 'milestone', done: p.status === 'done' || p.status === 'archived' });
    }
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? a.at.localeCompare(b.at) : a.allDay ? -1 : 1));
}

function renderCalendar() {
  const cursor = state.calCursor;
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  document.getElementById('cal-month-title').textContent = `${MONTHS_NOM[first.getMonth()]} ${first.getFullYear()}`;

  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const todayKey = ymd(new Date());
  if (!state.calSelected) state.calSelected = todayKey;

  let cells = WD_HEAD.map(d => `<span class="cal-wd">${d}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = ymd(day);
    const dots = itemsOn(key).slice(0, 3).map(it => `<i class="cat-${it.category}"></i>`).join('');
    cells += `<button class="cal-day${day.getMonth() !== first.getMonth() ? ' other' : ''}${key === todayKey ? ' today' : ''}${key === state.calSelected ? ' selected' : ''}" data-date="${key}">
      <span>${day.getDate()}</span><em>${dots}</em></button>`;
  }
  document.getElementById('cal-month').innerHTML = cells;

  // лента дней месяца с событиями — как «Расписание» в Google Календаре
  const agenda = document.getElementById('cal-agenda');
  const monthEnd = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const days = [];
  for (let d = new Date(first); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const key = ymd(d);
    const items = itemsOn(key);
    if (items.length || key === state.calSelected) days.push({ key, date: new Date(d), items });
  }

  if (!days.length) {
    agenda.innerHTML = '<div class="empty">В этом месяце пока пусто</div>';
    return;
  }

  agenda.innerHTML = days.map(({ key, date, items }) => `
    <section class="agenda-day${key === state.calSelected ? ' selected' : ''}" id="agenda-${key}">
      <div class="agenda-date${key === todayKey ? ' today' : ''}">
        <b>${date.getDate()}</b><span>${WD[date.getDay()]}</span>
      </div>
      <div class="agenda-items">
        ${items.length ? items.map(agendaItem).join('') : '<button class="agenda-empty" data-new-on="' + key + '">Ничего не запланировано — добавить</button>'}
      </div>
    </section>
  `).join('');
}

function agendaItem(it) {
  const time = it.allDay ? 'Весь день' : it.at.slice(11, 16) + (it.kind === 'event' ? ' – ' + endTime(it.at, it.minutes) : '');
  const sub = [it.kind === 'task' ? 'Задача' : CAT_LABEL[it.category], it.location].filter(Boolean).join(' · ');
  return `
    <button class="agenda-item cat-${it.category}${it.done ? ' done' : ''}${it.overdue ? ' overdue' : ''}" data-item="${esc(it.id)}">
      <span class="agenda-time">${time}</span>
      <span class="agenda-title">${esc(it.title)}</span>
      <span class="agenda-sub">${esc(sub)}</span>
    </button>`;
}

function endTime(at, minutes) {
  const [h, m] = at.slice(11, 16).split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

function findItem(id) {
  const event = state.events.find(e => e.id === id);
  if (event) return { kind: 'event', item: event };
  const task = state.tasks.find(t => t.id === id);
  return task ? { kind: 'task', item: task } : null;
}

// --- сессии ---

function renderSessions() {
  const list = document.getElementById('sessions-list');
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty">Недавних сессий нет</div>';
    return;
  }
  list.innerHTML = '<div class="group">' + state.sessions.map(session => `
    <article class="card" data-session="${esc(session.sessionId)}">
      <div class="card-head">
        ${avatarHtml(state.projects.find(p => p.id === session.projectId), session.tabColor || '#3a3a42', session.projectName)}
        <div class="card-titles">
          <div class="card-name">${esc(session.projectName)}</div>
          <div class="card-sub">${ago(session.at)} · ${esc(session.prompt.slice(0, 60))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-run btn-wide" data-act="resume"><i data-icon="terminal"></i>Продолжить</button>
      </div>
    </article>
  `).join('') + '</div>';
  mountIcons(list);
}

// --- панель подробностей ---

// Пока шторка открыта, страница под ней не должна ехать: фиксируем body
// на текущей прокрутке и возвращаем её при закрытии.
// textarea подгоняет высоту под содержимое; дальше 45% экрана — прокрутка внутри поля
function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  const border = el.offsetHeight - el.clientHeight;  // при border-box высоту надо задавать с учётом рамки
  el.style.height = Math.min(el.scrollHeight + border, Math.round(window.innerHeight * 0.45)) + 'px';
}

let lockedScrollY = 0;
function lockScroll(on) {
  const root = document.getElementById('app-root');
  if (on) {
    if (document.body.classList.contains('sheet-open')) return;
    lockedScrollY = window.scrollY;
    root.style.top = `-${lockedScrollY}px`;
    document.body.classList.add('sheet-open');
  } else {
    if (!document.body.classList.contains('sheet-open')) return;
    document.body.classList.remove('sheet-open');
    root.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }
}

const sheet = {
  el: () => document.getElementById('sheet'),

  open(kind, item, defaults = {}) {
    state.sheet = { kind, item: item || null, steps: (item?.checklist || []).map(st => ({ ...st })) };
    this.renderSteps();
    const isNew = !item;
    const isEvent = kind === 'event';

    document.getElementById('sheet-tabs').hidden = !isNew;
    document.getElementById('sheet-kind').hidden = true;   // подпись типа в шапке не нужна
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.toggle('active', t.dataset.kind === kind));
    document.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== kind; });

    const select = document.getElementById('f-project');
    select.innerHTML = '<option value="">Без проекта</option>' +
      state.projects.filter(p => p.status !== 'archived').map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');

    const when = item ? (isEvent ? item.at : item.due) : (defaults.at || defaults.due || '');
    document.getElementById('f-title').value = item?.title || '';
    document.getElementById('f-title').placeholder = isEvent ? 'Что за событие' : 'Что сделать';
    document.getElementById('f-date').value = when ? when.slice(0, 10) : '';
    document.getElementById('f-time').value = when && when.includes('T') ? when.slice(11, 16) : '';
    document.getElementById('f-duration').value = item?.durationMin && item.durationMin < 1440 ? item.durationMin : 60;
    document.getElementById('f-allday').checked = !!item?.allDay;
    document.getElementById('f-project').value = item?.projectId || '';
    this.fillMilestones(item?.projectId || '', item?.milestoneId || '');
    document.getElementById('f-category').value = item?.category || 'work';
    document.getElementById('f-location').value = item?.location || '';
    document.getElementById('f-priority').checked = item?.priority === 'high';
    document.getElementById('f-stage').value = item?.stage || (item?.status === 'done' ? 'done' : 'todo');
    document.getElementById('f-notes').value = item?.notes || '';
    this.syncAllDay();

    const done = item && item.status === 'done';
    const external = item?.external || null;
    document.getElementById('f-delete').hidden = isNew || !!external;
    const doneBtn = document.getElementById('f-done');
    doneBtn.hidden = isNew;
    doneBtn.classList.toggle('is-done', !!done);
    doneBtn.title = done ? 'Вернуть в работу' : (isEvent ? 'Отметить прошедшим' : 'Выполнено');
    document.getElementById('f-save').title = isNew ? 'Создать' : 'Сохранить';
    document.getElementById('f-save').hidden = !!external;

    this.applyExternal(external);
    document.getElementById('f-comments').hidden = isEvent || isNew;
    this.renderComments(item?.comments || []);
    document.getElementById('f-comment-add').value = '';

    this.el().hidden = false;
    document.getElementById('sheet-backdrop').hidden = false;
    this.el().classList.toggle('readonly', state.offline);
    this.el().querySelector('.sheet-body').scrollTop = 0;
    // высоту заметок и поля комментария считаем на следующем кадре — на видимой и устоявшейся шторке
    requestAnimationFrame(() => {
      autosize(document.getElementById('f-notes'));
      autosize(document.getElementById('f-comment-add'));
    });
    lockScroll(true);
    if (isNew) setTimeout(() => document.getElementById('f-title').focus(), 120);
  },

  close() {
    this.el().hidden = true;
    document.getElementById('sheet-backdrop').hidden = true;
    state.sheet.item = null;
    lockScroll(false);
  },

  // этапы есть не у всех проектов — поле показываем только когда есть из чего выбрать
  fillMilestones(projectId, selected) {
    const stages = (state.projects.find(p => p.id === projectId)?.milestones) || [];
    const field = document.getElementById('f-milestone-field');
    const select = document.getElementById('f-milestone');
    field.hidden = state.sheet.kind !== 'task' || !stages.length;
    select.innerHTML = '<option value="">Без этапа</option>' + stages.map(st =>
      `<option value="${esc(st.id)}">${esc(st.title)}${st.due ? ` · ${humanDue(st.due)}` : ''}</option>`).join('');
    select.value = stages.some(st => st.id === selected) ? selected : '';
  },

  renderSteps() {
    const list = document.getElementById('f-check-list');
    const steps = state.sheet.steps;
    list.innerHTML = steps.map(st => `
      <li class="f-check-item${st.done ? ' done' : ''}" data-step="${esc(st.id)}">
        <input type="checkbox" ${st.done ? 'checked' : ''}>
        <input type="text" value="${esc(st.text)}">
        <button type="button" class="f-check-remove" data-act="remove">&times;</button>
      </li>`).join('');
    const done = steps.filter(st => st.done).length;
    document.getElementById('f-check-progress').textContent = steps.length ? `${done} из ${steps.length}` : '';
  },

  syncAllDay() {
    const allDay = state.sheet.kind === 'event' && document.getElementById('f-allday').checked;
    document.getElementById('f-time-field').hidden = allDay;
    document.getElementById('f-duration-field').hidden = allDay || state.sheet.kind !== 'event';
  },

  // Задача из Trello или админки: поля показываем как есть, править нельзя — источник главнее
  applyExternal(external) {
    this.el().classList.toggle('external', !!external);
    const body = this.el().querySelector('.sheet-body');
    body.querySelectorAll('input, select, textarea').forEach(el => {
      // у чужой задачи можно менять только стадию и писать комментарии
      if (el.id === 'f-comment-add' || el.id === 'f-stage') return;
      el.disabled = !!external;
    });
    body.querySelectorAll('#f-check-list input[type="checkbox"]').forEach(el => { el.disabled = !!external; });
    // у чужой задачи без срока и без шагов пустые поля показывать нечего
    const item = state.sheet.item;
    document.getElementById('f-date').closest('.f-row').hidden = !!external && !item?.due;
    document.querySelector('.f-checklist').hidden = !!external && !state.sheet.steps.length;
    document.getElementById('f-priority').closest('.switch-row').hidden = !!external;
    const banner = document.getElementById('f-external');
    banner.hidden = !external;
    if (!external) return;
    const title = SOURCE_TITLES[external.kind] || external.kind;
    document.getElementById('f-external-text').textContent =
      `${title}${external.list ? ` › ${external.list}` : ''} — правится там, здесь можно закрыть и прокомментировать`;
    document.getElementById('f-external-link').href = external.url || '#';
  },

  renderComments(comments) {
    document.getElementById('f-comment-list').innerHTML = comments.map(c => `
      <li class="comment${c.mine ? ' is-mine' : ''}">
        <div class="comment-head"><span class="comment-author${c.author === 'claude' ? ' is-claude' : ''}">${c.author === 'claude' ? `${ICONS.claude}Claude · ${esc((c.session || '').slice(0, 8) || '?')}` : (c.mine ? 'Вы' : esc(c.author || '—'))}</span><span>${humanStamp(c.at)}</span>${c.pending ? '<span class="comment-pending">отправляется…</span>' : ''}</div>
        <div class="comment-text">${esc(c.text)}</div>
      </li>`).join('');
    document.getElementById('f-comments-count').textContent = comments.length || '';
  },

  async addComment() {
    const { item } = state.sheet;
    const box = document.getElementById('f-comment-add');
    const text = box.value.trim();
    if (!item || !text || blocked()) return;
    try {
      const res = await api('/api/comment', 'POST', { id: item.id, text });
      if (!res.ok) { toast(res.error || 'Не отправилось'); return; }
      item.comments = [...(item.comments || []), res.comment];
      box.value = '';
      autosize(box);
      this.renderComments(item.comments);
      if (res.comment.pending) toast('Уйдёт в трекер через минуту');
    } catch {
      toast('Компьютер недоступен');
    }
  },

  collect() {
    const title = document.getElementById('f-title').value.trim();
    if (!title) { document.getElementById('f-title').focus(); return null; }
    const date = document.getElementById('f-date').value;
    const time = document.getElementById('f-time').value;
    const projectId = document.getElementById('f-project').value;
    const notes = document.getElementById('f-notes').value.trim();

    if (state.sheet.kind === 'event') {
      if (!date) { toast('У события нужна дата'); return null; }
      const allDay = document.getElementById('f-allday').checked;
      return {
        title, projectId, notes, allDay,
        at: allDay ? `${date}T00:00` : `${date}T${time || '10:00'}`,
        durationMin: allDay ? 1440 : parseInt(document.getElementById('f-duration').value, 10),
        category: document.getElementById('f-category').value,
        location: document.getElementById('f-location').value.trim()
      };
    }
    return {
      title, projectId, notes,
      due: date ? (time ? `${date}T${time}` : date) : '',
      priority: document.getElementById('f-priority').checked ? 'high' : 'normal',
      stage: document.getElementById('f-stage').value,
      milestoneId: document.getElementById('f-milestone').value,
      checklist: state.sheet.steps.filter(st => st.text.trim()).map(st => ({ id: st.id, text: st.text.trim(), done: !!st.done }))
    };
  },

  async save() {
    if (blocked() || state.sheet.item?.external) return;
    const payload = this.collect();
    if (!payload) return;
    const { kind, item } = state.sheet;
    try {
      if (item) {
        const res = await api('/api/update', 'POST', { id: item.id, patch: payload });
        if (!res.ok) { toast(res.error || 'Не сохранилось'); return; }
        Object.assign(item, res.item || payload);
        toast('Сохранено');
      } else if (kind === 'event') {
        const res = await api('/api/event', 'POST', { ...payload, at: payload.at, duration: payload.durationMin });
        if (!res.ok) { toast(res.error || 'Не получилось'); return; }
        state.events.push(res.event);
        toast('Событие добавлено');
      } else {
        const res = await api('/api/task', 'POST', payload);
        if (!res.ok) { toast(res.error || 'Не получилось'); return; }
        state.tasks.push(res.task);
        toast('Задача создана');
      }
      this.close();
      renderAll();
    } catch {
      toast('Компьютер недоступен');
    }
  },

  async toggleDone() {
    const { item } = state.sheet;
    if (!item || blocked()) return;
    const done = item.status === 'done';
    try {
      await api(done ? '/api/reopen' : '/api/done', 'POST', { id: item.id });
      item.status = done ? (state.sheet.kind === 'event' ? 'planned' : 'open') : 'done';
      this.close();
      renderAll();
    } catch {
      toast('Не удалось');
    }
  },

  async remove() {
    const { item, kind } = state.sheet;
    if (!item || blocked() || item.external) return;
    try {
      const res = await api('/api/delete', 'POST', { id: item.id });
      if (!res.ok) { toast(res.error || 'Не удалось удалить'); return; }
      if (kind === 'event') state.events = state.events.filter(e => e.id !== item.id);
      else state.tasks = state.tasks.filter(t => t.id !== item.id);
      this.close();
      renderAll();
      toast('Удалено');
    } catch {
      toast('Не удалось удалить');
    }
  }
};

// --- события интерфейса ---

function blocked() {
  if (!state.offline) return false;
  toast('Нет связи с компьютером — только просмотр');
  return true;
}

document.getElementById('projects-list').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-project]');
  const action = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !action || blocked()) return;
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
  if (!card || !e.target.closest('[data-act="resume"]') || blocked()) return;
  const session = state.sessions.find(s => s.sessionId === card.dataset.session);
  if (!session) return;
  try {
    await api('/api/session', 'POST', { cwd: session.cwd, sessionId: session.sessionId, title: session.projectName, tabColor: session.tabColor });
    toast('Сессия открывается');
  } catch {
    toast('Не получилось открыть сессию');
  }
});

async function flagTask(task) {
  const priority = task.priority === 'high' ? 'normal' : 'high';
  try { await api('/api/update', 'POST', { id: task.id, patch: { priority } }); } catch {}
  task.priority = priority;
  renderTasks();
}

async function dropTask(task) {
  try { await api('/api/delete', 'POST', { id: task.id }); } catch {}
  state.tasks = state.tasks.filter(t => t.id !== task.id);
  renderAll();
  toast('Задача удалена');
}

document.getElementById('tasks-list').addEventListener('click', async (e) => {
  const swiped = e.target.closest('[data-swipe]');
  if (swiped) {
    if (blocked()) return;
    const task = state.tasks.find(t => t.id === swiped.dataset.id);
    closeSwipe();
    if (!task) return;
    if (swiped.dataset.swipe === 'flag') return flagTask(task);
    if (swiped.dataset.swipe === 'drop') return dropTask(task);
    try { await api('/api/reopen', 'POST', { id: task.id }); } catch {}
    task.status = 'open';
    return renderAll();
  }
  // открытую строку первый тап только закрывает
  if (openSwipe && e.target.closest('.swipe') === openSwipe) { closeSwipe(); return; }
  closeSwipe();

  const more = e.target.closest('[data-more]');
  if (more) {
    state.doneLimit = more.dataset.more === 'less' ? 3 : state.doneLimit + 5;
    renderTasks();
    return;
  }
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const task = state.tasks.find(t => t.id === row.dataset.id);
  if (!task) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'done') {
    if (blocked()) return;
    const done = task.status === 'done';
    row.classList.toggle('done', !done);
    try {
      await api(done ? '/api/reopen' : '/api/done', 'POST', { id: task.id });
      task.status = done ? 'open' : 'done';
      renderAll();
    } catch {
      row.classList.toggle('done', done);
      toast('Не удалось отметить');
    }
  } else if (act === 'open') {
    sheet.open('task', task);
  }
});

document.getElementById('cal-month').addEventListener('click', (e) => {
  const day = e.target.closest('[data-date]');
  if (!day) return;
  state.calSelected = day.dataset.date;
  renderCalendar();
  document.getElementById(`agenda-${day.dataset.date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('cal-agenda').addEventListener('click', (e) => {
  const item = e.target.closest('[data-item]');
  if (item) {
    if (/^(ms|dl):/.test(item.dataset.item)) {
      toast('Этапы проекта меняются в настройках проекта на компьютере');
      return;
    }
    const found = findItem(item.dataset.item);
    if (found) sheet.open(found.kind, found.item);
    return;
  }
  const empty = e.target.closest('[data-new-on]');
  if (empty && !blocked()) sheet.open('event', null, { at: `${empty.dataset.newOn}T10:00` });
});

document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
document.getElementById('cal-month-btn').addEventListener('click', () => shiftMonth(0, true));
document.getElementById('cal-today').addEventListener('click', () => {
  state.calCursor = new Date();
  state.calSelected = ymd(new Date());
  renderCalendar();
  document.getElementById(`agenda-${state.calSelected}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function shiftMonth(direction, toggleGrid) {
  if (toggleGrid) {
    document.getElementById('cal-month').classList.toggle('collapsed');
    document.getElementById('cal-month-btn').classList.toggle('collapsed');
    return;
  }
  const d = new Date(state.calCursor);
  d.setMonth(d.getMonth() + direction, 1);
  state.calCursor = d;
  state.calSelected = ymd(d);
  renderCalendar();
}

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
  state.doneLimit = 3;
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
      { projects: 'Проекты', tasks: 'Задачи', calendar: 'Календарь', sessions: 'Сессии', notes: 'Заметки' }[state.screen];
    document.getElementById('btn-add').hidden = !(state.screen === 'tasks' || state.screen === 'calendar');
    document.getElementById('notes-bar').hidden = state.screen !== 'notes';
    if (state.screen !== 'notes') document.body.classList.remove('searching');
    window.scrollTo(0, 0);
  });
});

document.getElementById('btn-add').addEventListener('click', () => {
  if (blocked()) return;
  if (state.screen === 'calendar') sheet.open('event', null, { at: `${state.calSelected || ymd(new Date())}T10:00` });
  else sheet.open('task', null);
});

// --- заметки ---

function noteCard(n) {
  const title = esc((n.title || '').trim() || 'Без заголовка');
  const snippet = esc((n.body || '').replace(/^#\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 80));
  return `<div class="swipe">
    <div class="swipe-actions">
      <button class="swipe-act" data-swipe="pin" data-id="${esc(n.id)}" title="${n.pinned ? 'Открепить' : 'Закрепить'}">${n.pinned ? ICONS['pin-off'] : ICONS.pin}</button>
      <button class="swipe-act danger" data-swipe="delete" data-id="${esc(n.id)}" title="Удалить">${ICONS.trash}</button>
    </div>
    <button class="note-card swipe-body" data-note="${esc(n.id)}">
      <div class="note-card-title">${title}</div>
      <div class="note-card-sub"><span class="note-card-when">${noteWhen(n.updatedAt)}</span>${snippet ? '&nbsp;&nbsp;' + snippet : ''}</div>
    </button>
  </div>`;
}

// дата в строке списка: время для сегодняшних, день недели для недавних, дальше — число
function noteWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const days = daysBack(d);
  if (days <= 0) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'вчера';
  if (days <= 7) return WD_FULL[d.getDay()];
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function daysBack(d) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const own = new Date(d);
  own.setHours(0, 0, 0, 0);
  return Math.round((midnight - own) / 86400000);
}

// секции как в «Заметках»: закреплённые, затем по давности правки
function noteBucket(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Ранее';
  const days = daysBack(d);
  if (days <= 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days <= 7) return 'Последние 7 дней';
  if (days <= 30) return 'Последние 30 дней';
  const month = d.toLocaleDateString('ru-RU', { month: 'long' });
  const title = month[0].toUpperCase() + month.slice(1);
  return d.getFullYear() === new Date().getFullYear() ? title : `${title} ${d.getFullYear()}`;
}

function notesPlural(n) {
  const tail = n % 100 > 4 && n % 100 < 21 ? 0 : [0, 1, 2, 2, 2][Math.min(n % 10, 4)];
  return `${n} ${['заметок', 'заметка', 'заметки'][tail]}`;
}

function section(title, notes) {
  return `<div class="group-title">${title}</div><div class="group">${notes.map(noteCard).join('')}</div>`;
}

function trashCard(n) {
  const title = esc((n.title || '').trim() || 'Без заголовка');
  const left = 30 - Math.floor((Date.now() - new Date(n.deletedAt).getTime()) / 86400000);
  return `<div class="note-card trashed">
    <div class="note-card-head"><span class="note-card-title">${title}</span><span class="note-card-when">${left <= 1 ? 'удалится сегодня' : `ещё ${left} дн.`}</span></div>
    <div class="trash-actions">
      <button data-restore="${esc(n.id)}">Восстановить</button>
      <button class="danger" data-purge="${esc(n.id)}">Удалить</button>
    </div>
  </div>`;
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  const all = state.notes || [];
  const trash = state.notesTrash || [];
  document.getElementById('notes-count').textContent = notesPlural(all.length);

  const query = (state.noteQuery || '').trim().toLowerCase();
  const notes = query
    ? all.filter(n => (n.title + ' ' + n.body).toLowerCase().includes(query))
    : all;

  let html;
  if (!notes.length) {
    html = `<div class="empty">${query ? 'Ничего не нашлось' : 'Заметок пока нет'}</div>`;
  } else if (query) {
    html = `<div class="group">${notes.map(noteCard).join('')}</div>`;
  } else {
    const pinned = notes.filter(n => n.pinned);
    html = pinned.length ? section('Закреплённые', pinned) : '';
    const buckets = new Map();
    for (const note of notes.filter(n => !n.pinned)) {
      const key = noteBucket(note.updatedAt);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(note);
    }
    for (const [title, items] of buckets) html += section(title, items);
  }

  if (trash.length && !query) {
    html += `<button class="notes-trash-toggle">${state.showTrash ? 'Скрыть корзину' : `Корзина · ${trash.length}`}</button>`;
    if (state.showTrash) html += `<div class="group">${trash.map(trashCard).join('')}</div>`;
  }
  list.innerHTML = html;
}

function sortNotes() {
  state.notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  state.notes.sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1));
}

function noteDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return time;
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${date} в ${time}`;
}

// заголовок растёт по содержимому: в textarea высоту задаём вручную
function fitTitle() {
  const el = document.getElementById('n-title');
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// строка, начинающаяся с «# », — заголовок раздела внутри заметки
const NOTE_HEAD = /^#\s+\S/;

// Редактор — не textarea: каждая строка отдельным блоком, чтобы заголовок было видно
// крупнее прямо при наборе. В хранилище всё равно уходит обычный текст.
function lineNode(text) {
  const line = document.createElement('div');
  line.className = NOTE_HEAD.test(text) ? 'note-line note-h' : 'note-line';
  line.textContent = text;
  return line;
}

function fillBody(text) {
  const box = document.getElementById('n-body');
  box.innerHTML = '';
  for (const line of (text || '').split('\n')) box.appendChild(lineNode(line));
  if (!box.firstChild) box.appendChild(lineNode(''));
}

function readBody() {
  return [...document.getElementById('n-body').children].map(n => n.textContent).join('\n');
}

// переключение класса не трогает выделение, поэтому курсор при наборе не прыгает
function markHeads() {
  for (const line of document.getElementById('n-body').children) {
    line.classList.add('note-line');
    line.classList.toggle('note-h', NOTE_HEAD.test(line.textContent));
  }
}

const noteEditor = {
  id: null, pinned: false, saveTimer: null, active: false, creating: null,
  open(note) {
    this.active = true;
    this.id = note ? note.id : null;
    this.pinned = note ? !!note.pinned : false;
    document.getElementById('n-title').value = note ? (note.title || '') : '';
    fillBody(note ? note.body : '');
    document.getElementById('n-delete').hidden = !note;
    document.getElementById('n-date').textContent = noteDate(note && note.updatedAt);
    this._reflectPin();
    fitTitle();
    document.getElementById('note-page').classList.add('open');
    document.getElementById('app-root').classList.add('pushed');
    // фокус после переезда, иначе клавиатура дёргает анимацию
    if (!note) setTimeout(() => document.getElementById('n-title').focus(), 480);
  },
  // создаём заметку под черновик ровно один раз: два сохранения подряд ловили
  // this.id === null и заводили две копии
  _ensure() {
    if (this.id) return Promise.resolve(this.id);
    if (state.offline) return Promise.resolve(null);
    if (!this.creating) {
      this.creating = api('/api/note-create', 'POST', { title: '', body: '' })
        .then(res => {
          if (res && res.ok) { this.id = res.note.id; state.notes.unshift(res.note); }
          return this.id;
        })
        .catch(() => this.id)
        .finally(() => { this.creating = null; });
    }
    return this.creating;
  },
  async save() {
    // редактор закрыт, а поля ещё хранят текст: iOS досылает input при уходе
    // клавиатуры, и такое сохранение заводило копию заметки
    if (!this.active || state.offline) return;
    const title = document.getElementById('n-title').value;
    const body = readBody();
    if (!this.id && !title.trim() && !body.trim()) return;   // пустую новую не создаём
    await this._ensure();
    if (!this.id) return;
    try {
      const res = await api('/api/note-update', 'POST', { id: this.id, title, body });
      if (res && res.ok && res.note) {
        const i = state.notes.findIndex(n => n.id === this.id);
        if (i >= 0) state.notes[i] = res.note;
        if (this.active) document.getElementById('n-date').textContent = noteDate(res.note.updatedAt);
      }
    } catch {}
  },
  schedule() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 700); },
  _reflectPin() {
    const btn = document.getElementById('n-pin');
    btn.classList.toggle('is-pinned', this.pinned);
    btn.title = this.pinned ? 'Открепить' : 'Закрепить';
  },
  async togglePin() {
    if (blocked()) return;
    await this._ensure();
    if (!this.id) return;
    this.pinned = !this.pinned;
    this._reflectPin();
    try {
      const res = await api('/api/note-update', 'POST', { id: this.id, pinned: this.pinned });
      if (res && res.ok && res.note) { const i = state.notes.findIndex(n => n.id === this.id); if (i >= 0) state.notes[i] = res.note; }
    } catch {}
  },
  async remove() {
    if (blocked()) return;
    if (!this.id) { this._hide(); return; }
    clearTimeout(this.saveTimer);
    const gone = state.notes.find(n => n.id === this.id);
    try { await api('/api/note-delete', 'POST', { id: this.id }); } catch {}
    state.notes = state.notes.filter(n => n.id !== this.id);
    if (gone) state.notesTrash.unshift({ ...gone, pinned: false, deletedAt: new Date().toISOString() });
    this._hide();
    renderNotes();
    toast('Заметка в корзине');
  },
  async close() {
    clearTimeout(this.saveTimer);
    await this.save();
    this._hide();
    sortNotes();
    renderNotes();
  },
  _hide() {
    this.active = false;
    this.id = null;
    // поля чистим здесь же, иначе запоздалый input сохранит текст уже в новую заметку
    document.getElementById('n-title').value = '';
    fillBody('');
    document.getElementById('note-outline').hidden = true;
    document.getElementById('note-page').classList.remove('open');
    document.getElementById('app-root').classList.remove('pushed');
  }
};

async function pinNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  const pinned = !note.pinned;
  try { await api('/api/note-update', 'POST', { id, pinned }); } catch {}
  note.pinned = pinned;
  sortNotes();
  renderNotes();
  toast(pinned ? 'Закреплено' : 'Откреплено');
}

async function trashNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  try { await api('/api/note-delete', 'POST', { id }); } catch {}
  state.notes = state.notes.filter(n => n.id !== id);
  state.notesTrash.unshift({ ...note, pinned: false, deletedAt: new Date().toISOString() });
  renderNotes();
  toast('Заметка в корзине');
}

document.getElementById('notes-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-swipe]');
  if (act) {
    if (blocked()) return;
    closeSwipe();
    return act.dataset.swipe === 'pin' ? pinNote(act.dataset.id) : trashNote(act.dataset.id);
  }
  // открытую строку первый тап только закрывает
  if (openSwipe && e.target.closest('.swipe') === openSwipe) { closeSwipe(); return; }
  closeSwipe();

  if (e.target.closest('.notes-trash-toggle')) {
    state.showTrash = !state.showTrash;
    return renderNotes();
  }
  const back = e.target.closest('[data-restore]');
  if (back) {
    if (blocked()) return;
    const id = back.dataset.restore;
    try { await api('/api/note-restore', 'POST', { id }); } catch {}
    const note = state.notesTrash.find(n => n.id === id);
    state.notesTrash = state.notesTrash.filter(n => n.id !== id);
    if (note) { delete note.deletedAt; state.notes.unshift(note); sortNotes(); }
    renderNotes();
    return toast('Заметка восстановлена');
  }
  const kill = e.target.closest('[data-purge]');
  if (kill) {
    if (blocked()) return;
    if (!confirm('Удалить навсегда? Восстановить будет нельзя.')) return;
    const id = kill.dataset.purge;
    try { await api('/api/note-purge', 'POST', { id }); } catch {}
    state.notesTrash = state.notesTrash.filter(n => n.id !== id);
    return renderNotes();
  }
  const card = e.target.closest('.note-card');
  if (!card || card.classList.contains('trashed')) return;
  const note = (state.notes || []).find(n => n.id === card.dataset.note);
  if (note) noteEditor.open(note);
});
document.getElementById('notes-compose').addEventListener('click', () => {
  if (!blocked()) noteEditor.open(null);
});
(() => {
  const input = document.getElementById('notes-search');
  const cancel = document.getElementById('notes-cancel');
  const bar = document.getElementById('notes-bar');
  const viewport = window.visualViewport;

  // Пока открыта клавиатура, iOS перестаёт держать position: fixed, и любая прокрутка
  // уводит полосу. Поэтому делаем как сам айфон: начал листать — клавиатура убирается.
  // Без клавиатуры fixed работает как обычно, полоса просто садится на низ экрана,
  // и никакой математики не нужно. Режим поиска при этом остаётся включённым.
  let typing = false;

  function placeBar() {
    if (!typing || !viewport) return;
    bar.style.position = 'absolute';
    bar.style.bottom = 'auto';
    bar.style.top = (viewport.pageTop + viewport.height - bar.offsetHeight - 8) + 'px';
  }

  input.addEventListener('input', () => {
    state.noteQuery = input.value;
    renderNotes();
  });

  input.addEventListener('focus', () => {
    const keepY = window.scrollY;
    typing = true;
    document.body.classList.add('searching');
    // придерживаем прокрутку, пока клавиатура выезжает: иначе iOS уводит список к полю
    const hold = setInterval(() => window.scrollTo(0, keepY), 16);
    setTimeout(() => clearInterval(hold), 350);
    placeBar();
  });

  input.addEventListener('blur', () => {
    typing = false;
    bar.style.position = '';
    bar.style.top = '';
    bar.style.bottom = '';
  });

  // жест прокрутки убирает клавиатуру — дальше список листается как обычно
  window.addEventListener('touchmove', () => { if (typing) input.blur(); }, { passive: true });

  // единственный момент, когда полосу надо поставить: клавиатура выехала
  if (viewport) viewport.addEventListener('resize', placeBar);



  // гасим pointerdown, иначе поле теряет фокус раньше, чем до кнопки дойдёт click
  cancel.addEventListener('pointerdown', (e) => e.preventDefault());
  cancel.addEventListener('click', () => {
    input.value = '';
    state.noteQuery = '';
    renderNotes();
    input.blur();
    document.body.classList.remove('searching');
  });
})();

// шапка проявляется, только когда крупный заголовок ушёл вверх
window.addEventListener('scroll', () => {
  document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 34);
}, { passive: true });

// Свайп по строке заметки влево открывает кнопки, как в системных списках iOS.
let openSwipe = null;

function closeSwipe() {
  if (!openSwipe) return;
  openSwipe.querySelector('.swipe-body').style.transform = '';
  openSwipe.querySelector('.swipe-actions').style.width = '';
  openSwipe = null;
}

// Резиновое натяжение (rubber banding): за пределом ход не запрещается, а вязнет.
// Формула Apple: смещение стремится к dimension, но никогда его не достигает.
function rubber(over, dimension) {
  return (1 - 1 / (over * 0.55 / dimension + 1)) * dimension;
}

function enableSwipe(list) {
  let drag = null;

  list.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.swipe');
    if (!row) return;
    if (openSwipe && openSwipe !== row) closeSwipe();
    const card = row.querySelector('.swipe-body');
    const actions = row.querySelector('.swipe-actions');
    actions.style.width = '';                     // меряем ширину в покое, а не с прошлого жеста
    drag = {
      row, card, actions,
      x0: e.touches[0].clientX,
      y0: e.touches[0].clientY,
      base: openSwipe === row ? -actions.offsetWidth : 0,
      width: actions.offsetWidth,
      span: row.offsetWidth,
      axis: null,
    };
  }, { passive: true });

  list.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dx = e.touches[0].clientX - drag.x0;
    const dy = e.touches[0].clientY - drag.y0;
    if (!drag.axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') drag.row.classList.add('dragging');
    }
    if (drag.axis !== 'x') return;
    e.preventDefault();                       // иначе жест уходит в прокрутку страницы
    const raw = drag.base + dx;
    if (raw > 0) drag.shift = rubber(raw, drag.span);                      // вправо действий нет
    else if (raw >= -drag.width) drag.shift = raw;
    else drag.shift = -drag.width - rubber(-raw - drag.width, drag.span);  // дальше кнопок — вязко
    drag.card.style.transform = `translateX(${drag.shift}px)`;
    drag.actions.style.width = Math.max(0, -drag.shift) + 'px';   // кнопки тянутся вместе со строкой
  }, { passive: false });

  list.addEventListener('touchend', () => {
    if (!drag) return;
    const { row, card, actions, width } = drag;
    row.classList.remove('dragging');
    if (drag.axis === 'x') {
      const open = -(drag.shift || 0) > width / 2;
      card.style.transform = open ? `translateX(${-width}px)` : '';
      // при возврате полосу можно отпустить в исходную: её всё равно накрывает строка
      actions.style.width = open ? width + 'px' : '';
      openSwipe = open ? row : null;
    }
    drag = null;
  });

}

enableSwipe(document.getElementById('notes-list'));
enableSwipe(document.getElementById('tasks-list'));
window.addEventListener('scroll', () => closeSwipe(), { passive: true });

document.getElementById('n-back').addEventListener('click', () => noteEditor.close());
document.getElementById('n-pin').addEventListener('click', () => noteEditor.togglePin());
document.getElementById('n-delete').addEventListener('click', () => noteEditor.remove());
document.getElementById('n-title').addEventListener('input', () => { fitTitle(); noteEditor.schedule(); });
// перевод строки в заголовке уводит в текст заметки, как на айфоне
document.getElementById('n-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('n-body').focus(); }
});
document.getElementById('n-body').addEventListener('input', () => { markHeads(); noteEditor.schedule(); });

// оглавление: список заголовков, тап переносит к нужному разделу
document.getElementById('n-outline').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('note-outline');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.innerHTML = '';
  const heads = [...document.getElementById('n-body').children].filter(l => NOTE_HEAD.test(l.textContent));
  if (!heads.length) {
    panel.innerHTML = '<div class="empty">Разделов нет. Начните строку с «# »</div>';
  }
  for (const line of heads) {
    const item = document.createElement('button');
    item.textContent = line.textContent.replace(/^#\s+/, '');
    item.addEventListener('click', () => {
      panel.hidden = true;
      line.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    panel.appendChild(item);
  }
  panel.hidden = false;
});

document.getElementById('note-page').addEventListener('click', (e) => {
  if (!e.target.closest('.note-outline') && !e.target.closest('#n-outline')) {
    document.getElementById('note-outline').hidden = true;
  }
});

// свайп от левого края возвращает назад, как на iOS
(() => {
  const page = document.getElementById('note-page');
  const root = document.getElementById('app-root');
  let sw = null;
  page.addEventListener('touchstart', (e) => {
    if (!page.classList.contains('open') || e.touches[0].clientX > 28) return;
    sw = { x0: e.touches[0].clientX, dx: 0 };
    page.classList.add('dragging');
    root.classList.add('dragging');
  }, { passive: true });
  page.addEventListener('touchmove', (e) => {
    if (!sw) return;
    sw.dx = Math.max(0, e.touches[0].clientX - sw.x0);
    const shift = -22 + 22 * (sw.dx / window.innerWidth);
    page.style.transform = `translateX(${sw.dx}px)`;
    // двигаем элементы экрана по отдельности — как в CSS, чтобы панель не прыгала
    for (const el of root.children) el.style.transform = `translateX(${shift}%)`;
  }, { passive: true });
  page.addEventListener('touchend', () => {
    if (!sw) return;
    const dx = sw.dx; sw = null;
    page.classList.remove('dragging');
    root.classList.remove('dragging');
    page.style.transform = '';
    for (const el of root.children) el.style.transform = '';   // вернётся к классам с анимацией
    if (dx > window.innerWidth * 0.35) noteEditor.close();
  });
})();

document.getElementById('sheet-backdrop').addEventListener('click', () => sheet.close());
document.getElementById('f-close').addEventListener('click', () => sheet.close());

// Свайп вниз закрывает шторку: за шапку — всегда, за тело — только когда оно
// прокручено к самому верху, иначе жест остаётся за скроллом содержимого.
const swipe = { startY: 0, dy: 0, active: false };
const sheetEl = document.getElementById('sheet');

sheetEl.addEventListener('touchstart', (e) => {
  const body = sheetEl.querySelector('.sheet-body');
  const onHead = !!e.target.closest('.sheet-head');
  if (!onHead && body.scrollTop > 0) return;
  swipe.active = true;
  swipe.startY = e.touches[0].clientY;
  swipe.dy = 0;
  sheetEl.style.transition = 'none';
}, { passive: true });

sheetEl.addEventListener('touchmove', (e) => {
  if (!swipe.active) return;
  swipe.dy = Math.max(0, e.touches[0].clientY - swipe.startY);
  if (swipe.dy > 0) sheetEl.style.transform = `translateY(${swipe.dy}px)`;
}, { passive: true });

sheetEl.addEventListener('touchend', () => {
  if (!swipe.active) return;
  swipe.active = false;
  sheetEl.style.transition = 'transform 180ms ease-out';
  if (swipe.dy > 90) {
    sheetEl.style.transform = 'translateY(100%)';
    setTimeout(() => { sheet.close(); sheetEl.style.transform = ''; sheetEl.style.transition = ''; }, 180);
  } else {
    sheetEl.style.transform = '';
    setTimeout(() => { sheetEl.style.transition = ''; }, 200);
  }
});
// свайп по затемнению не должен доходить до страницы
document.getElementById('sheet-backdrop').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.getElementById('f-save').addEventListener('click', () => sheet.save());
document.getElementById('f-done').addEventListener('click', () => sheet.toggleDone());
document.getElementById('f-comment-send').addEventListener('click', () => sheet.addComment());
document.getElementById('login-code').addEventListener('input', (e) => loginMood(e.target.value.trim() ? 'typing' : null));
// у задачи из трекера стадия применяется сразу — кнопки «сохранить» у неё нет
document.getElementById('f-stage').addEventListener('change', async (e) => {
  const { item } = state.sheet;
  if (!item?.external || blocked()) return;
  try {
    const res = await api('/api/update', 'POST', { id: item.id, patch: { stage: e.target.value } });
    if (!res.ok) { toast(res.error || 'Не сохранилось'); return; }
    Object.assign(item, res.item || {});
    toast(`${STAGE_TITLES[e.target.value]} — уйдёт в трекер через минуту`);
    renderAll();
  } catch {
    toast('Компьютер недоступен');
  }
});
document.getElementById('f-delete').addEventListener('click', () => sheet.remove());
document.getElementById('f-allday').addEventListener('change', () => sheet.syncAllDay());
document.getElementById('f-notes').addEventListener('input', (e) => autosize(e.target));
document.getElementById('f-comment-add').addEventListener('input', (e) => autosize(e.target));

document.getElementById('f-check-add').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = e.target.value.trim();
  if (!text) return;
  state.sheet.steps.push({ id: Math.random().toString(16).slice(2, 10), text, done: false });
  e.target.value = '';
  sheet.renderSteps();
});

document.getElementById('f-check-list').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-step]');
  if (!li) return;
  const step = state.sheet.steps.find(st => st.id === li.dataset.step);
  if (!step) return;
  if (e.target.closest('[data-act="remove"]')) {
    state.sheet.steps = state.sheet.steps.filter(st => st !== step);
    sheet.renderSteps();
  } else if (e.target.matches('input[type="checkbox"]')) {
    step.done = e.target.checked;
    sheet.renderSteps();
    // у существующей задачи отметка уходит сразу, не дожидаясь «Сохранить»
    const item = state.sheet.item;
    if (item && !blocked()) {
      try {
        await api('/api/check', 'POST', { id: item.id, step: step.id, done: step.done });
        const saved = (item.checklist || []).find(st => st.id === step.id);
        if (saved) saved.done = step.done;
        renderTasks();
      } catch {
        toast('Не удалось отметить');
      }
    }
  }
});

document.getElementById('f-check-list').addEventListener('input', (e) => {
  const li = e.target.closest('[data-step]');
  const step = li && state.sheet.steps.find(st => st.id === li.dataset.step);
  if (step && e.target.matches('input[type="text"]')) step.text = e.target.value;
});
document.getElementById('f-project').addEventListener('change', (e) => sheet.fillMilestones(e.target.value, ''));

document.querySelectorAll('.sheet-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.sheet.kind = tab.dataset.kind;
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== state.sheet.kind; });
    document.getElementById('f-title').placeholder = state.sheet.kind === 'event' ? 'Что за событие' : 'Что сделать';
    sheet.syncAllDay();
    sheet.fillMilestones(document.getElementById('f-project').value, '');
  });
});

document.getElementById('quick-dates').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-due]');
  if (!btn) return;
  const d = new Date();
  d.setDate(d.getDate() + parseInt(btn.dataset.due, 10));
  document.getElementById('f-date').value = ymd(d);
});

document.getElementById('login-submit').addEventListener('click', () => submitCode(document.getElementById('login-code').value));
document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(e.target.value); });
// шестизначный код отправляем сами — на телефоне это экономит нажатие
document.getElementById('login-code').addEventListener('input', (e) => {
  if (/^\d{6}$/.test(e.target.value.trim())) submitCode(e.target.value);
});
document.getElementById('login-scan').addEventListener('click', startScanner);

// код входа приходит в Telegram по кнопке: осознанное действие, а не рассылка
// на каждое открытие приложения
document.getElementById('login-tg').addEventListener('click', async () => {
  const btn = document.getElementById('login-tg');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Отправляю…';
  try {
    if (!apiBase) await resolveApi(true);
    const res = await fetch(apiBase + '/api/send-code', { method: 'POST' });
    const data = await res.json();
    btn.textContent = data.ok ? 'Код отправлен в Telegram' : (data.error || 'Не вышло');
  } catch {
    btn.textContent = 'Нет связи с компьютером';
  }
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
    mountIcons(btn);
  }, 2600);
});
document.getElementById('scanner-cancel').addEventListener('click', stopScanner);

// --- старт ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    // при каждом возвращении в приложение спрашиваем сервер, нет ли новой версии
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'updated') return;
    const known = localStorage.getItem('bmo-sw-version');
    localStorage.setItem('bmo-sw-version', e.data.version);
    // первая установка — просто запоминаем; смена версии — перезагружаем с уведомлением
    if (known && known !== e.data.version) {
      toast(`BMO обновлён до ${e.data.version}`);
      setTimeout(() => location.reload(), 900);
    }
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) load(true); });

(async () => {
  mountIcons();
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
  const cached = readCachedState();
  if (cached) applyState(cached.data);
  load();
  setInterval(() => { if (!document.hidden) load(true); }, 60000);
  // адрес туннеля меняется вместе с перезагрузкой компьютера
  setInterval(resolveApi, 300000);
})();
