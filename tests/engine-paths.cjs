const assert=require('node:assert/strict');
const {engineRoot}=require('../electron/paths.cjs');
assert.equal(engineRoot('/Downloads/YuiVoiceChanger.app/Contents/Resources/app.asar','/Downloads/YuiVoiceChanger.app/Contents/Resources',false),'/Downloads/YuiVoiceChanger.app/Contents/Resources');
assert.equal(engineRoot('C:\\apps\\resources\\app.asar','C:\\apps\\resources',false),'C:\\apps\\resources');
assert.equal(engineRoot('/source/YuiVoiceChanger','/electron/resources',false),'/source/YuiVoiceChanger');
assert.equal(engineRoot('/app','/app/resources',true),'/app/resources');
console.log('PASS archived Mac/Windows apps use a real engine working directory, development uses source');
