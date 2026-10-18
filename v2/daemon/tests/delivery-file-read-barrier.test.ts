import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import type { ChildProcess } from "node:child_process";
import { seatbeltProfile } from "../../driver-cell/src/sandbox.ts";
import { nativeNodeEnv } from "../../../src/runtimeEnvironment.ts";
import { disposeAndAwaitOwnedChild, waitForGateProfile, waitForGateReaderObservation, withoutGateReaderObservationDuringLaunch } from "./delivery-file-read-barrier.ts";

class FixtureSocket extends EventEmitter {
  destroyed = false;
  locator: Buffer | undefined;
  reply: (socket: FixtureSocket) => void = () => {};
  write(bytes: Buffer): boolean {this.locator = bytes; this.reply(this); return true;}
  destroy(): this {this.destroyed = true; return this;}
}

function fixtureControl(t: TestContext, reply: (socket: FixtureSocket) => void) {
  const prior = process.env.SCG_FIXTURE_CONTROL_SOCKET;
  process.env.SCG_FIXTURE_CONTROL_SOCKET = "/owned/fixture-control.sock";
  const socket = new FixtureSocket(); socket.reply = reply;
  let called!: () => void;
  const connected = new Promise<void>(resolve => {called = resolve;});
  const mock = t.mock.method(net, "createConnection", () => {called(); queueMicrotask(() => socket.emit("connect")); return socket as unknown as net.Socket;});
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore(); syncBuiltinESMExports();
    if (prior === undefined) delete process.env.SCG_FIXTURE_CONTROL_SOCKET;
    else process.env.SCG_FIXTURE_CONTROL_SOCKET = prior;
  });
  return {socket, connected, mock};
}

test("profile barrier without gate control performs no connection or timer", async t => {
  const prior = process.env.SCG_FIXTURE_CONTROL_SOCKET;
  delete process.env.SCG_FIXTURE_CONTROL_SOCKET;
  const connection = t.mock.method(net, "createConnection", () => {throw new Error("unexpected connection");});
  syncBuiltinESMExports();
  const timer = t.mock.method(globalThis, "setTimeout", () => {throw new Error("unexpected timer");});
  try {await waitForGateProfile("row", "/owned/fr-root"); assert.equal(connection.mock.callCount(), 0); assert.equal(timer.mock.callCount(), 0);}
  finally {
    timer.mock.restore(); connection.mock.restore(); syncBuiltinESMExports();
    if (prior === undefined) delete process.env.SCG_FIXTURE_CONTROL_SOCKET;
    else process.env.SCG_FIXTURE_CONTROL_SOCKET = prior;
  }
});

test("profile barrier sends only its locator and accepts the exact split canonical ACK at EOF", async t => {
  const {socket} = fixtureControl(t, s => {s.emit("data", Buffer.from('{"version":1,')); s.emit("data", Buffer.from('"approved":true}\n')); s.emit("end");});
  await waitForGateProfile("selected row", "/owned/fr-root");
  assert.equal(socket.locator?.toString(), '{"version":1,"operation":"profile-ready","rowId":"selected row","fixtureRoot":"/owned/fr-root"}\n');
  assert.equal(socket.destroyed, true);
});

for (const ack of [
  '{"version":1,"approved":false,"approved":true}\n',
  '{ "version":1,"approved":true}\n',
  '{"approved":true,"version":1}\n',
  '{"version":1,"approved":true}\n\n',
  '{"version":1,"approved":true}',
  '{"version":1,"approved":false}\n',
  '{"version":1,"approved":true,"extra":1}\n',
  '',
]) test(`profile barrier rejects noncanonical ACK ${JSON.stringify(ack)}`, async t => {
  const {socket} = fixtureControl(t, s => {s.emit("data", Buffer.from(ack)); s.emit("end");});
  await assert.rejects(waitForGateProfile("row", "/owned/fr-root"), /gate_fixture_barrier_ack_invalid/);
  assert.equal(socket.destroyed, true);
});

test("profile barrier bounds ACK bytes before EOF", async t => {
  fixtureControl(t, s => s.emit("data", Buffer.alloc(257)));
  await assert.rejects(waitForGateProfile("row", "/owned/fr-root"), /gate_fixture_barrier_ack_bound/);
});

for (const event of ["error", "close"] as const) test(`profile barrier fails on transport ${event}`, async t => {
  fixtureControl(t, s => s.emit(event, new Error("fixture refusal")));
  await assert.rejects(waitForGateProfile("row", "/owned/fr-root"), new RegExp(event === "error" ? "gate_fixture_barrier_transport" : "gate_fixture_barrier_closed"));
});

