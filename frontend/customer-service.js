import { API_URL } from "./config.js";
const el=id=>document.getElementById(id), root='/api/admin/premium/cases';
const plans={MONTH_1:'1 Month',MONTH_3:'3 Months',MONTH_6:'6 Months',YEAR_1:'1 Year'};
const methods={KBZPAY:'KBZPay',WAVE_MONEY:'Wave Money',AYA_PAY:'AYA Pay'};
const states=['WAITING_PAYMENT','WAITING_VERIFICATION','NEEDS_CUSTOMER_ACTION','CONFIRMED','COMPLETED','REJECTED','CANCELLED','EXPIRED'];
const reasons=['PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','OTHER'];
const dates=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Yangon',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true});
const date=v=>v&&Number.isFinite(Date.parse(v))?dates.format(new Date(v))+' MMT':'—';
const money=v=>Number.isSafeInteger(v)?new Intl.NumberFormat('en-US').format(v)+' MMK':'—';
const identity=c=>[c.first_name,c.last_name].filter(Boolean).join(' ')|| (c.username?'@'+c.username:'Telegram user');
let authenticated=false,page=1,pages=1,queueVersion=0,detailVersion=0,selected=null,current=null,busy=false,reviewed=null;
const dialog=el('actionDialog');
let conversationVersion=0,conversationCursor=null,conversationLoading=false;
function resetConversation(){
 ++conversationVersion;conversationCursor=null;conversationLoading=false;
 el('conversationList').replaceChildren();el('conversationRetry').hidden=true;el('conversationMore').hidden=true;
 el('conversationList').setAttribute('aria-busy','false');notify('conversationMessage','');
}
async function loadConversation(){
 if(!authenticated||!current||current.id!==selected||conversationLoading)return;
 const caseId=selected,version=++conversationVersion;conversationLoading=true;
 el('conversationRetry').hidden=true;el('conversationMore').hidden=true;el('conversationList').setAttribute('aria-busy','true');notify('conversationMessage','Loading conversation...');
 try{
  const q=new URLSearchParams({limit:50});if(conversationCursor!==null)q.set('after_id',conversationCursor);
  const data=await api(root+'/'+caseId+'/messages?'+q);
  if(version!==conversationVersion||selected!==caseId||!authenticated)return;
  if(!Array.isArray(data.messages)||data.messages.some(m=>m.payment_case_id!==caseId||!['CUSTOMER','ADMIN','SYSTEM'].includes(m.sender_type)||!['TEXT','PHOTO','SYSTEM'].includes(m.message_type))||!(data.next_after_id===null||(Number.isSafeInteger(data.next_after_id)&&data.next_after_id>0)))throw new Error('Invalid conversation response.');
  for(const m of data.messages){
   const item=node('li','','cs-message cs-message-'+m.sender_type.toLowerCase());
   item.append(node('strong',{CUSTOMER:'Customer',ADMIN:'Admin',SYSTEM:'System'}[m.sender_type]),node('small',date(m.created_at),'cs-note'));
   if(m.message_type==='PHOTO')item.append(node('p','[Payment screenshot]'),node('small','Secure preview not connected yet','cs-note'));
   if(typeof m.text_content==='string')item.append(node('p',m.text_content));
   const delivery=m.delivery_state??(m.sender_type==='ADMIN'?m.initial_delivery_state:null);
   const deliveryLabels={PENDING_SEND:'Pending delivery — not delivered',SENT:'Sent',FAILED:'Failed — delivery unsuccessful'};
   if(deliveryLabels[delivery])item.append(node('small',deliveryLabels[delivery],'cs-note'));
   el('conversationList').append(item);
  }
  conversationCursor=data.next_after_id;el('conversationMore').hidden=conversationCursor===null;
  notify('conversationMessage',el('conversationList').children.length?'':'No conversation messages yet.');
 }catch{if(version===conversationVersion&&selected===caseId){notify('conversationMessage','Unable to load conversation.',true);el('conversationRetry').hidden=false;}}
 finally{if(version===conversationVersion){conversationLoading=false;el('conversationList').setAttribute('aria-busy','false');}}
}
function notify(id,message,error=false){el(id).textContent=message;el(id).classList.toggle('error',error);}
function node(tag,text,cls){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;}
function fields(id,values){el(id).replaceChildren();for(const [label,value] of values)el(id).append(node('dt',label),node('dd',value??'—'));}
function validCase(c){return c&&Number.isSafeInteger(c.id)&&c.id>0&&states.includes(c.status)&&Object.hasOwn(plans,c.plan)&&Object.hasOwn(methods,c.payment_method)&&Number.isSafeInteger(c.amount_mmk);}
async function api(path,options={}){
 let response;try{response=await fetch(API_URL+path,{...options,credentials:'include'});}catch{throw new Error('Network request failed. Reload the case before trying an action again.');}
 if(response.status===401){authenticated=false;window.location.href='login.html';}
 const errors={400:'Check the required fields.',401:'Admin session expired. Sign in again.',403:'Request origin rejected. Use the approved Admin site.',404:'Payment case not found.',409:'Case state or verification conflicts with this action. Reload and review.',422:'Verification was not accepted. Review the supplied information.',503:'Payment Case service is not configured or is unavailable.'};
 if(!response.ok)throw new Error(errors[response.status]||'Request failed. Reload the case and review its state before retrying.');
 return response.json();
}
function lockControls(){
 el('filterFields').disabled=!authenticated||busy;el('logoutButton').disabled=busy;
 el('previousPage').disabled=busy||page<=1;el('nextPage').disabled=busy||page>=pages;
 el('conversationSend').disabled=!authenticated||busy||!current||['COMPLETED','REJECTED','CANCELLED','EXPIRED'].includes(current.status);
 el('detailRefresh').disabled=busy;el('queueRetry').disabled=busy;
 for(const button of document.querySelectorAll('#caseQueue button, #caseActions button'))button.disabled=busy;
 el('actionFields').disabled=busy;el('cancelAction').disabled=busy;el('submitAction').disabled=busy;
}
async function loadQueue(){
 if(!authenticated||busy)return;
 const version=++queueVersion;el('caseQueue').replaceChildren();el('queueRetry').hidden=true;el('caseQueue').setAttribute('aria-busy','true');notify('queueMessage','Loading cases…');
 el('previousPage').disabled=true;el('nextPage').disabled=true;
 try{
  const q=new URLSearchParams({page,limit:24,search:el('caseSearch').value.trim(),sort:el('caseSort').value});if(el('caseStatus').value)q.set('status',el('caseStatus').value);
  const data=await api(root+'?'+q);if(version!==queueVersion)return;
  if(!Array.isArray(data.cases)||data.cases.some(c=>!validCase(c))||!Number.isSafeInteger(data.total)||data.total<0)throw new Error('Invalid case list response.');
  pages=Math.max(1,Math.ceil(data.total/24));if(page>pages){page=pages;await loadQueue();return;}
  for(const c of data.cases){const b=node('button','', 'cs-case');b.type='button';b.value=String(c.id);b.setAttribute('aria-pressed',String(c.id===selected));
   b.append(node('strong',identity(c)),node('small',`Case ${c.id} · Telegram ID ${c.telegram_user_id}`),node('span',plans[c.plan]+' · '+methods[c.payment_method]),node('span',c.status.replaceAll('_',' '),'cs-badge '+c.status),node('small','Updated '+date(c.updated_at)));
   b.addEventListener('click',()=>{if(!busy)loadDetail(c.id);});el('caseQueue').append(b);
  }
  notify('queueMessage',data.total?`${data.total} payment cases`:'No matching payment cases.');el('pageIndicator').textContent=`Page ${page} of ${pages}`;lockControls();
 }catch(error){if(version===queueVersion){notify('queueMessage',error.message,true);el('queueRetry').hidden=false;}}
 finally{if(version===queueVersion)el('caseQueue').setAttribute('aria-busy','false');}
}
function render(c){
 current=c;el('caseContent').hidden=false;el('caseHeading').textContent='Payment Case '+c.id;
 const outcome=el('caseOutcome');outcome.className='cs-outcome';
 if(c.status==='CONFIRMED'){outcome.textContent='Payment is already confirmed — Premium activation did not complete. Do not ask the customer to pay again. Retry Activation.';outcome.classList.add('pending');}
 else if(c.status==='COMPLETED'){outcome.textContent='Premium activation/renewal succeeded. Case completed.';outcome.classList.add('success');}
 else if(c.status==='REJECTED'){outcome.textContent='Case rejected — '+(c.rejection_reason||'See action history.');outcome.classList.add('rejected');}
 else outcome.textContent=c.status==='NEEDS_CUSTOMER_ACTION'?'Legacy case — explicit Admin reconciliation required':c.status.replaceAll('_',' ');
 fields('caseSummary', [['Customer',identity(c)],['Username',c.username?'@'+c.username:'—'],['Telegram ID',c.telegram_user_id],['Plan',plans[c.plan]],['Plan days',c.plan_days],['Expected amount',money(c.amount_mmk)],['Payment method',methods[c.payment_method]],['Account reference',c.payment_account_reference],['Status',c.status],['Submitted',date(c.submitted_at)]]);
 fields('caseVerification',[['Customer last-four',c.transaction_last_four],['Verified full reference',c.verification?.transaction_reference],['Money verified by',c.verification?.admin_identifier],['Payment received',date(c.verification?.payment_at)],['Linked payment ID',c.payment_id],['Membership start',date(c.membership?.start_at)],['Membership expiry',date(c.membership?.expires_at)],['Created',date(c.created_at)],['Updated',date(c.updated_at)],['Confirmed',date(c.confirmed_at)],['Completed',date(c.completed_at)],['Rejected',date(c.rejected_at)]]);
 el('caseEvidence').replaceChildren();for(const e of c.evidence??[])el('caseEvidence').append(node('li',`${date(e.created_at)} · Evidence ${e.id}\nLast-four: ${e.transaction_last_four??'—'}\n${e.has_proof?'Payment proof received — secure preview integration pending.':'Transaction information submitted.'}`));
 if(!c.evidence?.length)el('caseEvidence').append(node('li','No evidence submitted yet.'));
 if(c.possible_duplicate_cases?.length)el('caseEvidence').append(node('li','Possible reused proof in cases '+c.possible_duplicate_cases.map(x=>x.id).join(', ')+'. Warning only — check the actual payment records; this does not prove duplicate payment.'));
 const timeline=[['Case created',c.created_at],['Case submitted / reviewed',c.submitted_at],['Money confirmed',c.confirmed_at],['Premium completed',c.completed_at]].filter(([,at])=>at).map(([message,at])=>({message,at}));
 for(const a of c.actions??[])timeline.push({at:a.created_at,message:`${a.action.replaceAll('_',' ')} · ${a.admin_identifier}${a.reason_category?' · '+a.reason_category.replaceAll('_',' '):''}\n${a.message}`});
 if(c.rejected_at&&!c.actions?.some(a=>a.action==='REJECT'))timeline.push({at:c.rejected_at,message:'Rejected: '+(c.rejection_reason||'—')});
 timeline.sort((a,b)=>String(a.at).localeCompare(String(b.at)));el('caseTimeline').replaceChildren();for(const item of timeline)el('caseTimeline').append(node('li',date(item.at)+'\n'+item.message));
 el('caseActions').replaceChildren();
 const actions=c.status==='WAITING_VERIFICATION'?[['confirm','Confirm Payment'],['reject','Reject Payment']]:c.status==='CONFIRMED'?[['retry-activation','Retry Activation']]:[];
 for(const [key,label] of actions){const b=node('button',label,'users-button'+(key==='reject'?' cs-reject':''));b.type='button';b.addEventListener('click',()=>openAction(key));el('caseActions').append(b);}
 lockControls();
}
async function loadDetail(caseId){
 if(!authenticated||busy)return false;
 if(selected!==caseId){el('conversationText').value='';notify('conversationSendStatus','');}
 selected=caseId;current=null;reviewed=null;resetConversation();const version=++detailVersion;if(dialog.open)dialog.close();
 for(const button of document.querySelectorAll('#caseQueue button'))button.setAttribute('aria-pressed',String(button.value===String(caseId)));
 el('caseContent').hidden=true;el('detailRefresh').hidden=false;notify('detailMessage','Loading case…');
 try{const c=await api(root+'/'+caseId);if(version!==detailVersion)return false;if(!validCase(c)||c.id!==caseId||!Array.isArray(c.evidence)||!Array.isArray(c.actions))throw new Error('Invalid case response.');render(c);notify('detailMessage','Case loaded. Dates shown in MMT.');void loadConversation();return true;}
 catch(error){if(version===detailVersion)notify('detailMessage',error.message,true);return false;}
}
function openAction(action){
 if(busy||!current)return;
 const allowed={confirm:['WAITING_VERIFICATION'],reject:['WAITING_VERIFICATION'],'retry-activation':['CONFIRMED']};
 if(!allowed[action]?.includes(current.status))return;
 reviewed={action,case:current};
 const labels={confirm:'Confirm Payment',reject:'Reject Payment Case','retry-activation':'Retry Premium Activation'};
 el('actionHeading').textContent=labels[action];el('submitAction').textContent=labels[action];
 fields('actionSummary',[['Customer',identity(current)],['Telegram ID',current.telegram_user_id],['Case',current.id],['Plan',plans[current.plan]],['Amount',money(current.amount_mmk)],['Method',methods[current.payment_method]],['Customer last-four',current.transaction_last_four]]);
 for(const [label,input,on] of [['paymentTimeLabel','paymentTime',action==='confirm'],['reasonLabel','rejectionCategory',action==='reject'],['messageLabel','adminMessage',action==='reject']]){el(label).hidden=!on;el(input).required=on;el(input).value='';}
 el('actionWarning').textContent=action==='confirm'?'Verify the screenshot, customer last-four and actual payment account records externally. Last-four is not unique. Confirmation automatically attempts Premium activation.':action==='retry-activation'?'Retry activation using the already recorded money verification. This does not confirm payment again.':action==='reject'?'Rejection is permanent for this case. No Premium activation will occur.':'Record an explicit Admin message. Telegram delivery is not connected; this message will not be sent.';
 notify('actionMessage','');dialog.showModal();
}
function mmtToUtc(value){
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value))throw new Error('Enter the actual payment date and time in MMT.');
 const full=value.length===16?value+':00':value;const ms=Date.parse(full+'+06:30');
 if(!Number.isFinite(ms)||new Date(ms+390*60000).toISOString().slice(0,19)!==full||ms>Date.now())throw new Error('Enter a valid, non-future payment time in MMT.');return new Date(ms).toISOString();
}
async function submitAction(event){
 event.preventDefault();if(busy||!reviewed||!current||reviewed.case.id!==current.id)return;
 const {action,case:c}=reviewed;let body={};
 try{
  if(action==='confirm'){body={payment_at:mmtToUtc(el('paymentTime').value),plan:c.plan,amount_mmk:c.amount_mmk,payment_method:c.payment_method};}
  if(action==='reject'){const message=el('adminMessage').value.trim();if(!message||message.length>500||/[\x00-\x1f]/.test(message))throw new Error('Enter a manual explanation (1–500 characters, single line).');body.message=message;}
  if(action==='reject'){if(!reasons.includes(el('rejectionCategory').value))throw new Error('Choose a rejection category.');body.reason_category=el('rejectionCategory').value;}
 }catch(error){notify('actionMessage',error.message,true);return;}
 busy=true;++queueVersion;lockControls();notify('actionMessage','Saving…');let result=null,errorText='';
 try{result=await api(root+'/'+c.id+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}catch(error){errorText=error.message;}
 // No automatic mutation retry, even when the response is lost. Close the dialog
 // and reload authoritative state before offering any new action.
 reviewed=null;dialog.close();busy=false;
 const loaded=await loadDetail(c.id);
 if(loaded){
  if(result?.completion_error==='MANUAL_RECONCILIATION_REQUIRED'&&current?.status==='CONFIRMED'){el('caseOutcome').textContent+='\nManual reconciliation required: later membership activity exists. Do not attempt automatic repair.';}
  if(result?.completion_error==='COMPLETION_FAILED'&&current?.status==='CONFIRMED'){el('caseOutcome').textContent+='\nActivation failed. Payment remains verified; retry activation or request Admin review. Do not pay again.';}
  if(errorText)notify('detailMessage',errorText+' Current case has been reloaded.',true);
 }else notify('detailMessage',(errorText||'Action response received.')+' Could not verify current case state. Reload before continuing.',true);
 lockControls();await loadQueue();
}
async function initialize(){
 if(busy)return;const version=++queueVersion;++detailVersion;resetConversation();authenticated=false;current=null;reviewed=null;el('caseContent').hidden=true;if(dialog.open)dialog.close();lockControls();
 try{await api('/api/admin/check');if(version!==queueVersion)return;authenticated=true;lockControls();await loadQueue();if(selected)await loadDetail(selected);}catch(error){if(version===queueVersion){notify('queueMessage',error.message,true);el('queueRetry').hidden=false;}}
}
el('queueFilters').addEventListener('submit',e=>{e.preventDefault();page=1;loadQueue();});
for(const id of ['caseStatus','caseSort'])el(id).addEventListener('change',()=>{page=1;loadQueue();});
el('previousPage').addEventListener('click',()=>{if(!busy&&page>1){page--;loadQueue();}});el('nextPage').addEventListener('click',()=>{if(!busy&&page<pages){page++;loadQueue();}});
el('queueRetry').addEventListener('click',()=>authenticated?loadQueue():initialize());el('detailRefresh').addEventListener('click',()=>selected&&loadDetail(selected));
el('actionForm').addEventListener('submit',submitAction);el('cancelAction').addEventListener('click',()=>{if(!busy){reviewed=null;dialog.close();}});dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();else reviewed=null;});
el('logoutButton').addEventListener('click',async()=>{if(busy)return;busy=true;lockControls();try{await api('/api/logout',{method:'POST'});window.location.href='login.html';}catch(error){notify('queueMessage',error.message,true);busy=false;lockControls();}});
window.addEventListener('pageshow',initialize);
el('conversationRetry').addEventListener('click',loadConversation);
el('conversationMore').addEventListener('click',loadConversation);

async function queueConversation(event){
 event.preventDefault();if(!authenticated||busy||!current||['COMPLETED','REJECTED','CANCELLED','EXPIRED'].includes(current.status))return;
 const caseId=current.id,text=el('conversationText').value.trim();if(!text||text.length>4096)return;
 busy=true;lockControls();notify('conversationSendStatus','Saving message…');
 try{await api(root+'/'+caseId+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});if(current?.id===caseId){el('conversationText').value='';notify('conversationSendStatus','Message queued; not yet delivered.');resetConversation();await loadConversation();}}
 catch{if(current?.id===caseId)notify('conversationSendStatus','Could not verify message save. Refresh conversation before retrying to avoid a duplicate.',true);}
 finally{busy=false;lockControls();}
}
el('conversationForm').addEventListener('submit',queueConversation);
