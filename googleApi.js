// Google Drive + Sheets API helper
require('dotenv').config();
const { google } = require('googleapis');
const { Readable } = require('stream');

// Authenticate with Google Service Account (for Sheets operations)
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

// OAuth2 client for Drive uploads (uses user's own storage quota)
function getDriveOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });
  return oauth2Client;
}

// Get a fresh access token from OAuth2 refresh token
async function getOAuthAccessToken() {
  const oauth2Client = getDriveOAuth2Client();
  const { token } = await oauth2Client.getAccessToken();
  return token;
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

// Google Drive: File Upload (uses resumable upload to support any file size)
// Uses OAuth2 user credentials so uploads count against the user's own Drive quota
// (service accounts on free Gmail have 0 storage quota)
async function uploadFileToDrive(buffer, filename, mimeType) {
  const accessToken = await getOAuthAccessToken();

  const targetFolder = DRIVE_FOLDER_ID;
  if (!targetFolder) throw new Error('GOOGLE_DRIVE_FOLDER_ID not configured');

  const metadata = { name: filename, parents: [targetFolder] };

  // Step 1: Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webContentLink,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': buffer.length.toString(),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Drive upload init failed (${initRes.status}): ${errText}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No resumable upload URL returned');

  // Step 2: Upload the file content
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': buffer.length.toString(),
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Drive upload failed (${uploadRes.status}): ${errText}`);
  }

  const fileData = await uploadRes.json();

  // Step 3: Make file publicly readable (using OAuth client)
  const oauthDrive = google.drive({ version: 'v3', auth: getDriveOAuth2Client() });
  await oauthDrive.permissions.create({
    fileId: fileData.id,
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return fileData.id;
}

// Google Drive: Create a resumable upload session URL
// Uses OAuth2 user credentials for upload quota
async function createResumableUpload(filename, mimeType, folderId) {
  const accessToken = await getOAuthAccessToken();

  const targetFolder = folderId || DRIVE_FOLDER_ID;
  const metadata = { name: filename, parents: [targetFolder] };

  // Initiate resumable upload session via Google Drive API v3
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webContentLink,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Google Drive resumable init failed (${initRes.status}): ${errText}`);
  }

  // The Location header contains the resumable upload URL
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No resumable upload URL returned');

  return { uploadUrl, folderId: targetFolder };
}

// Google Drive: After upload completes, set file as publicly readable and return URLs
async function finalizeUpload(fileId) {
  const oauthDrive = google.drive({ version: 'v3', auth: getDriveOAuth2Client() });
  await oauthDrive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return {
    fileId,
    streamUrl: getDriveStreamUrl(fileId),
    downloadUrl: getDriveDownloadUrl(fileId),
    imageUrl: getDriveImageUrl(fileId),
  };
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
  createResumableUpload,
  finalizeUpload,
  getDriveStreamUrl,
  getDriveImageUrl,
  getDriveDownloadUrl,
};
