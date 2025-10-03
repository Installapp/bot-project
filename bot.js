const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log("token:", process.env.DISCORD_BOT_TOKEN ? "✅ find token" : "❌ where is token ?");
// Suppress specific deprecation warning about 'ready' renamed to 'clientReady'
process.on('warning', (warning) => {
    if (
        warning?.name === 'DeprecationWarning' &&
        typeof warning?.message === 'string' &&
        warning.message.includes('ready event has been renamed to clientReady')
    ) {
        return; // ignore this specific warning
    }
    console.warn(warning);
});
const { Client, GatewayIntentBits, EmbedBuilder, Collection, REST, Routes, Partials, AuditLogEvent } = require('discord.js');
const express = require('express');
const session = require('express-session');
const { fetch } = require('undici');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const config = require('./config');
const commands = require('./commands');
const { TicketManager, ticketCommands } = require('./ticket');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    rest: {
        timeout: 30000
    }
});

// --- Log Channels Mapping ---
const LOG_CHANNELS = {
    member: '1413944186058833980',
    message: '1413949703124553848',
    channel: '1413949745935945914',
    nickname: '1413949204090454046',
    role: '1413949370776158380',
    voice: '1413949655099768932',
    ban: '1413949272407146716',
    timeout: '1413960573669871626',
    invite: '1413961019658604678',
    server: '1413949805562036284',
    console: '1422840762466566157',
    fallback: '1415657800557793311'
};

// Console webhook (preferred over channel send if provided)
const CONSOLE_WEBHOOK_URL = 'https://discord.com/api/webhooks/1422840791088500746/JOf0OD8lAo-NC6XBN2IWsaCRPt5dkc0JIYiVjltyQhaiVZ3X4ecPMisPVeleGh3Xu4pw';

const { saveLog } = require('./db');

async function sendLog(guild, type, payload) {
    try {
        const channelId = LOG_CHANNELS[type] || LOG_CHANNELS.fallback;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.send) return;
        const msg = await channel.send(payload);
        // Persist to SQLite
        try {
            const userId = payload?.embeds?.[0]?.data?.author?.name ? null : null;
            const title = payload?.embeds?.[0]?.data?.title || null;
            saveLog({
                type,
                guildId: guild.id,
                channelId,
                userId,
                title,
                payload: payload
            });
        } catch (_) {}
    } catch (_) {}
}

function userLine(user) {
    if (!user) return 'نامشخص';
    return `${user.tag} (<@${user.id}>)`;
}

function withAuthor(author) {
    const e = new EmbedBuilder();
    if (author?.displayAvatarURL) {
        e.setThumbnail(author.displayAvatarURL({ size: 128 }));
    }
    return e;
}

function userDisplay(user, member) {
    if (!user && !member) return 'نامشخص';
    const u = user || member?.user;
    const mention = member ? member.toString() : (u ? `<@${u.id}>` : '—');
    return `${u?.tag || 'نامشخص'} (${mention})`;
}

// --- Console forwarding to Discord ---
const ORIGINAL_CONSOLE = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
let consoleForwarding = false; // disabled: only show logs in console
async function sendConsoleLog(level, message) {
	try {
		if (!consoleForwarding) return;
        const clean = String(message || '').replace(/\s+$/,'').slice(0, 1900);
        if (!clean) return;

        if (CONSOLE_WEBHOOK_URL) {
            // Send via webhook (no need for client ready)
            try {
                await fetch(CONSOLE_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: `\`${level.toUpperCase()}\`\n${clean}` })
                });
                return;
            } catch (_) { /* fallback to channel below */ }
        }

        if (!client?.user) return; // fallback path requires client
        const channelId = LOG_CHANNELS.console;
        if (!channelId) return;
        let ch = client.channels.cache.get(channelId);
        if (!ch) { try { ch = await client.channels.fetch(channelId); } catch { return; } }
        if (!ch || !ch.send) return;
        await ch.send({ content: `\`${level.toUpperCase()}\`\n${clean}` });
	} catch (_) {}
}

const FORWARD_CONSOLE = false; // master switch
if (FORWARD_CONSOLE) {
    for (const [level, fn] of Object.entries(ORIGINAL_CONSOLE)) {
        console[level] = function(...args) {
            try { fn.apply(console, args); } catch(_) {}
            const text = args.map(a => {
                try { return typeof a === 'string' ? a : JSON.stringify(a, null, 2); } catch { return String(a); }
            }).join(' ');
            // prevent recursion when sending
            consoleForwarding = false;
            setTimeout(() => { consoleForwarding = true; }, 0);
            void sendConsoleLog(level, text);
        };
    }
} else {
    // ensure originals
    console.log = ORIGINAL_CONSOLE.log;
    console.error = ORIGINAL_CONSOLE.error;
    console.warn = ORIGINAL_CONSOLE.warn;
    console.info = ORIGINAL_CONSOLE.info;
    console.debug = ORIGINAL_CONSOLE.debug;
}


