CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    is_unread INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

CREATE TABLE IF NOT EXISTS redeem_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    redeem_type TEXT NOT NULL,
    value TEXT NOT NULL,
    result TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    redeemed INTEGER NOT NULL DEFAULT 0 CHECK (redeemed IN (0, 1)),
    expires_at DATETIME NOT NULL,
    redeemed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_redeem_codes_type ON redeem_codes(redeem_type);

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
CREATE INDEX IF NOT EXISTS idx_workflows_enabled_priority ON workflows(enabled, priority DESC, id ASC);

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
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_mail ON workflow_runs(mail_id);

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
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, id ASC);
