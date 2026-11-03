const effectDefaults={fx_enabled:false,fx_lowcut:80,fx_brightness:0,fx_compressor:0,fx_deesser:0,fx_reverb:0,fx_echo:0,fx_echo_ms:250,fx_limiter:true};
const effectRanges={fx_lowcut:[0,200],fx_brightness:[-6,6],fx_compressor:[0,100],fx_deesser:[0,100],fx_reverb:[0,50],fx_echo:[0,50],fx_echo_ms:[80,1000]};
module.exports={effectDefaults,effectRanges};