// --- Lightweight Dashboard (Express) ---
const app = express();
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
const WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1421423052637605950/Ize9qC6PnUcYWbV1zB-SJ06QlU03da8kjUvSD9GrS9gXGzBzd8JDdId-UeeN3eApgtuB';
let CURRENT_PASS = process.env.DASHBOARD_PASS || 'Farzad';
let FORGOT_CODE = null; // last generated verification code
let FORGOT_EXPIRES = 0; // timestamp ms

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
	console.log(`🖥️  Dashboard loaded at this address: http://localhost:${DASHBOARD_PORT}`);
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
// Throttle for console log of online member updates (once per hour)
client.lastOnlineCountConsoleLog = 0;

// --- Anti-Spam Manager ---
class AntiSpamManager {
    constructor(settings) {
        this.settings = settings || { enabled: false };
        this.userIdToWindow = new Map(); // userId => [ { t, content, meta } ]
        this.userIdToScore = new Map(); // userId => { score, last }
    }

    isExempt(message) {
        try {
            if (!this.settings.enabled) return true;
            if (!message?.member || !message?.guild) return true;
            const roleIds = message.member.roles?.cache?.keys ? Array.from(message.member.roles.cache.keys()) : [];
            if (this.settings.exemptRoleIds?.some(id => roleIds.includes(id))) return true;
            if (this.settings.exemptChannelIds?.includes(message.channelId)) return true;
            // بررسی کتگوری چنل برای معافیت تیکت‌ها
            if (this.settings.exemptCategoryIds?.includes(message.channel?.parentId)) return true;
            if (message.member?.permissions?.has?.('Administrator')) return true;
            return false;
        } catch (_) { return false; }
    }

    pushMessage(message) {
        const now = Date.now();
        const meta = this.extractMeta(message);
        const entry = { t: now, content: (message.content || '').trim(), meta };
        const arr = this.userIdToWindow.get(message.author.id) || [];
        arr.push(entry);
        // prune old
        const cutoff = now - (this.settings.windowMs || 7000);
        while (arr.length && arr[0].t < cutoff) arr.shift();
        this.userIdToWindow.set(message.author.id, arr);
        return arr;
    }

    extractMeta(message) {
        const content = (message.content || '');
        const mentions = (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0) + (message.mentions?.everyone ? 1 : 0);
        const links = (content.match(/https?:\/\/\S+/gi) || []).length;
        const emojis = (content.match(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu) || []).length;
        const letters = (content.replace(/[^a-zA-Z\p{L}]/gu, '') || '');
        const caps = (letters.match(/[A-Z\p{Lu}]/gu) || []).length;
        const ratio = letters.length ? caps / letters.length : 0;
        return { mentions, links, emojis, capsRatio: ratio };
    }

    similarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const len = Math.max(a.length, b.length);
        if (len === 0) return 1;
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
        return same / len;
    }

    computeViolations(message, windowEntries) {
        const s = this.settings;
        let score = 0;

        // Rate of messages
        if (windowEntries.length > (s.maxMessages || 6)) score += 2;

        // Duplicates / near-duplicates
        const contents = windowEntries.map(e => e.content).filter(Boolean);
        let dupCount = 0;
        for (let i = 1; i < contents.length; i++) {
            const sim = this.similarity(contents[i], contents[i - 1]);
            if (sim >= 0.9) dupCount++;
        }
        if (dupCount >= (s.maxDuplicates || 3)) score += 2;

        const last = windowEntries[windowEntries.length - 1];
        if (last) {
            if (last.meta.mentions > (s.maxMentionsPerMessage || 5)) score += 2;
            if (last.meta.emojis > (s.maxEmojisPerMessage || 15)) score += 1;
            if (last.meta.capsRatio > (s.maxCapsRatioPerMessage || 0.7) && (last.content || '').length >= 12) score += 1;
        }

        // Links in window
        const linkSum = windowEntries.reduce((acc, e) => acc + e.meta.links, 0);
        if (linkSum > (s.maxLinksPerWindow || 5)) score += 2;

        // Account and server age checks
        const accountAgeOk = Date.now() - (message.author?.createdTimestamp || 0) >= (s.minAccountAgeMs || 0);
        const joinedAt = message.member?.joinedTimestamp || 0;
        const serverAgeOk = Date.now() - joinedAt >= (s.minServerAgeMs || 0);
        if (!accountAgeOk) score += 1;
        if (!serverAgeOk) score += 1;

        return score;
    }

    async applyPunishment(message, totalScore) {
        try {
            const s = this.settings;
            const state = this.userIdToScore.get(message.author.id) || { score: 0, last: 0, step: 0 };
            // decay
            const decay = s.decayMs || 30 * 60 * 1000;
            const now = Date.now();
            const decayedScore = Math.max(0, state.score - Math.floor((now - state.last) / decay));
            const newScore = decayedScore + totalScore;
            state.score = newScore;
            state.last = now;

            // Choose step based on score thresholds
            // threshold: 2 -> warn, 4 -> 10m timeout, 6 -> 1h timeout, 8 -> kick
            const stepIndex = newScore >= 8 ? 3 : newScore >= 6 ? 2 : newScore >= 4 ? 1 : newScore >= 2 ? 0 : -1;
            if (s.stripRolesOnViolation) {
                await this.stripAllRoles(message).catch(() => {});
            }

            // If user is configured to only have roles stripped, skip further punishments
            const onlyStrip = Array.isArray(s.stripOnlyUserIds) && s.stripOnlyUserIds.includes(message.author.id);
            if (!onlyStrip && stepIndex > state.step) {
                state.step = stepIndex;
                this.userIdToScore.set(message.author.id, state);
                const step = s.punishments[stepIndex];
                await this.executeStep(message, step, newScore);
            } else {
                this.userIdToScore.set(message.author.id, state);
            }
        } catch (err) {
            console.error('❌ AntiSpam punishment error:', err?.message || err);
        }
    }

    async executeStep(message, step, score) {
        if (!step) return;
        const reason = `Anti-spam triggered (score=${score})`;
        try {
            switch (step.type) {
                case 'warn':
                    await message.reply({ content: '⚠️ لطفاً از ارسال پیام‌های پشت‌سرهم یا تکراری خودداری کنید.' }).catch(() => {});
                    break;
                case 'timeout': {
                    const ms = step.durationMs || 10 * 60 * 1000;
                    if (message.member?.moderatable) {
                        await message.member.timeout(ms, reason).catch(() => {});
                        await message.reply({ content: `⏳ شما برای ${(ms/60000)|0} دقیقه میوت شدید.` }).catch(() => {});
                    }
                    break;
                }
                case 'kick': {
                    if (message.member?.kickable) {
                        await message.member.kick(reason).catch(() => {});
                    }
                    break;
                }
                default:
                    break;
            }
        } catch (e) {
            console.error('❌ AntiSpam execute step error:', e?.message || e);
        }
    }

    async stripAllRoles(message) {
        try {
            const member = message.member;
            if (!member || !member.manageable) return;
            const me = message.guild?.members?.me;
            if (!me) return;
            const removable = member.roles.cache.filter(r => r.id !== message.guild.id && me.roles.highest.comparePositionTo(r) > 0);
            if (!removable.size) return;
            await member.roles.remove(Array.from(removable.keys()), 'Anti-spam violation: strip roles');
        } catch (e) {
            // ignore
        }
    }
}

