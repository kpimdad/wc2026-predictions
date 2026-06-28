'use strict';
/**
 * update-r32-teams.js
 * One-time script: writes confirmed Round of 32 team names (and corrected
 * kickoff times) to the Firestore `matches` collection.
 *
 * Run once via GitHub Actions → Actions tab → "Update R32 Teams" → Run workflow.
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const R32 = [
  { matchId: 'm073', kickoffUTC: '2026-06-28T19:00:00Z', teamA: 'South Africa',       teamB: 'Canada' },
  { matchId: 'm074', kickoffUTC: '2026-06-29T17:00:00Z', teamA: 'Brazil',              teamB: 'Japan' },
  { matchId: 'm075', kickoffUTC: '2026-06-29T20:30:00Z', teamA: 'Germany',             teamB: 'Paraguay' },
  { matchId: 'm076', kickoffUTC: '2026-06-30T01:00:00Z', teamA: 'Netherlands',         teamB: 'Morocco' },
  { matchId: 'm077', kickoffUTC: '2026-06-30T17:00:00Z', teamA: 'Ivory Coast',         teamB: 'Norway' },
  { matchId: 'm078', kickoffUTC: '2026-06-30T21:00:00Z', teamA: 'France',              teamB: 'Sweden' },
  { matchId: 'm079', kickoffUTC: '2026-07-01T01:00:00Z', teamA: 'Mexico',              teamB: 'Ecuador' },
  { matchId: 'm080', kickoffUTC: '2026-07-01T16:00:00Z', teamA: 'England',             teamB: 'DR Congo' },
  { matchId: 'm081', kickoffUTC: '2026-07-01T20:00:00Z', teamA: 'Belgium',             teamB: 'Senegal' },
  { matchId: 'm082', kickoffUTC: '2026-07-02T00:00:00Z', teamA: 'USA',                 teamB: 'Bosnia & Herzegovina' },
  { matchId: 'm083', kickoffUTC: '2026-07-02T19:00:00Z', teamA: 'Spain',               teamB: 'Austria' },
  { matchId: 'm084', kickoffUTC: '2026-07-02T23:00:00Z', teamA: 'Portugal',            teamB: 'Croatia' },
  { matchId: 'm085', kickoffUTC: '2026-07-03T03:00:00Z', teamA: 'Switzerland',         teamB: 'Algeria' },
  { matchId: 'm086', kickoffUTC: '2026-07-03T18:00:00Z', teamA: 'Australia',           teamB: 'Egypt' },
  { matchId: 'm087', kickoffUTC: '2026-07-03T22:00:00Z', teamA: 'Argentina',           teamB: 'Cape Verde' },
  { matchId: 'm088', kickoffUTC: '2026-07-04T01:30:00Z', teamA: 'Colombia',            teamB: 'Ghana' },
];

async function main() {
  console.log(`Updating ${R32.length} Round of 32 fixtures in Firestore…`);
  const batch = db.batch();
  R32.forEach(m => {
    batch.set(
      db.collection('matches').doc(m.matchId),
      { teamA: m.teamA, teamB: m.teamB, kickoffUTC: m.kickoffUTC },
      { merge: true }
    );
  });
  await batch.commit();
  console.log('Done. All R32 team names written to Firestore.');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
