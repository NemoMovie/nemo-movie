import { createPaymentCaseDelivery } from './payment-case-delivery.js';
import { createPaymentBotIntake } from './payment-bot-intake.js';
import { timingSafeEqual } from 'node:crypto';
import { createPremiumService, PLANS, PremiumError, id } from './premium-service.js';
import { createPaymentCaseLifecycle } from './payment-case-lifecycle.js';
const methods=['KBZPAY','WAVE_MONEY','AYA_PAY'];
const labels={MONTH_1:'1 Month',MONTH_3:'3 Months',MONTH_6:'6 Months',YEAR_1:'1 Year'};
const fail=(message,status=400)=>{throw new PremiumError(message,status);};
function fields(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('Invalid request');}
function plan(value){if(typeof value!=='string'||!Object.hasOwn(PLANS,value))fail('Invalid plan');return {plan:value,label:labels[value],plan_days:PLANS[value][0],amount_mmk:PLANS[value][1]};}
export function createPaymentBotService(db){
 const premium=createPremiumService(db);
 const create=db.transaction(input=>{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_cases_one_open'").get())fail('Workflow migration required',503);
  createPaymentCaseLifecycle(db).expire();
  fields(input,['telegram_user_id','plan','payment_method']);const uid=id(input.telegram_user_id),p=plan(input.plan);
  if(!methods.includes(input.payment_method))fail('Invalid payment method');
  if(!db.prepare('SELECT 1 FROM telegram_users WHERE telegram_user_id=?').get(uid))fail('User not found',404);
  const open=db.prepare("SELECT * FROM payment_cases WHERE telegram_user_id=? AND status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED','NEEDS_CUSTOMER_ACTION') ORDER BY id").all(uid);
  if(open.length>1)fail('Existing cases require Admin review',409);
  let c=open[0];
  if(c&&(c.status!=='WAITING_PAYMENT'||c.plan!==p.plan||c.payment_method!==input.payment_method))fail('An existing payment case must be resolved first',409);
  if(c&&c.payment_account_reference!=='PAYMENT_ACCOUNT_NOT_CONFIGURED')fail('Existing case requires Admin review',409);
  if(!c){
   const at=new Date().toISOString();
   const result=db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(?,?,?,?,?,'PAYMENT_ACCOUNT_NOT_CONFIGURED',?,?)`).run(uid,p.plan,p.plan_days,p.amount_mmk,input.payment_method,at,at);
   c={id:Number(result.lastInsertRowid),status:'WAITING_PAYMENT'};
  }
  return {...p,payment_method:input.payment_method,status:c.status,payment_account:'PAYMENT_ACCOUNT_NOT_CONFIGURED',instructions_live:false};
 });
 return {
  identity(input){fields(input,['telegram_user_id','username','first_name','last_name']);const u=premium.upsertUser(input);return {telegram_user_id:u.telegram_user_id};},
  status:uid=>premium.status(id(uid)),
  plans:()=>({plans:Object.keys(PLANS).map(plan)}),
  plan:value=>({...plan(value),methods}),
  create:input=>create.immediate(input)
 };
}
export function registerPaymentBotRoutes(app,db,env=process.env){
 const root='/api/internal/payment-bot',service=createPaymentBotService(db);
 app.use(root,(req,res,next)=>{
  res.set('Cache-Control','no-store');const secret=env.PAYMENT_BOT_API_SECRET;
  if(typeof secret!=='string'||!secret.trim())return res.status(503).json({message:'Payment Bot access is unavailable'});
  const supplied=Buffer.from(req.get('Authorization')||''),expected=Buffer.from('Bearer '+secret);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({message:'Authentication required'});
  if(req.body!==undefined&&Buffer.byteLength(JSON.stringify(req.body))>(req.path==='/flow/message'?24576:4096))return res.status(413).json({message:'Request too large'});
  next();
 });
 const intake=createPaymentBotIntake(db);
 app.post(root+'/flow/state',(req,res,next)=>{try{res.json(intake.state(req.body));}catch(e){if(e instanceof PremiumError)res.status(e.status).json({message:e.message});else next(e);}});
 const wrap=fn=>(req,res,next)=>{try{res.json(fn(req));}catch(e){if(e instanceof PremiumError)res.status(e.status).json({message:e.message});else next(e);}};
 app.get(root+'/notifications',wrap(r=>{
  if(Object.keys(r.query).length)throw new PremiumError('Invalid query',400);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_notifications'").get())throw new PremiumError('Notifications unavailable',503);
  return {notifications:db.prepare("SELECT n.case_id,n.event,n.message_id,n.action,n.delivery_state,m.telegram_user_id,m.text_content FROM payment_case_notifications n JOIN payment_case_messages m ON m.id=n.message_id WHERE n.delivery_state IN ('PENDING_SEND','FAILED') ORDER BY m.id LIMIT 100").all().map(n=>({...n,action:n.action==='RESELECT'?{text:'🔄 ရွေးချယ်မှု ပြန်လည်ပြုလုပ်ပါ',callback_data:'plans:'+n.case_id}:null}))};
 }));
 const delivery=createPaymentCaseDelivery(db);
 app.post(root+'/deliveries/claim',wrap(r=>delivery.claim(r.body)));
 app.post(root+'/deliveries/:id/sent',wrap(r=>delivery.acknowledge(r.params.id,r.body,'SENT')));
 app.post(root+'/deliveries/:id/failed',wrap(r=>delivery.acknowledge(r.params.id,r.body,'FAILED')));
 app.post(root+'/users',wrap(r=>service.identity(r.body)));
 app.get(root+'/users/:id/status',wrap(r=>service.status(r.params.id)));
 app.get(root+'/plans',wrap(()=>service.plans()));
 app.get(root+'/plans/:plan',wrap(r=>service.plan(r.params.plan)));
 app.post(root+'/cases',wrap(r=>service.create(r.body)));
 for(const action of ['select','method','cancel','message'])app.post(root+'/flow/'+action,wrap(r=>intake.act(action,r.body)));
}
