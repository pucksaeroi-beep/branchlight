'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, clipboard, Menu, nativeTheme, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const G = require('./git.cjs');

app.setName('Branchlight');
// Test hooks: a throwaway data dir + a scripted run that takes screenshots. Ignored in normal use.
if (process.env.BL_USER_DATA) app.setPath('userData', process.env.BL_USER_DATA);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const CONFIG = path.join(app.getPath('userData'), 'config.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'bl', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------------- config ----------------
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { config = {}; }
config.tabs ||= []; config.recent ||= []; config.settings ||= {};
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
}

// Login-shell PATH so hooks (husky, lint-staged), gpg and git-lfs work like in Terminal.
execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 4000 }, (_e, out) => {
  const m = /__P__(.*)__P__/.exec(out || ''); if (m) G.setPath(m[1]);
});

// Only repositories the user opened can be touched.
const allowed = new Set();
function repoOf(p) {
  const r = path.resolve(String(p || ''));
  if (!allowed.has(r)) throw new Error('Repository is not open: ' + r);
  return r;
}
async function addRepo(dir) {
  const top = await G.toplevel(dir);
  if (!top) throw new Error(`"${dir}" is not a git repository`);
  const real = path.resolve(top);
  allowed.add(real);
  config.recent = [real, ...config.recent.filter((r) => r !== real)].slice(0, 20);
  saveConfig();
  watch(real);
  return real;
}

// ---------------- file watching (debounced "changed" events) ----------------
const watchers = new Map();
function watch(repo) {
  if (watchers.has(repo)) return;
  let t = null;
  const fire = (kind) => { clearTimeout(t); t = setTimeout(() => win?.webContents.send('repo:changed', repo, kind), 350); };
  const ws = [];
  try {
    ws.push(fs.watch(repo, { recursive: true }, (_ev, f) => {
      if (!f) return fire('all');
      const s = String(f);
      if (/(^|\/)(node_modules|\.next|dist|build|target|\.venv)\//.test(s)) return;
      if (s.startsWith('.git/')) {
        if (/^\.git\/(objects|logs)\//.test(s) || s.endsWith('.lock')) return;
        return fire('git');
      }
      if (s === '.git') return;
      fire('work');
    }));
  } catch { /* volume without FSEvents: the renderer still refreshes on focus */ }
  watchers.set(repo, ws);
}
function unwatch(repo) { for (const w of watchers.get(repo) || []) w.close(); watchers.delete(repo); }

// ---------------- window ----------------
let win = null;
function createWindow() {
  const b = config.bounds || {};
  const dark = (config.settings.theme || 'dark') === 'dark' || (config.settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y, minWidth: 980, minHeight: 600,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: dark ? '#14161d' : '#f4f5f8', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  const remember = () => { if (!win.isMinimized() && !win.isFullScreen()) { config.bounds = win.getBounds(); saveConfig(); } };
  win.on('resized', remember); win.on('moved', remember);
  win.on('focus', () => win.webContents.send('app:focus'));
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!(DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('bl://app/'))) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (DEV_URL) win.loadURL(DEV_URL); else win.loadURL('bl://app/index.html');
  if (process.env.BL_SCRIPT) win.webContents.once('did-finish-load', () => runScript(process.env.BL_SCRIPT));
}

async function runScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  await wait(1500);
  for (const st of steps) {
    try {
      if (st.size) win.setContentSize(st.size[0], st.size[1]);
      if (st.eval) { const r = await win.webContents.executeJavaScript(st.eval, true); if (r !== undefined) console.log('[eval]', JSON.stringify(r)); }
      if (st.key) win.webContents.sendInputEvent({ type: 'keyDown', keyCode: st.key, modifiers: st.mods || [] });
      if (st.type) for (const ch of st.type) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await wait(st.wait ?? 500);
      if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    } catch (e) { console.log('[step error]', e.message); }
  }
  app.exit(0);
}

// ---------------- menu ----------------
function send(cmd, arg) { win?.webContents.send('menu', cmd, arg); }
function buildMenu() {
  const item = (label, accelerator, cmd) => ({ label, accelerator, click: () => send(cmd) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Branchlight', submenu: [
      { role: 'about' }, { type: 'separator' }, item('Settings…', 'Cmd+,', 'settings'), { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      item('Open Repository…', 'Cmd+O', 'open'), item('Clone Repository…', 'Cmd+Shift+O', 'clone'), item('Init Repository…', '', 'init'),
      { type: 'separator' }, item('New Tab', 'Cmd+T', 'new-tab'), item('Close Tab', 'Cmd+W', 'close-tab'),
      { type: 'separator' }, item('Open in Finder', 'Cmd+Shift+R', 'finder'), item('Open in Terminal', 'Cmd+Alt+T', 'terminal')] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      item('Command Palette…', 'Cmd+K', 'palette'), item('Find Commit…', 'Cmd+F', 'find'), { type: 'separator' },
      item('Show Local Changes', 'Cmd+1', 'wip'), item('Toggle Sidebar', 'Cmd+Alt+S', 'sidebar'), item('Refresh', 'Cmd+R', 'refresh'),
      { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { label: 'Repository', submenu: [
      item('Fetch', 'Cmd+Shift+F', 'fetch'), item('Pull', 'Cmd+Shift+L', 'pull'), item('Push', 'Cmd+Shift+P', 'push'), { type: 'separator' },
      item('New Branch…', 'Cmd+Shift+B', 'branch'), item('New Tag…', 'Cmd+Shift+T', 'tag'), { type: 'separator' },
      item('Stash Changes…', 'Cmd+Shift+S', 'stash'), item('Pop Stash', 'Cmd+Shift+Alt+S', 'pop'), { type: 'separator' },
      item('Commit', 'Cmd+Enter', 'commit'), item('Stage All', 'Cmd+Shift+A', 'stage-all'), item('Unstage All', 'Cmd+Shift+U', 'unstage-all')] },
    { role: 'windowMenu' },
  ]));
}

// ---------------- IPC ----------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
}
const ref = G.safeRef;
const paths = (list) => (Array.isArray(list) ? list : [list]).map((p) => {
  const s = String(p);
  if (!s || s.includes('\0') || path.isAbsolute(s) || s.split('/').includes('..')) throw new Error('Bad path ' + s);
  return s;
});

