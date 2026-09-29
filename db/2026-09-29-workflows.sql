CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    priority INTEGER NOT NULL DEFAULT 0,
    definition TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflows_enabled_priority
    ON workflows(enabled, priority DESC, id ASC);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id INTEGER NOT NULL,
    mail_id INTEGER,
    message_id TEXT,
    definition TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    duration_ms INTEGER,
    error TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started
    ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_mail
    ON workflow_runs(mail_id);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    duration_ms INTEGER,
    output TEXT,
    error TEXT,
    UNIQUE(run_id, node_id),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
    ON workflow_run_steps(run_id, id ASC);
