
/**
 * Firebase optional wiring.
 * If you want to enable patch reads, fill in firebaseConfig and uncomment init.
 * This file is separated so the dashboard can still work on GitHub Pages as static.
 */

// eslint-disable-next-line no-unused-vars
const firebaseConfig = {
  apiKey: "AIzaSyAhPCgPoJK6S6BWVcBZOruYqMPXVQXQFRk",
  authDomain: "handmade-pos.firebaseapp.com",
  projectId: "handmade-pos",
  storageBucket: "handmade-pos.firebasestorage.app",
  messagingSenderId: "174873514252",
  appId: "1:174873514252:web:c26659bffca850d475f929",
  measurementId: "G-3F8BYRBXDC"
};

// Example (Firestore):
// import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
// import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
// import { initDashboard } from "./app.js";
//
// const app = initializeApp(firebaseConfig);
// const db = getFirestore(app);
//
// async function getPatchFn(ym){
//   const ref = doc(db, "patches", `summary-${ym}`);
//   const snap = await getDoc(ref);
//   return snap.exists() ? snap.data() : null;
// }
//
// initDashboard({getPatchFn});
