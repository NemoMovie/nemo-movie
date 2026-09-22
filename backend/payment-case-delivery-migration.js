// Explicit migration on a caller-owned connection; never opens a database.
const stamp=c=>`COALESCE(length(${c})=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',${c},'+0 seconds')=${c},0)`;
const objects=[
`CREATE TABLE payment_case_deliveries (
 message_id INTEGER PRIMARY KEY REFERENCES payment_case_messages(id),
 state TEXT NOT NULL DEFAULT 'PENDING_SEND' CHECK(state IN ('PENDING_SEND','SENT','FAILED')),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count>=0),
 lease_token TEXT CHECK(lease_token IS NULL OR (length(lease_token)=64 AND lease_token NOT GLOB '*[^a-f0-9]*')),
 lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR ${stamp('lease_expires_at')}),
 retry_at TEXT CHECK(retry_at IS NULL OR ${stamp('retry_at')}),
 attempted_at TEXT CHECK(attempted_at IS NULL OR ${stamp('attempted_at')}),
 sent_at TEXT CHECK(sent_at IS NULL OR ${stamp('sent_at')}),
 error_category TEXT CHECK(error_category IS NULL OR error_category IN ('TRANSPORT_FAILED','LEASE_EXPIRED')),
 CHECK(lease_expires_at IS NULL OR lease_token IS NOT NULL), CHECK(state<>'SENT' OR lease_expires_at IS NULL)
)`,
`CREATE TRIGGER payment_case_deliveries_insert BEFORE INSERT ON payment_case_deliveries BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_deliveries WHERE message_id=NEW.message_id)
 OR NOT EXISTS(SELECT 1 FROM payment_case_messages m WHERE m.id=NEW.message_id AND ((m.sender_type='ADMIN' AND m.initial_delivery_state='PENDING_SEND') OR EXISTS(SELECT 1 FROM payment_case_notifications n WHERE n.message_id=m.id)))
 THEN RAISE(ABORT,'Invalid outbound message') END;
END`,
`CREATE TRIGGER payment_case_deliveries_update BEFORE UPDATE ON payment_case_deliveries BEGIN
 SELECT CASE WHEN OLD.state='SENT' OR NEW.message_id IS NOT OLD.message_id OR NEW.attempt_count<OLD.attempt_count THEN RAISE(ABORT,'Delivery is terminal or immutable') END;
END`,
`CREATE TRIGGER payment_case_deliveries_delete BEFORE DELETE ON payment_case_deliveries BEGIN SELECT RAISE(ABORT,'Delivery history cannot be deleted'); END`,
`CREATE TRIGGER payment_case_deliveries_admin AFTER INSERT ON payment_case_messages WHEN NEW.sender_type='ADMIN' AND NEW.initial_delivery_state='PENDING_SEND' BEGIN
 INSERT INTO payment_case_deliveries(message_id) VALUES(NEW.id);
END`,
`CREATE TRIGGER payment_case_deliveries_notification AFTER INSERT ON payment_case_notifications BEGIN
 INSERT INTO payment_case_deliveries(message_id,state) VALUES(NEW.message_id,NEW.delivery_state);
END`,
`CREATE TRIGGER payment_case_deliveries_sync AFTER UPDATE OF state ON payment_case_deliveries WHEN NEW.state<>OLD.state BEGIN
 UPDATE payment_case_notifications SET delivery_state=NEW.state WHERE message_id=NEW.message_id AND delivery_state<>NEW.state;
END`,
`CREATE TRIGGER payment_case_notifications_delivery_guard BEFORE UPDATE OF delivery_state ON payment_case_notifications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payment_case_deliveries WHERE message_id=NEW.message_id AND state=NEW.delivery_state) THEN RAISE(ABORT,'Use durable delivery state') END;
END`
];
const normalize=s=>s?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentCaseDelivery(db){
 if(db.inTransaction)throw new Error('Delivery migration requires its own transaction');db.pragma('foreign_keys=ON');
 db.transaction(()=>{
  for(const name of ['payment_case_notifications','payment_case_messages','payment_case_activation_attempts'])if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))throw new Error('Stage 3 schema required');
  for(const sql of objects){const name=sql.match(/^CREATE (?:TABLE|TRIGGER) (\w+)/)[1],old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);if(old&&normalize(old.sql)!==normalize(sql))throw new Error('Unexpected delivery schema');if(!old)db.exec(sql);}
  db.exec(`INSERT INTO payment_case_deliveries(message_id,state)
   SELECT m.id,COALESCE(n.delivery_state,'PENDING_SEND') FROM payment_case_messages m LEFT JOIN payment_case_notifications n ON n.message_id=m.id
   WHERE (m.sender_type='ADMIN' AND m.initial_delivery_state='PENDING_SEND' OR n.message_id IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM payment_case_deliveries d WHERE d.message_id=m.id)`);
  if(db.pragma('foreign_key_check').length)throw new Error('Invalid delivery relationships');
 }).immediate();
}
