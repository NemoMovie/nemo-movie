import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVELOPMENT_ACCOUNTS,resolvePaymentAccounts } from './payment-bot-accounts.js';

for(const method of Object.keys(DEVELOPMENT_ACCOUNTS)){
 test(method+' requires both nonblank strings and keeps the development fallback',()=>{
  for(const [account,name] of [[undefined,undefined],['synthetic',undefined],[undefined,'Synthetic'],['  ','Synthetic'],['synthetic',' \t '],[42,'Synthetic']]){
   const resolved=resolvePaymentAccounts({[method+'_ACCOUNT']:account,[method+'_ACCOUNT_NAME']:name});
   assert.equal(resolved[method],DEVELOPMENT_ACCOUNTS[method]);
  }
 });
}
test('complete configuration resolves independently without modifying fallbacks',()=>{
 const env=Object.fromEntries(Object.keys(DEVELOPMENT_ACCOUNTS).flatMap(method=>[[method+'_ACCOUNT',' synthetic-'+method+' '],[method+'_ACCOUNT_NAME',' Synthetic '+method+' ']]));
 const accounts=resolvePaymentAccounts(env);
 for(const method of Object.keys(accounts)){
  assert.deepEqual(accounts[method],{reference:'LIVE:'+method+':v1',account:'synthetic-'+method,name:'Synthetic '+method,live:true});
  assert.equal(DEVELOPMENT_ACCOUNTS[method].live,false);
 }
});
