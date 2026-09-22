// Explicit connection only. No configuration, database opening, or startup hook.
const iso=c=>`COALESCE(typeof(${c})='text' AND length(${c})=24 AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND strftime('%Y-%m-%dT%H:%M:%fZ',${c},'+0 seconds')=${c},0)`;
const file=c=>`${c} IS NULL OR (typeof(${c})='text' AND length(${c}) BETWEEN 1 AND 512 AND ${c} NOT GLOB '*[^A-Za-z0-9_-]*')`;
export const schema=[
`CREATE TABLE payment_case_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 payment_case_id INTEGER NOT NULL REFERENCES payment_cases(id) ON DELETE RESTRICT,
 telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
 sender_type TEXT NOT NULL CHECK(sender_type IN ('CUSTOMER','ADMIN','SYSTEM')),
 message_type TEXT NOT NULL CHECK(typeof(message_type)='text' AND length(message_type) BETWEEN 1 AND 32),
 text_content TEXT CHECK(text_content IS NULL OR (typeof(text_content)='text' AND length(trim(text_content)) BETWEEN 1 AND 4096)),
 telegram_chat_id TEXT CHECK(telegram_chat_id IS NULL OR (typeof(telegram_chat_id)='text' AND CAST(CAST(telegram_chat_id AS INTEGER) AS TEXT)=telegram_chat_id AND CAST(telegram_chat_id AS INTEGER) BETWEEN -9007199254740991 AND 9007199254740991 AND CAST(telegram_chat_id AS INTEGER)<>0)),
 telegram_message_id INTEGER CHECK(telegram_message_id IS NULL OR (typeof(telegram_message_id)='integer' AND telegram_message_id BETWEEN 1 AND 9007199254740991)),
 telegram_file_id TEXT CHECK(${file('telegram_file_id')}),
 telegram_file_unique_id TEXT CHECK(${file('telegram_file_unique_id')}),
 admin_identifier TEXT CHECK(admin_identifier IS NULL OR (typeof(admin_identifier)='text' AND length(trim(admin_identifier)) BETWEEN 1 AND 150)),
 initial_delivery_state TEXT NOT NULL CHECK(initial_delivery_state IN ('PENDING_SEND','NOT_APPLICABLE')),
 created_at TEXT NOT NULL CHECK(${iso('created_at')}),
 CHECK((telegram_chat_id IS NULL)=(telegram_message_id IS NULL)),
 CHECK((sender_type='ADMIN' AND admin_identifier IS NOT NULL AND initial_delivery_state='PENDING_SEND') OR (sender_type<>'ADMIN' AND admin_identifier IS NULL AND initial_delivery_state='NOT_APPLICABLE')),
 UNIQUE(telegram_chat_id,telegram_message_id)
)`,
`CREATE INDEX payment_case_messages_order ON payment_case_messages(payment_case_id,created_at,id)`,
`CREATE TABLE payment_case_message_evidence (
 message_id INTEGER PRIMARY KEY REFERENCES payment_case_messages(id) ON DELETE RESTRICT,
 evidence_id INTEGER UNIQUE NOT NULL REFERENCES payment_case_submissions(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL CHECK(${iso('created_at')})
)`,
`CREATE TRIGGER payment_case_messages_insert BEFORE INSERT ON payment_case_messages BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_messages WHERE id=NEW.id OR (telegram_chat_id=NEW.telegram_chat_id AND telegram_message_id=NEW.telegram_message_id))
 OR NOT EXISTS(SELECT 1 FROM payment_cases WHERE id=NEW.payment_case_id AND telegram_user_id=NEW.telegram_user_id AND created_at<=NEW.created_at AND (NEW.sender_type='SYSTEM' OR status NOT IN ('COMPLETED','REJECTED')))
 OR EXISTS(SELECT 1 FROM payment_case_messages WHERE payment_case_id=NEW.payment_case_id AND created_at>NEW.created_at)
 THEN RAISE(ABORT,'Conversation append refused') END;
 -- Type whitelist/shape lives in a replaceable trigger so future reviewed types
 -- can be added without rebuilding the historical message table.
 SELECT CASE WHEN NOT COALESCE(
 (NEW.message_type='TEXT' AND NEW.sender_type IN ('CUSTOMER','ADMIN') AND NEW.text_content IS NOT NULL AND NEW.telegram_file_id IS NULL AND NEW.telegram_file_unique_id IS NULL)
 OR (NEW.message_type='PHOTO' AND NEW.sender_type='CUSTOMER' AND NEW.telegram_file_id IS NOT NULL)
 OR (NEW.message_type='SYSTEM' AND NEW.sender_type='SYSTEM' AND NEW.text_content IS NOT NULL AND NEW.telegram_file_id IS NULL AND NEW.telegram_file_unique_id IS NULL),0)
 OR (NEW.sender_type='CUSTOMER' AND NEW.telegram_chat_id IS NULL)
 OR (NEW.sender_type<>'CUSTOMER' AND NEW.telegram_chat_id IS NOT NULL)
 THEN RAISE(ABORT,'Invalid conversation message') END;
END`,
`CREATE TRIGGER payment_case_message_evidence_insert BEFORE INSERT ON payment_case_message_evidence BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_case_message_evidence WHERE message_id=NEW.message_id OR evidence_id=NEW.evidence_id)
 OR NOT EXISTS(SELECT 1 FROM payment_case_messages m JOIN payment_case_submissions e ON e.case_id=m.payment_case_id
 WHERE m.id=NEW.message_id AND e.id=NEW.evidence_id AND m.sender_type='CUSTOMER' AND m.message_type='PHOTO'
 AND m.telegram_file_id=e.proof_file_id AND (e.proof_file_unique_id IS NULL OR m.telegram_file_unique_id=e.proof_file_unique_id)
 AND (e.proof_chat_id IS NULL OR (m.telegram_chat_id=e.proof_chat_id AND m.telegram_message_id=e.proof_message_id))
 AND NEW.created_at>=m.created_at AND NEW.created_at>=e.created_at)
 THEN RAISE(ABORT,'Evidence relationship refused') END;
END`,
...['payment_case_messages','payment_case_message_evidence'].flatMap(table=>['UPDATE','DELETE'].map(op=>`CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Conversation history is immutable'); END`))
];
const normalize=sql=>sql?.replace(/\s+/g,' ').trim().replace(/;$/,'');
export function migratePaymentCaseConversation(db){
 if(db.inTransaction)throw new Error('Conversation migration requires its own transaction.');
 db.pragma('foreign_keys = ON');if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Foreign keys required.');
 db.transaction(()=>{
  for(const name of ['payment_cases','payment_case_submissions','telegram_users'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Payment Case foundation required.');
  for(const sql of schema){const name=sql.match(/^CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/)[1];const old=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);if(old&&normalize(old.sql)!==normalize(sql))throw new Error('Unexpected conversation schema; manual review required.');if(!old)db.exec(sql);}
  for(const table of ['payment_case_messages','payment_case_message_evidence'])if(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length)throw new Error('Invalid conversation relationship.');
 }).immediate();
}
