const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const auth = require('basic-auth');
const dotenv = require('dotenv');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Paths to local scrcpy binaries
const SCRCPY_PATH = path.join(__dirname, 'scrcpy/build-auto/app/scrcpy');
const SCRCPY_SERVER_PATH = path.join(__dirname, 'scrcpy/build-auto/server/scrcpy-server');

// Basic Auth Middleware
const basicAuth = (req, res, next) => {
	const user = auth(req);
	const envUser = process.env.BASIC_AUTH_USER;
	const envPass = process.env.BASIC_AUTH_PASS;

	if (!user || user.name !== envUser || user.pass !== envPass) {
		res.set('WWW-Authenticate', 'Basic realm="Scrcpy Web"');
		return res.status(401).send('Authentication required.');
	}
	next();
};

app.use(basicAuth);
app.use(express.static('public'));
// Serve jmuxer from node_modules
app.use('/libs', express.static(path.join(__dirname, 'node_modules')));

// Helper: Get connected devices from ADB
const getAdbDevices = () => {
	return new Promise((resolve, reject) => {
		exec('adb devices', (err, stdout) => {
			if (err) {
				console.error("Error running adb devices:", err);
				return resolve([]);
			}
			const devices = [];
			const lines = stdout.split('\n');
			// Skip first line "List of devices attached"
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;
				const parts = line.split(/\s+/);
				if (parts.length >= 2 && parts[1] === 'device') {
					devices.push({
						serial: parts[0],
						name: `Device ${parts[0].slice(-4)}` // Default name
					});
				}
			}
			resolve(devices);
		});
	});
};

// Helper: Get phones (from file or auto-fill)
const getPhones = async () => {
	const filePath = path.join(__dirname, 'phones.json');
	let devices = [];
	
	if (fs.existsSync(filePath)) {
		try {
			const data = fs.readFileSync(filePath, 'utf8');
			devices = JSON.parse(data);
		} catch (e) {
			console.error("Error reading phones.json:", e);
		}
	}

	// File doesn't exist or failed to read (or empty), try auto-fill
	if (devices.length === 0) {
		devices = await getAdbDevices();
		if (devices.length > 0) {
			try {
				fs.writeFileSync(filePath, JSON.stringify(devices, null, '\t'));
				console.log("Created phones.json with detected devices.");
			} catch (e) {
				console.error("Error creating phones.json:", e);
			}
		}
	}

	// Always ensure Test Device is present
	if (!devices.find(d => d.serial === 'test-device')) {
		devices.push({ serial: 'test-device', name: 'Test Pattern (Source)' });
	}

	return devices;
};

// API to get list of phones
app.get('/api/phones', async (req, res) => {
	const phones = await getPhones();
	res.json(phones);
});

