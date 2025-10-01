require('dotenv').config();
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, Collection, REST, Routes, Partials } = require('discord.js');
const { format } = require('util');
const express = require('express');
const session = require('express-session');
const { fetch } = require('undici');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const config = require('./config');
const commands = require('./commands');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    rest: {
        timeout: 30000
    }
});

// --- Lightweight Dashboard (Express) ---
const app = express();
const DASHBOARD_PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3001;
const WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL;
let CURRENT_PASS = process.env.DASHBOARD_PASS;
let FORGOT_CODE = null; // last generated verification code
let FORGOT_EXPIRES = 0; // timestamp ms

// Global logs webhook - pretty logging to Discord
const LOGS_WEBHOOK_URL = process.env.LOGS_WEBHOOK_URL;
const LOGS_WEBHOOK_NAME = 'Spidey Bot • Logs';
const LOG_LEVEL_COLOR = {
    DEBUG: 0x60a5fa,
    INFO: 0x10b981,
    WARN: 0xf59e0b,
    ERROR: 0xef4444
};

let logBuffer = [];
let lastFlushAt = Date.now();
const MAX_LINES_PER_FLUSH = 10;
const FLUSH_INTERVAL_MS = 2000;

async function sendLogsEmbed(lines, level) {
    try {
        if (!LOGS_WEBHOOK_URL) return;
        const description = '```ansi\n' + lines.join('\n').slice(0, 1900) + '\n```';
        await fetch(LOGS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: LOGS_WEBHOOK_NAME,
                allowed_mentions: { parse: [] },
                embeds: [{
                    title: `${level} Logs` ,
                    description,
                    color: LOG_LEVEL_COLOR[level] || LOG_LEVEL_COLOR.INFO,
                    timestamp: new Date().toISOString()
                }]
            })
        }).catch(() => {});
    } catch (_) {}
}

function flushLogs(forceLevel) {
    if (logBuffer.length === 0) return;
    const level = forceLevel || (logBuffer.find(l => l.level === 'ERROR') ? 'ERROR' : 'INFO');
    const lines = logBuffer.splice(0, MAX_LINES_PER_FLUSH).map(l => l.text);
    lastFlushAt = Date.now();
    sendLogsEmbed(lines, level);
}

setInterval(() => {
    if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) flushLogs();
}, FLUSH_INTERVAL_MS);

(function patchConsoleForWebhookLogs(){
    if (!LOGS_WEBHOOK_URL) return;
    const original = {
        log: console.log.bind(console),
        info: console.info ? console.info.bind(console) : console.log.bind(console),
        warn: console.warn ? console.warn.bind(console) : console.log.bind(console),
        error: console.error ? console.error.bind(console) : console.log.bind(console),
        debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
    };

    function handle(level, args) {
        try {
            const text = format.apply(null, args);
            logBuffer.push({ level, text: `[${new Date().toLocaleTimeString()}] ${text}` });
            if (logBuffer.length >= MAX_LINES_PER_FLUSH) flushLogs(level);
        } catch (_) {}
    }

    console.log = (...args) => { original.log(...args); handle('INFO', args); };
    console.info = (...args) => { original.info(...args); handle('INFO', args); };
    console.warn = (...args) => { original.warn(...args); handle('WARN', args); };
    console.error = (...args) => { original.error(...args); handle('ERROR', args); };
    console.debug = (...args) => { original.debug(...args); handle('DEBUG', args); };
})();

app.use(express.urlencoded({ extended: false }));
app.use(session({
	secret: process.env.SESSION_SECRET || 'change_this_secret',
	resave: false,
	saveUninitialized: false,
	cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

// Serve static images from /picture
app.use('/picture', express.static(path.join(__dirname, 'picture')));

function requireAuth(req, res, next) {
	if (req.session && req.session.authenticated) return next();
	return res.redirect('/login');
}

function getBotStatus() {
	const isReady = !!client?.user;
	const uptimeMs = isReady ? (client.uptime || 0) : 0;
	const guilds = isReady ? client.guilds.cache.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount })).slice(0, 50) : [];
	const commandsCount = isReady && client.commands ? client.commands.size : 0;
	const reactionRolesCount = isReady && client.reactionRoles ? client.reactionRoles.size : 0;
	const voiceConnected = !!(isReady && client?.voice?.adapters?.size);
	const processUptimeMs = Math.round(process.uptime() * 1000);
	const memory = process.memoryUsage();
	return {
		online: isReady,
		botId: client?.user?.id || null,
		botTag: client?.user?.tag || null,
		uptimeMs,
		guildCount: isReady ? client.guilds.cache.size : 0,
		guilds,
		restPingMs: client?.rest?.ping ?? null,
		node: process.version,
		commandsCount,
		reactionRolesCount,
		voiceConnected,
		processUptimeMs,
		memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal }
	};
}

