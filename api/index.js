const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// Token diambil dari Vercel Environment Variables
const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ENDPOINT 1: Upload gambar dan kembalikan link custom
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('photo', req.file.buffer, { filename: 'image.jpg' });

        // 1. Upload ke Telegram
        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/sendPhoto`, form, {
            headers: form.getHeaders()
        });

        // 2. Dapatkan File ID
        const fileId = teleRes.data.result.photo.pop().file_id;

        // 3. Buat URL menggunakan domain web Anda (misal: cloud-img.vercel.app/v/12345)
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const customUrl = `${protocol}://${host}/v/${fileId}`;

        res.json({ url: customUrl });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Gagal upload ke storage Telegram' });
    }
});

// ENDPOINT 2: Menampilkan gambar saat link custom dibuka
app.get('/v/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        
        // 1. Dapatkan File Path dari Telegram menggunakan File ID
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;

        // 2. Download gambar dari Telegram dan tampilkan (proxy) ke browser user
        const imageRes = await axios({
            url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`,
            method: 'GET',
            responseType: 'stream'
        });

        // Set header agar browser mengenalinya sebagai gambar JPG
        res.setHeader('Content-Type', 'image/jpeg');
        // Fitur Cache agar gambar loading lebih cepat jika dibuka berkali-kali
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        
        imageRes.data.pipe(res);
    } catch (error) {
        console.error(error);
        res.status(404).send('Gambar tidak ditemukan atau sudah dihapus dari Telegram');
    }
});

module.exports = app;