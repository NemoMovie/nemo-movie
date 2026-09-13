// Pure calculation plus ledger validation; no database is opened on import.
export function membershipLedger(db, uid) {
    const fail=()=>{throw new Error('Membership ledger cannot be reconciled.');};
    const validTime=t=>{if(typeof t!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)||!Number.isFinite(Date.parse(t))||new Date(t).toISOString()!==t)fail();};
    const rows=db.prepare('SELECT * FROM premium_membership_effects WHERE telegram_user_id=? ORDER BY event_order,revision').all(uid);
    const events=[];const seen=new Set();
    for(const row of rows){
        validTime(row.effective_at);validTime(row.created_at);
        const previous=events[row.event_order-1];
        if(!Number.isSafeInteger(row.event_order)||row.event_order<1||row.event_order>events.length+1||
            (!previous&&(row.revision!==1||row.supersedes_effect_id!==null))||
            (previous&&(row.revision!==previous.revision+1||row.supersedes_effect_id!==previous.id||row.effect_type!=='PAYMENT_GRANT'||previous.effect_type!=='PAYMENT_GRANT'||row.effective_at!==previous.effective_at)))fail();
        if(row.effect_type==='PAYMENT_GRANT'){
            const p=db.prepare('SELECT * FROM payments WHERE id=?').get(row.payment_id);
            if(!p||p.telegram_user_id!==uid||!['CONFIRMED','CORRECTED'].includes(p.status)||p.plan_days!==row.plan_days||!Number.isSafeInteger(row.plan_days)||row.plan_days<=0||seen.has(p.id))fail();
            validTime(p.confirmed_at);
            if(row.correction_start_at!==null||row.correction_expires_at!==null)fail();
            if(previous){
                const links=db.prepare("SELECT * FROM membership_audit_log WHERE action='PAYMENT_CORRECTION' AND new_value=?").all(String(p.id));
                if(links.length!==1||links[0].telegram_user_id!==uid||links[0].old_value!==String(previous.payment_id)||links[0].field_name!=='payment:'+previous.payment_id||links[0].reason!==row.reason)fail();
            }
            seen.add(p.id);
            if(previous&&db.prepare('SELECT status FROM payments WHERE id=?').get(previous.payment_id)?.status!=='CORRECTED')fail();
        }else if(row.effect_type==='MEMBERSHIP_CORRECTION'){
            validTime(row.correction_start_at);validTime(row.correction_expires_at);
            if(row.payment_id!==null||row.plan_days!==null||row.correction_expires_at<=row.correction_start_at)fail();
        }else fail();
        events[row.event_order-1]=row;
    }
    for(const p of db.prepare("SELECT id FROM payments WHERE telegram_user_id=? AND status IN ('CONFIRMED','CORRECTED')").all(uid))if(!seen.has(p.id))fail();
    return events;
}
export function replayMembership(events) {
    let state=null;
    for(const e of events){
        if(e.effect_type==='MEMBERSHIP_CORRECTION')state={start_at:e.correction_start_at,expires_at:e.correction_expires_at};
        else {
            const active=state&&e.effective_at<state.expires_at;
            state={start_at:active?state.start_at:e.effective_at,expires_at:new Date(Date.parse(active?state.expires_at:e.effective_at)+e.plan_days*86400000).toISOString()};
        }
        if(state.expires_at<=state.start_at||state.expires_at.length!==24)throw new Error('Invalid replay state.');
    }
    return state;
}
