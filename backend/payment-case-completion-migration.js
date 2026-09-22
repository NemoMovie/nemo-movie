// Explicit, additive migration. No database opening or startup execution.
const iso=c=>`COALESCE(length(${c})=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',${c},'+0 seconds')=${c},0)`;
const definitions=[
`CREATE TABLE payment_case_notifications (
 case_id INTEGER NOT NULL REFERENCES payment_cases(id), event TEXT NOT NULL CHECK(event IN ('CONFIRMED','COMPLETED','REJECTED')),
 message_id INTEGER UNIQUE NOT NULL REFERENCES payment_case_messages(id),
 action TEXT CHECK(action IS NULL OR action='RESELECT'),
 delivery_state TEXT NOT NULL DEFAULT 'PENDING_SEND' CHECK(delivery_state IN ('PENDING_SEND','SENT','FAILED')),
 created_at TEXT NOT NULL CHECK(${iso('created_at')}), PRIMARY KEY(case_id,event),
 CHECK(COALESCE((event='REJECTED' AND action='RESELECT') OR (event<>'REJECTED' AND action IS NULL),0))
)`,
`CREATE TRIGGER payment_case_notifications_insert BEFORE INSERT ON payment_case_notifications BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_notifications WHERE case_id=NEW.case_id AND event=NEW.event OR message_id=NEW.message_id)
 OR NEW.delivery_state<>'PENDING_SEND' OR NOT EXISTS(SELECT 1 FROM payment_case_messages m JOIN payment_cases c ON c.id=m.payment_case_id WHERE m.id=NEW.message_id AND m.payment_case_id=NEW.case_id AND m.sender_type='SYSTEM' AND m.message_type='SYSTEM' AND c.status=NEW.event AND m.created_at=NEW.created_at)
 THEN RAISE(ABORT,'Invalid notification') END;
END`,
`CREATE TRIGGER payment_case_notifications_update BEFORE UPDATE ON payment_case_notifications BEGIN
 SELECT CASE WHEN NEW.case_id IS NOT OLD.case_id OR NEW.event IS NOT OLD.event OR NEW.message_id IS NOT OLD.message_id OR NEW.action IS NOT OLD.action OR NEW.created_at IS NOT OLD.created_at OR OLD.delivery_state='SENT'
 THEN RAISE(ABORT,'Notification payload is immutable') END;
END`,
`CREATE TRIGGER payment_case_notifications_delete BEFORE DELETE ON payment_case_notifications BEGIN SELECT RAISE(ABORT,'Notification history is immutable'); END`,
`CREATE TABLE payment_case_activation_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES payment_cases(id),
 admin_identifier TEXT NOT NULL CHECK(length(trim(admin_identifier)) BETWEEN 1 AND 150),
 outcome TEXT NOT NULL CHECK(outcome IN ('COMPLETED','COMPLETION_FAILED','MANUAL_RECONCILIATION_REQUIRED')),
 created_at TEXT NOT NULL CHECK(${iso('created_at')})
)`,
`CREATE TRIGGER payment_case_activation_attempts_insert BEFORE INSERT ON payment_case_activation_attempts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_activation_attempts WHERE id=NEW.id) OR NOT EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.case_id AND status=CASE WHEN NEW.outcome='COMPLETED' THEN 'COMPLETED' ELSE 'CONFIRMED' END)
 THEN RAISE(ABORT,'Invalid activation attempt') END;
END`,
...['UPDATE','DELETE'].map(op=>`CREATE TRIGGER payment_case_activation_attempts_no_${op.toLowerCase()} BEFORE ${op} ON payment_case_activation_attempts BEGIN SELECT RAISE(ABORT,'Activation history is immutable'); END`)
];
const norm=s=>s?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentCaseCompletion(db){
 if(db.inTransaction)throw new Error('Completion migration requires its own transaction');
 db.pragma('foreign_keys=ON');
 db.transaction(()=>{
  for(const name of ['payment_bot_operations','payment_case_messages','payment_case_verifications','premium_membership_effects'])if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))throw new Error('Stage 2 schema required');
  for(const sql of definitions){const name=sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)[1],old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);if(old&&norm(old.sql)!==norm(sql))throw new Error('Unexpected completion schema');if(!old)db.exec(sql);}
  if(db.pragma('foreign_key_check').length)throw new Error('Invalid completion relationships');
 }).immediate();
}