function getVoiceMembers() {
    const result = [];
    if (!client || !client.guilds) return result;
    for (const [, guild] of client.guilds.cache) {
        // Iterate voice channels (type 2 or 13)
        const channels = guild.channels.cache.filter(c => c && (c.type === 2 || c.type === 13));
        for (const [, ch] of channels) {
            const members = ch.members || new Map();
            for (const [, member] of members) {
                if (!member?.user) continue;
                result.push({
                    guildId: guild.id,
                    guildName: guild.name,
                    channelId: ch.id,
                    channelName: ch.name,
                    userId: member.user.id,
                    userTag: member.user.tag
                });
            }
        }
    }
    return result;
}

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Login page (password only)
app.get('/login', (req, res) => {
	if (req.session && req.session.authenticated) return res.redirect('/');
	const html = `<!doctype html>
	<html lang="fa"><head>
	<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="icon" href="/picture/d482808c-8efe-49d4-b535-cc8f054d18b9.png" />
	<title>Login • Bot Dashboard</title>
	<style>
	body{font-family:system-ui,-apple-system,Segoe UI,Roboto;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
	.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px;min-width:320px;width:90%;max-width:380px}
	.h{margin:0 0 12px 0;font-size:20px}
	.label{display:block;margin:12px 0 6px 0}
	.input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#e5e7eb}
	.btn{margin-top:16px;width:100%;padding:10px 12px;border-radius:8px;border:0;background:#2563eb;color:white;cursor:pointer}
	.a{display:inline-block;margin-top:12px;color:#93c5fd;text-decoration:none}
	.err{color:#fca5a5;margin-top:8px;min-height:20px}
	</style>
	</head><body></body>
		<form class="card" method="post" action="/login">
			<h1 class="h">ورود به داشبورد</h1>
			<label class="label">رمز عبور</label>
			<input class="input" type="password" name="password" placeholder="••••••" />
			<div class="err">${req.query.e ? 'رمز عبور اشتباه است' : ''}</div>
			<button class="btn" type="submit">ورود</button>
			<div><a class="a" href="/forgot">فراموشی رمز عبور؟</a></div>
		</form>
	</body></html>`;
	res.type('html').send(html);
});

app.post('/login', (req, res) => {
	const { password } = req.body || {};
	if (typeof password === 'string' && password === CURRENT_PASS) {
		req.session.authenticated = true;
		return res.redirect('/');
	}
	return res.redirect('/login?e=1');
});

// Logout and require password again
app.get('/logout', (req, res) => {
	try {
		if (req.session) {
			return req.session.destroy(() => res.redirect('/login'));
		}
	} catch (_) {}
	return res.redirect('/login');
});

// Forgot password: send a 6-digit code to webhook and show form
app.get('/forgot', async (_req, res) => {
	function generateCode() {
		return Math.floor(100000 + Math.random() * 900000).toString();
	}
	FORGOT_CODE = generateCode();
	FORGOT_EXPIRES = Date.now() + 10 * 60 * 1000; // 10 minutes
	try {
		await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: `🔐 Reset code: ${FORGOT_CODE} (valid 10m)` })
		});
	} catch (_) {}

	const html = `<!doctype html>
	<html lang="fa"><head>
	<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="icon" href="/picture/d482808c-8efe-49d4-b535-cc8f054d18b9.png" />
	<title>Forgot Password • Bot Dashboard</title>
	<style>
	body{font-family:system-ui,-apple-system,Segoe UI,Roboto;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
	.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px;min-width:320px;width:90%;max-width:520px}
	.btn{margin-top:16px;padding:10px 12px;border-radius:8px;border:0;background:#2563eb;color:white;cursor:pointer}
	.a{display:inline-block;margin-top:12px;color:#93c5fd;text-decoration:none}
	.p{opacity:.9;line-height:1.8}
	.input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#e5e7eb}
	.label{display:block;margin:12px 0 6px 0}
	.err{color:#fca5a5;margin-top:8px;min-height:20px}
	</style>
	</head><body>
		<form class="card" method="post" action="/forgot">
			<h1 style="margin:0 0 12px 0;font-size:20px">فراموشی رمز عبور</h1>
			<p class="p">کد تأیید به وبهوک ارسال شد. کد را به همراه رمز جدید وارد کنید.</p>
			<label class="label">کد تأیید</label>
			<input class="input" name="code" placeholder="123456" />
			<label class="label">رمز جدید</label>
			<input class="input" type="password" name="newPass" placeholder="رمز جدید" />
			<div class="err">${_req.query.e ? 'کد نامعتبر است یا منقضی شده' : ''}</div>
			<button class="btn" type="submit">تغییر رمز</button>
			<div><a class="a" href="/login">بازگشت به ورود</a></div>
		</form>
	</body></html>`;
	res.type('html').send(html);
});

