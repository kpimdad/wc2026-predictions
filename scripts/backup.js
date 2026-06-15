'use strict';
/**
 * backup.js — Daily backup → Excel email
 * Sheets: Leaderboard | Predictions | Match Results | Users
 */

const admin      = require('firebase-admin');
const ExcelJS    = require('exceljs');
const nodemailer = require('nodemailer');
const path       = require('path');
const os         = require('os');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// matches-index.json lives in the same scripts/ directory
const MATCHES_INDEX = require('./matches-index.json');
const matchIndex = {};
MATCHES_INDEX.forEach(m => { matchIndex[m.matchId] = m; });

const RECIPIENT = process.env.BACKUP_EMAIL || 'imdadkp@gmail.com';
const SENDER    = process.env.GMAIL_USER   || 'imdadkp@gmail.com';

// ── Helpers ────────────────────────────────────────────────────────────────

function headerStyle(row) {
  row.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A3D6B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1A6EBD' } } };
  });
}

function stripe(row, i) {
  if (i % 2 === 0) row.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
  });
}

function autoWidth(sheet) {
  sheet.columns.forEach(col => {
    let max = col.header ? col.header.length : 10;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 3, 42);
  });
}

function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ── Build workbook ─────────────────────────────────────────────────────────

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WC2026 Backup';
  wb.created = new Date();

  // ── Fetch all Firestore data ────────────────────────────────────────────
  const [usersSnap, predsSnap, matchesSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('predictions').get(),
    db.collection('matches').get(),
  ]);

  // Build user map — keyed by doc ID
  const allUsers = {};
  usersSnap.forEach(d => { allUsers[d.id] = { id: d.id, ...d.data() }; });

  // Active players only (exclude disabled and admin/system accounts)
  const activePlayers = Object.values(allUsers).filter(
    u => !u.disabled && !u.isAdminAccount && u.nickname !== 'Admin_account'
  );

  // Firestore match results — keyed by matchId
  const firestoreResults = {};
  matchesSnap.forEach(d => { firestoreResults[d.id] = d.data(); });

  // Compute exact/correct counts from predictions (user doc fields may be stale)
  const exactCount   = {};
  const correctCount = {};
  predsSnap.forEach(d => {
    const p = d.data();
    if (p.pointsAwarded === 13) exactCount[p.userId]   = (exactCount[p.userId]   || 0) + 1;
    if (p.pointsAwarded === 10) correctCount[p.userId] = (correctCount[p.userId] || 0) + 1;
  });

  // ── SHEET 1: Leaderboard ────────────────────────────────────────────────
  const lbSheet = wb.addWorksheet('Leaderboard');
  lbSheet.columns = [
    { header: 'Rank',            key: 'rank',    width: 8  },
    { header: 'Player',          key: 'name',    width: 16 },
    { header: 'Points',          key: 'pts',     width: 10 },
    { header: 'Exact Scores',    key: 'exact',   width: 14 },
    { header: 'Correct Results', key: 'correct', width: 16 },
    { header: 'Champion Pick',   key: 'champ',   width: 20 },
    { header: 'Top Scorer Pick', key: 'boot',    width: 20 },
  ];
  headerStyle(lbSheet.getRow(1));

  const sorted = [...activePlayers].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
  sorted.forEach((u, i) => {
    const row = lbSheet.addRow({
      rank:    i + 1,
      name:    u.nickname || '–',
      pts:     u.totalPoints || 0,
      exact:   exactCount[u.id]   || 0,
      correct: correctCount[u.id] || 0,
      champ:   u.championPick   || '–',
      boot:    u.goldenBootPick || '–',
    });
    stripe(row, i);
    row.getCell('pts').font   = { bold: true, color: { argb: 'FFB8860B' } };
    row.getCell('exact').font = { bold: true, color: { argb: 'FFCC8800' } };
    row.getCell('correct').font = { color: { argb: 'FF2E7D32' } };
  });
  autoWidth(lbSheet);

  // ── SHEET 2: Predictions ────────────────────────────────────────────────
  const predSheet = wb.addWorksheet('Predictions');
  predSheet.columns = [
    { header: 'Player',        key: 'player',    width: 14 },
    { header: 'Match',         key: 'match',     width: 30 },
    { header: 'Kickoff (UTC)', key: 'kickoff',   width: 20 },
    { header: 'Predicted',     key: 'predicted', width: 12 },
    { header: 'Actual',        key: 'actual',    width: 12 },
    { header: 'Points',        key: 'pts',       width: 10 },
  ];
  headerStyle(predSheet.getRow(1));

  const predRows = [];
  predsSnap.forEach(d => {
    const p = d.data();
    const u = allUsers[p.userId];
    if (!u || u.disabled || u.isAdminAccount) return;

    const mi = matchIndex[p.matchId];
    const fr = firestoreResults[p.matchId];

    predRows.push({
      player:    u.nickname || '–',
      match:     mi ? `${mi.teamA} vs ${mi.teamB}` : '–',
      kickoff:   mi ? fmtDate(mi.kickoffUTC) : '–',
      predicted: `${p.predictedA} – ${p.predictedB}`,
      actual:    (fr?.resultA != null) ? `${fr.resultA} – ${fr.resultB}` : '–',
      pts:       p.pointsAwarded ?? '–',
      _kickoff:  mi?.kickoffUTC || '',
      _player:   u.nickname || '',
    });
  });

  predRows.sort((a, b) => a._kickoff.localeCompare(b._kickoff) || a._player.localeCompare(b._player));
  predRows.forEach((r, i) => {
    const row = predSheet.addRow({
      player: r.player, match: r.match, kickoff: r.kickoff,
      predicted: r.predicted, actual: r.actual, pts: r.pts,
    });
    stripe(row, i);
    if (r.pts === 13) row.getCell('pts').font = { bold: true, color: { argb: 'FFCC8800' } };
    if (r.pts === 10) row.getCell('pts').font = { color: { argb: 'FF2E7D32' } };
    if (r.pts === 0)  row.getCell('pts').font = { color: { argb: 'FFC62828' } };
  });
  autoWidth(predSheet);

  // ── SHEET 3: Match Results ──────────────────────────────────────────────
  const matchSheet = wb.addWorksheet('Match Results');
  matchSheet.columns = [
    { header: 'Match Day',     key: 'day',     width: 14 },
    { header: 'Kickoff (UTC)', key: 'kickoff', width: 22 },
    { header: 'Team A',        key: 'teamA',   width: 22 },
    { header: 'Score',         key: 'score',   width: 12 },
    { header: 'Team B',        key: 'teamB',   width: 22 },
    { header: 'Status',        key: 'status',  width: 12 },
  ];
  headerStyle(matchSheet.getRow(1));

  // Use matches-index.json as the source of truth for teams/kickoffs
  // Join with Firestore for results/status
  const matchRows = [...MATCHES_INDEX].sort(
    (a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC)
  );
  matchRows.forEach((m, i) => {
    const fr = firestoreResults[m.matchId] || {};
    const hasResult = fr.resultA != null;
    const row = matchSheet.addRow({
      day:     m.matchDay   || '–',
      kickoff: fmtDate(m.kickoffUTC),
      teamA:   m.teamA      || '–',
      score:   hasResult ? `${fr.resultA} – ${fr.resultB}` : 'TBD',
      teamB:   m.teamB      || '–',
      status:  fr.status    || 'upcoming',
    });
    stripe(row, i);
    if (hasResult) row.getCell('score').font = { bold: true };
  });
  autoWidth(matchSheet);

  // ── SHEET 4: Users (active only) ────────────────────────────────────────
  const userSheet = wb.addWorksheet('Users');
  userSheet.columns = [
    { header: 'Player',          key: 'name',    width: 16 },
    { header: 'Points',          key: 'pts',     width: 10 },
    { header: 'Exact Scores',    key: 'exact',   width: 14 },
    { header: 'Correct Results', key: 'correct', width: 16 },
    { header: 'Champion Pick',   key: 'champ',   width: 20 },
    { header: 'Top Scorer Pick', key: 'boot',    width: 20 },
  ];
  headerStyle(userSheet.getRow(1));

  activePlayers.forEach((u, i) => {
    const row = userSheet.addRow({
      name:    u.nickname       || '–',
      pts:     u.totalPoints    || 0,
      exact:   exactCount[u.id]   || 0,
      correct: correctCount[u.id] || 0,
      champ:   u.championPick   || '–',
      boot:    u.goldenBootPick || '–',
    });
    stripe(row, i);
  });
  autoWidth(userSheet);

  return wb;
}

