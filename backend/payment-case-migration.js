// Explicit connection only: no environment loading, database opening, or startup hook.
const iso = c => `COALESCE(typeof(${c})='text' AND length(${c})=24 AND
 ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
 AND strftime('%Y-%m-%dT%H:%M:%fZ',${c},'+0 seconds')=${c},0)`;
const nonempty = c => `typeof(${c})='text' AND length(trim(${c})) BETWEEN 1 AND 500`;
export const objects = [
`CREATE TABLE payment_cases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
 plan TEXT NOT NULL CHECK(plan IN ('MONTH_1','MONTH_3','MONTH_6','YEAR_1')),
 plan_days INTEGER NOT NULL CHECK(typeof(plan_days)='integer'),
 amount_mmk INTEGER NOT NULL CHECK(typeof(amount_mmk)='integer'),
 payment_method TEXT NOT NULL CHECK(payment_method IN ('KBZPAY','WAVE_MONEY','AYA_PAY')),
 payment_account_reference TEXT NOT NULL CHECK(${nonempty('payment_account_reference')}),
 status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT' CHECK(status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','NEEDS_CUSTOMER_ACTION','CONFIRMED','COMPLETED','REJECTED')),
 submitted_at TEXT CHECK(submitted_at IS NULL OR ${iso('submitted_at')}),
 confirmed_at TEXT CHECK(confirmed_at IS NULL OR ${iso('confirmed_at')}),
 confirmed_by TEXT CHECK(confirmed_by IS NULL OR ${nonempty('confirmed_by')}),
 completed_at TEXT CHECK(completed_at IS NULL OR ${iso('completed_at')}),
 rejected_at TEXT CHECK(rejected_at IS NULL OR ${iso('rejected_at')}),
 rejected_by TEXT CHECK(rejected_by IS NULL OR ${nonempty('rejected_by')}),
 rejection_reason TEXT CHECK(rejection_reason IS NULL OR ${nonempty('rejection_reason')}),
 payment_id INTEGER UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL CHECK(${iso('created_at')}),
 updated_at TEXT NOT NULL CHECK(${iso('updated_at')} AND updated_at>=created_at),
 CHECK((plan='MONTH_1' AND plan_days=30 AND amount_mmk=2000) OR
 (plan='MONTH_3' AND plan_days=90 AND amount_mmk=5000) OR
 (plan='MONTH_6' AND plan_days=180 AND amount_mmk=9000) OR
 (plan='YEAR_1' AND plan_days=365 AND amount_mmk=17000)),
 CHECK(submitted_at IS NULL OR submitted_at BETWEEN created_at AND updated_at),
 CHECK((status IN ('CONFIRMED','COMPLETED') AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at BETWEEN submitted_at AND updated_at)
 OR (status NOT IN ('CONFIRMED','COMPLETED') AND confirmed_at IS NULL AND confirmed_by IS NULL)),
 CHECK((status='COMPLETED' AND completed_at IS NOT NULL AND payment_id IS NOT NULL AND completed_at BETWEEN confirmed_at AND updated_at)
 OR (status<>'COMPLETED' AND completed_at IS NULL AND payment_id IS NULL)),
 CHECK((status='REJECTED' AND rejected_at IS NOT NULL AND rejected_by IS NOT NULL AND rejection_reason IS NOT NULL AND rejected_at BETWEEN created_at AND updated_at)
 OR (status<>'REJECTED' AND rejected_at IS NULL AND rejected_by IS NULL AND rejection_reason IS NULL)),
 CHECK(status NOT IN ('WAITING_VERIFICATION','CONFIRMED','COMPLETED') OR submitted_at IS NOT NULL)
)`,
`CREATE TABLE payment_case_submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL REFERENCES payment_cases(id) ON DELETE RESTRICT,
 transaction_last_four TEXT CHECK(transaction_last_four IS NULL OR (typeof(transaction_last_four)='text' AND length(transaction_last_four)=4 AND transaction_last_four NOT GLOB '*[^0-9]*')),
 proof_file_id TEXT CHECK(proof_file_id IS NULL OR ${nonempty('proof_file_id')}),
 proof_file_unique_id TEXT CHECK(proof_file_unique_id IS NULL OR ${nonempty('proof_file_unique_id')}),
 proof_chat_id TEXT CHECK(proof_chat_id IS NULL OR ${nonempty('proof_chat_id')}),
 proof_message_id INTEGER CHECK(proof_message_id IS NULL OR (typeof(proof_message_id)='integer' AND proof_message_id BETWEEN 1 AND 9007199254740991)),
 created_at TEXT NOT NULL CHECK(${iso('created_at')}),
 CHECK(transaction_last_four IS NOT NULL OR proof_file_id IS NOT NULL),
 CHECK(proof_file_id IS NOT NULL OR (proof_file_unique_id IS NULL AND proof_chat_id IS NULL AND proof_message_id IS NULL)),
 CHECK((proof_chat_id IS NULL)=(proof_message_id IS NULL))
)`,
`CREATE INDEX payment_cases_user ON payment_cases(telegram_user_id,id)`,
`CREATE INDEX payment_cases_status ON payment_cases(status,id)`,
`CREATE INDEX payment_case_submissions_case ON payment_case_submissions(case_id,id)`,
`CREATE VIEW payment_cases_latest AS SELECT c.*,
 (SELECT transaction_last_four FROM payment_case_submissions WHERE case_id=c.id AND transaction_last_four IS NOT NULL ORDER BY id DESC LIMIT 1) AS transaction_last_four,
 (SELECT id FROM payment_case_submissions WHERE case_id=c.id AND proof_file_id IS NOT NULL ORDER BY id DESC LIMIT 1) AS latest_proof_submission_id
 FROM payment_cases c`,
`CREATE TRIGGER payment_cases_insert BEFORE INSERT ON payment_cases BEGIN
 SELECT CASE WHEN NEW.status<>'WAITING_PAYMENT' OR NEW.submitted_at IS NOT NULL OR EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.id)
 THEN RAISE(ABORT,'Invalid new payment case') END;
END`,
`CREATE TRIGGER payment_cases_update BEFORE UPDATE ON payment_cases BEGIN
 SELECT CASE WHEN OLD.status IN ('COMPLETED','REJECTED') OR NEW.id IS NOT OLD.id OR NEW.telegram_user_id IS NOT OLD.telegram_user_id
 OR NEW.plan IS NOT OLD.plan OR NEW.plan_days IS NOT OLD.plan_days OR NEW.amount_mmk IS NOT OLD.amount_mmk
 OR NEW.payment_method IS NOT OLD.payment_method OR NEW.payment_account_reference IS NOT OLD.payment_account_reference
 OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at<OLD.updated_at
 OR (OLD.status='CONFIRMED' AND (NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmed_by IS NOT OLD.confirmed_by OR NEW.submitted_at IS NOT OLD.submitted_at))
 THEN RAISE(ABORT,'Payment case history is protected') END;
 SELECT CASE WHEN NOT (NEW.status=OLD.status OR
 (OLD.status='WAITING_PAYMENT' AND NEW.status IN ('WAITING_VERIFICATION','REJECTED')) OR
 (OLD.status='WAITING_VERIFICATION' AND NEW.status IN ('NEEDS_CUSTOMER_ACTION','CONFIRMED','REJECTED')) OR
 (OLD.status='NEEDS_CUSTOMER_ACTION' AND NEW.status IN ('WAITING_VERIFICATION','REJECTED')) OR
 (OLD.status='CONFIRMED' AND NEW.status='COMPLETED')) THEN RAISE(ABORT,'Invalid payment case transition') END;
 SELECT CASE WHEN NEW.status IN ('WAITING_VERIFICATION','CONFIRMED','COMPLETED') AND (
 NOT EXISTS(SELECT 1 FROM payment_case_submissions WHERE case_id=OLD.id AND proof_file_id IS NOT NULL) OR
 NOT EXISTS(SELECT 1 FROM payment_case_submissions WHERE case_id=OLD.id AND transaction_last_four IS NOT NULL) OR
 EXISTS(SELECT 1 FROM payment_case_submissions WHERE case_id=OLD.id AND created_at>NEW.submitted_at)) THEN RAISE(ABORT,'Submitted evidence required') END;
 SELECT CASE WHEN NEW.status='COMPLETED' AND NOT EXISTS(
 SELECT 1 FROM payments p JOIN premium_membership_effects e ON e.payment_id=p.id
 WHERE p.id=NEW.payment_id AND p.telegram_user_id=NEW.telegram_user_id AND p.status='CONFIRMED'
 AND p.plan=NEW.plan AND p.plan_days=NEW.plan_days AND p.amount_mmk=NEW.amount_mmk AND p.payment_method=NEW.payment_method
 AND e.effect_type='PAYMENT_GRANT' AND e.telegram_user_id=NEW.telegram_user_id)
 THEN RAISE(ABORT,'Matching membership grant required') END;
END`,
`CREATE TRIGGER payment_case_submissions_insert BEFORE INSERT ON payment_case_submissions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.case_id AND status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','NEEDS_CUSTOMER_ACTION') AND created_at<=NEW.created_at)
 OR EXISTS(SELECT 1 FROM payment_case_submissions WHERE id=NEW.id)
 OR EXISTS(SELECT 1 FROM payment_case_submissions WHERE case_id=NEW.case_id AND created_at>NEW.created_at)
 THEN RAISE(ABORT,'Evidence append refused') END;
END`,
...['payment_cases','payment_case_submissions'].map(table=>`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Payment case history cannot be deleted'); END`),
`CREATE TRIGGER payment_case_submissions_no_update BEFORE UPDATE ON payment_case_submissions BEGIN SELECT RAISE(ABORT,'Evidence is immutable'); END`
];
const normalize = sql => sql?.replace(/\s+/g,' ').trim().replace(/;$/,'');

export function migratePaymentCases(db) {
 if(db.inTransaction) throw new Error('Payment case migration requires its own transaction.');
 db.pragma('foreign_keys = ON');
 if(db.pragma('foreign_keys',{simple:true})!==1) throw new Error('Foreign keys are required.');
 db.transaction(()=>{
  for(const name of ['telegram_users','payments','premium_membership_effects','membership_audit_log']) {
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('Existing Premium and ledger schema required.');
  }
  for(const sql of objects) {
   const name=sql.match(/^CREATE (?:TABLE|INDEX|VIEW|TRIGGER) (\w+)/)[1];
   const existing=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);
   if(existing && normalize(existing.sql)!==normalize(sql)) throw new Error('Unexpected payment case schema; manual review required.');
   if(!existing) db.exec(sql);
  }
  for(const table of ['payment_cases','payment_case_submissions']) {
   if(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) throw new Error('Invalid payment case relationships.');
  }
 }).immediate();
}
