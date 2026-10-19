// Writes docs/openapi.json from the live route schemas (no database connection is opened).
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/database.js';

const config = loadConfig();
const db = createDb({ connectionString: config.databaseUrl, max: 1 });
const app = await buildApp({ config, db });
await app.ready();
await writeFile('docs/openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await db.destroy();
console.log('wrote docs/openapi.json');
