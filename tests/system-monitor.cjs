const assert=require('node:assert/strict');
const {parseNvidiaSmi,cpuUsage,judge,SystemMonitor,formatLogLine}=require('../electron/system-monitor.cjs');

// nvidia-smi output
assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 97 %, 12 %, 7000 MiB, 8192 MiB, 71, 0x0000000000000400\n'),
 {name:'NVIDIA GeForce RTX 3060 Ti',util:97,encoder:12,vramUsedMb:7000,vramTotalMb:8192,temperature:71,thermalLimit:false});
assert.equal(parseNvidiaSmi('A, 1 %, 0 %, 1 MiB, 10 MiB, 40, 0x0000000000000040\n').thermalLimit,true,'hardware thermal slowdown');
assert.equal(parseNvidiaSmi('A, 1 %, 0 %, 1 MiB, 10 MiB, 40, 0x0000000000000020\n').thermalLimit,true,'software thermal slowdown');
assert.equal(parseNvidiaSmi('A, 1 %, [N/A], 1 MiB, 10 MiB, [N/A], [N/A]\n').encoder,null);
assert.equal(parseNvidiaSmi('A, 5 %, 0 %, 1 MiB, 10 MiB, 40, 0x0\nB, 90 %, 0 %, 2 MiB, 10 MiB, 40, 0x0\n').name,'B','the busiest GPU is the one that matters');
assert.equal(parseNvidiaSmi(''),null);
assert.equal(parseNvidiaSmi('Failed to initialize NVML: Driver Not Loaded\n'),null);

// CPU deltas
const cpu=(busy,idle)=>({times:{user:busy,nice:0,sys:0,irq:0,idle}});
assert.deepEqual(cpuUsage([cpu(0,0),cpu(0,0)],[cpu(50,50),cpu(100,0)]),{total:75,busiest:100});
assert.deepEqual(cpuUsage([cpu(5,5)],[cpu(5,5)]),{total:0,busiest:0});

// Verdicts
const roomy={cpu:{total:30,busiest:50},ramFreeRatio:.5,gpu:{util:40,vramUsedMb:1000,vramTotalMb:8000,thermalLimit:false}};
const kinds=(sample,behind)=>judge(sample,behind).map(item=>item.kind);
assert.deepEqual(kinds(roomy,false),['ok']);
assert.deepEqual(kinds(roomy,true),['other']);
assert.deepEqual(kinds({...roomy,gpu:{...roomy.gpu,util:97}},true),['gpu']);
assert.deepEqual(kinds({...roomy,gpu:{...roomy.gpu,util:97}},false),['ok'],'a busy GPU that keeps up is fine');
assert.deepEqual(kinds({...roomy,gpu:{...roomy.gpu,vramUsedMb:7600}},true),['vram']);
assert.deepEqual(kinds({...roomy,gpu:{...roomy.gpu,thermalLimit:true}},true),['thermal']);
assert.deepEqual(kinds({...roomy,cpu:{total:95,busiest:100}},true),['cpu']);
assert.deepEqual(kinds({...roomy,cpu:{total:40,busiest:100}},true),['cpu'],'one saturated core can hold conversion back');
assert.deepEqual(kinds({...roomy,ramFreeRatio:.05},false),['memory'],'low memory is worth reporting even before audio suffers');
assert.deepEqual(kinds({...roomy,ramFreeRatio:.05,gpu:{...roomy.gpu,util:97}},true),['gpu','memory']);
assert.deepEqual(kinds({...roomy,gpu:null},false),['ok']);
assert.deepEqual(kinds({...roomy,gpu:null},true),['other']);
for(const kind of ['ok','other','gpu','vram','thermal','cpu','memory']){
 const sample=kind==='memory'?{...roomy,ramFreeRatio:.05}:kind==='cpu'?{...roomy,cpu:{total:95,busiest:100}}:kind==='gpu'?{...roomy,gpu:{...roomy.gpu,util:97}}:kind==='vram'?{...roomy,gpu:{...roomy.gpu,vramUsedMb:7600}}:kind==='thermal'?{...roomy,gpu:{...roomy.gpu,thermalLimit:true}}:roomy;
 const verdict=judge(sample,!['ok','memory'].includes(kind))[0];
 assert.equal(verdict.kind,kind);assert(verdict.message.length>0);
}

