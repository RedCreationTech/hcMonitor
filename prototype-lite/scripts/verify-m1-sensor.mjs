import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const origin=process.env.M1_UI_ORIGIN || 'http://127.0.0.1:55290';const output=process.env.M1_UI_OUTPUT || '../docs/qa-m1/runtime/browser';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const errors=[];
try {
 const request=context.request;let r=await request.post(origin+'/v1/auth/login',{data:{employee:'W-02',pin:'Browser-QA-Password-2026!'}});assert(r.ok());
 const bytes=Buffer.alloc(44+96000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(96000,40);
 const csv=Buffer.from('t_s,hbo_mmol_mm_L\n'+Array.from({length:60},(_,i)=>`${i},${Math.sin(i)}`).join('\n'));
 const people=[['P1','interviewer'],['P2','subject']].map(([id,role])=>({id,role,purposes:{capture:true,analyze:true,review:true,report:true}}));
 r=await request.post(origin+'/v1/sessions',{data:{subject_code:'SENSOR-UI-FIXTURE',scene:'合成采样游标测试',consent_doc:'QA-ONLY',participants:people,assets:[{id:'AUDIO',name:'audio.wav',kind:'audio',size_bytes:bytes.length},{id:'SENSOR',name:'sensor.csv',kind:'nir',size_bytes:csv.length}],primary_asset_id:'AUDIO'}});assert(r.ok(),await r.text());const sid=(await r.json()).id;
 for(const [id,kind,name,buffer] of [['AUDIO','audio','audio.wav',bytes],['SENSOR','nir','sensor.csv',csv]]) {r=await request.post(origin+`/v1/sessions/${sid}/assets`,{multipart:{file:{name,mimeType:'application/octet-stream',buffer},kind,asset_id:id}});assert(r.ok(),await r.text());}
 assert((await request.post(origin+`/v1/sessions/${sid}/analyze-offline`,{data:{}})).ok());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+`/t/workstation/offline/${sid}`);
 const row=page.getByRole('row').filter({hasText:'合成采样趋势事件'});await row.getByRole('button',{name:'4s',exact:true}).click();await page.getByText('采样文件 sensor.csv · 文件内游标 4.00 秒',{exact:true}).waitFor();
 assert.equal(await page.locator('video').count(),0);assert.equal(await page.locator('#slice-SENSOR').count(),1); await page.getByRole('button',{name:'返回音视频',exact:true}).click(); assert.equal(await page.locator('video').count(),1); assert.deepEqual(errors,[]);
 await page.screenshot({path:output+'/sensor.png',fullPage:true});await fs.writeFile(output+'/sensor-result.json',JSON.stringify({passed:true,engine:'explicit synthetic fixture',sensorClock:4,audioDuration:3,csvNeverDecodedAsMedia:true,consoleErrors:errors},null,2));console.log('sensor cursor browser: passed');
}finally {await browser.close();}
