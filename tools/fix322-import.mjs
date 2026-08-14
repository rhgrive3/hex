import fs from 'node:fs';
const p='js/tools.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace(`import {\nimport { MAX_SOURCE as MAX_PLUGIN_SOURCE } from './plugins.js';\n`, `import {\n`);
const anchor=`import { EXAMPLE_PLUGIN } from './plugins.js';`;
const replacement=`import { EXAMPLE_PLUGIN, MAX_SOURCE as MAX_PLUGIN_SOURCE } from './plugins.js';`;
if(!s.includes(anchor)) throw new Error('plugins import anchor missing');
s=s.replace(anchor,replacement);
fs.writeFileSync(p,s);
