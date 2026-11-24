// Thin wrapper around the git CLI (the same approach Fork uses: no libgit2, no native modules).
// Parsers are pure functions so they can be unit-tested without a repository.
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const US = '\x1f'; // field separator inside a record
const RS = '\x1e'; // record separator
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// GUI apps on macOS start with a minimal PATH; add the usual places so git, gpg and hook tools resolve.
let PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
function setPath(p) { if (p) PATH = p + ':' + PATH; }

function env(extra) {
  // no TTY here: never wait for an editor or a password prompt
  return { ...process.env, PATH, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C.UTF-8', ...extra };
}

/** Run git; resolves {code, out, err}. Never throws for a non-zero exit. */
function run(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: env(opts.env), maxBuffer: 512 * 1024 * 1024, encoding: opts.binary ? 'buffer' : 'utf8', timeout: opts.timeout || 0 },
      (error, out, err) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err: String(err || (error && !error.code ? error.message : '')) }));
    if (opts.input != null) { child.stdin.end(opts.input); }
  });
}

/** Like run() but throws a readable Error on failure. */
async function git(cwd, args, opts = {}) {
  const r = await run(cwd, args, opts);
  if (r.code !== 0 && !(opts.ok || []).includes(r.code)) {
    const msg = (String(r.err).trim() || String(r.out).trim() || `git ${args[0]} failed (${r.code})`).replace(/^(error|fatal): /gm, '');
    const e = new Error(msg); e.code = r.code; throw e;
  }
  return r.out;
}

/** Streaming run for long network operations; onLine receives progress lines. */
function stream(cwd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'color.ui=false', ...args], { cwd, env: env() });
    let err = '';
    const feed = (b) => { const s = b.toString(); err += s; for (const l of s.split(/[\r\n]+/)) if (l.trim()) onLine?.(l.trim()); };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(err);
      else reject(new Error(err.split('\n').filter((l) => /error|fatal|rejected|hint|denied|conflict/i.test(l)).join('\n').replace(/^(error|fatal): /gm, '') || err.trim() || `git ${args[0]} failed`));
    });
  });
}

// ---------------------------------------------------------------- parsers

const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%s', '%D'].join('%x1f') + '%x1e';

function parseLog(out) {
  const commits = [];
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [sha, parents, author, email, at, committer, ct, subject, refs] = r.split(US);
    if (!sha || sha.length < 40) continue;
    commits.push({
      sha, parents: parents ? parents.split(' ') : [], author, email: (email || '').toLowerCase(),
      date: Number(at) * 1000, committer, cdate: Number(ct) * 1000, subject: subject || '', refs: parseDecorations(refs || ''),
    });
  }
  return commits;
}

/** "HEAD -> main, origin/main, tag: v1.0" → [{type,name}] */
function parseDecorations(s) {
  const out = [];
  for (let part of s.split(', ')) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) { out.push({ type: 'head' }); part = part.slice(8); }
    if (part === 'HEAD') { out.push({ type: 'head', detached: true }); continue; }
    if (part.startsWith('tag: ')) out.push({ type: 'tag', name: part.slice(5) });
    else if (part.endsWith('/HEAD')) continue;
    else out.push({ type: 'branch', name: part });
  }
  return out;
}

const REF_FORMAT = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(*objectname)', '%(committerdate:unix)', '%(contents:subject)'].join('%1f');

function parseRefs(out) {
  const local = [], remote = [], tags = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, sha, upstream, track, head, peeled, date, subject] = line.split(US);
    if (ref.startsWith('refs/heads/')) {
      const ahead = /ahead (\d+)/.exec(track || ''), behind = /behind (\d+)/.exec(track || '');
      local.push({ name: ref.slice(11), sha, upstream: upstream || '', gone: /gone/.test(track || ''),
        ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0, current: head === '*', date: Number(date) * 1000, subject });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (name.endsWith('/HEAD')) continue;
      const slash = name.indexOf('/');
      remote.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), sha, date: Number(date) * 1000 });
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ name: ref.slice(10), sha: peeled || sha, date: Number(date) * 1000, subject });
    }
  }
  return { local, remote, tags };
}

const XY = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflict' };

