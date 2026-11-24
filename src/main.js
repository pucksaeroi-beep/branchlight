// Branchlight — app shell: tabs, toolbar, layout, welcome screen, palette, settings.
import './styles/app.css';
import { h, icon, clear, add, modal, toast, popupMenu, debounce, confirm, fmtDate } from './ui/h.js';
import { app, Repo, S, op, showError, identityDialog } from './app.js';
import * as A from './actions.js';
import { createGraph } from './views/graph.js';
import { createSidebar } from './views/sidebar.js';
import { createPanel } from './views/panel.js';
import { createDiffView } from './views/diff.js';

const bl = window.bl;

// ---------------------------------------------------------------- layout
const tabsEl = h('div', { class: 'tabs' });
const titlebar = h('header', { class: 'titlebar' }, h('div', { class: 'traffic' }), tabsEl, h('div', { class: 'drag-fill' }));
const toolbar = h('div', { class: 'toolbar' });
const findBar = h('div', { class: 'findbar hidden' });
const centerEl = h('div', { class: 'center' });
const welcomeEl = h('div', { class: 'welcome' });

const graph = createGraph({
  onSelect: (sha) => selectSha(sha, false),
  onOpen: (c) => { if (c.wip) return; const r = (app.active.refsBySha.get(c.sha) || []).find((x) => x.kind === 'local' && !x.current); if (r) A.checkout(r.name); },
  onContext: (c, e) => A.commitMenu(c, e),
  onRefContext: (r, e) => A.refMenu(r, e),
  onRefOpen: (r) => A.refOpen(r),
  onLoadMore: debounce(async () => { const r = app.active; r.limit += 3000; await r.load(); render(); }, 300),
});
const sidebar = createSidebar({ onSelectSha: (sha) => selectSha(sha, true), onSelectStash: (s) => { app.active.sel = s.sha; app.active.diff = null; render(); } });
const panel = createPanel({ openDiff, selectSha: (sha) => selectSha(sha, true) });
const diffView = createDiffView({ onClose: closeDiff });
const resizerL = h('div', { class: 'resizer', dataset: { side: 'left' } });
const resizerR = h('div', { class: 'resizer', dataset: { side: 'right' } });
const workspace = h('main', { class: 'workspace' }, sidebar.el, resizerL, centerEl, resizerR, panel.el);
const root = h('div', { class: 'app' }, titlebar, toolbar, workspace, welcomeEl);
document.body.append(root);

app.views = { render, renderToolbar, graph };

// ---------------------------------------------------------------- rendering
function render() {
  renderTabs();
  renderToolbar();
  const repo = app.active;
  root.classList.toggle('no-repo', !repo);
  root.classList.toggle('no-sidebar', S('sidebar') === false);
  if (!repo) { renderWelcome(); return; }
  if (repo.error && !repo.snap) {
    clear(centerEl).append(h('div', { class: 'center-msg' }, icon('alert'), h('h3', {}, 'Could not read this repository'), h('pre', { class: 'err-pre' }, repo.error)));
    return;
  }
  if (!repo.snap) { clear(centerEl).append(h('div', { class: 'center-msg' }, h('div', { class: 'spinner' }))); return; }
  sidebar.render();
  if (repo.diff) {
    if (!centerEl.contains(diffView.el)) clear(centerEl).append(diffView.el);
    diffView.show();
  } else {
    if (!centerEl.contains(graph.el)) clear(centerEl).append(findBar, graph.el);
    graph.setRepo(repo);
  }
  panel.render();
}

function renderTabs() {
  clear(tabsEl);
  for (const r of app.tabs) {
    const t = h('div', { class: 'tab' + (r === app.active ? ' active' : ''), title: r.path },
      icon('repo'), h('span', { class: 'tab-name' }, r.name),
      r.branch ? h('span', { class: 'tab-branch' }, r.branch) : null,
      r.changes ? h('span', { class: 'tab-dot', title: `${r.changes} changes` }) : null,
      h('button', { class: 'tab-x', title: 'Close tab (⌘W)', onclick: (e) => { e.stopPropagation(); closeTab(r); } }, icon('x')));
    t.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.tab-x')) activate(r); });
    t.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(r); });
    tabsEl.append(t);
  }
  tabsEl.append(h('button', { class: 'tab-new', title: 'New tab (⌘T)', onclick: () => { app.active = null; saveTabs(); render(); } }, icon('plus')));
}

