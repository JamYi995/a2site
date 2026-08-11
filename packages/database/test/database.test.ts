import { describe, expect, it } from 'vitest';
import { createDatabase, runMigrations } from '../src/index.js';

describe('A2Site database', () => {
  it('在 PGlite 中持久执行版本化迁移', async () => {
    const database = await createDatabase();
    const migration = {
      id: 'test-001',
      description: 'test migration',
      sql: 'CREATE TABLE test_items(id TEXT PRIMARY KEY, value TEXT NOT NULL)',
    };

    expect(await runMigrations(database, [migration])).toEqual(['test-001']);
    expect(await runMigrations(database, [migration])).toEqual([]);
    await database.query('INSERT INTO test_items(id,value) VALUES($1,$2)', ['one', 'value']);
    expect(await database.query('SELECT * FROM test_items')).toEqual([{ id: 'one', value: 'value' }]);

    await database.close();
  });
});
