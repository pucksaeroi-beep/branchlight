// User-facing git actions: dialogs, confirmations and context menus.
import { h, icon, popupMenu, modal, confirm, toast } from './ui/h.js';
import { app, op, render, showError } from './app.js';

const R = () => app.active;
const short = (sha) => sha.slice(0, 7);
const copy = (t, what = 'Copied') => window.bl.shell.copy(t).then(() => toast(what));
const cleanName = (s) => s.trim().replace(/\s+/g, '-').replace(/\.\.+/g, '.').replace(/^[-.]+/, '').replace(/[~^:?*[\\\x00-\x20]/g, '');
const localNames = () => new Set(R().snap.refs.local.map((b) => b.name));

// ---------------------------------------------------------------- branches

export async function checkout(name) {
  if (name === R().branch) return;
  if (await op('checkout', [name], { ok: `Switched to ${name}`, quiet: true })) return;
  if (!/would be overwritten|commit your changes or stash/i.test(app.lastError || '')) return showError(app.lastError, 'switch');
  const r = await modal(`Switch to ${name}?`, h('p', {}, 'Your local changes conflict with that branch. Branchlight can stash them, switch, and re-apply them on the new branch.'),
    [{ label: 'Cancel' }, { label: 'Stash & Switch', primary: true, value: true }]);
  if (!r) return;
  if (!(await op('stash', [`Auto-stash before switching to ${name}`], { reload: false }))) return;
  if (await op('checkout', [name], { reload: false })) await op('stashApply', ['stash@{0}', true], { ok: `Switched to ${name} with your changes` });
  else { await R().load(); render(); }
}

export async function checkoutRemote(remoteName) {
  const branch = remoteName.slice(remoteName.indexOf('/') + 1);
  if (localNames().has(branch)) {
    const local = R().snap.refs.local.find((b) => b.name === branch);
    if (local.upstream === remoteName) return checkout(branch);
  }
  const name = localNames().has(branch) ? await branchName(`Check out ${remoteName} as`, branch + '-2') : branch;
  if (name) await op('checkoutRemote', [remoteName, name], { ok: `Checked out ${name} tracking ${remoteName}` });
}

export async function checkoutCommit(sha) {
  if (await confirm('Check out commit?', `HEAD will be detached at ${short(sha)}. Create a branch afterwards if you want to keep new commits.`, 'Check Out')) {
    await op('checkoutDetached', [sha], { ok: `HEAD is now at ${short(sha)}` });
  }
}

async function branchName(title, value = '', extra = null) {
  const input = h('input', { class: 'input mono', value, placeholder: 'feature/my-branch', spellcheck: 'false' });
  const hint = h('div', { class: 'hint' });
  input.addEventListener('input', () => {
    const v = cleanName(input.value);
    hint.textContent = v && v !== input.value.trim() ? `Will be created as “${v}”` : localNames().has(v) ? 'A branch with this name already exists' : '';
  });
  const r = await modal(title, [input, hint, extra], [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: (c) => c(cleanName(input.value)) }]);
  return r || null;
}

export async function newBranch(at = null) {
  const repo = R();
  at ||= repo.sel && repo.sel !== 'WIP' ? repo.sel : repo.snap.head;
  if (!at) return toast('Make a first commit before creating branches', 'error');
  const co = h('input', { type: 'checkbox', checked: true });
  const extra = h('label', { class: 'check' }, co, 'Check out the new branch');
  const name = await branchName(`New branch at ${short(at)}`, '', extra);
  if (name) await op('branch', [name, at, co.checked], { ok: `Created ${name}` });
}

export async function renameBranch(name) {
  const to = await branchName(`Rename ${name}`, name);
  if (to && to !== name) await op('renameBranch', [name, to], { ok: `Renamed to ${to}` });
}

