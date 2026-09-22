'use strict';
const {createClient}=require('./client');
const {createTelegramTransport}=require('./telegram-transport');
const {createFakeTransport}=require('./fake-transport');
const {createRuntime}=require('./runtime');
function configure({env=process.env,api,fetchImpl,log=()=>{}}={}){
 const mode=env.PAYMENT_BOT_MODE||'development';
 if(!['development','real'].includes(mode))throw new Error('PAYMENT_BOT_MODE is invalid');
 if(mode==='development'){
  if(typeof api!=='function')throw new Error('Development mode requires an injected synthetic backend');
  const fake=createFakeTransport();const telegram={...fake,sendFlow:(chat,text,markup)=>fake.sendMessage({telegramUserId:chat,text,actions:markup?.inline_keyboard?.flat()??[]}),getUpdates:async()=>[],answerCallbackQuery:async()=>{}};
  return createRuntime({api,telegram,log});
 }
 for(const key of ['PAYMENT_BOT_TOKEN','PAYMENT_BOT_API_SECRET','PAYMENT_BOT_BACKEND_URL'])if(typeof env[key]!=='string'||!env[key].trim())throw new Error(key+' is required');
 let backend;try{backend=createClient({baseUrl:env.PAYMENT_BOT_BACKEND_URL,secret:env.PAYMENT_BOT_API_SECRET});}catch{throw new Error('PAYMENT_BOT_BACKEND_URL or PAYMENT_BOT_API_SECRET is invalid');}
 const telegram=createTelegramTransport({token:env.PAYMENT_BOT_TOKEN,fetchImpl});
 return createRuntime({api:api||backend,telegram,log});
}
function start(options={}){const runtime=configure(options);const detach=runtime.installSignals();runtime.start();const stop=runtime.stop.bind(runtime);runtime.stop=()=>stop().finally(detach);return runtime;}
if(require.main===module){
 const {createRequire}=require('node:module'),path=require('node:path');
 const localRequire=createRequire(path.resolve(__dirname,'../telegram-bot/package.json'));
 try{localRequire('dotenv').config({path:path.join(__dirname,'.env'),quiet:true});start({log:message=>console.log(message)});}catch(error){const safe=/^(PAYMENT_BOT_(?:MODE|TOKEN|API_SECRET|BACKEND_URL)|Development mode requires)/.test(error.message)?error.message:'Payment Bot configuration failed';console.error(safe);process.exitCode=1;}
}
module.exports={start,configure};
