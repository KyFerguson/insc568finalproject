const fs = require("fs");
const path = require("path");
const http = require("http");

const QUEUE_DIR = path.join(__dirname, "Notification Queue");
const QUEUE_FILE = path.join(QUEUE_DIR, "queue.json");

const EMAIL_HOST = process.env.EMAIL_SERVER_HOST || "localhost";
const EMAIL_PORT = Number(process.env.EMAIL_SERVER_PORT || 2525);

const MAX_ATTEMPTS = 3;

function ensureDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function readQueue() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) {
    return { messages: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return { messages: [] };
  }
}

function writeQueue(data) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function enqueue(notification) {
  const queueData = readQueue();
  const message = {
    messageId: `MSG-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    to: notification.to,
    from: notification.from,
    subject: notification.subject,
    body: notification.body,
    metadata: notification.metadata || {},
  };
  queueData.messages.push(message);
  writeQueue(queueData);
  // eslint-disable-next-line no-console
  console.log(`[NotificationQueue] Queued message ${message.messageId} → ${message.to}`);
  return message;
}

function deliverMessage(message) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      to: message.to,
      from: message.from,
      subject: message.subject,
      body: message.body,
      metadata: message.metadata,
    });

    const req = http.request(
      {
        hostname: EMAIL_HOST,
        port: EMAIL_PORT,
        path: "/mail/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );

    req.on("error", () => resolve(false));
    req.write(payload);
    req.end();
  });
}

async function processQueue() {
  const queueData = readQueue();
  const pending = queueData.messages.filter((m) => m.status === "pending");

  if (pending.length === 0) {
    return;
  }

  let changed = false;

  for (const message of pending) {
    message.attempts += 1;
    const delivered = await deliverMessage(message);

    if (delivered) {
      message.status = "delivered";
      message.deliveredAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.log(`[NotificationQueue] Delivered ${message.messageId} → ${message.to}`);
      changed = true;
    } else if (message.attempts >= MAX_ATTEMPTS) {
      message.status = "failed";
      message.failedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.log(`[NotificationQueue] Failed (max attempts) ${message.messageId}`);
      changed = true;
    }
  }

  if (changed) {
    writeQueue(queueData);
  }
}

function startWorker(intervalMs = 5000) {
  setInterval(processQueue, intervalMs);
  // eslint-disable-next-line no-console
  console.log(`[NotificationQueue] Worker started (interval: ${intervalMs}ms)`);
}

function getQueue() {
  return readQueue();
}

module.exports = { enqueue, startWorker, getQueue };
