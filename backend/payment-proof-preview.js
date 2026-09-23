// No persistence or upstream metadata is returned to the browser.
async function bounded(response, limit) {
    if (!response.ok || !response.body) throw new Error();
    const chunks=[];let size=0;
    for await (const chunk of response.body) {
        size+=chunk.length;if(size>limit)throw new Error();chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
function imageType(bytes) {
    if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
    if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
    if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
    throw new Error();
}
export function registerPaymentProofPreview(app,db,{requireAdmin,env,fetchTelegram=globalThis.fetch}) {
    app.get('/api/admin/premium/cases/:caseId/evidence/:evidenceId/preview',
        (req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();},
        requireAdmin,async(req,res)=>{
            const error=(status,message)=>res.status(status).json({message});
            try {
                const ids=[req.params.caseId,req.params.evidenceId];
                if(ids.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<=0))return error(400,'Invalid evidence request');
                const evidence=db.prepare('SELECT proof_file_id FROM payment_case_submissions WHERE case_id=? AND id=?').get(...ids.map(Number));
                if(!evidence?.proof_file_id)return error(404,'Screenshot not found');
                const token=env.PAYMENT_BOT_TOKEN;
                if(typeof token!=='string'||!token.trim())return error(503,'Screenshot preview is unavailable');
                const options={redirect:'error',signal:AbortSignal.timeout(15000)};
                const response=await fetchTelegram(`https://api.telegram.org/bot${token}/getFile`,{
                    ...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:evidence.proof_file_id})});
                const data=JSON.parse((await bounded(response,65536)).toString('utf8'));
                const file=data?.result?.file_path;
                if(data.ok!==true||typeof file!=='string'||file.length>512||!/^\w[\w/-]*\.[a-zA-Z0-9]+$/.test(file)||file.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error();
                const bytes=await bounded(await fetchTelegram(`https://api.telegram.org/file/bot${token}/${file}`,options),10*1024*1024);
                res.set({'Content-Type':imageType(bytes),'Content-Disposition':'inline; filename="payment-proof"'});
                return res.send(bytes);
            }catch{return error(502,'Screenshot could not be loaded');}
        });
}
