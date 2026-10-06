import test from "node:test";
import assert from "node:assert/strict";
import { researchConfig, researchBucket, researchTick, summarizeResearch } from "../src/research.js";
import { researchWorkerEnabled } from "../src/service.js";
import { ResearchStore, type ResearchExperiment, type ResearchState, type ResearchEvent } from "../src/researchStore.js";
import { createResearchFeeds, ResearchFeedError, SOL_MINT, USDC_MINT, type FeedQuote } from "../src/researchFeeds.js";
const DAY = 86400000;
function harness(at: string) {
  let ms=Date.parse(at), calls=0;
  const config=researchConfig({JUPITER_API_KEY:"fixture"});
  const experiment:ResearchExperiment={_id:"test",phase:"CALIBRATION",rulesHash:"hash",rules:{policy:config.policy},createdAt:at,parentId:null,confirmationDesign:{minimumDays:90,minimumClosedTrades:30,automaticPromotion:false}};
  let state:ResearchState={_id:"test",revision:0,leaseOwner:"test",leaseUntil:new Date(ms+300000),lastBucket:null,candleDay:null,payload:{}};
  const events:ResearchEvent[]=[];
  const store={release:async()=>{},commit:async(_:ResearchState,payload:Record<string,unknown>,bucket:number,candleDay:string|null,added:ResearchEvent[])=>{state={...state,payload,lastBucket:bucket,candleDay,revision:state.revision+1};events.push(...added);}} as unknown as ResearchStore;
  const q=(input:string,output:string,amount:string,out:string):FeedQuote=>({inputMint:input,outputMint:output,inputAmount:amount,outputAmount:out,requestedAt:new Date(ms).toISOString(),observedAt:new Date(ms).toISOString(),router:"fixture",feeBps:5,externalFeeLamports:5000,buildStatus:"NOT_REQUESTED",expiresAt:null,raw:{}});
  const feeds={requestCount:4,order:async()=>q(SOL_MINT,USDC_MINT,"1","1"),candles:async()=>{
    calls++;ms+=500;
    const end=Math.floor(ms/DAY)*DAY;
    return { data:Array.from({length:250},(_,i)=>[(end-(250-i)*DAY)/1000,99,101,100,100,10]),observedAt:new Date(ms).toISOString(),sourceDate:null};
  },price:async(base:"SOL"|"USDC")=>({base,usd:base==="SOL"?120:1,observedAt:new Date(ms).toISOString(),sourceDate:null}),quotePair:async()=>({entry:q(USDC_MINT,SOL_MINT,"1000000","8000000"),reverse:q(SOL_MINT,USDC_MINT,"8000000","990000")})} as ReturnType<typeof createResearchFeeds>;
  return {config,experiment,store,feeds,events,get state(){return state;},get ms(){return ms;},get calls(){return calls;},setTime:(value:string)=>{ms=Date.parse(value);},tick:()=>researchTick(store,experiment,state,config,ms,{feeds,clock:()=>ms})};
}
test("elapsed feed time is causal; same bucket restart does not duplicate observations",async()=>{
  const h=harness("2026-10-06T00:05:00Z");await h.tick();
  assert.equal((h.state.payload.candles as unknown[]).length,250);
  assert.equal(h.events.filter(e=>e.kind==="candles").length,1);
  const count=h.events.length;await h.tick();assert.equal(h.events.length,count);assert.equal(h.calls,1);
  const report=h.events.find(e=>e.kind==="daily-report")!.report as Record<string,unknown>;
  assert.equal(report.overheadUsdMicros,null);
  const passive=report.passiveBenchmark as {equityMicros:number};
  assert.ok(Math.abs(passive.equityMicros-19_960_000)<=1,"initial passive costs only, no stale prior-close price jump");
});
test("pre-publication startup refetches at 00:05 and records missing scheduled buckets",async()=>{
  const h=harness("2026-10-06T00:02:00Z");await h.tick();assert.equal(h.state.candleDay,"2026-10-05");
  h.setTime("2026-10-06T00:06:00Z");await h.tick();assert.equal(h.calls,2);assert.equal(h.state.candleDay,"2026-10-06");
  h.setTime("2026-10-06T03:06:00Z");await h.tick();assert.equal(h.events.filter(e=>e.kind==="coverage-gap").length,1);
});
test("missing key retains candle and outage evidence; no fabricated fills",async()=>{
  const h=harness("2026-10-06T00:05:00Z");h.feeds.quotePair=async()=>{throw new ResearchFeedError("JUPITER_KEY_MISSING");};
  await h.tick();assert.equal((h.state.payload.candles as unknown[]).length,250);
  assert.ok(h.events.some(e=>e.kind==="outage"&&e.code==="JUPITER_KEY_MISSING"));
  assert.equal(h.events.filter(e=>e.kind==="paper-fill").length,0);
});
test("confirmation excludes pre-freeze bars and never auto-promotes",async()=>{
  const h=harness("2026-10-06T00:05:00Z");h.experiment.phase="CONFIRMATION";await h.tick();
  const decisions=h.events.filter(e=>e.kind==="decision");assert.ok(decisions.some(e=>(e.decision as {reason:string}).reason==="PRE_FREEZE_BAR"));
  const report=summarizeResearch(h.experiment,h.state.payload as never,h.ms);assert.equal(report.automaticPromotion,false);assert.equal(report.sufficientSampleForReview,false);
});