/** git status --porcelain=v2 -z --branch */
function parseStatus(out) {
  const st = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# branch.head ')) st.branch = p.slice(14) === '(detached)' ? null : p.slice(14);
    else if (p.startsWith('# branch.oid ')) st.oid = p.slice(13) === '(initial)' ? null : p.slice(13);
    else if (p.startsWith('# branch.upstream ')) st.upstream = p.slice(18);
    else if (p.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(p); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    else if (p[0] === '1' || p[0] === '2') {
      const f = p.split(' ');
      const xy = f[1];
      const file = f.slice(p[0] === '1' ? 8 : 9).join(' ');
      const from = p[0] === '2' ? parts[++i] : undefined;
      if (xy[0] !== '.') st.staged.push({ path: file, from, status: XY[xy[0]] || 'modified' });
      if (xy[1] !== '.') st.unstaged.push({ path: file, status: XY[xy[1]] || 'modified' });
    } else if (p[0] === 'u') {
      const f = p.split(' ');
      st.conflicts.push({ path: f.slice(10).join(' '), status: 'conflict', xy: f[1] });
    } else if (p[0] === '?') st.unstaged.push({ path: p.slice(2), status: 'untracked' });
  }
  return st;
}

/** --name-status -z output (with -M) → [{status, path, from}] */
function parseNameStatus(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const k = code[0];
    if (k === 'R' || k === 'C') { const from = parts[++i], to = parts[++i]; files.push({ status: XY[k], path: to, from, score: +code.slice(1) }); }
    else files.push({ status: XY[k] || 'modified', path: parts[++i] });
  }
  return files;
}

/** --numstat -z → Map path → {add, del, binary} */
function parseNumstat(out) {
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    let file = p;
    if (p === '') { i++; file = parts[++i]; } // rename: "a\td\t" then from, to
    map.set(file, { add: a === '-' ? 0 : +a, del: d === '-' ? 0 : +d, binary: a === '-' });
  }
  return map;
}

/** Unified diff text → [{header:[], oldPath, newPath, binary, hunks:[{header, oldStart, oldLines, newStart, newLines, lines:[{t,text,o,n}]}]}] */
function parseDiff(text) {
  const files = [];
  let f = null, h = null, o = 0, n = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { header: [line], oldPath: null, newPath: null, binary: false, hunks: [] }; files.push(f); h = null; continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('@@')) { /* falls through to hunk start */ }
      else {
        f.header.push(line);
        if (line.startsWith('--- ')) f.oldPath = line === '--- /dev/null' ? null : line.slice(6);
        else if (line.startsWith('+++ ')) f.newPath = line === '+++ /dev/null' ? null : line.slice(6);
        else if (line.startsWith('Binary files')) f.binary = true;
        continue;
      }
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m) {
      h = { header: line, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], context: m[5].trim(), lines: [] };
      f.hunks.push(h); o = h.oldStart; n = h.newStart; continue;
    }
    if (!h) continue;
    const c = line[0];
    if (c === '+') h.lines.push({ t: '+', text: line.slice(1), n: n++ });
    else if (c === '-') h.lines.push({ t: '-', text: line.slice(1), o: o++ });
    else if (c === ' ') h.lines.push({ t: ' ', text: line.slice(1), o: o++, n: n++ });
    else if (c === '\\') h.lines.push({ t: '\\', text: line });
    else if (line === '' ) { /* trailing newline of output */ }
  }
  return files;
}

function parseStashes(out) {
  return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [ref, sha, subject, at, parents] = r.split(US);
    return { ref, sha, subject, date: Number(at) * 1000, parents: (parents || '').split(' ').filter(Boolean) };
  });
}

// ---------------------------------------------------------------- repository queries

async function toplevel(dir) {
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.out.trim() : null;
}

function gitDir(repo) {
  const g = path.join(repo, '.git');
  try {
    if (fs.statSync(g).isFile()) { const m = /gitdir: (.*)/.exec(fs.readFileSync(g, 'utf8')); if (m) return path.resolve(repo, m[1].trim()); }
  } catch { /* ignore */ }
  return g;
}

