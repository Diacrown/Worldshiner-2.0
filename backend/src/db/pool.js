import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. a dropped connection) should never crash the
  // whole process — log and let the pool recover.
  console.error('[db] Unexpected error on idle client', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Use for multi-statement operations that must succeed or fail together
// (e.g. status change + history row insert).
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
