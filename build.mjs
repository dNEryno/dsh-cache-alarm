// Inlines core.mjs into the browser artifact. The client module cannot import
// relative files: the module loader hands the factory only React.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(here, 'core.mjs'), 'utf8').replace(/^export /gm, '');
const template = readFileSync(join(here, 'client.template.js'), 'utf8');
const marker = '/*__CORE__*/';
if (!template.includes(marker)) throw new Error('client.template.js is missing the core marker');
writeFileSync(join(here, 'client.js'), template.replace(marker, core.trimEnd()), 'utf8');
console.log('client.js written');
