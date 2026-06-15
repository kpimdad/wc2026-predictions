'use strict';
/**
 * backup.js
 * Daily backup of all Firestore data → Excel (.xlsx) → emailed as attachment
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

function autoWidth(sheet) {
  sheet.columns.forEach(col => {
    let max = col.header ? col.header.length : 10;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 3, 40);
  });
}

// ── Build workbook ─────────────────────────────────────────────────────────

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'WC2026 Backup';
  wb.created  = new Date();

  // ── Fetch all data ──────────────────────────────────────────────────────
  const [usersSnap, predsSnap, matchesSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('predictions').get(),
    db.collection('matches').get(),
  ]);

  const users   = {};
  const matches = {};

  usersSnap.forEach(d => { users[d.id]   = { id: d.id, ...d.data() }; });
  matchesSnap.forEach(d => { matches[d.id] = { id: d.id, ...d.data() }; });

  // ── Sheet 1: Leaderboard ────────────────────────────────────────────────
  const lbSheet = wb.addWorksheet('Leaderboard');
  lbSheet.columns = [
    { header: 'Rank',           key: 'rank',    width: 8  },
    { header: 'Player',         key: 'name',    width: 18 },
    { header: 'Points',         key: 'pts',     width: 10 },
    { header: 'Exact Scores',   key: 'exact',   width: 14 },
    { header: 'Correct Results',key: 'result',  width: 16 },
    { header: 'Champion Pick',  key: 'champ',   width: 18 },
    { header: 'Top Scorer Pick',key: 'boot',    width: 18 },
  ];
  headerStyle(lbSheet.getRow(1));

  const activeUsers = Object.values(users)
    .filter(u => !u.disabled && !u.isAdminAccount)
    .sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));

  activeUsers.forEach((u, i) => {
    const row = lbSheet.addRow({
      rank:   i + 1,
      name:   u.nickname || '–',
      pts:    u.totalPoints    || 0,
      exact:  u.exactScores    || 0,
      result: u.correctResults || 0,
      champ:  u.championPick   || '–',
      boot:   u.goldenBootPick || '–',
    });
    if (i % 2 === 0) {
      row.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
      });
    }
    row.getCell('pts').font   = { bold: true, color: { argb: 'FFB8860B' } };
    row.getCell('exact').font = { color: { argb: 'FFCC8800' } };
  });
  autoWidth(lbSheet);

  // ── Sheet 2: Predictions ────────────────────────────────────────────────
  const predSheet = wb.addWorksheet('Predictions');
  predSheet.columns = [
    { header: 'Player',          key: 'player',   width: 14 },
    { header: 'Match',           key: 'match',    width: 28 },
    { header: 'Kickoff (UTC)',   key: 'kickoff',  width: 20 },
    { header: 'Predicted',       key: 'predicted',width: 12 },
    { header: 'Actual',          key: 'actual',   width: 12 },
    { header: 'Points',          key: 'pts',      width: 10 },
    { header: 'Last Minute',     key: 'lastmin',  width: 13 },
  ];
  headerStyle(predSheet.getRow(1));

  const predRows = [];
  predsSnap.forEach(d => {
    const p = d.data();
    const u = users[p.userId];
    const m = matches[p.matchId];
    if (!u || !m) return;
    predRows.push({
      player:    u.nickname || p.userId,
      match:     `${m.teamA || '?'} vs ${m.teamB || '?'}`,
      kickoff:   m.kickoffUTC ? new Date(m.kickoffUTC).toISOString().replace('T', ' ').slice(0, 16) : '–',
      predicted: `${p.predictedA} – ${p.predictedB}`,
      actual:    m.resultA != null ? `${m.resultA} – ${m.resultB}` : '–',
      pts:       p.pointsAwarded ?? '–',
      lastmin:   p.lastMinute ? 'Yes' : 'No',
    });
  });

  // Sort by kickoff then player
  predRows.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.player.localeCompare(b.player));
  predRows.forEach((r, i) => {
    const row = predSheet.addRow(r);
    if (i % 2 === 0) row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
    });
    if (r.pts === 13) row.getCell('pts').font = { bold: true, color: { argb: 'FFCC8800' } };
    if (r.pts === 10) row.getCell('pts').font = { color: { argb: 'FF2E7D32' } };
    if (r.pts === 0)  row.getCell('pts').font = { color: { argb: 'FFC62828' } };
  });
  autoWidth(predSheet);

  // ── Sheet 3: Match Results ──────────────────────────────────────────────
  const matchSheet = wb.addWorksheet('Match Results');
  matchSheet.columns = [
    { header: 'Match Day',   key: 'day',     width: 14 },
    { header: 'Kickoff UTC', key: 'kickoff', width: 20 },
    { header: 'Team A',      key: 'teamA',   width: 22 },
    { header: 'Score',       key: 'score',   width: 10 },
    { header: 'Team B',      key: 'teamB',   width: 22 },
    { header: 'Status',      key: 'status',  width: 12 },
  ];
  headerStyle(matchSheet.getRow(1));

  const matchRows = Object.values(matches)
    .sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));

  matchRows.forEach((m, i) => {
    const row = matchSheet.addRow({
      day:     m.matchDay || '–',
      kickoff: m.kickoffUTC ? new Date(m.kickoffUTC).toISOString().replace('T', ' ').slice(0, 16) : '–',
      teamA:   m.teamA || '–',
      score:   m.resultA != null ? `${m.resultA} – ${m.resultB}` : 'TBD',
      teamB:   m.teamB || '–',
      status:  m.status || '–',
    });
    if (i % 2 === 0) row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
    });
    if (m.status === 'completed') row.getCell('score').font = { bold: true };
  });
  autoWidth(matchSheet);

  // ── Sheet 4: Users ──────────────────────────────────────────────────────
  const userSheet = wb.addWorksheet('Users');
  userSheet.columns = [
    { header: 'Nickname',        key: 'name',    width: 16 },
    { header: 'Points',          key: 'pts',     width: 10 },
    { header: 'Exact Scores',    key: 'exact',   width: 14 },
    { header: 'Correct Results', key: 'result',  width: 16 },
    { header: 'Champion Pick',   key: 'champ',   width: 18 },
    { header: 'Top Scorer Pick', key: 'boot',    width: 18 },
    { header: 'Mobile',          key: 'mobile',  width: 14 },
    { header: 'Admin',           key: 'admin',   width: 8  },
    { header: 'Status',          key: 'status',  width: 10 },
  ];
  headerStyle(userSheet.getRow(1));

  Object.values(users).forEach((u, i) => {
    const row = userSheet.addRow({
      name:   u.nickname       || '–',
      pts:    u.totalPoints    || 0,
      exact:  u.exactScores    || 0,
      result: u.correctResults || 0,
      champ:  u.championPick   || '–',
      boot:   u.goldenBootPick || '–',
      mobile: u.mobile         || '–',
      admin:  u.isAdmin ? 'Yes' : 'No',
      status: u.disabled ? 'Disabled' : 'Active',
    });
    if (i % 2 === 0) row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
    });
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
    auth: {
      user: SENDER,
      pass: process.env.GMAIL_BACKUP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from:     `"WC2026 Backup" <${SENDER}>`,
    to:       RECIPIENT,
    subject:  `⚽ WC2026 Daily Backup — ${today}`,
    html: `
      <h2 style="color:#0A3D6B">World Cup 2026 — Daily Backup</h2>
      <p>Your daily data backup is attached.</p>
      <p>The Excel file contains 4 sheets:<br>
        <strong>Leaderboard</strong> · <strong>Predictions</strong> ·
        <strong>Match Results</strong> · <strong>Users</strong>
      </p>
      <p style="color:#888;font-size:12px">Generated: ${new Date().toUTCString()}</p>
    `,
    attachments: [{ filename, path: tmpPath }],
  });

  console.log(`✅ Backup emailed to ${RECIPIENT} — ${filename}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Starting daily backup…`);
  const wb = await buildWorkbook();
  await sendBackup(wb);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
