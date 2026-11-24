// Right panel: commit details, or the working-copy view (stage / unstage / commit).
import { h, icon, clear, fmtDate, fmtRelative, popupMenu, toast, confirm, modal } from '../ui/h.js';
import { avatar } from '../ui/avatar.js';
import { app, op, render, showError, identityDialog } from '../app.js';
import * as A from '../actions.js';

const ST = {
  added: ['A', 'add'], modified: ['M', 'mod'], deleted: ['D', 'del'], renamed: ['R', 'ren'], copied: ['C', 'ren'],
  typechange: ['T', 'mod'], untracked: ['U', 'add'], conflict: ['!', 'conf'],
};
export const statusBadge = (s) => h('span', { class: 'st st-' + (ST[s]?.[1] || 'mod'), title: s }, ST[s]?.[0] || '?');

export function fileLabel(p, from) {
  const i = p.lastIndexOf('/');
  return h('span', { class: 'fname' }, h('b', {}, p.slice(i + 1)), i > 0 ? h('span', { class: 'fdir' }, p.slice(0, i)) : null,
    from ? h('span', { class: 'fdir', title: from }, ` ← ${from.split('/').pop()}`) : null);
}

export function createPanel({ openDiff, selectSha }) {
  const el = h('section', { class: 'panel' });
  const cache = new Map();
  let loading = null;

  async function render_() {
    const repo = app.active;
    if (!repo?.snap) return clear(el);
    if (repo.sel === 'WIP' || (!repo.snap.commits.length)) return renderChanges(repo);
    const sha = repo.sel;
    if (!sha) return clear(el);
    let c = cache.get(repo.path + sha);
    if (!c) {
      if (loading !== sha) {
        loading = sha;
        clear(el).append(h('div', { class: 'panel-loading' }, h('div', { class: 'spinner' })));
        try { c = await window.bl.git.commit(repo.path, sha); cache.set(repo.path + sha, c); if (cache.size > 300) cache.delete(cache.keys().next().value); }
        catch (e) { loading = null; clear(el).append(h('div', { class: 'panel-empty' }, e.message)); return; }
        loading = null;
        if (app.active !== repo || repo.sel !== sha) return;
      } else return;
    }
    renderCommit(repo, c);
  }

  // ------------------------------------------------------------ commit details
  function renderCommit(repo, c) {
    const stash = repo.snap.stashes.find((s) => s.sha === c.sha);
    const refs = repo.refsBySha.get(c.sha) || [];
    const add = c.files.reduce((a, f) => a + f.add, 0), del = c.files.reduce((a, f) => a + f.del, 0);
    const sameCommitter = c.committer === c.author;
    const files = h('div', { class: 'files' }, c.files.map((f) => {
      const active = repo.diff?.kind === 'commit' && repo.diff.sha === c.sha && repo.diff.file.path === f.path;
      const row = h('div', { class: 'file' + (active ? ' active' : '') }, statusBadge(f.status), fileLabel(f.path, f.from),
        h('span', { class: 'fstat' }, f.binary ? h('span', { class: 'muted' }, 'bin') : [f.add ? h('span', { class: 'plus' }, '+' + f.add) : null, f.del ? h('span', { class: 'minus' }, '−' + f.del) : null]));
      row.addEventListener('click', () => openDiff({ kind: 'commit', sha: c.sha, parent: c.parents[0] || null, file: f, list: c.files }));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(repo, f, e, false); });
      return row;
    }));
    clear(el).append(
      h('div', { class: 'panel-scroll' },
        stash ? h('div', { class: 'stash-bar' }, icon('stash'), h('span', {}, stash.ref),
          h('button', { class: 'btn small', onclick: () => op('stashApply', [stash.ref, false], { ok: 'Stash applied' }) }, 'Apply'),
          h('button', { class: 'btn small primary', onclick: () => A.pop(stash.ref) }, 'Pop'),
          h('button', { class: 'btn small ghost danger', onclick: async () => { if (await confirm(`Drop ${stash.ref}?`, stash.subject, 'Drop', true)) op('stashDrop', [stash.ref], { ok: 'Stash dropped' }); } }, icon('trash'))) : null,
        h('div', { class: 'c-head' },
          h('div', { class: 'c-sha' },
            h('span', { class: 'mono' }, 'commit: '), h('button', { class: 'sha-btn mono', title: 'Copy SHA', onclick: () => window.bl.shell.copy(c.sha).then(() => toast('SHA copied')) }, c.sha.slice(0, 10), icon('copy'))),
          c.parents.length ? h('div', { class: 'c-parents' }, c.parents.length > 1 ? 'merge of ' : 'parent ',
            c.parents.map((p) => h('button', { class: 'sha-link mono', onclick: () => selectSha(p) }, p.slice(0, 7)))) : h('div', { class: 'c-parents' }, 'root commit')),
        h('h2', { class: 'c-subject' }, c.subject),
        c.body ? h('pre', { class: 'c-body' }, c.body) : null,
        refs.length ? h('div', { class: 'c-refs' }, refs.map((r) => h('span', { class: 'chip ' + r.kind }, icon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch'), r.name))) : null,
        h('div', { class: 'c-author' }, avatar(c.author, c.email, 36),
          h('div', {}, h('div', { class: 'c-name' }, c.author), h('div', { class: 'muted small' }, c.email)),
          h('div', { class: 'c-when', title: fmtDate(c.date) }, h('div', {}, fmtRelative(c.date)), h('div', { class: 'muted small' }, fmtDate(c.date)))),
        !sameCommitter ? h('div', { class: 'muted small c-committer' }, `committed by ${c.committer} · ${fmtRelative(c.cdate)}`) : null,
        h('div', { class: 'files-head' }, h('span', {}, `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`),
          h('span', { class: 'fstat' }, h('span', { class: 'plus' }, '+' + add), h('span', { class: 'minus' }, '−' + del))),
        files));
  }

  // ------------------------------------------------------------ working copy
  function renderChanges(repo) {
    const st = repo.status;
    const opBanner = repo.operation ? h('div', { class: 'op-banner' }, icon('alert'),
      h('div', {}, h('b', {}, `${repo.operation[0].toUpperCase() + repo.operation.slice(1)} in progress`),
        h('div', { class: 'small' }, st.conflicts.length ? `Resolve ${st.conflicts.length} conflicted file(s), then continue.` : 'All conflicts resolved — continue when ready.')),
      h('div', { class: 'op-actions' },
        h('button', { class: 'btn small', onclick: () => op('abort', [repo.operation], { ok: 'Aborted' }) }, 'Abort'),
        h('button', { class: 'btn small primary', disabled: st.conflicts.length > 0, onclick: () => op('continue', [repo.operation], { ok: 'Continued' }) }, 'Continue'))) : null;

    const list = (files, staged) => h('div', { class: 'files' }, files.map((f) => {
      const active = repo.diff?.kind === 'work' && repo.diff.file.path === f.path && repo.diff.staged === staged;
      const row = h('div', { class: 'file' + (active ? ' active' : '') }, statusBadge(f.status), fileLabel(f.path, f.from),
        h('span', { class: 'file-acts' },
          !staged ? h('button', { class: 'icon-btn', title: 'Discard changes', onclick: (e) => { e.stopPropagation(); discard(repo, [f]); } }, icon('undo')) : null,
          h('button', { class: 'icon-btn stage', title: staged ? 'Unstage' : 'Stage', onclick: (e) => { e.stopPropagation(); toggle(repo, f, staged); } }, icon(staged ? 'minus' : 'plus'))));
      row.addEventListener('click', () => openDiff({ kind: 'work', file: f, staged, list: files }));
      row.addEventListener('dblclick', () => toggle(repo, f, staged));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(repo, f, e, true, staged); });
      return row;
    }));

    const conflicts = st.conflicts.length ? h('div', { class: 'wsec conflicts' },
      h('div', { class: 'wsec-head' }, icon('alert'), h('span', {}, `Conflicts (${st.conflicts.length})`)),
      h('div', { class: 'files' }, st.conflicts.map((f) => {
        const row = h('div', { class: 'file' }, statusBadge('conflict'), fileLabel(f.path),
          h('span', { class: 'file-acts show' },
            h('button', { class: 'btn tiny', title: 'Keep our version', onclick: (e) => { e.stopPropagation(); op('resolve', [f.path, 'ours'], { ok: 'Resolved with ours' }); } }, 'Ours'),
            h('button', { class: 'btn tiny', title: 'Take their version', onclick: (e) => { e.stopPropagation(); op('resolve', [f.path, 'theirs'], { ok: 'Resolved with theirs' }); } }, 'Theirs'),
            h('button', { class: 'btn tiny primary', title: 'Mark as resolved (git add)', onclick: (e) => { e.stopPropagation(); op('resolve', [f.path, null], { ok: 'Marked resolved' }); } }, icon('check'))));
        row.addEventListener('click', () => openDiff({ kind: 'work', file: { ...f, status: 'conflict' }, staged: false, list: st.conflicts.map((x) => ({ ...x, status: 'conflict' })) }));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(repo, f, e, true, false); });
        return row;
      }))) : null;

    const summary = h('input', { class: 'commit-summary', placeholder: 'Commit summary', value: repo.message.summary, spellcheck: 'true' });
    const count = h('span', { class: 'count' });
    const body = h('textarea', { class: 'commit-body', placeholder: 'Description', rows: 4, spellcheck: 'true' });
    body.value = repo.message.body;
    const amend = h('input', { type: 'checkbox', checked: repo.message.amend });
    const btn = h('button', { class: 'btn commit-btn' });
    const refresh = () => {
      const n = summary.value.length;
      count.textContent = n ? String(72 - n) : '';
      count.className = 'count' + (n > 72 ? ' over' : n > 50 ? ' warn' : '');
      const staged = st.staged.length;
      btn.disabled = repo.busy > 0 || (!summary.value.trim() && !amend.checked) || st.conflicts.length > 0 && repo.operation !== 'merge';
      btn.textContent = amend.checked ? 'Amend previous commit' : staged ? `Commit changes to ${staged} file${staged === 1 ? '' : 's'}` : st.unstaged.length ? 'Stage all & commit' : 'Commit';
      const graph = app.views.graph;
      if (graph) graph.draw();
    };
    summary.addEventListener('input', () => { repo.message.summary = summary.value; refresh(); });
    body.addEventListener('input', () => { repo.message.body = body.value; });
    amend.addEventListener('change', async () => {
      repo.message.amend = amend.checked;
      if (amend.checked && !summary.value.trim()) {
        const last = await window.bl.git.lastMessage(repo.path);
        const nl = last.indexOf('\n');
        summary.value = repo.message.summary = nl < 0 ? last : last.slice(0, nl);
        body.value = repo.message.body = nl < 0 ? '' : last.slice(nl + 1).trim();
      }
      refresh();
    });
    const doCommit = () => commit(repo);
    btn.addEventListener('click', doCommit);
    for (const x of [summary, body]) x.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); doCommit(); } });
    refresh();

    const user = repo.snap.user;
    clear(el).append(
      h('div', { class: 'panel-scroll changes' },
        opBanner,
        h('div', { class: 'wip-title' }, h('span', {}, repo.changes ? `${repo.changes} file change${repo.changes === 1 ? '' : 's'} on ` : 'Working tree clean on '),
          h('span', { class: 'chip local' }, icon('branch'), repo.branch || 'detached HEAD')),
        conflicts,
        h('div', { class: 'wsec' },
          h('div', { class: 'wsec-head' }, h('span', {}, `Unstaged Files (${st.unstaged.length})`),
            st.unstaged.length ? h('button', { class: 'btn tiny stage-all', onclick: () => op('stage', [st.unstaged.map((f) => f.path)]) }, 'Stage all changes') : null),
          st.unstaged.length ? list(st.unstaged, false) : h('div', { class: 'side-none' }, 'Nothing to stage')),
        h('div', { class: 'wsec' },
          h('div', { class: 'wsec-head' }, h('span', {}, `Staged Files (${st.staged.length})`),
            st.staged.length ? h('button', { class: 'btn tiny unstage-all', onclick: () => op('unstage', [st.staged.map((f) => f.path)]) }, 'Unstage all') : null),
          st.staged.length ? list(st.staged, true) : h('div', { class: 'side-none' }, 'Stage files to include them in the commit'))),
      h('div', { class: 'commit-box' },
        h('div', { class: 'commit-head' }, h('span', {}, 'Commit'), user.email ? h('span', { class: 'commit-as', title: `${user.name} <${user.email}>` }, avatar(user.name, user.email, 18), user.name) :
          h('button', { class: 'btn tiny', onclick: () => identityDialog(repo) }, 'Set identity…')),
        h('div', { class: 'summary-wrap' }, summary, count),
        body,
        h('label', { class: 'check small' }, amend, 'Amend previous commit'),
        btn));
  }

  async function toggle(repo, f, staged) {
    await op(staged ? 'unstage' : 'stage', [[f.path, ...(f.from && staged ? [f.from] : [])]]);
  }

  async function discard(repo, files) {
    const names = files.map((f) => f.path).join(', ');
    const untracked = files.some((f) => f.status === 'untracked');
    if (await confirm('Discard changes?', `${names}\n\n${untracked ? 'Untracked files will be deleted. ' : ''}This cannot be undone.`, 'Discard', true)) {
      if (repo.diff?.kind === 'work' && files.some((f) => f.path === repo.diff.file.path)) repo.diff = null;
      await op('discard', [files], { ok: 'Discarded' });
    }
  }

  async function commit(repo) {
    const st = repo.status;
    const msg = [repo.message.summary.trim(), repo.message.body.trim()].filter(Boolean).join('\n\n');
    if (!msg) return toast('Write a commit summary first', 'error');
    if (!st.staged.length && !repo.message.amend) {
      if (!st.unstaged.length && !repo.operation) return toast('Nothing to commit');
      if (st.unstaged.length) {
        const ok = await modal('Nothing is staged', h('p', {}, `Stage all ${st.unstaged.length} changed file(s) and commit them?`), [{ label: 'Cancel' }, { label: 'Stage All & Commit', primary: true, value: true }]);
        if (!ok) return;
        if (!(await op('stage', [st.unstaged.map((f) => f.path)], { reload: false }))) return;
      }
    }
    repo.busy++; render_();
    try {
      await window.bl.git.op(repo.path, 'commit', msg, { amend: repo.message.amend });
      repo.message = { summary: '', body: '', amend: false };
      repo.diff = null;
      toast('Committed');
    } catch (e) { showError(e.message, 'commit', repo); }
    repo.busy--;
    await repo.load();
    repo.sel = repo.index.has('WIP') ? 'WIP' : repo.snap.head;
    render();
  }

  function fileMenu(repo, f, e, work, staged) {
    popupMenu([
      work && !staged && f.status !== 'conflict' ? { label: 'Stage', icon: 'plus', onClick: () => toggle(repo, f, false) } : null,
      work && staged ? { label: 'Unstage', icon: 'minus', onClick: () => toggle(repo, f, true) } : null,
      work && !staged && f.status !== 'conflict' ? { label: 'Discard Changes…', icon: 'undo', danger: true, onClick: () => discard(repo, [f]) } : null,
      work && f.status === 'untracked' ? { label: 'Ignore File', icon: 'eye', onClick: () => op('ignore', [f.path], { ok: 'Added to .gitignore' }) } : null,
      work && f.status === 'untracked' && f.path.includes('.') ? { label: `Ignore *.${f.path.split('.').pop()}`, icon: 'eye', onClick: () => op('ignore', [`*.${f.path.split('.').pop()}`], { ok: 'Added to .gitignore' }) } : null,
      work ? '-' : null,
      { label: 'File History', icon: 'history', onClick: () => fileHistory(repo, f.path) },
      { label: 'Open in Editor', icon: 'code', disabled: f.status === 'deleted', onClick: () => window.bl.shell.editor(repo.path, f.path) },
      { label: 'Reveal in Finder', icon: 'folder', disabled: f.status === 'deleted', onClick: () => window.bl.shell.finder(repo.path, f.path) },
      { label: 'Copy Path', icon: 'copy', onClick: () => window.bl.shell.copy(f.path).then(() => toast('Path copied')) },
    ], e);
  }

  async function fileHistory(repo, path) {
    let commits;
    try { commits = await window.bl.git.fileLog(repo.path, path); } catch (e) { return showError(e.message); }
    const listEl = h('div', { class: 'history-list' }, commits.map((c) => h('button', { class: 'history-row', onclick: () => { close(); selectSha(c.sha); } },
      avatar(c.author, c.email, 24),
      h('div', { class: 'hist-main' }, h('div', { class: 'hist-sub' }, c.subject), h('div', { class: 'muted small' }, `${c.author} · ${fmtRelative(c.date)}`)),
      h('span', { class: 'mono muted small' }, c.sha.slice(0, 7)))));
    let close = () => {};
    modal(h('span', {}, icon('history'), ' History of ', h('span', { class: 'mono' }, path)), commits.length ? listEl : h('p', { class: 'muted' }, 'No commits'), [{ label: 'Close' }], { class: 'wide' });
    close = () => document.querySelector('.modal-back.show')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }

  return { el, render: render_, invalidate: () => cache.clear() };
}