const antiSpam = new AntiSpamManager(config.antiSpam);

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
    commands.sendCommand,
    ...ticketCommands
];

commandList.forEach(command => {
    client.commands.set(command.data.name, command);
});

// ایجاد مدیر تیکت
const ticketManager = new TicketManager(client);

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
                const oldName = channel.name;
                await channel.setName(desiredName);
                console.log(`✅ Updated member count channel name to: ${desiredName}`);
                // Log like the screenshot
                try {
                    const embed = new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle('Voice channel name updated')
                        .addFields(
                            { name: 'Name', value: `${desiredName} ( ${oldName} )`, inline: false },
                            { name: 'ID', value: MEMBER_COUNT_CHANNEL_ID, inline: false },
                            { name: 'Previous name', value: oldName, inline: false }
                        )
                        .setTimestamp();
                    await sendLog(channel.guild, 'channel', { embeds: [embed] });
                } catch (_) {}
            }
            // Only log when there's an actual change, not when already up to date
        } else {
            console.log(`❌ Member count channel ${MEMBER_COUNT_CHANNEL_ID} not found or guild unavailable`);
        }
    } catch (error) {
        console.error('❌ Error updating member count channel name:', error);
    }
}

// Helper to update online member count channel name
async function updateOnlineMemberCountChannel() {
    try {
        let channel = client.channels.cache.get(config.onlineMemberCountChannelId);
        if (!channel) {
            try { channel = await client.channels.fetch(config.onlineMemberCountChannelId); } catch {}
        }
        if (channel && channel.guild) {
            // Count online members (status: online, idle, dnd - not offline or invisible)
            const guild = channel.guild;
            let onlineCount = 0;
            
            // Fetch all members to ensure we have presence data (with limit for performance)
            try {
                await guild.members.fetch({ limit: 1000 });
            } catch (e) {
                // Silently ignore this warning as it's not critical
            }
            
            guild.members.cache.forEach(member => {
                if (!member.user.bot && member.presence && 
                    ['online', 'idle', 'dnd'].includes(member.presence.status)) {
                    onlineCount++;
                }
            });
            
            const desiredName = `『👤』𝐎𝐧𝐥𝐢𝐧𝐞 : ${onlineCount}`;
            if (channel.name !== desiredName) {
                await channel.setName(desiredName);
                // Throttle console log to once per hour
                const now = Date.now();
                if (!client.lastOnlineCountConsoleLog || now - client.lastOnlineCountConsoleLog >= 60 * 60 * 1000) {
                    client.lastOnlineCountConsoleLog = now;
                    console.log(`✅ Updated online member count channel name to: ${desiredName}`);
                }
            }
            // Only log when there's an actual change, not when already up to date
        } else {
            console.log(`❌ Online member count channel ${config.onlineMemberCountChannelId} not found or guild unavailable`);
        }
    } catch (error) {
        console.error('❌ Error updating online member count channel name:', error);
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
client.once('clientReady', async () => {
	console.log(`✅ Bot started successfully. ${client.user.tag}`);
    console.log(`🔗 Bot is in ${client.guilds.cache.size} server(s)`);
    
    // Initial update + schedule periodic refresh every 5 minutes (with timeout)
    console.log('🔄 Updating member count channels...');
    setTimeout(async () => {
        try {
            await updateMemberCountChannel();
            console.log('✅ Member count channel updated');
        } catch (error) {
            console.error('❌ Error in member count update:', error);
        }
    }, 2000);
    
    setTimeout(async () => {
        try {
            await updateOnlineMemberCountChannel();
            console.log('✅ Online member count channel updated');
        } catch (error) {
            console.error('❌ Error in online member count update:', error);
        }
    }, 5000);
    
    setInterval(() => { 
        updateMemberCountChannel().catch(e => console.error('❌ Member count update error:', e)); 
    }, 5 * 60 * 1000);
    
    setInterval(() => { 
        updateOnlineMemberCountChannel().catch(e => console.error('❌ Online count update error:', e)); 
    }, 5 * 60 * 1000);
    
    // Reset daily stats at midnight
    console.log('🔄 Setting up daily statistics...');
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
    console.log('✅ Daily statistics setup complete');

    // Ensure the bot sits in the specified voice channel by ID
    console.log('🔄 Connecting to voice channel...');
    setTimeout(() => { connectToVoiceChannel(); }, 3000);

    // Reaction-role disabled per new requirement; using auto-role on member join instead

    // Register slash commands
    try {
        console.log('🔄 Registering slash commands...');
        console.log(`📋 Found ${commandList.length} commands to register`);
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN || config.botToken);
        
        const commandsData = commandList.map(command => command.data.toJSON());
        console.log(`📤 Sending ${commandsData.length} commands to Discord API...`);
        
        // Register commands globally
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commandsData }
        );
        
		console.log(`✅ ${commandsData.length} commands are ready for use.`);
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
    
    console.log('🎉 Bot initialization completed successfully!');
    
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

// Handle slash commands and button interactions
client.on('interactionCreate', async (interaction) => {
    // مدیریت دکمه‌های تیکت
    if (interaction.isButton()) {
        const buttonIds = ['create_ticket', 'close_ticket', 'reopen_ticket', 'delete_ticket'];
        if (buttonIds.includes(interaction.customId)) {
            await ticketManager.handleButtonInteraction(interaction);
            return;
        }
    }

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

// Ban/Unban logs
client.on('guildBanAdd', async (ban) => {
    try {
        const fetched = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 }).catch(() => null);
        const entry = fetched?.entries?.first?.();
        const embed = withAuthor(ban.user)
            .setColor(0xc0392b)
            .setTitle('User banned')
            .addFields(
                { name: 'User', value: userDisplay(ban.user, null), inline: false },
                { name: 'ID', value: String(ban.user.id), inline: false }
            )
            .setTimestamp(entry?.createdTimestamp || Date.now());
        await sendLog(ban.guild, 'ban', { embeds: [embed] });
    } catch (_) {}
});

client.on('guildBanRemove', async (ban) => {
    try {
        const fetched = await ban.guild.fetchAuditLogs({ type: 23, limit: 1 }).catch(() => null);
        const entry = fetched?.entries?.first?.();
        const embed = withAuthor(ban.user)
            .setColor(0x27ae60)
            .setTitle('User unbanned')
            .addFields(
                { name: 'User', value: userDisplay(ban.user, null), inline: false },
                { name: 'ID', value: String(ban.user.id), inline: false }
            )
            .setTimestamp(entry?.createdTimestamp || Date.now());
        await sendLog(ban.guild, 'ban', { embeds: [embed] });
    } catch (_) {}
});

// Auto-react on new messages in configured channels
client.on('messageCreate', async (message) => {
    try {
        if (message.author?.bot) return;
        
        // Track message count
        client.dailyStats.messages++;
        
        // Anti-spam processing
        if (!antiSpam.isExempt(message)) {
            const entries = antiSpam.pushMessage(message);
            const score = antiSpam.computeViolations(message, entries);
            if (score > 0) {
                await antiSpam.applyPunishment(message, score);
            }
        }
        
        const set = client.autoReactions.get(message.channelId);
        if (!set || set.size === 0) return;
        for (const emojiKey of set) {
            try { await message.react(emojiKey); } catch {}
        }
    } catch (error) {
        console.error('❌ Error in messageCreate auto-reaction:', error);
    }
});

// Message update (edit)
client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
        const guild = newMessage.guild || oldMessage.guild;
        if (!guild) return;
        const before = oldMessage?.content || '';
        const after = newMessage?.content || '';
        if (before === after) return;
        const embed = withAuthor((newMessage.author || oldMessage.author))
            .setColor(0x3498db)
            .setTitle('✏️ Message Edited')
            .addFields(
                { name: 'Author', value: userLine(newMessage.author || oldMessage.author), inline: false },
                { name: 'Channel', value: newMessage.channel ? `#${newMessage.channel.name} (${newMessage.channel.id})` : '—', inline: false },
                { name: 'Before', value: before.slice(0, 1024) || '—', inline: false },
                { name: 'After', value: after.slice(0, 1024) || '—', inline: false }
            )
            .setTimestamp();
        await sendLog(guild, 'message', { embeds: [embed] });
    } catch (_) {}
});

