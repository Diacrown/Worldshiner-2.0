import { pool, withTransaction } from '../db/pool.js';
import { getJobById } from './jobs.service.js';

const KINDS = ['custom', 'matching_set', 'stock'];

function formatDesignNo(prefix, n) {
  return `${prefix}${String(n).padStart(5, '0')}`;
}

// Refreshes jobs.design_no — a denormalized display string summarizing every
// design entry's base number, so job list/detail views don't need to join
// job_design_entries just to show "S00001, S00002E-S, S00002W-S".
async function refreshJobDesignNo(client, jobId) {
  const { rows } = await client.query(
    `SELECT base_number FROM job_design_entries WHERE job_id = $1 AND base_number IS NOT NULL ORDER BY sort_order, id`,
    [jobId]
  );
  const designNo = rows.map((r) => r.base_number).join(', ') || null;
  await client.query('UPDATE jobs SET design_no = $1 WHERE id = $2', [designNo, jobId]);
}

export async function listDesignEntries(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'SELECT * FROM job_design_entries WHERE job_id = $1 ORDER BY sort_order, id',
    [jobId]
  );
  return rows;
}

// Mints the next sequential design number, scoped to the JOB's OWN office —
// each office has its own counter and letter prefix (e.g. Sydney's "S",
// UK's "K"), matching how the real system's separate designNo/designNoB/
// designNoK/designNoT counters actually worked, rather than one shared
// global sequence. Claiming is separate from creating an entry: a matching
// set claims ONE number, then multiple pieces (each with their own suffix)
// reuse that same base — so the number is handed to the caller first, and
// addDesignEntry() below just records it.
export async function claimDesignNumber(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE offices SET next_design_value = next_design_value + 1
       WHERE id = $1 RETURNING next_design_value - 1 AS claimed, letter_prefix`,
      [job.office_id]
    );
    const { claimed, letter_prefix } = rows[0];
    if (!letter_prefix) {
      const err = new Error('This office has no design-number letter prefix configured — set offices.letter_prefix before claiming numbers');
      err.status = 400;
      throw err;
    }
    return { baseNumber: formatDesignNo(letter_prefix, claimed) };
  });
}

export async function addDesignEntry(user, jobId, { kind, baseNumber, suffix, description, poNumber, sortOrder, styleCode, qty }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (!KINDS.includes(kind)) {
    const err = new Error(`kind must be one of: ${KINDS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  let finalBaseNumber = null;
  if (kind === 'matching_set') {
    if (!baseNumber) {
      const err = new Error('baseNumber is required for a matching_set entry (claim one first, then reuse it per piece)');
      err.status = 400;
      throw err;
    }
    if (!suffix || !suffix.trim()) {
      const err = new Error('suffix is required for a matching_set entry (e.g. "E", "W")');
      err.status = 400;
      throw err;
    }
    finalBaseNumber = `${baseNumber}${suffix.trim()}-S`;
  } else if (kind === 'custom') {
    if (!baseNumber) {
      const err = new Error('baseNumber is required for a custom entry');
      err.status = 400;
      throw err;
    }
    if (suffix) {
      const err = new Error('suffix is only used for matching_set entries');
      err.status = 400;
      throw err;
    }
    finalBaseNumber = baseNumber;
  }
  // kind === 'stock': finalBaseNumber stays null — no claimed number involved,
  // it's identified by an existing style code + quantity instead.
  if (kind === 'stock' && !styleCode) {
    const err = new Error('styleCode is required for a stock entry');
    err.status = 400;
    throw err;
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO job_design_entries (job_id, kind, base_number, description, po_number, sort_order, style_code, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [jobId, kind, finalBaseNumber, description || null, poNumber || null, sortOrder || 0, kind === 'stock' ? styleCode : null, kind === 'stock' ? (qty || 1) : null]
    );
    await refreshJobDesignNo(client, jobId);
    return rows[0];
  });
}

export async function updateDesignEntry(user, jobId, entryId, { description, poNumber, sortOrder }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const sets = [];
  const params = [];
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (poNumber !== undefined) { params.push(poNumber); sets.push(`po_number = $${params.length}`); }
  if (sortOrder !== undefined) { params.push(sortOrder); sets.push(`sort_order = $${params.length}`); }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM job_design_entries WHERE id = $1 AND job_id = $2', [entryId, jobId]);
    return rows[0] ?? null;
  }
  params.push(entryId, jobId);
  const { rows } = await pool.query(
    `UPDATE job_design_entries SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND job_id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

// Deletes the entry row only — deliberately does NOT decrement
// design_number_counter, so claimed numbers stay monotonic and never get
// reused even if the entry that claimed one is later removed.
export async function deleteDesignEntry(user, jobId, entryId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM job_design_entries WHERE id = $1 AND job_id = $2',
      [entryId, jobId]
    );
    if (rowCount > 0) await refreshJobDesignNo(client, jobId);
    return rowCount > 0;
  });
}

export async function listClientItems(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'SELECT * FROM job_client_items WHERE job_id = $1 ORDER BY sort_order, id',
    [jobId]
  );
  return rows;
}

export async function addClientItem(user, jobId, { description, sortOrder }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'INSERT INTO job_client_items (job_id, description, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [jobId, description || null, sortOrder || 0]
  );
  return rows[0];
}

export async function updateClientItem(user, jobId, itemId, { description, sortOrder }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const sets = [];
  const params = [];
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (sortOrder !== undefined) { params.push(sortOrder); sets.push(`sort_order = $${params.length}`); }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM job_client_items WHERE id = $1 AND job_id = $2', [itemId, jobId]);
    return rows[0] ?? null;
  }
  params.push(itemId, jobId);
  const { rows } = await pool.query(
    `UPDATE job_client_items SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND job_id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

export async function deleteClientItem(user, jobId, itemId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rowCount } = await pool.query(
    'DELETE FROM job_client_items WHERE id = $1 AND job_id = $2',
    [itemId, jobId]
  );
  return rowCount > 0;
}

const SETTER_POLISHER_ROLES = ['setter', 'polisher', 'repairer'];

export async function listSetterPolisher(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'SELECT * FROM job_setter_polisher WHERE job_id = $1 ORDER BY id',
    [jobId]
  );
  return rows;
}

export async function addSetterPolisher(user, jobId, { roleType, personName, fee, dateSent, dueDate, dateReturned }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (!SETTER_POLISHER_ROLES.includes(roleType)) {
    const err = new Error(`roleType must be one of: ${SETTER_POLISHER_ROLES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO job_setter_polisher (job_id, role_type, person_name, fee, date_sent, due_date, date_returned)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [jobId, roleType, personName || null, fee || null, dateSent || null, dueDate || null, dateReturned || null]
  );
  return rows[0];
}

export async function updateSetterPolisher(user, jobId, id, { personName, fee, dateSent, dueDate, dateReturned }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (personName !== undefined) push('person_name', personName);
  if (fee !== undefined) push('fee', fee);
  if (dateSent !== undefined) push('date_sent', dateSent);
  if (dueDate !== undefined) push('due_date', dueDate);
  if (dateReturned !== undefined) push('date_returned', dateReturned);
  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM job_setter_polisher WHERE id = $1 AND job_id = $2', [id, jobId]);
    return rows[0] ?? null;
  }
  params.push(id, jobId);
  const { rows } = await pool.query(
    `UPDATE job_setter_polisher SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND job_id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

export async function deleteSetterPolisher(user, jobId, id) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rowCount } = await pool.query(
    'DELETE FROM job_setter_polisher WHERE id = $1 AND job_id = $2',
    [id, jobId]
  );
  return rowCount > 0;
}
