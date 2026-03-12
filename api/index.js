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
const TIER_LIMITS = { "Free": 3, "VIP": 10, "VVIP": 20, "VVIP+": 30 };

const getWIBDate = () => {
    const d = new Date(); d.setUTCHours(d.getUTCHours() + 7);
    return d.toISOString().split('T')[0]; 
};

// 1. SINKRONISASI KOIN
app.get('/api/user/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const todayWIB = getWIBDate(); 
        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;
        let coins = 0, isNewDay = false, tier = "Free", resetAmount = 3;

        try {
            const fRes = await axios.get(userUrl);
            const fields = fRes.data.fields;
            const lastLogin = fields.last_login?.stringValue || "";
            coins = parseInt(fields.coins?.integerValue || fields.coins?.doubleValue || 0);
            tier = fields.tier?.stringValue || "Free";
            resetAmount = TIER_LIMITS[tier] || 3;

            if (lastLogin !== todayWIB) {
                coins = resetAmount; isNewDay = true;
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
    } catch (error) { res.status(500).json({ error: 'Gagal sinkronisasi data' }); }
});

// 2. UPLOAD & POTONG KOIN
app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        const clientId = req.body.clientId;
        if (!clientId || !req.file) return res.status(400).json({ error: 'Data tidak valid' });

        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;
        let currentCoins = 0;
        try {
            const fRes = await axios.get(userUrl);
            currentCoins = parseInt(fRes.data.fields.coins?.integerValue || 0);
        } catch (err) { return res.status(403).json({ error: 'OUT_OF_COINS' }); }

        if (currentCoins <= 0) return res.status(403).json({ error: 'OUT_OF_COINS' });

        const mime = req.file.mimetype;
        const originalName = req.file.originalname || 'Unknown_File';
        let endpoint = 'sendDocument', fieldName = 'document';
        if (mime.startsWith('image/') && mime !== 'image/gif') { endpoint = 'sendPhoto'; fieldName = 'photo'; } 
        else if (mime.startsWith('video/')) { endpoint = 'sendVideo'; fieldName = 'video'; } 
        else if (mime === 'image/gif') { endpoint = 'sendAnimation'; fieldName = 'animation'; }

        const form = new FormData();
        form.append('chat_id', CHAT_ID); form.append(fieldName, req.file.buffer, { filename: originalName });
        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/${endpoint}`, form, { headers: form.getHeaders() });
        const result = teleRes.data.result;
        let fileId = endpoint === 'sendPhoto' ? result.photo.pop().file_id : endpoint === 'sendVideo' ? result.video.file_id : endpoint === 'sendAnimation' ? result.animation.file_id : result.document.file_id;
        const customUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/v/${fileId}`;

        await axios.patch(`${userUrl}?updateMask.fieldPaths=coins`, { fields: { coins: { integerValue: currentCoins - 1 } } });
        await axios.post(`${DB_URL}/telecloud_uploads`, {
            fields: { userId: { stringValue: clientId }, fileName: { stringValue: originalName }, fileSize: { stringValue: (req.file.size / (1024 * 1024)).toFixed(2) + " MB" }, url: { stringValue: customUrl }, timestamp: { timestampValue: new Date().toISOString() } }
        });
        res.json({ url: customUrl, remainingCoins: currentCoins - 1 });
    } catch (error) { res.status(500).json({ error: 'Upload gagal' }); }
});

// 3. REDEEM CODE (BARU)
app.post('/api/redeem', async (req, res) => {
    try {
        const { clientId, code } = req.body;
        const upperCode = code.toUpperCase();
        
        // Cek Kode di Database
        const codeRes = await axios.get(`${DB_URL}/telecloud_codes/${upperCode}`);
        const reward = parseInt(codeRes.data.fields.value.integerValue);

        // Ambil Data User
        const userUrl = `${DB_URL}/telecloud_users/${clientId}`;
        const userRes = await axios.get(userUrl);
        let currentCoins = parseInt(userRes.data.fields.coins?.integerValue || 0);
        let redeemedHistory = userRes.data.fields.redeemed?.stringValue || "";

        // Cek apakah user sudah pernah pakai kode ini
        let usedList = redeemedHistory.split(',');
        if (usedList.includes(upperCode)) {
            return res.status(400).json({ error: 'KODE SUDAH PERNAH DIGUNAKAN!' });
        }

        // Tambahkan Koin & Catat Sejarah
        usedList.push(upperCode);
        await axios.patch(`${userUrl}?updateMask.fieldPaths=coins&updateMask.fieldPaths=redeemed`, {
            fields: { coins: { integerValue: currentCoins + reward }, redeemed: { stringValue: usedList.join(',') } }
        });

        res.json({ success: true, newCoins: currentCoins + reward, rewardAmount: reward });
    } catch (err) {
        res.status(400).json({ error: 'KODE TIDAK VALID ATAU EXPIRED!' });
    }
});

