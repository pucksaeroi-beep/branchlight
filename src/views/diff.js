// Diff viewer: unified / split, word-level highlights, hunk + line staging, image previews.
import { h, icon, clear, toast, confirm } from '../ui/h.js';
import { app, S, op, render } from '../app.js';
import { buildPatch, selectionHasChanges, inlineDiff } from '../lib/patch.js';
import { statusBadge } from './panel.js';

const IMG = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
const MAX_LINES = 5000;

export function createDiffView({ onClose }) {
  const el = h('div', { class: 'diff' });
  let token = 0;
  let full = false;
  let sel = new Map(); // hunk index → Set(line index)
  let anchor = null;

  async function show() {
    const repo = app.active, d = repo?.diff;
    if (!d) return;
    const my = ++token;
    const opts = { ignoreWhitespace: S('ignoreWhitespace'), context: S('context') };
    let file = null, err = null;
    try {
      file = d.kind === 'commit' ? await window.bl.git.commitDiff(repo.path, d.sha, d.file, opts) : await window.bl.git.workingDiff(repo.path, d.file, d.staged, opts);
    } catch (e) { err = e.message; }
    if (my !== token) return;
    if (d.key !== keyOf(d)) { sel = new Map(); full = false; d.key = keyOf(d); }
    d.parsed = file;
    paint(repo, d, file, err);
  }
  const keyOf = (d) => `${d.kind}:${d.sha || ''}:${d.staged ? 1 : 0}:${d.file.path}`;

  function paint(repo, d, file, err) {
    const f = d.file;
    const add = file ? file.hunks.reduce((a, hk) => a + hk.lines.filter((l) => l.t === '+').length, 0) : 0;
    const del = file ? file.hunks.reduce((a, hk) => a + hk.lines.filter((l) => l.t === '-').length, 0) : 0;
    const mode = S('diffMode');
    const work = d.kind === 'work';
    const idx = d.list ? d.list.findIndex((x) => x.path === f.path) : -1;
    const go = (k) => { const n = d.list[idx + k]; if (n) { app.active.diff = { ...d, file: n }; render(); } };

    const bar = h('div', { class: 'diff-bar' },
      h('button', { class: 'icon-btn', title: 'Back to graph (Esc)', onclick: onClose }, icon('chevronLeft')),
      statusBadge(f.status),
      h('div', { class: 'diff-path' }, h('span', { class: 'fdir' }, f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''), h('b', {}, f.path.split('/').pop()),
        f.from ? h('span', { class: 'fdir' }, `  ← ${f.from}`) : null),
      h('span', { class: 'fstat' }, h('span', { class: 'plus' }, '+' + add), h('span', { class: 'minus' }, '−' + del)),
      h('div', { class: 'grow' }),
      d.list?.length > 1 ? h('div', { class: 'seg' },
        h('button', { class: 'icon-btn', title: 'Previous file', disabled: idx <= 0, onclick: () => go(-1) }, icon('arrowUp')),
        h('span', { class: 'muted small' }, `${idx + 1}/${d.list.length}`),
        h('button', { class: 'icon-btn', title: 'Next file', disabled: idx >= d.list.length - 1, onclick: () => go(1) }, icon('arrowDown'))) : null,
      h('div', { class: 'seg' },
        h('button', { class: 'seg-btn' + (mode === 'unified' ? ' on' : ''), title: 'Unified', onclick: () => setPref({ diffMode: 'unified' }) }, icon('unified'), 'Unified'),
        h('button', { class: 'seg-btn' + (mode === 'split' ? ' on' : ''), title: 'Split', onclick: () => setPref({ diffMode: 'split' }) }, icon('split'), 'Split')),
      h('button', { class: 'seg-btn tgl' + (S('ignoreWhitespace') ? ' on' : ''), title: 'Ignore whitespace', onclick: () => setPref({ ignoreWhitespace: !S('ignoreWhitespace') }) }, icon('whitespace'), 'Whitespace'),
      work && !d.staged && f.status !== 'conflict' ? h('button', { class: 'btn small ghost danger', onclick: () => discardFile(repo, f) }, icon('undo'), 'Discard') : null,
      f.status === 'conflict' ? [
        h('button', { class: 'btn small', title: 'Keep our version (checkout --ours)', onclick: () => resolve(f, 'ours') }, 'Use Ours'),
        h('button', { class: 'btn small', title: 'Take their version (checkout --theirs)', onclick: () => resolve(f, 'theirs') }, 'Use Theirs'),
        h('button', { class: 'btn small primary', title: 'I edited the file — mark it resolved (git add)', onclick: () => resolve(f, null) }, icon('check'), 'Mark Resolved')] :
      work ? h('button', { class: 'btn small ' + (d.staged ? '' : 'primary'), onclick: () => stageFile(repo, d) }, icon(d.staged ? 'minus' : 'plus'), d.staged ? 'Unstage File' : 'Stage File') : null,
      h('button', { class: 'icon-btn', title: 'Open in editor', disabled: f.status === 'deleted', onclick: () => window.bl.shell.editor(repo.path, f.path) }, icon('code')),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: onClose }, icon('x')));

    const body = h('div', { class: 'diff-body mono ' + mode });
    if (err) body.append(h('div', { class: 'diff-msg' }, icon('alert'), err));
    else if (file?.conflict) body.append(conflictView(file));
    else if (IMG.test(f.path) && (file?.binary || /\.svg$/i.test(f.path))) body.append(imagePreview(repo, d));
    else if (!file || (!file.hunks.length && !file.binary)) body.append(h('div', { class: 'diff-msg' }, f.status === 'renamed' ? 'File renamed without changes' : 'No changes to show (mode or whitespace only)'));
    else if (file.binary) body.append(h('div', { class: 'diff-msg' }, icon('file'), 'Binary file changed'));
    else {
      let budget = full ? Infinity : MAX_LINES;
      file.hunks.forEach((hk, hi) => {
        if (budget <= 0) return;
        body.append(hunkHeader(repo, d, file, hk, hi));
        body.append(mode === 'split' ? splitHunk(hk, hi, work) : unifiedHunk(hk, hi, work));
        budget -= hk.lines.length;
      });
      if (budget <= 0) body.append(h('button', { class: 'btn show-all', onclick: () => { full = true; paint(repo, d, file, null); } }, 'Show the full diff'));
    }
    clear(el).append(bar, body);
  }

  function setPref(p) {
    app.settings = { ...app.settings, ...p };
    window.bl.app.setSettings(p);
    show();
  }

  // ------------------------------------------------------------ hunks
  function hunkHeader(repo, d, file, hk, hi) {
    const s = sel.get(hi);
    const n = s ? [...s].filter((i) => hk.lines[i].t !== ' ').length : 0;
    const label = n ? `${n} line${n === 1 ? '' : 's'}` : 'Hunk';
    const acts = [];
    if (d.kind === 'work' && d.file.status !== 'conflict') {
      if (!d.staged) acts.push(h('button', { class: 'btn tiny ghost danger', onclick: () => applyHunk(repo, d, file, hk, hi, 'discard') }, `Discard ${label}`));
      acts.push(h('button', { class: 'btn tiny ' + (d.staged ? '' : 'primary'), onclick: () => applyHunk(repo, d, file, hk, hi, d.staged ? 'unstage' : 'stage') }, `${d.staged ? 'Unstage' : 'Stage'} ${label}`));
      if (n) acts.push(h('button', { class: 'btn tiny ghost', onclick: () => { sel.delete(hi); show(); } }, 'Clear'));
    }
    return h('div', { class: 'hunk-head' }, h('span', { class: 'hunk-range' }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`),
      h('span', { class: 'hunk-ctx' }, hk.context), h('div', { class: 'grow' }), acts);
  }

  async function applyHunk(repo, d, file, hk, hi, kind) {
    if (d.file.status === 'untracked') {
      // a new file can only be staged whole (git apply cannot partially add an untracked path reliably)
      if (kind === 'stage') return stageFile(repo, d);
    }
    const s = sel.get(hi) || null;
    if (!selectionHasChanges(hk, s)) return toast('Select changed lines (+ or −) first');
    const patch = buildPatch(file, hk, s, kind !== 'stage');
    if (kind === 'discard') {
      if (!(await confirm('Discard these changes?', 'The selected lines are removed from your working copy. This cannot be undone.', 'Discard', true))) return;
    }
    const ok = await op('applyPatch', [patch, { cached: kind !== 'discard', reverse: kind !== 'stage' }], { reload: true });
    if (ok) { sel.delete(hi); await show(); }
  }

  async function stageFile(repo, d) {
    const f = d.file;
    await op(d.staged ? 'unstage' : 'stage', [[f.path, ...(f.from && d.staged ? [f.from] : [])]]);
    // follow the file to the other list, or close when it disappears
    const st = app.active.status;
    const other = (d.staged ? st.unstaged : st.staged).find((x) => x.path === f.path);
    app.active.diff = other ? { ...d, staged: !d.staged, file: other, list: d.staged ? st.unstaged : st.staged } : null;
    render();
  }

  async function discardFile(repo, f) {
    if (await confirm('Discard changes?', `${f.path}\n\n${f.status === 'untracked' ? 'The file will be deleted. ' : ''}This cannot be undone.`, 'Discard', true)) {
      app.active.diff = null;
      await op('discard', [[f]], { ok: 'Discarded' });
    }
  }

  // ------------------------------------------------------------ conflicts
  async function resolve(f, side) {
    app.active.diff = null;
    await op('resolve', [f.path, side], { ok: side ? `Resolved with ${side}` : 'Marked resolved' });
  }

  function conflictView(file) {
    if (file.deleted) return h('div', { class: 'diff-msg' }, icon('alert'), 'Deleted on one side — choose Ours or Theirs.');
    let zone = '';
    const rows = file.text.split('\n').map((line, i) => {
      let cls = zone;
      if (line.startsWith('<<<<<<<')) { zone = 'ours'; cls = 'marker ours'; }
      else if (line.startsWith('=======') && zone) { zone = 'theirs'; cls = 'marker mid'; }
      else if (line.startsWith('>>>>>>>') && zone) { zone = ''; cls = 'marker theirs'; }
      return h('div', { class: 'cl ' + cls }, h('span', { class: 'ln' }, i + 1), h('span', { class: 'dt' }, line || '\u200b'));
    });
    return h('div', {},
      h('div', { class: 'conflict-help' }, h('span', {}, h('span', { class: 'sw', style: { background: 'var(--accent)' } }), 'Ours (current branch)'),
        h('span', {}, h('span', { class: 'sw', style: { background: 'var(--purple)' } }), 'Theirs (incoming)'),
        h('span', { class: 'muted' }, 'Edit the file in your editor, or pick a side above.')),
      h('div', { class: 'conflict-view' }, rows));
  }

  // ------------------------------------------------------------ line rendering
  function pick(hi, li, e) {
    const s = sel.get(hi) || new Set();
    if (e.shiftKey && anchor && anchor.hi === hi) {
      const [a, b] = [Math.min(anchor.li, li), Math.max(anchor.li, li)];
      for (let i = a; i <= b; i++) s.add(i);
    } else s.has(li) ? s.delete(li) : s.add(li);
    anchor = { hi, li };
    s.size ? sel.set(hi, s) : sel.delete(hi);
    show();
  }

  function pairs(lines) {
    // pair each run of '-' lines with the following run of '+' lines (for word highlights / split view)
    const map = new Map();
    for (let i = 0; i < lines.length;) {
      if (lines[i].t !== '-') { i++; continue; }
      let j = i; while (j < lines.length && lines[j].t === '-') j++;
      let k = j; while (k < lines.length && lines[k].t === '+') k++;
      for (let x = 0; x < Math.min(j - i, k - j); x++) { map.set(i + x, j + x); map.set(j + x, i + x); }
      i = k;
    }
    return map;
  }

  function content(l, other) {
    if (!other || l.text.length > 2000 || other.text.length > 2000) return l.text || '\u200b';
    const d = inlineDiff(l.t === '-' ? l.text : other.text, l.t === '-' ? other.text : l.text);
    const [pre, mid, post] = l.t === '-' ? d.a : d.b;
    // only highlight words when the lines are mostly alike; otherwise the whole line is the change
    if (!mid || pre.length + post.length < 0.4 * Math.max(l.text.length, other.text.length)) return l.text || '\u200b';
    return [pre, h('span', { class: 'word' }, mid), post];
  }

  function unifiedHunk(hk, hi, work) {
    const pm = pairs(hk.lines);
    const s = sel.get(hi);
    return h('div', { class: 'hunk' }, hk.lines.map((l, li) => {
      if (l.t === '\\') return h('div', { class: 'dl meta' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'dt' }, l.text));
      const cls = 'dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx') + (s?.has(li) ? ' picked' : '');
      const row = h('div', { class: cls },
        h('span', { class: 'ln' }, l.o ?? ''), h('span', { class: 'ln' }, l.n ?? ''),
        h('span', { class: 'sign' }, l.t === ' ' ? '' : l.t === '-' ? '−' : '+'),
        h('span', { class: 'dt' }, content(l, pm.has(li) ? hk.lines[pm.get(li)] : null)));
      if (work && l.t !== ' ') { row.classList.add('pickable'); row.querySelectorAll('.ln,.sign').forEach((g) => g.addEventListener('mousedown', (e) => { e.preventDefault(); pick(hi, li, e); })); }
      return row;
    }));
  }

  function splitHunk(hk, hi, work) {
    const pm = pairs(hk.lines);
    const s = sel.get(hi);
    const rows = [];
    for (let i = 0; i < hk.lines.length;) {
      const l = hk.lines[i];
      if (l.t === ' ') { rows.push([[l, i], [l, i]]); i++; continue; }
      if (l.t === '\\') { i++; continue; }
      let j = i; const dels = [], adds = [];
      while (j < hk.lines.length && hk.lines[j].t === '-') dels.push([hk.lines[j], j++]);
      while (j < hk.lines.length && (hk.lines[j].t === '+' || hk.lines[j].t === '\\')) { if (hk.lines[j].t === '+') adds.push([hk.lines[j], j]); j++; }
      for (let x = 0; x < Math.max(dels.length, adds.length); x++) rows.push([dels[x] || null, adds[x] || null]);
      i = j;
    }
    const side = (cell, isLeft) => {
      if (!cell) return [h('span', { class: 'ln' }), h('span', { class: 'dt empty' })];
      const [l, li] = cell;
      const kind = l.t === ' ' ? 'ctx' : l.t === '-' ? 'del' : 'add';
      const ln = h('span', { class: `ln ${kind}${s?.has(li) && l.t !== ' ' ? ' picked' : ''}${work && l.t !== ' ' ? ' pickable' : ''}` }, isLeft ? l.o ?? '' : l.n ?? '');
      if (work && l.t !== ' ') ln.addEventListener('mousedown', (e) => { e.preventDefault(); pick(hi, li, e); });
      return [ln, h('span', { class: `dt ${kind}${s?.has(li) && l.t !== ' ' ? ' picked' : ''}` }, content(l, pm.has(li) ? hk.lines[pm.get(li)] : null))];
    };
    return h('div', { class: 'hunk split' }, rows.map(([a, b]) => h('div', { class: 'sl' }, side(a, true), side(b, false))));
  }

  // ------------------------------------------------------------ images
  function imagePreview(repo, d) {
    const mime = /\.svg$/i.test(d.file.path) ? 'image/svg+xml' : 'image/' + d.file.path.split('.').pop().toLowerCase().replace('jpg', 'jpeg');
    const box = (label, rev, path) => {
      const img = h('img', { alt: label });
      const wrap = h('div', { class: 'img-side' }, h('div', { class: 'img-label' }, label), h('div', { class: 'img-frame' }, img), h('div', { class: 'muted small img-meta' }));
      if (!rev) { wrap.classList.add('none'); img.remove(); wrap.querySelector('.img-frame').append(h('span', { class: 'muted' }, '—')); return wrap; }
      window.bl.git.blob(repo.path, rev, path).then((b64) => {
        if (!b64) { img.replaceWith(h('span', { class: 'muted' }, 'not available')); return; }
        img.src = `data:${mime};base64,${b64}`;
        img.onload = () => { wrap.querySelector('.img-meta').textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${Math.round(b64.length * 0.75 / 1024)} KB`; };
      }).catch(() => {});
      return wrap;
    };
    const f = d.file;
    const oldRev = d.kind === 'commit' ? d.parent : 'HEAD';
    const newRev = d.kind === 'commit' ? d.sha : ':working';
    return h('div', { class: 'img-diff' },
      box('Before', f.status === 'added' || f.status === 'untracked' ? null : oldRev, f.from || f.path),
      box('After', f.status === 'deleted' ? null : newRev, f.path));
  }

  return { el, show };
}
