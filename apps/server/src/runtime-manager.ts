import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostRecord, ThreadRecord } from "@cwb/storage";
import { SshConnection, TmuxCodexRuntime, TerminalSnapshotRenderer, withPrependedPath, type RemoteSession, type CommandStream } from "@cwb/remote-runtime";
import { CodexClient } from "@cwb/codex-client";

export interface RuntimeEvent { threadId: string; type: "codex" | "terminal"; payload: unknown }
export interface RuntimeManager {
  events: EventEmitter;
  create(host: HostRecord, thread: ThreadRecord): Promise<string>;
  resume(host: HostRecord, thread: ThreadRecord, codexThreadId: string): Promise<void>;
  reconnect(host: HostRecord, thread: ThreadRecord): Promise<void>;
  detach?(threadId: string): Promise<void>;
  exit(thread: ThreadRecord, host?: HostRecord): Promise<void>;
  send(thread: ThreadRecord, text: string): Promise<string | undefined>;
  interrupt(thread: ThreadRecord): Promise<void>;
  resolve(thread: ThreadRecord, requestId: string | number, value: unknown): Promise<void>;
  prepareTerminal(thread: ThreadRecord): Promise<void>;
  terminalInput(thread: ThreadRecord, data: string): Promise<void>;
  terminalSeed(thread:ThreadRecord):Promise<string>;
  screenshot(thread: ThreadRecord): Promise<Buffer | undefined>;
  hostStatus?(hostId:string): "online"|"connecting"|"offline";
  listHistorical?(host:HostRecord):Promise<Array<{id:string;title?:string;cwd?:string;updatedAt?:string}>>;
  close(): Promise<void>;
  setHostPassword?(hostId: string, password?: string): void;
}

interface Active { hostId:string;ssh: SshConnection; runtime: TmuxCodexRuntime; session: RemoteSession; client: CodexClient; forward: {port:number;close():Promise<void>}; stream?: CommandStream; turnId?: string; tmuxCreated:boolean;hasRollout:boolean }
interface RetryState { host:HostRecord;thread:ThreadRecord;attempt:number;timer?:NodeJS.Timeout;cancelled:boolean }
export interface HostRuntimeManagerOptions {
  sshFactory?: (config:ConstructorParameters<typeof SshConnection>[0])=>SshConnection;
  runtimeFactory?: (ssh:SshConnection)=>TmuxCodexRuntime;
  clientFactory?: (url:string)=>CodexClient;
  retryBaseMs?:number;
  retryMaxMs?:number;
  retryLimit?:number;
}

