const test=require('node:test'),assert=require('node:assert/strict');
const {createFlow}=require('./flow');const {createClient}=require('./client');
const user={id:101,first_name:'Fake'},message={chat:{id:101,type:'private'},from:user,text:'/start upgrade'};
function fixture(status='NON_PREMIUM'){
 const calls=[],sent=[];const flow=createFlow({send:async(...args)=>sent.push(args),api:async(path,body)=>{calls.push({path,body});if(path==='/flow/state')return {membership:{status,expires_at:'2030-01-01'},case:null};if(path==='/plans')return {plans:['MONTH_1','MONTH_3','MONTH_6','YEAR_1'].map(plan=>({plan,label:plan,amount_mmk:2000}))};if(path.startsWith('/plans/'))return {plan:'MONTH_1',label:'1 Month',methods:['KBZPAY','WAVE_MONEY','AYA_PAY']};if(path==='/cases')return {label:'1 Month',amount_mmk:2000,payment_method:'KBZPAY'};return {};}});return {flow,calls,sent};
}
test('start takes update identity, four plans, active/expired plans without a case',async()=>{
 for(const status of ['NON_PREMIUM','EXPIRED','ACTIVE']){const f=fixture(status);await f.flow.handle({message});assert.equal(f.calls[0].body.telegram_user_id,101);assert(!f.calls.some(c=>c.path==='/cases'));assert.equal(f.sent[0][2].inline_keyboard.length,4);}
 const f=fixture();await f.flow.handle({message:{...message,text:'/start upgrade_999'}});assert.equal(f.calls.length,0);
 await f.flow.handle({message:{...message,chat:{id:-1,type:'group'}}});assert.equal(f.calls.length,0);
});
test('client secret only in header, bounded transport and no redirects',async()=>{
 const calls=[];const api=createClient({baseUrl:'http://127.0.0.1:3101',secret:'synthetic',fetchImpl:async(...args)=>{calls.push(args);return {ok:true,json:async()=>({})};}});await api('/users',{telegram_user_id:101});assert(!calls[0][0].includes('synthetic'));assert.equal(calls[0][1].headers.Authorization,'Bearer synthetic');assert.equal(calls[0][1].redirect,'error');await assert.rejects(api('/../../public'));
 assert.throws(()=>createClient({baseUrl:'http://public.invalid',secret:'synthetic'}));assert.throws(()=>createClient({baseUrl:'https://example.invalid',secret:''}));
});

test('entry point import starts nothing; rejected backend call stays generic',async()=>{
 assert.equal(typeof require('./bot').start,'function');
 const sent=[];const flow=createFlow({api:async()=>{throw new Error('SENSITIVE-TRANSPORT-DATA');},send:async(...args)=>sent.push(args)});
 await flow.handle({message});assert.equal(sent.length,1);assert.doesNotMatch(sent[0][1],/SENSITIVE/);
});