export async function deleteBranch(name) {
  const b = R().snap.refs.local.find((x) => x.name === name);
  const remote = b?.upstream && !b.gone ? h('input', { type: 'checkbox' }) : null;
  const ok = await modal(`Delete ${name}?`, [h('p', {}, 'The branch label is removed; commits stay reachable from other branches.'),
    remote ? h('label', { class: 'check' }, remote, `Also delete ${b.upstream} on the remote`) : null],
  [{ label: 'Cancel' }, { label: 'Delete', primary: true, danger: true, value: true }]);
  if (!ok) return;
  let done = await op('deleteBranch', [name, false], { quiet: true, reload: false });
  if (!done && await confirm(`${name} is not fully merged`, 'Delete it anyway? Commits only on this branch may be lost.', 'Force Delete', true)) {
    done = await op('deleteBranch', [name, true], { reload: false });
  }
  if (done && remote?.checked) {
    const i = b.upstream.indexOf('/');
    await op('deleteRemoteBranch', [b.upstream.slice(0, i), b.upstream.slice(i + 1)], { reload: false });
  }
  await R().load(); render();
  if (done) toast(`Deleted ${name}`);
}

export async function deleteRemoteBranch(full) {
  const i = full.indexOf('/');
  if (await confirm(`Delete ${full}?`, 'This removes the branch from the remote server for everyone.', 'Delete on Remote', true)) {
    await op('deleteRemoteBranch', [full.slice(0, i), full.slice(i + 1)], { ok: `Deleted ${full}` });
  }
}

export async function merge(name) {
  const cur = R().branch;
  const noff = h('input', { type: 'checkbox' });
  const squash = h('input', { type: 'checkbox' });
  const ok = await modal(`Merge ${name} into ${cur || 'HEAD'}`, [
    h('label', { class: 'check' }, noff, 'Always create a merge commit (--no-ff)'),
    h('label', { class: 'check' }, squash, 'Squash into one change (--squash, commit yourself)')],
  [{ label: 'Cancel' }, { label: 'Merge', primary: true, value: true }]);
  if (ok) await op('merge', [name, { noFF: noff.checked, squash: squash.checked }], { ok: `Merged ${name}` });
}

export async function rebase(onto) {
  if (await confirm(`Rebase ${R().branch || 'HEAD'} onto ${onto}?`, 'Your local commits are replayed on top. Don’t rebase commits others already pulled.', 'Rebase')) {
    await op('rebase', [onto], { ok: `Rebased onto ${onto}` });
  }
}

export async function setUpstream(name) {
  const remotes = R().snap.refs.remote.map((r) => r.name);
  if (!remotes.length) return toast('No remote branches', 'error');
  const sel = h('select', { class: 'input' }, remotes.map((r) => h('option', { value: r, selected: r.endsWith('/' + name) }, r)));
  const r = await modal(`Upstream for ${name}`, sel, [{ label: 'Cancel' }, { label: 'Set', primary: true, onClick: (c) => c(sel.value) }]);
  if (r) await op('setUpstream', [name, r], { ok: `${name} now tracks ${r}` });
}

// ---------------------------------------------------------------- commits

export async function newTag(at) {
  const repo = R();
  at ||= repo.sel && repo.sel !== 'WIP' ? repo.sel : repo.snap.head;
  const name = h('input', { class: 'input mono', placeholder: 'v1.2.0', spellcheck: 'false' });
  const msg = h('input', { class: 'input', placeholder: 'Message (optional — makes an annotated tag)' });
  const r = await modal(`New tag at ${short(at)}`, [name, msg], [{ label: 'Cancel' }, { label: 'Create Tag', primary: true, onClick: (c) => c({ n: cleanName(name.value), m: msg.value.trim() }) }]);
  if (r?.n) await op('tag', [r.n, at, r.m || null], { ok: `Tagged ${r.n}` });
}

