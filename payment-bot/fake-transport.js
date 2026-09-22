'use strict';
// Deliberately no network or token configuration. Intended for isolated tests.
function createFakeTransport({outcomes=[]}={}){
 const sent=[],attempts=[];let index=0;
 return {sent,attempts,async sendMessage(message){attempts.push(structuredClone(message));const outcome=outcomes[index++];if(typeof outcome==='function')await outcome();else if(outcome==='fail')throw new Error('Synthetic transport failure');sent.push(structuredClone(message));return {ok:true};}};
}
module.exports={createFakeTransport};
