// Virtualised commit list with a canvas-drawn lane graph (only visible rows are in the DOM).
import { h, icon, clear, fmtRelative, fmtDate, popover } from '../ui/h.js';
import { initials } from '../ui/avatar.js';
import { app, S } from '../app.js';

export const ROW = 32;
const LANE = 18;
const PAD = 14;
export const COLORS = ['#22c3f0', '#f2558c', '#a571ff', '#ffb340', '#35d58a', '#ff7a45', '#4f8dff', '#e45cf0', '#c4dd48', '#16d0bd', '#ff5d5d', '#929dff'];

export function createGraph({ onSelect, onOpen, onContext, onRefContext, onRefOpen, onLoadMore }) {
  const canvas = h('canvas', { class: 'graph-canvas' });
  const rowsEl = h('div', { class: 'graph-rows' });
  const win = h('div', { class: 'graph-win' }, canvas, rowsEl);
  const spacer = h('div', { class: 'graph-spacer' });
  const scroller = h('div', { class: 'graph-scroll', tabindex: '0' }, spacer, win);
  const head = h('div', { class: 'graph-head' },
    h('div', {}, 'BRANCH / TAG'), h('div', {}, 'GRAPH'), h('div', {}, 'COMMIT MESSAGE'), h('div', {}, 'AUTHOR'), h('div', {}, 'DATE'), h('div', { class: 'r' }, 'SHA'));
  const el = h('div', { class: 'graph' }, head, scroller);
  let repo = null;
  let gw = 80;
  let matches = null;

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  scroller.addEventListener('scroll', () => {
    if (repo) repo.scrollTop = scroller.scrollTop;
    schedule();
    if (repo && scroller.scrollTop + scroller.clientHeight > spacer.offsetHeight - ROW * 20 && repo.snap?.commits.length >= repo.limit) onLoadMore?.();
  }, { passive: true });
  new ResizeObserver(schedule).observe(scroller);

  scroller.addEventListener('keydown', (e) => {
    if (!repo || !repo.list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const i = repo.index.get(repo.sel) ?? -1;
      const page = Math.floor(scroller.clientHeight / ROW) - 1;
      const n = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + page, PageUp: i - page, Home: 0, End: repo.list.length - 1 }[e.key];
      const j = Math.max(0, Math.min(repo.list.length - 1, n));
      onSelect(repo.list[j].sha); reveal(j);
    } else if (e.key === 'Enter') onOpen?.(repo.list[repo.index.get(repo.sel)]);
  });

  function setRepo(r, keepScroll = true) {
    const changed = repo !== r;
    repo = r;
    if (!repo) return;
    gw = Math.min(PAD * 2 + Math.max(1, repo.width) * LANE, 320);
    el.style.setProperty('--gw', gw + 'px');
    spacer.style.height = repo.list.length * ROW + 'px';
    computeMatches();
    if (changed || !keepScroll) scroller.scrollTop = repo.scrollTop || 0;
    draw();
  }

  function computeMatches() {
    const q = repo?.find?.trim().toLowerCase();
    if (!q) { matches = null; return; }
    matches = new Set();
    repo.list.forEach((c, i) => {
      if (c.wip) return;
      if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.email.includes(q) || c.sha.startsWith(q)) matches.add(i);
    });
  }

  function reveal(i) {
    const top = i * ROW, bottom = top + ROW;
    if (top < scroller.scrollTop) scroller.scrollTop = top - ROW;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + ROW;
  }

  function center(i) { scroller.scrollTop = Math.max(0, i * ROW - scroller.clientHeight / 2 + ROW); }

  function draw() {
    if (!repo) return;
    const n = repo.list.length;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 4);
    const last = Math.min(n, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW) + 4);
    win.style.transform = `translateY(${first * ROW}px)`;
    drawCanvas(first, last);
    clear(rowsEl);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(rowEl(i));
    rowsEl.append(frag);
  }

  function drawCanvas(first, last) {
    const dpr = window.devicePixelRatio || 1;
    const H = (last - first) * ROW;
    canvas.width = gw * dpr; canvas.height = Math.max(1, H) * dpr;
    canvas.style.width = gw + 'px'; canvas.style.height = H + 'px';
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.lineWidth = 2;
    g.lineCap = 'round';
    const x = (l) => PAD + l * LANE;
    const bg = getComputedStyle(el).getPropertyValue('--bg-graph').trim() || '#171a22';
    for (let i = first; i < last; i++) {
      const r = repo.rows[i];
      const y0 = (i - first) * ROW, ym = y0 + ROW / 2, y1 = y0 + ROW;
      const dim = matches && !matches.has(i);
      g.globalAlpha = dim ? 0.25 : 1;
      for (const s of r.top) seg(g, x(s.from), y0, x(s.to), ym, s, true);
      for (const s of r.bottom) seg(g, x(s.from), ym, x(s.to), y1, s, false);
    }
    // nodes on top of lines
    for (let i = first; i < last; i++) {
      const r = repo.rows[i], c = repo.list[i];
      const y = (i - first) * ROW + ROW / 2, cx = x(r.col), col = COLORS[r.color];
      g.globalAlpha = matches && !matches.has(i) ? 0.3 : 1;
      if (repo.refsBySha.has(c.sha)) { // connector from the ref pills to the node
        g.strokeStyle = col; g.globalAlpha *= 0.55; g.lineWidth = 1.5; g.setLineDash([]);
        g.beginPath(); g.moveTo(0, y); g.lineTo(cx - 9, y); g.stroke();
        g.globalAlpha = matches && !matches.has(i) ? 0.3 : 1; g.lineWidth = 2;
      }
      if (c.wip) {
        g.setLineDash([3, 3]); g.strokeStyle = col; g.fillStyle = bg;
        g.beginPath(); g.arc(cx, y, 8.5, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([]);
        g.fillStyle = col; g.font = '700 9px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('···', cx, y - 1);
      } else if (c.parents.length > 1) {
        g.fillStyle = col; g.beginPath(); g.arc(cx, y, 5.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = bg; g.beginPath(); g.arc(cx, y, 2.4, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = col; g.beginPath(); g.arc(cx, y, 9.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(10,12,18,.88)'; g.font = '700 8.5px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(initials(c.author), cx, y + 0.5);
      }
      if (c.sha === repo.sel) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([]);
        g.beginPath(); g.arc(cx, y, c.parents.length > 1 && !c.wip ? 8 : 12, 0, Math.PI * 2); g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  function seg(g, x1, y1, x2, y2, s, isTop) {
    g.strokeStyle = COLORS[s.color];
    g.setLineDash(s.dashed ? [3, 3] : []);
    g.beginPath();
    g.moveTo(x1, y1);
    if (x1 === x2) g.lineTo(x2, y2);
    else if (isTop) g.bezierCurveTo(x1, y2, x2, y1 + (y2 - y1) * 0.2, x2, y2);   // lane bends into the node
    else g.bezierCurveTo(x1, y1 + (y2 - y1) * 0.8, x2, y1, x2, y2);              // leaves the node towards a parent lane
    g.stroke();
  }

  function rowEl(i) {
    const c = repo.list[i], r = repo.rows[i];
    const refs = repo.refsBySha.get(c.sha) || [];
    const color = COLORS[r.color];
    const cls = 'crow' + (c.sha === repo.sel ? ' sel' : '') + (matches && !matches.has(i) ? ' dim' : '') + (matches?.has(i) ? ' hit' : '') + (c.wip ? ' wip' : '');
    const row = h('div', { class: cls, style: { '--c': color }, dataset: { i } },
      h('div', { class: 'g-refs' }, refs.length ? refPills(refs, c, color) : null),
      h('div', { class: 'g-graph' }),
      c.wip ? wipMessage() : h('div', { class: 'g-msg' }, highlight(c.subject)),
      h('div', { class: 'g-author' }, c.wip ? '' : c.author),
      h('div', { class: 'g-date', title: c.wip ? '' : fmtDate(c.date) }, c.wip ? '' : S('dateFormat') === 'absolute' ? fmtDate(c.date) : fmtRelative(c.date)),
      h('div', { class: 'g-sha' }, c.wip ? '' : c.sha.slice(0, 7)));
    row.addEventListener('mousedown', (e) => { if (e.button === 0) { onSelect(c.sha); scroller.focus({ preventScroll: true }); } });
    row.addEventListener('dblclick', () => onOpen?.(c));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); onSelect(c.sha); onContext?.(c, e); });
    return row;
  }

  function wipMessage() {
    const st = repo.status;
    const counts = [];
    const mod = st.unstaged.filter((f) => f.status !== 'untracked').length + st.staged.length;
    const add = st.unstaged.filter((f) => f.status === 'untracked').length;
    if (st.conflicts.length) counts.push(h('span', { class: 'wip-count conflict' }, icon('alert'), st.conflicts.length));
    if (mod) counts.push(h('span', { class: 'wip-count mod' }, icon('edit'), mod));
    if (add) counts.push(h('span', { class: 'wip-count add' }, icon('plus'), add));
    const label = repo.message.summary || (repo.operation ? `${repo.operation} in progress` : '// WIP');
    return h('div', { class: 'g-msg' }, h('span', { class: 'wip-label' }, label), counts);
  }

  function highlight(text) {
    const q = repo.find?.trim();
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return [text.slice(0, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
  }

  function refPills(refs, c, color) {
    const first = refs[0];
    const more = refs.length - 1;
    const wrap = h('div', { class: 'pills' });
    const pill = (r) => {
      const p = h('span', { class: `pill ${r.kind}${r.current ? ' current' : ''}`, style: { '--c': color }, title: refs.map((x) => x.name + (x.remote ? ` ⇄ ${x.remote}` : '')).join('\n') },
        r.current ? icon('check') : null,
        r.kind === 'tag' ? icon('tag') : null,
        h('span', { class: 'pill-name' }, r.name),
        r.kind === 'local' ? icon('laptop', 'pill-ic') : null,
        r.kind === 'remote' || r.remote ? icon('cloud', 'pill-ic') : null);
      p.addEventListener('dblclick', (e) => { e.stopPropagation(); onRefOpen?.(r); });
      p.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSelect(c.sha); onRefContext?.(r, e); });
      return p;
    };
    wrap.append(pill(first));
    if (more) {
      const m = h('span', { class: 'pill more', style: { '--c': color }, title: refs.slice(1).map((x) => x.name).join('\n') }, '+' + more);
      m.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const all = h('div', { class: 'pills-pop' }, refs.map(pill));
        popover(all, m);
      });
      wrap.append(m);
    }
    return wrap;
  }

  return {
    el, setRepo, draw: schedule, reveal, center, focus: () => scroller.focus({ preventScroll: true }),
    refreshMatches: () => { computeMatches(); draw(); },
    nextMatch(dir = 1) {
      if (!matches?.size) return;
      const cur = repo.index.get(repo.sel) ?? -1;
      const arr = [...matches].sort((a, b) => a - b);
      const j = dir > 0 ? (arr.find((i) => i > cur) ?? arr[0]) : ([...arr].reverse().find((i) => i < cur) ?? arr[arr.length - 1]);
      onSelect(repo.list[j].sha); center(j);
    },
    get matchCount() { return matches?.size ?? 0; },
  };
}
