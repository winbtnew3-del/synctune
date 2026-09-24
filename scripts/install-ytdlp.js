const fs = require('fs');
const path = require('path');
const https = require('https');

const isWin = process.platform === 'win32';
const fileName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const targetPath = path.join(__dirname, '..', fileName);

if (fs.existsSync(targetPath)) {
  const stat = fs.statSync(targetPath);
  // Ensure not empty or corrupted (< 10MB)
  if (stat.size > 10 * 1024 * 1024) {
    console.log(`[install-ytdlp] ${fileName} already exists (${(stat.size / 1024 / 1024).toFixed(1)}MB), skipping download.`);
    process.exit(0);
  }
}

const url = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

console.log(`[install-ytdlp] Downloading ${fileName} from ${url}...`);

function download(downloadUrl) {
  https.get(downloadUrl, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return download(res.headers.location);
    }

    if (res.statusCode !== 200) {
      console.error(`[install-ytdlp] Failed to download, status code: ${res.statusCode}`);
      process.exit(1);
    }

    const file = fs.createWriteStream(targetPath);
    res.pipe(file);

    file.on('finish', () => {
      file.close(() => {
        if (!isWin) {
          fs.chmodSync(targetPath, 0o755);
        }
        console.log(`[install-ytdlp] Successfully downloaded and set executable: ${targetPath}`);
      });
    });
  }).on('error', (err) => {
    console.error('[install-ytdlp] Download error:', err);
    process.exit(1);
  });
}

download(url);
