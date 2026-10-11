import { spawnRealTime as spawn,type ChildProcess } from "./taskClockProcess.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { terminateChild,trackCliChild } from "../pi/cliProcess.js";

export async function acquireGrokBrokerRealmLease(root:string,flock="flock"):Promise<Readonly<{close():Promise<void>}>>{
  const handle=await open(path.join(root,".daimon-broker-lease"),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);let child:ChildProcess|undefined;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600)throw new Error();child=trackCliChild(spawn("/bin/sh",["-c",'"$1" --exclusive --nonblock --conflict-exit-code 73 3 || exit 73; printf "ready\\n"; IFS= read -r _hold || :',"daimon-grok-broker-lease",flock],{detached:process.platform!=="win32",env:{PATH:process.env.PATH,LANG:"C",LC_ALL:"C",TZ:"UTC"},stdio:["pipe","pipe","ignore",handle.fd]}));await ready(child);let closed=false;return{close:async()=>{if(closed)return;closed=true;const exited=new Promise<boolean>((resolve)=>{if(child!.exitCode!==null||child!.signalCode!==null)return resolve(true);child!.once("close",()=>resolve(true));setTimeout(()=>resolve(false),500);});child!.stdin?.end();if(!await exited)await terminateChild(child!);}};}catch{if(child)await terminateChild(child).catch(()=>undefined);throw new Error("Grok broker realm is already in use or cannot be leased");}finally{await handle.close();}
}
function ready(child:ChildProcess):Promise<void>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error()),5000);const fail=()=>{clearTimeout(timer);reject(new Error());};child.once("error",fail);child.once("close",fail);child.stdout?.once("data",(chunk:Buffer)=>{clearTimeout(timer);if(chunk.toString()==="ready\n")resolve();else reject(new Error());});});}
