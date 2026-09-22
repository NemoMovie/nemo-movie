// Deliberately non-payable configuration. Real accounts require a later review.
export const DEVELOPMENT_ACCOUNTS=Object.freeze(Object.fromEntries(['KBZPAY','WAVE_MONEY','AYA_PAY'].map(method=>[method,Object.freeze({reference:'DEV:'+method+':v1',account:'PAYMENT_ACCOUNT_NOT_CONFIGURED',name:'PAYMENT_ACCOUNT_NOT_CONFIGURED',live:false})])));
