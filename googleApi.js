// Google Drive + Sheets API helper
require('dotenv').config();
const { google } = require('googleapis');
const { Readable } = require('stream');

// Authenticate with Google Service Account
function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

const SHEET_RANGE = 'Sheet1!A:R';

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function getDrive() {
  const auth = getAuth();
  return google.drive({ version: 'v3', auth });
}

// Fetch all beats from Google Sheet, return as array of objects
async function fetchBeatsFromSheet() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const [headers, ...dataRows] = rows;

  return dataRows
    .filter(row => row[15] !== 'false')
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });

      obj.bpm = parseInt(obj.bpm) || 120;
      obj.lease_price = parseFloat(obj.lease_price) || 29.99;
      obj.premium_price = parseFloat(obj.premium_price) || 99.99;
      obj.stems_price = parseFloat(obj.stems_price) || 199.99;
      obj.plays = parseInt(obj.plays) || 0;
      obj.tags = obj.tags ? obj.tags.split(',').map(t => t.trim()) : [];

      if (obj.cover_art_id) {
        obj.cover_art_url = getDriveImageUrl(obj.cover_art_id);
      }
      if (obj.audio_file_id) {
        obj.audio_url = getDriveStreamUrl(obj.audio_file_id);
      }

      return obj;
    });
}

// Add a new beat row to Google Sheet
async function addBeatToSheet(beatData) {
  const sheets = await getSheets();
  const id = require('uuid').v4();
  const now = new Date().toISOString();

  const row = [
    id,
    beatData.title || '',
    beatData.artist || "O'Neil",
    beatData.genre || '',
    beatData.bpm || 120,
    beatData.key || '',
    beatData.mood || '',
    beatData.duration || '',
    beatData.lease_price || 29.99,
    beatData.premium_price || 99.99,
    beatData.stems_price || 199.99,
    (beatData.tags || []).join(','),
    beatData.cover_art_id || '',
    beatData.audio_file_id || '',
    0,
    now,
    'true',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:Q',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });

  return id;
}

// Update play count for a beat
async function incrementPlayCount(beatId) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];
  const headers = rows[0];
  const idCol = headers.indexOf('id');
  const playsCol = headers.indexOf('plays');

  const rowIdx = rows.findIndex((r, i) => i > 0 && r[idCol] === beatId);
  if (rowIdx === -1) return;

  const currentPlays = parseInt(rows[rowIdx][playsCol]) || 0;
  const sheetRow = rowIdx + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!${String.fromCharCode(65 + playsCol)}${sheetRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[currentPlays + 1]] },
  });
}

// Update a beat row in Google Sheet
async function updateBeatInSheet(beatId, updates) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error('Sheet is empty');

  const headers = rows[0];
  const idCol = headers.indexOf('id');
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[idCol] === beatId);
  if (rowIdx === -1) throw new Error('Beat not found');

  const updatableFields = ['title', 'genre', 'bpm', 'key', 'mood', 'lease_price', 'premium_price', 'stems_price', 'tags'];
  const sheetRow = rowIdx + 1;

  for (const field of updatableFields) {
    if (updates[field] !== undefined && updates[field] !== '') {
      const colIdx = headers.indexOf(field);
      if (colIdx === -1) continue;
      const colLetter = String.fromCharCode(65 + colIdx);
      let value = updates[field];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Sheet1!${colLetter}${sheetRow + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
      });
    }
  }
}

// Soft-delete a beat (set active = false)
async function deleteBeatInSheet(beatId) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error('Sheet is empty');

  const headers = rows[0];
  const idCol = headers.indexOf('id');
  const activeCol = headers.indexOf('active');
  if (activeCol === -1) throw new Error('No active column found');

  const rowIdx = rows.findIndex((r, i) => i > 0 && r[idCol] === beatId);
  if (rowIdx === -1) throw new Error('Beat not found');

  const sheetRow = rowIdx + 1;
  const colLetter = String.fromCharCode(65 + activeCol);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!${colLetter}${sheetRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['false']] },
  });
}

// Google Drive: File Upload
async function uploadFileToDrive(buffer, filename, mimeType) {
  const drive = await getDrive();

  const fileMetadata = {
    name: filename,
    parents: [DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType,
    body: Readable.from(buffer),
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webContentLink, webViewLink',
  });

  // Make file publicly readable
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return res.data.id;
}

// Get a direct streaming URL for audio files
function getDriveStreamUrl(fileId) {
  return 'https://drive.google.com/uc?export=download&id=' + fileId;
}

// Get a thumbnail/image URL for cover art
function getDriveImageUrl(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400';
}

// Get full-res download URL (for purchased beats)
function getDriveDownloadUrl(fileId) {
  return 'https://drive.google.com/uc?export=download&confirm=1&id=' + fileId;
}

module.exports = {
  fetchBeatsFromSheet,
  addBeatToSheet,
  updateBeatInSheet,
  deleteBeatInSheet,
  incrementPlayCount,
  uploadFileToDrive,
  getDriveStreamUrl,
  getDriveImageUrl,
  getDriveDownloadUrl,
};
