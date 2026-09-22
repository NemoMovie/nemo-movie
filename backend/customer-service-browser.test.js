import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { startPremiumBrowserFixture,SYNTHETIC_LOGIN } from './premium-browser-fixture.js';
// Optional externally available test tooling; no application dependency is added.
const playwright = process.env.PLAYWRIGHT_MODULE_PATH ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH)) : null;
test('Customer Service real browser, synthetic fixture only',{skip:!playwright},async t=>{
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));assert.notEqual(port,3000);
 const f=await startPremiumBrowserFixture({port});let browser;
 try{
  browser=await playwright.chromium.launch({channel:'msedge',headless:true,args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.origin+'/customer-service.html');await page.waitForURL('**/login.html');
  await page.locator('#username').fill(SYNTHETIC_LOGIN.username);await page.locator('#password').fill(SYNTHETIC_LOGIN.password);await page.locator('#loginForm').evaluate(form=>form.requestSubmit());await page.waitForURL('**/premium-admin.html');
  await page.getByRole('link',{name:'Customer Service',exact:true}).click();await page.locator('.cs-case').first().waitFor();
  assert.equal(await page.locator('#caseStatus').inputValue(),'OPEN');
  assert.equal(await page.locator('.cs-case').count(),3);
  assert.deepEqual((await page.locator('.cs-badge').allTextContents()).sort(),['CONFIRMED','WAITING PAYMENT','WAITING VERIFICATION']);
  assert.equal(await page.locator('.cs-layout').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),2);
  const select=async state=>{await page.locator('#caseStatus').selectOption(state);await page.waitForFunction(state=>document.querySelectorAll('.cs-case').length===1&&document.querySelector('.cs-badge')?.textContent===state.replaceAll('_',' '),state);await page.locator('.cs-case').click();await page.locator('#caseContent').waitFor();};
  const conversationReady=()=>page.waitForFunction(()=>document.querySelector('#conversationList').getAttribute('aria-busy')==='false');
  for(const state of ['COMPLETED','REJECTED']){
   await select(state);await conversationReady();assert.match(await page.locator('#conversationList').innerText(),/I already sent the synthetic payment/);
  }
  await select('WAITING_PAYMENT');await conversationReady();
  assert.match(await page.locator('#conversationList').innerText(),/Payment screenshot/);
  assert.match(await page.locator('#conversationList').innerText(),/Secure preview not connected yet/);
  assert.match(await page.locator('#conversationList').innerText(),/<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#conversationList img').count(),0);
  assert.match(await page.locator('#conversationList').innerText(),/Pending delivery — not delivered/);
  assert.equal(await page.locator('.cs-message-system').count(),1);
  assert.doesNotMatch(await page.locator('#conversationList').innerHTML(),/SYNTHETIC-PHOTO|telegram_file_id|telegram_chat_id|telegram_message_id/);
  await select('CONFIRMED');await conversationReady();assert.equal(await page.locator('#conversationMessage').innerText(),'No conversation messages yet.');
  await page.route('**/cases/*/messages?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"message":"Unavailable"}'}));
  await page.locator('#detailRefresh').click();await page.getByText('Unable to load conversation.',{exact:true}).waitFor();assert.equal(await page.locator('#caseContent').isVisible(),true);
  await page.unroute('**/cases/*/messages?*');await page.locator('#conversationRetry').click();await conversationReady();
  await page.locator('#caseStatus').selectOption('ALL');await page.waitForFunction(()=>document.querySelectorAll('.cs-case').length===6);
  await select('WAITING_VERIFICATION');assert.match(await page.locator('#caseEvidence').innerText(),/secure preview integration pending/);
  assert.equal(await page.getByRole('button',{name:'Need More Information',exact:true}).count(),0);
  assert.equal(await page.locator('#fullReference').count(),0);
  await page.locator('#conversationText').fill('<img src=x onerror=alert(1)> Synthetic Admin message');await page.locator('#conversationSend').click();await page.getByText('Message queued; not yet delivered.',{exact:true}).waitFor();await conversationReady();
  assert.match(await page.locator('#conversationList').innerText(),/Synthetic Admin message/);assert.equal(await page.locator('#conversationList img').count(),0);assert.match(await page.locator('#conversationList').innerText(),/Pending delivery/);
  await page.getByRole('button',{name:'Confirm Payment',exact:true}).click();await page.locator('#paymentTime').fill('2026-01-01T06:30');await page.locator('#submitAction').click();await page.waitForFunction(()=>document.querySelector('#caseOutcome').textContent.includes('succeeded'));
  assert.equal(await page.locator('#caseActions button').count(),0);
  await select('CONFIRMED');assert.match(await page.locator('#caseOutcome').innerText(),/activation did not complete/);await page.getByRole('button',{name:'Retry Activation',exact:true}).click();await page.locator('#submitAction').click();await page.waitForFunction(()=>document.querySelector('#caseOutcome').textContent.includes('succeeded'));
  await select('CANCELLED');assert.equal(await page.locator('#caseActions button').count(),0);
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`overflow at ${width}`);}
  assert.equal(await page.locator('body').evaluate(e=>/NM-[A-HJ-NP-Z2-9]{6}/.test(e.innerText)),false);
  for(const name of ['premium-admin','premium-users','pending-payments','premium-payments','confirm-payment','premium-user-details?telegramUserId=101','customer-service']){
   const [base,query]=name.split('?');await page.goto(f.origin+'/'+base+'.html'+(query?'?'+query:''));assert.equal(await page.getByRole('link',{name:'Customer Service',exact:true}).count(),1);
   const nav=page.getByRole('navigation',{name:'Premium navigation'});
   assert.deepEqual(await nav.getByRole('link').allTextContents(),['Dashboard','Premium Users','Payments','Customer Service']);
   assert.equal(await page.getByRole('link',{name:'Back to Movie Admin',exact:true}).count(),1);
   assert.equal(await page.getByRole('button',{name:'Logout',exact:true}).count(),1);
   assert.equal(await page.getByText('More Premium pages coming soon.',{exact:true}).count(),0);
  }
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await f.close();}
});
