const io = require('socket.io-client');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 8558;
const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASS;
const SERIAL = 'D3VC53R14L2';

console.log(`Connecting to http://localhost:${PORT} as ${USER}...`);

const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const socket = io(`http://localhost:${PORT}`, {
    extraHeaders: {
        Authorization: authHeader
    }
});

socket.on('connect', () => {
    console.log('Connected! Socket ID:', socket.id);
    
    console.log(`Requesting stream for ${SERIAL}...`);
    socket.emit('start-stream', SERIAL, { 
        bitrate: 2000000, 
        audio: false, 
        maxSize: 720 
    });
});

socket.on('connect_error', (err) => {
    console.error('Connection Error:', err.message);
});

const fs = require('fs');
const path = require('path');
const fileName = `stream_${SERIAL}_${Date.now()}.h264`;
const filePath = path.join(__dirname, 'test', fileName);
const fileStream = fs.createWriteStream(filePath);

console.log(`Saving stream to: ${filePath}`);

let bytesReceived = 0;
let lastLog = Date.now();

socket.on('video-data', (data) => {
    bytesReceived += data.length;
    fileStream.write(Buffer.from(data));
    
    const now = Date.now();
    if (now - lastLog > 1000) {
        console.log(`Receiving video data... Total bytes: ${bytesReceived}`);
        lastLog = now;
    }
});

socket.on('stream-stopped', (data) => {
    console.log('Stream stopped!', data);
    process.exit(0);
});

socket.on('stream-error', (data) => {
    console.error('Stream error:', data);
    process.exit(1);
});

socket.on('disconnect', () => {
    console.log('Disconnected.');
});

setTimeout(() => {
    console.log('Test timeout. Exiting.');
    if (bytesReceived > 0) {
        console.log('SUCCESS: Received data.');
    } else {
        console.log('FAILURE: No data received.');
    }
    socket.disconnect();
    process.exit(bytesReceived > 0 ? 0 : 1);
}, 30000);