// Socket.io connection
io.on('connection', (socket) => {
	console.log('Client connected');
	let streamProcess = null;
	let currentResolution = { width: 0, height: 0 };

	socket.on('start-stream', async (serial, options = {}) => {
		if (streamProcess) {
			console.log('Killing previous stream');
			streamProcess.kill('SIGTERM');
			streamProcess = null;
		}

		if (!serial) return;

		console.log(`Starting stream for ${serial} with options:`, options);
		
		// Test Stream Logic
		if (serial === 'test-device') {
			currentResolution = { width: 1280, height: 720 };
			console.log("Starting Test Stream (ffmpeg)");
			
			const args = [
				'-re',
				'-i', 'test.h264',
				'-c', 'copy',
				'-f', 'h264',
				'-'
			];
			streamProcess = spawn('ffmpeg', args);

			streamProcess.stdout.on('data', (data) => {
				socket.emit('video-data', data);
			});
			
			streamProcess.on('close', (code) => {
				console.log(`Test stream exited with code ${code}`);
				socket.emit('stream-stopped', { code });
			});
			return;
		}

		// Auto-wake the device
		exec(`adb -s ${serial} shell input keyevent 224`);

		// Fetch device resolution (Promise wrapper)
		const fetchResolution = () => new Promise((resolve) => {
			exec(`adb -s ${serial} shell wm size`, (err, stdout) => {
				if (!err && stdout) {
					const match = stdout.match(/Physical size: (\d+)x(\d+)/);
					if (match) {
						resolve({ width: parseInt(match[1]), height: parseInt(match[2]) });
						return;
					}
				}
				resolve(null);
			});
		});

		const resolution = await fetchResolution();
		if (resolution) {
			currentResolution = resolution;
			console.log(`Device ${serial} resolution: ${currentResolution.width}x${currentResolution.height}`);
		}

		try {
			// Use local 'scrcpy' -> FIFO -> 'ffmpeg' pipeline
			// This avoids stdout pollution from scrcpy/adb which corrupts the stream if piped directly
			const bitrate = options.bitrate || 2000000;
			const maxSize = options.maxSize || 0;
			
			// Create FIFO with unique ID to avoid collisions
			const sessionId = Date.now().toString().slice(-6);
			const fifoPath = path.join('/tmp', `scrcpy_${serial}_${sessionId}.mkv`);
			
			try {
				if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
				require('child_process').execSync(`mkfifo ${fifoPath}`);
			} catch (e) {
				console.error(`Failed to create FIFO:`, e);
				return;
			}

			const scrcpyArgs = [
				'-s', serial,
				'--no-audio',
				'--no-window',
				`--record=${fifoPath}`,
				'--record-format=mkv',
				'--video-bit-rate', String(bitrate),
				'--video-codec-options=profile=1' // Force Baseline profile for browser compatibility
			];

			if (maxSize > 0) {
				scrcpyArgs.push('--max-size', String(maxSize));
			}

			console.log(`Spawning scrcpy at ${SCRCPY_PATH} with args: ${scrcpyArgs.join(' ')}`);
			
			const scrcpyProcess = spawn(SCRCPY_PATH, scrcpyArgs, {
				env: {
					...process.env,
					SCRCPY_SERVER_PATH: SCRCPY_SERVER_PATH,
					XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/tmp'
				}
			});

			const ffmpegArgs = [
				'-i', fifoPath,
				'-c:v', 'copy',
				'-bsf:v', 'h264_mp4toannexb', // Convert to Annex B for jmuxer
				'-f', 'h264',
				'-'
			];
			console.log(`Spawning ffmpeg pipeline...`);
			const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

			// Read ffmpeg stdout -> send to socket
			ffmpegProcess.stdout.on('data', (data) => {
				socket.emit('video-data', data);
			});

			// Error handling
			scrcpyProcess.stderr.on('data', (data) => {
				console.error(`[scrcpy stderr]:`, data.toString().trim());
			});
			
			// Cleanup function
			const cleanup = () => {
				console.log(`Cleaning up stream processes...`);
				try {
					scrcpyProcess.kill('SIGTERM');
					ffmpegProcess.kill('SIGTERM');
				} catch (e) { /* ignore */ }
				
				// Remove FIFO
				try {
					if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
				} catch (e) { console.error(`Error removing FIFO:`, e); }
			};

			scrcpyProcess.on('close', (code) => {
				console.log(`scrcpy process exited with code ${code}`);
				cleanup();
				socket.emit('stream-stopped', { code });
			});

			ffmpegProcess.on('close', (code) => {
				console.log(`ffmpeg process exited with code ${code}`);
				if (code !== 0 && code !== null) cleanup();
			});
			
			streamProcess = {
				kill: (signal) => {
					cleanup();
				}
			};

		} catch (e) {
			console.error("Error spawning stream:", e);
		}
	});

	socket.on('control-key', (data) => {
		const { serial, keycode } = data;
		if (serial && keycode) {
			console.log(`Sending key ${keycode} to ${serial}`);
			exec(`adb -s ${serial} shell input keyevent ${keycode}`);
		}
	});

	socket.on('touch-tap', (data) => {
		const { serial, x, y } = data; // x, y are normalized 0.0-1.0
		if (serial && currentResolution.width > 0) {
			const realX = Math.round(x * currentResolution.width);
			const realY = Math.round(y * currentResolution.height);
			exec(`adb -s ${serial} shell input tap ${realX} ${realY}`);
		}
	});

	socket.on('control-scroll', (data) => {
		const { serial, direction } = data;
		if (serial) {
			const width = currentResolution.width || 1080;
			const height = currentResolution.height || 1920;
			const x = Math.round(width / 2);
			const yCenter = Math.round(height / 2);
			const scrollDist = Math.round(height * 0.2); // 20% screen height

			let yStart, yEnd;
			if (direction === 'down') {
				// Scroll down -> Swipe Up (drag content up)
				yStart = yCenter + Math.round(scrollDist / 2);
				yEnd = yCenter - Math.round(scrollDist / 2);
			} else {
				// Scroll up -> Swipe Down (drag content down)
				yStart = yCenter - Math.round(scrollDist / 2);
				yEnd = yCenter + Math.round(scrollDist / 2);
			}

			// Fast swipe for scroll (100ms)
			exec(`adb -s ${serial} shell input swipe ${x} ${yStart} ${x} ${yEnd} 100`);
		}
	});

	socket.on('control-swipe-up', (data) => {
		const { serial } = data;
		if (serial) {
			const width = currentResolution.width || 1080;
			const height = currentResolution.height || 1920;
			
			const x = Math.round(width / 2);
			// Taller swipe: 90% -> 10%
			const yStart = Math.round(height * 0.9);
			const yEnd = Math.round(height * 0.1);
			
			console.log(`Swiping up on ${serial}: ${x},${yStart} -> ${x},${yEnd}`);
			// Slower duration: 1000ms
			exec(`adb -s ${serial} shell input swipe ${x} ${yStart} ${x} ${yEnd} 1000`);
		}
	});

	socket.on('disconnect', () => {
		console.log('Client disconnected');
		if (streamProcess) {
			streamProcess.kill('SIGTERM');
		}
	});
});

const PORT = process.env.PORT || 8558;
server.listen(PORT, () => {
	console.log(`Server listening on port ${PORT}`);
	getAdbDevices().then(devices => {
		console.log("Currently connected ADB devices:", devices.map(d => d.serial).join(', '));
	});
});