// Message delete
client.on('messageDelete', async (message) => {
    try {
        const guild = message.guild;
        if (!guild) return;
        const embed = withAuthor(message.author)
            .setColor(0xe74c3c)
            .setTitle('🗑️ Message Deleted')
            .addFields(
                { name: 'Author', value: userLine(message.author), inline: false },
                { name: 'Channel', value: message.channel ? `#${message.channel.name} (${message.channel.id})` : '—', inline: false },
                { name: 'Content', value: (message.content || '—').slice(0, 1024), inline: false }
            )
            .setTimestamp();
        await sendLog(guild, 'message', { embeds: [embed] });
    } catch (_) {}
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

        // Allow logging for bots too (no early return)
        
        // Log voice join/leave/move in the requested style
        try {
            const guild = newState.guild || oldState.guild;
            const user = (newState.member || oldState.member)?.user;
            if (oldState.channelId !== newState.channelId) {
                if (newState.channelId && !oldState.channelId) {
                    const ch = newState.channel;
                    const count = ch?.members?.size || 0;
                    const limit = ch?.userLimit && ch.userLimit > 0 ? ch.userLimit : '∞';
                    const embed = withAuthor(user)
                        .setColor(0x2ecc71)
                        .setTitle('User joined channel')
                        .addFields(
                            { name: 'User', value: userDisplay(user, newState.member), inline: false },
                            { name: 'Channel', value: `${ch ? `🔊 ${ch.name}` : '—'}`, inline: false },
                            { name: 'Users', value: `${count}/${limit}`, inline: false }
                        )
                        .setTimestamp();
                    await sendLog(guild, 'voice', { embeds: [embed] });
                } else if (!newState.channelId && oldState.channelId) {
                    const ch = oldState.channel;
                    const count = ch?.members?.size || 0;
                    const limit = ch?.userLimit && ch.userLimit > 0 ? ch.userLimit : '∞';
                    const embed = withAuthor(user)
                        .setColor(0xe74c3c)
                        .setTitle('User left channel')
                        .addFields(
                            { name: 'User', value: userDisplay(user, oldState.member), inline: false },
                            { name: 'Channel', value: `${ch ? `🔊 ${ch.name}` : '—'}`, inline: false },
                            { name: 'Users', value: `${count}/${limit}`, inline: false }
                        )
                        .setTimestamp();
                    await sendLog(guild, 'voice', { embeds: [embed] });
                } else if (newState.channelId && oldState.channelId) {
                    const from = oldState.channel;
                    const to = newState.channel;
                    const toCount = to?.members?.size || 0;
                    const toLimit = to?.userLimit && to.userLimit > 0 ? to.userLimit : '∞';
                    const embed = withAuthor(user)
                        .setColor(0x5865f2)
                        .setTitle('User moved channel')
                        .addFields(
                            { name: 'User', value: userDisplay(user, newState.member), inline: false },
                            { name: 'From', value: `${from ? `🔊 ${from.name}` : '—'}`, inline: true },
                            { name: 'To', value: `${to ? `🔊 ${to.name}` : '—'}`, inline: true },
                            { name: 'Users', value: `${toCount}/${toLimit}`, inline: false }
                        )
                        .setTimestamp();
                    await sendLog(guild, 'voice', { embeds: [embed] });
                }
            }
        } catch (_) {}

        // Check if someone joined the specific voice channel
        if (!newState.member?.user?.bot && newState.channelId === voiceChannelId && oldState.channelId !== voiceChannelId) {
            console.log(`✅ ${newState.member.user.username} joined voice move me `);
            
            try {
                // Send message to the person who joined
                const welcomeMessage = `درود ${newState.member}\n` +
                                     `به زودی به درخواست شما رسیدگی خواهد شد .\n` +
                                     `ممنون از صبوری شما 🌹\n` +
                                     `**زمان:** <t:${Math.floor(Date.now() / 1000)}:F>`;
                
                await newState.member.send(welcomeMessage);
                console.log(`📩 wait message sent to ${newState.member.user.username} `);
                
            } catch (dmError) {
                console.error(`❌ Error sending welcome DM to ${newState.member.user.tag}:`, dmError);
            }
            
            try {
                // Send notification to the target user (music provider)
                const targetUser = await client.users.fetch(targetUserId);
                
                if (targetUser) {
                    const notificationMessage = `یک درخواست از چنل <#${newState.channel.id}> داری !\n` +
                                              `**کاربر:** <@${newState.member.user.id}>\n` +
                                              `**زمان:** <t:${Math.floor(Date.now() / 1000)}:F>`;
                    
                    await targetUser.send(notificationMessage);
                    console.log(`🔔 move me request sent to farzadthebest `);
                } else {
                    console.log(`❌ Target user ${targetUserId} not found`);
                }
            } catch (dmError) {
                console.error(`❌ Error sending music notification:`, dmError);
            }
        }
        
        // Check if someone left the voice channel
        if (!oldState.member?.user?.bot && oldState.channelId === voiceChannelId && newState.channelId !== voiceChannelId) {
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

// Listen for presence updates to update online member count in real-time
client.on('presenceUpdate', async (oldPresence, newPresence) => {
    try {
        // Only update if the status actually changed
        const oldStatus = oldPresence?.status || 'offline';
        const newStatus = newPresence?.status || 'offline';
        
        if (oldStatus !== newStatus) {
            // Debounce updates to avoid rate limiting - only update every 30 seconds max
            if (!client.lastOnlineCountUpdate || Date.now() - client.lastOnlineCountUpdate > 30000) {
                client.lastOnlineCountUpdate = Date.now();
                await updateOnlineMemberCountChannel();
            }
        }
    } catch (error) {
        console.error('❌ Error in presence update handler:', error);
    }
});

// Guild updates (server settings) - focus on name changes
client.on('guildUpdate', async (oldGuild, newGuild) => {
    try {
        if (oldGuild.name !== newGuild.name) {
            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('Server name updated')
                .addFields(
                    { name: 'Name', value: `${newGuild.name}`, inline: false },
                    { name: 'Previous name', value: `${oldGuild.name}`, inline: false }
                )
                .setTimestamp();
            await sendLog(newGuild, 'server', { embeds: [embed] });
        }
        // You can extend here for icon/banner/description/AFK channel/etc.
    } catch (_) {}
});

// Channel create/update/delete logs
client.on('channelCreate', async (channel) => {
    try {
        const guild = channel.guild; if (!guild) return;
        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('🆕 Channel Created')
            .addFields(
                { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: false },
                { name: 'Type', value: String(channel.type), inline: true },
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
            )
            .setTimestamp();
        await sendLog(guild, 'channel', { embeds: [embed] });
    } catch (_) {}
});

client.on('channelDelete', async (channel) => {
    try {
        const guild = channel.guild; if (!guild) return;
        const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('🗑️ Channel Deleted')
            .addFields(
                { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: false },
                { name: 'Type', value: String(channel.type), inline: true },
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
            )
            .setTimestamp();
        await sendLog(guild, 'channel', { embeds: [embed] });
    } catch (_) {}
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
    try {
        const guild = newChannel.guild; if (!guild) return;
        // Skip logging for the online member count channel to avoid spam in channel logs
        if (String(newChannel.id) === String(config.onlineMemberCountChannelId)) return;
        const changes = [];
        const nameChanged = oldChannel.name !== newChannel.name;
        if (nameChanged) {
            const isVoice = newChannel.type === 2 || newChannel.type === 13;
            const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle(isVoice ? 'Voice channel name updated' : 'Channel name updated')
                .addFields(
                    { name: 'Name', value: `${newChannel.name} ( ${oldChannel.name} )`, inline: false },
                    { name: 'ID', value: newChannel.id, inline: false },
                    { name: 'Previous name', value: oldChannel.name, inline: false }
                )
                .setTimestamp();
            await sendLog(guild, 'channel', { embeds: [embed] });
            // continue to also report other changes if exist
        }
        if (oldChannel.parentId !== newChannel.parentId) {
            changes.push({ name: 'Parent', value: `${oldChannel.parentId || '—'} → ${newChannel.parentId || '—'}`, inline: false });
        }
        // Permission overwrites change summary (brief)
        if (JSON.stringify(oldChannel.permissionOverwrites?.cache?.keys?.()) !== JSON.stringify(newChannel.permissionOverwrites?.cache?.keys?.())) {
            changes.push({ name: 'Permissions', value: 'Permission overwrites updated', inline: false });
        }
        if (!nameChanged && changes.length === 0) return;
        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('📝 Channel Updated')
            .addFields(
                { name: 'Channel', value: `${newChannel.name} (${newChannel.id})`, inline: false },
                ...changes,
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false }
            )
            .setTimestamp();
        if (changes.length) {
            await sendLog(guild, 'channel', { embeds: [embed] });
        }
    } catch (_) {}
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
        
        // Also update online member count as new member might be online
        updateOnlineMemberCountChannel();

        // Send welcome message to welcome channel
        await sendWelcomeChannelMessage(member);
        
        // Send DM to the new member
        await sendWelcomeDM(member);
        
    } catch (error) {
        console.error('❌ Error handling new member:', error);
    }
    // Member join log
    try {
        const embed = withAuthor(member.user)
            .setColor(0x2ecc71)
            .setTitle('User joined')
            .addFields(
                { name: 'User', value: userDisplay(member.user, member), inline: false },
                { name: 'ID', value: String(member.id), inline: false },
                { name: 'Created', value: `<t:${Math.floor((member.user.createdTimestamp||0)/1000)}:R>`, inline: false },
                { name: 'Members', value: String(member.guild.memberCount), inline: false }
            )
            .setTimestamp();
        await sendLog(member.guild, 'member', { embeds: [embed] });
    } catch (_) {}
});

// Member leave
client.on('guildMemberRemove', async (member) => {
    try {
        const roles = member.roles?.cache
            ? Array.from(member.roles.cache.values())
                .filter(r => r.id !== member.guild.id)
                .map(r => `${r}`)
            : [];
        const embed = withAuthor(member.user)
            .setColor(0xffa500)
            .setTitle('User left')
            .addFields(
                { name: 'User', value: userDisplay(member.user, member), inline: false },
                { name: 'ID', value: String(member.id), inline: false },
                { name: 'Joined', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : '—', inline: false },
                { name: 'Roles', value: roles.length ? roles.join(' ') : '—', inline: false },
                { name: 'Members', value: String(Math.max(0, (member.guild.memberCount||0) - 1)), inline: false }
            )
            .setTimestamp();
        await sendLog(member.guild, 'member', { embeds: [embed] });
    } catch (_) {}
});

// Detect kicks via audit log (best-effort) shortly after member leaves
client.on('guildMemberRemove', async (member) => {
    try {
        const fetched = await member.guild.fetchAuditLogs({ type: 20, limit: 1 }).catch(() => null); // MemberKick = 20
        const entry = fetched?.entries?.first?.();
        if (entry && entry.target?.id === member.id && Date.now() - entry.createdTimestamp < 10_000) {
            const embed = withAuthor(member.user)
                .setColor(0xff0000)
                .setTitle('🦵 Member Kicked')
                .addFields(
                    { name: 'User', value: userLine(member.user), inline: false },
                    { name: 'By', value: userLine(entry.executor), inline: false },
                    { name: 'Reason', value: entry.reason || '—', inline: false },
                    { name: 'Time', value: `<t:${Math.floor(entry.createdTimestamp/1000)}:F>`, inline: false }
                )
                .setTimestamp(entry.createdTimestamp);
            await sendLog(member.guild, 'member', { embeds: [embed] });
        }
    } catch (_) {}
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
        
        // Also update online member count as member left (might have been online)
        updateOnlineMemberCountChannel();
    } catch (error) {
        // silent
    }
});

