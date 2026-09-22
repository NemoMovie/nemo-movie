import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { createPaymentBotIntake } from './payment-bot-intake.js';
import { createPremiumService } from './premium-service.js';
import { createRuntime } from '../payment-bot/runtime.js';
import { createTelegramTransport } from '../payment-bot/telegram-transport.js';
import { messages } from '../payment-bot/flow.js';

test('real adapter/runtime with intercepted HTTP preserves persisted Stage 2 workflow and replay receipts',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
 for(const migrate of [migratePremium,migratePremiumLedgerV3,migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation,migratePaymentCaseWorkflow,migratePaymentBotIntake])migrate(db);
 const clock=()=>Date.parse('2026-01-01T00:00:00.000Z'),premium=createPremiumService(db,{clock});
 const intake=()=>createPaymentBotIntake(db,{clock});
 const api=async(p,b)=>{if(b)assert.equal(b.telegram_user_id,101);if(p==='/users')return premium.upsertUser(b);if(p==='/flow/state')return intake().state(b);if(p.startsWith('/flow/'))return intake().act(p.slice(6),b);if(p==='/plans')return {plans:[{plan:'MONTH_1',amount_mmk:2000}]};return {plan:'MONTH_1',amount_mmk:2000,methods:['KBZPAY','AYA_PAY']};};
 let pending=[],seq=0;const sent=[],acks=[];
 const telegram=createTelegramTransport({token:randomBytes(24).toString('hex'),fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);let result;
  if(url.endsWith('/getUpdates')){result=pending.filter(u=>u.update_id>=body.offset);pending=[];}
  else if(url.endsWith('/answerCallbackQuery')){acks.push(body.callback_query_id);result=true;}
  else {assert(url.endsWith('/sendMessage'));sent.push(body);result={message_id:sent.length};}
  return {ok:true,status:200,json:async()=>({ok:true,result})};
 }});
 let runtime=createRuntime({api,telegram});
 const msg=extra=>({message:{chat:{id:101,type:'private'},from:{id:101},message_id:++seq,date:clock()/1000,...extra}});
 const cb=data=>({callback_query:{id:'synthetic-'+ ++seq,from:{id:101},message:{chat:{id:101,type:'private'}},data}});
 const run=async update=>{pending=[{update_id:++seq,...update}];await runtime.processUpdates();};
 const state=()=>intake().state({telegram_user_id:101}).case;
 await run(msg({text:'/start upgrade'}));assert.equal(sent.at(-1).text,messages.plans);
 await run(cb('plan:MONTH_1:0'));assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,0);
 await run(cb('method:MONTH_1:KBZPAY:0:999'));assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,0);
 const select=cb('method:MONTH_1:KBZPAY:0');await run(select);await run(select);assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,1);
 await run(cb('cancel:'+state().id));assert.equal(state().status,'CANCELLED');
 await run(cb('premium_reselect'));assert.equal(sent.at(-1).text,messages.plans);
 await run(cb('method:MONTH_1:AYA_PAY:'+state().id));assert.equal(state().status,'WAITING_PAYMENT');
 await run(msg({photo:[{file_id:'synthetic-proof-a',file_unique_id:'synthetic-unique-a'}]}));assert.equal(state().step,'WAITING_LAST_FOUR');
 const replacement=msg({photo:[{file_id:'synthetic-proof-b',file_unique_id:'synthetic-unique-b'}]});await run(replacement);
 runtime=createRuntime({api,telegram});await run(replacement); // Restart replay: SQLite receipts, no bot memory.
 assert.equal(db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,2);
 assert.equal(db.prepare('SELECT latest_proof_submission_id FROM payment_cases_latest ORDER BY id DESC').get().latest_proof_submission_id,2);
 await run(msg({text:'１２３４'}));assert.equal(sent.at(-1).text,messages.invalid);assert.equal(state().status,'WAITING_PAYMENT');
 const digits=msg({text:'0007'});await run(digits);await run(digits);assert.equal(state().status,'WAITING_VERIFICATION');
 assert.equal(db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,3);
 assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,0);
 assert(acks.length>=6);assert(sent.every(s=>s.chat_id===101));assert(sent.every(s=>!s.text.includes('synthetic-proof')));
});