app.post('/forgot', async (req, res) => {
	const code = (req.body?.code || '').trim();
	const newPass = (req.body?.newPass || '').toString();
	const now = Date.now();
	const valid = code && FORGOT_CODE && code === FORGOT_CODE && now < FORGOT_EXPIRES && newPass.length >= 4;
	if (!valid) return res.redirect('/forgot?e=1');

	CURRENT_PASS = newPass;
	FORGOT_CODE = null;
	FORGOT_EXPIRES = 0;
	try {
		await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: `✅ Dashboard password changed successfully.` })
		});
	} catch (_) {}

	const html = `<!doctype html>
	<html lang="fa"><head>
	<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="icon" href="/picture/d482808c-8efe-49d4-b535-cc8f054d18b9.png" />
	<title>Password Changed • Bot Dashboard</title>
	<style>
	body{font-family:system-ui,-apple-system,Segoe UI,Roboto;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
	.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px;min-width:320px;width:90%;max-width:520px}
	.a{display:inline-block;margin-top:12px;color:#93c5fd;text-decoration:none}
	</style>
	</head><body>
		<div class="card">
			<p>✅ رمز با موفقیت تغییر کرد. لطفاً دوباره وارد شوید.</p>
			<a class="a" href="/login">بازگشت به ورود</a>
		</div>
	</body></html>`;
	res.type('html').send(html);
});

// Protected JSON status
app.get('/status', requireAuth, (_req, res) => {
	res.json(getBotStatus());
});

