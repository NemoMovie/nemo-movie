import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import Database from 'better-sqlite3';
const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
async function fixture(t, large = false) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY, poster TEXT, title TEXT, type TEXT, year INTEGER, categories TEXT)');
    const rows = [[1,'beta','movie',2020,'Thailand'],[2,'Alpha','series',null,'Japan'],[3,'alpha','movie',2020,'Thailand'],[4,'100%','series',0,'Korea'],[5,'a_b!','movie',2025,'Japan']];
    const insert = db.prepare('INSERT INTO movies VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
        for (const [id,title,type,year,category] of rows) insert.run(id,'/uploads/test.webp',title,type,year,category);
        if (large) for (let id=6;id<=5000;id++) insert.run(id,'/uploads/test.webp','Synthetic '+id,'movie',2024,'Test');
    })();
    const app = vm.runInNewContext(source.slice(source.indexOf('const app = express();'), source.indexOf('if (isProduction) app.set'))+'\napp;', {express});
    const guards = source.slice(source.indexOf('function validAdminSession('),source.indexOf('app.get("/api/admin/check"')) + source.slice(source.indexOf('function requireAdmin('),source.indexOf('// GET movies with search'));
    // Synthetic session only; real sessions/login tested by existing integration tests.
    app.use((req,res,next)=> {req.session = req.get('test-admin') === 'yes' ? {isAdmin:true,credentialVersion:1} : {}; next();});
    vm.runInNewContext(guards + source.slice(source.indexOf('app.get("/api/admin/movies",'),source.indexOf('// GET one movie')), {app,db,adminAuth:{getCredential:()=>({credential_version:1})}});
    const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
    return async (query='',admin=true)=>{
        const r=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/movies${query?'?'+query:''}`,{headers:admin?{'test-admin':'yes'}:{}});
        assert.equal(r.headers.get('cache-control'),'no-store');
        return {status:r.status,body:await r.json()};
    };
}
test('Admin listing authorization, projection, defaults and page boundaries',async t=>{
    const req=await fixture(t);
    assert.equal((await req('',false)).status,401);
    const r=(await req()).body;
    assert.deepEqual(r.movies.map(m=>m.id),[5,4,3,2,1]);
    assert.deepEqual(Object.keys(r.movies[0]).sort(),['id','poster','title','type','year']);
    assert.deepEqual(r.stats,{totalContent:5,totalMovies:3,totalSeries:2});
    assert.equal(r.total,5);
    assert.deepEqual((await req('limit=2&page=3')).body.movies.map(m=>m.id),[1]);
    assert.deepEqual((await req('page=99')).body.movies,[]);
    assert.equal((await req('limit=100')).status,200);
});
test('Admin query validation rejects malformed and unsafe input',async t=>{
    const req=await fixture(t);
    for(const key of ['page','limit']) for(const value of ['0','-1','1.5','abc','','9007199254740992']) assert.equal((await req(`${key}=${value}`)).status,400);
    for(const q of ['limit=101','page=9007199254740991&limit=100','type=other','sort=constructor','sort=yearHigh','search='+ 'x'.repeat(151)]) assert.equal((await req(q)).status,400,q);
    for(const key of ['page','limit','search','type','sort']) assert.equal((await req(`${key}=1&${key}=2`)).status,400);
    for(const key of ['page','limit','search','type','sort']) assert.equal((await req(`${key}[]=1`)).status,400);
    assert.equal((await req('search='+ 'x'.repeat(150))).status,200);
});
test('Admin literal search, categories, year, type and global counts',async t=>{
    const req=await fixture(t);
    for(const [q,ids] of [['search=%20ALPHA%20',[3,2]],['search=thailand',[3,1]],['search=2020',[3,1]],['search=%25',[4]],['search=_',[5]],['search=!',[5]],['type=series',[4,2]],['type=movie',[5,3,1]],['type=series&search=alpha',[2]],['search=missing',[]]]) {
        const r=(await req(q)).body;
        assert.deepEqual(r.movies.map(m=>m.id),ids,q);assert.equal(r.total,ids.length);
        assert.equal(r.stats.totalContent,5);
    }
});
test('Admin all six deterministic sorts including NULL and zero years',async t=>{
    const req=await fixture(t);
    for(const [sort,ids] of Object.entries({newest:[5,4,3,2,1],oldest:[1,2,3,4,5],'title-asc':[4,5,3,2,1],'title-desc':[1,3,2,5,4],'year-desc':[5,3,1,4,2],'year-asc':[2,4,3,1,5]})) assert.deepEqual((await req('sort='+sort)).body.movies.map(m=>m.id),ids);
});
test('5000 synthetic titles return only 24 bounded rows and accurate totals',async t=>{
    const req=await fixture(t,true);const r=(await req()).body;
    assert.equal(r.movies.length,24);assert.equal(r.total,5000);
    assert.equal(r.movies[0].id,5000);assert(JSON.stringify(r).length<5000);
    assert.equal(r.movies.at(-1).id,4977);
    const last = (await req('page=209')).body.movies;
    assert.equal(last.length,8);
    assert.equal(last[0].id,8);
    assert.equal(last.at(-1).id,1);
    assert.equal((await req('page=208')).body.movies.length,24);
    assert.deepEqual((await req('page=210')).body.movies,[]);
});
