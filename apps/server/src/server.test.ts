import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@cwb/storage";
import type { AppConfig } from "@cwb/config";
import { hashPassword } from "./auth.js";
import { buildServer } from "./server.js";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { RuntimeManager } from "./runtime-manager.js";
let app: FastifyInstance | undefined; let storage: Storage | undefined;
afterEach(async () => { await app?.close(); storage?.close(); });
async function setup() { storage = new Storage(":memory:"); app = await buildServer({ version: 1, bindHost: "127.0.0.1", port: 3210, publicOrigin: "https://bridge.example", passwordHash: await hashPassword("correct horse battery staple"), sessionSecret: "x".repeat(32), trustedProxy: "127.0.0.1" }, storage); }
describe("HTTP boundary", () => {
  it("authenticates directly over HTTP and rejects spoofed proxy metadata", async () => {
    storage = new Storage(":memory:");
    app = await buildServer({ version: 1, bindHost: "127.0.0.1", port: 3210, publicOrigin: "http://127.0.0.1:3210", passwordHash: await hashPassword("correct horse battery staple"), sessionSecret: "x".repeat(32), trustedProxy: "127.0.0.1" }, storage);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://127.0.0.1:3210" }, payload: { password: "correct horse battery staple" } });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).not.toContain("Secure");
    const spoofed = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-proto": "http" }, payload: { password: "correct horse battery staple" } });
    expect(spoofed.statusCode).toBe(404);
    expect(spoofed.body).toBe("");
  });
  it("accepts equivalent localhost and IPv4 loopback origins on the configured port", async () => {
    storage = new Storage(":memory:");
    app = await buildServer({ version: 1, bindHost: "127.0.0.1", port: 3210, publicOrigin: "http://localhost:3210", passwordHash: await hashPassword("correct horse battery staple"), sessionSecret: "x".repeat(32), trustedProxy: "127.0.0.1" }, storage);
    const loopback = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" }, payload: { password: "correct horse battery staple" } });
    expect(loopback.statusCode).toBe(200);
    const wrongPort = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" }, payload: { password: "correct horse battery staple" } });
    expect(wrongPort.statusCode).toBe(403);
    const nonLoopback = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "bridge.attacker.test:3210", origin: "http://bridge.attacker.test:3210" }, payload: { password: "correct horse battery staple" } });
    expect(nonLoopback.statusCode).toBe(403);
  });
  it("accepts the browser's actual HTTP origin only in all-interface danger mode", async () => {
    storage = new Storage(":memory:");
    app = await buildServer({ version: 1, bindHost: "0.0.0.0", port: 3210, publicOrigin: "http://127.0.0.1:3210", passwordHash: await hashPassword("correct horse battery staple"), sessionSecret: "x".repeat(32), trustedProxy: "127.0.0.1" }, storage);
    const accepted = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "192.0.2.10:3210", origin: "http://192.0.2.10:3210" }, payload: { password: "correct horse battery staple" } });
    expect(accepted.statusCode).toBe(200);
    const crossOrigin = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "192.0.2.10:3210", origin: "http://evil.example" }, payload: { password: "correct horse battery staple" } });
    expect(crossOrigin.statusCode).toBe(403);
  });
  it("authenticates through the local HTTPS proxy and protects mutations with CSRF", async () => { await setup(); const login = await app!.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-proto": "https", origin: "https://bridge.example" }, payload: { password: "correct horse battery staple" } }); expect(login.statusCode).toBe(200); expect(login.headers["set-cookie"]).toContain("Secure"); const csrf = login.json().csrfToken; const cookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value; const logout = await app!.inject({ method: "POST", url: "/api/auth/logout", headers: { "x-forwarded-proto": "https", origin: "https://bridge.example", cookie, "x-csrf-token": csrf } }); expect(logout.statusCode).toBe(204); });
});

