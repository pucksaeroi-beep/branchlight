// Commit graph lane layout. Input: commits newest-first (children before parents, as `git log --date-order`).
// Output per row: the node's lane + colour and the line segments to draw in the top half (entering the
// node) and bottom half (leaving it). Lanes are reused once free, so the graph stays narrow.

export const LANE_COLORS = 12;

/**
 * @param {{sha:string, parents:string[]}[]} commits
 * @returns {{rows: {col:number, color:number, top:Seg[], bottom:Seg[]}[], width:number}}
 *   Seg = {from:number, to:number, color:number, dashed?:boolean}
 */
export function layout(commits) {
  const lanes = [];       // lane index → sha it is waiting for (or null)
  const colors = [];      // lane index → colour id
  const dashed = [];      // lane index → drawn dashed (WIP link)
  let nextColor = 0;
  let width = 0;
  const rows = new Array(commits.length);

  const freeLane = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };

  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];
    const top = [];
    let col = -1;

    // lanes waiting for this commit converge into it; others pass straight through
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] == null) continue;
      if (lanes[k] === c.sha) { if (col < 0) col = k; }
    }
    const isNew = col < 0;
    if (isNew) { col = freeLane(); colors[col] = nextColor++ % LANE_COLORS; dashed[col] = false; }
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] == null) continue;
      if (lanes[k] === c.sha) { top.push({ from: k, to: col, color: colors[k], dashed: dashed[k] }); if (k !== col) lanes[k] = null; }
      else top.push({ from: k, to: k, color: colors[k], dashed: dashed[k] });
    }
    const color = colors[col];

    // parents
    const bottom = [];
    lanes[col] = null;
    const parents = c.parents || [];
    const assigned = new Set();
    parents.forEach((p, i) => {
      let k = lanes.indexOf(p);
      // first parent already awaited further right: keep this lane straight, the other one bends in later
      if (k > col && i === 0) k = -1;
      if (k >= 0) { bottom.push({ from: col, to: k, color: i === 0 ? color : colors[k], dashed: !!c.wip }); return; }
      if (i === 0) { k = col; }
      else { k = freeLane(); colors[k] = nextColor++ % LANE_COLORS; }
      lanes[k] = p; dashed[k] = !!c.wip && i === 0; assigned.add(k);
      bottom.push({ from: col, to: k, color: i === 0 ? color : colors[k], dashed: !!c.wip });
    });
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] == null || assigned.has(k)) continue;
      bottom.push({ from: k, to: k, color: colors[k], dashed: dashed[k] });
    }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();

    for (const s of top) width = Math.max(width, s.from + 1, s.to + 1);
    for (const s of bottom) width = Math.max(width, s.from + 1, s.to + 1);
    width = Math.max(width, col + 1);
    rows[r] = { col, color, top, bottom, isNew };
  }
  return { rows, width };
}