test("unusable exit is retried next hour rather than consuming the daily signal",async()=>{
  const h=harness("2026-10-06T00:05:00Z");await h.tick();
  const payload=h.state.payload;
  const ledger=payload.ledger as {position:unknown};
  ledger.position={solLamports:"10000000",entryDebitMicros:1000000,openedAt:"2026-09-01T00:05:00Z",stopPrice:1,tradeId:"exit-retry"};
  payload.lastDecisionBar=null;
  h.setTime("2026-10-06T01:05:00Z");
  const original=h.feeds.order;
  h.feeds.order=async(...args)=>({...await original(...args),expiresAt:"2026-10-06T00:05:00Z"});
  await h.tick();assert.equal(h.state.payload.lastDecisionBar,null);assert.ok((h.state.payload.ledger as {position:unknown}).position);
  h.feeds.order=original;h.setTime("2026-10-06T02:05:00Z");await h.tick();
  assert.equal((h.state.payload.ledger as {position:unknown}).position,null);
  assert.ok(h.state.payload.lastDecisionBar!==null);
});
test("opt-in defaults, cadence and numeric configuration fail closed",()=>{
  assert.equal(researchWorkerEnabled({}),false);assert.equal(researchWorkerEnabled({RESEARCH_ENABLED:"true"}),true);
  assert.throws(()=>researchWorkerEnabled({RESEARCH_ENABLED:"yes"}));
  assert.throws(()=>researchConfig({RESEARCH_STARTING_USD_MICROS:"NaN"}));
  assert.equal(researchBucket(Date.parse("2026-10-06T00:04:59Z"))+1,researchBucket(Date.parse("2026-10-06T00:05:00Z")));
});

test("evidence budget pauses atomically and makes no later feed requests",async()=>{
  const h=harness("2026-10-06T00:05:00Z");await h.tick();
  h.state.payload.evidenceBytes=100_000_000;
  const previousLedger=structuredClone(h.state.payload.ledger);
  h.setTime("2026-10-06T01:05:00Z");await h.tick();
  assert.equal(h.state.payload.collectionPaused,true);
  assert.deepEqual(h.state.payload.ledger,previousLedger);
  assert.equal(h.events.at(-1)?.kind,"collection-paused");
  h.feeds.price=async()=>{throw new Error("paused collector must not fetch");};
  const count=h.events.length;h.setTime("2026-10-06T02:05:00Z");await h.tick();assert.equal(h.events.length,count);
});