function tbtn(ic, label, onClick, { badge, title, menu, spin, disabled } = {}) {
  const b = h('button', { class: 'tb' + (spin ? ' spinning' : ''), title: title || label, disabled },
    h('span', { class: 'tb-ic' }, icon(ic), badge ? h('span', { class: 'tb-badge' }, badge) : null), h('span', { class: 'tb-label' }, label));
  b.addEventListener('click', () => onClick(b));
  if (menu) { b.classList.add('has-menu'); b.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(b); }); }
  return b;
}

function renderToolbar() {
  const repo = app.active;
  clear(toolbar);
  if (!repo) { toolbar.append(h('div', { class: 'tb-title' }, 'Branchlight')); return; }
  const st = repo.status;
  const busy = repo.busy > 0;
  const net = repo.netOp;
  const crumbs = h('div', { class: 'crumbs' },
    h('button', { class: 'crumb', title: 'Switch repository', onclick: (e) => repoMenu(e.currentTarget) }, h('span', { class: 'crumb-k' }, 'repository'), h('span', { class: 'crumb-v' }, repo.name, icon('chevronDown'))),
    h('button', { class: 'crumb', title: 'Switch branch', onclick: (e) => branchMenu(e.currentTarget) }, h('span', { class: 'crumb-k' }, 'branch'),
      h('span', { class: 'crumb-v' }, icon('branch'), repo.branch || (st ? 'detached' : '…'), icon('chevronDown'))));
  toolbar.append(
    h('button', { class: 'icon-btn tb-side', title: 'Toggle sidebar (⌥⌘S)', onclick: toggleSidebar }, icon('sidebar')),
    crumbs,
    h('div', { class: 'tb-group' },
      tbtn('undo', 'Undo', undoLast, { title: 'Undo last commit (soft reset)', disabled: busy || !repo.snap?.head }),
      h('span', { class: 'tb-sep' }),
      tbtn('pull', 'Pull', () => A.pull(), { badge: st?.behind || null, menu: A.pullMenu, spin: net === 'pull', disabled: busy, title: 'Pull (⇧⌘L) — right-click for options' }),
      h('button', { class: 'tb-caret', title: 'Pull options', onclick: (e) => A.pullMenu(e.currentTarget) }, icon('chevronDown')),
      tbtn('push', 'Push', () => A.push(), { badge: st?.ahead || null, menu: A.pushMenu, spin: net === 'push', disabled: busy, title: 'Push (⇧⌘P) — right-click for options' }),
      h('button', { class: 'tb-caret', title: 'Push options', onclick: (e) => A.pushMenu(e.currentTarget) }, icon('chevronDown')),
      tbtn('fetch', 'Fetch', () => A.fetch(), { spin: net === 'fetch', disabled: busy, title: 'Fetch all remotes (⇧⌘F)' }),
      h('span', { class: 'tb-sep' }),
      tbtn('branch', 'Branch', () => A.newBranch(), { disabled: busy, title: 'New branch (⇧⌘B)' }),
      tbtn('stash', 'Stash', () => A.stash(), { disabled: busy || !repo.changes, title: 'Stash changes (⇧⌘S)' }),
      tbtn('pop', 'Pop', () => A.pop(), { disabled: busy || !repo.snap?.stashes.length, badge: repo.snap?.stashes.length || null, title: 'Pop latest stash' })),
    h('div', { class: 'tb-right' },
      app.progress && net ? h('span', { class: 'progress-line', title: app.progress }, app.progress) : null,
      h('button', { class: 'icon-btn', title: 'Find commit (⌘F)', onclick: openFind }, icon('search')),
      h('button', { class: 'icon-btn', title: 'Command palette (⌘K)', onclick: palette }, icon('keyboard')),
      h('button', { class: 'icon-btn', title: 'Open in Terminal (⌥⌘T)', onclick: () => bl.shell.terminal(repo.path) }, icon('terminal')),
      h('button', { class: 'icon-btn', title: 'Open in Finder (⇧⌘R)', onclick: () => bl.shell.finder(repo.path) }, icon('folder')),
      h('button', { class: 'icon-btn', title: 'Settings (⌘,)', onclick: settings }, icon('settings'))));
}