export class HostRuntimeManager implements RuntimeManager {
  readonly events = new EventEmitter();
  private readonly active = new Map<string, Active>();
  private readonly connecting=new Set<string>();
  private readonly retries=new Map<string,RetryState>();
  private readonly detached=new Set<string>();
  private closing=false;
  private readonly hostPasswords = new Map<string, string>();
  constructor(private readonly options:HostRuntimeManagerOptions={}){}
  setHostPassword(hostId:string,password?:string):void{if(password)this.hostPasswords.set(hostId,password);else this.hostPasswords.delete(hostId);}
  hostStatus(hostId:string):"online"|"connecting"|"offline"{if([...this.active.values()].some(active=>active.hostId===hostId))return "online";return this.connecting.has(hostId)?"connecting":"offline";}
  async listHistorical(host:HostRecord){
    const active=[...this.active.values()].find(value=>value.hostId===host.id);
    if(active)return this.historicalFrom(active.client);
    let lastError:unknown;
    for(let attempt=0;attempt<5;attempt++){
      const suffix=randomUUID().replaceAll("-","").slice(0,16),thread:ThreadRecord={id:`history-${suffix}`,hostId:host.id,tmuxSession:`cwb-history-${suffix}`,remotePort:randomInt(20000,60000),workingDirectory:".",title:"history probe",status:"connecting",createdAt:Date.now(),updatedAt:Date.now()};
      let probe:Active|undefined;
      try{probe=await this.open(host,thread);return await this.historicalFrom(probe.client);}
      catch(error){lastError=error;}
      finally{if(probe)await this.dispose(probe,{stopTmux:true});}
    }
    throw lastError instanceof Error?lastError:new Error("unable to start Codex history probe");
  }
  async create(host: HostRecord, thread: ThreadRecord): Promise<string> {
    this.detached.delete(thread.id);
    const active = await this.open(host, thread);
    try{const created = await active.client.createThread({ cwd: thread.workingDirectory });active.hasRollout=false;await this.activate(host,{...thread,codexThreadId:created.id},active,false);return created.id;}
    catch(error){await this.dispose(active,{stopTmux:active.tmuxCreated&&!this.detached.has(thread.id)});throw error;}
  }
  async resume(host: HostRecord, thread: ThreadRecord, codexThreadId: string): Promise<void> {
    this.detached.delete(thread.id);
    const active = await this.open(host, thread);
    try{await active.client.resumeThread(codexThreadId, { cwd: thread.workingDirectory });if(active.hasRollout)active.session = await active.runtime.attachViewer(active.session, thread.workingDirectory, codexThreadId, thread.proxy);await this.activate(host,thread,active,active.hasRollout);}
    catch(error){await this.dispose(active,{stopTmux:active.tmuxCreated&&!this.detached.has(thread.id)});throw error;}
  }
  async reconnect(host: HostRecord, thread: ThreadRecord): Promise<void> { if(this.active.has(thread.id))return;if(!thread.codexThreadId)throw new Error("thread has no Codex id");this.detached.delete(thread.id);this.events.emit("connectionGenerationChanged",{threadId:thread.id});this.cancelRetry(thread.id);const state={host,thread,attempt:0,cancelled:false};this.retries.set(thread.id,state);await this.tryReconnect(state); }
  async detach(threadId:string):Promise<void>{this.detached.add(threadId);this.cancelRetry(threadId);const active=this.active.get(threadId);if(!active)return;this.active.delete(threadId);void this.dispose(active,{stopTmux:false});}
  async exit(thread: ThreadRecord, host?:HostRecord): Promise<void> { this.cancelRetry(thread.id);const active=this.active.get(thread.id);if(active){this.active.delete(thread.id);await this.dispose(active,{stopTmux:true,requireStop:true});return;}if(!host)throw new Error("host is required to exit a disconnected thread");const ssh=await this.createSsh(host);try{await ssh.connect();await (this.options.runtimeFactory?.(ssh)??new TmuxCodexRuntime(withPrependedPath(ssh,combinedPrependPath(host,thread)))).stop(thread.tmuxSession);}finally{ssh.close();} }
  async send(thread: ThreadRecord, text: string): Promise<string | undefined> { const active = this.must(thread.id); const result = await active.client.startTurn(thread.codexThreadId!, text) as { turn?: { id?: string } }; active.turnId = result.turn?.id;active.hasRollout=true;await this.prepareTerminal(thread);return active.turnId; }
  async interrupt(thread: ThreadRecord): Promise<void> { const active = this.must(thread.id); if (active.turnId) await active.client.interruptTurn(thread.codexThreadId!, active.turnId); }
  async resolve(thread: ThreadRecord, requestId: string | number, value: unknown): Promise<void> { this.must(thread.id).client.respond(requestId, value as never); }
  async prepareTerminal(thread:ThreadRecord):Promise<void>{const active=this.must(thread.id);if(!active.hasRollout)throw new Error("terminal is unavailable until the first message is sent");if(active.session.viewerPane&&active.stream)return;try{if(!active.session.viewerPane)active.session=await active.runtime.attachViewer(active.session,thread.workingDirectory,thread.codexThreadId!,thread.proxy);if(!active.stream)await this.attachTerminal(thread.id,active);}catch(error){this.connectionLost(thread.id,active,"viewer attach failed");throw error;}}
  async terminalInput(thread: ThreadRecord, data: string): Promise<void> { await this.prepareTerminal(thread);const active = this.must(thread.id); await active.runtime.sendKeys(active.session, data); }
  async terminalSeed(thread:ThreadRecord):Promise<string>{const active=this.must(thread.id);if(!active.hasRollout)return "";return active.runtime.capture(active.session,1000);}
  async screenshot(thread: ThreadRecord): Promise<Buffer | undefined> { const active=this.must(thread.id);if(!active.hasRollout)return;await this.prepareTerminal(thread);const [ansi,size]=await Promise.all([active.runtime.capture(active.session),active.runtime.dimensions(active.session)]);return (await new TerminalSnapshotRenderer().render(ansi,size)).png; }
  async close(): Promise<void> { this.closing=true;for(const id of this.retries.keys())this.cancelRetry(id);for (const [threadId,active] of [...this.active]) {this.active.delete(threadId);await this.dispose(active,{stopTmux:false});} }
  private async open(host: HostRecord, thread: ThreadRecord): Promise<Active> {
    if(!thread.remotePort)throw new Error("thread has no persisted app-server port");this.connecting.add(host.id);let ssh:SshConnection|undefined;
    let forward:{port:number;close():Promise<void>}|undefined,client:CodexClient|undefined,runtime:TmuxCodexRuntime|undefined,session:RemoteSession|undefined;
    let tmuxCreated=false;
    try{ssh=await this.createSsh(host);await ssh.connect();runtime=this.options.runtimeFactory?.(ssh)??new TmuxCodexRuntime(withPrependedPath(ssh,combinedPrependPath(host,thread)));await runtime.checkPrerequisites();const existed=await runtime.exists(thread.tmuxSession);session=await runtime.start(thread.tmuxSession,thread.workingDirectory,thread.remotePort,thread.proxy);tmuxCreated=!existed;await runtime.waitUntilReady(session);forward=await ssh.forwardRemotePort(thread.remotePort);client=this.options.clientFactory?.(`ws://127.0.0.1:${forward.port}`)??new CodexClient({url:`ws://127.0.0.1:${forward.port}`});client.on("notification",payload=>this.events.emit("event",{threadId:thread.id,type:"codex",payload} satisfies RuntimeEvent));client.on("request",payload=>this.events.emit("event",{threadId:thread.id,type:"codex",payload} satisfies RuntimeEvent));await client.connect();return {hostId:host.id,ssh,runtime,session,client,forward,tmuxCreated,hasRollout:thread.hasRollout!==0};}catch(error){client?.close();await forward?.close().catch(()=>undefined);if(runtime&&session&&tmuxCreated)await runtime.stop(session.name).catch(()=>undefined);ssh?.close();throw error;}finally{this.connecting.delete(host.id);}
  }
  private async activate(host:HostRecord,thread:ThreadRecord,active:Active,withTerminal:boolean):Promise<void>{if(this.detached.has(thread.id))throw new Error("thread runtime was detached");this.active.set(thread.id,active);this.retries.set(thread.id,{host,thread,attempt:0,cancelled:false});const lost=()=>this.connectionLost(thread.id,active);active.client.on("transportError",lost);active.client.on("transportClose",lost);try{if(withTerminal)await this.attachTerminal(thread.id,active);}catch(error){this.active.delete(thread.id);throw error;}}
  private async attachTerminal(threadId:string,active:Active):Promise<void>{await this.pipe(threadId,active);const lost=()=>this.connectionLost(threadId,active);active.stream!.once("close",lost);active.stream!.once("error",lost);}
  private async pipe(threadId: string, active: Active): Promise<void> { active.stream = await active.runtime.terminalStream(active.session); active.stream.on("data", data => this.events.emit("event", { threadId, type: "terminal", payload: data.toString("utf8") } satisfies RuntimeEvent)); }
  private connectionLost(threadId:string,active:Active,reason?:string):void{if(this.closing||this.active.get(threadId)!==active)return;this.events.emit("connectionGenerationChanged",{threadId,reason});this.events.emit("connectionLost",{threadId,reason});this.active.delete(threadId);void this.dispose(active,{stopTmux:false}).finally(()=>{const state=this.retries.get(threadId);if(state&&!state.cancelled)this.scheduleRetry(state);});}
  private async tryReconnect(state:RetryState):Promise<void>{if(state.cancelled||this.closing)return;try{await this.resume(state.host,state.thread,state.thread.codexThreadId!);state.attempt=0;}catch{this.scheduleRetry(state);}}
  private scheduleRetry(state:RetryState):void{if(state.cancelled||this.closing||state.timer)return;const limit=this.options.retryLimit??8;if(state.attempt>=limit){this.events.emit("reconnectFailed",{threadId:state.thread.id,attempts:state.attempt});return;}const delay=Math.min((this.options.retryBaseMs??500)*2**state.attempt++,this.options.retryMaxMs??30_000);state.timer=setTimeout(()=>{state.timer=undefined;void this.tryReconnect(state);},delay);state.timer.unref?.();}
  private cancelRetry(threadId:string):void{const state=this.retries.get(threadId);if(!state)return;state.cancelled=true;if(state.timer)clearTimeout(state.timer);this.retries.delete(threadId);}
  private async dispose(active:Active,options:{stopTmux:boolean;requireStop?:boolean}):Promise<void>{active.stream?.removeAllListeners();active.stream?.close();active.client.removeAllListeners("transportError");active.client.removeAllListeners("transportClose");active.client.close();await active.forward.close().catch(()=>undefined);try{if(options.stopTmux){const stopping=active.runtime.stop(active.session.name);if(options.requireStop)await stopping;else await stopping.catch(()=>undefined);}}finally{active.ssh.close();}}
  private async historicalFrom(client:CodexClient):Promise<Array<{id:string;title?:string;cwd?:string;updatedAt?:string}>>{const result=await client.listThreads({limit:100});return result.data.map(thread=>({id:thread.id,title:typeof thread.name==="string"?thread.name:undefined,cwd:typeof thread.cwd==="string"?thread.cwd:undefined,updatedAt:typeof thread.updatedAt==="string"?thread.updatedAt:undefined}));}
  private async createSsh(host:HostRecord):Promise<SshConnection>{
    const expected=opensshSha256ToHex(host.hostKeySha256);
    const config:ConstructorParameters<typeof SshConnection>[0]={host:host.hostname,port:host.port,username:host.username,hostHash:"sha256",hostVerifier:(key:string)=>key.toLowerCase()===expected};
    const password=this.hostPasswords.get(host.id);
    if(password)config.password=password;
    else if(host.identityFile)config.privateKey=await readFile(host.identityFile);
    else if(process.env.SSH_AUTH_SOCK)config.agent=process.env.SSH_AUTH_SOCK;
    else {
      for(const name of ["id_ed25519","id_ecdsa","id_rsa"]){
        try{config.privateKey=await readFile(join(homedir(),".ssh",name));break;}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      }
    }
    return this.options.sshFactory?.(config)??new SshConnection(config);
  }
  private must(threadId: string): Active { const value = this.active.get(threadId); if (!value) throw new Error("thread runtime is not connected"); return value; }
}

export function opensshSha256ToHex(value:string):string{if(!value.startsWith("SHA256:"))throw new Error("host key fingerprint must use OpenSSH SHA256:base64 format");const encoded=value.slice(7);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error("invalid OpenSSH host key fingerprint");const bytes=Buffer.from(encoded,"base64");if(bytes.length!==32)throw new Error("invalid SHA256 host key fingerprint length");return bytes.toString("hex");}
function combinedPrependPath(host:HostRecord,thread:ThreadRecord):string|undefined{return [thread.prependPath,host.prependPath].filter(Boolean).join(":")||undefined;}