// Protected dashboard
app.get('/', requireAuth, (_req, res) => {
	const s = getBotStatus();
    const voice = getVoiceMembers();
	const html = `<!doctype html>
	<html lang="fa">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<link rel="icon" href="/picture/d482808c-8efe-49d4-b535-cc8f054d18b9.png" />
		<title>Bot Dashboard</title>
		<style>
			body{font-family:system-ui,-apple-system,Segoe UI,Roboto;max-width:1100px;margin:32px auto;padding:0 16px;background:#0f172a;color:#e2e8f0}
			.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
			.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px}
			.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
			.badge.ok{background:#065f46;color:#ecfdf5}
			.badge.off{background:#7c2d12;color:#ffedd5}
			.small{opacity:.8;font-size:12px}
			table{width:100%;border-collapse:collapse}
			th,td{padding:8px;border-bottom:1px solid #1f2937;text-align:left}
			.btn{padding:8px 12px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;text-decoration:none}
			.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
            .input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#e5e7eb}
            .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
            .submit{margin-top:10px;padding:10px 12px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer}
		</style>
		<meta http-equiv="refresh" content="10" />
	</head>
	<body>
		<div class="header">
			<h1>Bot Dashboard</h1>
			<div>
				<a class="btn" href="/logout">خروج</a>
			</div>
		</div>
		<div class="grid">
			<div class="card">
				<div>وضعیت: <span class="badge ${s.online ? 'ok' : 'off'}">${s.online ? 'ONLINE' : 'OFFLINE'}</span></div>
				<div>Bot: ${s.botTag || '-'} <span class="small">(${s.botId || '-'})</span></div>
				<div>Guilds: ${s.guildCount}</div>
				<div>Commands: ${s.commandsCount}</div>
				<div>Voice Connected: ${s.voiceConnected ? 'Yes' : 'No'}</div>
				<div>Uptime: ${Math.round((s.uptimeMs||0)/1000)}s (proc: ${Math.round((s.processUptimeMs||0)/1000)}s)</div>
				<div>REST Ping: ${s.restPingMs ?? '-'} ms</div>
				<div>CPU Usage: ${(process.cpuUsage().user / 1000000).toFixed(1)}%</div>
				<div>Active Users: ${voice.length}</div>
			</div>
			<div class="card">
				<h3 style="margin-top:0">Memory</h3>
				<div>RSS: ${(s.memory.rss/1024/1024).toFixed(1)} MB</div>
				<div>Heap Used: ${(s.memory.heapUsed/1024/1024).toFixed(1)} MB</div>
				<div>Heap Total: ${(s.memory.heapTotal/1024/1024).toFixed(1)} MB</div>
			</div>
			<div class="card">
				<h3 style="margin-top:0">Server Statistics</h3>
				<div>Total Members: ${s.guilds.reduce((sum, g) => sum + (g.memberCount || 0), 0)}</div>
				<div>Average Members/Guild: ${s.guildCount > 0 ? Math.round(s.guilds.reduce((sum, g) => sum + (g.memberCount || 0), 0) / s.guildCount) : 0}</div>
				<div>Largest Guild: ${s.guilds.length > 0 ? s.guilds.reduce((max, g) => (g.memberCount || 0) > (max.memberCount || 0) ? g : max).name : 'N/A'}</div>
				<div>System Load: ${(process.uptime() / 3600).toFixed(1)}h uptime</div>
			</div>
			<div class="card">
				<h3 style="margin-top:0">Quick Actions</h3>
				<div style="margin-bottom:8px">
					<a class="btn" href="/status" target="_blank">JSON Status</a>
					<a class="btn" href="/healthz" target="_blank">Health Check</a>
				</div>
				<div style="font-size:12px;opacity:0.8">
					Last updated: ${new Date().toLocaleString('fa-IR')}
				</div>
			</div>
			<div class="card">
				<h3 style="margin-top:0">Daily Statistics</h3>
				<div>Commands Used: ${client.dailyStats.commands}</div>
				<div>Messages Sent: ${client.dailyStats.messages}</div>
				<div>Members Joined: ${client.dailyStats.joins}</div>
				<div>Members Left: ${client.dailyStats.leaves}</div>
			</div>
			<div class="card">
				<h3 style="margin-top:0">Top Commands</h3>
				${Array.from(client.commandUsage.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([cmd, count]) => `<div>${cmd}: ${count}</div>`)
					.join('') || '<div>No commands used yet</div>'}
			</div>
		</div>
		<div class="card" style="margin-top:16px">
			<h3 style="margin-top:0">Guilds</h3>
			<table>
				<thead><tr><th>Name</th><th>ID</th><th>Members</th></tr></thead>
				<tbody>
					${(s.guilds||[]).map(g => `<tr><td>${g.name}</td><td>${g.id}</td><td>${g.memberCount||'-'}</td></tr>`).join('')}
				</tbody>
			</table>
		</div>
        <div class="card" style="margin-top:16px">
            <h3 style="margin-top:0">Voice Members (live)</h3>
            <table>
                <thead><tr><th>User Tag</th><th>User ID</th><th>Guild</th><th>Channel</th></tr></thead>
                <tbody>
                    ${voice.length ? voice.map(v => `<tr><td>${v.userTag}</td><td>${v.userId}</td><td>${v.guildName} (${v.guildId})</td><td>${v.channelName} (${v.channelId})</td></tr>`).join('') : '<tr><td colspan="4">—</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="card" style="margin-top:16px">
            <h3 style="margin-top:0">Actions</h3>
            <form method="post" action="/action">
                <input type="hidden" name="type" value="dm" />
                <div class="row">
                    <div>
                        <label>Target User ID</label>
                        <input class="input" name="userId" placeholder="123456789012345678" />
                    </div>
                    <div>
                        <label>Embed Text (optional)</label>
                        <input class="input" name="embedText" placeholder="Embed description" />
                    </div>
                </div>
                <div style="margin-top:8px">
                    <label>Message (optional)</label>
                    <input class="input" name="message" placeholder="Plain text message" />
                </div>
                <button class="submit" type="submit">Send DM</button>
            </form>
            <hr style="border-color:#1f2937;border-width:1px;margin:16px 0" />
            <form method="post" action="/action">
                <input type="hidden" name="type" value="say" />
                <div class="row">
                    <div>
                        <label>Channel ID</label>
                        <input class="input" name="channelId" placeholder="123456789012345678" />
                    </div>
                    <div>
                        <label>Message</label>
                        <input class="input" name="message" placeholder="Text to send" />
                    </div>
                </div>
                <button class="submit" type="submit">Send Message to Channel</button>
            </form>
        </div>
	</body>
	</html>`;
	res.type('html').send(html);
});

// Handle dashboard actions
app.post('/action', requireAuth, async (req, res) => {
    try {
        const type = (req.body?.type || '').toString();
        if (type === 'dm') {
            const userId = (req.body?.userId || '').trim();
            const message = (req.body?.message || '').trim();
            const embedText = (req.body?.embedText || '').trim();
            if (!/^\d{5,}$/.test(userId)) throw new Error('Invalid userId');
            const user = await client.users.fetch(userId);
            if (!user) throw new Error('User not found');
            const payload = {};
            if (message) payload.content = message;
            if (embedText) payload.embeds = [{ description: embedText, color: 0x3498db }];
            if (!payload.content && !payload.embeds) throw new Error('Empty message');
            await user.send(payload);
            return res.redirect('/?ok=dm');
        }
        if (type === 'say') {
            const channelId = (req.body?.channelId || '').trim();
            const message = (req.body?.message || '').trim();
            if (!/^\d{5,}$/.test(channelId)) throw new Error('Invalid channelId');
            if (!message) throw new Error('Empty message');
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.send) throw new Error('Channel not found or not text');
            await channel.send({ content: message });
            return res.redirect('/?ok=say');
        }
        throw new Error('Unknown action');
    } catch (e) {
        console.error('Action error:', e?.message || e);
        return res.redirect('/?err=1');
    }
});

