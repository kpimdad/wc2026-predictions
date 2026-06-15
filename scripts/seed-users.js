/**
 * seed-users.js — one-time run via GitHub Actions (workflow_dispatch only)
 * Adds WC 2026 players to Firestore, skipping any that already exist.
 */
'use strict';
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PLAYERS = [
  'Anu', 'Imdad', 'Nadi', 'Safi', 'Hannatha',
  'Haya', 'Sani', 'Hibatha', 'Usama', 'Naflu', 'Hishu', 'Raji'
];

async function main() {
  // Fetch existing nicknames
  const snap = await db.collection('users').get();
  const existing = new Set();
  snap.forEach(d => {
    const n = (d.data().nickname || '').toLowerCase().replace(/\s+/g, '');
    existing.add(n);
  });

  let added = 0, skipped = 0;

  for (const nickname of PLAYERS) {
    const key = nickname.toLowerCase().replace(/\s+/g, '');
    if (existing.has(key)) {
      console.log(`  — Skipping "${nickname}" (already exists)`);
      skipped++;
      continue;
    }
    const ref = db.collection('users').doc();
    await ref.set({
      nickname,
      pinHash: '',
      mobile: '',
      isAdmin: false,
      totalPoints: 0,
      exactScores: 0,
      correctResults: 0,
      championPick: '',
      goldenBootPick: '',
      lastMinuteCount: 0,
      photoURL: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`  ✅ Added "${nickname}"`);
    added++;
  }

  console.log(`\nDone. Added: ${added}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
