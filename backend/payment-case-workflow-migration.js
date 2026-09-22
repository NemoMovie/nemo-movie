// Explicit isolated connection only. No startup hook, environment, or DB opening.
import { objects as cases } from './payment-case-migration.js';
import { objects as adapter } from './payment-case-adapter-migration.js';
import { schema as admin } from './payment-case-admin-migration.js';
import { schema as conversation } from './payment-case-conversation-migration.js';
const name=sql=>sql.match(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX|TRIGGER|VIEW) (\w+)/)[1];
const norm=sql=>sql?.replace(/"(payment_cases|payment_case_verifications)"/g,'$1').replace(/\s+/g,' ').trim().replace(/;$/,'');
const legacy=[...cases,...adapter,...admin,...conversation];
export const targets=legacy.map(sql=>{
 switch(name(sql)){
 case 'payment_cases': return sql.replace("'COMPLETED','REJECTED'))", "'COMPLETED','REJECTED','CANCELLED','EXPIRED'))");
 case 'payment_cases_update': return sql.replace("OLD.status IN ('COMPLETED','REJECTED')","OLD.status IN ('COMPLETED','REJECTED','CANCELLED','EXPIRED')")
  .replace("('WAITING_VERIFICATION','REJECTED'))", "('WAITING_VERIFICATION','CANCELLED','EXPIRED'))")
  .replace("NEW.status IN ('NEEDS_CUSTOMER_ACTION','CONFIRMED','REJECTED')", "NEW.status IN ('CONFIRMED','REJECTED')")
  .replace("SELECT CASE WHEN NOT (NEW.status=OLD.status OR", "SELECT CASE WHEN NEW.status='EXPIRED' AND (OLD.status<>'WAITING_PAYMENT' OR NOT COALESCE(NEW.updated_at>=strftime('%Y-%m-%dT%H:%M:%fZ',OLD.created_at,'+1 day'),0)) THEN RAISE(ABORT,'Case has not expired') END;\n SELECT CASE WHEN NOT (NEW.status=OLD.status OR");
 case 'payment_case_verifications': return sql.replace("transaction_reference TEXT NOT NULL CHECK(","transaction_reference TEXT CHECK(transaction_reference IS NULL OR (").replace("BETWEEN 5 AND 150),","BETWEEN 5 AND 150)),");
 case 'payment_cases_verified_transition': return sql.replace('p.transaction_reference=v.transaction_reference','p.transaction_reference IS v.transaction_reference');
 case 'payment_case_messages_insert': return sql.replace("status NOT IN ('COMPLETED','REJECTED')", "status NOT IN ('COMPLETED','REJECTED','CANCELLED','EXPIRED')");
 case 'payment_case_admin_actions_insert': return sql.replace('SELECT CASE WHEN EXISTS', "SELECT CASE WHEN NEW.action='NEEDS_CUSTOMER_ACTION' OR NEW.reason_category='CUSTOMER_CANCELLED' THEN RAISE(ABORT,'Retired workflow action') END;\n SELECT CASE WHEN EXISTS");
 default:return sql;
 }
});
const unique="CREATE UNIQUE INDEX payment_cases_one_open ON payment_cases(telegram_user_id) WHERE status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED')";
export function migratePaymentCaseWorkflow(db){
 if(db.inTransaction)throw new Error('Workflow migration requires its own transaction.');
 const current=new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(r=>[r.name,r.sql]));
 if(current.has('payment_cases_one_open')){
  for(const sql of [...targets,unique])if(norm(current.get(name(sql)))!==norm(sql))throw new Error('Unexpected workflow schema; manual review required.');
  if(db.pragma('foreign_key_check').length)throw new Error('Invalid relationships.');return;
 }
 for(const sql of legacy)if(norm(current.get(name(sql)))!==norm(sql))throw new Error('Expected legacy case schema; manual review required.');
 const names=new Set(legacy.map(name));
 for(const r of db.prepare("SELECT name,tbl_name FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger')").all())if(['payment_cases','payment_case_verifications'].includes(r.tbl_name)&&!names.has(r.name))throw new Error('Unexpected case dependency; manual review required.');
 if(db.prepare("SELECT telegram_user_id FROM payment_cases WHERE status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED','NEEDS_CUSTOMER_ACTION') GROUP BY telegram_user_id HAVING count(*)>1").get())throw new Error('Conflicting open cases require manual review.');
 const foreignKeys=db.pragma('foreign_keys',{simple:true});
 // Standard SQLite table rebuild: disable FKs before the transaction, validate
 // all references before commit, and restore the connection setting on all paths.
 db.pragma('foreign_keys = OFF');
 try{db.transaction(()=>{
  const dependent=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('trigger','view')").all();
  for(const r of dependent)db.exec(`DROP ${r.type} "${r.name.replaceAll('"','""')}"`);
  for(const table of ['payment_cases','payment_case_verifications']){
   const sequence=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
   const sql=targets.find(sql=>name(sql)===table);
   if(current.has(table+'_workflow'))throw new Error('Migration staging name unavailable.');
   db.exec(sql.replace('CREATE TABLE '+table+' (','CREATE TABLE '+table+'_workflow ('));
   db.exec(`INSERT INTO ${table}_workflow SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_workflow RENAME TO ${table};`);
   if(sequence!==undefined)db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(sequence,table);
  }
  for(const sql of targets.filter(sql=>sql.startsWith('CREATE INDEX')&&sql.includes(' ON payment_cases(')))db.exec(sql);
  for(const r of dependent)db.exec(targets.find(sql=>name(sql)===r.name)??r.sql);
  db.exec(unique);
  if(db.pragma('foreign_key_check').length)throw new Error('Invalid workflow relationships.');
 }).immediate();}finally{db.pragma('foreign_keys = '+foreignKeys);}
}
