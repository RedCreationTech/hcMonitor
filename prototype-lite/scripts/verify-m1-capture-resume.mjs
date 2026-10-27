import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const origin='http://127.0.0.1:55290',output=fileURLToPath(new URL('../../docs/qa-m1/runtime/segments',import.meta.url));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const ctx=await browser.newContext({viewport:{width:1440,height:1000},permissions:['camera','microphone']}),page=await ctx.newPage(),errors=[];
const trace=[];page.on('request',r=>{if(r.url().includes('/v1/')&&!r.url().endsWith('/state'))trace.push({at:Date.now(),request:r.method()+' '+new URL(r.url()).pathname});});page.on('response',r=>{if(r.url().includes('/v1/')&&!r.url().endsWith('/state'))trace.push({at:Date.now(),status:r.status(),url:new URL(r.url()).pathname});});
page.on('pageerror',e=>errors.push(e.message));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function openCapture(subject,failStart=false){
 await page.getByRole('button',{name:'本机录制',exact:true}).click();const modal=page.getByRole('dialog');
 await modal.getByLabel('对象编号',{exact:true}).fill(subject);await modal.getByLabel('场景',{exact:true}).fill('分段浏览器合成测试');await modal.getByLabel('告知文书编号',{exact:true}).fill('QA-ONLY');
 for(const text of ['两名参与者均已授权采集及本次分析','两名参与者均已授权指定专家查看与复核','两名参与者均已授权报告编制与分发'])await modal.getByRole('checkbox',{name:text,exact:true}).check();
 if(failStart)await page.evaluate(()=>{const start=MediaRecorder.prototype.start;MediaRecorder.prototype.start=function(){MediaRecorder.prototype.start=start;throw new Error('合成首次启动失败');};});
 await modal.getByRole('button',{name:'开始录制',exact:true}).click();
 if(failStart){await modal.getByText('合成首次启动失败',{exact:true}).waitFor();await modal.locator('.ant-modal-close').click();return;}
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);return modal;
}
async function state(){return (await ctx.request.get(origin+'/v1/state')).json();}
try{
 await fs.mkdir(output,{recursive:true});await page.goto(origin);await page.getByPlaceholder('W-02 / R-01 / C-04 / A-01').fill('W-02');await page.getByPlaceholder('请输入本地账号口令').fill('Browser-QA-Password-2026!');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await openCapture('FAILED-START-SYNTHETIC',true);
 let modal=await openCapture('PAUSED-STOP-SYNTHETIC');await sleep(3500);await modal.getByRole('button',{name:'暂停录制',exact:true}).click();await modal.getByRole('button',{name:'恢复录制',exact:true}).waitFor();await modal.getByRole('button',{name:'结束并分析',exact:true}).click();await modal.waitFor({state:'hidden',timeout:30000});
 let saved=(await state()).sessions.filter(s=>s.subject_code==='PAUSED-STOP-SYNTHETIC').at(-1);assert.equal(saved.assets.length,1);assert.equal(saved.capture.segments[0].closed_by,'pause');
 modal=await openCapture('RESUME-ERROR-SYNTHETIC');await sleep(3000);await modal.getByRole('button',{name:'暂停录制',exact:true}).click();await modal.getByRole('button',{name:'恢复录制',exact:true}).waitFor();
 await page.evaluate(()=>{const start=MediaRecorder.prototype.start;MediaRecorder.prototype.start=function(){MediaRecorder.prototype.start=start;throw new Error('合成恢复启动失败');};});
 await modal.getByRole('button',{name:'恢复录制',exact:true}).click();await modal.getByRole('button',{name:'重试上传并分析',exact:true}).waitFor({timeout:8000});await modal.getByRole('button',{name:'重试上传并分析',exact:true}).click();await modal.waitFor({state:'hidden',timeout:30000});
 saved=(await state()).sessions.filter(s=>s.subject_code==='RESUME-ERROR-SYNTHETIC').at(-1);assert.equal(saved.assets.length,1);assert.equal(saved.capture.omitted_segments.length,1);
 modal=await openCapture('RECOVERY-SYNTHETIC');await sleep(3500);await modal.getByRole('button',{name:'暂停录制',exact:true}).click();await modal.getByRole('button',{name:'恢复录制',exact:true}).click();await sleep(3000);
 let completes=0;await page.route('**/v1/uploads/*/complete',route=>{completes++;return completes===2?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'合成上传中断'})}):route.continue();});
 await modal.getByRole('button',{name:'结束并分析',exact:true}).click();await modal.getByRole('button',{name:'重试上传并分析',exact:true}).waitFor();
 saved=(await state()).sessions.filter(s=>s.subject_code==='RECOVERY-SYNTHETIC').at(-1);assert.equal(saved.assets.filter(a=>a.upload_status==='complete').length,1);
 await page.unroute('**/v1/uploads/*/complete');await page.reload();await page.getByRole('button',{name:'本机录制',exact:true}).click();modal=page.getByRole('dialog');await modal.getByRole('button',{name:'下载第2段原件',exact:true}).waitFor();await modal.getByRole('button',{name:'重试上传并分析',exact:true}).click();await modal.waitFor({state:'hidden',timeout:30000});
 saved=(await state()).sessions.filter(s=>s.subject_code==='RECOVERY-SYNTHETIC').at(-1);assert.equal(saved.assets.length,2);assert(saved.assets.every(a=>a.upload_status==='complete'));
 const source=saved.assets[0];const bytes=await (await ctx.request.get(`${origin}/v1/sessions/${saved.id}/assets/${source.id}/media`)).body();
 const body={subject_code:'LEGACY-RANGES-SYNTHETIC',scene:'旧录制有效区间',source:'live',consent_doc:'QA-ONLY',participants:saved.participants,assets:[{id:'AS-LEGACY',kind:'video',name:'legacy.webm',size_bytes:bytes.length,duration_seconds:0}],primary_asset_id:'AS-LEGACY',capture:{gaps:[{at:1,kind:'pause'}]}};
 let r=await ctx.request.post(origin+'/v1/sessions',{data:body});assert(r.ok(),await r.text());const sid=(await r.json()).id;
 r=await ctx.request.post(`${origin}/v1/sessions/${sid}/assets`,{multipart:{file:{name:'legacy.webm',mimeType:'video/webm',buffer:bytes},kind:'video',asset_id:'AS-LEGACY'}});assert(r.ok(),await r.text());
 await page.goto(`${origin}/t/workstation/offline/${sid}`);await page.getByRole('button',{name:'开始 / 重试分析',exact:true}).click();await page.getByText('逐句转写与匿名角色校正',{exact:true}).waitFor();
 for(let i=1;i<=2;i++){await page.getByRole('button',{name:'添加连续有效区间',exact:true}).click();await page.getByLabel(`区间${i}开始秒`,{exact:true}).fill(i===1?'0':'1.2');await page.getByLabel(`区间${i}结束秒`,{exact:true}).fill(i===1?'0.6':'1.8');}
 await page.getByLabel('有效区间核验依据',{exact:true}).fill('合成夹具逐段回看，排除中部区间；不用于真人效果结论');await page.getByText('已逐段回看，确认区间内连续有效',{exact:true}).click();await page.getByRole('button',{name:'保存有效区间并标记待重算',exact:true}).click();await page.getByText('以下算法结果来自旧修订，不能送审或发布；请完成重算和重新复核。',{exact:true}).waitFor();
 saved=(await state()).sessions.find(s=>s.id===sid);assert.equal(saved.analysis_intervals.ranges.length,2);assert.equal(saved.revision,2);
 await page.screenshot({path:output+'/legacy-ranges.png',fullPage:true});await page.getByRole('button',{name:'按修订重算',exact:true}).click();await page.getByRole('button',{name:'开始 / 重试分析',exact:true}).waitFor();
 const runs=await (await ctx.request.get(`${origin}/v1/sessions/${sid}/runs`)).json();assert.equal(runs.length,2);
 await page.locator('.ant-select').filter({hasText:'历史运行'}).first().locator('.ant-select-selector').click();await page.getByText(`${runs[0].id} · ${runs[0].status}`,{exact:true}).click();await page.getByText('正在查看不可变历史运行；校正与复核操作关闭。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'保存有效区间并标记待重算',exact:true}).count(),0);assert.deepEqual(errors,[]);
 await fs.writeFile(new URL('../../docs/qa-m1/segments-browser-summary.json',import.meta.url),JSON.stringify({passed:true,fixture:'Chrome virtual devices and explicit synthetic detector',failedStartDoesNotLeaveEmptyCache:true,pauseThenStop:true,twoFileResume:true,failedResumeRetainsValidPart:true,emptyPartAudited:true,partialUploadRetryAfterReload:true,legacyRangeEditor:true,newRevisionAndRun:true,oldRunRetained:true,historicalViewDoesNotShowCurrentRanges:true,consoleErrors:errors},null,2));console.log('failed start, pause-stop, failed resume, recovery, ranges and immutable history: passed');
}catch(e){await fs.writeFile(output+'/request-trace.json',JSON.stringify(trace,null,2));await page.screenshot({path:output+'/failure.png',fullPage:true});console.error(await page.locator('body').innerText());throw e;}finally{await browser.close();}
