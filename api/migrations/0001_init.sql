
PRAGMA foreign_keys = ON;

CREATE TABLE homes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CONSTRAINT homes_name_not_empty
        CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
    id TEXT PRIMARY KEY NOT NULL,
    home_id TEXT NOT NULL,
    name TEXT NOT NULL CONSTRAINT members_name_not_empty
        CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT members_home_fk
        FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

CREATE INDEX members_home_order_idx
    ON members(home_id, created_at, id);

CREATE TABLE bills (
    id TEXT PRIMARY KEY NOT NULL,
    home_id TEXT NOT NULL,
    title TEXT NOT NULL CONSTRAINT bills_title_not_empty
        CHECK (length(trim(title)) > 0),
    total_cents INTEGER NOT NULL
        CONSTRAINT bills_total_positive CHECK (total_cents > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bills_home_fk
        FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

CREATE TABLE shares (
    id TEXT PRIMARY KEY NOT NULL,
    bill_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL
        CONSTRAINT shares_amount_nonnegative CHECK (amount_cents >= 0),
    paid_at TEXT,
    idempotency_key TEXT,
    CONSTRAINT shares_bill_fk
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
    CONSTRAINT shares_member_fk
        FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    CONSTRAINT shares_bill_member_unique UNIQUE (bill_id, member_id),
    CONSTRAINT shares_payment_key_pair CHECK (
        (paid_at IS NULL AND idempotency_key IS NULL)
        OR (paid_at IS NOT NULL AND idempotency_key IS NOT NULL)
    )
);

CREATE UNIQUE INDEX shares_idempotency_key_unique
    ON shares(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX shares_member_unpaid_idx
    ON shares(member_id, paid_at);
