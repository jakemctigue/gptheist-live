const $ = (id) => document.getElementById(id);
const names = ["TOKYO","BERLIN","RIO","DENVER","LISBON","STOCKHOLM","NAIROBI","HELSINKI","PALERMO","PROFESSOR"];
const roles = ["SCOUT","CRITERIA","CHAIN PROOF","SOCIAL PROOF","VALIDATION","PAIR POLICY","BRIEF","AUDIT","VETO GATE","FINAL"];
let selected = null;
let timer = null;
let latestSnapshot = null;
let activeFilter = "ALL";
let socialRequest = 0;
let historyRequest = 0;
let walletAddress = null;
let walletAuthenticated = false;
let walletProvider = null;
let tradePolicy = null;
let preparedTrade = null;
let smartAccountConfiguration = null;
let smartAccountGrant = null;
const deployerHistoryCache = new Map();
const short = (value, size=6) => `${value.slice(0,size+2)}…${value.slice(-4)}`;
const explorer = (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`;
const tokenExplorer = (address) => `https://robinhoodchain.blockscout.com/address/${address}`;
const pons = (address) => `https://www.ponsfamily.com/launchpad/${address}`;
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const formatWei = (value) => {
  try { const n=BigInt(value), whole=n/1000000000000000000n, fraction=(n%1000000000000000000n).toString().padStart(18,"0").slice(0,4).replace(/0+$/,"");return `${whole}${fraction?`.${fraction}`:""} ETH` } catch { return "—" }
};
const socialHosts = {twitter:new Set(["x.com","www.x.com","twitter.com","www.twitter.com"]),telegram:new Set(["t.me","www.t.me"]),discord:new Set(["discord.gg","discord.com","www.discord.com"]),farcaster:new Set(["warpcast.com","www.warpcast.com"])};
function safeSocialUrl(raw,type){try{const url=new URL(raw);if(!["http:","https:"].includes(url.protocol))return null;const allowed=socialHosts[type];if(allowed&&!allowed.has(url.hostname.toLowerCase()))return null;return url.href}catch{return null}}
function xHandle(raw){const url=safeSocialUrl(raw,"twitter");if(!url)return null;const handle=new URL(url).pathname.split("/").filter(Boolean)[0]||"";return /^[A-Za-z0-9_]{1,15}$/.test(handle)?handle:null}

async function researchX(raw){
  const request=++socialRequest,handle=xHandle(raw);if(!handle)return;
  $("social-proof").textContent=`X / @${handle} · CHECKING PUBLIC PROFILE…`;
  try{const response=await fetch(`/api/social?handle=${encodeURIComponent(handle)}`,{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);const profile=await response.json();if(request!==socialRequest)return;const year=new Date(profile.joined).getUTCFullYear();$("social-proof").textContent=`X / @${profile.handle} · ${profile.followers.toLocaleString()} FOLLOWERS · JOINED ${year}${profile.verified?" · VERIFIED":""} · PUBLIC MIRROR`}
  catch{if(request===socialRequest)$("social-proof").textContent=`X / @${handle} DECLARED · PUBLIC PROFILE UNAVAILABLE · NOT SCORED`}
}

const deployerHistoryKey=(launch)=>`${launch.deployer.toLowerCase()}:${launch.blockNumber}:${launch.logIndex}`;
function renderDeployerHistory(history){$("prior-launches").textContent=String(history.priorLaunches);$("prior-graduated").textContent=String(history.priorGraduations);$("history-window").textContent=`${history.historyWindowDays} DAYS · ${history.historyWindowBlocks.toLocaleString()} BLOCKS`;$("deployer-verdict").textContent=history.priorLaunches===0?"FRESH IN 30 DAYS":history.priorLaunches>=5?"SERIAL LAUNCHER":"RETURNING"}
async function researchHistory(launch){
  const request=++historyRequest;$("deployer-verdict").textContent="SCANNING 30 DAYS";$("history-window").textContent="30 DAYS / ONCHAIN";
  try{const query=new URLSearchParams({deployer:launch.deployer,beforeBlock:String(launch.blockNumber),beforeLogIndex:String(launch.logIndex)});const response=await fetch(`/api/history?${query}`,{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);const history=await response.json();deployerHistoryCache.set(deployerHistoryKey(launch),history);if(request!==historyRequest||selected?.transactionHash!==launch.transactionHash)return;renderDeployerHistory(history)}
  catch{if(request===historyRequest&&selected?.transactionHash===launch.transactionHash){$("deployer-verdict").textContent="30-DAY SCAN UNAVAILABLE";$("history-window").textContent="RECENT WINDOW ONLY"}}
}

function renderDossier(launch){
  const market=launch.market,meta=launch.metadata,history=launch.deployerResearch;
  $("dossier-status").textContent=`BLOCK #${launch.blockNumber.toLocaleString()} · ${launch.verdict}`;
  $("token-identity").textContent=meta.status==="DECLARED"?`${meta.name||"UNNAMED"} / $${meta.symbol||"—"}`:short(launch.token,8);
  $("factory-proof").textContent=market.status==="VERIFIED"?"PONS V2 / VERIFIED":"UNAVAILABLE";
  $("deployer-address").textContent=short(launch.deployer,8);
  $("fee-route").textContent=market.status==="VERIFIED"?(market.creatorFeeRecipient.toLowerCase()===launch.deployer.toLowerCase()?"DEPLOYER":"THIRD PARTY"):"UNAVAILABLE";
  $("liquidity-verdict").textContent=market.status==="VERIFIED"?`${market.phase} / ${pct(market.progressBps)}`:"UNAVAILABLE";
  $("real-quote").textContent=market.status==="VERIFIED"?formatWei(market.realQuoteReserve):"—";
  if(market.status==="VERIFIED"){const left=BigInt(market.graduationThreshold)>BigInt(market.realQuoteReserve)?BigInt(market.graduationThreshold)-BigInt(market.realQuoteReserve):0n;$("graduation-left").textContent=formatWei(left);$("curve-reserves").textContent=`${formatWei(market.quoteReserve)} / TOKEN ${short(market.tokenReserve,6)}`}
  else{$("graduation-left").textContent="—";$("curve-reserves").textContent="—"}
  $("deployer-verdict").textContent=history.priorLaunches===0?"FRESH IN WINDOW":history.priorLaunches>=5?"SERIAL LAUNCHER":"RETURNING";
  $("prior-launches").textContent=String(history.priorLaunches);$("prior-graduated").textContent=String(history.priorGraduations);$("history-window").textContent=`${history.windowBlocks.toLocaleString()} BLOCKS`;
  const cachedHistory=deployerHistoryCache.get(deployerHistoryKey(launch));if(cachedHistory)renderDeployerHistory(cachedHistory);
  const socialRoot=$("social-links");socialRoot.replaceChildren();const declared=[];
  if(meta.status==="DECLARED")Object.entries(meta.socials).forEach(([type,raw])=>{const url=safeSocialUrl(raw,type);if(!url)return;const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=`${type.toUpperCase()} ↗`;socialRoot.append(a);declared.push(type)});
  if(!declared.length){const empty=document.createElement("span");empty.textContent="NO VALID DECLARED LINKS";socialRoot.append(empty)}
  $("social-verdict").textContent=declared.length?`${declared.length} DECLARED / NOT ENDORSED`:"NO FOOTPRINT";
  $("social-proof").textContent=declared.length?"Declared on chain · external reputation not yet scored":"No valid social URLs declared in token metadata.";
  socialRequest++;if(meta.status==="DECLARED"&&meta.socials.twitter)researchX(meta.socials.twitter);
  const flags=[...launch.assessment.blockers];if(market.status==="VERIFIED"&&market.currentSnipeTaxBps>500)flags.push(`Snipe tax ${pct(market.currentSnipeTaxBps)}`);if(history.priorLaunches>=5)flags.push(`${history.priorLaunches} prior launches in window`);if(!declared.length)flags.push("No valid declared social links");flags.push(...launch.assessment.unknowns);
  const riskRoot=$("risk-flags");riskRoot.replaceChildren();flags.forEach(flag=>{const li=document.createElement("li");li.textContent=flag;riskRoot.append(li)});$("risk-verdict").textContent=flags.length?`${flags.length} FLAGS / GAPS`:"NO FLAGS IN CURRENT RULESET";
}

function buildRoute(){
  const root=$("route"); root.replaceChildren();
  names.forEach((name,i)=>{const el=document.createElement("div");el.className="agent";el.dataset.index=String(i);const role=document.createElement("span");role.textContent=`0${i+1}`.slice(-2)+" / "+roles[i];const title=document.createElement("strong");title.textContent=name;const status=document.createElement("small");status.textContent="STANDBY";el.append(role,title,status);root.append(el)});
}

function animate(decision){
  if(timer) clearInterval(timer); let i=0; const cards=[...document.querySelectorAll(".agent")];
  cards.forEach((card,index)=>{card.className="agent";card.querySelector("small").textContent="STANDBY";if(index===0)card.classList.add("active")});
  timer=setInterval(()=>{if(i>=cards.length){clearInterval(timer);return}const h=decision.handoffs[i];const card=cards[i];card.classList.remove("active");card.classList.add("done",h.outcome.toLowerCase());card.querySelector("small").textContent=h.outcome;i++;cards[i]?.classList.add("active")},120);
}

function selectLaunch(launch){
  const selectionChanged=selected?.transactionHash!==launch.transactionHash;
  selected=launch;
  if(selectionChanged){preparedTrade=null;if($("send-trade"))$("send-trade").disabled=true;if($("trade-result"))$("trade-result").textContent="Selection changed. Run every execution gate again."}
  document.querySelectorAll(".intercept").forEach(el=>el.classList.toggle("selected",el.dataset.tx===launch.transactionHash));
  $("selected-token").textContent=short(launch.token,8);$("trace-id").textContent=short(launch.transactionHash,8);
  $("pons-link").href=pons(launch.token);$("token-link").href=tokenExplorer(launch.token);$("tx-link").href=explorer(launch.transactionHash);
  const card=$("decision-card");card.className=`decision-card ${launch.verdict.toLowerCase()}`;$("decision").textContent=launch.verdict;$("decision-copy").textContent=launch.handoffs[9].message;
  const market=launch.market;
  $("score").textContent=String(launch.assessment.score).padStart(2,"0");
  $("progress").textContent=market.status==="VERIFIED"?pct(market.progressBps):"UNKNOWN";
  $("phase").textContent=market.status==="VERIFIED"?market.phase:market.status;
  $("taxes").textContent=market.status==="VERIFIED"?`${pct(market.creatorTaxBps)} / ${pct(market.currentSnipeTaxBps)}`:"—";
  const assessment=launch.assessment;
  const evidence=[];
  if(assessment.blockers.length)evidence.push(`BLOCKERS — ${assessment.blockers.join(" · ")}`);
  evidence.push(`SCORE — ${assessment.reasons.join(" · ")}`);
  evidence.push(`UNRESOLVED — ${assessment.unknowns.join(" · ")}`);
  $("evidence").textContent=evidence.join("  /  ");
  renderDossier(launch);
  const trace=$("trace");trace.replaceChildren();launch.handoffs.forEach(h=>{const li=document.createElement("li");li.className=h.outcome.toLowerCase();const seq=document.createElement("span");seq.textContent=`${String(h.sequence).padStart(2,"0")} / ${h.outcome}`;const title=document.createElement("strong");title.textContent=h.agent;const copy=document.createElement("p");copy.textContent=h.message;li.append(seq,title,copy);trace.append(li)});animate(launch);
  if(selectionChanged&&!deployerHistoryCache.has(deployerHistoryKey(launch)))researchHistory(launch);
  updateTradeControls();
}

function renderFeed(snapshot){
  const feed=$("feed");feed.replaceChildren();
  const launches=activeFilter==="ALL"?snapshot.launches:snapshot.launches.filter(x=>x.verdict===activeFilter);
  if(!launches.length){const empty=document.createElement("p");empty.className="empty";empty.textContent=`No ${activeFilter.toLowerCase()} launches in the current block window.`;feed.append(empty);return}
  launches.forEach((launch,i)=>{const button=document.createElement("button");button.type="button";button.className="intercept";button.dataset.tx=launch.transactionHash;const n=document.createElement("span");n.className="ordinal";n.textContent=String(i+1).padStart(2,"0");const body=document.createElement("div");const title=document.createElement("strong");title.textContent=short(launch.token,8);const meta=document.createElement("small");const progress=launch.market.status==="VERIFIED"?pct(launch.market.progressBps):"UNKNOWN";meta.textContent=`${launch.assessment.score}/100 · ${progress} CURVE · ${launch.pairLabel}`;body.append(title,meta);const badge=document.createElement("span");badge.className=`badge ${launch.verdict.toLowerCase()}`;badge.textContent=launch.verdict;button.append(n,body,badge);button.addEventListener("click",()=>selectLaunch(launch));feed.append(button)});
  const stillPresent=selected&&launches.find(x=>x.transactionHash===selected.transactionHash);selectLaunch(stillPresent||launches[0]);
}

function render(snapshot){
  latestSnapshot=snapshot;$("pulse").classList.add("online");$("block").textContent=`#${snapshot.headBlock.toLocaleString()}`;$("sync").textContent="LIVE";
  $("launch-count").textContent=String(snapshot.launches.length).padStart(2,"0");$("watch-count").textContent=String(snapshot.launches.filter(x=>x.verdict==="WATCH").length).padStart(2,"0");$("veto-count").textContent=String(snapshot.launches.filter(x=>x.verdict==="VETO").length).padStart(2,"0");
  $("updated").textContent=`SYNC ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`;
  renderFeed(snapshot);
}

async function sync(){try{const response=await fetch("/api/snapshot",{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);render(await response.json())}catch(error){$("pulse").classList.remove("online");$("sync").textContent="RETRYING";$("block").textContent="OFFLINE";$("updated").textContent=String(error.message||error).slice(0,70)}}

const tradeAcknowledgement="I UNDERSTAND THIS SUBMITS A REAL TRADE";
const txExplorer=(hash)=>`https://robinhoodchain.blockscout.com/tx/${hash}`;
const announcedMetaMaskProviders=new Map();
const boundWalletProviders=new WeakSet();
window.addEventListener("eip6963:announceProvider",event=>{const detail=event?.detail;if(!detail||typeof detail.info?.uuid!=="string"||typeof detail.provider?.request!=="function")return;if(detail.info.rdns==="io.metamask"||detail.info.rdns==="io.metamask.flask")announcedMetaMaskProviders.set(detail.info.uuid,detail.provider)});
window.dispatchEvent(new Event("eip6963:requestProvider"));
function readableUnits(raw,decimals){try{const n=BigInt(raw),base=10n**BigInt(decimals),whole=n/base,fraction=(n%base).toString().padStart(decimals,"0").slice(0,6).replace(/0+$/g,"");return `${whole}${fraction?`.${fraction}`:""}`}catch{return "—"}}
function updateTradeControls(){
  const ready=Boolean(tradePolicy?.enabled&&walletAuthenticated&&walletAddress&&selected&&$("trade-ack").checked&&$("trade-amount").value.trim());
  $("prepare-trade").disabled=!ready;
  $("setup-smart-account").disabled=!Boolean(smartAccountConfiguration?.enabled&&walletAuthenticated&&walletAddress&&selected&&!smartAccountGrant);
  $("revoke-smart-account").disabled=!Boolean(walletAuthenticated&&smartAccountGrant?.status==="ACTIVE");
}
function resetPreparedTrade(message){preparedTrade=null;$("send-trade").disabled=true;$("trade-result").textContent=message;$("trade-tx").hidden=true}
async function getMetaMaskProvider(){
  if(walletProvider)return walletProvider;
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise(resolve=>setTimeout(resolve,120));
  walletProvider=announcedMetaMaskProviders.values().next().value||(window.ethereum?.isMetaMask===true?window.ethereum:null);
  if(!walletProvider)throw new Error("MetaMask was not found. Install or unlock MetaMask and try again.");
  return walletProvider;
}
function bindWalletProvider(provider){
  if(typeof provider.on!=="function"||boundWalletProviders.has(provider))return;
  boundWalletProviders.add(provider);
  provider.on("accountsChanged",()=>{void logoutWallet("Wallet account changed. Authenticate the new account.")});
  provider.on("chainChanged",()=>{void logoutWallet("Wallet network changed. Authenticate again on Robinhood Chain.")});
  provider.on("disconnect",()=>{void logoutWallet("MetaMask disconnected. Authenticate again.")});
}
async function ensureRobinhoodChain(){
  const provider=await getMetaMaskProvider();
  const chain=await provider.request({method:"eth_chainId"});
  if(chain==="0x1237")return provider;
  try{await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x1237"}]})}
  catch(error){if(error&&error.code===4902){await provider.request({method:"wallet_addEthereumChain",params:[{chainId:"0x1237",chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://rpc.mainnet.chain.robinhood.com"],blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}]});return provider}throw error}
  return provider;
}
async function connectWallet(){
  if(walletAuthenticated){await logoutWallet("MetaMask session ended.");return}
  try{
    const provider=await ensureRobinhoodChain();
    let accounts;
    try{await provider.request({method:"wallet_requestPermissions",params:[{eth_accounts:{}}]});accounts=await provider.request({method:"eth_accounts"})}
    catch(error){if(error?.code!==4200&&error?.code!==-32601)throw error;accounts=await provider.request({method:"eth_requestAccounts"})}
    if(!Array.isArray(accounts)||accounts.length===0)accounts=await provider.request({method:"eth_requestAccounts"});
    const account=Array.isArray(accounts)&&typeof accounts[0]==="string"?accounts[0]:null;
    if(!account||!/^0x[0-9a-fA-F]{40}$/.test(account))throw new Error("Wallet returned an invalid account.");
    const wallet=account.toLowerCase();
    $("wallet-status").textContent=`SIGNATURE REQUEST · ${short(wallet,8)}`;
    const challengeResponse=await fetch("/api/auth/challenge",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify({wallet})});
    const challenge=await challengeResponse.json();if(!challengeResponse.ok)throw new Error(`${challenge.code||"AUTH_FAILED"}: ${challenge.error||`HTTP ${challengeResponse.status}`}`);
    const messageHex=`0x${Array.from(new TextEncoder().encode(challenge.message),byte=>byte.toString(16).padStart(2,"0")).join("")}`;
    const signature=await provider.request({method:"personal_sign",params:[messageHex,wallet]});
    const verifyResponse=await fetch("/api/auth/verify",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify({challengeId:challenge.challengeId,message:challenge.message,signature})});
    const verified=await verifyResponse.json();if(!verifyResponse.ok||!verified.authenticated)throw new Error(`${verified.code||"AUTH_FAILED"}: ${verified.error||`HTTP ${verifyResponse.status}`}`);
    walletAddress=String(verified.wallet).toLowerCase();walletAuthenticated=true;bindWalletProvider(provider);$("wallet-status").textContent=`METAMASK AUTHORIZED ${short(walletAddress,8)} · CHAIN 4663`;$("connect-wallet").textContent="SIGN OUT";resetPreparedTrade("Wallet ownership verified. Hardware-backed accounts remain device-gated. Select intent and run all gates.");await loadSmartAccountStatus();updateTradeControls();
  }catch(error){walletAddress=null;walletAuthenticated=false;$("connect-wallet").textContent="AUTHENTICATE METAMASK";$("wallet-status").textContent=String(error?.message||error).slice(0,120);updateTradeControls()}
}
async function logoutWallet(message="MetaMask authentication required."){
  try{await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:"{}"})}catch{}
  walletAddress=null;walletAuthenticated=false;smartAccountGrant=null;$("connect-wallet").textContent="AUTHENTICATE METAMASK";$("wallet-status").textContent=message;$("smart-account-status").textContent="Authenticate the MetaMask treasury to inspect its execution account.";resetPreparedTrade("Authenticate the wallet before preparing a trade.");updateTradeControls();
}
async function loadWalletSession(){
  try{const response=await fetch("/api/auth/session",{credentials:"same-origin",headers:{accept:"application/json"}});if(!response.ok)return;const session=await response.json();if(!session.authenticated)return;walletAddress=String(session.wallet).toLowerCase();walletAuthenticated=true;$("wallet-status").textContent=`AUTHENTICATED ${short(walletAddress,8)} · SESSION RESTORED`;$("connect-wallet").textContent="SIGN OUT";await loadSmartAccountStatus();updateTradeControls()}catch{}
}
async function loadTradePolicy(){
  try{
    const response=await fetch("/api/trade/policy",{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);tradePolicy=await response.json();
    $("trade-policy-status").textContent=tradePolicy.enabled?"POLICY ARMED · ABSOLUTE CAPS · NO % EQUITY CAP":"SERVER DISABLED";$("trade-slippage").max=String(tradePolicy.maxSlippageBps);updateTradeControls();
  }catch(error){$("trade-policy-status").textContent="POLICY UNAVAILABLE";$("trade-result").textContent=String(error?.message||error).slice(0,100)}
}
function renderSmartAccountGrant(grant){
  smartAccountGrant=grant;
  $("smart-account-link").hidden=!grant;$("smart-account-funding").hidden=!grant;
  if(!grant){$("smart-account-status").textContent=smartAccountConfiguration?.enabled?"Ready. Select a verified Pons launch, then authorize the isolated 24-hour account.":smartAccountConfiguration?.reason||"ERC-4337 setup is not configured.";updateTradeControls();return}
  $("smart-account-link").href=tokenExplorer(grant.account);$("smart-account-funding").href=txExplorer(grant.fundingTransactionHash);
  const expiry=new Date(grant.expiresAt).toLocaleString();$("smart-account-status").textContent=`${grant.status} · ${short(grant.account,8)} · ${short(grant.token,8)} / ${short(grant.curve,8)} · EXPIRES ${expiry}`;updateTradeControls();
}
async function loadSmartAccountStatus(){
  if(!walletAuthenticated){renderSmartAccountGrant(null);return}
  try{const response=await fetch("/api/smart-account/status",{credentials:"same-origin",headers:{accept:"application/json"}});const result=await response.json();if(!response.ok)throw new Error(`${result.code||"STATUS_FAILED"}: ${result.error||`HTTP ${response.status}`}`);renderSmartAccountGrant(result.grant)}catch(error){smartAccountGrant=null;$("smart-account-status").textContent=String(error?.message||error).slice(0,160);updateTradeControls()}
}
async function loadSmartAccountConfiguration(){
  try{const response=await fetch("/api/smart-account/config",{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`HTTP ${response.status}`);smartAccountConfiguration=await response.json();$("smart-account-status").textContent=smartAccountConfiguration.enabled?"Authenticate MetaMask and select a verified Pons launch to create the isolated execution account.":smartAccountConfiguration.reason;updateTradeControls()}catch(error){smartAccountConfiguration={enabled:false,reason:String(error?.message||error)};$("smart-account-status").textContent="ERC-4337 configuration unavailable.";updateTradeControls()}
}
async function setupSmartAccount(){
  if(!selected||!walletAddress||!smartAccountConfiguration?.enabled)return;
  $("setup-smart-account").disabled=true;$("smart-account-status").textContent="Verifying Pons provenance and pricing the $30 ceiling…";
  try{
    const provider=await ensureRobinhoodChain();bindWalletProvider(provider);
    const planResponse=await fetch("/api/smart-account/plan",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify({token:selected.token,curve:selected.curve})});
    const plan=await planResponse.json();if(!planResponse.ok)throw new Error(`${plan.code||"PLAN_FAILED"}: ${plan.error||`HTTP ${planResponse.status}`}`);
    $("smart-account-cap").textContent=`$${plan.spendCapUsd} / ${formatWei(plan.spendCapWei)} + ${formatWei(plan.gasReserveWei)} GAS`;
    $("smart-account-status").textContent=`MetaMask will authorize ${short(plan.sessionKey,8)} until ${new Date(plan.expiresAt).toLocaleString()}, then fund exactly ${formatWei(plan.totalFundingWei)}.`;
    if(!window.GptheistSmartAccount?.setup)throw new Error("Alchemy Wallet API client did not load.");
    const result=await window.GptheistSmartAccount.setup({provider,owner:walletAddress,plan});
    $("smart-account-link").href=tokenExplorer(result.account);$("smart-account-link").hidden=false;$("smart-account-funding").href=txExplorer(result.fundingTransactionHash);$("smart-account-funding").hidden=false;
    await loadSmartAccountStatus();
  }catch(error){$("smart-account-status").textContent=String(error?.message||error).slice(0,220)}
  finally{updateTradeControls()}
}
async function revokeSmartAccount(){
  $("revoke-smart-account").disabled=true;$("smart-account-status").textContent="Deleting the only usable permission context…";
  try{const response=await fetch("/api/smart-account/revoke",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:"{}"});const result=await response.json();if(!response.ok)throw new Error(`${result.code||"REVOKE_FAILED"}: ${result.error||`HTTP ${response.status}`}`);await loadSmartAccountStatus()}catch(error){$("smart-account-status").textContent=String(error?.message||error).slice(0,180)}finally{updateTradeControls()}
}
async function prepareTrade(){
  if(!selected||!walletAddress)return;
  resetPreparedTrade("Running chain, venue, amount, fee, quote, simulation, and balance gates…");$("prepare-trade").disabled=true;$("trade-gate-list").replaceChildren();
  try{
    await ensureRobinhoodChain();
    const response=await fetch("/api/trade/prepare",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify({side:$("trade-side").value,token:selected.token,curve:selected.curve,wallet:walletAddress,amount:$("trade-amount").value.trim(),slippageBps:Number($("trade-slippage").value),acknowledgement:tradeAcknowledgement})});
    const result=await response.json();if(!response.ok)throw new Error(`${result.code||"GATE_BLOCKED"}: ${result.error||`HTTP ${response.status}`}`);
    preparedTrade=result;result.gates.forEach(gate=>{const li=document.createElement("li");li.textContent=`PASS / ${gate.id} — ${gate.detail}`;$("trade-gate-list").append(li)});
    $("trade-expected").textContent=`${readableUnits(result.expectedOut,result.outputDecimals)} ${result.side==="BUY"?"TOKEN":"ETH"}`;$("trade-minimum").textContent=`${readableUnits(result.minOut,result.outputDecimals)} ${result.side==="BUY"?"TOKEN":"ETH"}`;$("trade-fees").textContent=`${result.totalFeeBps} BPS`;$("trade-impact").textContent=`${result.priceImpactBps} BPS`;$("trade-expiry").textContent=`BLOCK ${result.expiresAfterBlock.toLocaleString()}`;
    $("send-trade").disabled=false;$("trade-result").textContent=`PREPARED ${result.auditId}. Review the wallet transaction before approving.`;
  }catch(error){const li=document.createElement("li");li.className="blocked";li.textContent=String(error?.message||error).slice(0,180);$("trade-gate-list").append(li);$("trade-result").textContent="No transaction was prepared or submitted."}
  finally{updateTradeControls()}
}
async function sendPreparedTrade(){
  if(!preparedTrade||!walletAddress)return;
  $("send-trade").disabled=true;$("trade-result").textContent="Opening the wallet's final transaction review…";
  try{
    const provider=await ensureRobinhoodChain();bindWalletProvider(provider);
    const head=Number.parseInt(await provider.request({method:"eth_blockNumber"}),16);if(!Number.isSafeInteger(head)||head>preparedTrade.expiresAfterBlock)throw new Error("Quote expired. Run the execution gates again.");
    const accounts=await provider.request({method:"eth_accounts"});if(!Array.isArray(accounts)||String(accounts[0]||"").toLowerCase()!==preparedTrade.wallet)throw new Error("Connected wallet changed. Run the execution gates again.");
    const hash=await provider.request({method:"eth_sendTransaction",params:[preparedTrade.transaction]});if(typeof hash!=="string"||!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new Error("Wallet returned an invalid transaction hash.");
    $("trade-result").textContent=`SUBMITTED ${short(hash,10)} · wallet-approved`;$("trade-tx").href=txExplorer(hash);$("trade-tx").hidden=false;preparedTrade=null;
  }catch(error){$("trade-result").textContent=String(error?.message||error).slice(0,160);$("send-trade").disabled=false}
}

document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{activeFilter=button.dataset.filter;document.querySelectorAll("[data-filter]").forEach(item=>item.classList.toggle("active",item===button));if(latestSnapshot)renderFeed(latestSnapshot)}));
$("connect-wallet").addEventListener("click",connectWallet);$("prepare-trade").addEventListener("click",prepareTrade);$("send-trade").addEventListener("click",sendPreparedTrade);$("setup-smart-account").addEventListener("click",setupSmartAccount);$("revoke-smart-account").addEventListener("click",revokeSmartAccount);["trade-side","trade-amount","trade-slippage","trade-ack"].forEach(id=>$(id).addEventListener("input",()=>{resetPreparedTrade("Trade intent changed. Run every execution gate again.");updateTradeControls()}));
buildRoute();loadTradePolicy();loadSmartAccountConfiguration();loadWalletSession();sync();setInterval(sync,1000);