export async function reset(sha, mode) {
  const text = { soft: 'Keep all changes staged.', mixed: 'Keep changes in the working tree, unstaged.', hard: 'Discard every uncommitted change and every commit after this one. This cannot be undone.' }[mode];
  if (await confirm(`Reset ${R().branch || 'HEAD'} to ${short(sha)} (${mode})?`, text, 'Reset', mode === 'hard')) {
    await op('reset', [sha, mode], { ok: `Reset to ${short(sha)}` });
  }
}

export async function cherryPick(c) {
  if (await confirm('Cherry-pick commit?', `Apply “${c.subject}” on top of ${R().branch || 'HEAD'}.`, 'Cherry-pick')) await op('cherryPick', [c.sha], { ok: 'Cherry-picked' });
}

export async function revert(c) {
  if (await confirm('Revert commit?', `Create a new commit that undoes “${c.subject}”.`, 'Revert')) await op('revert', [c.sha, c.parents.length > 1], { ok: 'Reverted' });
}

export function commitMenu(c, e) {
  const repo = R();
  if (c.wip) {
    return popupMenu([
      { label: 'Stash Changes…', icon: 'stash', onClick: () => stash() },
      { label: 'Discard All Changes…', icon: 'trash', danger: true, onClick: () => discardAll() },
    ], e);
  }
  const branches = (repo.refsBySha.get(c.sha) || []).filter((r) => r.kind === 'local' && !r.current);
  popupMenu([
    ...branches.map((b) => ({ label: `Check Out ${b.name}`, icon: 'branch', onClick: () => checkout(b.name) })),
    { label: 'Check Out This Commit…', icon: 'commit', onClick: () => checkoutCommit(c.sha) },
    '-',
    { label: 'New Branch Here…', icon: 'branch', kbd: '⇧⌘B', onClick: () => newBranch(c.sha) },
    { label: 'New Tag Here…', icon: 'tag', kbd: '⇧⌘T', onClick: () => newTag(c.sha) },
    '-',
    { label: 'Cherry-pick', icon: 'cherry', onClick: () => cherryPick(c) },
    { label: 'Revert Commit', icon: 'undo', onClick: () => revert(c) },
    { header: `Reset ${repo.branch || 'HEAD'} to here` },
    { label: 'Soft — keep changes staged', icon: 'reset', onClick: () => reset(c.sha, 'soft') },
    { label: 'Mixed — keep working copy', icon: 'reset', onClick: () => reset(c.sha, 'mixed') },
    { label: 'Hard — discard everything', icon: 'reset', danger: true, onClick: () => reset(c.sha, 'hard') },
    '-',
    { label: 'Copy SHA', icon: 'copy', onClick: () => copy(c.sha, 'SHA copied') },
    { label: 'Copy Message', icon: 'copy', onClick: () => copy(c.subject, 'Message copied') },
  ], e);
}