async function undoLast() {
  const repo = app.active;
  const head = repo.snap.commits.find((c) => c.sha === repo.snap.head);
  if (!head?.parents.length) return toast('Nothing to undo');
  if (await confirm('Undo last commit?', `“${head.subject}” is removed from ${repo.branch || 'HEAD'}; its changes stay staged so you can edit and recommit.${repo.status.ahead === 0 && repo.status.upstream ? '\n\nThis commit was already pushed.' : ''}`, 'Undo Commit')) {
    await op('reset', [head.parents[0], 'soft'], { ok: 'Last commit undone — changes are staged' });
  }
}

function repoMenu(anchor) {
  popupMenu([
    { header: 'Open tabs' },
    ...app.tabs.map((r) => ({ label: r.name, icon: 'repo', checked: r === app.active, onClick: () => activate(r) })),
    '-',
    { label: 'Open Repository…', icon: 'folder', kbd: '⌘O', onClick: openRepo },
    { label: 'Clone…', icon: 'download', kbd: '⇧⌘O', onClick: clone },
    { label: 'Open in Editor', icon: 'code', onClick: () => bl.shell.editor(app.active.path) },
  ], anchor);
}

function branchMenu(anchor) {
  const repo = app.active;
  const locals = repo.snap.refs.local.slice().sort((a, b) => b.date - a.date);
  popupMenu([
    { header: 'Check out (recent first)' },
    ...locals.slice(0, 14).map((b) => ({ label: b.name, icon: 'branch', checked: b.current, onClick: () => A.checkout(b.name) })),
    locals.length > 14 ? { label: `All ${locals.length} branches…`, icon: 'search', onClick: palette } : null,
    '-',
    { label: 'New Branch…', icon: 'plus', kbd: '⇧⌘B', onClick: () => A.newBranch() },
  ], anchor);
}

// ---------------------------------------------------------------- selection / diff
function selectSha(sha, reveal) {
  const repo = app.active;
  if (!repo) return;
  repo.sel = sha;
  if (repo.diff) { repo.diff = null; render(); }
  else { graph.draw(); panel.render(); sidebar.render(); }
  const i = repo.index.get(sha);
  if (reveal && i != null) graph.center(i);
}

function openDiff(d) {
  app.active.diff = d;
  render();
}
function closeDiff() {
  if (!app.active?.diff) return;
  app.active.diff = null;
  render();
  graph.focus();
}

// ---------------------------------------------------------------- find
function openFind() {
  if (!app.active?.snap) return;
  if (app.active.diff) closeDiff();
  findBar.classList.remove('hidden');
  const input = findBar.querySelector('input') || buildFind();
  input.value = app.active.find || '';
  input.focus(); input.select();
}
function buildFind() {
  const input = h('input', { class: 'find-input', placeholder: 'Find by message, author or SHA…', spellcheck: 'false' });
  const count = h('span', { class: 'find-count' });
  const update = () => { app.active.find = input.value; graph.refreshMatches(); count.textContent = input.value ? `${graph.matchCount} found` : ''; };
  input.addEventListener('input', debounce(update, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { update(); graph.nextMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') closeFind();
  });
  add(findBar, icon('search'), input, count,
    h('button', { class: 'icon-btn', title: 'Previous (⇧↩)', onclick: () => graph.nextMatch(-1) }, icon('arrowUp')),
    h('button', { class: 'icon-btn', title: 'Next (↩)', onclick: () => graph.nextMatch(1) }, icon('arrowDown')),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: closeFind }, icon('x')));
  return input;
}
function closeFind() {
  findBar.classList.add('hidden');
  if (app.active) { app.active.find = ''; graph.refreshMatches(); }
  const c = findBar.querySelector('.find-count'); if (c) c.textContent = '';
  graph.focus();
}

// ---------------------------------------------------------------- tabs / repos
async function openPath(path) {
  const existing = app.tabs.find((r) => r.path === path);
  if (existing) return activate(existing);
  const repo = new Repo(path);
  app.tabs.push(repo);
  app.active = repo;
  saveTabs(); render();
  await repo.load();
  render();
}
async function openRepo() {
  try { const p = await bl.repo.pick(); if (p) await openPath(p); } catch (e) { showError(e.message); }
}
async function initRepo() {
  try { const p = await bl.repo.init(); if (p) { await openPath(p); toast('Repository created'); } } catch (e) { showError(e.message); }
}
async function openRecent(p) {
  try { await openPath(await bl.repo.add(p)); } catch (e) { showError(e.message); }
}
function activate(r) {
  if (app.active === r) return;
  app.active = r;
  saveTabs(); render();
  r.load().then(render);
}
function closeTab(r) {
  const i = app.tabs.indexOf(r);
  app.tabs.splice(i, 1);
  bl.repo.close(r.path);
  if (app.active === r) app.active = app.tabs[Math.min(i, app.tabs.length - 1)] || null;
  saveTabs(); render();
}
function saveTabs() { bl.app.saveTabs(app.tabs.map((r) => r.path), app.active?.path || null); }

