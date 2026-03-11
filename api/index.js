const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

// Import Firebase versi Server (Node.js)
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, serverTimestamp } = require('firebase/firestore');

const app = express();
app.use(express.json()); // Agar backend bisa membaca data JSON

const upload = multer({ storage: multer.memoryStorage() });

const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDoy_bQVNbQfb_4v9CK50sip2H3oJsqyjQ",
  authDomain: "onion-cloud-a8d3d.firebaseapp.com",
  projectId: "onion-cloud-a8d3d",
  storageBucket: "onion-cloud-a8d3d.firebasestorage.app",
  messagingSenderId: "847112548109",
  appId: "1:847112548109:web:e17bb0b171f648aac04a44",
  measurementId: "G-N3XT0CV97T"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ==========================================
// ENDPOINT 1: Sinkronisasi Koin (Dipanggil saat web dibuka)
// ==========================================
app.get('/api/user/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const today = new Date().toISOString().split('T')[0];
        const userRef = doc(db, 'telecloud_users', clientId);
        const userSnap = await getDoc(userRef);

        let coins = 0;
        let isNewDay = false;

        if (!userSnap.exists()) {
            // User baru, kasih 3 koin
            coins = 3;
            await setDoc(userRef, { coins: 3, last_login: today, createdAt: serverTimestamp() });
            isNewDay = true;
        } else {
            const data = userSnap.data();
            if (data.last_login !== today) {
                // Sudah ganti hari, reset koin jadi 3
                coins = 3;
                await updateDoc(userRef, { coins: 3, last_login: today });
                isNewDay = true;
            } else {
                // Hari yang sama, gunakan saldo terakhir
                coins = data.coins;
            }
        }
        res.json({ coins, isNewDay });
    } catch (error) {
        console.error("Firebase Auth Error:", error);
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

        // 1. CEK KOIN DI DATABASE (Anti-Hack)
        const userRef = doc(db, 'telecloud_users', clientId);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists() || userSnap.data().coins <= 0) {
            return res.status(403).json({ error: 'OUT_OF_COINS' });
        }

        let currentCoins = userSnap.data().coins;

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

        // 3. SIMPAN RIWAYAT KE FIREBASE & POTONG KOIN
        const currentSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
        
        await addDoc(collection(db, 'telecloud_uploads'), {
            userId: clientId,
            fileName: originalName,
            fileSize: currentSizeMB + " MB",
            url: customUrl,
            timestamp: serverTimestamp()
        });

        await updateDoc(userRef, { coins: currentCoins - 1 });

        // Kembalikan Link URL dan Sisa Koin terbaru ke Frontend
        res.json({ url: customUrl, remainingCoins: currentCoins - 1 });

    } catch (error) {
        console.error(error.response?.data || error.message);
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
        console.error(error);
        res.status(404).send('File tidak ditemukan / sudah dihapus');
    }
});

module.exports = app;