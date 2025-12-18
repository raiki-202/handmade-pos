
/**
 * e.nue Dashboard (bundle + patch skeleton)
 * - Bundles: /data/*.json (served by GitHub Pages)
 * - Patches: Firestore docs/collections (optional)
 * 
 * This file is safe to run even without Firebase (it will just show bundle-only demo).
 */

const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

function fmtYen(n){
  try{
    const v = Number(n||0);
    return v.toLocaleString("ja-JP");
  }catch{ return String(n); }
}

/** ---------- Bundle loader ---------- */
async function loadJson(url){
  const r = await fetch(url, {cache:"no-store"});
  if(!r.ok) throw new Error("fetch failed: " + url);
  return await r.json();
}

/**
 * Patch format (suggested)
 * - monthly patch doc: /patches/summary-YYYY-MM (or /patches/assets-YYYY-MM)
 * - purchase history: /patches/sales-YYYY-MM with arrays of records or delta totals
 */
async function tryLoadFirestorePatch(getPatchFn){
  // getPatchFn should be async (key) => data|null
  // This is injected only if Firebase is available.
  if(typeof getPatchFn !== "function") return null;
  try{
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    return await getPatchFn(ym);
  }catch(e){
    console.warn("patch load failed", e);
    return null;
  }
}

/** ---------- UI: chart swap motion ---------- */
function initSwap(){
  const stage = $(".swapStage");
  if(!stage) return;
  const btnOrders = $("#btnOrders");
  const btnAssets = $("#btnAssets");
  const panelOrders = $("#panelOrders");
  const panelAssets = $("#panelAssets");

  function setActive(which){
    if(which === "orders"){
      panelOrders.classList.add("active");
      panelAssets.classList.remove("active");
    }else{
      panelAssets.classList.add("active");
      panelOrders.classList.remove("active");
    }
  }

  btnOrders?.addEventListener("click", ()=>setActive("orders"));
  btnAssets?.addEventListener("click", ()=>setActive("assets"));

  // Default
  setActive("orders");
}

/** ---------- Dashboard demo bind ---------- */
async function initDashboard({getPatchFn} = {}){
  initSwap();

  // 1) load bundle (past months)
  let bundle;
  try{
    bundle = await loadJson("./data/summary-bundle.json");
  }catch(e){
    console.error(e);
    bundle = null;
  }

  // 2) load patch (current month)
  const patch = await tryLoadFirestorePatch(getPatchFn);

  // 3) merge (simple: overwrite current month)
  const merged = structuredClone(bundle || { months: [] });
  if(patch?.month){
    const i = merged.months.findIndex(m => m.month === patch.month);
    if(i >= 0) merged.months[i] = patch;
    else merged.months.push(patch);
    merged.months.sort((a,b)=>a.month.localeCompare(b.month));
  }

  // 4) render KPIs (latest month)
  const months = merged.months || [];
  const last = months[months.length-1] || {assets:0, orders:0, revenue:0};
  $("#kpiAssets").textContent = fmtYen(last.assets);
  $("#kpiOrders").textContent = fmtYen(last.orders);
  $("#kpiRevenue").textContent = fmtYen(last.revenue);

  // placeholders (you can later replace with real charts)
  $("#ordersText").textContent = `月別受注件数（${months.length}ヶ月分：bundle + 当月patch）`;
  $("#assetsText").textContent = `月別総資産（${months.length}ヶ月分：bundle + 当月patch）`;
}

/** ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", ()=>{
  // If Firebase is not wired yet, run bundle-only mode.
  initDashboard();
});

export { initDashboard };