export function refMenu(r, e) {
  const cur = R().branch;
  if (r.kind === 'local') {
    const b = r.ref;
    return popupMenu([
      { label: r.current ? `${r.name} is checked out` : `Check Out ${r.name}`, icon: 'check', disabled: r.current, onClick: () => checkout(r.name) },
      '-',
      { label: `Merge ${r.name} into ${cur}`, icon: 'merge', disabled: r.current || !cur, onClick: () => merge(r.name) },
      { label: `Rebase ${cur} onto ${r.name}`, icon: 'branch', disabled: r.current || !cur, onClick: () => rebase(r.name) },
      '-',
      { label: 'Push', icon: 'push', disabled: !r.current, onClick: () => push() },
      { label: b.upstream ? `Tracking ${b.upstream}…` : 'Set Upstream…', icon: 'cloud', onClick: () => setUpstream(r.name) },
      { label: 'New Branch From Here…', icon: 'branch', onClick: () => newBranch(b.sha) },
      { label: 'Rename…', icon: 'edit', onClick: () => renameBranch(r.name) },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: r.current, onClick: () => deleteBranch(r.name) },
      '-',
      { label: 'Copy Branch Name', icon: 'copy', onClick: () => copy(r.name) },
    ], e);
  }
  if (r.kind === 'remote') {
    return popupMenu([
      { label: `Check Out ${r.name}`, icon: 'check', onClick: () => checkoutRemote(r.name) },
      { label: `Merge into ${cur}`, icon: 'merge', disabled: !cur, onClick: () => merge(r.name) },
      { label: `Rebase ${cur} onto ${r.name}`, icon: 'branch', disabled: !cur, onClick: () => rebase(r.name) },
      '-',
      { label: 'Delete on Remote…', icon: 'trash', danger: true, onClick: () => deleteRemoteBranch(r.name) },
      { label: 'Copy Branch Name', icon: 'copy', onClick: () => copy(r.name) },
    ], e);
  }
  if (r.kind === 'tag') {
    const remote = R().snap.remotes[0]?.name;
    return popupMenu([
      { label: 'Check Out Tag…', icon: 'commit', onClick: () => checkoutCommit(r.ref.sha) },
      { label: remote ? `Push to ${remote}` : 'Push (no remote)', icon: 'push', disabled: !remote, onClick: () => net('pushTag', [remote, r.name], `Pushed ${r.name}`) },
      { label: 'Delete Tag…', icon: 'trash', danger: true, onClick: async () => { if (await confirm(`Delete tag ${r.name}?`, 'Only the local tag is deleted.', 'Delete', true)) op('deleteTag', [r.name], { ok: 'Tag deleted' }); } },
      { label: 'Copy Tag Name', icon: 'copy', onClick: () => copy(r.name) },
    ], e);
  }
  return null;
}

export function refOpen(r) {
  if (r.kind === 'local') return checkout(r.name);
  if (r.kind === 'remote') return checkoutRemote(r.name);
  if (r.kind === 'tag') return checkoutCommit(r.ref.sha);
}

// ---------------------------------------------------------------- stash

export async function stash() {
  const repo = R();
  if (!repo.changes) return toast('Nothing to stash');
  const msg = h('input', { class: 'input', placeholder: 'Stash message (optional)' });
  const keep = h('input', { type: 'checkbox' });
  const r = await modal('Stash changes', [msg, h('label', { class: 'check' }, keep, 'Keep staged changes in the index')],
    [{ label: 'Cancel' }, { label: 'Stash', primary: true, onClick: (c) => c({ m: msg.value.trim() }) }]);
  if (r) await op('stash', [r.m, { keepIndex: keep.checked }], { ok: 'Changes stashed' });
}

export async function pop(ref = null) {
  const s = R().snap.stashes;
  if (!s.length) return toast('No stashes');
  await op('stashApply', [ref || s[0].ref, true], { ok: 'Stash applied and dropped' });
}

export function stashMenu(s, e) {
  popupMenu([
    { label: 'Apply', icon: 'pop', onClick: () => op('stashApply', [s.ref, false], { ok: 'Stash applied' }) },
    { label: 'Pop (apply + drop)', icon: 'pop', onClick: () => pop(s.ref) },
    '-',
    { label: 'Drop…', icon: 'trash', danger: true, onClick: async () => { if (await confirm(`Drop ${s.ref}?`, s.subject, 'Drop', true)) op('stashDrop', [s.ref], { ok: 'Stash dropped' }); } },
  ], e);
}

export async function discardAll() {
  const st = R().status;
  const files = [...st.unstaged];
  if (!files.length && !st.staged.length) return;
  if (!(await confirm('Discard all changes?', `${files.length + st.staged.length} file(s). Untracked files are deleted. This cannot be undone.`, 'Discard All', true))) return;
  if (st.staged.length) await op('unstage', [st.staged.map((f) => f.path)], { reload: false });
  const after = await window.bl.git.status(R().path);
  await op('discard', [after.unstaged], { ok: 'Changes discarded' });
}

// ---------------------------------------------------------------- network

