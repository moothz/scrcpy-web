const socket = io();
let jmuxer = null;
let currentSerial = null;

const tabsContainer = document.getElementById('tabs-container');
const statusMessage = document.getElementById('status-message');
const player = document.getElementById('player');
const videoWrapper = document.getElementById('video-wrapper');

// Fetch phones and render tabs
async function loadPhones() {
    try {
        const res = await fetch('/api/phones');
        const phones = await res.json();
        renderTabs(phones);
        if (phones.length > 0) {
            // Optional: Auto-select first phone?
            // selectPhone(phones[0].serial);
        } else {
            statusMessage.textContent = "No devices found in phones.json (or via adb)";
        }
    } catch (e) {
        console.error("Failed to load phones", e);
    }
}

function renderTabs(phones) {
    tabsContainer.innerHTML = '';
    phones.forEach(phone => {
        const tab = document.createElement('div');
        tab.className = 'device-tab';
        tab.textContent = phone.name || phone.serial;
        tab.dataset.serial = phone.serial;
        tab.onclick = () => selectPhone(phone.serial, tab);
        tabsContainer.appendChild(tab);
    });
}

function selectPhone(serial, tabElement) {
    if (currentSerial === serial) return;
    currentSerial = serial;

    // Update UI
    document.querySelectorAll('.device-tab').forEach(t => t.classList.remove('active'));
    if (tabElement) tabElement.classList.add('active');
    
    // Apply blur/darken effect immediately
    videoWrapper.classList.add('stream-loading');
    statusMessage.textContent = "Connecting to " + serial + "...";
    statusMessage.style.display = 'block';
    
    // Init JMuxer if not exists
    if (!jmuxer) {
        jmuxer = new JMuxer({
            node: 'player',
            mode: 'video',
            flushingTime: 0, // Low latency
            fps: 30,
            debug: false
        });
    } else {
        jmuxer.clearBuffer();
    }

    // Get settings
    const bitrate = document.getElementById('bitrate-slider').value * 1000000; // Mbps to bps
    const audio = document.getElementById('audio-toggle').checked;
    const maxSize = parseInt(document.getElementById('resolution-select').value, 10);

    // Start stream
    socket.emit('start-stream', serial, { bitrate, audio, maxSize });
}

// Handle Touch/Click on Video
player.addEventListener('mousedown', (e) => {
    if (!currentSerial) return;
    
    const rect = player.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    
    socket.emit('touch-tap', {
        serial: currentSerial,
        x: x,
        y: y
    });
});

// Handle Scroll (Mouse Wheel)
player.addEventListener('wheel', (e) => {
    if (!currentSerial) return;
    e.preventDefault(); // Prevent page scroll

    // deltaY > 0 is scrolling down (content moves up)
    // deltaY < 0 is scrolling up (content moves down)
    
    socket.emit('control-scroll', {
        serial: currentSerial,
        direction: e.deltaY > 0 ? 'down' : 'up'
    });
}, { passive: false });

// Settings Listeners
const bitrateSlider = document.getElementById('bitrate-slider');
const bitrateValue = document.getElementById('bitrate-value');
const audioToggle = document.getElementById('audio-toggle');
const resolutionSelect = document.getElementById('resolution-select');

bitrateSlider.addEventListener('input', () => {
    bitrateValue.textContent = bitrateSlider.value;
});

// Restart stream on setting change (debounce could be nice, but change is fine)
const updateStreamSettings = () => {
    if (currentSerial) {
        // Re-trigger stream start with new settings
        console.log("Updating stream settings...");
        videoWrapper.classList.add('stream-loading');
        if (jmuxer) jmuxer.clearBuffer();
        
        const bitrate = bitrateSlider.value * 1000000;
        const audio = audioToggle.checked;
        const maxSize = parseInt(resolutionSelect.value, 10);
        socket.emit('start-stream', currentSerial, { bitrate, audio, maxSize });
    }
};

bitrateSlider.addEventListener('change', updateStreamSettings);
audioToggle.addEventListener('change', updateStreamSettings);
resolutionSelect.addEventListener('change', updateStreamSettings);

// Socket events
socket.on('video-data', (data) => {
    // data is ArrayBuffer or Buffer
    statusMessage.style.display = 'none';
    
    // Remove blur effect when we get data
    videoWrapper.classList.remove('stream-loading');
    
    if (jmuxer) {
        jmuxer.feed({
            video: new Uint8Array(data)
        });
    }
});

socket.on('stream-stopped', () => {
    statusMessage.textContent = "Stream stopped.";
    statusMessage.style.display = 'block';
    videoWrapper.classList.add('stream-loading');
});

socket.on('stream-error', (data) => {
    statusMessage.textContent = "Error: " + data.message;
    statusMessage.style.display = 'block';
});

// Controls
document.querySelectorAll('.control-btn').forEach(btn => {
    if (btn.id === 'btn-swipe-up' || btn.id === 'btn-reconnect') return; // Handled separately
    btn.addEventListener('click', () => {
        if (!currentSerial) return alert("Select a device first");
        const key = btn.dataset.key;
        socket.emit('control-key', { serial: currentSerial, keycode: key });
    });
});

// Swipe Up Button
document.getElementById('btn-swipe-up').addEventListener('click', () => {
    if (!currentSerial) return alert("Select a device first");
    socket.emit('control-swipe-up', { serial: currentSerial });
});

// Reconnect Button
document.getElementById('btn-reconnect').addEventListener('click', () => {
    if (!currentSerial) return alert("Select a device first");
    console.log("Requesting stream reconnect...");
    
    // Visual feedback
    videoWrapper.classList.add('stream-loading');
    statusMessage.textContent = "Reconnecting...";
    statusMessage.style.display = 'block';
    
    if (jmuxer) jmuxer.clearBuffer();
    
    socket.emit('start-stream', currentSerial);
});

// Initialize
loadPhones();
