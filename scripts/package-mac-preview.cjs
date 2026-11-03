// Native packaging preserves app permissions, framework links and ad-hoc signing.
if(process.platform!=='darwin')throw Error('Mac版はMac上の npm run dist:mac またはGitHub Actionsでビルドしてください。');
const build=require('node:child_process').spawnSync('npm',['run','dist:mac'],{stdio:'inherit'});
process.exit(build.status??1);