// ── Send email ─────────────────────────────────────────────────────────────

async function sendBackup(wb) {
  const today    = new Date().toISOString().slice(0, 10);
  const filename = `WC2026-Backup-${today}.xlsx`;
  const tmpPath  = path.join(os.tmpdir(), filename);

  await wb.xlsx.writeFile(tmpPath);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SENDER, pass: process.env.GMAIL_BACKUP_PASSWORD },
  });

  await transporter.sendMail({
    from:    `"WC2026 Backup" <${SENDER}>`,
    to:      RECIPIENT,
    subject: `⚽ WC2026 Daily Backup — ${today}`,
    html: `
      <h2 style="color:#0A3D6B">World Cup 2026 — Daily Backup</h2>
      <p>Your daily data backup is attached.</p>
      <ul>
        <li><strong>Leaderboard</strong> — ranked standings with exact scores &amp; correct results</li>
        <li><strong>Predictions</strong> — all active player predictions with match names, kickoffs &amp; points</li>
        <li><strong>Match Results</strong> — all 104 matches with scores &amp; status</li>
        <li><strong>Users</strong> — active players summary</li>
      </ul>
      <p style="color:#888;font-size:12px">Generated: ${new Date().toUTCString()}</p>
    `,
    attachments: [{ filename, path: tmpPath }],
  });

  console.log(`✅ Backup emailed to ${RECIPIENT} (${filename})`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Starting daily backup…`);
  const wb = await buildWorkbook();
  await sendBackup(wb);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
