import { spawn } from "./taskClockProcess.js";
import { redactCredentialText } from "../core/credentialRedaction.js";
import { boundedDiagnosticWindow, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES } from "../pi/cliChildOutput.js";
import { terminateChild, trackCliChild } from "../pi/cliProcess.js";

export const ENGINE_BROKER_NATIVE_REQUEST_BYTES = 396;
export const ENGINE_BROKER_NATIVE_RESULT_BYTES = 128;
/** `DBL_MAX_DIAGNOSTIC`: the launcher's bounded tail of a failed worker's own merged stdout/stderr. */
export const ENGINE_BROKER_NATIVE_DIAGNOSTIC_BYTES = 512;
/** `DBL_MAX_OUTPUT`: the launcher's bound on a whole turn's stdout, and the control protocol's own `text` bound, which is the next boundary this output crosses. */
const MAX_PROMPT = 65_536, MAX_CAPABILITY = 4_096, MAX_OUTPUT = 262_144;
const statuses = ["ok", "prelaunch_failed", "worker_failed", "output_failed", "cancelled"] as const;
const stages = ["none", "peer", "request", "registration", "executable", "exec", "wait", "output", "attestation"] as const;
const failures = ["none", "peer", "protocol", "registration", "executable", "exec", "wait", "output_limit", "cancelled", "profile_missing", "profile_invalid"] as const;

export interface NativeBrokerDiagnostic { exitCode:number;failureClass:typeof failures[number];profileApplied:boolean;reason?:string;stage:typeof stages[number];startTicks:string;status:typeof statuses[number];termSignal:number;workerPid:number;workerUid:number }
export class NativeBrokerTurnFailure extends Error { constructor(readonly diagnostic:NativeBrokerDiagnostic){super("engine broker turn failed");} }
export type NativeBrokerTurn = Readonly<{slot:number;requestId:string;turnId:string;agentId:string;wakeId:string;prompt:string;providerCapability:string;mcpCapability:string}>;
export interface NativeBrokerTurnResult {text:string;workerPid:number;workerUid:number;startTicks:bigint;diagnostic:NativeBrokerDiagnostic}

export async function runNativeBrokerTurn(executable:string,input:NativeBrokerTurn,signal?:AbortSignal):Promise<Readonly<NativeBrokerTurnResult>>{
  const frame=encodeNativeBrokerTurn(input),child=trackCliChild(spawn(executable,["--client"],{detached:process.platform!=="win32",env:{LANG:"C",LC_ALL:"C",TZ:"UTC",DAIMON_BROKER_PID:String(process.pid)},stdio:["pipe","pipe","ignore"],...(signal===undefined?{}:{signal})}));const chunks:Buffer[]=[];let bytes=0;
  child.stdout!.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=ENGINE_BROKER_NATIVE_RESULT_BYTES+MAX_OUTPUT)chunks.push(chunk);});child.stdin!.end(frame);frame.fill(0);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});if(code!==0||bytes>ENGINE_BROKER_NATIVE_RESULT_BYTES+MAX_OUTPUT)throw new Error();return decodeNativeBrokerResult(Buffer.concat(chunks),input.turnId,[input.providerCapability,input.mcpCapability]);}catch(error){if(error instanceof NativeBrokerTurnFailure)throw error;throw new Error("engine broker turn failed");}finally{await terminateChild(child).catch(()=>undefined);}
}
export function encodeNativeBrokerTurn(input:NativeBrokerTurn):Buffer{if(!Number.isInteger(input.slot)||input.slot<0)throw new TypeError("invalid engine broker turn");const p=Buffer.from(input.prompt),provider=Buffer.from(input.providerCapability),mcp=Buffer.from(input.mcpCapability);if(p.length<1||p.length>MAX_PROMPT||provider.length<1||provider.length>MAX_CAPABILITY||mcp.length<1||mcp.length>MAX_CAPABILITY||provider.equals(mcp))throw new TypeError("invalid engine broker turn");const c=Buffer.alloc(4+provider.length+mcp.length);c.writeUInt16LE(provider.length,0);provider.copy(c,2);c.writeUInt16LE(mcp.length,2+provider.length);mcp.copy(c,4+provider.length);const frame=Buffer.alloc(ENGINE_BROKER_NATIVE_REQUEST_BYTES+8+p.length+c.length);frame.writeUInt32LE(2,0);frame.writeUInt32LE(input.slot,4);field(frame,8,65,input.requestId);field(frame,73,65,input.turnId);field(frame,138,129,input.agentId);field(frame,267,129,input.wakeId);let o=ENGINE_BROKER_NATIVE_REQUEST_BYTES;frame.writeUInt32LE(p.length,o);o+=4;p.copy(frame,o);o+=p.length;frame.writeUInt32LE(c.length,o);o+=4;c.copy(frame,o);p.fill(0);provider.fill(0);mcp.fill(0);c.fill(0);return frame;}