const server = app.listen(DASHBOARD_PORT, () => {
	console.log(`🖥️  Dashboard listening on http://localhost:${DASHBOARD_PORT}`);
});

// Create commands collection
client.commands = new Collection();
// In-memory reaction role mappings: messageId => { emojiKey: roleId }
client.reactionRoles = new Map();
// Auto reaction mappings
client.autoReactions = new Map(); // channelId => Set(emojiKeys)
client.autoReactSingle = new Map(); // messageId => Set(emojiKeys)
// Warnings storage: userId => [ { reason, moderatorTag, timestamp } ]
client.warns = new Map();
// Deduplication guards
client.handledGuildMemberAdds = new Set(); // memberId with TTL
client.handledInteractions = new Set(); // interactionId, short TTL
// Command usage tracking
client.commandUsage = new Map(); // commandName => count
client.dailyStats = {
	commands: 0,
	messages: 0,
	joins: 0,
	leaves: 0
};

// Add commands to collection
const commandList = [
    commands.avatarCommand,
    commands.banCommand,
    commands.kickCommand,
    commands.clearCommand,
    commands.warnCommand,
    commands.warn2Command,
    commands.warnlistCommand,
    commands.clearwarnsCommand,
    commands.deletemessageuserCommand,
    commands.remindCommand,
    commands.weatherCommand,
    commands.timeCommand,
    commands.sayCommand,
    commands.serverinfoCommand,
    commands.userinfoCommand,
    commands.helpCommand,
    commands.reactionroleCommand,
    commands.autoreactionCommand,
    commands.sendCommand
];

commandList.forEach(command => {
    client.commands.set(command.data.name, command);
});

// Voice channel the bot should always sit in (by ID)
const VOICE_CHANNEL_ID = '1413929142683963452';

// Helper to update member count channel name (same channel id used as counter name)
const MEMBER_COUNT_CHANNEL_ID = '1413929142683963452';
async function updateMemberCountChannel() {
    try {
        let channel = client.channels.cache.get(MEMBER_COUNT_CHANNEL_ID);
        if (!channel) {
            try { channel = await client.channels.fetch(MEMBER_COUNT_CHANNEL_ID); } catch {}
        }
        if (channel && channel.guild) {
            // Fetch fresh guild data to avoid stale memberCount
            let freshGuild = null;
            try { freshGuild = await channel.guild.fetch(); } catch {}
            const memberCount = (freshGuild && typeof freshGuild.memberCount === 'number')
                ? freshGuild.memberCount
                : channel.guild.memberCount;
            const desiredName = `『👤』𝖬𝖾𝗆𝖻𝖾𝗋: ${memberCount}`;
            if (channel.name !== desiredName) {
                await channel.setName(desiredName);
                console.log(`✅ Updated member count channel name to: ${desiredName}`);
            } else {
                console.log(`ℹ️ Member count channel name already up to date.`);
            }
        } else {
            console.log(`❌ Member count channel ${MEMBER_COUNT_CHANNEL_ID} not found or guild unavailable`);
        }
    } catch (error) {
        console.error('❌ Error updating member count channel name:', error);
    }
}

// Maintain a persistent voice connection to the specified voice channel
let voiceConnection = null;
async function connectToVoiceChannel() {
    try {
        let channel = client.channels.cache.get(VOICE_CHANNEL_ID);
        if (!channel) {
            try { channel = await client.channels.fetch(VOICE_CHANNEL_ID); } catch {}
        }

        // ChannelType.GuildVoice = 2, GuildStageVoice = 13 (avoid importing ChannelType)
        if (!channel || (channel.type !== 2 && channel.type !== 13)) {
            console.log(`❌ Target voice channel ${VOICE_CHANNEL_ID} not found or is not a voice/stage channel`);
            return;
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
        });

        voiceConnection = connection;
        console.log(`✅ Connected to voice channel by ID: ${channel.name}`);

        // Basic resilience: log errors and try to reconnect on disconnect
        connection.on('error', (err) => {
            console.error('❌ Voice connection error:', err?.message || err);
        });

        connection.on('stateChange', (oldState, newState) => {
            if (newState.status === 'disconnected') {
                console.log('⚠️ Voice connection disconnected, attempting to reconnect in 3s...');
                setTimeout(() => { connectToVoiceChannel(); }, 3000);
            }
        });
    } catch (error) {
        console.error('❌ Failed to connect to voice channel:', error?.message || error);
    }
}