function registerIpc() {
  handle('app:state', () => ({ tabs: config.tabs.filter((t) => fs.existsSync(t)), active: config.active, recent: config.recent.filter((t) => fs.existsSync(t)), settings: config.settings, home: app.getPath('home') }));
  handle('app:tabs', (tabs, active) => { config.tabs = tabs; config.active = active; saveConfig(); });
  handle('settings:set', (s) => {
    config.settings = { ...config.settings, ...s }; saveConfig();
    if (s.theme) nativeTheme.themeSource = s.theme;
    return config.settings;
  });
  handle('repo:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Choose a git repository' });
    return r.canceled ? null : addRepo(r.filePaths[0]);
  });
  handle('repo:add', (dir) => addRepo(dir));
  handle('repo:close', (repo) => { unwatch(repo); });
  handle('repo:forget', (repo) => { config.recent = config.recent.filter((r) => r !== repo); saveConfig(); });
  handle('repo:init', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for the new repository' });
    if (r.canceled) return null;
    await G.git(r.filePaths[0], ['init', '-b', 'main']);
    return addRepo(r.filePaths[0]);
  });
  handle('repo:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Clone into…' });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('repo:clone', async (url, parent, name) => {
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url)) throw new Error('Unsupported URL');
    const dest = path.join(parent, paths(name)[0]);
    await G.stream(parent, ['clone', '--progress', '--', url, dest], (l) => win?.webContents.send('progress', l));
    return addRepo(dest);
  });

  // read-only queries
  handle('git:snapshot', async (repo, opts = {}) => {
    repo = repoOf(repo);
    const [st, refs, stashes, remotes] = await Promise.all([G.status(repo), G.refs(repo), G.stashes(repo), G.remotes(repo)]);
    const commits = await G.log(repo, { limit: opts.limit || 3000, all: true });
    const head = await G.run(repo, ['rev-parse', 'HEAD']);
    const ident = await Promise.all([G.run(repo, ['config', 'user.name']), G.run(repo, ['config', 'user.email'])]);
    return { status: st, refs, stashes, remotes, commits, head: head.code === 0 ? head.out.trim() : null,
      user: { name: ident[0].out.trim(), email: ident[1].out.trim() } };
  });
  handle('git:status', async (repo) => G.status(repoOf(repo)));
  handle('git:commit', (repo, sha) => G.commit(repoOf(repo), sha));
  handle('git:commitDiff', (repo, sha, file, opts) => G.commitDiff(repoOf(repo), sha, { path: paths(file.path)[0], from: file.from ? paths(file.from)[0] : null }, opts));
  handle('git:workingDiff', (repo, file, staged, opts) => G.workingDiff(repoOf(repo), { ...file, path: paths(file.path)[0], from: file.from ? paths(file.from)[0] : null }, staged, opts));
  handle('git:blob', (repo, rev, file) => G.blob(repoOf(repo), rev === ':working' ? rev : ref(rev), paths(file)[0]));
  handle('git:lastMessage', async (repo) => (await G.run(repoOf(repo), ['log', '-1', '--format=%B'])).out.replace(/\n+$/, ''));
  handle('git:fileLog', async (repo, file) => {
    const out = await G.git(repoOf(repo), ['log', '--follow', '--max-count=300', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1f%x1e`, '--', paths(file)[0]]);
    return G.parseLog(out);
  });

  // mutations — every one is a fixed git command; names and paths are validated above
  const ops = {
    stage: (r, files) => G.git(r, ['add', '-A', '--', ...paths(files)]),
    unstage: async (r, files) => {
      const hasHead = (await G.run(r, ['rev-parse', '--verify', 'HEAD'])).code === 0;
      return hasHead ? G.git(r, ['reset', '-q', 'HEAD', '--', ...paths(files)]) : G.git(r, ['rm', '--cached', '-r', '-q', '--', ...paths(files)]);
    },
    discard: async (r, files) => {
      const tracked = [], untracked = [];
      for (const f of files) (f.status === 'untracked' ? untracked : tracked).push(f.path);
      if (tracked.length) await G.git(r, ['checkout', '--', ...paths(tracked)]);
      if (untracked.length) await G.git(r, ['clean', '-f', '-q', '--', ...paths(untracked)]);
    },
    applyPatch: (r, patch, { cached, reverse }) => G.git(r, ['apply', '--whitespace=nowarn', '--unidiff-zero', ...(cached ? ['--cached'] : []), ...(reverse ? ['-R'] : []), '-'], { input: patch }),
    commit: (r, msg, { amend, noVerify, signoff }) => G.git(r, ['commit', '-F', '-', '--cleanup=strip', ...(amend ? ['--amend'] : []), ...(noVerify ? ['--no-verify'] : []), ...(signoff ? ['--signoff'] : [])], { input: msg }),
    checkout: (r, name) => G.git(r, ['switch', ref(name)]),
    checkoutRemote: (r, remoteBranch, local) => G.git(r, ['switch', '-c', ref(local), '--track', ref(remoteBranch)]),
    checkoutDetached: (r, sha) => G.git(r, ['switch', '--detach', ref(sha)]),
    branch: (r, name, at, checkout) => G.git(r, checkout ? ['switch', '-c', ref(name), ref(at)] : ['branch', ref(name), ref(at)]),
    renameBranch: (r, from, to) => G.git(r, ['branch', '-m', ref(from), ref(to)]),
    deleteBranch: (r, name, force) => G.git(r, ['branch', force ? '-D' : '-d', ref(name)]),
    deleteRemoteBranch: (r, remote, branch) => G.stream(r, ['push', ref(remote), '--delete', ref(branch)]),
    setUpstream: (r, local, upstream) => G.git(r, ['branch', `--set-upstream-to=${ref(upstream)}`, ref(local)]),
    merge: (r, name, { noFF, squash } = {}) => G.git(r, ['merge', '--no-edit', ...(noFF ? ['--no-ff'] : []), ...(squash ? ['--squash'] : []), ref(name)]),
    rebase: (r, onto) => G.git(r, ['rebase', ref(onto)]),
    cherryPick: (r, sha) => G.git(r, ['cherry-pick', ref(sha)]),
    revert: (r, sha, isMerge) => G.git(r, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), ref(sha)]),
    reset: (r, sha, mode) => G.git(r, ['reset', ['soft', 'mixed', 'hard'].includes(mode) ? '--' + mode : '--mixed', ref(sha)]),
    tag: (r, name, at, message) => G.git(r, message ? ['tag', '-a', ref(name), '-m', String(message), ref(at)] : ['tag', ref(name), ref(at)]),
    deleteTag: (r, name) => G.git(r, ['tag', '-d', ref(name)]),
    pushTag: (r, remote, name) => G.stream(r, ['push', ref(remote), `refs/tags/${ref(name)}`]),
    stash: (r, msg, { keepIndex, untracked = true } = {}) => G.git(r, ['stash', 'push', ...(untracked ? ['-u'] : []), ...(keepIndex ? ['--keep-index'] : []), ...(msg ? ['-m', String(msg)] : [])]),
    // restore the staged state too; fall back to a plain apply only when git says the index can't be restored
    stashApply: (r, sref, pop) => G.git(r, ['stash', pop ? 'pop' : 'apply', '--index', ref(sref)])
      .catch((e) => { if (/--index|index/i.test(e.message) && !/conflict/i.test(e.message)) return G.git(r, ['stash', pop ? 'pop' : 'apply', ref(sref)]); throw e; }),
    stashDrop: (r, sref) => G.git(r, ['stash', 'drop', ref(sref)]),
    abort: (r, op) => G.git(r, [{ merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[op] || 'merge', '--abort']),
    continue: (r, op) => G.git(r, [{ merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[op], '--continue'], { env: { GIT_EDITOR: 'true' } }),
    resolve: (r, file, side) => (side ? G.git(r, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', ...paths(file)]) : Promise.resolve()).then(() => G.git(r, ['add', '--', ...paths(file)])),
    addRemote: (r, name, url) => G.git(r, ['remote', 'add', ref(name), ref(url)]),
    removeRemote: (r, name) => G.git(r, ['remote', 'remove', ref(name)]),
    ignore: (r, pattern) => fs.promises.appendFile(path.join(r, '.gitignore'), (fs.existsSync(path.join(r, '.gitignore')) && !fs.readFileSync(path.join(r, '.gitignore'), 'utf8').endsWith('\n') ? '\n' : '') + paths(pattern)[0] + '\n'),
    setIdentity: (r, name, email) => Promise.all([G.git(r, ['config', 'user.name', String(name)]), G.git(r, ['config', 'user.email', String(email)])]),
    // network
    fetch: (r) => G.stream(r, ['fetch', '--all', '--prune', '--progress'], (l) => win?.webContents.send('progress', l)),
    pull: (r, mode) => G.stream(r, ['pull', '--progress', mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase'], (l) => win?.webContents.send('progress', l)),
    push: async (r, { force, tags, remote } = {}) => {
      const st = await G.status(r);
      if (!st.branch) throw new Error('HEAD is detached — create a branch first');
      const rem = remote || (await G.remotes(r))[0]?.name;
      if (!rem) throw new Error('This repository has no remote');
      const args = ['push', '--progress', ...(force ? ['--force-with-lease'] : []), ...(tags ? ['--follow-tags'] : [])];
      if (!st.upstream) args.push('-u', ref(rem), ref(st.branch));
      return G.stream(r, args, (l) => win?.webContents.send('progress', l));
    },
  };
  handle('git:op', (repo, name, ...args) => {
    if (!Object.hasOwn(ops, name)) throw new Error('Unknown operation ' + name);
    return ops[name](repoOf(repo), ...args);
  });

  handle('shell:finder', (repo, file) => (file ? shell.showItemInFolder(path.join(repoOf(repo), paths(file)[0])) : shell.openPath(repoOf(repo))));
  handle('shell:terminal', (repo) => execFile('open', ['-a', 'Terminal', repoOf(repo)]));
  handle('shell:editor', (repo, file) => {
    const target = file ? path.join(repoOf(repo), paths(file)[0]) : repoOf(repo);
    execFile('open', ['-a', 'Visual Studio Code', target], (e) => { if (e) shell.openPath(target); });
  });
  handle('shell:external', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  handle('clip:copy', (text) => clipboard.writeText(String(text)));
}

// ---------------- lifecycle ----------------
app.whenReady().then(() => {
  protocol.handle('bl', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('not found', { status: 404 });
    const rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
    const p = path.join(DIST, rel || 'index.html');
    if (!p.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  if (!DEV_URL) {
    session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self' bl:; script-src 'self' bl:; style-src 'self' bl: 'unsafe-inline'; img-src 'self' bl: data: blob:; font-src 'self' bl: data:; connect-src 'self' bl:; object-src 'none'; base-uri 'none'"] } }));
  }
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  nativeTheme.themeSource = config.settings.theme || 'dark';
  registerIpc();
  buildMenu();
  // tabs restored from last session are trusted again
  Promise.all(config.tabs.filter((t) => fs.existsSync(t)).map((t) => addRepo(t).catch(() => null))).finally(createWindow);
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