test("profile barrier bounds its locator before connecting", async t => {
  const {mock} = fixtureControl(t, () => {});
  await assert.rejects(waitForGateProfile("x".repeat(4096), "/owned/fr-root"), /gate_fixture_barrier_invalid_locator/);
  assert.equal(mock.mock.callCount(), 0);
});

test("profile barrier times out after thirty seconds without ACK", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const {socket, connected} = fixtureControl(t, () => {});
  const rejected = assert.rejects(waitForGateProfile("row", "/owned/fr-root"), /gate_fixture_barrier_timeout/);
  await connected;
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(socket.destroyed, true);
});

function ownedChild() {
  return Object.assign(new EventEmitter(), {exitCode: null, signalCode: null}) as unknown as ChildProcess;
}

test("read fixture cleanup waits for its actual owned child exit before unlinking", async () => {
  const child = ownedChild(), order: string[] = [];
  await disposeAndAwaitOwnedChild(child, () => {order.push("dispose"); queueMicrotask(() => {order.push("exit"); child.emit("exit", 0, null);});}, () => {order.push("remove");});
  assert.deepEqual(order, ["dispose", "exit", "remove"]);
});

test("read fixture cleanup retains its root on a bounded child exit timeout", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let removed = false;
  const rejected = assert.rejects(disposeAndAwaitOwnedChild(ownedChild(), () => {}, () => {removed = true;}), error => error instanceof AggregateError && error.errors[0].message === "delivery_read_cleanup_exit_timeout");
  t.mock.timers.tick(3000);
  await rejected;
  assert.equal(removed, false);
});

test("read fixture cleanup preserves disposal failure while still waiting for exit", async () => {
  const child = ownedChild(), original = new Error("dispose failed"); let removed = false;
  await assert.rejects(disposeAndAwaitOwnedChild(child, () => {queueMicrotask(() => child.emit("exit", 0, null)); throw original;}, () => {removed = true;}), error => error instanceof AggregateError && error.cause === original && error.errors[0] === original);
  assert.equal(removed, true);
});

const readerRow = "Darwin OS-level file read outside cwd: cell-sandbox; tool-policy read UNVERIFIED (OS-level only)";
function readerControl(t: TestContext, reply: (socket: FixtureSocket) => void) {
  const prior = process.env.SCG_FIXTURE_OBSERVATION_SOCKET;
  process.env.SCG_FIXTURE_OBSERVATION_SOCKET = "/owned/sealed-target/control/o-p0.sock";
  const socket = new FixtureSocket(); socket.reply = reply;
  let called!: () => void;
  const connected = new Promise<void>(resolve => {called = resolve;});
  const mock = t.mock.method(net, "createConnection", () => {called(); queueMicrotask(() => socket.emit("connect")); return socket as unknown as net.Socket;});
  syncBuiltinESMExports();
  t.after(() => {mock.mock.restore(); syncBuiltinESMExports(); if (prior === undefined) delete process.env.SCG_FIXTURE_OBSERVATION_SOCKET; else process.env.SCG_FIXTURE_OBSERVATION_SOCKET = prior;});
  return {socket, connected, mock};
}

test("reader hold without env adds no call-site await import timer socket or teardown reordering", async t => {
  const prior = process.env.SCG_FIXTURE_OBSERVATION_SOCKET;
  delete process.env.SCG_FIXTURE_OBSERVATION_SOCKET;
  const connection=t.mock.method(net,"createConnection",()=>{throw new Error("unexpected socket");});syncBuiltinESMExports();
  const timer=t.mock.method(globalThis,"setTimeout",()=>{throw new Error("unexpected timer");});
  const order: string[]=[];
  let imports=0;
  const hook=registerHooks({resolve(specifier,context,nextResolve){if(specifier==="node:net")imports++;return nextResolve(specifier,context);}});
  const hold=async()=>{await waitForGateReaderObservation(readerRow,"/owned/fr-root");};
  const row=async()=>{order.push("assertions");if(process.env.SCG_FIXTURE_OBSERVATION_SOCKET!==undefined)await hold();order.push("teardown");};
  try {
    const result=row();order.push("caller");await result;
    assert.deepEqual(order,["assertions","teardown","caller"]);assert.equal(imports,0);assert.equal(connection.mock.callCount(),0);assert.equal(timer.mock.callCount(),0);
    await waitForGateReaderObservation(readerRow,"/owned/fr-root");assert.equal(connection.mock.callCount(),0);assert.equal(timer.mock.callCount(),0);assert.equal(imports,0);
  } finally {hook.deregister();timer.mock.restore();connection.mock.restore();syncBuiltinESMExports();if(prior!==undefined)process.env.SCG_FIXTURE_OBSERVATION_SOCKET=prior;}
});