// When the client is ready, run this code (only once)
client.once('ready', async () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`🔗 Bot is in ${client.guilds.cache.size} server(s)`);
    console.info('🪵 Webhook logger initialized. Streaming logs to Discord.');
    
    // Initial update + schedule periodic refresh every 5 minutes
    await updateMemberCountChannel();
    setInterval(() => { updateMemberCountChannel(); }, 5 * 60 * 1000);
    
    // Reset daily stats at midnight
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
        client.dailyStats = { commands: 0, messages: 0, joins: 0, leaves: 0 };
        console.log('📊 Daily statistics reset');
        
        // Schedule next reset for 24 hours later
        setInterval(() => {
            client.dailyStats = { commands: 0, messages: 0, joins: 0, leaves: 0 };
            console.log('📊 Daily statistics reset');
        }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    // Ensure the bot sits in the specified voice channel by ID
    setTimeout(() => { connectToVoiceChannel(); }, 3000);

    // Reaction-role disabled per new requirement; using auto-role on member join instead

    // Register slash commands
    try {
        console.log('🔄 Registering slash commands...');
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN || config.botToken);
        
        const commandsData = commandList.map(command => command.data.toJSON());
        
        // Register commands globally
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commandsData }
        );
        
        console.log(`✅ Successfully registered ${commandsData.length} slash commands globally!`);
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
    
    // (legacy join removed; using connectToVoiceChannel above)
});