function operation(repo) {
  const g = gitDir(repo);
  const has = (p) => fs.existsSync(path.join(g, p));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

async function log(repo, { limit = 2000, all = true, branch = null } = {}) {
  const args = ['log', '--date-order', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, '--decorate=short'];
  if (branch) args.push(safeRef(branch)); else if (all) args.push('--branches', '--remotes', '--tags', 'HEAD');
  const r = await run(repo, args);
  if (r.code !== 0) return []; // empty repository
  return parseLog(r.out);
}

async function refs(repo) {
  return parseRefs(await git(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']));
}

async function status(repo) {
  const st = parseStatus(await git(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']));
  st.operation = operation(repo);
  return st;
}

async function stashes(repo) {
  const r = await run(repo, ['stash', 'list', '-z', `--format=%gd${'%x1f'}%H${'%x1f'}%s${'%x1f'}%at${'%x1f'}%P%x1e`]);
  return r.code === 0 ? parseStashes(r.out.replace(/\0/g, '')) : [];
}

async function remotes(repo) {
  const out = await git(repo, ['remote', '-v']);
  const map = new Map();
  for (const l of out.split('\n')) { const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l); if (m && !map.has(m[1])) map.set(m[1], m[2]); }
  return [...map].map(([name, url]) => ({ name, url }));
}

async function commit(repo, sha) {
  safeRef(sha);
  const out = await git(repo, ['show', '--no-patch', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', sha]);
  const [h, parents, author, email, at, committer, cemail, ct, ...body] = out.split(US);
  const msg = body.join(US).replace(/\n+$/, '');
  const nl = msg.indexOf('\n');
  const c = { sha: h, parents: parents ? parents.split(' ') : [], author, email: email.toLowerCase(), date: at * 1000, committer, cemail, cdate: ct * 1000,
    subject: nl < 0 ? msg : msg.slice(0, nl), body: nl < 0 ? '' : msg.slice(nl + 1).trim() };
  const base = c.parents[0] || EMPTY_TREE;
  const [ns, num] = await Promise.all([
    git(repo, ['diff', '--name-status', '-M', '-z', base, sha]),
    git(repo, ['diff', '--numstat', '-M', '-z', base, sha]),
  ]);
  const stats = parseNumstat(num);
  c.files = parseNameStatus(ns).map((f) => ({ ...f, ...(stats.get(f.path) || { add: 0, del: 0 }) }));
  return c;
}

async function commitDiff(repo, sha, file, opts = {}) {
  safeRef(sha);
  const c = await git(repo, ['rev-list', '--parents', '-n1', sha]);
  const parent = c.trim().split(' ')[1] || EMPTY_TREE;
  const paths = file.from ? [file.from, file.path] : [file.path];
  return parseDiff(await git(repo, ['diff', '-M', ...diffOpts(opts), parent, sha, '--', ...paths]))[0] || null;
}

function diffOpts(o) {
  const a = [`-U${Math.max(0, Math.min(50, Number(o.context ?? 3)))}`];
  if (o.ignoreWhitespace) a.push('-w');
  return a;
}

async function workingDiff(repo, file, staged, opts = {}) {
  if (file.status === 'conflict') {
    // show the working file with its conflict markers; combined diffs are hard to read
    const p = path.join(repo, file.path);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) return { conflict: true, text: '', deleted: true, hunks: [] };
    if (st.size > 4 * 1024 * 1024) return { conflict: true, text: '(file too large to show)', hunks: [] };
    return { conflict: true, text: fs.readFileSync(p, 'utf8'), hunks: [] };
  }
  if (file.status === 'untracked') {
    const r = await run(repo, ['diff', '--no-index', ...diffOpts(opts), '--', '/dev/null', file.path]);
    return parseDiff(r.out)[0] || null;
  }
  const args = ['diff', ...diffOpts(opts), ...(staged ? ['--cached', '-M'] : []), '--', ...(file.from ? [file.from, file.path] : [file.path])];
  return parseDiff(await git(repo, args))[0] || null;
}

/** Old/new blobs for an image preview (base64), or null when absent. */
async function blob(repo, rev, file) {
  if (rev === ':working') {
    try { return fs.readFileSync(path.join(repo, file)).toString('base64'); } catch { return null; }
  }
  const r = await run(repo, ['show', `${rev}:${file}`], { binary: true });
  return r.code === 0 ? r.out.toString('base64') : null;
}

/** Refuse anything that git could read as an option. */
function safeRef(s) {
  if (typeof s !== 'string' || !s || s.startsWith('-') || /[\0\n]/.test(s)) throw new Error('Invalid ref: ' + s);
  return s;
}

module.exports = {
  run, git, stream, setPath, toplevel, gitDir, operation, log, refs, status, stashes, remotes, commit, commitDiff, workingDiff, blob, safeRef,
  parseLog, parseDecorations, parseRefs, parseStatus, parseNameStatus, parseNumstat, parseDiff, parseStashes, EMPTY_TREE,
};