test("reader observation sends locator only and accepts split canonical ACK plus EOF", async t=>{
  const {socket}=readerControl(t,s=>{s.emit("data",Buffer.from('{"version":1,'));s.emit("data",Buffer.from('"observed":true}\n'));s.emit("end");});
  await waitForGateReaderObservation(readerRow,"/owned/fr-root");
  assert.deepEqual(JSON.parse(socket.locator!.toString()),{version:1,operation:"reader-observed",rowId:readerRow,fixtureRoot:"/owned/fr-root"});assert.equal(socket.destroyed,true);
});

for(const ack of ['{"version":1,"observed":false,"observed":true}\n','{ "version":1,"observed":true}\n','{"observed":true,"version":1}\n','{"version":1,"observed":true}','{"version":1,"observed":false}\n',''])test(`reader observation rejects noncanonical ACK ${JSON.stringify(ack)}`,async t=>{
  readerControl(t,s=>{s.emit("data",Buffer.from(ack));s.emit("end");});await assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_ack_invalid/);
});

for(const event of ["error","close"] as const)test(`reader observation transport ${event} fails`,async t=>{
  readerControl(t,s=>s.emit(event,new Error("fixture")));await assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_(transport|closed)/);
});

test("reader observation bounds ACK locator row endpoint and timeout",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const {connected}=readerControl(t,()=>{});
  const rejected=assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_timeout/);await connected;t.mock.timers.tick(30000);await rejected;
  await assert.rejects(waitForGateReaderObservation("unreviewed","/owned/fr-root"),/gate_reader_observation_scope/);
  await assert.rejects(waitForGateReaderObservation(readerRow,"x".repeat(4096)),/gate_reader_observation_invalid_locator/);
});

test("reader observation ACK overflow fails",async t=>{
  readerControl(t,s=>s.emit("data",Buffer.alloc(257)));await assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_ack_bound/);
});

test("launch removes gate observation variable from reader spec and host process env and restores on errors",()=>{
  const prior=process.env.SCG_FIXTURE_OBSERVATION_SOCKET;process.env.SCG_FIXTURE_OBSERVATION_SOCKET="/owned/sealed-target/control/o-p0.sock";
  try {
    withoutGateReaderObservationDuringLaunch(()=>{assert.equal(process.env.SCG_FIXTURE_OBSERVATION_SOCKET,undefined);assert.equal(({...process.env}).SCG_FIXTURE_OBSERVATION_SOCKET,undefined);assert.equal(nativeNodeEnv().SCG_FIXTURE_OBSERVATION_SOCKET,undefined);});
    assert.equal(process.env.SCG_FIXTURE_OBSERVATION_SOCKET,"/owned/sealed-target/control/o-p0.sock");
    assert.throws(()=>withoutGateReaderObservationDuringLaunch(()=>{throw new Error("launch");}),/launch/);
    assert.equal(process.env.SCG_FIXTURE_OBSERVATION_SOCKET,"/owned/sealed-target/control/o-p0.sock");
  } finally {if(prior===undefined)delete process.env.SCG_FIXTURE_OBSERVATION_SOCKET;else process.env.SCG_FIXTURE_OBSERVATION_SOCKET=prior;}
});


test("reader lifetime control leaves production rendered profile bytes identical",()=>{
  const policy={cellDir:"/fixture/work",writablePaths:[],scratchPaths:[]};
  const prior=process.env.SCG_FIXTURE_OBSERVATION_SOCKET;delete process.env.SCG_FIXTURE_OBSERVATION_SOCKET;
  const baseline=seatbeltProfile(policy);
  try {process.env.SCG_FIXTURE_OBSERVATION_SOCKET="/owned/sealed-target/control/o-p0.sock";assert.equal(seatbeltProfile(policy),baseline);withoutGateReaderObservationDuringLaunch(()=>assert.equal(seatbeltProfile(policy),baseline));}
  finally {if(prior===undefined)delete process.env.SCG_FIXTURE_OBSERVATION_SOCKET;else process.env.SCG_FIXTURE_OBSERVATION_SOCKET=prior;}
});


test("reader observation rejection still runs awaited cleanup before root removal",async t=>{
  readerControl(t,s=>{s.emit("data",Buffer.from("bad ACK"));s.emit("end");});
  const child=ownedChild(),order:string[]=[];
  try {await assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_ack_invalid/);order.push("refused");}
  finally {await disposeAndAwaitOwnedChild(child,()=>{order.push("dispose");queueMicrotask(()=>{order.push("exit");child.emit("exit",0,null);});},()=>{order.push("remove");});}
  assert.deepEqual(order,["refused","dispose","exit","remove"]);
});

test("reader observation write throw fails as typed transport refusal",async t=>{
  const {socket}=readerControl(t,()=>{});socket.write=()=>{throw new Error("forced");};
  await assert.rejects(waitForGateReaderObservation(readerRow,"/owned/fr-root"),/gate_reader_observation_transport/);
});
