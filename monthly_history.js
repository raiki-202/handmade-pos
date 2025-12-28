import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
  import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
  import {
    getFirestore,
    collection, doc, query, where, orderBy, limit, getDocs, addDoc, updateDoc, serverTimestamp, Timestamp
  } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

  // ✅ 本番（既存ファイルと同じ）
  const firebaseConfig = {
    apiKey: "AIzaSyAhPCgPoJK6S6BWVcBZOruYqMPXVQXQFRk",
    authDomain: "handmade-pos.firebaseapp.com",
    projectId: "handmade-pos",
    storageBucket: "handmade-pos.firebasestorage.app",
    messagingSenderId: "174873514252",
    appId: "1:174873514252:web:c26659bffca850d475f929"
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // ---- UI refs
  const el = (id)=>document.getElementById(id);
  const monthsEl = el("months");
  const statsEl  = el("stats");
  const authStateEl = el("authState");
  const toastEl = el("toast");

  const yearSel = el("yearSel");
  const monthSel = el("monthSel");
  const qEl = el("q");

  const btnHome = el("btnHome");
  const btnOther = el("btnOther");
  const btnReload = el("btnReload");
  const btnCsv = el("btnCsv");

  // ---- helpers
  const pad2 = (n)=> String(n).padStart(2,"0");
  const fmtYMD = (d)=> `${d.getFullYear()}/${pad2(d.getMonth()+1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtMoney = (n)=> {
    const v = Number(n||0);
    return "¥" + v.toLocaleString("ja-JP");
  };
  const ymKey = (d)=> `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    setTimeout(()=>toastEl.classList.remove("on"), 1400);
  }

  function safeStr(v){
    if(v===null || v===undefined) return "";
    return String(v);
  }

  function normalizeText(s){
    return safeStr(s).toLowerCase().replace(/\\s+/g," ").trim();
  }

  function saleToSearchText(sale){
    const parts = [];
    parts.push(sale.id);
    parts.push(sale.buyerName);
    parts.push(sale.channel);
    parts.push(sale.paymentMethod);
    parts.push(sale.memo);
    parts.push(sale.shippingOption);
    parts.push(sale.kind);
    parts.push(sale.parentSaleId);
    parts.push(sale.isRefund ? "refund" : "");
    if(Array.isArray(sale.items)){
      for(const it of sale.items){
        parts.push(it.name, it.productName, it.sku, it.code);
      }
    }
    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function escapeHtml(str){
    return safeStr(str)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  // ---- data cache
  let rawSales = [];                 // normalized
  let lastBuilt = null;              // { list, groups }
  let currentUser = null;

  
  // ---- fix request cache
  let fixReqList = [];               // raw fix requests (recent)
  let fixReqBySale = new Map();      // saleId -> {pending:[], done:[]}

  function rebuildFixReqIndex(){
    fixReqBySale = new Map();
    for(const r of fixReqList){
      const sid = safeStr(r.saleId);
      if(!sid) continue;
      if(!fixReqBySale.has(sid)) fixReqBySale.set(sid, { pending: [], done: [] });
      const bucket = fixReqBySale.get(sid);
      const st = safeStr(r.status);
      if(st === "完了") bucket.done.push(r);
      else bucket.pending.push(r); // 依頼中 or unknown
    }
    // sort newest first (createdAtMs desc)
    for(const b of fixReqBySale.values()){
      b.pending.sort((a,b)=> (b.createdAtMs||0)-(a.createdAtMs||0));
      b.done.sort((a,b)=> (b.createdAtMs||0)-(a.createdAtMs||0));
    }
  }

  function getFixCountsCached(saleId){
    const b = fixReqBySale.get(saleId);
    return { pending: b ? b.pending.length : 0, done: b ? b.done.length : 0 };
  }

  function getLatestPending(saleId){
    const b = fixReqBySale.get(saleId);
    return (b && b.pending.length) ? b.pending[0] : null;
  }

  function getLatestDone(saleId){
    const b = fixReqBySale.get(saleId);
    return (b && b.done.length) ? b.done[0] : null;
  }

// ---- option lists (自動収集)
  let optPaymentMethods = [];
  let optChannels = [];

  function uniqSorted(arr){
    const set = new Set(arr.map(v=>safeStr(v).trim()).filter(Boolean));
    return [...set].sort((a,b)=>a.localeCompare(b,'ja'));
  }
  function buildOptionsHTML(list, current){
    const cur = safeStr(current).trim();
    const opts = [];
    // current が候補に無い場合も先頭に出す
    if(cur && !list.includes(cur)){
      opts.push(`<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`);
    }
    for(const v of list){
      const sel = (v===cur) ? " selected" : "";
      opts.push(`<option value="${escapeHtml(v)}"${sel}>${escapeHtml(v)}</option>`);
    }
    // 自由入力
    opts.push(`<option value="__custom__">（自由入力）</option>`);
    return opts.join("");
  }

  // ---- routing
  btnHome.addEventListener("click", ()=> location.href = "index.html");
  btnOther.addEventListener("click", ()=> location.href = "otherpage.html");
  btnReload.addEventListener("click", ()=> loadAll(true));
  btnCsv.addEventListener("click", ()=> exportCsv());

  yearSel.addEventListener("change", ()=> render());
  monthSel.addEventListener("change", ()=> render());
  qEl.addEventListener("input", ()=> render());

  function fillYearOptions(sales){
    const years = new Set(sales.map(s=> s.date.getFullYear()));
    const arr = [...years].sort((a,b)=>b-a);

    // fallback: 今年〜過去3年
    const nowY = new Date().getFullYear();
    if(arr.length===0){
      for(let y=nowY; y>=nowY-3; y--) arr.push(y);
    }else{
      if(!years.has(nowY)) arr.unshift(nowY);
    }

    yearSel.innerHTML = "";
    for(const y of arr){
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = `${y}年`;
      yearSel.appendChild(opt);
    }
  }

  function normalizeSale(docSnap){
    const data = docSnap.data ? docSnap.data() : docSnap;

    let createdAt = data.createdAt;
    let date = null;
    try{
      if(createdAt?.toDate) date = createdAt.toDate();
      else if(typeof createdAt === "number") date = new Date(createdAt);
      else if(typeof createdAt === "string") date = new Date(createdAt);
    }catch(e){}
    if(!date || isNaN(date.getTime())){
      date = new Date(0);
    }

    const items = Array.isArray(data.items) ? data.items.map(it=>({
      id: it.id ?? it.productId ?? it.sku ?? "",
      name: it.name ?? it.productName ?? "",
      qty: Number(it.qty ?? it.quantity ?? 0),
      unitPrice: Number(it.unitPrice ?? it.price ?? it.unit ?? 0),
      // 互換用（古いコードが price を参照しても動くよう残す）
      price: Number(it.unitPrice ?? it.price ?? it.unit ?? 0),
      subtotal: Number(
        it.subtotal ??
        (Number(it.unitPrice ?? it.price ?? it.unit ?? 0) * Number(it.qty ?? it.quantity ?? 0)) ??
        0
      ),
      raw: it
    })) : [];

    const total =
      Number(data.total ?? data.totalAmount ?? data.grandTotal ?? data.amount ?? 0) ||
      items.reduce((a,b)=> a + (Number(b.subtotal)||0), 0);

    // バンドル由来判定（存在するなら尊重、無い場合は kind/source でも判定）
    const isBundled = Boolean(
      data.isBundled ?? data.bundled ?? (safeStr(data.source).toLowerCase()==="bundle") ?? false
    ) || (safeStr(data.kind).toLowerCase()==="bundle");
    const parentSaleId = data.parentSaleId ?? data.parentId ?? "";

    const isRefund = Boolean(data.isRefund ?? false) || (safeStr(data.channel).toLowerCase()==="refund") || (Number(data.total ?? data.totalAmount ?? data.grandTotal ?? data.amount ?? 0) < 0 && parentSaleId);

    const sale = {
      id: docSnap.id ?? data.id ?? "",
      date,
      total,
      items,

      // 表示用
      buyerName: data.buyerName ?? data.customerName ?? data.purchaserName ?? "",
      orderDate: data.orderDate ?? "",
      orderDateMs: Number(data.orderDateMs ?? 0) || 0,
      createdAtText: createdAt?.toDate ? createdAt.toDate().toLocaleString('ja-JP') : (typeof createdAt==='number' ? new Date(createdAt).toLocaleString('ja-JP') : (createdAt?.seconds ? new Date(createdAt.seconds*1000).toLocaleString('ja-JP') : "")),
      clientCreatedAt: Number(data.clientCreatedAt ?? 0) || 0,
      channel: data.channel ?? data.channelId ?? "",
      channelLabel: data.channelLabel ?? "",
      paymentId: data.paymentId ?? "",
      paymentLabel: data.paymentLabel ?? "",
      paymentMethod: data.paymentMethod ?? data.payment ?? data.paymentId ?? "",
      venue: data.venue ?? data.venueId ?? "",
      venueLabel: data.venueLabel ?? "",
      kindId: data.kindId ?? "",
      kindLabel: data.kindLabel ?? "",
      urgentOptionId: data.urgentOptionId ?? "",
      urgentOptionLabel: data.urgentOptionLabel ?? "",
      memo: data.memo ?? data.note ?? "",
      shippingOption: data.shippingOption ?? "",
      kind: data.kind ?? "",

      parentSaleId,
      isRefund,

      isBundled
    };
    sale._search = saleToSearchText(sale);
    sale._ym = ymKey(date);
    return sale;
  }

  
// ======================
// Bundle + Patch 読み込み
// ======================
// 1) bundle (JSON) を基本として読み込み
// 2) Firestore の差分（updates/adds）だけを重ねる
//
// ※ GitHub Pages で動かす場合：
//    - bundle JSON は同じリポジトリ内に置いて fetch できるようにする
//    - 例: /bundles/sales_bundle.json など
const BUNDLE_PATH = "./sales_bundle.json"; // ←必要ならパス変更

// 読み取り件数（表示用）
let readCountJson = 0;
let readCountFirebase = 0;

async function loadBundleSales(){
  readCountJson = 0;
  try{
    const res = await fetch(BUNDLE_PATH, { cache: "no-store" });
    if(!res.ok) throw new Error("bundle fetch failed");
    const data = await res.json();

    // 期待形式：{ sales:[ ... ] } または [ ... ]
    const list = Array.isArray(data) ? data : (Array.isArray(data.sales) ? data.sales : []);
    // bundle 由来フラグ付与
    for(const s of list){
      if(s && typeof s === "object"){
        if(!("isBundled" in s)) s.isBundled = true;
        if(!("source" in s)) s.source = "bundle";
      }
    }
    readCountJson = list.length;
    return list;
  }catch(err){
    console.warn("bundle load failed", err);
    readCountJson = 0;
    return [];
  }
}

async function loadSalesPatches(){
  readCountFirebase = 0;
  // updates: 既存 saleId を上書きする差分
  // adds:    新規 sale を追加する差分
  const updates = [];
  const adds = [];

  try{
    const [uSnap, aSnap] = await Promise.all([
      getDocs(query(collection(db, "sales_patch_updates"), limit(5000))),
      getDocs(query(collection(db, "sales_patch_adds"), limit(5000)))
    ]);

    uSnap.forEach(d=>{
      updates.push({ id: d.id, ...((d.data && d.data()) || {}) , source:"firebase" });
    });
    aSnap.forEach(d=>{
      adds.push({ id: d.id, ...((d.data && d.data()) || {}) , source:"firebase" });
    });

    readCountFirebase = updates.length + adds.length;
  }catch(err){
    // まだコレクションが無い / 権限が無い等でも UI が落ちないようにする
    console.warn("patch load failed", err);
    readCountFirebase = 0;
  }

  return { updates, adds };
}

function mergeBundleAndPatches(bundleList, patch){
  const map = new Map();

  // bundle をベース
  for(const s of (bundleList || [])){
    const id = safeStr(s?.id || "");
    if(!id) continue;
    map.set(id, { ...s });
  }

  // updates を上書き（存在しない id は新規扱いで入れる）
  for(const u of (patch?.updates || [])){
    const id = safeStr(u?.id || "");
    if(!id) continue;
    const cur = map.get(id) || { id };
    map.set(id, { ...cur, ...u });
  }

  // adds を追加（同じ id があれば上書き）
  for(const a of (patch?.adds || [])){
    const id = safeStr(a?.id || "");
    if(!id) continue;
    map.set(id, { ...a, id });
  }

  return [...map.values()];
}

async function loadSales(){
  // 旧：Firestore の sales を丸読み
  // 新：bundle を基本にして、Firestore は差分だけ読む
  const bundleList = await loadBundleSales();
  const patch = await loadSalesPatches();

  const mergedRaw = mergeBundleAndPatches(bundleList, patch);

  // normalize
  rawSales = mergedRaw.map(x=> normalizeSale(x));

  // option lists を sales から自動収集
  optPaymentMethods = uniqSorted(rawSales.map(x=>x.paymentMethod));
  optChannels       = uniqSorted(rawSales.map(x=>x.channel));

  fillYearOptions(rawSales);
  const latest = rawSales.find(s=> s.date.getTime()>0);
  if(latest){
    yearSel.value = String(latest.date.getFullYear());
  }
}


async function loadFixRequests(){
    // 修正依頼は多くてもそこまで増えない想定：最新5000件まで
    try{
      const q = query(
        collection(db, "sales_fix_requests"),
        orderBy("createdAt", "desc"),
        limit(5000)
      );
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d=>{
        const data = d.data() || {};
        const createdAt = data.createdAt;
        const createdAtMs =
          (createdAt?.toDate ? createdAt.toDate().getTime()
            : (createdAt?.seconds ? createdAt.seconds*1000
              : (typeof createdAt === "number" ? createdAt : 0)));
        list.push({
          id: d.id,
          ...data,
          createdAtMs
        });
      });
      fixReqList = list;
      rebuildFixReqIndex();
    }catch(err){
      console.warn("loadFixRequests failed", err);
      fixReqList = [];
      rebuildFixReqIndex();
    }
  }


  async function loadAll(force=false){
    authStateEl.textContent = "読み込み中…";
    monthsEl.innerHTML = "";
    statsEl.innerHTML = "";

    try{
      await loadSales();
      await loadFixRequests();

      authStateEl.textContent = `OK（bundle(json): ${readCountJson} 件 / patch(firebase): ${readCountFirebase} 件 / 合算: ${rawSales.length} 件 / 修正依頼: ${fixReqList.length} 件）`;
      render();
    }catch(err){
      console.error(err);
      authStateEl.textContent = "読み込み失敗";
      monthsEl.innerHTML = `<div class="empty">読み込みに失敗しました。<br><span class="muted">Firestore ルール / インデックス / createdAt の型を確認してね。</span></div>`;
      toast("読み込み失敗");
    }
  }

  function buildGroups(filtered){
    const map = new Map();
    for(const s of filtered){
      const key = s._ym;
      if(!map.has(key)){
        map.set(key, { monthKey:key, total:0, count:0, sales:[] });
      }
      const g = map.get(key);
      g.total += Number(s.total||0);
      g.count += 1;
      g.sales.push(s);
    }
    for(const g of map.values()){
      g.sales.sort((a,b)=> b.date - a.date);
    }
    const arr = [...map.values()].sort((a,b)=> b.monthKey.localeCompare(a.monthKey));
    return arr;
  }

  function applyFilters(){
    const y = Number(yearSel.value);
    const m = monthSel.value === "all" ? null : Number(monthSel.value);
    const q = normalizeText(qEl.value);

    return rawSales.filter(s=>{
      if(s.date.getTime()<=0) return false;
      if(s.date.getFullYear() !== y) return false;
      if(m && (s.date.getMonth()+1)!==m) return false;
      if(q && !s._search.includes(q)) return false;
      return true;
    });
  }

  function renderStats(list){
    const total = list.reduce((a,b)=> a + Number(b.total||0), 0);
    const cnt = list.length;

    statsEl.innerHTML = "";
    const p1 = document.createElement("div");
    p1.className = "pill";
    p1.textContent = `合計：${fmtMoney(total)}`;
    statsEl.appendChild(p1);

    const p2 = document.createElement("div");
    p2.className = "pill";
    p2.textContent = `件数：${cnt.toLocaleString("ja-JP")} 件`;
    statsEl.appendChild(p2);

    // 読み取り件数（firebase / json）
    const p3 = document.createElement("div");
    p3.className = "pill";
    p3.textContent = `読込：firebase ${readCountFirebase.toLocaleString("ja-JP")} 件 / json ${readCountJson.toLocaleString("ja-JP")} 件`;
    statsEl.appendChild(p3);
  }

  function render(){
    if(!rawSales.length){
      monthsEl.innerHTML = `<div class="empty">データがありません。</div>`;
      return;
    }

    const list = applyFilters();
    renderStats(list);

    const groups = buildGroups(list);
    lastBuilt = { list, groups };

    monthsEl.innerHTML = "";
    if(groups.length===0){
      monthsEl.innerHTML = `<div class="empty">該当データがありません。</div>`;
      return;
    }

    for(const g of groups){
      const [yy,mm] = g.monthKey.split("-");
      const monthLabel = `${yy}年${Number(mm)}月`;

      const det = document.createElement("details");
      det.className = "month";

      const sum = document.createElement("summary");

      const left = document.createElement("div");
      left.className = "mLeft";
      left.innerHTML = `<div class="mTitle">${monthLabel}</div><div class="mSub">タップで明細</div>`;

      const right = document.createElement("div");
      right.className = "mRight";
      right.innerHTML = `<div class="mTotal">${fmtMoney(g.total)}</div><div class="mCount">${g.count} 件</div>`;

      sum.appendChild(left);
      sum.appendChild(right);
      det.appendChild(sum);

      const salesWrap = document.createElement("div");
      salesWrap.className = "sales";

      for(const s of g.sales){
        const card = document.createElement("div");
        card.className = "saleCard";
        card.addEventListener("click", ()=>{
          openSaleDrawer(s);
        });

        const sRow = document.createElement("div");
        sRow.className = "saleSum";

        const sLeft = document.createElement("div");
        sLeft.className = "saleLeft";

        const top = document.createElement("div");
        top.className = "saleTop";

        const d = document.createElement("div");
        d.className = "saleDate";
        d.textContent = (s.orderDate ? s.orderDate : fmtYMD(s.date));

        top.appendChild(d);

        // 販売方法（channel）
        if(s.channelLabel || s.channel){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = (s.channelLabel || s.channel);
          top.appendChild(b);
        }

        if(s.isRefund){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = "返金";
          top.appendChild(b);
        }

        
        
        if(s.isBundled){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = "バンドル";
          top.appendChild(b);
        }

        const latestDone = getLatestDone(s.id);
        if(latestDone && safeStr(latestDone.adminMemo || "").includes("バンドルを修正します")){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = "バンドル修正";
          top.appendChild(b);
        }

// 修正依頼バッジ（依頼中/完了）
        const fc = getFixCountsCached(s.id);
        if((fc.pending||0) > 0){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = `依頼中 ${fc.pending}`;
          top.appendChild(b);
        }
        if((fc.done||0) > 0){
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = `完了 ${fc.done}`;
          top.appendChild(b);
        }
const bottom = document.createElement("div");
        bottom.className = "saleBottom";

        const bn = document.createElement("div");
        bn.className = "saleBuyer";
        bn.textContent = (s.buyerName ?? "");

        const t = document.createElement("div");
        t.className = "saleTotal";
        t.textContent = fmtMoney(s.total);

        bottom.appendChild(bn);
        bottom.appendChild(t);

        sLeft.appendChild(top);
        sLeft.appendChild(bottom);

        const sRight = document.createElement("div");
        sRight.className = "saleRight";

        const editBtn = document.createElement("button");
        editBtn.className = "editBtn";
        editBtn.type = "button";
        editBtn.textContent = "✎";
        editBtn.title = "編集";
        editBtn.addEventListener("click", (e)=>{
          e.preventDefault();
          e.stopPropagation();
          openEditChoiceModal(s);
        });

        sRow.appendChild(sLeft);
        sRow.appendChild(sRight);
        sRow.appendChild(editBtn);
        card.appendChild(sRow);

        salesWrap.appendChild(card);
      }

      det.appendChild(salesWrap);
      monthsEl.appendChild(det);
    }
  }

  function exportCsv(){
    if(!lastBuilt || !lastBuilt.list){
      toast("データなし");
      return;
    }

    const list = lastBuilt.list.slice().sort((a,b)=> b.date - a.date);

    const header = ["id","date","total","buyerName","channel","paymentMethod","kind","parentSaleId","isRefund","memo","itemName","qty","price","subtotal"];
    const lines = [header.join(",")];

    for(const s of list){
      const base = [
        csvCell(s.id),
        csvCell(fmtYMD(s.date)),
        csvCell(s.total),
        csvCell(s.buyerName),
        csvCell(s.channel),
        csvCell(s.paymentMethod),
        csvCell(s.kind),
        csvCell(s.parentSaleId),
        csvCell(s.isRefund ? "true" : ""),
        csvCell(s.memo)
      ];

      if(s.items?.length){
        for(const it of s.items){
          const row = base.concat([
            csvCell(it.name),
            csvCell(it.qty),
            csvCell(it.price),
            csvCell(it.subtotal)
          ]);
          lines.push(row.join(","));
        }
      }else{
        const row = base.concat([csvCell(""),csvCell(""),csvCell(""),csvCell("")]);
        lines.push(row.join(","));
      }
    }

    const blob = new Blob(["\\ufeff" + lines.join("\\n")], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const y = yearSel.value || "year";
    const m = monthSel.value === "all" ? "all" : pad2(monthSel.value);
    a.download = `monthly_sales_${y}_${m}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast("CSV出しました");
  }

  function csvCell(v){
    const s = safeStr(v);
    if(/[",\\n]/.test(s)){
      return '"' + s.replaceAll('"','""') + '"';
    }
    return s;
  }

  // ======================
  //  編集フロー
  // ======================
  function closeModal(modal){
    if(modal && modal.remove) modal.remove();
  }

  // =========================
  // Bottom Drawer : Sale Detail
  // =========================
  let drawerEl = null;
  let drawerBackdropEl = null;

  function ensureDrawer(){
    if(drawerEl && drawerBackdropEl) return;

    drawerBackdropEl = document.createElement("div");
    drawerBackdropEl.className = "drawerBackdrop";
    drawerBackdropEl.addEventListener("click", ()=> closeSaleDrawer());

    drawerEl = document.createElement("div");
    drawerEl.className = "drawer";
    drawerEl.innerHTML = `
      <div class="drawerHeader">
        <div class="drawerTitle">
          <div class="big" id="drawerBig">明細</div>
          <div class="sub" id="drawerSub"></div>
        </div>
        <button class="drawerClose" id="drawerCloseBtn" type="button">閉じる</button>
      </div>
      <div class="drawerBody" id="drawerBody"></div>
    `;
    drawerEl.querySelector("#drawerCloseBtn").addEventListener("click", ()=> closeSaleDrawer());

    document.body.appendChild(drawerBackdropEl);
    document.body.appendChild(drawerEl);
  }

  function closeSaleDrawer(){
    if(!drawerEl) return;
    drawerEl.classList.remove("open");
    drawerBackdropEl.classList.remove("open");
    // iOS 背景スクロール復帰
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }

  function openSaleDrawer(sale){
    ensureDrawer();

    // 背景スクロール抑止
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    const dateText = sale.orderDate ? sale.orderDate : fmtYMD(sale.date);
    const big = `${fmtMoney(sale.total)}`;
    const sub = `${dateText}${(sale.buyerName? " / " + sale.buyerName : "")}`;

    drawerEl.querySelector("#drawerBig").textContent = big;
    drawerEl.querySelector("#drawerSub").textContent = sub;

    const body = drawerEl.querySelector("#drawerBody");

    const kv = (k,v)=>`<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v ?? "")}</div>`;

    const channel = sale.channelLabel || sale.channel || "";
    const payment = sale.paymentLabel || sale.paymentMethod || sale.paymentId || "";
    const kind = sale.kindLabel || sale.kindId || "";
    const venue = sale.venueLabel || sale.venue || "";
    const urgent = sale.urgentOptionLabel || sale.urgentOptionId || "";
    const memo = sale.memo || "";
    const latestDone = getLatestDone(sale.id);
    const bundleFixDone = !!(latestDone && safeStr(latestDone.adminMemo || "").includes("バンドルを修正します"));


    let html = `
      <div class="kv">
        ${kv("購入者", sale.buyerName ?? "")}
        ${kv("購入日付", dateText)}
        <div class="k">修正履歴</div><div class="v"><span id="fixPending">-</span>件（依頼中） / <span id="fixDone">-</span>件（完了）</div>
        ${kv("販売方法", channel)}
        ${kv("決済方法", payment)}
        ${kv("開催場所", venue)}
        ${kv("販売種別", kind)}
        ${urgent ? kv("緊急オプション", urgent) : ""}
        ${memo ? kv("メモ", memo) : ""}
                ${sale.parentSaleId ? kv("親Sale", sale.parentSaleId) : ""}
        ${sale.isRefund ? kv("返金", "はい") : ""}
        ${sale.isBundled ? kv("Bundle", "はい") : ""}
        ${bundleFixDone ? kv("バンドル修正", "完了（バンドル修正します）") : ""}
      </div>
    `;

    // items
    const rows = Array.isArray(sale.items) ? sale.items : [];
    html += `<div class="sectionTitle">商品明細</div>`;
    if(!rows.length){
      html += `<div class="empty">明細（items）がありません。</div>`;
    }else{
      html += `
        <table class="drawerTable">
          <thead>
            <tr>
              <th>商品</th>
              <th class="right">数量</th>
              <th class="right">単価</th>
              <th class="right">小計</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(it=>`
              <tr>
                <td>${escapeHtml(it.name || it.id || "")}</td>
                <td class="right">${escapeHtml(String(it.qty ?? ""))}</td>
                <td class="right">${escapeHtml(fmtMoney((it.unitPrice ?? it.price ?? 0)))}</td>
                <td class="right">${escapeHtml(fmtMoney(it.subtotal ?? 0))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }

    // system fields (折りたたみ気味)
    const createdAt = sale.createdAtText || "";

    if(createdAt){
      html += `<div class="sectionTitle">システム</div>
        <div class="kv">
          ${createdAt ? kv("createdAt", createdAt) : ""}
        </div>
      `;
    }

    body.innerHTML = html;

    // 修正履歴件数
    if(sale.id){
      {
      const cnt = getFixCountsCached(sale.id);
      const pEl = drawerEl.querySelector("#fixPending");
      const dEl = drawerEl.querySelector("#fixDone");
      if(pEl) pEl.textContent = String(cnt?.pending ?? 0);
      if(dEl) dEl.textContent = String(cnt?.done ?? 0);
    }

    drawerBackdropEl.classList.add("open");
    drawerEl.classList.add("open");
  }


  function openEditChoiceModal(sale){
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modalCard" role="dialog" aria-modal="true">
        <div class="modalTitle">編集内容を選択</div>
        <div class="modalSub">クレーム返金：マイナスの sales を新規作成 / 打ち間違い修正：管理者へ修正依頼を送信（salesは変更しません）</div>
        <div class="modalBtns">
          <button class="modalBtn danger" id="btnClaim">
            <span>クレーム返金処理</span><span class="hint">追記</span>
          </button>
          <button class="modalBtn primary" id="btnFix">
            <span>打ち間違い修正</span><span class="hint">依頼</span>
          </button>
          <button class="modalBtn" id="btnCancel">
            <span>キャンセル</span><span class="hint">閉じる</span>
          </button>
        </div>
      </div>
    `;
    modal.addEventListener("click", (e)=>{
      if(e.target === modal) closeModal(modal);
    });
    document.body.appendChild(modal);

    modal.querySelector("#btnCancel").onclick = ()=> closeModal(modal);

    // refund の sales には返金処理を重ねない（必要なら打ち間違い修正で編集）
    if(sale.isRefund){
      const bc = modal.querySelector("#btnClaim");
      bc.disabled = true;
      bc.style.opacity = "0.45";
      bc.style.pointerEvents = "none";
      bc.querySelector(".hint").textContent = "不可";
    }

    modal.querySelector("#btnClaim").onclick = ()=>{
      closeModal(modal);
      openClaimEditor(sale);
    };

    modal.querySelector("#btnFix").onclick = ()=>{
      closeModal(modal);
      openFixRequestDrawer(sale);
    };
  }

  // =========================
  // 打ち間違い修正：詳細と同じ構成でタップ編集 → 修正依頼作成 / 管理者は承認反映
  // =========================
  function openFixRequestDrawer(sale){
    ensureDrawer();
    const admin = isAdminUser();
    const pending = admin ? getLatestPending(sale.id) : null;

    // draft = 現在値コピー（staffがタップで変更）
    const draft = {
      buyerName: sale.buyerName ?? "",
      orderDate: sale.orderDate ?? "",
      paymentId: sale.paymentId ?? "",
      paymentLabel: sale.paymentLabel ?? "",
      paymentMethod: sale.paymentMethod ?? "",
      channel: sale.channel ?? "",
      channelLabel: sale.channelLabel ?? "",
      venue: sale.venue ?? "",
      venueLabel: sale.venueLabel ?? "",
      kindId: sale.kindId ?? "",
      kindLabel: sale.kindLabel ?? "",
      urgentOptionId: sale.urgentOptionId ?? "",
      urgentOptionLabel: sale.urgentOptionLabel ?? "",
      memo: sale.memo ?? "",
      items: (sale.items || []).map(it=>({
        id: it.id ?? "",
        name: it.name ?? "",
        qty: Number(it.qty ?? 0),
        unitPrice: Number(it.unitPrice ?? it.price ?? 0),
        subtotal: Number(it.subtotal ?? (Number(it.qty??0) * Number(it.unitPrice ?? it.price ?? 0)) ?? 0)
      }))
    };

    function recalc(){
      draft.items = (draft.items||[]).map(it=>{
        const qty = Number(it.qty||0);
        const unitPrice = Number(it.unitPrice||0);
        return { ...it, qty, unitPrice, subtotal: qty*unitPrice };
      });
      draft.total = draft.items.reduce((a,b)=> a + Number(b.subtotal||0), 0);
    }
    recalc();

    const counts = getFixCountsCached(sale.id);

    // drawer header
    drawerEl.querySelector("#drawerBig").textContent = admin ? "修正依頼の確認" : "打ち間違い修正（依頼）";
    drawerEl.querySelector("#drawerSub").textContent =
      `合計 ${fmtMoney(sale.total)} / ${sale.orderDate ? sale.orderDate : fmtYMD(sale.date)} ・ 修正履歴：依頼中 ${counts.pending} / 完了 ${counts.done}`;

    const body = drawerEl.querySelector("#drawerBody");

    const buildKVRow = (label, value, field, hint="タップで変更")=>{
      const v = (value ?? "");
      return `
        <div class="kvRow tappable" data-field="${escapeHtml(field)}" role="button" tabindex="0">
          <div class="k">${escapeHtml(label)}</div>
          <div class="v">
            <div class="vv">${escapeHtml(String(v))}</div>
            <div class="vh">${escapeHtml(hint)}</div>
          </div>
        </div>
      `;
    };

    const paymentShow = draft.paymentLabel || draft.paymentMethod || draft.paymentId;
    const channelShow = draft.channelLabel || draft.channel;
    const venueShow   = draft.venueLabel || draft.venue;
    const kindShow    = draft.kindLabel || draft.kindId || sale.kind || "";
    const urgentShow  = draft.urgentOptionLabel || draft.urgentOptionId;

    let html = `
      <div class="drawerPills">
        <div class="pill">依頼中 <span id="fixPending">${counts.pending}</span></div>
        <div class="pill">完了 <span id="fixDone">${counts.done}</span></div>
      </div>

      <div class="sectionTitle">基本（タップで変更）</div>
      <div class="kvGrid2">
        ${buildKVRow("購入者氏名", draft.buyerName, "buyerName")}
        ${buildKVRow("購入日付", draft.orderDate || (sale.orderDate || fmtYMD(sale.date)), "orderDate", "YYYY-MM-DD")}
        ${buildKVRow("販売方法", channelShow, "channel")}
        ${buildKVRow("決済方法", paymentShow, "payment")}
        ${buildKVRow("開催場所", venueShow, "venue")}
        ${buildKVRow("販売種別", kindShow, "kind")}
        ${urgentShow ? buildKVRow("緊急オプション", urgentShow, "urgent") : ""}
      </div>

      <div class="sectionTitle">メモ</div>
      <div class="kvRow tappable" data-field="memo" role="button" tabindex="0">
        <div class="k">メモ</div>
        <div class="v">
          <div class="vv">${escapeHtml(draft.memo || "")}</div>
          <div class="vh">タップで変更</div>
        </div>
      </div>

      <div class="sectionTitle">商品明細（タップで編集）</div>
      <div class="muted" style="margin:-6px 0 10px;">行をタップで編集／下の「＋追加」で増やせます。</div>
      <div id="itemsBox"></div>
      <div class="miniActions">
        <button class="sbtn" id="addItemBtn" type="button">＋追加</button>
        <div style="flex:1"></div>
        <div class="pill">合計（仮）: <b id="draftTotal">${fmtMoney(draft.total||0)}</b></div>
      </div>

      ${admin && pending ? `
        <div class="approveBox">
          <div class="approveHead">管理者：依頼内容の確認</div>
          <div class="approveNote">依頼コメント：${escapeHtml(pending.requestText || "-")}</div>
          <div class="approveList" id="approveList"></div>
          <div class="muted" style="margin-top:8px;">※ チェックした変更だけ sales に反映します。</div>
        </div>
      ` : `
        <div class="sectionTitle">依頼コメント（必須）</div>
        <textarea id="reqText" placeholder="管理者に伝える内容（例：購入者名をtest1→test2に修正、単価を修正 など）" style="width:100%;min-height:92px;border-radius:14px;border:1px solid var(--glass-border);padding:12px;background:rgba(255,255,255,.82);font-weight:700;"></textarea>
        <div class="miniActions" style="margin-top:10px;">
          <button class="sbtn primary" id="sendReqBtn" type="button">保存（修正依頼）</button>
          <button class="sbtn" id="closeBtn2" type="button">閉じる</button>
        </div>
      `}
    `;

    body.innerHTML = html;

    // items render
    const itemsBox = body.querySelector("#itemsBox");
    function renderItems(){
      const rows = draft.items || [];
      if(!rows.length){
        itemsBox.innerHTML = `<div class="empty">商品がありません。</div>`;
        return;
      }
      itemsBox.innerHTML = `
        <table class="drawerTable">
          <thead><tr><th>商品</th><th class="right">数量</th><th class="right">単価</th><th class="right">小計</th></tr></thead>
          <tbody>
            ${rows.map((it,idx)=>`
              <tr class="trow tappable" data-item="${idx}">
                <td>${escapeHtml(it.name || it.id || "")}</td>
                <td class="right">${escapeHtml(String(it.qty ?? ""))}</td>
                <td class="right">${escapeHtml(fmtMoney(it.unitPrice ?? 0))}</td>
                <td class="right">${escapeHtml(fmtMoney(it.subtotal ?? 0))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
      const dt = body.querySelector("#draftTotal");
      if(dt) dt.textContent = fmtMoney(draft.total||0);
    }
    renderItems();

    // tap edit handlers (kv + item row)
    body.addEventListener("click", async (e)=>{
      const kv = e.target.closest?.(".kvRow.tappable");
      if(kv){
        const f = kv.getAttribute("data-field");
        if(!f) return;
        if(admin && pending){
          // admin mode: editing draft not needed here
          return;
        }
        if(f==="buyerName"){
          const nv = prompt("購入者氏名", draft.buyerName ?? "");
          if(nv===null) return;
          draft.buyerName = nv;
        }else if(f==="orderDate"){
          const nv = prompt("購入日付（YYYY-MM-DD）", draft.orderDate || sale.orderDate || fmtYMD(sale.date));
          if(nv===null) return;
          draft.orderDate = nv.trim();
        }else if(f==="channel"){
          const nv = prompt("販売方法（ID または 表示名）", (draft.channelLabel || draft.channel || ""));
          if(nv===null) return;
          draft.channelLabel = nv; // 過渡期：labelとして保持
          draft.channel = nv;
        }else if(f==="payment"){
          const nv = prompt("決済方法（ID または 表示名）", (draft.paymentLabel || draft.paymentMethod || draft.paymentId || ""));
          if(nv===null) return;
          draft.paymentLabel = nv;
          draft.paymentMethod = nv;
          draft.paymentId = nv;
        }else if(f==="venue"){
          const nv = prompt("開催場所（ID または 表示名）", (draft.venueLabel || draft.venue || ""));
          if(nv===null) return;
          draft.venueLabel = nv;
          draft.venue = nv;
        }else if(f==="kind"){
          const nv = prompt("販売種別（例：stock / order / -）", (draft.kindId || sale.kind || ""));
          if(nv===null) return;
          draft.kindId = nv;
          draft.kindLabel = nv;
        }else if(f==="urgent"){
          const nv = prompt("緊急オプション（空で解除）", (draft.urgentOptionLabel || draft.urgentOptionId || ""));
          if(nv===null) return;
          draft.urgentOptionLabel = nv;
          draft.urgentOptionId = nv;
        }else if(f==="memo"){
          const nv = prompt("メモ", draft.memo ?? "");
          if(nv===null) return;
          draft.memo = nv;
        }
        // refresh kv values by reopening drawer quickly
        openFixRequestDrawer({ ...sale, ...draft, items: draft.items, total: sale.total });
        return;
      }

      const row = e.target.closest?.("tr.trow.tappable");
      if(row){
        if(admin && pending) return;
        const idx = Number(row.getAttribute("data-item"));
        const it = draft.items[idx];
        if(!it) return;
        const name = prompt("商品名", it.name || "");
        if(name===null) return;
        const qty = prompt("数量", String(it.qty ?? 0));
        if(qty===null) return;
        const up = prompt("単価（円）", String(it.unitPrice ?? 0));
        if(up===null) return;
        it.name = name;
        it.qty = Number(qty||0);
        it.unitPrice = Number(up||0);
        recalc();
        renderItems();
        return;
      }
    });

    // add item
    const addBtn = body.querySelector("#addItemBtn");
    if(addBtn){
      addBtn.addEventListener("click", ()=>{
        if(admin && pending) return;
        draft.items.push({ id:"", name:"", qty:1, unitPrice:0, subtotal:0 });
        recalc();
        renderItems();
      });
    }

    // staff: send request
    const sendBtn = body.querySelector("#sendReqBtn");
    if(sendBtn){
      sendBtn.addEventListener("click", async ()=>{
        try{
          const reqText = safeStr(body.querySelector("#reqText")?.value || "").trim();
          if(!reqText){
            toast("依頼コメントを入れてね");
            return;
          }
          // proposed: keep minimal but include items and key fields
          const proposed = {
            buyerName: draft.buyerName ?? "",
            orderDate: draft.orderDate || sale.orderDate || fmtYMD(sale.date),
            channel: draft.channel ?? "",
            channelLabel: draft.channelLabel ?? "",
            paymentId: draft.paymentId ?? "",
            paymentLabel: draft.paymentLabel ?? "",
            paymentMethod: draft.paymentMethod ?? "",
            venue: draft.venue ?? "",
            venueLabel: draft.venueLabel ?? "",
            kindId: draft.kindId ?? "",
            kindLabel: draft.kindLabel ?? "",
            urgentOptionId: draft.urgentOptionId ?? "",
            urgentOptionLabel: draft.urgentOptionLabel ?? "",
            memo: draft.memo ?? "",
            items: (draft.items||[]).map(it=>({
              id: it.id ?? "",
              name: it.name ?? "",
              qty: Number(it.qty||0),
              unitPrice: Number(it.unitPrice||0),
              price: Number(it.unitPrice||0), // 互換
              subtotal: Number(it.subtotal||0)
            }))
          };
          const snapshot = {
            buyerName: sale.buyerName ?? "",
            orderDate: sale.orderDate ?? "",
            channel: sale.channel ?? "",
            channelLabel: sale.channelLabel ?? "",
            paymentId: sale.paymentId ?? "",
            paymentLabel: sale.paymentLabel ?? "",
            paymentMethod: sale.paymentMethod ?? "",
            venue: sale.venue ?? "",
            venueLabel: sale.venueLabel ?? "",
            kindId: sale.kindId ?? "",
            kindLabel: sale.kindLabel ?? "",
            urgentOptionId: sale.urgentOptionId ?? "",
            urgentOptionLabel: sale.urgentOptionLabel ?? "",
            memo: sale.memo ?? "",
            items: (sale.items||[]).map(it=>({
              id: it.id ?? "",
              name: it.name ?? "",
              qty: Number(it.qty ?? 0),
              unitPrice: Number(it.unitPrice ?? it.price ?? 0),
              price: Number(it.unitPrice ?? it.price ?? 0),
              subtotal: Number(it.subtotal ?? 0)
            }))
          };

          await addDoc(collection(db,"sales_fix_requests"),{
            saleId: sale.id,
            status: "依頼中",
            requestText: reqText,
            createdAt: serverTimestamp(),
            createdBy: (currentUser?.email || currentUser?.uid || ""),
            snapshot,
            proposed
          });

          toast("保存しました。管理者へ確認依頼の連絡をお願いします");

          await loadFixRequests();
          render(); // list badges update
          openSaleDrawer(sale); // back to detail
        }catch(err){
          console.error(err);
          toast("保存失敗");
        }
      });
    }
    const closeBtn2 = body.querySelector("#closeBtn2");
    if(closeBtn2) closeBtn2.addEventListener("click", ()=> closeSaleDrawer());

    // admin approve list (latest pending only)
    if(admin && pending){
      const listEl = body.querySelector("#approveList");
      if(listEl){
        const snap = pending.snapshot || {};
        const prop = pending.proposed || {};
        const fields = [
          ["buyerName","購入者氏名"],
          ["orderDate","購入日付"],
          ["channelLabel","販売方法"],
          ["paymentLabel","決済方法"],
          ["venueLabel","開催場所"],
          ["kindLabel","販売種別"],
          ["urgentOptionLabel","緊急オプション"],
          ["memo","メモ"],
          ["items","商品明細"]
        ];

        function fmtVal(v){
          if(v==null) return "";
          if(Array.isArray(v)) return `${v.length}件`;
          return String(v);
        }

        listEl.innerHTML = fields.map(([k,lab])=>{
          const before = fmtVal((k in snap)? snap[k] : "");
          const after  = fmtVal((k in prop)? prop[k] : "");
          if(before === after) return "";
          return `
            <label class="approveItem">
              <span class="approveMain">${escapeHtml(lab)}：${escapeHtml(before || "（空）")} → ${escapeHtml(after || "（空）")}</span>
              <span class="approveChk"><input type="checkbox" data-appr="${escapeHtml(k)}" checked> 許可</span>
            </label>
          `;
        }).filter(Boolean).join("");

        // add action buttons
        const actions = document.createElement("div");
        actions.className = "miniActions";
        actions.innerHTML = `
          <button class="sbtn primary" id="applyBtn" type="button">保存して閉じる（反映）</button>
          <button class="sbtn" id="closeBtnA" type="button">閉じる</button>
        `;
        body.appendChild(actions);

        body.querySelector("#closeBtnA").addEventListener("click", ()=> closeSaleDrawer());

        body.querySelector("#applyBtn").addEventListener("click", async ()=>{
          try{
            // build update payload based on approved checks
            const approved = new Set([...body.querySelectorAll("input[type=checkbox][data-appr]")].filter(x=>x.checked).map(x=>x.getAttribute("data-appr")));
            const updateData = {};

            // apply approved fields
            if(approved.has("buyerName")) updateData.buyerName = prop.buyerName ?? snap.buyerName ?? "";
            if(approved.has("orderDate")) updateData.orderDate = prop.orderDate ?? snap.orderDate ?? "";
            if(approved.has("channelLabel")){
              if("channel" in prop) updateData.channel = prop.channel;
              if("channelLabel" in prop) updateData.channelLabel = prop.channelLabel;
            }
            if(approved.has("paymentLabel")){
              if("paymentId" in prop) updateData.paymentId = prop.paymentId;
              if("paymentLabel" in prop) updateData.paymentLabel = prop.paymentLabel;
              if("paymentMethod" in prop) updateData.paymentMethod = prop.paymentMethod;
            }
            if(approved.has("venueLabel")){
              if("venue" in prop) updateData.venue = prop.venue;
              if("venueLabel" in prop) updateData.venueLabel = prop.venueLabel;
            }
            if(approved.has("kindLabel")){
              if("kindId" in prop) updateData.kindId = prop.kindId;
              if("kindLabel" in prop) updateData.kindLabel = prop.kindLabel;
            }
            if(approved.has("urgentOptionLabel")){
              if("urgentOptionId" in prop) updateData.urgentOptionId = prop.urgentOptionId;
              if("urgentOptionLabel" in prop) updateData.urgentOptionLabel = prop.urgentOptionLabel;
            }
            if(approved.has("memo")) updateData.memo = prop.memo ?? "";
            if(approved.has("items")){
              const items = (prop.items || []).map(it=>({
                id: it.id ?? "",
                name: it.name ?? "",
                qty: Number(it.qty||0),
                unitPrice: Number(it.unitPrice ?? it.price ?? 0),
                price: Number(it.unitPrice ?? it.price ?? 0),
                subtotal: Number(it.subtotal ?? (Number(it.qty||0)*Number(it.unitPrice ?? it.price ?? 0)) ?? 0)
              }));
              updateData.items = items;
              updateData.total = items.reduce((a,b)=> a + Number(b.subtotal||0), 0);
            }

            const isBundled = sale.isBundled === true;

            if(!isBundled && Object.keys(updateData).length){
              await updateDoc(doc(db,"sales", sale.id), updateData);
            }

            // mark request done
            const reqUpdate = {
              status: "完了",
              resolvedAt: serverTimestamp(),
              resolvedBy: (currentUser?.email || currentUser?.uid || "")
            };
            if(isBundled){
              reqUpdate.adminMemo = "バンドルを修正します";
            }
            await updateDoc(doc(db,"sales_fix_requests", pending.id), reqUpdate);

            toast("完了にしました");
            await loadAll(true); // refresh sales + requests
            closeSaleDrawer();
          }catch(err){
            console.error(err);
            toast("保存失敗（管理者）");
          }
        });
      }
    }

    drawerBackdropEl.classList.add("open");
    drawerEl.classList.add("open");
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }


function openClaimEditor(sale){
  const modal = document.createElement("div");
  modal.className = "modal";

  modal.innerHTML = `
    <div class="modalCard" role="dialog" aria-modal="true">
      <div class="modalTitle">クレーム返金処理（マイナス sales 作成）</div>
      <div class="modalSub">元の sales は変更しません。紐づく「返金用の sales（マイナス）」を新規作成します。</div>

      <div class="form">
        <div class="row">
          <div class="input">
            <div class="lab">返金額（円）</div>
            <input id="refundAmt" inputmode="numeric" type="number" min="1" step="1" placeholder="例：2000" />
          </div>
          <div class="input">
            <div class="lab">対象 sale</div>
            <input value="${escapeHtml(sale.id)}" disabled />
          </div>
        </div>

        <div class="input">
          <div class="lab">事由</div>
          <textarea id="reason" placeholder="例：商品不良 / 破損 / 誤配送 など"></textarea>
        </div>

        <div class="miniActions">
          <button class="sbtn primary" id="save">保存（返金 sales 作成）</button>
          <button class="sbtn" id="cancel">キャンセル</button>
        </div>
      </div>
    </div>
  `;

  modal.addEventListener("click", (e)=>{
    if(e.target === modal) closeModal(modal);
  });
  document.body.appendChild(modal);

  modal.querySelector("#cancel").onclick = ()=> closeModal(modal);

  modal.querySelector("#save").onclick = async ()=>{
    try{
      const amt = Number(modal.querySelector("#refundAmt").value || 0);
      const reason = safeStr(modal.querySelector("#reason").value || "").trim();
      if(!(amt>0)){
        toast("返金額を入れてね");
        return;
      }
      if(!reason){
        toast("事由を入れてね");
        return;
      }

      // 返金は「紐づくマイナス sales」を新規作成
      await addDoc(collection(db,"sales"),{
        parentSaleId: sale.id,
        isRefund: true,

        createdAt: serverTimestamp(),

        buyerName: sale.buyerName || "",
        channel: sale.channel || "refund",
        paymentMethod: sale.paymentMethod || "",
        shippingOption: sale.shippingOption || "",
        kind: "-",

        memo: `返金：${reason}`,

        items: [{
          name: "クレーム返金",
          qty: 1,
          price: -Math.abs(amt),
          subtotal: -Math.abs(amt)
        }],
        total: -Math.abs(amt),

        createdBy: (currentUser?.email || currentUser?.uid || "")
      });

      toast("返金 sales を作成しました");
      closeModal(modal);

      await loadAll(true);

    }catch(err){
      console.error(err);
      toast("保存失敗");
    }
  };
}


  function toLocalInputValue(date){
    // datetime-local は「YYYY-MM-DDTHH:mm」
    const d = date instanceof Date ? date : new Date(date);
    if(isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = pad2(d.getMonth()+1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    return `${y}-${m}-${dd}T${hh}:${mm}`;
  }

  function parseLocalInputValue(v){
    // ブラウザによってはローカルタイム扱いで Date 化される
    const d = new Date(v);
    return d;
  }

  function recalcItems(items){
    return items.map(it=>{
      const qty = Number(it.qty||0);
      const price = Number(it.price||0);
      return { ...it, qty, price, subtotal: qty*price };
    });
  }

  
  async function fetchPendingFixRequest(saleId){
    try{
      const q = query(
        collection(db, "sales_fix_requests"),
        where("saleId","==", saleId),
        where("status","==", "依頼中"),
        orderBy("createdAt","desc"),
        limit(1)
      );
      const snap = await getDocs(q);
      if(snap.empty) return null;
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }catch(err){
      console.warn("fetchPendingFixRequest failed", err);
      return null;
    }
  }
  async function fetchFixRequestCounts(saleId){
    // returns { pending: number, done: number }
    try{
      const qPending = query(
        collection(db, "sales_fix_requests"),
        where("saleId","==", saleId),
        where("status","==","依頼中")
      );
      const qDone = query(
        collection(db, "sales_fix_requests"),
        where("saleId","==", saleId),
        where("status","==","完了")
      );
      const [sPending, sDone] = await Promise.all([getDocs(qPending), getDocs(qDone)]);
      return { pending: (sPending.size||0), done: (sDone.size||0) };
    }catch(err){
      console.warn("fetchFixRequestCounts failed", err);
      return { pending: 0, done: 0 };
    }
  }



  function isAdminUser(){
    return (currentUser?.email || "") === "enue_staff03@management.com";
  }

  function fmtYMD(d){
    const y = d.getFullYear();
    const m = pad2(d.getMonth()+1);
    const dd = pad2(d.getDate());
    return `${y}-${m}-${dd}`;
  }
  function msAtLocalMidnight(d){
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
    return x.getTime();
  }

  async function openFullEditEditor(sale){
    const modal = document.createElement("div");
    modal.className = "modal";

    const admin = isAdminUser();
    const pending = admin ? await fetchPendingFixRequest(sale.id) : null;

    // 基準（現在の sales）
    const baseItems = recalcItems((sale.items || []).map(it=>({
      name: safeStr(it.name||""),
      qty: Number(it.qty||0),
      price: Number(it.price||0)
    })));
    const baseTotal = baseItems.reduce((a,b)=>a+Number(b.subtotal||0),0);

    // proposed（依頼があればそれを優先表示）
    let p = null;
    if(pending?.proposed && typeof pending.proposed === "object"){
      p = pending.proposed;
    }

    let items = p?.items
      ? recalcItems((p.items||[]).map(it=>({ name: safeStr(it.name||""), qty: Number(it.qty||0), price: Number(it.price||0) })))
      : baseItems.map(it=>({ ...it }));

    if(items.length===0) items = [{name:"", qty:1, price:0, subtotal:0}];

    const initBuyer = safeStr(p?.buyerName ?? sale.buyerName ?? "");
    const initPayment = safeStr(p?.paymentMethod ?? sale.paymentMethod ?? "");
    const initChannel = safeStr(p?.channel ?? sale.channel ?? "");
    const initMemo = safeStr(p?.memo ?? sale.memo ?? "");
    const initShip = safeStr(p?.shippingOption ?? sale.shippingOption ?? "");
    const initKind = safeStr(p?.kind ?? sale.kind ?? "");
    const initTotal = (p?.total!=null ? Number(p.total||0) : baseTotal);

    // 変更内容（何→何）表示用：pendingがある時は snapshot→proposed を表示
    const snap = pending?.snapshot || null;
    const prop = pending?.proposed || null;
    const fromTo = (key, fallbackBefore, fallbackAfter)=>{
      if(!admin || !pending) return "";
      const before = String((snap && (key in snap)) ? (snap[key] ?? "") : (fallbackBefore ?? ""));
      const after  = String((prop && (key in prop)) ? (prop[key] ?? "") : (fallbackAfter ?? ""));
      if(before === after) return "";
      const b = before === "" ? "（空）" : before;
      const a = after === "" ? "（空）" : after;
      return `${b}→${a}`;
    };

    const ftBuyer  = fromTo("buyerName", sale.buyerName, initBuyer);
    const ftPay    = fromTo("paymentMethod", sale.paymentMethod, initPayment);
    const ftChan   = fromTo("channel", sale.channel, initChannel);
    const ftMemo   = fromTo("memo", sale.memo, initMemo);
    const ftShip   = fromTo("shippingOption", sale.shippingOption, initShip);
    const ftKind   = fromTo("kind", sale.kind, initKind);
    const ftTotal  = fromTo("total", baseTotal, initTotal);



    const initDate = (p?.createdAtLocal ? new Date(p.createdAtLocal) : sale.date);
    const initDateVal = toLocalInputValue(initDate);

    const requestTextValue = safeStr(pending?.requestText ?? "");

    modal.innerHTML = `
      <div class="modalCard" role="dialog" aria-modal="true">
        <div class="modalTitle">${admin && pending ? "修正依頼の反映（管理者）" : "打ち間違い修正（管理者へ依頼）"}</div>
        <div class="modalSub">
          ${admin && pending
            ? "各変更の「許可」にチェック → 保存で sales に反映し、依頼を「完了」にします。"
            : "カード内の情報をすべて編集できます。保存すると「修正依頼」を送信します（salesは変更しません）。"}
        </div>

        ${admin && pending ? `
          <div class="approveBox" id="approveBox">
            <div class="approveHead">反映する変更にチェック</div>
            <div class="approveNote">依頼コメント：${escapeHtml(requestTextValue || "-")}</div>
            <div class="approveList" id="approveList"></div>
          </div>
        ` : ""}

        <div class="form">
          <div class="row">
            <div class="input">
              <div class="lab">
                購入者氏名
                ${admin && pending && ftBuyer ? `<span class="fromTo">${escapeHtml(ftBuyer)}</span>` : ``}
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="buyerName" checked>許可</label>` : ``}
              </div>
              <input id="buyerName" value="${escapeHtml(initBuyer)}" placeholder="例：山田 太郎" />
            </div>
            <div class="input">
              <div class="lab">
                日付
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="date" checked>許可</label>` : ``}
              </div>
              <input id="createdAt" type="datetime-local" value="${escapeHtml(initDateVal)}" />
            </div>
          </div>

          <div class="row">
            <div class="input">
              <div class="lab">
                決済方法
                ${admin && pending && ftPay ? `<span class="fromTo">${escapeHtml(ftPay)}</span>` : ``}
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="paymentMethod" checked>許可</label>` : ``}
              </div>
              <select id="paymentMethodSel">
                ${buildOptionsHTML(optPaymentMethods, initPayment)}
              </select>
              <input id="paymentMethodCustom" style="display:none;margin-top:6px;" value="" placeholder="自由入力（例：現金 / PayPay）" />
            </div>
            <div class="input">
              <div class="lab">
                チャンネル
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="channel" checked>許可</label>` : ``}
              </div>
              <select id="channelSel">
                ${buildOptionsHTML(optChannels, initChannel)}
              </select>
              <input id="channelCustom" style="display:none;margin-top:6px;" value="" placeholder="自由入力（例：マルシェ / インスタ）" />
            </div>
          </div>

          <div class="row">
            <div class="input">
              <div class="lab">
                種別 kind
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="kind" checked>許可</label>` : ``}
              </div>
              <select id="kindSel">
                <option value="">-</option>
                <option value="stock">stock</option>
                <option value="order">order</option>
              </select>
            </div>
            <div class="input">
              <div class="lab">
                配送 shippingOption
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="shippingOption" checked>許可</label>` : ``}
              </div>
              <input id="shippingOption" value="${escapeHtml(initShip)}" placeholder="例：持ち帰り" />
            </div>
          </div>

          <div class="input">
            <div class="lab">
              メモ
              ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="memo" checked>許可</label>` : ``}
            </div>
            <textarea id="memo" placeholder="メモ（任意）">${escapeHtml(initMemo)}</textarea>
          </div>

          ${admin && pending ? "" : `
          <div class="input">
            <div class="lab">管理者への依頼コメント（必須）</div>
            <textarea id="requestText" placeholder="例：決済方法を現金→PayPayに、日付を12/28→12/27に修正してください"></textarea>
          </div>
          `}

          <div class="input">
            <div class="lab">
              明細（items）
              ${admin && pending ? `<label class="okChk" style="margin-left:10px;"><input type="checkbox" data-appr="items" checked>許可</label>` : ``}
            </div>
            <table class="miniTable" id="itemsTbl">
              <thead>
                <tr>
                  <th style="width:42%;">商品</th>
                  <th style="width:18%;">数量</th>
                  <th style="width:20%;">単価</th>
                  <th style="width:20%;">小計</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>

            <div class="miniActions">
              <button class="sbtn" id="addItem">＋ 行追加</button>
              <button class="sbtn danger" id="delItem">－ 最終行削除</button>
            </div>
          </div>

          <div class="row">
            <div class="input">
              <div class="lab">
                合計（円）
                ${admin && pending ? `<label class="okChk"><input type="checkbox" data-appr="total" checked>許可</label>` : ``}
              </div>
              <input id="total" type="number" step="1" value="${escapeHtml(String(initTotal))}" />
            </div>
            <div class="input">
              <div class="lab">ID（編集不可）</div>
              <input value="${escapeHtml(safeStr(sale.id))}" disabled />
            </div>
          </div>

          <div class="miniActions">
            <button class="sbtn primary" id="save">${admin && pending ? "保存して反映（完了）" : "保存（依頼送信）"}</button>
            <button class="sbtn" id="cancel">キャンセル</button>
          </div>
        </div>
      </div>
    `;

    modal.addEventListener("click", (e)=>{
      if(e.target === modal) closeModal(modal);
    });
    document.body.appendChild(modal);

    // kind 初期値
    const kindSel = modal.querySelector("#kindSel");
    kindSel.value = initKind || "";

    const tbody = modal.querySelector("#itemsTbl tbody");

    const paySel = modal.querySelector("#paymentMethodSel");
    const payCus = modal.querySelector("#paymentMethodCustom");
    const chSel = modal.querySelector("#channelSel");
    const chCus = modal.querySelector("#channelCustom");

    const syncCustomVisibility = ()=>{
      payCus.style.display = (paySel.value==="__custom__") ? "block" : "none";
      chCus.style.display = (chSel.value==="__custom__") ? "block" : "none";
    };
    syncCustomVisibility();
    paySel.onchange = syncCustomVisibility;
    chSel.onchange = syncCustomVisibility;

    function renderItems(){
      items = recalcItems(items);
      tbody.innerHTML = items.map((it, idx)=>`
        <tr>
          <td><input data-i="${idx}" data-k="name" value="${escapeHtml(it.name||"")}" placeholder="商品名" /></td>
          <td><input data-i="${idx}" data-k="qty" type="number" inputmode="numeric" min="0" step="1" value="${escapeHtml(String(it.qty||0))}" /></td>
          <td><input data-i="${idx}" data-k="price" type="number" inputmode="numeric" step="1" value="${escapeHtml(String(it.price||0))}" /></td>
          <td class="right">${yen(it.subtotal||0)}</td>
        </tr>
      `).join("");

      // total は items から再計算して自動で入れる（手入力したいなら後でスイッチ足す）
      const t = items.reduce((a,b)=>a+Number(b.subtotal||0),0);
      modal.querySelector("#total").value = String(Math.round(t));
    }

    tbody.addEventListener("input", (e)=>{
      const inp = e.target;
      if(!(inp instanceof HTMLInputElement)) return;
      const i = Number(inp.dataset.i);
      const k = inp.dataset.k;
      if(!Number.isFinite(i) || !k) return;

      if(k==="name"){
        items[i].name = inp.value;
      }else if(k==="qty"){
        items[i].qty = Number(inp.value||0);
      }else if(k==="price"){
        items[i].price = Number(inp.value||0);
      }
      renderItems();
    });

    modal.querySelector("#addItem").onclick = ()=>{
      items.push({ name:"", qty:1, price:0, subtotal:0 });
      renderItems();
    };
    modal.querySelector("#delItem").onclick = ()=>{
      if(items.length<=1){
        toast("これ以上減らせない");
        return;
      }
      items.pop();
      renderItems();
    };

    modal.querySelector("#cancel").onclick = ()=> closeModal(modal);

    // 管理者：差分表示
    if(admin && pending){
      const list = modal.querySelector("#approveList");
      const base = {
        buyerName: safeStr(sale.buyerName||""),
        date: toLocalInputValue(sale.date),
        paymentMethod: safeStr(sale.paymentMethod||""),
        channel: safeStr(sale.channel||""),
        kind: safeStr(sale.kind||""),
        shippingOption: safeStr(sale.shippingOption||""),
        memo: safeStr(sale.memo||""),
        items: JSON.stringify(baseItems),
        total: String(Math.round(baseTotal))
      };
      const now = {
        buyerName: safeStr(modal.querySelector("#buyerName").value||""),
        date: safeStr(modal.querySelector("#createdAt").value||""),
        paymentMethod: (paySel.value==="__custom__"? safeStr(payCus.value||"") : safeStr(paySel.value||"")),
        channel: (chSel.value==="__custom__"? safeStr(chCus.value||"") : safeStr(chSel.value||"")),
        kind: safeStr(kindSel.value||""),
        shippingOption: safeStr(modal.querySelector("#shippingOption").value||""),
        memo: safeStr(modal.querySelector("#memo").value||""),
        items: JSON.stringify(items),
        total: safeStr(modal.querySelector("#total").value||"")
      };
      const rows = [
        ["buyerName","購入者氏名"],
        ["date","日付"],
        ["paymentMethod","決済方法"],
        ["channel","チャンネル"],
        ["kind","種別 kind"],
        ["shippingOption","配送"],
        ["memo","メモ"],
        ["items","明細 items"],
        ["total","合計"]
      ].filter(([k])=> base[k]!==now[k]);

      if(rows.length===0){
        list.innerHTML = `<div class="approveEmpty">差分が見つかりません（そのまま保存で完了にできます）</div>`;
      }else{
        list.innerHTML = rows.map(([k,label])=>`
          <div class="approveRow">
            <div class="approveL">${escapeHtml(label)}</div>
            <div class="approveR">${escapeHtml(String(base[k]))} → <b>${escapeHtml(String(now[k]))}</b></div>
            <label class="approveC"><input type="checkbox" data-appr="${k}" checked>許可</label>
          </div>
        `).join("");
      }
    }

    modal.querySelector("#save").onclick = async ()=>{
      try{
        const buyerName = safeStr(modal.querySelector("#buyerName").value || "").trim();
        const createdAtStr = safeStr(modal.querySelector("#createdAt").value || "");
        const paymentMethod = (paySel.value === "__custom__"
          ? safeStr(payCus.value || "").trim()
          : safeStr(paySel.value || "").trim());
        const channel = (chSel.value === "__custom__"
          ? safeStr(chCus.value || "").trim()
          : safeStr(chSel.value || "").trim());
        const memo = safeStr(modal.querySelector("#memo").value || "").trim();
        const shippingOption = safeStr(modal.querySelector("#shippingOption").value || "").trim();
        const kind = safeStr(kindSel.value || "").trim();

        const createdAtDate = parseLocalInputValue(createdAtStr);
        if(!createdAtStr || isNaN(createdAtDate.getTime())){
          toast("日付が不正");
          return;
        }

        // items 正規化
        items = recalcItems(items).map(it=>({
          name: safeStr(it.name||"").trim(),
          qty: Number(it.qty||0),
          price: Number(it.price||0),
          subtotal: Number(it.subtotal||0)
        })).filter(it=> it.name || it.qty || it.price);

        const total = Number(modal.querySelector("#total").value || 0);

        if(!items.length){
          toast("明細が空です");
          return;
        }
        if(!(total>=0)){
          toast("合計が不正");
          return;
        }

        if(admin && pending){
          // ✅ バンドル由来は sales を触らず、依頼を完了にして「バンドル修正します」を付ける
          if(sale.isBundled === true){
            await updateDoc(doc(db, "sales_fix_requests", pending.id), {
              status: "完了",
              adminMemo: "バンドルを修正します",
              resolvedAt: serverTimestamp(),
              resolvedBy: (currentUser?.email || currentUser?.uid || "")
            });
            toast("完了にしました（バンドルを修正します）");
            closeModal(modal);
            await loadAll(true);
            return;
          }

          // ---- 管理者：許可チェックされたものだけ sales に反映
          const allowed = new Set(
            Array.from(modal.querySelectorAll('input[type="checkbox"][data-appr]'))
              .filter(ch=>ch.checked)
              .map(ch=>ch.getAttribute("data-appr"))
          );

          const updateData = {};
          if(allowed.has("buyerName")) updateData.buyerName = buyerName;
          if(allowed.has("paymentMethod")) updateData.paymentMethod = paymentMethod;
          if(allowed.has("channel")) updateData.channel = channel;
          if(allowed.has("memo")) updateData.memo = memo;
          if(allowed.has("shippingOption")) updateData.shippingOption = shippingOption;
          if(allowed.has("kind")) updateData.kind = kind;

          if(allowed.has("date")){
            updateData.orderDate = fmtYMD(createdAtDate);
            updateData.orderDateMs = msAtLocalMidnight(createdAtDate);
            updateData.clientCreatedAt = createdAtDate.getTime();
          }

          if(allowed.has("items")){
            updateData.items = items;
          }
          if(allowed.has("total")){
            updateData.total = Math.round(total);
          }else{
            // total の許可が外れてるのに items だけ反映、みたいな時にズレが出るのを避ける
            if(allowed.has("items")){
              updateData.total = Math.round(items.reduce((a,b)=>a+Number(b.subtotal||0),0));
            }
          }

          // 何も許可しない場合は sales を触らず「完了」にできる（運用次第）
          if(Object.keys(updateData).length > 0){
            await updateDoc(doc(db, "sales", sale.id), updateData);
          }

          await updateDoc(doc(db, "sales_fix_requests", pending.id), {
            status: "完了",
            resolvedAt: serverTimestamp(),
            resolvedBy: (currentUser?.email || currentUser?.uid || "")
          });

          toast("反映して完了にしました");
          closeModal(modal);
          await loadAll(true);
          return;
        }

        // ---- スタッフ：修正依頼を送る（salesは触らない）
        const requestText = safeStr(modal.querySelector("#requestText").value || "").trim();
        if(!requestText){
          toast("依頼コメントを入れてね");
          return;
        }

        await addDoc(collection(db, "sales_fix_requests"), {
          saleId: sale.id,
          status: "依頼中",
          requestText,
          createdAt: serverTimestamp(),
          createdBy: (currentUser?.email || currentUser?.uid || ""),

          snapshot: {
            buyerName: sale.buyerName || "",
            orderDate: sale.orderDate || "",
            channel: sale.channel || "",
            paymentMethod: sale.paymentMethod || "",
            memo: sale.memo || "",
            shippingOption: sale.shippingOption || "",
            kind: sale.kind || "",
            total: Number(sale.total || 0),
            items: (sale.items || []).map(it=>({
              name: it.name || "",
              qty: Number(it.qty||0),
              price: Number(it.price||0),
              subtotal: Number(it.subtotal||0)
            }))
          },

          proposed: {
            buyerName,
            createdAtLocal: createdAtDate.toISOString(),
            paymentMethod,
            channel,
            memo,
            shippingOption,
            kind,
            items,
            total
          }
        });

        toast("保存しました。管理者へ確認依頼の連絡をお願いします");
        closeModal(modal);
        await loadAll(true);

      }catch(err){
        console.error(err);
        toast("保存失敗（ルール確認）");
      }
    };

    // 初期レンダ
    renderItems();
  }


  // ---- auth gate (ログインしてなければ login.html へ)
  onAuthStateChanged(auth, (user)=>{
    if(!user){
      authStateEl.textContent = "未ログイン → login.html へ";
      setTimeout(()=> location.href = "login.html", 250);
      return;
    }
    currentUser = user;
    authStateEl.textContent = `ログイン中：${user.email || "user"}`;
    loadAll();
  });
