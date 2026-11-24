// Offline avatars: initials on a colour derived from the e-mail (no Gravatar, nothing leaves the Mac).
import { h } from './h.js';

const HUES = [199, 330, 265, 32, 152, 12, 220, 292, 75, 174, 0, 238];

export function hashStr(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

export function initials(name = '') {
  const parts = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarColor(email = '') {
  const hue = HUES[hashStr(String(email).toLowerCase()) % HUES.length];
  return `hsl(${hue} 70% 58%)`;
}

export function avatar(name, email, size = 28) {
  return h('span', { class: 'avatar', title: `${name} <${email}>`, style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px', background: avatarColor(email) } }, initials(name));
}
