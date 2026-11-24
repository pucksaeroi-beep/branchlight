'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Every call resolves to the value or throws an Error with git's message.
const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('bl', {
  app: {
    state: () => call('app:state'),
    saveTabs: (tabs, active) => call('app:tabs', tabs, active),
    setSettings: (s) => call('settings:set', s),
  },
  repo: {
    pick: () => call('repo:pick'), add: (d) => call('repo:add', d), close: (r) => call('repo:close', r), forget: (r) => call('repo:forget', r),
    init: () => call('repo:init'), pickDir: () => call('repo:pickDir'), clone: (url, parent, name) => call('repo:clone', url, parent, name),
  },
  git: {
    snapshot: (r, o) => call('git:snapshot', r, o), status: (r) => call('git:status', r), commit: (r, sha) => call('git:commit', r, sha),
    commitDiff: (r, sha, f, o) => call('git:commitDiff', r, sha, f, o), workingDiff: (r, f, staged, o) => call('git:workingDiff', r, f, staged, o),
    blob: (r, rev, f) => call('git:blob', r, rev, f), lastMessage: (r) => call('git:lastMessage', r), search: (r, q) => call('git:search', r, q),
    fileLog: (r, f) => call('git:fileLog', r, f),
    op: (r, name, ...a) => call('git:op', r, name, ...a),
  },
  shell: {
    finder: (r, f) => call('shell:finder', r, f), terminal: (r) => call('shell:terminal', r), editor: (r, f) => call('shell:editor', r, f),
    external: (u) => call('shell:external', u), copy: (t) => call('clip:copy', t),
  },
  on: (ch, fn) => {
    const ok = ['menu', 'repo:changed', 'app:focus', 'progress'];
    if (!ok.includes(ch)) return () => {};
    const l = (_e, ...a) => fn(...a);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});
