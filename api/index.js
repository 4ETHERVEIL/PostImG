const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json()); 

const upload = multer({ storage: multer.memoryStorage() });

const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PROJECT_ID = "onion-cloud-a8d3d"; 
const DB_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// BATAS KOIN HARIAN SESUAI MEMBERSHIP
const TIER_LIMITS = { "Free": 3, "VIP": 10, "VVIP": 20, "VVIP+": 30 };

const getWIBDate = () => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 7);
    return d.toISOString().split('T')[0]; 
};

// ==========================================
// ENDPOINT 1: Sinkronisasi Koin & Membership
// ==========================================
app.get('/api/user/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const todayWIB = getWIBDate(); 
        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;

        let coins = 0;
        let isNewDay = false;
        let tier = "Free";
        let resetAmount = 3;

        try {
            const fRes = await axios.get(userUrl);
            const fields = fRes.data.fields;
            const lastLogin = fields.last_login?.stringValue || "";
            
            coins = parseInt(fields.coins?.integerValue || fields.coins?.doubleValue || 0);
            tier = fields.tier?.stringValue || "Free";
            resetAmount = TIER_LIMITS[tier] || 3;

            if (lastLogin !== todayWIB) {
                coins = resetAmount;
                isNewDay = true;
                await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=last_login&updateMask.fieldPaths=tier`, {
                    fields: { coins: { integerValue: coins }, last_login: { stringValue: todayWIB }, tier: { stringValue: tier } }
                });
            }
        } catch (err) {
            if (err.response && err.response.status === 404) {
                coins = 3; tier = "Free"; resetAmount = 3; isNewDay = true;
                await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=last_login&updateMask.fieldPaths=tier`, {
                    fields: { coins: { integerValue: 3 }, last_login: { stringValue: todayWIB }, tier: { stringValue: "Free" } }
                });
            } else { throw err; }
        }

        res.json({ coins, isNewDay, tier, resetAmount });
    } catch (error) {
        res.status(500).json({ error: 'Gagal sinkronisasi data' });
    }
});

// ==========================================
// ENDPOINT 2: Upload File & Potong Koin
// ==========================================
app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        const clientId = req.body.clientId;
        if (!clientId) return res.status(400).json({ error: 'KTP tidak valid' });
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;
        let currentCoins = 0;

        try {
            const fRes = await axios.get(userUrl);
            currentCoins = parseInt(fRes.data.fields.coins?.integerValue || 0);
        } catch (err) { return res.status(403).json({ error: 'OUT_OF_COINS' }); }

        if (currentCoins <= 0) return res.status(403).json({ error: 'OUT_OF_COINS' });

        const mime = req.file.mimetype;
        const originalName = req.file.originalname || 'Unknown_File';
        let endpoint = 'sendDocument';
        let fieldName = 'document';

        if (mime.startsWith('image/') && mime !== 'image/gif') { endpoint = 'sendPhoto'; fieldName = 'photo'; } 
        else if (mime.startsWith('video/')) { endpoint = 'sendVideo'; fieldName = 'video'; } 
        else if (mime === 'image/gif') { endpoint = 'sendAnimation'; fieldName = 'animation'; }

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append(fieldName, req.file.buffer, { filename: originalName });

        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/${endpoint}`, form, { headers: form.getHeaders() });
        const result = teleRes.data.result;
        let fileId = endpoint === 'sendPhoto' ? result.photo.pop().file_id : 
                     endpoint === 'sendVideo' ? result.video.file_id : 
                     endpoint === 'sendAnimation' ? result.animation.file_id : result.document.file_id;

        const customUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/v/${fileId}`;

        await axios.patch(`${userUrl}?updateMask.fieldPaths=coins`, {
            fields: { coins: { integerValue: currentCoins - 1 } }
        });

        const currentSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
        await axios.post(`${DB_URL}/telecloud_uploads`, {
            fields: {
                userId: { stringValue: clientId }, fileName: { stringValue: originalName },
                fileSize: { stringValue: currentSizeMB + " MB" }, url: { stringValue: customUrl },
                timestamp: { timestampValue: new Date().toISOString() }
            }
        });

        res.json({ url: customUrl, remainingCoins: currentCoins - 1 });
    } catch (error) { res.status(500).json({ error: 'Upload gagal diproses' }); }
});

// ==========================================
// ENDPOINT 3: Proxy Penampil Media
// ==========================================
app.get('/v/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;
        const mediaRes = await axios({ url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`, method: 'GET', responseType: 'stream' });
        
        res.setHeader('Content-Type', mediaRes.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        mediaRes.data.pipe(res);
    } catch (error) { res.status(404).send('File tidak ditemukan'); }
});

// ==========================================
// ENDPOINT 4: ADMIN PANEL - AMBIL DATA
// ==========================================
app.post('/api/admin/data', async (req, res) => {
    try {
        const { username, password } = req.body;
        const validUser = process.env.ADMIN_USER || "admin";
        const validPass = process.env.ADMIN_PASS || "onion2026";

        if (username !== validUser || password !== validPass) return res.status(401).json({ error: 'Kredensial Tidak Valid!' });

        const usersRes = await axios.get(`${DB_URL}/telecloud_users`);
        const users = (usersRes.data.documents || []).map(doc => ({
            id: doc.name.split('/').pop(),
            coins: parseInt(doc.fields.coins?.integerValue || doc.fields.coins?.doubleValue || 0),
            tier: doc.fields.tier?.stringValue || "Free",
            last_login: doc.fields.last_login?.stringValue || "Unknown"
        }));

        const uploadsRes = await axios.get(`${DB_URL}/telecloud_uploads`);
        const uploads = (uploadsRes.data.documents || []).map(doc => ({
            userId: doc.fields.userId?.stringValue || "Unknown",
            fileName: doc.fields.fileName?.stringValue || "Unknown",
            fileSize: doc.fields.fileSize?.stringValue || "0 MB",
            url: doc.fields.url?.stringValue || "#",
            timestamp: doc.fields.timestamp?.timestampValue || ""
        }));

        uploads.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json({ users, uploads });
    } catch (error) { res.status(500).json({ error: 'Gagal memuat data dari Firebase' }); }
});

// ==========================================
// ENDPOINT 5: ADMIN PANEL - UPDATE USER (BARU)
// ==========================================
app.post('/api/admin/update-user', async (req, res) => {
    try {
        const { username, password, targetUserId, newCoins, newTier } = req.body;
        const validUser = process.env.ADMIN_USER || "admin";
        const validPass = process.env.ADMIN_PASS || "onion2026";

        if (username !== validUser || password !== validPass) return res.status(401).json({ error: 'Akses Ditolak!' });

        const userUrl = `${DB_URL}/telecloud_users/${targetUserId}`;
        await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=tier`, {
            fields: { 
                coins: { integerValue: parseInt(newCoins) },
                tier: { stringValue: newTier }
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Gagal memperbarui user' });
    }
});

module.exports = app;