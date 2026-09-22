import { membershipLedger, replayMembership } from './premium-ledger.js';
import { randomInt } from 'node:crypto';
export const PLANS = Object.freeze({MONTH_1:[30,2000],MONTH_3:[90,5000],MONTH_6:[180,9000],YEAR_1:[365,17000]});
const METHODS=['KBZPAY','WAVE_MONEY','AYA_PAY'];
const DAY=86400000;
export class PremiumError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const reject=(message,status)=>{throw new PremiumError(message,status);};
export function id(value){if(!['string','number'].includes(typeof value)||!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value))) reject('Invalid identifier');return Number(value);}
function text(value,max=150){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f]/.test(value)) reject('Invalid text');return value.trim();}
function iso(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value) reject('Invalid timestamp');return value;}
function select(value,values){if(!values.includes(value))reject('Invalid selection');return value;}
function body(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k)))reject('Invalid request fields');return value;}
function query(q,keys,limit=24){body(q,keys);for(const v of Object.values(q))if(typeof v!=='string')reject('Invalid query');const page=q.page===undefined?1:id(q.page);const size=q.limit===undefined?limit:id(q.limit);const offset=(page-1)*size;if(size>100||!Number.isSafeInteger(offset))reject('Invalid pagination');const search=(q.search??'').trim();if(search.length>150)reject('Invalid search');return {page,size,offset,pattern:'%'+search.replace(/[!%_]/g,'!$&')+'%'};}
export function createPremiumService(db,{clock=()=>Date.now(),random=randomInt}={}) {
    db.pragma('foreign_keys = ON');
    const now=()=>new Date(clock()).toISOString();
    const getPayment=value=>{const row=db.prepare('SELECT * FROM payments WHERE id=?').get(id(value));if(!row)reject('Payment not found',404);return row;};
    const user=value=>{const row=db.prepare('SELECT * FROM telegram_users WHERE telegram_user_id=?').get(id(value));if(!row)reject('User not found',404);return row;};
    const membership=value=>db.prepare('SELECT * FROM premium_memberships WHERE telegram_user_id=?').get(id(value));
    const status=(m,time=now())=>!m?'NON_PREMIUM':iso(m.expires_at)>time?'ACTIVE':'EXPIRED';
    const audit=(uid,action,field,oldValue,newValue,reason,admin,time)=>db.prepare('INSERT INTO membership_audit_log (telegram_user_id,action,field_name,old_value,new_value,reason,admin_identifier,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid,action,field,oldValue,newValue,text(reason,1000),text(admin),time);
    function reconciled(uid){
        const events=membershipLedger(db,uid);const expected=replayMembership(events);const stored=membership(uid);
        if(expected?(!stored||stored.start_at!==expected.start_at||stored.expires_at!==expected.expires_at):!!stored)reject('Membership cannot be reconciled with ledger',409);
        return events;
    }
    function persistReplay(uid,time){
        const state=replayMembership(membershipLedger(db,uid));if(!state)reject('No membership effects to replay',409);
        db.prepare(`INSERT INTO premium_memberships (telegram_user_id,start_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET start_at=excluded.start_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at,reminder_2d_sent_at=NULL,reminder_1d_sent_at=NULL`).run(uid,state.start_at,state.expires_at,time,time);
        return membership(uid);
    }
    function appendGrant(p,events,time,admin){
        const links=db.prepare("SELECT * FROM membership_audit_log WHERE action='PAYMENT_CORRECTION' AND new_value=?").all(String(p.id));
        let original=null;let reason=null;
        if(links.length){
            if(links.length!==1)reject('Ambiguous payment correction',409);
            const link=links[0];const originalId=id(link.old_value);
            original=events.find(e=>e.effect_type==='PAYMENT_GRANT'&&e.payment_id===originalId);
            if(link.telegram_user_id!==p.telegram_user_id||link.field_name!=='payment:'+originalId||!original||getPayment(originalId).status!=='CORRECTED')reject('Correction effect cannot be reconciled',409);
            reason=text(link.reason,1000);
        }
        db.prepare(`INSERT INTO premium_membership_effects (telegram_user_id,event_order,revision,effect_type,payment_id,effective_at,plan_days,supersedes_effect_id,admin_identifier,reason,created_at) VALUES (?,?,?,'PAYMENT_GRANT',?,?,?,?,?,?,?)`).run(p.telegram_user_id,original?.event_order??events.length+1,original?original.revision+1:1,p.id,original?.effective_at??time,p.plan_days,original?.id??null,admin,reason,time);
    }
    function cleanup(){return db.prepare(`DELETE FROM payments WHERE status IN ('PENDING','EXPIRED')
        AND length(request_expires_at)=24 AND request_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ',request_expires_at,'+0 seconds')=request_expires_at
        AND request_expires_at<=? AND request_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(now()).changes;}
    function newRequest(uid,plan,method,time){
        const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for(let attempt=0;attempt<100;attempt++){
            let code='NM-';for(let n=0;n<6;n++)code+=alphabet[random(alphabet.length)];
            if(db.prepare('SELECT 1 FROM payments WHERE payment_request_code=?').get(code))continue;
            const result=db.prepare(`INSERT INTO payments (telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES (?,?,?,?,?,?,'PENDING',?,?)`).run(uid,code,method,PLANS[plan][1],plan,PLANS[plan][0],time,new Date(Date.parse(time)+DAY).toISOString());
            return getPayment(Number(result.lastInsertRowid));
        }
        reject('Request temporarily unavailable; retry later',503);
    }
    const request=db.transaction(input=>{
        body(input,['telegram_user_id','plan','payment_method']);const uid=user(input.telegram_user_id).telegram_user_id;
        const plan=select(input.plan,Object.keys(PLANS));const method=select(input.payment_method,METHODS);const time=now();cleanup();
        const existing=db.prepare("SELECT * FROM payments WHERE telegram_user_id=? AND status='PENDING' AND request_expires_at>? ORDER BY id DESC").all(uid,time).find(p=>{iso(p.request_expires_at);return true;});
        return existing??newRequest(uid,plan,method,time);
    });
    const confirm=db.transaction((value,input,admin,verifiedCaseId=null)=>{
        text(admin);body(input,['transaction_reference','payment_at']);const p=getPayment(value);const time=now();
        if(p.status==='CONFIRMED'){reconciled(p.telegram_user_id);return {payment:p,membership:membership(p.telegram_user_id)};}
        if(p.status!=='PENDING'||iso(p.request_expires_at)<=time)reject('Request is not valid for confirmation',409);
        let reference;
        if(verifiedCaseId!==null){
            const verified=db.prepare(`SELECT 1 FROM payment_case_verifications v JOIN payment_cases c ON c.id=v.case_id WHERE c.id=? AND c.status='CONFIRMED' AND c.telegram_user_id=? AND c.plan=? AND c.plan_days=? AND c.amount_mmk=? AND c.payment_method=? AND v.internal_request_code=? AND v.transaction_reference IS NULL AND v.payment_at=? AND v.confirmed_at=? AND v.admin_identifier=?`).get(id(verifiedCaseId),p.telegram_user_id,p.plan,p.plan_days,p.amount_mmk,p.payment_method,p.payment_request_code,input.payment_at,time,admin);
            if(!verified||input.transaction_reference!==null)reject('Durable case verification required',409);
            reference=null;
        }else reference=text(input.transaction_reference);
        const paymentAt=iso(input.payment_at);if(paymentAt>time)reject('Payment time is in the future');
        if(!METHODS.includes(p.payment_method)||!Object.hasOwn(PLANS,p.plan)||PLANS[p.plan][0]!==p.plan_days||PLANS[p.plan][1]!==p.amount_mmk)reject('Payment plan mismatch',409);
        if(db.prepare("SELECT 1 FROM payments WHERE payment_method=? AND transaction_reference=? AND status='CONFIRMED' AND id<>?").get(p.payment_method,reference,p.id))reject('Transaction reference already confirmed',409);
        const events=reconciled(p.telegram_user_id);
        // The trigger requires CONFIRMED before the grant insert; all writes roll back together.
        db.prepare("UPDATE payments SET status='CONFIRMED',transaction_reference=?,payment_at=?,confirmed_at=?,confirmed_by=? WHERE id=?").run(reference,paymentAt,time,admin,p.id);
        appendGrant(p,events,time,admin);
        persistReplay(p.telegram_user_id,time);
        return {payment:getPayment(p.id),membership:membership(p.telegram_user_id)};
    });
    return {
        cleanup,
        upsertUser(input){body(input,['telegram_user_id','username','first_name','last_name']);const uid=id(input.telegram_user_id);const time=now();const existing=db.prepare('SELECT * FROM telegram_users WHERE telegram_user_id=?').get(uid);const names=['username','first_name','last_name'].map(k=>input[k]===undefined?existing?.[k]??null:input[k]===null?null:text(input[k]));db.prepare(`INSERT INTO telegram_users (telegram_user_id,username,first_name,last_name,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`).run(uid,...names,time,time,time,time);return user(uid);},
        request:input=>request.immediate(input), confirm:(pid,input,admin)=>confirm.immediate(pid,input,admin),
        // Internal adapter-only entry; public/legacy confirm still requires a reference.
        confirmVerifiedCase:(pid,caseId,paymentAt,admin)=>confirm.immediate(pid,{transaction_reference:null,payment_at:paymentAt},admin,id(caseId)),
        status(uid){const m=membership(uid);return {status:status(m),start_at:m?.start_at??null,expires_at:m?.expires_at??null};},
        details(uid){const u=user(uid);const m=membership(uid);return {user:u,membership:m??null,status:status(m)};},
        history(uid,q={}){user(uid);const {size,offset}=query(q,['page','limit'],20);return {payments:db.prepare('SELECT * FROM payments WHERE telegram_user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(id(uid),size,offset),total:db.prepare('SELECT COUNT(*) n FROM payments WHERE telegram_user_id=?').get(id(uid)).n};},
        payments(q={}){
            const {page,size,offset,pattern}=query(q,['page','limit','search','status','method','sort'],20);
            const filter=select(q.status??'ALL',['ALL','CONFIRMED','CORRECTED','VOID']);
            const method=select(q.method??'ALL',['ALL',...METHODS]);
            const direction=select(q.sort??'newest',['newest','oldest'])==='newest'?'DESC':'ASC';
            // Keep permanent legacy history visible without offering refund operations.
            const where=`WHERE p.status IN ('CONFIRMED','CORRECTED','VOID','REFUNDED')
                AND (p.payment_request_code LIKE ? ESCAPE '!' OR CAST(p.telegram_user_id AS TEXT) LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!')
                ${filter==='ALL'?'':'AND p.status=?'} ${method==='ALL'?'':'AND p.payment_method=?'}`;
            const args=[pattern,pattern,pattern,...(filter==='ALL'?[]:[filter]),...(method==='ALL'?[]:[method])];
            const from='FROM payments p LEFT JOIN telegram_users u USING(telegram_user_id)';
            const records=db.prepare(`SELECT p.id,p.payment_request_code,p.telegram_user_id,u.username,
                p.plan,p.plan_days,p.payment_method,p.amount_mmk,p.status,p.payment_at,p.confirmed_at,
                p.created_at,p.admin_note,p.transaction_reference ${from} ${where}
                ORDER BY COALESCE(p.payment_at,p.confirmed_at,p.created_at) ${direction},p.id ${direction}
                LIMIT ? OFFSET ?`).all(...args,size,offset);
            const total=db.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...args).n;
            return {records,total,page,limit:size,totalPages:Math.ceil(total/size)};
        },
        lookup(code){if(typeof code!=='string'||!/^NM-[A-HJ-NP-Z2-9]{6}$/.test(code))reject('Invalid Request Code');const p=db.prepare('SELECT p.*,u.username FROM payments p JOIN telegram_users u USING(telegram_user_id) WHERE payment_request_code=?').get(code);if(!p)reject('Request not found',404);return {...p,status:p.status==='PENDING'&&iso(p.request_expires_at)<=now()?'EXPIRED':p.status};},
        users(q={}){const {size,offset,pattern}=query(q,['page','limit','search','status','sort']);const filter=select(q.status??'ALL',['ALL','ACTIVE','EXPIRED']);const orders={newest:'m.created_at DESC',oldest:'m.created_at ASC',expiry_high:'m.expires_at DESC',expiry_low:'m.expires_at ASC',username_az:'u.username COLLATE NOCASE ASC',username_za:'u.username COLLATE NOCASE DESC'};const sort=select(q.sort??'newest',Object.keys(orders));const time=now();const where=`WHERE (CAST(u.telegram_user_id AS TEXT) LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!' OR u.first_name LIKE ? ESCAPE '!' OR u.last_name LIKE ? ESCAPE '!') ${filter==='ALL'?'':filter==='ACTIVE'?'AND m.expires_at>?':'AND m.expires_at<=?'}`;const args=[pattern,pattern,pattern,pattern,...(filter==='ALL'?[]:[time])];const from='FROM premium_memberships m JOIN telegram_users u USING(telegram_user_id)';return {users:db.prepare(`SELECT u.telegram_user_id,u.username,u.first_name,u.last_name,m.start_at,m.expires_at ${from} ${where} ORDER BY ${orders[sort]},u.telegram_user_id DESC LIMIT ? OFFSET ?`).all(...args,size,offset).map(m=>({...m,status:status(m,time)})),total:db.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...args).n};},
        pending(q={}){const {size,offset,pattern}=query(q,['page','limit','search','payment_method','sort']);const method=q.payment_method===undefined?null:select(q.payment_method,METHODS);const sort=select(q.sort??'newest',['newest','oldest']);const where=`WHERE p.status='PENDING' AND p.request_expires_at>? AND (p.payment_request_code LIKE ? ESCAPE '!' OR CAST(p.telegram_user_id AS TEXT) LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!') ${method?'AND p.payment_method=?':''}`;const args=[now(),pattern,pattern,pattern,...(method?[method]:[])];const from='FROM payments p JOIN telegram_users u USING(telegram_user_id)';return {payments:db.prepare(`SELECT p.*,u.username ${from} ${where} ORDER BY p.id ${sort==='newest'?'DESC':'ASC'} LIMIT ? OFFSET ?`).all(...args,size,offset),total:db.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...args).n};},
        void:db.transaction((pid,input,admin)=>{body(input,['reason']);const p=getPayment(pid);const reason=text(input.reason,1000);text(admin);if(p.status!=='PENDING'||iso(p.request_expires_at)<=now())reject('Only valid pending requests may be voided',409);db.prepare("UPDATE payments SET status='VOID',admin_note=? WHERE id=?").run(reason,p.id);audit(p.telegram_user_id,'PAYMENT_VOID','payment:'+p.id,p.status,'VOID',reason,admin,now());return getPayment(p.id);}),
        correct:db.transaction((pid,input,admin)=>{body(input,['reason','plan','payment_method']);const reason=text(input.reason,1000);text(admin);const p=getPayment(pid);if(p.status!=='CONFIRMED')reject('Only confirmed payments may be corrected',409);const events=reconciled(p.telegram_user_id);if(!events.some(e=>e.effect_type==='PAYMENT_GRANT'&&e.payment_id===p.id))reject('Original grant is not current',409);const plan=select(input.plan,Object.keys(PLANS));const method=select(input.payment_method,METHODS);const time=now();if(db.prepare("SELECT 1 FROM payments WHERE telegram_user_id=? AND status='PENDING' AND request_expires_at>?").get(p.telegram_user_id,time))reject('Resolve the existing pending request first',409);const replacement=newRequest(p.telegram_user_id,plan,method,time);db.prepare("UPDATE payments SET status='CORRECTED' WHERE id=?").run(p.id);audit(p.telegram_user_id,'PAYMENT_CORRECTION','payment:'+p.id,String(p.id),String(replacement.id),reason,admin,time);return {original:getPayment(p.id),replacement};}),
        correctMembership:db.transaction((uid,input,admin)=>{body(input,['start_at','expires_at','reason']);const m=membership(uid);if(!m)reject('Membership not found',404);const start=iso(input.start_at);const expiry=iso(input.expires_at);const reason=text(input.reason,1000);text(admin);if(expiry<=start)reject('Expiry must follow start');const events=reconciled(id(uid));const time=now();db.prepare("INSERT INTO premium_membership_effects (telegram_user_id,event_order,effect_type,effective_at,correction_start_at,correction_expires_at,admin_identifier,reason,created_at) VALUES (?,?,'MEMBERSHIP_CORRECTION',?,?,?,?,?,?)").run(id(uid),events.length+1,time,start,expiry,admin,reason,time);for(const [key,value] of [['start_at',start],['expires_at',expiry]])if(m[key]!==value)audit(id(uid),'MEMBERSHIP_CORRECTION',key,m[key],value,reason,admin,time);return persistReplay(id(uid),time);}),
        stats(){const time=now();return {...db.prepare('SELECT COUNT(*) totalPremiumUsers,COUNT(CASE WHEN expires_at>? THEN 1 END) activePremium,COUNT(CASE WHEN expires_at<=? THEN 1 END) expiredPremium FROM premium_memberships').get(time,time),totalIncome:db.prepare("SELECT COALESCE(SUM(amount_mmk),0) total FROM payments WHERE status='CONFIRMED'").get().total};}
    };
}
