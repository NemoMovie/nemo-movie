import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
 constructor(){this.children=[];this.events={};this.value='';this.hidden=false;this.disabled=false;this.attrs={};this.classList={add(){},toggle(){}};}
 set textContent(v){this.text=String(v);this.children=[];} get textContent(){return (this.text??'')+this.children.map(c=>c.textContent).join('');}
 set innerHTML(v){throw new Error('Unsafe HTML rendering');}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.text='';this.children=nodes;}
 setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.events[k]=fn;}showModal(){this.open=true;}close(){this.open=false;}
}
const record=(id=1,status='WAITING_VERIFICATION')=>({id,status,telegram_user_id:101,username:'fake',first_name:'<img src=x onerror=alert(1)>',plan:'MONTH_1',plan_days:30,amount_mmk:2000,payment_method:'KBZPAY',transaction_last_four:'1234',created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',evidence:[{id:1,has_proof:true,transaction_last_four:'1234'}],actions:[],internal_request_code:'NM-ABCDEF',proof_file_id:'DO-NOT-RENDER'});
function fixture({conversation=false}={}){
 const elements={};const get=id=>elements[id]??=new Element();get('caseSort').value='newest';const pending=[];
 const context=vm.createContext({URLSearchParams,API_URL:'',document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},window:{location:{href:''},addEventListener(){}},
 fetch:(url,options)=>!conversation&&url.includes('/messages?')?Promise.resolve({status:200,ok:true,json:async()=>({messages:[],next_after_id:null})}):new Promise(resolve=>pending.push({url,options,resolve}))});
 vm.runInContext(fs.readFileSync(new URL('../frontend/customer-service.js',import.meta.url),'utf8').replace('import { API_URL } from "./config.js";',''),context);
 const run=code=>vm.runInContext(code,context);run('authenticated=true');
 const reply=(index,data,status=200)=>pending[index].resolve({status,ok:status>=200&&status<300,json:async()=>data});
 const setCase=c=>{context.caseData=c;run('selected=caseData.id;render(caseData)');};
 return {get,pending,run,reply,setCase,context};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('queue filters/pagination and stale queue responses',async()=>{
 const f=fixture();f.run('page=2;loadQueue()');assert.match(f.pending[0].url,/page=2&limit=24/);assert.equal(f.pending[0].options.credentials,'include');
 f.get('caseSearch').value='fake';f.get('caseStatus').value='CONFIRMED';f.run('page=1;loadQueue()');
 assert.match(f.pending[1].url,/search=fake.*status=CONFIRMED/);f.reply(1,{cases:[record(2,'CONFIRMED')],total:1});await tick();f.reply(0,{cases:[record()],total:30});await tick();
 assert.match(f.get('caseQueue').textContent,/Case 2/);assert.doesNotMatch(f.get('caseQueue').textContent,/Case 1/);
});
test('selected case stale protection, safe text and explicit-field rendering',async()=>{
 const f=fixture();f.run('loadDetail(1)');f.run('loadDetail(2)');f.reply(1,record(2));await tick();f.reply(0,record());await tick();
 assert.equal(f.run('current.id'),2);assert.match(f.get('caseSummary').textContent,/<img src=x/);assert.doesNotMatch(f.get('caseSummary').textContent,/NM-ABCDEF|DO-NOT-RENDER/);assert.match(f.get('caseEvidence').textContent,/View Screenshot/);
});
test('actions by state, completed versus confirmed outcome',()=>{
 const f=fixture();for(const [state,count] of [['WAITING_PAYMENT',0],['WAITING_VERIFICATION',2],['NEEDS_CUSTOMER_ACTION',0],['CANCELLED',0],['EXPIRED',0],['CONFIRMED',1],['COMPLETED',0],['REJECTED',0]]){f.setCase(record(1,state));assert.equal(f.get('caseActions').children.length,count);}
 f.setCase(record(1,'CONFIRMED'));assert.match(f.get('caseOutcome').textContent,/activation did not complete/);f.setCase(record(1,'COMPLETED'));assert.match(f.get('caseOutcome').textContent,/succeeded/);
});

test('OTHER rejection and immutable action history render hostile markup as text',()=>{
 const f=fixture(),hostile='<img src=x onerror=alert(1)> <script>synthetic</script>';
 f.setCase({...record(1,'REJECTED'),rejection_reason:hostile,actions:[{action:'REJECT',reason_category:'OTHER',message:hostile,admin_identifier:'Synthetic',created_at:'2026-01-01T00:00:00.000Z'}]});
 assert(f.get('caseOutcome').textContent.includes(hostile));assert(f.get('caseTimeline').textContent.includes(hostile));
 // The fixture throws on any innerHTML assignment, including history rendering.
});
test('required message, rejection category/explanation and payment time; no accidental POST',async()=>{
 const f=fixture();f.setCase(record());
 for(const action of ['needs-customer-action','reject','confirm']){f.run(`openAction('${action}')`);await f.run('submitAction({preventDefault(){}})');assert.equal(f.pending.length,0);}
 f.run("openAction('reject')");f.get('adminMessage').value='A reason';await f.run('submitAction({preventDefault(){}})');assert.equal(f.pending.length,0);
});
test('one POST only, MMT payload, refetch and activation pending even after HTTP 200',async()=>{
 const f=fixture();f.setCase(record());f.run("openAction('confirm')");f.get('paymentTime').value='2026-01-01T06:30';
 f.run('submitAction({preventDefault(){}})');f.run('submitAction({preventDefault(){}})');assert.equal(f.pending.length,1);assert.equal(f.get('submitAction').disabled,true);
 assert.equal(JSON.parse(f.pending[0].options.body).payment_at,'2026-01-01T00:00:00.000Z');assert.equal(JSON.parse(f.pending[0].options.body).transaction_reference,undefined);
 f.reply(0,record(1,'CONFIRMED'));await tick();assert.equal(f.pending[1].url,'/api/admin/premium/cases/1');f.reply(1,record(1,'CONFIRMED'));await tick();assert.match(f.get('caseOutcome').textContent,/activation did not complete/);f.reply(2,{cases:[],total:0});await tick();
});
test('retry has empty payload; manual reconciliation shown without repair',async()=>{
 const f=fixture();f.setCase(record(1,'CONFIRMED'));f.run("openAction('retry-activation');submitAction({preventDefault(){}})");assert.equal(f.pending[0].options.body,'{}');
 f.reply(0,{...record(1,'CONFIRMED'),completion_error:'MANUAL_RECONCILIATION_REQUIRED'});await tick();f.reply(1,record(1,'CONFIRMED'));await tick();assert.match(f.get('caseOutcome').textContent,/Manual reconciliation/);f.reply(2,{cases:[],total:0});await tick();assert.equal(f.pending.filter(p=>p.options.method==='POST').length,1);
});
test('401 redirects and service errors do not invent case state',async()=>{
 for(const status of [401,403,409,422,503]){const f=fixture();f.run('loadDetail(1)');f.reply(0,{},status);await tick();assert.equal(f.run('current'),null);assert.equal(f.get('caseContent').hidden,true);if(status===401)assert.equal(f.context.window.location.href,'login.html');}
});

test('conversation plain-text rendering, photo placeholder, pending state and pagination',async()=>{
 const f=fixture({conversation:true});f.run('loadDetail(1)');f.reply(0,record());await tick();
 assert.equal(f.get('conversationMessage').textContent,'Loading conversation...');assert.match(f.pending[1].url,/\/1\/messages\?limit=50/);assert.equal(f.pending[1].options.credentials,'include');
 const base={payment_case_id:1,created_at:'2026-01-01T00:00:00.000Z'};
 f.reply(1,{messages:[{...base,sender_type:'CUSTOMER',message_type:'PHOTO',text_content:null},{...base,sender_type:'CUSTOMER',message_type:'TEXT',text_content:'<img src=x onerror=alert(1)>'},{...base,sender_type:'ADMIN',message_type:'TEXT',text_content:'Please wait',initial_delivery_state:'PENDING_SEND'},{...base,sender_type:'SYSTEM',message_type:'SYSTEM',text_content:'System note'}],next_after_id:4});await tick();
 const text=f.get('conversationList').textContent;for(const pattern of [/Customer/,/Admin/,/System/,/Payment screenshot/,/Screenshot unavailable/,/<img src=x/,/Pending delivery — not delivered/,/Please wait/])assert.match(text,pattern);
 assert.equal(f.get('conversationMore').hidden,false);f.run('loadConversation()');assert.match(f.pending[2].url,/after_id=4/);f.reply(2,{messages:[{...base,sender_type:'CUSTOMER',message_type:'TEXT',text_content:'Last page'}],next_after_id:null});await tick();assert.equal(f.get('conversationList').children.length,5);assert.equal(f.get('conversationMore').hidden,true);
});
test('conversation case switching discards stale response; errors independent and retry works',async()=>{
 const f=fixture({conversation:true});f.run('loadDetail(1)');f.reply(0,record());await tick();
 f.run('loadDetail(2)');f.reply(2,record(2));await tick();f.reply(3,{},503);await tick();
 assert.equal(f.get('caseContent').hidden,false);assert.equal(f.run('current.id'),2);assert.equal(f.get('conversationMessage').textContent,'Unable to load conversation.');
 f.reply(1,{messages:[{payment_case_id:1,sender_type:'CUSTOMER',message_type:'TEXT',text_content:'STALE'}],next_after_id:null});await tick();assert.doesNotMatch(f.get('conversationList').textContent,/STALE/);
 f.run('loadConversation()');f.reply(4,{messages:[],next_after_id:null});await tick();assert.equal(f.get('conversationMessage').textContent,'No conversation messages yet.');assert.equal(f.get('conversationRetry').hidden,true);
 f.run('loadDetail(2)');assert.equal(f.get('conversationList').children.length,0);assert.equal(f.get('caseContent').hidden,true);
});

test('delivery labels use durable state; sent/failed are not shown as pending',async()=>{
 const f=fixture({conversation:true});f.run('loadDetail(1)');f.reply(0,record());await tick();
 const base={payment_case_id:1,created_at:'2026-01-01T00:00:00.000Z',sender_type:'ADMIN',message_type:'TEXT',initial_delivery_state:'PENDING_SEND'};
 f.reply(1,{messages:[{...base,id:1,text_content:'Sent text',delivery_state:'SENT'},{...base,id:2,text_content:'Failed text',delivery_state:'FAILED'},{...base,id:3,sender_type:'SYSTEM',message_type:'SYSTEM',text_content:'Pending system',delivery_state:'PENDING_SEND'}],next_after_id:null});await tick();
 const rows=f.get('conversationList').children;assert.match(rows[0].textContent,/Sent/);assert.doesNotMatch(rows[0].textContent,/Pending delivery/);assert.match(rows[1].textContent,/Failed — delivery unsuccessful/);assert.doesNotMatch(rows[1].textContent,/Pending delivery/);assert.match(rows[2].textContent,/Pending delivery/);
});
test('Admin composer persists only once during click burst and never changes case state',async()=>{
 const f=fixture();f.setCase(record());f.get('conversationText').value='<img src=x onerror=alert(1)>';f.run('queueConversation({preventDefault(){}})');f.run('queueConversation({preventDefault(){}})');assert.equal(f.pending.length,1);assert.equal(f.pending[0].url,'/api/admin/premium/cases/1/messages');assert.equal(f.pending[0].options.credentials,'include');assert.deepEqual(JSON.parse(f.pending[0].options.body),{text:'<img src=x onerror=alert(1)>'});f.reply(0,{delivery_state:'PENDING_SEND'});await tick();assert.equal(f.run('current.status'),'WAITING_VERIFICATION');assert.equal(f.get('conversationText').value,'');assert.match(f.get('conversationSendStatus').textContent,/queued/);
 f.setCase(record(1,'COMPLETED'));f.get('conversationText').value='No';await f.run('queueConversation({preventDefault(){}})');assert.equal(f.pending.length,1);assert.equal(f.get('conversationSend').disabled,true);
});

test('screenshot links use only protected case/evidence IDs',()=>{
 const f=fixture();f.setCase(record());const link=f.get('caseEvidence').children[0].children[0];
 assert.equal(link.textContent,'View Screenshot');assert.equal(link.href,'/api/admin/premium/cases/1/evidence/1/preview');assert.equal(link.rel,'noopener noreferrer');
 assert.equal(f.run('screenshotLink(1,0).textContent'),'Screenshot unavailable');
});