/**
 * `output` is accepted as any byte view, and normalized to a `Buffer` once
 * here: `Uint8Array.prototype.toString("utf8")` ignores its argument and
 * renders the bytes as comma-separated decimals, which is how a live worker's
 * last words reached an operator as `reason=108,111,110,101,...` instead of a
 * sentence. Decoding is explicit from here on, never a stringification.
 */
export function decodeNativeBrokerResult(input:Uint8Array,turnId:string,secrets:readonly string[]=[]):NativeBrokerTurnResult{
  const output=Buffer.isBuffer(input)?input:Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  if(output.length<ENGINE_BROKER_NATIVE_RESULT_BYTES)throw new Error("engine broker turn failed");
  const status=output.readUInt32LE(4),uid=output.readUInt32LE(8),length=output.readUInt32LE(12),pid=output.readInt32LE(16),exitCode=output.readInt32LE(20),termSignal=output.readInt32LE(24),ticks=output.readBigUInt64LE(32),stage=output.readUInt32LE(108),failure=output.readUInt32LE(112),profile=output.readUInt32LE(116),diagnosticLength=output.readUInt32LE(120),observed=output.subarray(40,105).toString("utf8").replace(/\0.*$/u,"");
  const paddingZero=[output.subarray(28,32),output.subarray(105,108),output.subarray(124,128)].every((bytes)=>bytes.every((byte)=>byte===0));
  if(output.length!==ENGINE_BROKER_NATIVE_RESULT_BYTES+length+diagnosticLength||output.readUInt32LE(0)!==2||status>=statuses.length||stage>=stages.length||failure>=failures.length||profile>1||!paddingZero||observed!==turnId||length>MAX_OUTPUT||diagnosticLength>ENGINE_BROKER_NATIVE_DIAGNOSTIC_BYTES)throw new Error("engine broker turn failed");
  // Decoded from the caller's own view, not from the normalized frame: the
  // decode is what must be correct for any byte view, and it is the step the
  // live `reason=108,111,110,...` failure came from.
  const reason=workerReason(input.subarray(ENGINE_BROKER_NATIVE_RESULT_BYTES+length),secrets);
  const diagnostic:NativeBrokerDiagnostic={status:statuses[status]!,stage:stages[stage]!,failureClass:failures[failure]!,profileApplied:profile===1,...(reason===undefined?{}:{reason}),exitCode,termSignal,workerPid:pid,workerUid:uid,startTicks:ticks.toString()};
  const success=status===0&&stage===7&&failure===0&&profile===0&&pid>0&&uid>=2200&&ticks>0n&&exitCode===0&&termSignal===0&&diagnosticLength===0;
  const prelaunch=status===1&&stage>=1&&stage<=5&&failure>=1&&failure<=5&&profile===0&&pid===0&&uid===0&&ticks===0n&&diagnosticLength===0;
  const worker=status===2&&stage===6&&(failure===5||failure===6)&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  const outputFailure=status===3&&stage===7&&failure===7&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  const cancelled=status===4&&stage===6&&failure===8&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  if(!success){if(length!==0||(!prelaunch&&!worker&&!outputFailure&&!cancelled))throw new Error("engine broker turn failed");throw new NativeBrokerTurnFailure(diagnostic);}
  return{text:output.subarray(ENGINE_BROKER_NATIVE_RESULT_BYTES).toString("utf8"),workerUid:uid,workerPid:pid,startTicks:ticks,diagnostic};
}
/**
 * The worker's own last words, fit to cross a boundary.
 *
 * A failed brokered turn otherwise reports nothing but `exit=1`: the launcher
 * merges the worker's stdout and stderr into one pipe and publishes no output
 * for a failure, so this bounded window is the only account of why it failed.
 * It keeps both ends of what it is given (`boundedDiagnosticWindow`), because
 * a worker that dies early prints its error before it echoes anything.
 * It is worker-controlled text, so it is redacted exactly as the CLI child
 * path redacts a failed engine child (`redactCredentialText` with the turn's
 * own capabilities as exact secrets, the same diagnostic bound) and flattened
 * to one line, because it travels inside a failure message.
 */
