import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { membershipLedger,replayMembership } from './premium-ledger.js';
const labels={MONTH_1:'1 လ',MONTH_3:'3 လ',MONTH_6:'6 လ',YEAR_1:'1 နှစ်'};
export const confirmedText='✅ ငွေပေးချေမှုကို အတည်ပြုပြီးပါပြီ။\n\nPremium Member အဖြစ် အသက်သွင်းပေးနေပါသည်။\n\nခဏစောင့်ပေးပါ။';
export const rejectionReasons={
 PAYMENT_NOT_FOUND:'ပေးပို့ထားသော ငွေပေးချေမှုအချက်အလက်များဖြင့်\nငွေလွှဲထားမှုကို စစ်ဆေးရှာဖွေ၍ မတွေ့ရှိပါ။',
 INCORRECT_PAYMENT_DETAILS:'ပေးပို့ထားသော ငွေပေးချေမှု အချက်အလက်များသည်\nစစ်ဆေးတွေ့ရှိသော ငွေလွှဲမှု အချက်အလက်များနှင့် မကိုက်ညီပါ။',
 PAYMENT_PROOF_ALREADY_USED:'ပေးပို့ထားသော ငွေပေးချေမှုအထောက်အထားကို\nယခင်ငွေပေးချေမှုတစ်ခုတွင် အသုံးပြုပြီးဖြစ်ပါသည်။\n\nငွေပေးချေမှုအသစ် ပြုလုပ်လိုပါက\nအောက်ပါခလုတ်မှ ပြန်လည်ရွေးချယ်နိုင်ပါသည်။',
 INCORRECT_AMOUNT:'ရွေးချယ်ထားသော Premium Plan အတွက်\nပေးချေရမည့် ငွေပမာဏနှင့်\nလွှဲထားသော ငွေပမာဏ မကိုက်ညီပါ။',
 INVALID_OR_UNCLEAR_PROOF:'ပေးပို့ထားသော ငွေလွှဲ Screenshot မှ\nလိုအပ်သော ငွေပေးချေမှု အချက်အလက်များကို\nရှင်းလင်းစွာ စစ်ဆေး၍ မရပါ။'
};
export function formatMMT(utc){
 if(typeof utc!=='string'||!Number.isFinite(Date.parse(utc))||new Date(utc).toISOString()!==utc)throw new Error('Invalid notification time');
 return new Date(Date.parse(utc)+390*60000).toISOString().slice(0,19).replace('T',' ')+' MMT (UTC+06:30)';
}
export function completionEnabled(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_notifications'").get();}
export function createCaseNotifications(db,{clock=()=>Date.now()}={}){
 const conversation=createPaymentCaseConversationService(db,{clock});
 function queue(c,event,text){
  if(db.prepare('SELECT 1 FROM payment_case_notifications WHERE case_id=? AND event=?').get(c.id,event))return;
  const m=conversation.appendSystemMessage(c.id,{text});
  db.prepare('INSERT INTO payment_case_notifications(case_id,event,message_id,action,created_at) VALUES(?,?,?,?,?)').run(c.id,event,m.id,event==='REJECTED'?'RESELECT':null,m.created_at);
 }
 return {
  confirmed:c=>queue(c,'CONFIRMED',confirmedText),
  completed(c){
   const events=membershipLedger(db,c.telegram_user_id),index=events.findIndex(e=>e.payment_id===c.payment_id);
   if(index<0)throw new Error('Missing completion effect');
   const before=replayMembership(events.slice(0,index)),after=replayMembership(events.slice(0,index+1));
   const early=before&&before.expires_at>events[index].effective_at;
   const text=early?`🎉 Premium သက်တမ်းတိုးခြင်း အောင်မြင်ပါပြီ။\n\nPremium Plan: ${labels[c.plan]}\nသက်တမ်းကုန်ဆုံးမည့်အချိန်: ${formatMMT(after.expires_at)}\n\nယခု Premium သက်တမ်းအသစ်ကို\nအောင်မြင်စွာ ထည့်သွင်းပြီးပါပြီ။`:`🎉 Premium Member အဖြစ် အောင်မြင်စွာ အသက်သွင်းပြီးပါပြီ။\n\nPremium Plan: ${labels[c.plan]}\nစတင်သည့်အချိန်: ${formatMMT(after.start_at)}\nသက်တမ်းကုန်ဆုံးမည့်အချိန်: ${formatMMT(after.expires_at)}\n\nယခု Nemo Movie Website တွင် Premium Content များကို\nကြည့်ရှုနိုင်ပါပြီ။`;
   queue(c,'COMPLETED',text);
  },
  rejected:(c,reason,note)=>queue(c,'REJECTED','❌ ငွေပေးချေမှုကို အတည်ပြု၍ မရပါ။\n\n'+(reason==='OTHER'?'အကြောင်းပြချက်:\n'+note:rejectionReasons[reason])),
  attempt:(c,admin,outcome)=>db.prepare('INSERT INTO payment_case_activation_attempts(case_id,admin_identifier,outcome,created_at) VALUES(?,?,?,?)').run(c.id,admin,outcome,new Date(clock()).toISOString())
 };
}
