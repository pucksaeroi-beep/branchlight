// Shared application state + the git actions used by every view.
import { layout } from './lib/graph.js';
import { h, toast, confirm, modal, prompt } from './ui/h.js';

export const app = {
  tabs: [],          // Repo[]
  active: null,      // Repo
  settings: {},
  recent: [],
  home: '',
  progress: '',
  views: {},         // registered by main.js: { render(), renderTabs(), sidebar, graph, panel, center }
};

export const S = (k) => ({ theme: 'dark', pullMode: 'merge', diffMode: 'unified', ignoreWhitespace: false, dateFormat: 'relative', context: 3, ...app.settings })[k];

export class Repo {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.snap = null;
    this.list = [];          // commits incl. WIP row
    this.rows = [];          // graph layout rows
    this.width = 1;
    this.index = new Map();  // sha → row index
    this.refsBySha = new Map();
    this.sel = null;         // sha | 'WIP'
    this.detail = null;      // loaded commit details
    this.diff = null;        // { kind:'commit'|'work', file, staged, sha }
    this.find = '';
    this.limit = 3000;
    this.scrollTop = 0;
    this.busy = 0;
    this.collapsed = new Set(['tags']);
    this.message = { summary: '', body: '', amend: false };
    this.error = null;
  }

  get status() { return this.snap?.status; }
  get changes() { const s = this.status; return s ? s.staged.length + s.unstaged.length + s.conflicts.length : 0; }
  get branch() { return this.status?.branch; }
  get operation() { return this.status?.operation; }

  /** Full reload of refs, status, stashes and history. */
  async load() {
    try {
      const snap = await window.bl.git.snapshot(this.path, { limit: this.limit });
      this.snap = snap;
      this.error = null;
      this.rebuild();
    } catch (e) { this.error = e.message; }
  }

  /** Cheap reload of the working tree only. */
  async loadStatus() {
    if (!this.snap) return this.load();
    try {
      const before = this.changes;
      this.snap.status = await window.bl.git.status(this.path);
      if ((before > 0) !== (this.changes > 0)) this.rebuild();
    } catch { /* ignore */ }
  }

  rebuild() {
    const { commits, status, head, refs } = this.snap;
    const list = commits.slice();
    if (status.staged.length + status.unstaged.length + status.conflicts.length > 0 || !commits.length) {
      list.unshift({ sha: 'WIP', wip: true, parents: head ? [head] : [], subject: '', author: this.snap.user.name, email: this.snap.user.email, date: Date.now() });
    }
    this.list = list;
    const l = layout(list);
    this.rows = l.rows;
    this.width = l.width;
    this.index = new Map(list.map((c, i) => [c.sha, i]));
    // refs grouped per commit: local branches merged with their same-named remote twin
    const by = new Map();
    const push = (sha, r) => { if (!by.has(sha)) by.set(sha, []); by.get(sha).push(r); };
    const remoteAt = new Map(refs.remote.map((r) => [r.name, r]));
    const usedRemote = new Set();
    for (const b of refs.local) {
      const twin = b.upstream && remoteAt.get(b.upstream);
      const sameSha = twin && twin.sha === b.sha;
      if (sameSha) usedRemote.add(twin.name);
      push(b.sha, { kind: 'local', name: b.name, current: b.current, remote: sameSha ? twin.name : null, ref: b });
    }
    for (const r of refs.remote) if (!usedRemote.has(r.name)) push(r.sha, { kind: 'remote', name: r.name, ref: r });
    for (const t of refs.tags) push(t.sha, { kind: 'tag', name: t.name, ref: t });
    if (!status.branch && head) push(head, { kind: 'head', name: 'HEAD', current: true });
    for (const arr of by.values()) arr.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || ({ local: 0, head: 0, remote: 1, tag: 2 }[a.kind] - { local: 0, head: 0, remote: 1, tag: 2 }[b.kind]));
    this.refsBySha = by;
    if (this.sel && this.sel !== 'WIP' && !this.index.has(this.sel)) this.sel = null;
    if (this.sel === 'WIP' && !this.index.has('WIP')) this.sel = head;
    if (!this.sel) this.sel = this.index.has('WIP') ? 'WIP' : head;
  }
}

// ---------------------------------------------------------------- running git operations

export function render() { app.views.render?.(); }

/** Run a mutating git operation on the active repo, then reload. */
export async function op(name, args = [], { ok, quiet, reload = true, repo = app.active } = {}) {
  if (!repo) return false;
  repo.busy++; app.views.renderToolbar?.();
  try {
    await window.bl.git.op(repo.path, name, ...args);
    if (ok) toast(ok);
    return true;
  } catch (e) {
    app.lastError = e.message;
    if (!quiet) showError(e.message, name, repo);
    return false;
  } finally {
    repo.busy--; app.progress = '';
    if (reload) { await repo.load(); render(); } else app.views.renderToolbar?.();
  }
}

export function showError(msg, name = '', repo = app.active) {
  // Conflicts are expected states; show them as guidance rather than raw errors.
  if (/conflict/i.test(msg) && repo) {
    toast('Conflicts — resolve them in Local Changes, then continue', 'error');
    repo.sel = 'WIP'; repo.diff = null;
    return;
  }
  if (/Please tell me who you are|user\.email/.test(msg)) { identityDialog(repo); return; }
  toast(h('div', {}, h('b', {}, name ? `git ${name} failed` : 'Error'), h('pre', { class: 'err-pre' }, msg.trim().slice(0, 1500))), 'error');
}

export async function identityDialog(repo = app.active) {
  const name = h('input', { class: 'input', placeholder: 'Your Name', value: repo?.snap?.user?.name || '' });
  const email = h('input', { class: 'input', placeholder: 'you@example.com', value: repo?.snap?.user?.email || '' });
  const r = await modal('Commit identity', [h('p', { class: 'muted' }, 'Git needs a name and e-mail for commits in this repository.'), h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'E-mail', email)],
    [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: (c) => c({ name: name.value.trim(), email: email.value.trim() }) }]);
  if (r?.name && r?.email) await op('setIdentity', [r.name, r.email], { ok: 'Identity saved', repo });
}

export { confirm, prompt };
