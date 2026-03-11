const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json()); // Agar backend bisa membaca data JSON

const upload = multer({ storage: multer.memoryStorage() });

const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// PENTING: Gunakan Project ID Firebase Anda
const PROJECT_ID = "onion-cloud-a8d3d"; 
const DB_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ==========================================
// FUNGSI WAKTU AKURAT (WIB - ASIA/JAKARTA)
// ==========================================
const getWIBDate = () => {
    // Membuat tanggal berdasarkan waktu UTC lalu ditambah 7 jam untuk WIB
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 7);
    return d.toISOString().split('T')[0]; // Menghasilkan format YYYY-MM-DD
};

// ==========================================
// ENDPOINT 1: Sinkronisasi Koin (Dipanggil saat web dibuka)
// ==========================================
app.get('/api/user/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const todayWIB = getWIBDate(); // Menggunakan tanggal WIB yang akurat
        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;

        let coins = 0;
        let isNewDay = false;

        try {
            // Coba ambil data user dari Firebase
            const fRes = await axios.get(userUrl);
            const fields = fRes.data.fields;
            const lastLogin = fields.last_login?.stringValue || "";
            coins = parseInt(fields.coins?.integerValue || fields.coins?.doubleValue || 0);

            // Jika tanggal terakhir login BERBEDA dengan tanggal WIB hari ini
            if (lastLogin !== todayWIB) {
                coins = 3;
                isNewDay = true;
                // Update koin jadi 3 dan set tanggal login ke hari ini
                await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=last_login`, {
                    fields: {
                        coins: { integerValue: 3 },
                        last_login: { stringValue: todayWIB }
                    }
                });
            }
        } catch (err) {
            // Jika user belum ada (Error 404 dari Firebase)
            if (err.response && err.response.status === 404) {
                coins = 3;
                isNewDay = true;
                // Buat user baru dengan 3 koin
                await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=last_login`, {
                    fields: {
                        coins: { integerValue: 3 },
                        last_login: { stringValue: todayWIB }
                    }
                });
            } else {
                throw err; // Lempar error jika masalahnya bukan 404 (misal: Rules terkunci)
            }
        }

        res.json({ coins, isNewDay });
    } catch (error) {
        console.error("Firebase API Error:", error.response?.data || error.message);
        res.status(500).json({ error: 'Gagal mengambil data koin dari server' });
    }
});

// ==========================================
// ENDPOINT 2: Upload File & Potong Koin
// ==========================================
app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        const clientId = req.body.clientId;
        if (!clientId) return res.status(400).json({ error: 'Akses Ditolak: KTP tidak valid' });
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;
        let currentCoins = 0;

        // 1. CEK KOIN DI DATABASE (Anti-Hack)
        try {
            const fRes = await axios.get(userUrl);
            currentCoins = parseInt(fRes.data.fields.coins?.integerValue || 0);
        } catch (err) {
            return res.status(403).json({ error: 'OUT_OF_COINS' });
        }

        if (currentCoins <= 0) return res.status(403).json({ error: 'OUT_OF_COINS' });

        // 2. PROSES UPLOAD KE TELEGRAM
        const mime = req.file.mimetype;
        const originalName = req.file.originalname || 'Unknown_File';
        let endpoint = 'sendDocument';
        let fieldName = 'document';

        if (mime.startsWith('image/') && mime !== 'image/gif') {
            endpoint = 'sendPhoto'; fieldName = 'photo';
        } else if (mime.startsWith('video/')) {
            endpoint = 'sendVideo'; fieldName = 'video';
        } else if (mime === 'image/gif') {
            endpoint = 'sendAnimation'; fieldName = 'animation';
        }

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append(fieldName, req.file.buffer, { filename: originalName });

        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/${endpoint}`, form, {
            headers: form.getHeaders()
        });

        const result = teleRes.data.result;
        let fileId = endpoint === 'sendPhoto' ? result.photo.pop().file_id : 
                     endpoint === 'sendVideo' ? result.video.file_id : 
                     endpoint === 'sendAnimation' ? result.animation.file_id : 
                     result.document.file_id;

        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const customUrl = `${protocol}://${host}/v/${fileId}`;

        // 3. POTONG KOIN
        await axios.patch(`${userUrl}?updateMask.fieldPaths=coins`, {
            fields: { coins: { integerValue: currentCoins - 1 } }
        });

        // 4. SIMPAN RIWAYAT KE FIREBASE
        const currentSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
        await axios.post(`${DB_URL}/telecloud_uploads`, {
            fields: {
                userId: { stringValue: clientId },
                fileName: { stringValue: originalName },
                fileSize: { stringValue: currentSizeMB + " MB" },
                url: { stringValue: customUrl },
                timestamp: { timestampValue: new Date().toISOString() }
            }
        });

        // Kembalikan Link URL dan Sisa Koin terbaru ke Frontend
        res.json({ url: customUrl, remainingCoins: currentCoins - 1 });

    } catch (error) {
        console.error("Upload Error:", error.response?.data || error.message);
        res.status(500).json({ error: 'Gagal memproses unggahan' });
    }
});

// ==========================================
// ENDPOINT 3: Proxy Penampil Media
// ==========================================
app.get('/v/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;

        const mediaRes = await axios({
            url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`,
            method: 'GET',
            responseType: 'stream'
        });

        res.setHeader('Content-Type', mediaRes.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        mediaRes.data.pipe(res);
    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(404).send('File tidak ditemukan / sudah dihapus');
    }
});

module.exports = app;