function workerReason(tail:Uint8Array,secrets:readonly string[]):string|undefined{
  if(tail.byteLength===0)return undefined;
  // Decoded explicitly, and with replacement rather than a throw: the window
  // is a byte count, so it can cut a multi-byte sequence in half at either
  // end, and a worker's last words must not be lost to its own encoding.
  const flattened=UTF8.decode(tail).replace(/[\u0000-\u001f\u007f]+/gu," ").replace(/\s+/gu," ").trim();
  // Redact first, unbounded, then window: redaction can lengthen the text
  // ([REDACTED] is longer than a short secret), so bounding before it could
  // hand back more bytes than the boundary admits.
  const redacted=redactCredentialText(scrubCutFragments(flattened,secrets),secrets,Number.MAX_SAFE_INTEGER).trim();
  const reason=boundedDiagnosticWindow(redacted,CLI_ENGINE_MAX_DIAGNOSTIC_BYTES).trim();
  return reason.length===0?undefined:reason;
}
/** Non-fatal by construction: a cut multi-byte sequence becomes U+FFFD, never an exception. */
const UTF8=new TextDecoder("utf-8");

/**
 * A credential the launcher's window cut in half, at either side of a cut.
 *
 * Exact redaction matches a secret whole, so a secret a cut split survives as
 * a fragment it can never match: the piece before a cut can end with a
 * secret's prefix, and the piece after it can begin with a secret's suffix.
 * The trick that answers this where Daimon owns both ends — retain one whole
 * secret more than is reported (`cliChildOutput.ts`) — cannot work at this
 * boundary, because the launcher's window *is* what it sends: a margin
 * reserved there would be reported along with everything else. So the fragment
 * is matched here, where the turn's own capabilities are known, and every cut
 * the window can make is covered: the two sides of each elision marker, and
 * the outer ends, where the launcher's capture itself stopped reading.
 *
 * Only a fragment long enough to be a credential is scrubbed. Below
 * {@link MIN_CREDENTIAL_FRAGMENT} characters a piece of a random token is
 * indistinguishable from ordinary words and carries nothing usable, and
 * scrubbing it would eat real text.
 */
const MIN_CREDENTIAL_FRAGMENT=12;
const ELISION_MARKER=/(\[… \d+ bytes elided …\])/u;
const scrubCutFragments=(value:string,secrets:readonly string[]):string=>
  value.split(ELISION_MARKER).map((part)=>ELISION_MARKER.test(part)?part:scrubEnds(part,secrets)).join("");
function scrubEnds(part:string,secrets:readonly string[]):string{
  let result=part;
  for(const secret of secrets){
    if(secret.length<=MIN_CREDENTIAL_FRAGMENT)continue;
    for(let length=Math.min(secret.length-1,result.length);length>=MIN_CREDENTIAL_FRAGMENT;length-=1){
      if(result.endsWith(secret.slice(0,length))){result=`${result.slice(0,result.length-length)}[REDACTED]`;break;}
    }
    for(let length=Math.min(secret.length-1,result.length);length>=MIN_CREDENTIAL_FRAGMENT;length-=1){
      if(result.startsWith(secret.slice(secret.length-length))){result=`[REDACTED]${result.slice(length)}`;break;}
    }
  }
  return result;
}
function field(target:Buffer,offset:number,length:number,value:string):void{if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)||Buffer.byteLength(value)>=length)throw new TypeError("invalid engine broker turn");target.write(value,offset,"utf8");}