it("updates public settings without exposing internal secrets",async()=>{
  storage=new Storage(":memory:");
  const config={version:1 as const,bindHost:"127.0.0.1" as const,port:3210,publicOrigin:"https://bridge.example",passwordHash:await hashPassword("correct horse battery staple"),sessionSecret:"x".repeat(32),trustedProxy:"127.0.0.1" as const};
  let saved:AppConfig|undefined;
  app=await buildServer(config,storage,{webRoot:false,settingsSaver:async next=>{saved=next;}});
  const base={"x-forwarded-proto":"https",origin:"https://bridge.example"};
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:base,payload:{password:"correct horse battery staple"}});
  const cookie=`${login.cookies[0]!.name}=${login.cookies[0]!.value}`,headers={...base,cookie,"x-csrf-token":login.json().csrfToken};
  const before=await app.inject({method:"GET",url:"/api/settings",headers:{...base,cookie}});
  expect(before.json()).not.toHaveProperty("passwordHash");expect(before.json()).not.toHaveProperty("sessionSecret");
  const invalidOrigin=await app.inject({method:"PUT",url:"/api/settings",headers,payload:{bindHost:"127.0.0.1",port:3210,publicOrigin:"https://new.example/dashboard"}});
  expect(invalidOrigin.statusCode).toBe(400);
  const updated=await app.inject({method:"PUT",url:"/api/settings",headers,payload:{bindHost:"0.0.0.0",port:4321,publicOrigin:"https://new.example",newPassword:"new-password-123"}});
  expect(updated.statusCode).toBe(200);expect(updated.json()).toMatchObject({bindHost:"0.0.0.0",port:4321,publicOrigin:"https://new.example",restartRequired:true});
  expect(saved).toMatchObject({bindHost:"0.0.0.0",port:4321,publicOrigin:"https://new.example"});expect(saved!.passwordHash).not.toBe(config.passwordHash);
  expect((await app.inject({method:"GET",url:"/api/settings",headers:{...base,cookie}})).statusCode).toBe(401);
});

