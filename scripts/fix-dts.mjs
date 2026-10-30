// tsc rewrites relative `.ts` imports in emitted JS but not in declarations; fix those up.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

for (const file of readdirSync('dist').filter((f) => f.endsWith('.d.ts'))) {
  const path = `dist/${file}`;
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