// 4. PROXY MEDIA
app.get('/v/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const mediaRes = await axios({ url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${getFile.data.result.file_path}`, method: 'GET', responseType: 'stream' });
        res.setHeader('Content-Type', mediaRes.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        mediaRes.data.pipe(res);
    } catch (error) { res.status(404).send('File tidak ditemukan'); }
});

// ==========================================
// AREA ADMIN PANEL
// ==========================================

// Cek Kredensial
const checkAdmin = (req) => {
    const validUser = process.env.ADMIN_USER || "admin";
    const validPass = process.env.ADMIN_PASS || "onion2026";
    return (req.body.username === validUser && req.body.password === validPass);
};

// Ambil Semua Data Admin
app.post('/api/admin/data', async (req, res) => {
    if (!checkAdmin(req)) return res.status(401).json({ error: 'Akses Ditolak!' });
    try {
        const usersRes = await axios.get(`${DB_URL}/telecloud_users`).catch(()=>({data:{documents:[]}}));
        const users = (usersRes.data.documents || []).map(doc => ({
            id: doc.name.split('/').pop(), coins: parseInt(doc.fields.coins?.integerValue || 0),
            tier: doc.fields.tier?.stringValue || "Free", last_login: doc.fields.last_login?.stringValue || "Unknown"
        }));

        const uploadsRes = await axios.get(`${DB_URL}/telecloud_uploads`).catch(()=>({data:{documents:[]}}));
        const uploads = (uploadsRes.data.documents || []).map(doc => ({
            userId: doc.fields.userId?.stringValue || "?", fileName: doc.fields.fileName?.stringValue || "?",
            fileSize: doc.fields.fileSize?.stringValue || "0 MB", url: doc.fields.url?.stringValue || "#", timestamp: doc.fields.timestamp?.timestampValue || ""
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const codesRes = await axios.get(`${DB_URL}/telecloud_codes`).catch(()=>({data:{documents:[]}}));
        const codes = (codesRes.data.documents || []).map(doc => ({
            id: doc.name.split('/').pop(), value: parseInt(doc.fields.value?.integerValue || 0)
        }));

        res.json({ users, uploads, codes });
    } catch (error) { res.status(500).json({ error: 'Gagal memuat data' }); }
});

// Admin Aksi: Edit User, Hapus User, Buat Kode, Hapus Kode
app.post('/api/admin/action', async (req, res) => {
    if (!checkAdmin(req)) return res.status(401).json({ error: 'Akses Ditolak!' });
    const { action, targetId, newCoins, newTier, codeValue } = req.body;
    try {
        if (action === 'edit_user') {
            await axios.patch(`${DB_URL}/telecloud_users/${targetId}?updateMask.fieldPaths=coins&updateMask.fieldPaths=tier`, {
                fields: { coins: { integerValue: parseInt(newCoins) }, tier: { stringValue: newTier } }
            });
        } else if (action === 'delete_user') {
            await axios.delete(`${DB_URL}/telecloud_users/${targetId}`);
        } else if (action === 'create_code') {
            await axios.patch(`${DB_URL}/telecloud_codes/${targetId}?updateMask.fieldPaths=value`, {
                fields: { value: { integerValue: parseInt(codeValue) } }
            });
        } else if (action === 'delete_code') {
            await axios.delete(`${DB_URL}/telecloud_codes/${targetId}`);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Gagal mengeksekusi aksi' }); }
});

module.exports = app;