// Nickname change logs
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (oldMember.nickname !== newMember.nickname) {
            const embed = withAuthor(newMember.user)
                .setColor(0x9b59b6)
                .setTitle('User nickname update')
                .addFields(
                    { name: 'User', value: userDisplay(newMember.user, newMember), inline: false },
                    { name: 'Nickname', value: newMember.nickname || newMember.user.displayName || '—', inline: false },
                    { name: 'Previous nickname', value: oldMember.nickname || oldMember.user.displayName || '/', inline: false }
                )
                .setTimestamp();
            try {
                const fetched = await newMember.guild.fetchAuditLogs({ type: 24, limit: 1 });
                const entry = fetched?.entries?.first?.();
                if (entry && Date.now() - entry.createdTimestamp < 10_000 && entry.target?.id === newMember.id) {
                    embed.addFields({ name: 'Reason', value: entry.reason || '—', inline: false });
                }
            } catch (_) {}
            await sendLog(newMember.guild, 'nickname', { embeds: [embed] });
        }
        // Timeout
        const oldUntil = oldMember.communicationDisabledUntilTimestamp || 0;
        const newUntil = newMember.communicationDisabledUntilTimestamp || 0;
        if (oldUntil !== newUntil) {
            const now = Date.now();
            const isTimeout = newUntil && newUntil > now;
            const embed = withAuthor(newMember.user)
                .setColor(isTimeout ? 0x2c3e50 : 0x27ae60)
                .setTitle(isTimeout ? 'User timed out' : 'User timeout removed')
                .addFields(
                    { name: 'User', value: userDisplay(newMember.user, newMember), inline: false },
                    ...(
                        isTimeout
                        ? [
                            { name: 'Timed out for', value: `${Math.max(1, Math.round((newUntil - now)/60000))} minutes`, inline: false },
                            { name: 'Timeout expires at', value: new Date(newUntil).toLocaleString(), inline: false }
                          ]
                        : []
                    )
                )
                .setTimestamp();
            try {
                const fetched = await newMember.guild.fetchAuditLogs({ type: 24, limit: 1 });
                const entry = fetched?.entries?.first?.();
                if (entry && now - entry.createdTimestamp < 10_000 && entry.target?.id === newMember.id) {
                    if (isTimeout) embed.addFields({ name: 'Reason', value: entry.reason || '—', inline: false });
                }
            } catch (_) {}
            await sendLog(newMember.guild, 'timeout', { embeds: [embed] });
        }
    } catch (_) {}
});

