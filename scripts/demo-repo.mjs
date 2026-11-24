// Creates a demo repository full of mock history (fake people, fake project) for screenshots and testing.
//   node scripts/demo-repo.mjs [dir]      → <dir>/aurora-weather (+ a local bare "origin")
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = resolve(process.argv[2] || 'demo');
const work = join(base, 'aurora-weather');
const origin = join(base, 'origin.git');
const mate = join(base, 'teammate');
rmSync(base, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const PEOPLE = [
  ['Mia Hartley', 'mia@aurora.example'], ['Kenji Sato', 'kenji@aurora.example'], ['Priya Nair', 'priya@aurora.example'],
  ['Lucas Moreau', 'lucas@aurora.example'], ['Ava Chen', 'ava@aurora.example'],
];
let t = Date.now() - 46 * 86400e3;
let who = 0;
const env = (p = PEOPLE[who]) => {
  t += (2 + Math.random() * 20) * 3600e3;
  const d = new Date(Math.min(t, Date.now() - 600e3)).toISOString();
  return { ...process.env, GIT_AUTHOR_NAME: p[0], GIT_AUTHOR_EMAIL: p[1], GIT_COMMITTER_NAME: p[0], GIT_COMMITTER_EMAIL: p[1], GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (cwd, f, s) => { mkdirSync(join(cwd, f, '..'), { recursive: true }); writeFileSync(join(cwd, f), s); };
const append = (cwd, f, s) => write(cwd, f, (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), 'utf8') : '') + s);
const commit = (cwd, msg, person) => { if (person != null) who = person; git(cwd, 'add', '-A'); execFileSync('git', ['commit', '-q', '-m', msg], { cwd, env: env() }); };

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
git(work, 'init', '-q', '-b', 'main');
git(work, 'config', 'user.name', PEOPLE[0][0]);
git(work, 'config', 'user.email', PEOPLE[0][1]);
git(work, 'remote', 'add', 'origin', origin);

// --- history on main
write(work, 'README.md', '# Aurora Weather\n\nA tiny forecast app (demo data).\n');
write(work, 'package.json', JSON.stringify({ name: 'aurora-weather', version: '0.1.0', scripts: { start: 'node src/server.js' } }, null, 2) + '\n');
commit(work, 'Initial commit', 0);
write(work, 'src/server.js', "import http from 'node:http';\nimport { forecast } from './forecast.js';\n\nhttp.createServer((req, res) => {\n  res.end(JSON.stringify(forecast('Bangkok')));\n}).listen(3000);\n");
write(work, 'src/forecast.js', "export function forecast(city) {\n  return { city, temp: 31, sky: 'sunny' };\n}\n");
commit(work, 'Add forecast server', 1);
write(work, 'src/units.js', "export const toF = (c) => c * 9 / 5 + 32;\nexport const toC = (f) => (f - 32) * 5 / 9;\n");
commit(work, 'Add unit conversion helpers', 2);
append(work, 'README.md', '\n## Run\n\n```sh\nnpm start\n```\n');
commit(work, 'Document how to run the server', 0);
git(work, 'tag', '-a', 'v0.1.0', '-m', 'First preview');

// feature/radar
git(work, 'switch', '-q', '-c', 'feature/radar');
write(work, 'src/radar.js', "export function radar(lat, lon) {\n  return { lat, lon, layers: ['rain', 'clouds'] };\n}\n");
commit(work, 'Radar: tile endpoint skeleton', 3);
append(work, 'src/radar.js', "\nexport const ZOOM = { min: 3, max: 12 };\n");
commit(work, 'Radar: clamp zoom levels', 3);

// fix/timezone off main
git(work, 'switch', '-q', 'main');
git(work, 'switch', '-q', '-c', 'fix/timezone');
write(work, 'src/time.js', "export const local = (d, tz = 'Asia/Bangkok') => new Date(d).toLocaleString('en-GB', { timeZone: tz });\n");
commit(work, 'Fix sunrise time shown in UTC', 4);

git(work, 'switch', '-q', 'main');
write(work, 'src/forecast.js', "import { toF } from './units.js';\n\nexport function forecast(city, unit = 'C') {\n  const temp = 31;\n  return { city, temp: unit === 'F' ? toF(temp) : temp, sky: 'sunny' };\n}\n");
commit(work, 'Forecast: support Fahrenheit', 1);
who = 4; git(work, 'merge', '-q', '--no-ff', 'fix/timezone', '-m', "Merge branch 'fix/timezone'");
git(work, 'switch', '-q', 'feature/radar');
append(work, 'src/radar.js', "\nexport function legend() {\n  return ['light', 'moderate', 'heavy'];\n}\n");
commit(work, 'Radar: add precipitation legend', 3);
git(work, 'switch', '-q', 'main');
who = 3; git(work, 'merge', '-q', '--no-ff', 'feature/radar', '-m', "Merge branch 'feature/radar'");
write(work, 'package.json', JSON.stringify({ name: 'aurora-weather', version: '0.2.0', scripts: { start: 'node src/server.js', test: 'node --test' } }, null, 2) + '\n');
commit(work, 'Release 0.2.0', 0);
git(work, 'tag', '-a', 'v0.2.0', '-m', 'Radar + Fahrenheit');

// feature/dark-mode and feature/alerts in parallel
git(work, 'switch', '-q', '-c', 'feature/dark-mode');
write(work, 'web/theme.css', ':root { --bg: #fff; --fg: #111; }\n@media (prefers-color-scheme: dark) {\n  :root { --bg: #0d1117; --fg: #e6edf3; }\n}\n');
commit(work, 'Dark mode: theme tokens', 2);
write(work, 'web/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="#ffb340"/><circle cx="40" cy="26" r="16" fill="#0d1117"/></svg>\n');
commit(work, 'Dark mode: moon logo', 2);
git(work, 'switch', '-q', 'main');
git(work, 'switch', '-q', '-c', 'feature/alerts');
write(work, 'src/alerts.js', "export function alerts(city) {\n  return [{ city, level: 'yellow', text: 'Heavy rain this evening' }];\n}\n");
commit(work, 'Alerts: severe weather feed', 1);
git(work, 'switch', '-q', 'main');
write(work, 'src/server.js', "import http from 'node:http';\nimport { forecast } from './forecast.js';\n\nconst PORT = process.env.PORT || 3000;\n\nhttp.createServer((req, res) => {\n  res.setHeader('content-type', 'application/json');\n  res.end(JSON.stringify(forecast('Bangkok')));\n}).listen(PORT);\n");
commit(work, 'Server: configurable port and JSON content type', 4);
git(work, 'switch', '-q', 'feature/alerts');
append(work, 'src/alerts.js', "\nexport const LEVELS = ['green', 'yellow', 'orange', 'red'];\n");
commit(work, 'Alerts: severity levels', 1);
git(work, 'switch', '-q', 'feature/dark-mode');
append(work, 'web/theme.css', '\nbody { background: var(--bg); color: var(--fg); transition: background .2s; }\n');
commit(work, 'Dark mode: smooth transition', 2);
git(work, 'switch', '-q', 'main');
who = 2; git(work, 'merge', '-q', '--no-ff', 'feature/dark-mode', '-m', "Merge branch 'feature/dark-mode'");
git(work, 'branch', '-q', '-d', 'feature/dark-mode');
write(work, 'CHANGELOG.md', '# Changelog\n\n## 0.3.0\n- Dark mode\n- Configurable port\n');
commit(work, 'Changelog for 0.3.0', 0);

git(work, 'push', '-q', '-u', 'origin', 'main', 'feature/alerts', '--tags');

// a teammate pushes, so main is behind origin/main
execFileSync('git', ['clone', '-q', origin, mate]);
git(mate, 'config', 'user.name', PEOPLE[1][0]); git(mate, 'config', 'user.email', PEOPLE[1][1]);
append(mate, 'README.md', '\n## API\n\n`GET /` returns today\'s forecast as JSON.\n');
commit(mate, 'Docs: describe the API', 1);
git(mate, 'push', '-q', 'origin', 'main');

// local work ahead of origin
who = 0;
git(work, 'switch', '-q', 'feature/alerts');
write(work, 'src/alerts.js', "export const LEVELS = ['green', 'yellow', 'orange', 'red'];\n\nexport function alerts(city, min = 'yellow') {\n  const all = [{ city, level: 'yellow', text: 'Heavy rain this evening' }];\n  return all.filter((a) => LEVELS.indexOf(a.level) >= LEVELS.indexOf(min));\n}\n");
commit(work, 'Alerts: filter by minimum severity', 1);
git(work, 'switch', '-q', 'main');
git(work, 'switch', '-q', '-c', 'feature/hourly-chart');
write(work, 'web/chart.js', "export function hourly(points) {\n  return points.map((p, i) => ({ x: i, y: p.temp }));\n}\n");
commit(work, 'Hourly chart: data mapping', 4);
// two edits of the README title → merging fix/readme-title into main conflicts (try it!)
git(work, 'switch', '-q', 'main');
git(work, 'switch', '-q', '-c', 'fix/readme-title');
write(work, 'README.md', readFileSync(join(work, 'README.md'), 'utf8').replace('# Aurora Weather', '# Aurora Weather ☀️'));
commit(work, 'README: friendlier title', 4);
git(work, 'switch', '-q', 'main');
write(work, 'README.md', readFileSync(join(work, 'README.md'), 'utf8').replace('# Aurora Weather', '# Aurora Weather — forecasts'));
commit(work, 'README: clarify title', 0);
append(work, 'src/units.js', "export const toKmh = (ms) => ms * 3.6;\n");
commit(work, 'Units: wind speed in km/h', 2);
git(work, 'fetch', '-q', 'origin');

// a stash and some uncommitted work
append(work, 'CHANGELOG.md', '- Wind speed units\n');
git(work, 'stash', 'push', '-q', '-m', 'WIP changelog wording');
write(work, 'src/forecast.js', "import { toF } from './units.js';\n\n// TODO: real provider\nexport function forecast(city, unit = 'C') {\n  const temp = 30.5;\n  const humidity = 72;\n  return { city, temp: unit === 'F' ? toF(temp) : temp, humidity, sky: 'partly cloudy' };\n}\n");
write(work, 'src/cache.js', "const store = new Map();\n\nexport function cached(key, ttl, fn) {\n  const hit = store.get(key);\n  if (hit && hit.until > Date.now()) return hit.value;\n  const value = fn();\n  store.set(key, { value, until: Date.now() + ttl });\n  return value;\n}\n");
append(work, 'README.md', '\n## Caching\n\nResponses are cached for 10 minutes.\n');
git(work, 'add', 'README.md');

console.log('Demo repository ready →', work);
