import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
    constructor(){this.children=[];this.events={};this.value='';this.dataset={};this.classList={add(){}};}
    set innerHTML(v){this.children=[];} set textContent(v){this.text=String(v);this.children=[];} get textContent(){return this.text;}
    appendChild(e){this.children.push(e);} before(e){this.message=e;} setAttribute(){}
    addEventListener(name,fn){this.events[name]=fn;}
}
function fixture(){
    const elements={};const get=id=>elements[id]??=new Element();get('typeFilter').value='all';get('sortFilter').value='newest';
    const pending=[];const timers=new Map();let timer=0;
    const context=vm.createContext({URLSearchParams,API_URL:'',document:{getElementById:get,createElement:()=>new Element()},window:{location:{href:''},addEventListener(){}},navigator:{},confirm:()=>true,
        setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
        fetch:(url,options)=>url==='/api/admin/check'?Promise.resolve({status:200,ok:true}):new Promise(resolve=>pending.push({url,options,resolve}))});
    vm.runInContext(fs.readFileSync(new URL('../frontend/admin.js',import.meta.url),'utf8').replace('import { API_URL } from "./config.js";',''),context);
    const run=code=>vm.runInContext(code,context);
    const reply=(request,total=49,status=200)=>request.resolve({status,ok:status===200,json:async()=>({movies:total?[{id:41,title:'Test',type:'movie',poster:'/uploads/a.webp',year:2020}]:[],total,stats:{totalContent:5000,totalMovies:4000,totalSeries:1000}})});
    return {get,pending,run,reply,timers,context};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Admin page fetch, bounded controls, numbering and global stats',async()=>{
    const f=fixture();f.run('currentPage=100;loadAdminMovies()');f.reply(f.pending[0],5000);await tick();
    assert.match(f.pending[0].url,/page=100&limit=24/);assert.equal(f.pending[0].options.credentials,'include');
    assert.equal(f.get('adminMovieList').children[0].children[1].textContent,'2377 - Test');
    assert(f.get('pagination').children.length<=7);assert.equal(f.get('totalContent').textContent,'5000');
});
test('Admin debounce, Enter, sort mapping and stale responses',async()=>{
    const f=fixture();f.run('loadAdminMovies()');f.get('searchInput').value='love';f.get('searchInput').events.input();
    f.reply(f.pending[0]);await tick();assert.equal(f.get('adminMovieList').children.length,0);
    assert.equal(f.timers.size,1);f.get('searchInput').events.keydown({key:'Enter',preventDefault(){}});assert.equal(f.timers.size,0);
    f.get('sortFilter').value='titleAZ';f.get('sortFilter').events.change();assert.match(f.pending[2].url,/sort=title-asc/);
    f.reply(f.pending[2],0);await tick();f.reply(f.pending[1]);await tick();assert.equal(f.get('adminMovieList').children.length,0);
});
test('Admin delete last final-page row clamps to last page; failures do not redirect',async()=>{
    const f=fixture();f.run('currentPage=3;loadAdminMovies()');f.reply(f.pending[0]);await tick();
    const row=f.get('adminMovieList').children[0];row.children.at(-1).events.click();
    assert.equal(f.pending[1].options.method,'DELETE');f.reply(f.pending[1]);await tick();
    assert.match(f.pending[2].url,/page=3/);f.reply(f.pending[2],48);await tick();assert.match(f.pending[3].url,/page=2/);
    f.reply(f.pending[3],48);await tick();assert.equal(f.run('currentPage'),2);
    f.run('loadAdminMovies()');f.reply(f.pending[4],0,500);await tick();assert.equal(f.context.window.location.href,'');assert.match(f.get('adminMovieList').message.textContent,/Could not load/);
    f.run('loadAdminMovies()');f.reply(f.pending[5],0,401);await tick();assert.equal(f.context.window.location.href,'login.html');
});
