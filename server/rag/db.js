// Postgres-подключение к Supabase владельца (D-134). Креды — только env.
// Pooler Supabase использует самоподписанный CA; rejectUnauthorized:false —
// осознанное допущение, зафиксированное в D-134.

import pg from 'pg';

export function dbConfigFromEnv(env = process.env) {
  const host = env.SUPABASE_DB_HOST;
  const user = env.SUPABASE_DB_USER;
  const password = env.SUPABASE_DB_PASSWORD;
  if (!host || !user || !password) {
    throw new Error('SUPABASE_DB_HOST/USER/PASSWORD не заданы в env — подключение невозможно');
  }
  return {
    host,
    port: Number(env.SUPABASE_DB_PORT || 5432),
    user,
    password,
    database: env.SUPABASE_DB_NAME || 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  };
}

export async function withClient(fn, env = process.env) {
  const client = new pg.Client(dbConfigFromEnv(env));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}