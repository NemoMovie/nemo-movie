import { timingSafeEqual } from 'node:crypto';
import { createPremiumService, PremiumError } from './premium-service.js';
export function registerPremiumRoutes(app,db,{requireAdmin,requireSameOrigin,adminIdentity,env=process.env}) {
    const service=createPremiumService(db);
    const wrap=fn=>(req,res,next)=>{try{res.set('Cache-Control','no-store');res.json(fn(req));}catch(error){if(error instanceof PremiumError)res.status(error.status).json({message:error.message});else next(error);}};
    const root='/api/admin/premium';
    app.use(root,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
    const get=(suffix,fn)=>app.get(root+suffix,requireAdmin,wrap(fn));
    // Premium mutations require Origin; shared validation still owns origin matching.
    const requirePremiumOrigin=(req,res,next)=>{
        if(req.get('Origin')===undefined)return res.status(403).json({message:'Request origin rejected'});
        return requireSameOrigin(req,res,next);
    };
    const post=(suffix,fn)=>app.post(root+suffix,requirePremiumOrigin,requireAdmin,wrap(fn));
    get('/stats',()=>service.stats());get('/users',r=>service.users(r.query));
    get('/users/:telegramUserId',r=>service.details(r.params.telegramUserId));
    get('/users/:telegramUserId/payments',r=>service.history(r.params.telegramUserId,r.query));
    get('/payments',r=>service.payments(r.query));
    post('/users',r=>service.upsertUser(r.body));
    get('/pending',r=>service.pending(r.query));get('/payments/request/:code',r=>service.lookup(r.params.code));
    post('/payments/request',r=>service.request(r.body));
    post('/payments/:id/confirm',r=>service.confirm(r.params.id,r.body,adminIdentity(r)));
    post('/payments/:id/void',r=>service.void(r.params.id,r.body,adminIdentity(r)));
    post('/payments/:id/correct',r=>service.correct(r.params.id,r.body,adminIdentity(r)));
    app.put(root+'/users/:telegramUserId/membership',requirePremiumOrigin,requireAdmin,wrap(r=>service.correctMembership(r.params.telegramUserId,r.body,adminIdentity(r))));
    app.get('/api/internal/premium/users/:telegramUserId/status',(req,res,next)=>{
        res.set('Cache-Control','no-store');const secret=env.PREMIUM_STATUS_SECRET;
        if(typeof secret!=='string'||!secret.trim())return res.status(503).json({message:'Premium status access is not configured'});
        const supplied=Buffer.from(req.get('Authorization')||'');const expected=Buffer.from('Bearer '+secret);
        if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({message:'Authentication required'});
        next();
    },wrap(r=>service.status(r.params.telegramUserId)));
    // No schema changes; failed cleanup is logged generically and retried later.
    const clean=()=>{try{service.cleanup();}catch{console.error('Premium request cleanup failed.');}};
    clean();const timer=setInterval(clean,10*60*1000);timer.unref();
    return ()=>clearInterval(timer);
}
