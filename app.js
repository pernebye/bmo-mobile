// Runner PWA — проекты, задачи, календарь и сессии Claude с телефона.

const KEY_TOKEN = 'runner-token';
const KEY_API = 'runner-api';

// Приложение живёт на постоянном адресе GitHub Pages, а компьютер каждый раз
// получает новый адрес туннеля — он публикуется в origin.json рядом с приложением.
const ORIGIN_POINTER = 'https://raw.githubusercontent.com/pernebye/runner-mobile/main/origin.json';
// raw отдаётся через CDN и минут пять помнит старый адрес; когда связь потеряна,
// спрашиваем напрямую у API GitHub, чтобы не ждать протухания кэша
const ORIGIN_FRESH = 'https://api.github.com/repos/pernebye/runner-mobile/contents/origin.json';

let apiBase = location.origin.includes('github.io') ? (localStorage.getItem(KEY_API) || '') : '';

const state = {
  projects: [], workspaces: [], tasks: [], events: [], sessions: [], activity: {},
  screen: 'projects', scope: 'all', workspace: '', search: '',
  calCursor: new Date(), calSelected: '',
  sheet: { kind: 'task', item: null }
};

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
  renderCalendar();
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
          <div class="card-extra">
            ${hasDev ? '<button class="btn btn-narrow" data-act="dev">Dev</button>' : ''}
            ${project.prodUrl ? `<a class="btn btn-narrow" href="${esc(project.prodUrl)}" target="_blank" rel="noopener">Сайт</a>` : ''}
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// --- задачи ---

function scopeTasks(scope) {
  const open = state.tasks.filter(t => t.status !== 'done');
  if (scope === 'today') return open.filter(t => t.due && dayDiff(t.due) <= 0);
  if (scope === 'week') return open.filter(t => t.due && dayDiff(t.due) <= 7);
  if (scope === 'overdue') return open.filter(isOverdue);
  if (scope === 'done') return state.tasks.filter(t => t.status === 'done');
  return open;
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  const tasks = scopeTasks(state.scope).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  if (!tasks.length) {
    list.innerHTML = `<div class="empty">${state.scope === 'done' ? 'Выполненных пока нет' : 'Задач нет — чисто'}</div>`;
    return;
  }

  if (state.scope === 'done') {
    list.innerHTML = tasks.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).map(taskRow).join('');
    return;
  }

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
  list.innerHTML = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([key, items]) => `
      <div class="group-title${key === 'overdue' ? ' alert' : ''}">${titles[key]}</div>
      ${items.map(taskRow).join('')}
    `).join('');
}

function taskRow(task) {
  const project = state.projects.find(p => p.id === task.projectId);
  const meta = [];
  if (task.due) meta.push(`<span class="task-due">${humanDue(task.due)}</span>`);
  if (project) meta.push(`<span>${esc(project.name)}</span>`);
  return `
    <article class="task${isOverdue(task) ? ' overdue' : ''}${task.status === 'done' ? ' done' : ''}" data-id="${esc(task.id)}">
      <button class="check" data-act="done"></button>
      <div class="task-body" data-act="open">
        <div class="task-title">${task.priority === 'high' ? '<span class="task-flag">● </span>' : ''}${esc(task.title)}</div>
        ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
        ${task.notes ? `<div class="task-notes">${esc(task.notes)}</div>` : ''}
      </div>
    </article>
  `;
}