async function net(name, args, ok) {
  const repo = R();
  repo.netOp = name; app.views.renderToolbar?.();
  const done = await op(name, args, { ok });
  repo.netOp = null; app.views.renderToolbar?.();
  return done;
}

export const fetch = () => net('fetch', [], 'Fetched all remotes');
export async function pull(mode) {
  const repo = R();
  if (!repo.status?.upstream) return toast(`${repo.branch || 'HEAD'} has no upstream — push it first or set one`, 'error');
  return net('pull', [mode || app.settings.pullMode || 'merge'], 'Pulled');
}
export async function push(opts = {}) {
  const repo = R();
  if (!repo.snap.remotes.length) return toast('This repository has no remote. Add one from the sidebar.', 'error');
  if (repo.status.behind > 0 && !opts.force) {
    const r = await modal('Branch is behind its remote', h('p', {}, `${repo.branch} is ${repo.status.behind} commit(s) behind ${repo.status.upstream}. Pull first, or force-push (with lease) to overwrite the remote.`),
      [{ label: 'Cancel' }, { label: 'Pull First', value: 'pull' }, { label: 'Force Push', danger: true, primary: true, value: 'force' }]);
    if (r === 'pull') return pull();
    if (r !== 'force') return;
    opts.force = true;
  }
  return net('push', [opts], repo.status.upstream ? 'Pushed' : `Pushed and set upstream for ${repo.branch}`);
}

export function pullMenu(anchor) {
  const m = app.settings.pullMode || 'merge';
  popupMenu([
    { header: 'Pull' },
    { label: 'Fetch all', icon: 'fetch', onClick: fetch },
    { label: 'Pull (merge)', icon: 'pull', checked: m === 'merge', onClick: () => pull('merge') },
    { label: 'Pull (rebase)', icon: 'pull', checked: m === 'rebase', onClick: () => pull('rebase') },
    { label: 'Pull (fast-forward only)', icon: 'pull', checked: m === 'ff-only', onClick: () => pull('ff-only') },
  ], anchor);
}
export function pushMenu(anchor) {
  popupMenu([
    { header: 'Push' },
    { label: 'Push', icon: 'push', onClick: () => push() },
    { label: 'Push with tags', icon: 'tag', onClick: () => push({ tags: true }) },
    { label: 'Force push (with lease)…', icon: 'alert', danger: true, onClick: async () => { if (await confirm('Force push?', 'Overwrites the remote branch if nobody pushed since your last fetch.', 'Force Push', true)) push({ force: true }); } },
  ], anchor);
}

export async function addRemote() {
  const name = h('input', { class: 'input mono', value: R().snap.remotes.length ? '' : 'origin', placeholder: 'origin' });
  const url = h('input', { class: 'input mono', placeholder: 'git@github.com:you/repo.git' });
  const r = await modal('Add remote', [h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'URL', url)],
    [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: (c) => c({ n: name.value.trim(), u: url.value.trim() }) }]);
  if (r?.n && r?.u) await op('addRemote', [r.n, r.u], { ok: `Added ${r.n}` });
}

export function remoteMenu(rem, e) {
  popupMenu([
    { label: 'Copy URL', icon: 'copy', onClick: () => copy(rem.url) },
    { label: 'Open in Browser', icon: 'globe', disabled: !webUrl(rem.url), onClick: () => window.bl.shell.external(webUrl(rem.url)) },
    { label: 'Fetch', icon: 'fetch', onClick: fetch },
    '-',
    { label: 'Remove Remote…', icon: 'trash', danger: true, onClick: async () => { if (await confirm(`Remove ${rem.name}?`, 'Only the local configuration is removed.', 'Remove', true)) op('removeRemote', [rem.name], { ok: 'Remote removed' }); } },
  ], e);
}

export function webUrl(url) {
  let m = /^git@([^:]+):(.+?)(\.git)?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?(.+?)(\.git)?$/.exec(url);
  return m ? `https://${m[1]}` : null;
}

export { icon };