// Invite create/delete logs
client.on('inviteCreate', async (invite) => {
    try {
        function relExpires(expiresAt) {
            if (!expiresAt) return '—';
            const diff = expiresAt.getTime() - Date.now();
            if (diff <= 0) return 'expired';
            const days = Math.ceil(diff / (24*60*60*1000));
            if (days >= 2) return `in ${days} days`;
            const hours = Math.ceil(diff / (60*60*1000));
            return `in ${hours} hours`;
        }
        const ch = invite.channel;
        // Determine creator: prefer invite.inviter, fallback to audit log
        let creator = invite.inviter || null;
        if (!creator) {
            try {
                const fetched = await invite.guild.fetchAuditLogs({ type: AuditLogEvent.InviteCreate, limit: 1 });
                const entry = fetched?.entries?.first?.();
                if (entry && Date.now() - entry.createdTimestamp < 10_000) {
                    creator = entry.executor || creator;
                }
            } catch (_) {}
        }
        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('Invite created')
            .addFields(
                { name: 'Code', value: invite.code, inline: false },
                { name: 'Channel', value: ch ? `${ch.name} (# ${ch.name})` : '—', inline: false },
                { name: 'By', value: creator ? userLine(creator) : '—', inline: false },
                { name: 'Expires', value: relExpires(invite.expiresAt), inline: false },
                { name: 'Max uses', value: String(invite.maxUses ?? '∞'), inline: false }
            )
            .setTimestamp();
        await sendLog(invite.guild, 'invite', { embeds: [embed] });
    } catch (_) {}
});

