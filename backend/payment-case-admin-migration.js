// Explicit-connection, additive migration. No startup hook or production DB access.
export const schema = [
`CREATE TABLE payment_case_admin_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 case_id INTEGER NOT NULL REFERENCES payment_cases(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('NEEDS_CUSTOMER_ACTION','RETURN_TO_VERIFICATION','REJECT')),
 message TEXT NOT NULL CHECK(typeof(message)='text' AND length(trim(message)) BETWEEN 1 AND 500),
 reason_category TEXT CHECK(reason_category IN ('PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','CUSTOMER_CANCELLED','OTHER')),
 admin_identifier TEXT NOT NULL CHECK(typeof(admin_identifier)='text' AND length(trim(admin_identifier)) BETWEEN 1 AND 150),
 created_at TEXT NOT NULL CHECK(COALESCE(typeof(created_at)='text' AND length(created_at)=24 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+0 seconds')=created_at,0)),
 CHECK((action='REJECT' AND reason_category IS NOT NULL) OR (action<>'REJECT' AND reason_category IS NULL))
)`,
`CREATE INDEX payment_case_admin_actions_case ON payment_case_admin_actions(case_id,id)`,
`CREATE TRIGGER payment_case_admin_actions_insert BEFORE INSERT ON payment_case_admin_actions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_admin_actions WHERE id=NEW.id)
 THEN RAISE(ABORT,'Action history is immutable') END;
END`,
...['UPDATE','DELETE'].map(op=>`CREATE TRIGGER payment_case_admin_actions_no_${op.toLowerCase()} BEFORE ${op} ON payment_case_admin_actions BEGIN SELECT RAISE(ABORT,'Action history is immutable'); END`)
];
const normalize=sql=>sql?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentCaseAdmin(db){
 if(db.inTransaction)throw new Error('Admin case migration requires its own transaction.');
 db.pragma('foreign_keys = ON');
 if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Foreign keys required.');
 db.transaction(()=>{
  for(const name of ['payment_cases','payment_case_submissions','payment_case_verifications'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Payment Case adapter schema required.');
  for(const sql of schema){const name=sql.match(/^CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/)[1];const old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);
   if(old&&normalize(old.sql)!==normalize(sql))throw new Error('Unexpected Admin case schema; manual review required.');
   if(!old)db.exec(sql);
  }
  if(db.prepare('PRAGMA foreign_key_check(payment_case_admin_actions)').all().length)throw new Error('Invalid action relationships.');
 }).immediate();
}
