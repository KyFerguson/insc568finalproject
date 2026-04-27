const http = require("http");
const fs = require("fs");
const path = require("path");

const EMAIL_PORT = Number(process.env.EMAIL_SERVER_PORT || 2525);
const QUEUE_DIR = path.join(__dirname, "Notification Queue");
const MAILBOX_FILE = path.join(QUEUE_DIR, "mailbox.json");

function ensureDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function readMailbox() {
  ensureDir();
  if (!fs.existsSync(MAILBOX_FILE)) {
    return { emails: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(MAILBOX_FILE, "utf8"));
  } catch {
    return { emails: [] };
  }
}

function writeMailbox(data) {
  fs.writeFileSync(MAILBOX_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  const routePath = String(req.url || "").split("?")[0];

  // Receive an outbound email from the notification queue
  if (req.method === "POST" && routePath === "/mail/send") {
    try {
      const body = await parseBody(req);
      const mailbox = readMailbox();
      const email = {
        emailId: `EMAIL-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        receivedAt: new Date().toISOString(),
        to: body.to || "",
        from: body.from || "",
        subject: body.subject || "",
        body: body.body || "",
        metadata: body.metadata || {},
      };
      mailbox.emails.push(email);
      writeMailbox(mailbox);
      // eslint-disable-next-line no-console
      console.log(`[MockEmailServer] Accepted ${email.emailId} → ${email.to} | ${email.subject}`);
      sendJson(res, 202, { message: "Email accepted for delivery", emailId: email.emailId });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // View all received emails (advisor's inbox)
  if (req.method === "GET" && routePath === "/mail/inbox") {
    sendJson(res, 200, readMailbox());
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

function start() {
  server.listen(EMAIL_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[MockEmailServer] Listening on http://localhost:${EMAIL_PORT}`);
  });
}

module.exports = { start, server };
