// Non-payable fallback for missing or incomplete payment account configuration.
export const DEVELOPMENT_ACCOUNTS=Object.freeze(Object.fromEntries(['KBZPAY','WAVE_MONEY','AYA_PAY'].map(method=>[method,Object.freeze({reference:'DEV:'+method+':v1',account:'PAYMENT_ACCOUNT_NOT_CONFIGURED',name:'PAYMENT_ACCOUNT_NOT_CONFIGURED',live:false})])));

export function resolvePaymentAccounts(env=process.env){
 return Object.fromEntries(Object.entries(DEVELOPMENT_ACCOUNTS).map(([method,fallback])=>{
  const account=typeof env[method+'_ACCOUNT']==='string'?env[method+'_ACCOUNT'].trim():'';
  const name=typeof env[method+'_ACCOUNT_NAME']==='string'?env[method+'_ACCOUNT_NAME'].trim():'';
  return [method,account&&name?{reference:'LIVE:'+method+':v1',account,name,live:true}:fallback];
 }));
}
