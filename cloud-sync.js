// Cloud syncing for Dry Bed Treasure. Static-site friendly: no server code required.
// Each family's box uses a cryptographically random 128-bit sharing code.
// Never grant broad Firestore permissions: deploy firestore.rules.txt first.
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

const CODE_RE = /^[a-f0-9]{32}$/;
export function parseBoxCode(input) {
  const value = String(input || '').trim();
  if (CODE_RE.test(value.toLowerCase())) return value.toLowerCase();
  try {
    const url = new URL(value);
    const code = new URLSearchParams(url.hash.slice(1)).get('box') || url.searchParams.get('box');
    return CODE_RE.test(code || '') ? code.toLowerCase() : null;
  } catch (_) { return null; }
}
export function generateBoxCode() {
  if (!crypto?.getRandomValues) throw new Error('Secure code generation requires HTTPS.');
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function makeCloud(config) {
  if (!config || !config.apiKey || !config.projectId || !config.appId) {
    throw new Error('Firebase settings are missing.');
  }
  const app = getApps().length ? getApp() : initializeApp(config);
  const auth = getAuth(app);
  if (typeof auth.authStateReady === 'function') await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  const db = getFirestore(app);
  const settingsRef = id => doc(db, 'boxes', id, 'meta', 'settings');
  const daysRef = id => collection(db, 'boxes', id, 'days');
  const dateRef = (id, date) => doc(db, 'boxes', id, 'days', date);

  function validatedCode(code) {
    const id = parseBoxCode(code);
    if (!id) throw new Error('That sharing code is not valid.');
    return id;
  }
  const cleanSettings = s => ({
    name: String(s.name || '').slice(0, 34), start: s.start, goal: s.goal,
    updatedAt: serverTimestamp()
  });
  const cleanEntry = status => ({ status, updatedAt: serverTimestamp() });

  async function create(localData) {
    const id = generateBoxCode();
    await setDoc(settingsRef(id), cleanSettings(localData));
    const entries = Object.entries(localData.days || {});
    for (let i = 0; i < entries.length; i += 250) {
      const batch = writeBatch(db);
      for (const [day, status] of entries.slice(i, i + 250)) {
        if (status === 'dry' || status === 'notDry') batch.set(dateRef(id, day), cleanEntry(status));
      }
      await batch.commit();
    }
    return id;
  }

  async function subscribe(boxId, onData, onError) {
    const id = validatedCode(boxId);
    const initial = await getDoc(settingsRef(id));
    if (!initial.exists()) throw new Error('This shared box could not be found. Check the sharing code.');
    let latestSettings = null, latestDays = null;
    let onlineA = false, onlineB = false;
    function publish() {
      if (latestSettings && latestDays) {
        onData({ settings: latestSettings, days: latestDays, online: onlineA && onlineB });
      }
    }
    const stopSettings = onSnapshot(settingsRef(id), { includeMetadataChanges: true }, snapshot => {
      if (!snapshot.exists()) { onError(new Error('The shared box is missing.')); return; }
      const data = snapshot.data();
      latestSettings = { name: String(data.name || '').slice(0, 34), start: data.start, goal: data.goal };
      onlineA = !snapshot.metadata.fromCache;
      publish();
    }, onError);
    const stopDays = onSnapshot(daysRef(id), { includeMetadataChanges: true }, snapshot => {
      latestDays = {};
      snapshot.forEach(item => {
        const status = item.data().status;
        if (status === 'dry' || status === 'notDry') latestDays[item.id] = status;
      });
      onlineB = !snapshot.metadata.fromCache;
      publish();
    }, onError);
    return { id, stop: () => { stopSettings(); stopDays(); } };
  }

  async function setDay(id, day, status) {
    validatedCode(id);
    if (status === null) return deleteDoc(dateRef(id, day));
    return setDoc(dateRef(id, day), cleanEntry(status));
  }
  async function setSettings(id, next) {
    validatedCode(id);
    return setDoc(settingsRef(id), cleanSettings(next));
  }
  async function replaceAll(id, next) {
    validatedCode(id);
    // This routine deliberately deletes records missing from the replacement.
    const existing = await getDocs(daysRef(id));
    const oldIds = existing.docs.map(d => d.id);
    const newEntries = Object.entries(next.days || {});
    const wanted = new Set(newEntries.map(([day]) => day));
    const ops = [];
    for (const date of oldIds) if (!wanted.has(date)) ops.push({ date, status: null });
    for (const [date, status] of newEntries) ops.push({ date, status });
    for (let i = 0; i < ops.length; i += 250) {
      const batch = writeBatch(db);
      for (const {date, status} of ops.slice(i, i + 250)) {
        if (status === null) batch.delete(dateRef(id, date));
        else batch.set(dateRef(id, date), cleanEntry(status));
      }
      await batch.commit();
    }
    await setSettings(id, next);
  }
  return { create, subscribe, setDay, setSettings, replaceAll };
}
