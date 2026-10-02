-- Settled-tasks feed (GET /v1/tasks/settled): the feed and its stats both read
-- "payment_status = 'settled' ordered/filtered by settled_at".
CREATE INDEX IF NOT EXISTS idx_tasks_payment_settled ON tasks(payment_status, settled_at);
