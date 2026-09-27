import { readFile } from 'node:fs/promises';
import { createTour } from '../src/tour.js';

export async function loadTour() {
  const raw = await readFile(new URL('../fixtures/tour.json', import.meta.url), 'utf8');
  return createTour(JSON.parse(raw));
}

export const ACTORS = {
  curator: { role: 'curatorial', name: '策展值班岗位' },
  registrar: { role: 'curatorial', name: '藏品登录岗位' },
  carrier: { role: 'carrier-install', name: '承运组长岗位' },
  installer: { role: 'carrier-install', name: '安装组长岗位' },
  educator: { role: 'public-education', name: '公教专员岗位' },
};