client.on('inviteDelete', async (invite) => {
    try {
        const ch = invite.channel;
        // Determine deleter via audit log (best effort)
        let deleter = null;
        try {
            const fetched = await invite.guild.fetchAuditLogs({ type: AuditLogEvent.InviteDelete, limit: 1 });
            const entry = fetched?.entries?.first?.();
            if (entry && Date.now() - entry.createdTimestamp < 10_000) {
                deleter = entry.executor || null;
            }
        } catch (_) {}
        const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Invite deleted')
            .addFields(
                { name: 'Code', value: invite.code, inline: false },
                { name: 'Channel', value: ch ? `${ch.name} (# ${ch.name})` : '—', inline: false },
                { name: 'By', value: deleter ? userLine(deleter) : '—', inline: false }
            )
            .setTimestamp();
        await sendLog(invite.guild, 'invite', { embeds: [embed] });
    } catch (_) {}
});

// Role create/delete/update and member role changes
client.on('roleCreate', async (role) => {
    try {
        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('🧩 Role Created')
            .addFields(
                { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false }
            )
            .setTimestamp();
        await sendLog(role.guild, 'role', { embeds: [embed] });
    } catch (_) {}
});

client.on('roleDelete', async (role) => {
    try {
        const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('🧩 Role Deleted')
            .addFields(
                { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false }
            )
            .setTimestamp();
        await sendLog(role.guild, 'role', { embeds: [embed] });
    } catch (_) {}
});