async function clone() {
  const url = h('input', { class: 'input mono', placeholder: 'https://github.com/user/repo.git  or  git@github.com:user/repo.git', spellcheck: 'false' });
  let parent = app.settings.cloneDir || app.home;
  const dir = h('button', { class: 'btn dir-btn', onclick: async () => { const p = await bl.repo.pickDir(); if (p) { parent = p; dir.textContent = p; } } }, parent);
  const name = h('input', { class: 'input mono', placeholder: 'folder name' });
  url.addEventListener('input', () => { const m = /([^/:]+?)(\.git)?\/?$/.exec(url.value.trim()); if (m) name.value = m[1]; });
  const progress = h('div', { class: 'clone-progress muted small' });
  const off = bl.on('progress', (l) => { progress.textContent = l; });
  const r = await modal('Clone a repository', [
    h('label', { class: 'field' }, 'Repository URL', url),
    h('label', { class: 'field' }, 'Clone into', dir),
    h('label', { class: 'field' }, 'Folder name', name), progress,
  ], [{ label: 'Cancel' }, { label: 'Clone', primary: true, onClick: async (close) => {
    if (!url.value.trim() || !name.value.trim()) return;
    progress.textContent = 'Cloning…';
    try {
      const p = await bl.repo.clone(url.value.trim(), parent, name.value.trim());
      app.settings.cloneDir = parent; bl.app.setSettings({ cloneDir: parent });
      close(p);
    } catch (e) { progress.textContent = ''; showError(e.message, 'clone'); }
  } }], { sticky: true });
  off();
  if (r) { await openPath(r); toast('Cloned'); }
}

function renderWelcome() {
  clear(welcomeEl).append(
    h('div', { class: 'welcome-inner' },
      h('div', { class: 'logo' }, h('img', { src: './logo.svg', alt: '' })),
      h('h1', {}, 'Branchlight'),
      h('p', { class: 'tagline' }, 'A fast, beautiful Git client for macOS.'),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'wcard', onclick: openRepo }, icon('folder'), h('b', {}, 'Open'), h('span', {}, 'an existing repository'), h('kbd', {}, '⌘O')),
        h('button', { class: 'wcard', onclick: clone }, icon('download'), h('b', {}, 'Clone'), h('span', {}, 'from GitHub, GitLab, …'), h('kbd', {}, '⇧⌘O')),
        h('button', { class: 'wcard', onclick: initRepo }, icon('sparkle'), h('b', {}, 'Init'), h('span', {}, 'a brand-new repository'), h('kbd', {}, ''))),
      app.recent.length ? h('div', { class: 'recent' }, h('div', { class: 'recent-title' }, 'Recent repositories'),
        app.recent.slice(0, 10).map((p) => h('div', { class: 'recent-row', onclick: () => openRecent(p) }, icon('repo'),
          h('div', { class: 'recent-main' }, h('b', {}, p.split('/').pop()), h('span', { class: 'muted small' }, p.replace(app.home, '~'))),
          h('button', { class: 'icon-btn', title: 'Remove from list', onclick: (e) => { e.stopPropagation(); bl.repo.forget(p); app.recent = app.recent.filter((x) => x !== p); renderWelcome(); } }, icon('x'))))) : null));
}

