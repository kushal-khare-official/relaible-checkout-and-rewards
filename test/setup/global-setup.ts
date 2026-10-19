import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { createDb } from '../../src/db/database.js';
import { migrateToLatest } from '../../src/db/migrations.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Integration tests run against real PostgreSQL, because the invariants under test are
 * enforced by row locks and constraints. By default a throwaway container is started; set
 * TEST_DATABASE_URL to use an existing (disposable!) database instead. It will be truncated.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }
  const db = createDb({ connectionString: url, max: 2 });
  await migrateToLatest(db);
  await db.destroy();
  project.provide('databaseUrl', url);

  return async () => {
    await container?.stop();
  };
}