// Backfill helper: assign role to users who already reacted on a message
async function backfillReactionRole(guildId, channelId, messageId, emojiKey, roleId) {
    try {
        // Validate guild presence
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;

        // Ensure bot has required perms
        const me = guild.members.me || await guild.members.fetch(client.user.id).catch(() => null);
        if (!me || !me.permissions.has('ManageRoles')) return;

        // Fetch target message
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.messages) return;
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return;

        // Find the reaction object for the emoji
        const reaction = message.reactions.cache.find(r => (r.emoji.id ? r.emoji.id : r.emoji.name) === emojiKey);
        if (!reaction) return;

        // Fetch users who reacted
        // Note: fetch() paginates under the hood
        const users = await reaction.users.fetch({ limit: 100 });
        for (const [, user] of users) {
            if (user.bot) continue;
            try {
                const member = await guild.members.fetch(user.id);
                if (!member.roles.cache.has(roleId)) {
                    await member.roles.add(roleId, 'Startup reaction-role backfill for ✅');
                }
            } catch (_) {}
        }
    } catch (error) {
        console.error('❌ Error during reaction-role backfill:', error);
    }
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Dedup: ignore if we already handled this interaction id
    if (client.handledInteractions.has(interaction.id)) return;
    client.handledInteractions.add(interaction.id);
    setTimeout(() => client.handledInteractions.delete(interaction.id), 5 * 60 * 1000);

    const command = client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`❌ No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        // Track command usage
        const currentCount = client.commandUsage.get(interaction.commandName) || 0;
        client.commandUsage.set(interaction.commandName, currentCount + 1);
        client.dailyStats.commands++;
        
        await command.execute(interaction);
        console.log(`✅ Command ${interaction.commandName} executed by ${interaction.user.tag}`);
    } catch (error) {
        console.error(`❌ Error executing command ${interaction.commandName}:`, error);
        
        const errorMessage = {
            content: '❌ خطا در اجرای دستور!',
            ephemeral: true
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
});

// Reaction add handler for reaction roles
client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;

        // Ensure partials are resolved
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        const message = reaction.message;
        const guild = message.guild;
        if (!guild) return;

        const mapping = client.reactionRoles.get(message.id);
        if (!mapping) return;

        // Normalize emoji key
        const emoji = reaction.emoji;
        const emojiKey = emoji.id ? emoji.id : emoji.name;
        const roleId = mapping[emojiKey];
        if (!roleId) return;

        try {
            const member = await guild.members.fetch(user.id);
            if (!member.roles.cache.has(roleId)) {
                await member.roles.add(roleId, 'Reaction role assignment');
            }
        } catch (e) {
            // ignore per-user failures
        }
    } catch (error) {
        console.error('❌ Error in messageReactionAdd handler:', error);
    }
});

// Reaction remove handler to remove roles upon unreact
client.on('messageReactionRemove', async (reaction, user) => {
    try {
        if (user.bot) return;

        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        const message = reaction.message;
        const guild = message.guild;
        if (!guild) return;

        const mapping = client.reactionRoles.get(message.id);
        if (!mapping) return;

        const emoji = reaction.emoji;
        const emojiKey = emoji.id ? emoji.id : emoji.name;
        const roleId = mapping[emojiKey];
        if (!roleId) return;

        try {
            const member = await guild.members.fetch(user.id);
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId, 'Reaction role removed on unreact');
            }
        } catch (e) {
            // ignore per-user failures
        }
    } catch (error) {
        console.error('❌ Error in messageReactionRemove handler:', error);
    }
});

// Auto-react on new messages in configured channels
client.on('messageCreate', async (message) => {
    try {
        if (message.author?.bot) return;
        
        // Track message count
        client.dailyStats.messages++;
        
        const set = client.autoReactions.get(message.channelId);
        if (!set || set.size === 0) return;
        for (const emojiKey of set) {
            try { await message.react(emojiKey); } catch {}
        }
    } catch (error) {
        console.error('❌ Error in messageCreate auto-reaction:', error);
    }
});

// Ensure single-message auto reactions persist if removed
client.on('messageReactionRemove', async (reaction, user) => {
    try {
        // Re-apply auto reactions configured for a single message
        if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
        const message = reaction.message;
        const set = client.autoReactSingle.get(message.id);
        if (!set || set.size === 0) return;
        const emojiKey = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
        if (set.has(emojiKey)) {
            try { await message.react(emojiKey); } catch {}
        }
    } catch (error) {
        // silent
    }
});

// Voice state update handler
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const voiceChannelId = '1421971081052422265'; // ویس چنل مورد نظر
        const targetUserId = '995631414907244646'; // کاربری که باید پیام بگیره

        // Ignore bot updates to avoid spam
        if (newState.member?.user?.bot) return;
        
        // Check if someone joined the specific voice channel
        if (newState.channelId === voiceChannelId && oldState.channelId !== voiceChannelId) {
            console.log(`🎤 ${newState.member.user.tag} joined target voice channel`);
            
            try {
                // Send message to the person who joined
                const welcomeMessage = `🎤 **خوش اومدی به ویس!**\n\n` +
                                     `**منتظر باش تا موو بدن** 🎵\n\n` +
                                     `**چنل:** ${newState.channel.name}\n` +
                                     `**زمان:** <t:${Math.floor(Date.now() / 1000)}:F>`;
                
                await newState.member.send(welcomeMessage);
                console.log(`✅ Welcome message sent to ${newState.member.user.tag}`);
                
            } catch (dmError) {
                console.error(`❌ Error sending welcome DM to ${newState.member.user.tag}:`, dmError);
            }
            
            try {
                // Send notification to the target user (music provider)
                const targetUser = await client.users.fetch(targetUserId);
                
                if (targetUser) {
                    const notificationMessage = `🎤 **یکی تو ویس هست که میخواد مووش بدی!**\n\n` +
                                              `**کاربر:** ${newState.member.user.tag}\n` +
                                              `**چنل:** ${newState.channel.name}\n` +
                                              `**زمان:** <t:${Math.floor(Date.now() / 1000)}:F>`;
                    
                    await targetUser.send(notificationMessage);
                    console.log(`✅ Music notification sent to ${targetUser.tag}`);
                } else {
                    console.log(`❌ Target user ${targetUserId} not found`);
                }
            } catch (dmError) {
                console.error(`❌ Error sending music notification:`, dmError);
            }
        }
        
        // Check if someone left the voice channel
        if (oldState.channelId === voiceChannelId && newState.channelId !== voiceChannelId) {
            console.log(`🎤 ${oldState.member.user.tag} left target voice channel`);
        }
        
        // If the bot itself left a voice channel, try to reconnect to the target voice by ID
        if (oldState.member?.id === client.user.id && oldState.channelId && !newState.channelId) {
            setTimeout(() => { connectToVoiceChannel(); }, 2000);
        }
        
    } catch (error) {
        console.error('❌ Error in voice state update:', error);
    }
});

// Listen for new members joining the server
client.on('guildMemberAdd', async (member) => {
    try {
        // Dedup: ensure we welcome only once per member
        if (client.handledGuildMemberAdds.has(member.id)) {
            return;
        }
        client.handledGuildMemberAdds.add(member.id);
        // Auto-expire after 10 minutes (safety)
        setTimeout(() => client.handledGuildMemberAdds.delete(member.id), 10 * 60 * 1000);

        console.log(`👋 New member joined: ${member.user.tag} (${member.user.id})`);
        
        // Track join count
        client.dailyStats.joins++;
        
        try {
            // Change nickname to ! name (no parentheses) when joining server
            const displayName = member.displayName; // Nickname if set, else username
            const newNickname = `! ${displayName}`;

            await member.setNickname(newNickname, 'New member joined server');
            console.log(`✅ Changed nickname for ${member.user.tag} to: ${newNickname}`);

        } catch (nicknameError) {
            console.error(`❌ Error changing nickname for ${member.user.tag}:`, nicknameError);
        }
        
        // Auto-assign member role on join
        try {
            const autoMemberRoleId = '1413922081049153648';
            const guildMember = await member.guild.members.fetch(member.id).catch(() => null);
            if (guildMember && autoMemberRoleId && !guildMember.roles.cache.has(autoMemberRoleId)) {
                await guildMember.roles.add(autoMemberRoleId, 'Auto-assign member role on join');
                console.log(`✅ Assigned member role (${autoMemberRoleId}) to ${member.user.tag}`);
            }
        } catch (roleErr) {
            console.error('❌ Failed to auto-assign member role:', roleErr?.message || roleErr);
        }

        // Update member counter immediately on join
        updateMemberCountChannel();

        // Send welcome message to welcome channel
        await sendWelcomeChannelMessage(member);
        
        // Send DM to the new member
        await sendWelcomeDM(member);
        
    } catch (error) {
        console.error('❌ Error handling new member:', error);
    }
});

// Also update counter when a member leaves
client.on('guildMemberRemove', async (member) => {
    try {
        console.log(`👋 Member left: ${member.user?.tag || member.id}`);
        
        // Track leave count
        client.dailyStats.leaves++;
        
        // Note: We can't restore nickname here because the member is no longer in the server
        // The nickname will be automatically reset when they rejoin
        
        updateMemberCountChannel();
    } catch (error) {
        // silent
    }
});

// Function to send welcome message to the welcome channel
async function sendWelcomeChannelMessage(member) {
    try {
        const welcomeChannel = client.channels.cache.get(config.welcomeChannelId);
        
        if (!welcomeChannel) {
            console.error(`❌ Welcome channel not found with ID: ${config.welcomeChannelId}`);
            return;
        }

		const welcomeMessage = `Welcome to Our server\n${member}`;
		const avatarUrl = member.user.displayAvatarURL({ size: 512 });
		const embed = new EmbedBuilder()
			.setColor(0x2dd4bf)
			.setAuthor({ name: member.user.tag, iconURL: avatarUrl })
			.setImage(avatarUrl);

		await welcomeChannel.send({ content: welcomeMessage, embeds: [embed] });
		console.log(`✅ Welcome message (with avatar) sent to channel for ${member.user.tag}`);
        
    } catch (error) {
        console.error('❌ Error sending welcome channel message:', error);
    }
}

// Function to send DM to new member
async function sendWelcomeDM(member) {
    try {
		const dmMessage = `خوش اومدی🌹 ${member}\n\n` +
					 `قوانین سرور رو میتونی در این چنل ببینی https://discord.com/channels/1410884345161322638/1414313035526574091\n\n` +
					 `و برای دریافت رول های بیشتر میتوانید به این چنل مراجعه کنید .\nhttps://discord.com/channels/1410884345161322638/1415085128971059201`;
        
        await member.send(dmMessage);
        console.log(`✅ Welcome DM sent to ${member.user.tag}`);
        
    } catch (error) {
        console.error('❌ Error sending welcome DM:', error);
        // If DM fails, try to send a message in a general channel as fallback
        try {
            const generalChannel = member.guild.channels.cache.find(channel => 
                channel.type === 0 && channel.permissionsFor(member.guild.members.me).has('SendMessages')
            );
            
            if (generalChannel) {
                await generalChannel.send(`خوش اومدی ${member}! لطفاً پیام خصوصی خود را برای اطلاعات بیشتر بررسی کنید.`);
                console.log(`✅ Fallback welcome message sent to ${generalChannel.name} for ${member.user.tag}`);
            }
        } catch (fallbackError) {
            console.error('❌ Error sending fallback welcome message:', fallbackError);
        }
    }
}

// Handle errors
client.on('error', error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Login to Discord with your client's token
const botToken = process.env.DISCORD_BOT_TOKEN || config.botToken;
if (!botToken) {
    console.error('❌ Bot token not found! Please set DISCORD_BOT_TOKEN in your .env file');
    process.exit(1);
}

console.log('🔑 Bot token loaded successfully');
client.login(botToken);
