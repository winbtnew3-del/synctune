const fs = require('fs');
const path = require('path');
const https = require('https');

const isWin = process.platform === 'win32';
const fileName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const targetPath = path.join(__dirname, '..', fileName);

if (fs.existsSync(targetPath)) {
  console.log(`[install-ytdlp] ${fileName} already exists, skipping download.`);
  process.exit(0);
}

const url = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

console.log(`[install-ytdlp] Downloading ${fileName} from ${url}...`);

function download(downloadUrl) {
  https.get(downloadUrl, (res) => {
    // Follow redirect
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