function renderCounts() {
  const counts = {
    all: scopeTasks('all').length,
    today: scopeTasks('today').length,
    week: scopeTasks('week').length,
    overdue: scopeTasks('overdue').length,
    done: scopeTasks('done').length
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

const CAT_LABEL = { work: 'Работа', call: 'Созвон', personal: 'Личное', other: 'Другое', task: 'Задача' };

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
        <button class="btn btn-run btn-wide" data-act="resume">Продолжить сессию</button>
      </div>
    </article>
  `).join('');
}

// --- панель подробностей ---

const sheet = {
  el: () => document.getElementById('sheet'),

  open(kind, item, defaults = {}) {
    state.sheet = { kind, item: item || null };
    const isNew = !item;
    const isEvent = kind === 'event';

    document.getElementById('sheet-tabs').hidden = !isNew;
    document.getElementById('sheet-kind').hidden = isNew;
    document.getElementById('sheet-kind').textContent = isEvent ? 'Событие' : 'Задача';
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
    document.getElementById('f-category').value = item?.category || 'work';
    document.getElementById('f-location').value = item?.location || '';
    document.getElementById('f-priority').checked = item?.priority === 'high';
    document.getElementById('f-notes').value = item?.notes || '';
    this.syncAllDay();

    const done = item && item.status === 'done';
    document.getElementById('f-delete').hidden = isNew;
    document.getElementById('f-done').hidden = isNew;
    document.getElementById('f-done').textContent = done ? 'Вернуть' : (isEvent ? 'Прошло' : 'Выполнено');
    document.getElementById('f-save').textContent = isNew ? 'Создать' : 'Сохранить';

    this.el().hidden = false;
    document.getElementById('sheet-backdrop').hidden = false;
    if (isNew) setTimeout(() => document.getElementById('f-title').focus(), 120);
  },

  close() {
    this.el().hidden = true;
    document.getElementById('sheet-backdrop').hidden = true;
    state.sheet.item = null;
  },

  syncAllDay() {
    const allDay = state.sheet.kind === 'event' && document.getElementById('f-allday').checked;
    document.getElementById('f-time-field').hidden = allDay;
    document.getElementById('f-duration-field').hidden = allDay || state.sheet.kind !== 'event';
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
      priority: document.getElementById('f-priority').checked ? 'high' : 'normal'
    };
  },

  async save() {
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
    if (!item) return;
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
    if (!item) return;
    try {
      await api('/api/delete', 'POST', { id: item.id });
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
    await api('/api/session', 'POST', { cwd: session.cwd, sessionId: session.sessionId, title: session.projectName, tabColor: session.tabColor });
    toast('Сессия открывается');
  } catch {
    toast('Не получилось открыть сессию');
  }
});

document.getElementById('tasks-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const task = state.tasks.find(t => t.id === row.dataset.id);
  if (!task) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'done') {
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
    const found = findItem(item.dataset.item);
    if (found) sheet.open(found.kind, found.item);
    return;
  }
  const empty = e.target.closest('[data-new-on]');
  if (empty) sheet.open('event', null, { at: `${empty.dataset.newOn}T10:00` });
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
      { projects: 'Проекты', tasks: 'Задачи', calendar: 'Календарь', sessions: 'Сессии' }[state.screen];
    document.getElementById('btn-add').hidden = !(state.screen === 'tasks' || state.screen === 'calendar');
  });
});

document.getElementById('btn-reload').addEventListener('click', () => load());

document.getElementById('btn-add').addEventListener('click', () => {
  if (state.screen === 'calendar') sheet.open('event', null, { at: `${state.calSelected || ymd(new Date())}T10:00` });
  else sheet.open('task', null);
});

document.getElementById('sheet-backdrop').addEventListener('click', () => sheet.close());
document.getElementById('f-save').addEventListener('click', () => sheet.save());
document.getElementById('f-done').addEventListener('click', () => sheet.toggleDone());
document.getElementById('f-delete').addEventListener('click', () => sheet.remove());
document.getElementById('f-allday').addEventListener('change', () => sheet.syncAllDay());

document.querySelectorAll('.sheet-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.sheet.kind = tab.dataset.kind;
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== state.sheet.kind; });
    document.getElementById('f-title').placeholder = state.sheet.kind === 'event' ? 'Что за событие' : 'Что сделать';
    sheet.syncAllDay();
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
document.getElementById('scanner-cancel').addEventListener('click', stopScanner);

// --- старт ---

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) load(true); });

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
