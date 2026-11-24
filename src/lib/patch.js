// Build a patch for staging / unstaging / discarding a hunk or a set of lines.
// `file` and `hunk` come from parseDiff (electron/git.cjs). `selected` is a Set of line indexes
// inside the hunk (null = whole hunk). `reverse` is true when the patch will be applied with -R
// (unstage from the index, or discard from the working tree).

export function buildPatch(file, hunk, selected = null, reverse = false) {
  const out = [];
  let oldCount = 0, newCount = 0, lastKept = false;
  hunk.lines.forEach((l, i) => {
    if (l.t === '\\') { if (lastKept) out.push(l.text); return; }
    const pick = !selected || selected.has(i);
    lastKept = true;
    if (l.t === ' ') { out.push(' ' + l.text); oldCount++; newCount++; return; }
    if (pick) { out.push(l.t + l.text); if (l.t === '-') oldCount++; else newCount++; return; }
    // An unselected change must stay as it is on the side the patch is applied to.
    // Forward (stage): the old side is the index → keep '-' lines as context, drop '+' lines.
    // Reverse (-R):    the new side is the target → keep '+' lines as context, drop '-' lines.
    if ((l.t === '-' && !reverse) || (l.t === '+' && reverse)) { out.push(' ' + l.text); oldCount++; newCount++; }
    else lastKept = false;
  });
  const hh = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
  return [...file.header, hh, ...out].join('\n') + '\n';
}

/** True when a hunk-level selection changes nothing (only context selected). */
export function selectionHasChanges(hunk, selected) {
  return hunk.lines.some((l, i) => (l.t === '+' || l.t === '-') && (!selected || selected.has(i)));
}

/** Split a pair of changed lines into [common-prefix, changed, common-suffix] for word highlighting. */
export function inlineDiff(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // snap to word boundaries so highlights read naturally
  while (p > 0 && /\w/.test(a[p - 1]) && /\w/.test(a[p] || '')) p--;
  while (s > 0 && /\w/.test(a[a.length - s]) && /\w/.test(a[a.length - s - 1] || '')) s--;
  return {
    a: [a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s)],
    b: [b.slice(0, p), b.slice(p, b.length - s), b.slice(b.length - s)],
  };
}
