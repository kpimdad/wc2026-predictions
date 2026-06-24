/**
 * backup-predictions.js
 * Fires at each match lock time (kickoff − 5 min).
 * Emails an Excel snapshot of all predictions for that match.
 * Writes a `backedUp: true` flag to Firestore so it never sends twice.
 *
 * Required GitHub Secrets:
 *   FIREBASE_SERVICE_ACCOUNT  — already set
 *   EMAIL_PASS                — Gmail App Password for imdadkp@gmail.com
 */

'use strict';

const admin      = require('firebase-admin');
const Excel      = require('exceljs');
const nodemailer = require('nodemailer');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');

const MATCHES = require('./matches-index.json');

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Find matches whose lock time just passed (within last 10 min) ───────────
  const now       = Date.now();
  const WINDOW_MS = 10 * 60 * 1000;

  const toLock = MATCHES.filter(m => {
    const lockMs = new Date(m.kickoffUTC).getTime() - 5 * 60 * 1000;
    return lockMs <= now && lockMs >= now - WINDOW_MS;
  });

  if (toLock.length === 0) {
    console.log('No matches locking right now — nothing to do.');
    process.exit(0);
  }

  console.log(`${toLock.length} match(es) just locked:`, toLock.map(m => `${m.teamA} vs ${m.teamB}`).join(', '));

  // ── Email transport ──────────────────────────────────────────────────────────
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'imdadkp@gmail.com',
      pass: process.env.EMAIL_PASS,
    },
  });

  // ── Users map ────────────────────────────────────────────────────────────────
  const usersSnap = await db.collection('users').get();
  const nickMap   = {};
  usersSnap.forEach(d => { nickMap[d.id] = d.data().nickname || d.data().name || d.id; });

  // ── Process each locked match ─────────────────────────────────────────────
  for (const m of toLock) {
    const flagRef = db.collection('backupFlags').doc(m.matchId);
    const flag    = await flagRef.get();

    if (flag.exists && flag.data().backedUp) {
      console.log(`Already emailed for ${m.matchId} — skipping.`);
      continue;
    }

    // Fetch predictions for this match
    const predSnap = await db.collection('predictions')
      .where('matchId', '==', m.matchId)
      .get();

    const rows = [];
    predSnap.forEach(d => {
      const p = d.data();
      rows.push({
        player:     nickMap[p.userId] || p.userId,
        match:      `${m.teamA} vs ${m.teamB}`,
        prediction: `${p.predictedA} - ${p.predictedB}`,
      });
    });
    rows.sort((a, b) => a.player.localeCompare(b.player));

    // Build Excel in temp dir (not committed to repo)
    const wb = new Excel.Workbook();
    const ws = wb.addWorksheet('Predictions');

    ws.columns = [
      { header: 'Player',     key: 'player',     width: 22 },
      { header: 'Match',      key: 'match',      width: 32 },
      { header: 'Prediction', key: 'prediction', width: 14 },
    ];

    // Style header
    const headerRow = ws.getRow(1);
    headerRow.font      = { bold: true, size: 12, color: { argb: 'FF000000' } };
    headerRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD700' } };
    headerRow.alignment = { horizontal: 'center' };

    // Data rows with alternating shading
    rows.forEach((r, i) => {
      const row = ws.addRow(r);
      row.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: i % 2 === 0 ? 'FFF5F5F5' : 'FFFFFFFF' },
      };
    });

    // Add border to all cells
    ws.eachRow(row => {
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' },
        };
      });
    });

    // Save to temp file
    const dateStr  = new Date(m.kickoffUTC).toISOString().slice(0, 10);
    const matchStr = `${m.teamA.replace(/\s+/g, '_')}_vs_${m.teamB.replace(/\s+/g, '_')}`;
    const fileName = `${dateStr}_${m.matchId}_${matchStr}.xlsx`;
    const tmpPath  = path.join(os.tmpdir(), fileName);
    await wb.xlsx.writeFile(tmpPath);

    // Send email
    const kickoffTime = new Date(m.kickoffUTC).toLocaleString('en-GB', {
      timeZone: 'UTC', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    await transporter.sendMail({
      from:    '"Kootharas WC 2026" <imdadkp@gmail.com>',
      to:      'imdadkp@gmail.com',
      subject: `🔒 Predictions locked — ${m.teamA} vs ${m.teamB} (${kickoffTime})`,
      text:    `Match locked: ${m.teamA} vs ${m.teamB}\nKickoff: ${kickoffTime}\nTotal predictions captured: ${rows.length}\n\nSee attached Excel for the full list.`,
      html:    `<p><strong>Match locked:</strong> ${m.teamA} vs ${m.teamB}<br>
                <strong>Kickoff:</strong> ${kickoffTime}<br>
                <strong>Predictions captured:</strong> ${rows.length}</p>
                <p>See the attached Excel file for the full breakdown.</p>`,
      attachments: [{ filename: fileName, path: tmpPath }],
    });

    console.log(`📧 Email sent for ${m.matchId} (${rows.length} predictions)`);

    // Mark as done in Firestore so we never double-send
    await flagRef.set({
      backedUp: true,
      sentAt:   admin.firestore.FieldValue.serverTimestamp(),
      matchId:  m.matchId,
    });

    // Clean up temp file
    fs.unlinkSync(tmpPath);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
