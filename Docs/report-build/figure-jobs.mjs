// Writes figures/jobs.json for the headless-Chrome renderer (SVG -> PNG at native size).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'figures');
const figs = [
  ['fig1-aws-architecture', 2500, 1650],
  ['fig2-system-architecture', 2500, 1620],
  ['fig3-fault-timeline', 1600, 860],
  ['fig4-gnn', 1600, 900],
  ['fig5-model-accuracy', 1500, 820],
];
const jobs = figs.map(([n, w, h]) => ({ url: pathToFileURL(path.join(dir, `${n}.svg`)).href, out: `${n}.png`, wait: 400, width: w, height: h }));
fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify({ outDir: dir, jobs }, null, 1));
console.log(`wrote ${jobs.length} jobs`);
