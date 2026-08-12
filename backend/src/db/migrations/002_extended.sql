-- World Shiner 2.0 — Extended schema
-- Ports the rest of the job document's nested/embedded data (India's `prod`
-- object, setter/polisher flat fields, client items, design entries, chat,
-- issue tracker) into proper normalized tables instead of loosely-typed
-- nested JSON blobs on a single shared document.
--
-- Schema is complete here so the full data model is planned end-to-end.
-- API routes for these tables are NOT all wired up yet in this scaffold —
-- see docs/ROADMAP.md for what's live vs. planned.

-- India's own production-side tracking. 1:1 with jobs. Kept separate from
-- the branch office's own fields on purpose — the old system had India's
-- `prod.*` fields and the branch's own fields smashed onto the same document,
-- which is exactly how the dueDate/clientDeliveryDate field collision happened.
CREATE TABLE job_production (
  job_id            BIGINT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  inquiry_date      DATE,
  quotation_date    DATE,
  cad_issued        DATE,
  cad_modification  DATE,
  qc_ready          DATE,
  qc_pass           DATE,
  ship_date         DATE,
  item_type         TEXT
);

CREATE TABLE job_setter_polisher (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  role_type     TEXT NOT NULL CHECK (role_type IN ('setter','polisher')),
  person_name   TEXT,
  fee           NUMERIC(10,2),
  date_sent     DATE,
  due_date      DATE,
  date_returned DATE
);
CREATE INDEX idx_setter_polisher_job ON job_setter_polisher(job_id);

CREATE TABLE job_design_entries (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('custom','matching_set','stock')),
  base_number   TEXT,        -- e.g. S01141 — claimed sequentially for custom/matching_set
  description   TEXT,
  po_number     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_design_entries_job ON job_design_entries(job_id);

-- Sequence backing claimNextDesignNo() — replaces whatever counter document
-- the old app read/incremented in Firestore for design numbers.
CREATE TABLE design_number_counter (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  next_value    INTEGER NOT NULL,
  CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE job_client_items (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_client_items_job ON job_client_items(job_id);

-- Covers clientRef images, cadImage images, and per-client-item images —
-- one table instead of three parallel array-of-URL fields.
CREATE TABLE job_images (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  client_item_id  BIGINT REFERENCES job_client_items(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('client_ref','cad','client_item')),
  url             TEXT NOT NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_images_job ON job_images(job_id);

CREATE TABLE job_chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sender_user_id  INTEGER REFERENCES users(id),
  body            TEXT,
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_job ON job_chat_messages(job_id, created_at);

CREATE TABLE job_chat_read_receipts (
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id)
);

CREATE TABLE job_issues (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  issue_type        TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened_by_user_id INTEGER REFERENCES users(id),
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by_user_id INTEGER REFERENCES users(id),
  resolved_at       TIMESTAMPTZ
);
CREATE INDEX idx_issues_job ON job_issues(job_id);

CREATE TABLE job_issue_events (
  id            BIGSERIAL PRIMARY KEY,
  issue_id      BIGINT NOT NULL REFERENCES job_issues(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,   -- 'opened' | 'reopened' | 'resolved' | 'note'
  note          TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
