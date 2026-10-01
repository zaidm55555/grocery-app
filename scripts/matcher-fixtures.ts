// Regression fixtures for src/utils/matcher.ts.
// Run: npx tsc scripts/matcher-fixtures.ts --ignoreConfig --outDir /tmp/mf --module commonjs --target es2020 --skipLibCheck && node /tmp/mf/scripts/matcher-fixtures.js
import { matchScore, pickBestMatch } from '../src/utils/matcher';

declare const process: any;
type P = { name: string; unit: string; price?: number };
const T = 0.5;
const same: [P, P][] = [
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt Vacuum Evaporated', unit: '1 kg', price: 29 }],
  [{ name: 'Amul Butter Salted', unit: '100 g', price: 58 }, { name: 'Amul Salted Butter', unit: '100 g', price: 60 }],
  [{ name: 'Tomatoes', unit: '500 g', price: 30 }, { name: 'Tomato', unit: '500 g', price: 32 }],
  [{ name: 'Mother Dairy Dahi', unit: '400 g', price: 40 }, { name: 'Mother Dairy Curd', unit: '400 g', price: 42 }],
  [{ name: 'Aashirvaad Atta', unit: '5 kg', price: 260 }, { name: 'Aashirvaad Atta', unit: '5 kg', price: 255 }],
  [{ name: 'Coca-Cola Zero', unit: '750 ml', price: 40 }, { name: 'Coca Cola Zero Sugar', unit: '750 ml', price: 40 }],
];
const different: [P, P][] = [
  [{ name: 'English Oven Pav Bread', unit: '200 g', price: 30 }, { name: 'English Oven Milk Bread', unit: '400 g', price: 45 }],
  [{ name: 'English Oven Pav Bread', unit: '400 g', price: 40 }, { name: 'English Oven Milk Bread', unit: '400 g', price: 40 }],
  [{ name: 'Amul Butter Salted', unit: '100 g', price: 58 }, { name: 'Amul Butter Unsalted', unit: '100 g', price: 58 }],
  [{ name: 'Amul Toned Milk', unit: '500 ml', price: 30 }, { name: 'Amul Full Cream Milk', unit: '500 ml', price: 36 }],
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Aashirvaad Salt', unit: '1 kg', price: 28 }],
  [{ name: 'Coca-Cola', unit: '750 ml', price: 40 }, { name: 'Coca-Cola Zero', unit: '750 ml', price: 40 }],
  [{ name: 'Atta', unit: '1 kg', price: 60 }, { name: 'Maida', unit: '1 kg', price: 60 }],
  [{ name: 'Red Chilli Powder', unit: '100 g', price: 40 }, { name: 'Green Chilli Powder', unit: '100 g', price: 40 }],
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt', unit: '1 L', price: 28 }],
];
let fail = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { fail++; console.log('FAIL', msg); } };
same.forEach(([a, b]) => { const s = matchScore(a, b); check(s >= T, `should match (${s}): ${a.name} ~ ${b.name}`); });
different.forEach(([a, b]) => { const s = matchScore(a, b); check(s < T, `should NOT match (${s}): ${a.name} ~ ${b.name} [${b.unit}]`); });
const pick = pickBestMatch({ name: 'Amul Butter', unit: '500 g', price: 280 }, [
  { name: 'Amul Butter', unit: '100 g', price: 58 }, { name: 'Amul Butter', unit: '500 g', price: 285 }, { name: 'Amul Cheese', unit: '500 g', price: 280 },
]);
check(pick?.candidate.unit === '500 g' && pick.candidate.name === 'Amul Butter', 'pickBestMatch prefers same size');
console.log(fail ? `${fail} failure(s)` : 'all fixtures pass');
process.exit(fail ? 1 : 0);