class FakeRuntime implements RuntimeManager {
  events=new EventEmitter(); calls:string[]=[]; failExit=false;
  async create(){this.calls.push("create");return "codex-1";} async resume(){this.calls.push("resume");} async reconnect(_host:unknown,thread:{remotePort?:number}){this.calls.push(`reconnect:${thread.remotePort}`);} async detach(threadId:string){this.calls.push(`detach:${threadId}`);}
  async exit(_thread:unknown,host?:{id:string}){this.calls.push(`exit:${host?.id}`);if(this.failExit)throw new Error("tmux stop failed");} async send(){this.calls.push("send");return "turn-1";} async interrupt(){this.calls.push("interrupt");} async resolve(){this.calls.push("resolve");}
  async terminalInput(){this.calls.push("input");} async screenshot(){return Buffer.from([137,80,78,71]);} async close(){}
  async terminalSeed(){return "\u001b[31mseed\u001b[0m";}
}
it("wires authenticated thread operations to the runtime",async()=>{storage=new Storage(":memory:");storage.upsertHost({id:"host",name:"A",hostname:"a",port:22,username:"u",hostKeySha256:"key",identityFile:"/key",createdAt:1});const runtime=new FakeRuntime();app=await buildServer({version:1,bindHost:"127.0.0.1",port:3210,publicOrigin:"https://bridge.example",passwordHash:await hashPassword("correct horse battery staple"),sessionSecret:"x".repeat(32),trustedProxy:"127.0.0.1"},storage,{runtime,webRoot:false});const base={"x-forwarded-proto":"https",origin:"https://bridge.example"};const login=await app.inject({method:"POST",url:"/api/auth/login",headers:base,payload:{password:"correct horse battery staple"}}),csrf=login.json().csrfToken,cookie=`${login.cookies[0]!.name}=${login.cookies[0]!.value}`,headers={...base,cookie,"x-csrf-token":csrf};const hosts=await app.inject({method:"GET",url:"/api/hosts",headers:{...base,cookie}});expect(hosts.json()[0]).toMatchObject({id:"host",hostname:"a",port:22,username:"u",hostKeySha256:"key",identityFile:"/key"});const customTitle=await app.inject({method:"POST",url:"/api/threads",headers,payload:{hostId:"host",cwd:"/work",title:"custom"}});expect(customTitle.statusCode).toBe(400);const invalidProxy=await app.inject({method:"POST",url:"/api/threads",headers,payload:{hostId:"host",cwd:"/work",proxy:"file:///tmp/socket"}});expect(invalidProxy.statusCode).toBe(400);const created=await app.inject({method:"POST",url:"/api/threads",headers,payload:{hostId:"host",cwd:"/work",proxy:"http://proxy.example:8080"}});expect(created.statusCode).toBe(201);const id=created.json().id;expect(created.json()).toMatchObject({title:`Codex thread ${id.slice(0,8)}`,proxy:"http://proxy.example:8080"});expect(storage.thread(id)?.proxy).toBe("http://proxy.example:8080");const sent=await app.inject({method:"POST",url:`/api/threads/${id}/messages`,headers,payload:{text:"hi"}});expect(sent.statusCode).toBe(200);expect(sent.json()).toEqual({turnId:"turn-1"});expect((await app.inject({method:"POST",url:`/api/threads/${id}/interrupt`,headers})).statusCode).toBe(204);expect((await app.inject({method:"POST",url:`/api/threads/${id}/terminal/takeover`,headers,payload:{enabled:true}})).statusCode).toBe(204);expect((await app.inject({method:"POST",url:`/api/threads/${id}/terminal/input`,headers,payload:{data:"x"}})).statusCode).toBe(204);expect((await app.inject({method:"GET",url:`/api/threads/${id}/terminal/screenshot`,headers:{...base,cookie}})).statusCode).toBe(200);expect((await app.inject({method:"POST",url:`/api/threads/${id}/exit`,headers})).statusCode).toBe(204);const restored=await app.inject({method:"POST",url:`/api/threads/${id}/resume`,headers});expect(restored.statusCode).toBe(200);expect(restored.json()).toMatchObject({id,status:"idle",proxy:"http://proxy.example:8080"});expect((await app.inject({method:"DELETE",url:`/api/threads/${id}`,headers})).statusCode).toBe(204);expect(storage.thread(id)).toBeUndefined();expect(runtime.calls).toEqual(expect.arrayContaining(["create","send","interrupt","input","exit:host","resume",`detach:${id}`]));});
it("keeps a thread active when the remote tmux cannot be stopped",async()=>{storage=new Storage(":memory:");storage.upsertHost({id:"host",name:"A",hostname:"a",port:22,username:"u",hostKeySha256:"key",identityFile:"/key",createdAt:1});storage.createThread({id:"thread",hostId:"host",codexThreadId:"codex",tmuxSession:"cwb-thread",remotePort:45678,workingDirectory:"/work",title:"thread",status:"idle",createdAt:1,updatedAt:1});const runtime=new FakeRuntime();runtime.failExit=true;app=await buildServer({version:1,bindHost:"127.0.0.1",port:3210,publicOrigin:"https://bridge.example",passwordHash:await hashPassword("correct horse battery staple"),sessionSecret:"x".repeat(32),trustedProxy:"127.0.0.1"},storage,{runtime,webRoot:false});const base={"x-forwarded-proto":"https",origin:"https://bridge.example"},login=await app.inject({method:"POST",url:"/api/auth/login",headers:base,payload:{password:"correct horse battery staple"}}),cookie=`${login.cookies[0]!.name}=${login.cookies[0]!.value}`,csrf=login.json().csrfToken;const result=await app.inject({method:"POST",url:"/api/threads/thread/exit",headers:{...base,cookie,"x-csrf-token":csrf}});expect(result.statusCode).toBe(500);expect(storage.thread("thread")?.status).toBe("idle");});
it("reconnects a persisted active thread on its original remote port",async()=>{storage=new Storage(":memory:");storage.upsertHost({id:"host",name:"A",hostname:"a",port:22,username:"u",hostKeySha256:"key",identityFile:"/key",createdAt:1});storage.createThread({id:"thread",hostId:"host",codexThreadId:"codex",tmuxSession:"cwb-thread",remotePort:45678,workingDirectory:"/work",title:"thread",status:"idle",createdAt:1,updatedAt:1});const runtime=new FakeRuntime();app=await buildServer({version:1,bindHost:"127.0.0.1",port:3210,publicOrigin:"https://bridge.example",passwordHash:await hashPassword("correct horse battery staple"),sessionSecret:"x".repeat(32),trustedProxy:"127.0.0.1"},storage,{runtime,webRoot:false});await new Promise(resolve=>setTimeout(resolve,0));expect(runtime.calls).toContain("reconnect:45678");});
it("expires pending RPC callbacks when the runtime connection generation changes",async()=>{storage=new Storage(":memory:");storage.upsertHost({id:"host",name:"A",hostname:"a",port:22,username:"u",hostKeySha256:"key",identityFile:"/key",createdAt:1});storage.createThread({id:"thread",hostId:"host",codexThreadId:"codex",tmuxSession:"cwb-thread",remotePort:45678,workingDirectory:"/work",title:"thread",status:"waiting",createdAt:1,updatedAt:1});storage.putPending({id:"bridge-request",threadId:"thread",payload:"{}",rpcId:"7",method:"item/tool/requestUserInput",params:"{}",createdAt:1});const runtime=new FakeRuntime();app=await buildServer({version:1,bindHost:"127.0.0.1",port:3210,publicOrigin:"https://bridge.example",passwordHash:await hashPassword("correct horse battery staple"),sessionSecret:"x".repeat(32),trustedProxy:"127.0.0.1"},storage,{runtime,webRoot:false});runtime.events.emit("connectionGenerationChanged",{threadId:"thread"});expect(storage.pending("thread")).toHaveLength(0);const base={"x-forwarded-proto":"https",origin:"https://bridge.example"},login=await app.inject({method:"POST",url:"/api/auth/login",headers:base,payload:{password:"correct horse battery staple"}}),cookie=`${login.cookies[0]!.name}=${login.cookies[0]!.value}`,csrf=login.json().csrfToken;const stale=await app.inject({method:"POST",url:"/api/threads/thread/requests/bridge-request",headers:{...base,cookie,"x-csrf-token":csrf},payload:{answers:{question:{answers:["old"]}}}});expect(stale.statusCode).toBe(409);expect(runtime.calls).not.toContain("resolve");});
