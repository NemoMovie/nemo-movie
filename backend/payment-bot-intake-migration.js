// Explicit Stage 2 migration; never opens a DB or runs at production startup.
import { targets } from './payment-case-workflow-migration.js';
const oldGuard=targets.find(sql=>sql.startsWith('CREATE TRIGGER payment_cases_update '));
const guard=oldGuard.replace('OR NEW.payment_method IS NOT OLD.payment_method OR NEW.payment_account_reference IS NOT OLD.payment_account_reference',`OR ((NEW.payment_method IS NOT OLD.payment_method OR NEW.payment_account_reference IS NOT OLD.payment_account_reference) AND NOT EXISTS(
 SELECT 1 FROM payment_case_method_changes a WHERE a.case_id=OLD.id AND a.id=(SELECT max(id) FROM payment_case_method_changes WHERE case_id=OLD.id)
 AND a.old_method=OLD.payment_method AND a.old_account=OLD.payment_account_reference AND a.new_method=NEW.payment_method AND a.new_account=NEW.payment_account_reference
 AND a.created_at=NEW.updated_at AND OLD.status='WAITING_PAYMENT' AND NEW.status='WAITING_PAYMENT'))`);
const schema=[
`CREATE TABLE payment_case_method_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES payment_cases(id),
 telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_user_id),
 old_method TEXT NOT NULL, new_method TEXT NOT NULL CHECK(new_method IN ('KBZPAY','WAVE_MONEY','AYA_PAY') AND new_method<>old_method),
 old_account TEXT NOT NULL, new_account TEXT NOT NULL CHECK(length(new_account) BETWEEN 1 AND 500),
 created_at TEXT NOT NULL CHECK(COALESCE(length(created_at)=24 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+0 seconds')=created_at,0))
)`,
`CREATE TRIGGER payment_case_method_changes_insert BEFORE INSERT ON payment_case_method_changes BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_method_changes WHERE id=NEW.id) OR NOT EXISTS(
 SELECT 1 FROM payment_cases c WHERE c.id=NEW.case_id AND c.telegram_user_id=NEW.telegram_user_id AND c.status='WAITING_PAYMENT'
 AND c.payment_method=NEW.old_method AND c.payment_account_reference=NEW.old_account AND c.updated_at<=NEW.created_at
 AND strftime('%Y-%m-%dT%H:%M:%fZ',c.created_at,'+1 day')>NEW.created_at)
 OR EXISTS(SELECT 1 FROM payment_case_submissions WHERE case_id=NEW.case_id AND proof_file_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM payment_case_messages WHERE payment_case_id=NEW.case_id AND message_type='PHOTO')
 THEN RAISE(ABORT,'Method change refused') END;
END`,
`CREATE TRIGGER payment_case_method_changes_apply AFTER INSERT ON payment_case_method_changes BEGIN
 UPDATE payment_cases SET payment_method=NEW.new_method,payment_account_reference=NEW.new_account,updated_at=NEW.created_at WHERE id=NEW.case_id;
END`,
`CREATE TABLE payment_bot_operations (
 telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_user_id), operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 150),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), case_id INTEGER NOT NULL REFERENCES payment_cases(id), outcome TEXT NOT NULL,
 PRIMARY KEY(telegram_user_id,operation_key)
)`,
...['payment_case_method_changes','payment_bot_operations'].flatMap(table=>['UPDATE','DELETE'].map(op=>`CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'History is immutable'); END`)),
`CREATE TRIGGER payment_bot_operations_insert BEFORE INSERT ON payment_bot_operations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_bot_operations WHERE telegram_user_id=NEW.telegram_user_id AND operation_key=NEW.operation_key)
 OR NOT EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.case_id AND telegram_user_id=NEW.telegram_user_id) THEN RAISE(ABORT,'Invalid operation receipt') END;
END`
];
const normalize=s=>s?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentBotIntake(db){
 if(db.inTransaction)throw new Error('Intake migration requires its own transaction');
 db.pragma('foreign_keys=ON');
 db.transaction(()=>{
  const current=db.prepare("SELECT sql FROM sqlite_master WHERE name='payment_cases_update'").get()?.sql;
  if(![normalize(oldGuard),normalize(guard)].includes(normalize(current)))throw new Error('Stage 1 workflow required');
  for(const sql of schema){const name=sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)[1],old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);if(old&&normalize(old.sql)!==normalize(sql))throw new Error('Unexpected intake schema');if(!old)db.exec(sql);}
  if(normalize(current)!==normalize(guard)){db.exec('DROP TRIGGER payment_cases_update');db.exec(guard);}
  if(db.pragma('foreign_key_check').length)throw new Error('Invalid intake relationships');
 }).immediate();
}
