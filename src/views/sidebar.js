// Left sidebar: local branches (as a folder tree), remotes, tags, stashes.
import { h, icon, clear } from '../ui/h.js';
import { app } from '../app.js';
import * as A from '../actions.js';

export function createSidebar({ onSelectSha, onSelectStash }) {
  const filter = h('input', { class: 'side-filter', placeholder: 'Filter branches…', spellcheck: 'false' });
  const body = h('div', { class: 'side-body' });
  const el = h('aside', { class: 'sidebar' }, h('div', { class: 'side-search' }, icon('search'), filter), body);
  filter.addEventListener('input', () => render());
  filter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filter.value = ''; render(); } });

  function section(repo, key, title, ic, count, items, actions = null, onContext = null) {
    const open = !repo.collapsed.has(key) || !!filter.value;
    const head = h('div', { class: 'side-head' + (open ? ' open' : '') },
      icon('chevronRight', 'chev'), icon(ic), h('span', { class: 'side-title' }, title), h('span', { class: 'side-count' }, count), actions);
    head.addEventListener('click', (e) => {
      if (e.target.closest('.side-act')) return;
      repo.collapsed.has(key) ? repo.collapsed.delete(key) : repo.collapsed.add(key); render();
    });
    if (onContext) head.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(e); });
    return h('div', { class: 'side-sec' }, head, open ? h('div', { class: 'side-items' }, items) : null);
  }

  /** Build a folder tree from "a/b/c" names. */
  function tree(items, depth, leaf) {
    const groups = new Map(), leaves = [];
    for (const it of items) {
      const parts = it.label.split('/');
      if (parts.length > 1) {
        const k = parts[0];
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ ...it, label: parts.slice(1).join('/') });
      } else leaves.push(it);
    }
    const out = [];
    for (const [k, arr] of groups) {
      const key = 'f:' + (arr[0].prefix || '') + depth + k;
      const repo = app.active;
      const open = !repo.collapsed.has(key) || !!filter.value;
      const row = h('div', { class: 'side-row folder', style: { '--d': depth } }, icon(open ? 'folderOpen' : 'folder'), h('span', { class: 'name' }, k), h('span', { class: 'side-count' }, arr.length));
      row.addEventListener('click', () => { repo.collapsed.has(key) ? repo.collapsed.delete(key) : repo.collapsed.add(key); render(); });
      out.push(row);
      if (open) out.push(...tree(arr, depth + 1, leaf));
    }
    for (const it of leaves) out.push(leaf(it, depth));
    return out;
  }

  function render() {
    const repo = app.active;
    clear(body);
    if (!repo?.snap) return;
    const q = filter.value.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const { refs, stashes, remotes } = repo.snap;

    // LOCAL
    const local = refs.local.filter((b) => match(b.name)).map((b) => ({ label: b.name, b }));
    const localLeaf = (it, d) => {
      const b = it.b;
      const row = h('div', { class: 'side-row branch' + (b.current ? ' current' : '') + (repo.sel === b.sha ? ' sel' : ''), style: { '--d': d }, title: b.upstream ? `${b.name} → ${b.upstream}` : b.name },
        b.current ? icon('check', 'cur') : icon('branch'),
        h('span', { class: 'name' }, it.label),
        b.gone ? h('span', { class: 'badge warn', title: 'Upstream branch is gone' }, 'gone') : null,
        b.behind ? h('span', { class: 'badge behind', title: `${b.behind} behind ${b.upstream}` }, icon('arrowDown'), b.behind) : null,
        b.ahead ? h('span', { class: 'badge ahead', title: `${b.ahead} ahead of ${b.upstream}` }, icon('arrowUp'), b.ahead) : null);
      row.addEventListener('click', () => onSelectSha(b.sha));
      row.addEventListener('dblclick', () => A.checkout(b.name));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); A.refMenu({ kind: 'local', name: b.name, current: b.current, ref: b }, e); });
      return row;
    };
    body.append(section(repo, 'local', 'LOCAL', 'laptop', refs.local.length, tree(local, 0, localLeaf),
      h('button', { class: 'side-act', title: 'New branch (⇧⌘B)', onclick: () => A.newBranch() }, icon('plus'))));

    // REMOTE
    const remoteItems = [];
    for (const rem of remotes) {
      const key = 'r:' + rem.name;
      const branches = refs.remote.filter((r) => r.remote === rem.name && match(r.name));
      if (q && !branches.length) continue;
      const open = !repo.collapsed.has(key) || !!q;
      const row = h('div', { class: 'side-row remote', style: { '--d': 0 }, title: rem.url }, icon(open ? 'chevronDown' : 'chevronRight', 'mini'), icon('cloud'), h('span', { class: 'name' }, rem.name), h('span', { class: 'side-count' }, branches.length));
      row.addEventListener('click', () => { repo.collapsed.has(key) ? repo.collapsed.delete(key) : repo.collapsed.add(key); render(); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); A.remoteMenu(rem, e); });
      remoteItems.push(row);
      if (open) {
        remoteItems.push(...tree(branches.map((r) => ({ label: r.branch, r, prefix: rem.name })), 1, (it, d) => {
          const r = it.r;
          const el2 = h('div', { class: 'side-row branch' + (repo.sel === r.sha ? ' sel' : ''), style: { '--d': d } }, icon('branch'), h('span', { class: 'name' }, it.label));
          el2.addEventListener('click', () => onSelectSha(r.sha));
          el2.addEventListener('dblclick', () => A.checkoutRemote(r.name));
          el2.addEventListener('contextmenu', (e) => { e.preventDefault(); A.refMenu({ kind: 'remote', name: r.name, ref: r }, e); });
          return el2;
        }));
      }
    }
    if (!remotes.length) remoteItems.push(h('button', { class: 'side-empty', onclick: () => A.addRemote() }, icon('plus'), 'Add a remote…'));
    body.append(section(repo, 'remote', 'REMOTE', 'cloud', refs.remote.length, remoteItems,
      h('button', { class: 'side-act', title: 'Add remote', onclick: () => A.addRemote() }, icon('plus'))));

    // TAGS
    const tags = refs.tags.filter((t) => match(t.name)).sort((a, b) => b.date - a.date);
    body.append(section(repo, 'tags', 'TAGS', 'tag', refs.tags.length, tags.map((t) => {
      const row = h('div', { class: 'side-row' + (repo.sel === t.sha ? ' sel' : ''), style: { '--d': 0 } }, icon('tag'), h('span', { class: 'name' }, t.name));
      row.addEventListener('click', () => onSelectSha(t.sha));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); A.refMenu({ kind: 'tag', name: t.name, ref: t }, e); });
      return row;
    })));

    // STASHES
    const st = stashes.filter((s) => match(s.subject));
    body.append(section(repo, 'stashes', 'STASHES', 'stash', stashes.length, st.length ? st.map((s) => {
      const row = h('div', { class: 'side-row stash' + (repo.sel === s.sha ? ' sel' : ''), style: { '--d': 0 }, title: s.subject }, icon('stash'), h('span', { class: 'name' }, s.subject.replace(/^(WIP )?[Oo]n [^:]+: /, '')));
      row.addEventListener('click', () => onSelectStash(s));
      row.addEventListener('dblclick', () => A.pop(s.ref));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); A.stashMenu(s, e); });
      return row;
    }) : h('div', { class: 'side-none' }, 'No stashes')));
  }

  return { el, render, focusFilter: () => filter.focus() };
}