client.on('roleUpdate', async (oldRole, newRole) => {
    try {
        const changes = [];
        if (oldRole.name !== newRole.name) changes.push({ name: 'Name', value: `${oldRole.name} → ${newRole.name}`, inline: false });
        if (oldRole.color !== newRole.color) changes.push({ name: 'Color', value: `#${oldRole.color.toString(16)} → #${newRole.color.toString(16)}`, inline: false });
        if (oldRole.hoist !== newRole.hoist) changes.push({ name: 'Hoist', value: `${oldRole.hoist} → ${newRole.hoist}`, inline: false });
        if (oldRole.mentionable !== newRole.mentionable) changes.push({ name: 'Mentionable', value: `${oldRole.mentionable} → ${newRole.mentionable}`, inline: false });
        if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push({ name: 'Permissions', value: 'Permissions updated', inline: false });
        if (changes.length === 0) return;
        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('🧩 Role Updated')
            .addFields(
                { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: false },
                ...changes,
                { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false }
            )
            .setTimestamp();
        await sendLog(newRole.guild, 'role', { embeds: [embed] });
    } catch (_) {}
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        // detect role changes
        const oldRoles = new Set(oldMember.roles.cache.keys());
        const newRoles = new Set(newMember.roles.cache.keys());
        const added = [...newRoles].filter(id => !oldRoles.has(id));
        const removed = [...oldRoles].filter(id => !newRoles.has(id));
        if (added.length === 0 && removed.length === 0) return;
        const guild = newMember.guild;

        // Prepare fields
        const addedMentions = added.map(id => `<@&${id}>`).join(' ');
        const removedMentions = removed.map(id => `<@&${id}>`).join(' ');
        const previousRoles = Array.from(oldRoles)
            .filter(id => id !== guild.id)
            .map(id => `<@&${id}>`).join(' ');

        // Try to fetch executor/reason
        let reasonText = null;
        try {
            const fetched = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 1 });
            const entry = fetched?.entries?.first?.();
            if (entry && Date.now() - entry.createdTimestamp < 10_000 && entry.target?.id === newMember.id) {
                reasonText = entry.reason || null;
            }
        } catch (_) {}

        const base = withAuthor(newMember.user);
        const nowTs = Math.floor(Date.now()/1000);

        if (added.length && removed.length === 0) {
            const embed = base
                .setColor(0x2ecc71)
                .setTitle('User roles added')
                .addFields(
                { name: 'User', value: userDisplay(newMember.user, newMember), inline: false },
                    { name: 'Added', value: addedMentions || '—', inline: false },
                    ...(reasonText ? [{ name: 'Reason', value: reasonText, inline: false }] : [])
                )
                .setTimestamp();
            await sendLog(guild, 'role', { embeds: [embed] });
            return;
        }

        if (removed.length && added.length === 0) {
            const embed = base
                .setColor(0xe67e22)
                .setTitle('User roles removed')
                .addFields(
                { name: 'User', value: userDisplay(newMember.user, newMember), inline: false },
                    { name: 'Removed', value: removedMentions || '—', inline: false }
                )
                .setTimestamp();
            await sendLog(guild, 'role', { embeds: [embed] });
            return;
        }

        // Both added and removed -> update summary
        const embed = base
            .setColor(0x5865f2)
            .setTitle('User roles update')
            .addFields(
                { name: 'User', value: userDisplay(newMember.user, newMember), inline: false },
                ...(added.length ? [{ name: 'Added', value: addedMentions, inline: false }] : []),
                { name: 'Previous roles', value: previousRoles || '—', inline: false }
            )
            .setTimestamp();
        await sendLog(guild, 'role', { embeds: [embed] });
    } catch (_) {}
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
// Validate token presence/format before attempting login
if (!botToken) {
    console.error('❌ Bot token not found! Please set DISCORD_BOT_TOKEN in your .env file');
    process.exit(1);
}
if (typeof botToken !== 'string' || botToken.split('.').length !== 3 || /\s/.test(botToken)) {
    console.error('❌ Bot token format looks invalid. Ensure it is the exact Bot Token (3 parts, no spaces).');
    process.exit(1);
}

console.log('🔑 Bot token loaded successfully');
client.login(botToken);