// Log line
const line=formatLogLine('2026-11-07 20:00:00',{cpu:{total:75.4,busiest:100},ramFreeRatio:.25,ramFreeGb:4,ramTotalGb:16,gpu:{name:'RTX',util:97,encoder:12,vramUsedMb:7000,vramTotalMb:8192,temperature:71,thermalLimit:false}},true,[{kind:'gpu'}]);
assert.equal(line,'2026-11-07 20:00:00 System: cpu=75% busiest_core=100% ram_free_gb=4.0/16.0 gpu=97% encoder=12% vram_mb=7000/8192 gpu_temp=71 thermal_limit=false behind=true verdict=gpu');
assert.match(formatLogLine('t',{cpu:{total:1,busiest:2},ramFreeRatio:.5,ramFreeGb:8,ramTotalGb:16,gpu:null},false,[{kind:'ok'}]),/gpu=unavailable behind=false verdict=ok$/);

// Monitor: behind is measured against the previous sample, and each conversion starts clean.
(async()=>{
 const logged=[],published=[];let timer=null;
 const monitor=new SystemMonitor({
  publish:status=>published.push(status),writeLog:line=>logged.push(line),stamp:()=>'t',
  readGpu:async()=>({name:'RTX',util:97,encoder:0,vramUsedMb:1,vramTotalMb:10,temperature:50,thermalLimit:false}),
  readCpus:()=>[cpu(1,1)],readMemory:()=>({free:8*2**30,total:16*2**30}),
  setTimer:callback=>{timer=callback;return 1;},clearTimer:()=>{timer=null;},
 });
 monitor.start();assert.equal(typeof timer,'function');
 monitor.observe({late_blocks:0,dropped:0,skipped_blocks:0});
 await monitor.sample();
 assert.deepEqual(published.at(-1).verdicts.map(item=>item.kind),['ok']);assert.equal(published.at(-1).behind,false);
 monitor.observe({late_blocks:3,dropped:0,skipped_blocks:0});
 await monitor.sample();
 assert.deepEqual(published.at(-1).verdicts.map(item=>item.kind),['gpu']);assert.equal(published.at(-1).behind,true);
 assert.deepEqual(published.at(-1).found,{gpu:1});
 await monitor.sample();
 assert.equal(published.at(-1).behind,false,'no new late blocks means it recovered');
 assert.deepEqual(published.at(-1).found,{gpu:1},'what was found stays visible after it recovers');
 monitor.observe({late_blocks:3,dropped:1,skipped_blocks:0});await monitor.sample();
 assert.deepEqual(published.at(-1).found,{gpu:2});
 monitor.observe({late_blocks:3,dropped:1,skipped_blocks:2});await monitor.sample();
 assert.deepEqual(published.at(-1).found,{gpu:3});
 assert.match(logged.at(-1),/System: .*behind=true verdict=gpu/);
 monitor.stop();assert.equal(timer,null);
 // Sampling that finishes after stop must not report.
 const count=published.length;await monitor.sample();assert.equal(published.length,count);
 monitor.start();monitor.observe({late_blocks:0,dropped:0,skipped_blocks:0});await monitor.sample();
 assert.deepEqual(published.at(-1).found,{},'a new conversion starts clean');
 monitor.stop();
 // A broken reader never takes the audio app down.
 const quiet=new SystemMonitor({publish:status=>published.push(status),writeLog:()=>{throw Error('disk full');},stamp:()=>'t',readGpu:async()=>{throw Error('no gpu');},readCpus:()=>[cpu(1,1)],readMemory:()=>({free:1,total:2}),setTimer:()=>1,clearTimer:()=>{}});
 quiet.start();await quiet.sample();assert.equal(published.at(-1).sample.gpu,null);quiet.stop();
 console.log('PASS system monitor parses, judges only real slowdowns, logs and survives missing readers');
})().catch(error=>{console.error(error);process.exitCode=1;});
