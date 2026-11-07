// Electron wraps errors thrown in the main process; people should only see the message itself.
export default function errorText(error:unknown){
 return (error instanceof Error?error.message:String(error))
  .replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:\w*Error: )?/,'');
}