// ---------------------------------------------------------------- palette (⌘K)
function palette() {
  const repo = app.active;
  const items = [];
  const cmd = (label, ic, run, hint = '') => items.push({ label, ic, run, hint });
  if (repo?.snap) {
    for (const b of repo.snap.refs.local) cmd(b.name, 'branch', () => A.checkout(b.name), b.current ? 'current' : 'check out');
    for (const b of repo.snap.refs.remote) cmd(b.name, 'cloud', () => A.checkoutRemote(b.name), 'check out remote');
    cmd('Fetch', 'fetch', A.fetch, '⇧⌘F'); cmd('Pull', 'pull', () => A.pull(), '⇧⌘L'); cmd('Push', 'push', () => A.push(), '⇧⌘P');
    cmd('New Branch…', 'plus', () => A.newBranch(), '⇧⌘B'); cmd('New Tag…', 'tag', () => A.newTag(), '⇧⌘T');
    cmd('Stash Changes…', 'stash', A.stash, '⇧⌘S'); cmd('Pop Stash', 'pop', () => A.pop());
    cmd('Show Local Changes', 'edit', () => selectSha('WIP', true), '⌘1');
    cmd('Find Commit…', 'search', openFind, '⌘F');
    cmd('Open in Terminal', 'terminal', () => bl.shell.terminal(repo.path)); cmd('Open in Finder', 'folder', () => bl.shell.finder(repo.path));
    cmd('Open in VS Code', 'code', () => bl.shell.editor(repo.path));
  }
  for (const p of app.recent) if (!app.tabs.some((t) => t.path === p)) cmd(p.split('/').pop(), 'repo', () => openRecent(p), p.replace(app.home, '~'));
  cmd('Open Repository…', 'folder', openRepo, '⌘O'); cmd('Clone Repository…', 'download', clone, '⇧⌘O');
  cmd('Toggle Light / Dark Theme', 'sun', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  cmd('Settings…', 'settings', settings, '⌘,');

  const input = h('input', { class: 'pal-input', placeholder: 'Check out a branch, open a repository, run a command…', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list' });
  let cur = 0, shown = [];
  const score = (label, q) => {
    const l = label.toLowerCase();
    if (!q) return 1;
    if (l.startsWith(q)) return 3;
    if (l.includes(q)) return 2;
    let i = 0; for (const ch of l) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.map((it) => ({ it, s: score(it.label, q) })).filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it);
    cur = Math.min(cur, Math.max(0, shown.length - 1));
    clear(list).append(...shown.map((it, i) => h('div', { class: 'pal-row' + (i === cur ? ' on' : ''), onmousedown: (e) => { e.preventDefault(); run(it); } },
      icon(it.ic), h('span', { class: 'pal-label' }, it.label), h('span', { class: 'pal-hint' }, it.hint))));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  let close;
  const run = (it) => { close?.(); setTimeout(() => it.run(), 10); };
  input.addEventListener('input', () => { cur = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (shown[cur]) run(shown[cur]); }
  });
  draw();
  modal(null, [input, list], [], { class: 'palette' });
  close = () => document.querySelector('.modal-back.show:last-of-type')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

// ---------------------------------------------------------------- settings
function setTheme(t) {
  app.settings.theme = t; bl.app.setSettings({ theme: t });
  applyTheme();
}
function applyTheme() {
  const t = S('theme');
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  graph.draw();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function settings() {
  const seg = (key, opts, after) => h('div', { class: 'seg wide' }, opts.map(([v, label]) => {
    const b = h('button', { class: 'seg-btn' + (S(key) === v ? ' on' : '') }, label);
    b.addEventListener('click', () => { app.settings[key] = v; bl.app.setSettings({ [key]: v }); b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); after?.(); render(); });
    return b;
  }));
  const ctx = h('input', { class: 'input small-num', type: 'number', min: 0, max: 20, value: S('context') });
  ctx.addEventListener('change', () => { const v = Math.max(0, Math.min(20, +ctx.value || 3)); app.settings.context = v; bl.app.setSettings({ context: v }); });
  const repo = app.active;
  modal('Settings', h('div', { class: 'settings' },
    h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Theme')), seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], applyTheme)),
    h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Default pull'), h('div', { class: 'muted small' }, 'What the Pull button does')), seg('pullMode', [['merge', 'Merge'], ['rebase', 'Rebase'], ['ff-only', 'FF only']])),
    h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Diff layout')), seg('diffMode', [['unified', 'Unified'], ['split', 'Split']])),
    h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Dates')), seg('dateFormat', [['relative', '3 hours ago'], ['absolute', fmtDate(Date.now() - 3 * 3600e3)]])),
    h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Context lines'), h('div', { class: 'muted small' }, 'Unchanged lines around each change')), ctx),
    repo ? h('div', { class: 'set-row' }, h('div', {}, h('b', {}, 'Commit identity'), h('div', { class: 'muted small' }, repo.snap?.user.email ? `${repo.snap.user.name} <${repo.snap.user.email}>` : 'Not set')),
      h('button', { class: 'btn small', onclick: () => identityDialog(repo) }, 'Change for this repo…')) : null,
    h('div', { class: 'set-foot muted small' }, 'Branchlight runs the git installed on your Mac. Credentials, SSH keys, hooks and GPG signing work exactly like in Terminal.')),
  [{ label: 'Done', primary: true }], { class: 'wide' });
}

function toggleSidebar() { app.settings.sidebar = S('sidebar') === false; bl.app.setSettings({ sidebar: app.settings.sidebar }); render(); }

// ---------------------------------------------------------------- resizers
for (const rz of [resizerL, resizerR]) {
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const left = rz.dataset.side === 'left';
    const start = e.clientX;
    const w0 = left ? sidebar.el.offsetWidth : panel.el.offsetWidth;
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.max(left ? 180 : 300, Math.min(left ? 460 : 720, w0 + (left ? ev.clientX - start : start - ev.clientX)));
      root.style.setProperty(left ? '--side-w' : '--panel-w', w + 'px');
      graph.draw();
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing');
      const k = left ? 'sideWidth' : 'panelWidth';
      const v = left ? sidebar.el.offsetWidth : panel.el.offsetWidth;
      app.settings[k] = v; bl.app.setSettings({ [k]: v });
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
}

// ---------------------------------------------------------------- events
const menu = {
  open: openRepo, clone, init: initRepo, 'new-tab': () => { app.active = null; saveTabs(); render(); },
  'close-tab': () => app.active && closeTab(app.active), finder: () => app.active && bl.shell.finder(app.active.path),
  terminal: () => app.active && bl.shell.terminal(app.active.path), palette, find: openFind, settings,
  wip: () => app.active && selectSha(app.active.index.has('WIP') ? 'WIP' : app.active.snap.head, true),
  sidebar: toggleSidebar, refresh: () => app.active?.load().then(render),
  fetch: () => app.active && A.fetch(), pull: () => app.active && A.pull(), push: () => app.active && A.push(),
  branch: () => app.active && A.newBranch(), tag: () => app.active && A.newTag(), stash: () => app.active && A.stash(), pop: () => app.active && A.pop(),
  commit: () => document.querySelector('.commit-btn:not([disabled])')?.click(),
  'stage-all': () => { const r = app.active; if (r?.status?.unstaged.length) op('stage', [r.status.unstaged.map((f) => f.path)]); },
  'unstage-all': () => { const r = app.active; if (r?.status?.staged.length) op('unstage', [r.status.staged.map((f) => f.path)]); },
};
bl.on('menu', (cmd) => { if (document.querySelector('.modal-back') && cmd !== 'palette') return; menu[cmd]?.(); });

bl.on('progress', (line) => { app.progress = line; const p = toolbar.querySelector('.progress-line'); if (p) { p.textContent = line; p.title = line; } else if (app.active?.netOp) renderToolbar(); });

const reloadSoon = debounce(async (repo, kind) => {
  if (repo.busy) return;
  if (kind === 'work') await repo.loadStatus(); else await repo.load();
  if (repo === app.active) {
    if (kind === 'work') {
      renderTabs(); renderToolbar();
      if (repo.sel === 'WIP' || !repo.diff) panel.render();
      if (repo.diff?.kind === 'work') diffView.show(); else graph.setRepo(repo);
    } else render();
  } else renderTabs();
}, 250);
bl.on('repo:changed', (path, kind) => { const r = app.tabs.find((t) => t.path === path); if (r) reloadSoon(r, kind); });
bl.on('app:focus', () => { if (app.active && !app.active.busy) reloadSoon(app.active, 'all'); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('.modal-back, .menu')) {
    if (app.active?.diff) { e.preventDefault(); closeDiff(); } else if (!findBar.classList.contains('hidden')) closeFind();
  }
  if (e.metaKey && /^[1-9]$/.test(e.key) && e.altKey) { const t = app.tabs[+e.key - 1]; if (t) activate(t); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  const st = await bl.app.state();
  app.settings = st.settings || {};
  app.recent = st.recent;
  app.home = st.home;
  if (app.settings.sideWidth) root.style.setProperty('--side-w', app.settings.sideWidth + 'px');
  if (app.settings.panelWidth) root.style.setProperty('--panel-w', app.settings.panelWidth + 'px');
  applyTheme();
  app.tabs = st.tabs.map((p) => new Repo(p));
  app.active = app.tabs.find((r) => r.path === st.active) || app.tabs[0] || null;
  render();
  await Promise.all(app.tabs.map((r) => (r === app.active ? r.load().then(render) : r.load())));
  render();
  graph.focus();
})();

// debug handle for scripted screenshots
window.__app = { app, render, selectSha, openDiff, openPath, palette, settings, openFind, graph, A };
