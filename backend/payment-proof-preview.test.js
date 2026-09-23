import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { registerPaymentProofPreview } from './payment-proof-preview.js';

test('isolated authenticated screenshot proxy with mocked Telegram only',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE payment_case_submissions(id INTEGER,case_id INTEGER,proof_file_id TEXT); INSERT INTO payment_case_submissions VALUES(1,10,'private-file'),(2,10,NULL)");
 const env={PAYMENT_BOT_TOKEN:'synthetic-token'};let mode='ok',calls=0;
 const png=Buffer.from('89504e470d0a1a0a00000000','hex');
 const app=express();registerPaymentProofPreview(app,db,{env,requireAdmin:(req,res,next)=>req.headers.cookie==='test=admin'?next():res.status(401).json({message:'Authentication required'}),fetchTelegram:async(url,options)=>{
  calls++;assert.equal(options.redirect,'error');assert.ok(options.signal);
  if(url.endsWith('/getFile')){
   assert.equal(JSON.parse(options.body).file_id,'private-file');
   if(mode==='get-error')throw new Error('synthetic-token private-file');
   return Response.json({ok:true,result:{file_path:mode==='bad-path'?'../private':'photos/private.png'}});
  }
  if(mode==='download-error')return new Response('synthetic-token private-file',{status:500});
  return new Response(mode==='html'?'<script>private-file</script>':png,{headers:{'Content-Type':'text/html'}});
 }});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const get=async(suffix='10/evidence/1/preview',auth=true)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/premium/cases/${suffix}`,{headers:auth?{Cookie:'test=admin'}:{}});
 await t.test('anonymous rejected without upstream request',async()=>{const r=await get(undefined,false);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(calls,0);});
 await t.test('valid image bytes with safe headers and no upstream metadata',async()=>{const r=await get();assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);assert.doesNotMatch(JSON.stringify([...r.headers]),/private|synthetic-token/);});
 for(const suffix of ['11/evidence/1/preview','10/evidence/2/preview','10/evidence/99/preview'])await t.test('missing or mismatched evidence '+suffix,async()=>{const before=calls;const r=await get(suffix);assert.equal(r.status,404);assert.equal(calls,before);assert.doesNotMatch(await r.text(),/private|synthetic-token/);});
 await t.test('missing token fails safely',async()=>{delete env.PAYMENT_BOT_TOKEN;const r=await get();assert.equal(r.status,503);env.PAYMENT_BOT_TOKEN='synthetic-token';});
 for(const failure of ['get-error','download-error','html','bad-path'])await t.test(failure+' safe rejection',async()=>{mode=failure;const r=await get();assert.equal(r.status,502);assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(await r.text(),/private|synthetic-token|telegram|file_path/);});
});
