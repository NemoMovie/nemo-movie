// Additive, explicit-connection migration; never loads configuration or opens a DB.
const iso = c => `COALESCE(typeof(${c})='text' AND length(${c})=24 AND
 ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
 AND strftime('%Y-%m-%dT%H:%M:%fZ',${c},'+0 seconds')=${c},0)`;
export const objects = [
`CREATE TABLE payment_case_verifications (
 case_id INTEGER PRIMARY KEY REFERENCES payment_cases(id) ON DELETE RESTRICT,
 transaction_reference TEXT NOT NULL CHECK(typeof(transaction_reference)='text' AND transaction_reference=trim(transaction_reference) AND length(transaction_reference) BETWEEN 5 AND 150),
 payment_method TEXT NOT NULL CHECK(payment_method IN ('KBZPAY','WAVE_MONEY','AYA_PAY')),
 payment_at TEXT NOT NULL CHECK(${iso('payment_at')}),
 confirmed_at TEXT NOT NULL CHECK(${iso('confirmed_at')} AND payment_at<=confirmed_at),
 admin_identifier TEXT NOT NULL CHECK(typeof(admin_identifier)='text' AND length(trim(admin_identifier)) BETWEEN 1 AND 150),
 internal_request_code TEXT UNIQUE NOT NULL CHECK(length(internal_request_code)=9 AND substr(internal_request_code,1,3)='NM-' AND substr(internal_request_code,4) NOT GLOB '*[^A-HJ-NP-Z2-9]*'),
 UNIQUE(payment_method,transaction_reference)
)`,
`CREATE TRIGGER payment_case_verifications_insert BEFORE INSERT ON payment_case_verifications BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_verifications WHERE case_id=NEW.case_id OR internal_request_code=NEW.internal_request_code OR (payment_method=NEW.payment_method AND transaction_reference=NEW.transaction_reference))
 OR NOT EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.case_id AND status='WAITING_VERIFICATION' AND payment_method=NEW.payment_method AND updated_at<=NEW.confirmed_at)
 OR EXISTS(SELECT 1 FROM payments WHERE payment_request_code=NEW.internal_request_code OR (status='CONFIRMED' AND payment_method=NEW.payment_method AND transaction_reference=NEW.transaction_reference))
 THEN RAISE(ABORT,'Payment verification refused') END;
END`,
...['UPDATE','DELETE'].map(op=>`CREATE TRIGGER payment_case_verifications_no_${op.toLowerCase()} BEFORE ${op} ON payment_case_verifications BEGIN SELECT RAISE(ABORT,'Payment verification is immutable'); END`),
`CREATE TRIGGER payment_cases_verified_transition BEFORE UPDATE ON payment_cases WHEN NEW.status IN ('CONFIRMED','COMPLETED') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payment_case_verifications v WHERE v.case_id=NEW.id AND v.confirmed_at=NEW.confirmed_at AND v.admin_identifier=NEW.confirmed_by AND v.payment_method=NEW.payment_method)
 THEN RAISE(ABORT,'Durable verification required') END;
 SELECT CASE WHEN NEW.status='COMPLETED' AND NOT EXISTS(SELECT 1 FROM payment_case_verifications v JOIN payments p ON p.payment_request_code=v.internal_request_code WHERE v.case_id=NEW.id AND p.id=NEW.payment_id AND p.transaction_reference=v.transaction_reference AND p.payment_at=v.payment_at AND p.confirmed_at=v.confirmed_at AND p.confirmed_by=v.admin_identifier)
 THEN RAISE(ABORT,'Verified payment link required') END;
END`,
// Reserve verified references against concurrent legacy confirmation too. Unreserved
// legacy payments retain their existing behavior and duplicate-reference rules.
...['INSERT','UPDATE'].map(op=>`CREATE TRIGGER payment_case_reserved_reference_${op.toLowerCase()} BEFORE ${op} ON payments WHEN NEW.status='CONFIRMED' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_verifications v JOIN payment_cases c ON c.id=v.case_id
 WHERE (v.payment_method=NEW.payment_method AND v.transaction_reference=NEW.transaction_reference OR v.internal_request_code=NEW.payment_request_code)
 AND (NEW.payment_request_code IS NOT v.internal_request_code OR NEW.telegram_user_id IS NOT c.telegram_user_id OR NEW.plan IS NOT c.plan OR NEW.plan_days IS NOT c.plan_days OR NEW.amount_mmk IS NOT c.amount_mmk OR NEW.payment_method IS NOT v.payment_method OR NEW.transaction_reference IS NOT v.transaction_reference OR NEW.payment_at IS NOT v.payment_at OR NEW.confirmed_at IS NOT v.confirmed_at OR NEW.confirmed_by IS NOT v.admin_identifier))
 THEN RAISE(ABORT,'Transaction reference is reserved') END;
END`)
];
const normalize = sql => sql?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentCaseAdapter(db) {
 if(db.inTransaction) throw new Error('Adapter migration requires its own transaction.');
 db.pragma('foreign_keys = ON');
 if(db.pragma('foreign_keys',{simple:true})!==1) throw new Error('Foreign keys are required.');
 db.transaction(()=>{
  for(const name of ['payment_cases','payment_case_submissions','payments','premium_membership_effects']) {
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('Payment Case foundation required.');
  }
  const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_verifications'").get();
  if(!existing && db.prepare("SELECT 1 FROM payment_cases WHERE status IN ('CONFIRMED','COMPLETED')").get()) throw new Error('Existing case confirmations need manual review; verification cannot be invented.');
  for(const sql of objects) {
   const name=sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)[1];
   const old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);
   if(old && normalize(old.sql)!==normalize(sql)) throw new Error('Unexpected adapter schema; manual review required.');
   if(!old) db.exec(sql);
  }
  if(db.prepare('PRAGMA foreign_key_check(payment_case_verifications)').all().length) throw new Error('Invalid verification relationships.');
 }).immediate();
}
