'use strict';
const labels={MONTH_1:'1 လ',MONTH_3:'3 လ',MONTH_6:'6 လ',YEAR_1:'1 နှစ်'};
const methods={KBZPAY:'KBZPay',WAVE_MONEY:'Wave Money',AYA_PAY:'AYA Pay'};
const messages={
 plans:'⭐ Premium Plan\n\nမိမိဝယ်ယူလိုသော Premium Plan ကို အောက်တွင် ရွေးချယ်ပါ။',
 photo:'✅ ငွေလွှဲ Screenshot ကို လက်ခံရရှိပါပြီ။\n\nယခု Transaction / Reference Number ရဲ့\nနောက်ဆုံးဂဏန်း ၄ လုံးကို ရိုက်ထည့်ပေးပါ။\n\nဥပမာ — 1234',
 screenshot:'⚠️ ငွေလွှဲထားသော Screenshot ကို အရင်ပို့ပေးပါ။\n\nScreenshot ပို့ပြီးပါက\nTransaction / Reference Number ရဲ့\nနောက်ဆုံးဂဏန်း ၄ လုံးကို ရိုက်ထည့်ပေးရပါမည်။',
 invalid:'⚠️ Transaction / Reference Number ရဲ့\nနောက်ဆုံးဂဏန်း ၄ လုံးကိုသာ ရိုက်ထည့်ပေးပါ။\n\nဥပမာ — 1234',
 submitted:'✅ ငွေပေးချေမှု အချက်အလက်များကို လက်ခံရရှိပါပြီ။\n\nပေးပို့ထားသော ငွေလွှဲ Screenshot နှင့်\nTransaction / Reference Number ရဲ့ နောက်ဆုံးဂဏန်း ၄ လုံးကို\nစစ်ဆေးရန် ပေးပို့ထားပါသည်။\n\nငွေပေးချေမှုကို စစ်ဆေးအတည်ပြုပြီးသည်အထိ\nခဏစောင့်ပေးပါ။',
 review:'⏳ သင်၏ ငွေပေးချေမှုကို စစ်ဆေးနေပါသည်။\n\nလက်ရှိ ငွေပေးချေမှုကို စစ်ဆေးအတည်ပြုပြီးသည်အထိ\nငွေပေးချေမှုအသစ် ပြုလုပ်၍ မရသေးပါ။\n\nခဏစောင့်ပေးပါ။',
 confirmed:'⏳ သင်၏ ငွေပေးချေမှုကို အတည်ပြုပြီးပါပြီ။\n\nPremium Member အဖြစ် အသက်သွင်းပေးနေပါသည်။\n\nလက်ရှိလုပ်ငန်းစဉ် ပြီးဆုံးသည်အထိ\nငွေပေးချေမှုအသစ် ပြုလုပ်၍ မရသေးပါ။\n\nခဏစောင့်ပေးပါ။',
 cancelled:'ငွေပေးချေမှုကို ပယ်ဖျက်ပြီးပါပြီ။\n\nPremium Plan ဝယ်ယူလိုပါက\nပြန်လည်ရွေးချယ်နိုင်ပါသည်။',
 expired:'⌛ ငွေပေးချေမှုအတွက် သတ်မှတ်ထားသော အချိန် ကုန်ဆုံးသွားပါပြီ။\n\nPremium ဝယ်ယူလိုပါက\nရွေးချယ်မှုကို ပြန်လည်ပြုလုပ်နိုင်ပါသည်။',
 error:'⚠️ လုပ်ဆောင်မှု မအောင်မြင်ပါ။ /start ဖြင့် လက်ရှိအခြေအနေကို ပြန်စစ်ပါ။',
 development:'🧪 စမ်းသပ်မှုသာ ဖြစ်ပါသည်။ ငွေမလွှဲပါနှင့်။ အကောင့်အစစ် မသတ်မှတ်ရသေးပါ။ စမ်းသပ် Screenshot နှင့် အချက်အလက်များသာ အသုံးပြုပါ။'
};
const button=(text,callback_data)=>({text,callback_data});
const keyboard=rows=>({inline_keyboard:rows});
const amount=n=>n.toLocaleString('en-US');
function createFlow({api,send}){
 async function plans(chat,after){const p=await api('/plans');await send(chat,messages.plans,keyboard(p.plans.map(p=>[button(`⭐ ${labels[p.plan]} — ${amount(p.amount_mmk)} ကျပ်`,`plan:${p.plan}:${after}`)])));}
 async function methodMenu(chat,plan,caseId,after){const p=await api('/plans/'+encodeURIComponent(plan));await send(chat,`ရွေးချယ်ထားသော Premium Plan\n\n⭐ ${labels[p.plan]} — ${amount(p.amount_mmk)} ကျပ်\n\nငွေပေးချေမည့် နည်းလမ်းကို ရွေးချယ်ပါ။`,keyboard([...p.methods.map(m=>[button(methods[m],caseId?`change:${caseId}:${m}`:`method:${p.plan}:${m}:${after}`)]),...(!caseId?[[button('← Premium Plan ပြန်ရွေးရန်',`plans:${after}`)]]:[])]));}
 async function show(chat,c){
  const retry=keyboard([[button('🔄 ရွေးချယ်မှု ပြန်လည်ပြုလုပ်ပါ',`plans:${c.id}`)]]);
  if(c.status==='CANCELLED')return send(chat,messages.cancelled,retry);
  if(c.status==='EXPIRED')return send(chat,messages.expired,retry);
  if(c.status==='WAITING_VERIFICATION')return send(chat,messages.review);
  if(c.status==='CONFIRMED')return send(chat,messages.confirmed);
  if(c.status==='REJECTED')return send(chat,'ငွေပေးချေမှုကို ပယ်ချထားပါသည်။ ပြန်လည်ရွေးချယ်နိုင်ပါသည်။',retry);
  if(c.status==='COMPLETED')return send(chat,'Premium လုပ်ငန်းစဉ် ပြီးဆုံးပါပြီ။ /start ဖြင့် အခြေအနေကို စစ်ဆေးပါ။');
  if(c.status!=='WAITING_PAYMENT')return send(chat,messages.error);
  const rows=[...(c.can_change_method?[[button('← ငွေပေးချေမှုနည်းလမ်း ပြောင်းရန်',`methods:${c.id}`)]]:[]),[button('❌ ငွေပေးချေမှု ပယ်ဖျက်ရန်',`cancel:${c.id}`)]];
  if(c.step==='WAITING_LAST_FOUR')return send(chat,messages.photo,keyboard(rows));
  // Never render an instruction to transfer money to a development placeholder.
  return send(chat,`${messages.development}\n\n💳 ငွေပေးချေမှု အချက်အလက်\n\nPremium Plan: ${labels[c.plan]}\nကျသင့်ငွေ: ${amount(c.amount_mmk)} ကျပ်\nငွေပေးချေမှု: ${methods[c.payment_method]}\n\n${methods[c.payment_method]} အကောင့်:\n${c.payment_account}\n\nအကောင့်အမည်:\n${c.payment_account_name}\n\nစမ်းသပ် Screenshot ကို ဒီ Chat ထဲသို့ ပို့ပေးပါ။\nထို့နောက် Transaction / Reference Number ရဲ့ နောက်ဆုံးဂဏန်း ၄ လုံးကို ရိုက်ထည့်ပေးပါ။\n\n⚠️ ယခုငွေပေးချေမှု မပြီးဆုံးသေးခင်\nနောက်ထပ်ငွေပေးချေမှုအသစ် မပြုလုပ်ပါနှင့်။`,keyboard(rows));
 }
 async function handle(update){
  const callback=update.callback_query,msg=callback?.message||update.message,from=callback?.from||msg?.from;
  if(msg?.chat?.type!=='private'||!Number.isSafeInteger(from?.id)||from.id<=0||msg.chat.id!==from.id||from.is_bot)return;
  const chat=from.id,start=!callback&&/^\/start(?:\s+upgrade)?\s*$/.test(msg.text||'');
  try{
   if(!callback&&msg.text?.startsWith('/')&&!start)return await send(chat,messages.error);
   await api('/users',{telegram_user_id:from.id,username:from.username??null,first_name:from.first_name??null,last_name:from.last_name??null});
   const state=await api('/flow/state',{telegram_user_id:from.id}),c=state.case;
   if(!['NON_PREMIUM','EXPIRED','ACTIVE'].includes(state.membership.status))throw new Error('Invalid status');
   if(!callback&&!start&&c&&['WAITING_PAYMENT','WAITING_VERIFICATION'].includes(c.status)){
    const photo=Array.isArray(msg.photo)?msg.photo.at(-1):null;
    const body={telegram_user_id:from.id,operation_key:`msg:${from.id}:${msg.message_id}`,case_id:c.id,chat_id:String(chat),message_id:msg.message_id,message_date:msg.date,kind:photo?'PHOTO':typeof msg.text==='string'?'TEXT':'OTHER',...(photo?{file_id:photo.file_id,file_unique_id:photo.file_unique_id}:typeof msg.text==='string'?{text:msg.text}:{})};
    const r=await api('/flow/message',body);
    if(r.outcome!=='SUBMITTED'&&r.case.status!=='WAITING_PAYMENT')return await show(chat,r.case);
    const text={PHOTO_ACCEPTED:messages.photo,SUBMITTED:messages.submitted,SCREENSHOT_REQUIRED:messages.screenshot,INVALID_LAST_FOUR:messages.invalid,CLARIFICATION:messages.review,UNDER_REVIEW:messages.review}[r.outcome];
    return await (text?send(chat,text):show(chat,r.case));
   }
   if(c&&['WAITING_VERIFICATION','CONFIRMED','NEEDS_CUSTOMER_ACTION'].includes(c.status))return await show(chat,c);
   if(start){if(c&&c.status!=='COMPLETED')return await show(chat,c);return await plans(chat,c?.id??0);}
   if(!callback){if(c)return await show(chat,c);return await send(chat,messages.screenshot);}
   const parts=String(callback.data||'').split(':'),op={telegram_user_id:from.id,operation_key:'cb:'+callback.id};
   if(parts[0]==='premium_reselect'&&parts.length===1){if(c?.status==='WAITING_PAYMENT')return await show(chat,c);return await plans(chat,c?.id??0);}
   if(parts[0]==='plans'&&parts.length===2){if(c?.status==='WAITING_PAYMENT')return await show(chat,c);if(Number(parts[1])!==(c?.id??0))throw Object.assign(new Error('Stale button'),{status:409});return await plans(chat,c?.id??0);}
   if(parts[0]==='plan'&&parts.length===3){if(c?.status==='WAITING_PAYMENT')return await show(chat,c);if(Number(parts[2])!==(c?.id??0))throw Object.assign(new Error('Stale button'),{status:409});return await methodMenu(chat,parts[1],null,parts[2]);}
   if(parts[0]==='method'&&parts.length===4){const r=await api('/flow/select',{...op,plan:parts[1],payment_method:parts[2],after_case_id:Number(parts[3])});return await show(chat,r.case);}
   if(parts[0]==='methods'&&parts.length===2&&c?.id===Number(parts[1])&&c.can_change_method)return await methodMenu(chat,c.plan,c.id,0);
   if(parts[0]==='change'&&parts.length===3){const r=await api('/flow/method',{...op,case_id:Number(parts[1]),payment_method:parts[2]});return await show(chat,r.case);}
   if(parts[0]==='cancel'&&parts.length===2){const r=await api('/flow/cancel',{...op,case_id:Number(parts[1])});return await show(chat,r.case);}
   return await send(chat,messages.error);
  }catch(error){try{await send(chat,messages.error);}catch{console.error('Payment Bot response failed.');}return [400,404,409,422].includes(error.status)?undefined:false;}
 }
 return {handle};
}
module.exports={createFlow,messages};
