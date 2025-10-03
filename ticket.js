const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');

// تنظیمات تیکت
const TICKET_CONFIG = {
    openCategoryId: '1415288123344027779',    // کتگوری تیکت‌های باز
    closeCategoryId: '1415288228776509531',   // کتگوری تیکت‌های بسته
    transcriptChannelId: '1417854138829508608', // چنل ارسال ترنسکریپت
    allowedRoles: [                          // رول‌هایی که می‌توانند تیکت را ببینند
        '1417472094786162698',
        '1422594258229133423'
    ]
};

// ذخیره اطلاعات تیکت‌ها در حافظه + دیتابیس
const activeTickets = new Map(); // channelId => { userId, createdAt, ticketNumber }
const { getTicketCounter, setTicketCounter, saveTicket, deleteTicket, getTicketByChannel } = require('./db');
let ticketCounter = getTicketCounter();

// کلاس مدیریت تیکت
class TicketManager {
    constructor(client) {
        this.client = client;
    }

    // ارسال لاگ اکشن تیکت
    async sendTicketActionLog({ guild, actorUser, ticketNumber, action }) {
        try {
            const LOG_CHANNEL_ID = '1415289745231056986';
            const channel = await this.client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.send) return;

            const actor = actorUser || this.client.user;
            const embed = new EmbedBuilder()
                .setColor(action === 'Created' ? 0x2ecc71 : action === 'Deleted' ? 0xe74c3c : 0x5865f2)
                .setAuthor({ name: actor.tag, iconURL: actor.displayAvatarURL?.({ size: 128 }) })
                .addFields(
                    { name: 'Logged Info', value: `Ticket: Ticket-${String(ticketNumber).padStart(4, '0')}\nAction: ${action}`, inline: true },
                    { name: 'Panel', value: 'Nova-Ticket 2', inline: true }
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        } catch (_) {}
    }

    // ایجاد تیکت جدید
    async createTicket(interaction) {
        try {
            const guild = interaction.guild;
            const user = interaction.user;
            
            // بررسی اینکه کاربر قبلاً تیکت باز دارد یا نه
            const existingTicket = Array.from(activeTickets.values()).find(ticket => ticket.userId === user.id);
            if (existingTicket) {
                const existingChannel = guild.channels.cache.get(existingTicket.channelId);
                if (existingChannel) {
                    return await interaction.reply({
                        content: `❌ شما قبلاً یک تیکت باز دارید: ${existingChannel}`,
                        ephemeral: true
                    });
                } else {
                    // اگر چنل موجود نیست، آن را از لیست حذف کن
                    activeTickets.delete(existingTicket.channelId);
                }
            }

            await interaction.deferReply({ ephemeral: true });

            // ایجاد چنل تیکت
            const ticketChannel = await guild.channels.create({
                name: `ticket-${String(ticketCounter).padStart(4, '0')}-${user.username}`,
                type: ChannelType.GuildText,
                parent: TICKET_CONFIG.openCategoryId,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AttachFiles,
                            PermissionFlagsBits.EmbedLinks
                        ]
                    },
                    {
                        id: this.client.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.ManageMessages,
                            PermissionFlagsBits.ManageChannels
                        ]
                    }
                ]
            });

            // اضافه کردن دسترسی برای رول‌های مجاز
            for (const roleId of TICKET_CONFIG.allowedRoles) {
                await ticketChannel.permissionOverwrites.create(roleId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    EmbedLinks: true,
                    ManageMessages: true  // برای بستن تیکت
                });
            }

            // ذخیره اطلاعات تیکت (حافظه + دیتابیس)
            const createdAt = Date.now();
            const info = { userId: user.id, createdAt, ticketNumber: ticketCounter, channelId: ticketChannel.id };
            activeTickets.set(ticketChannel.id, info);
            saveTicket({ channelId: ticketChannel.id, userId: user.id, createdAt, ticketNumber: ticketCounter });

            ticketCounter++;
            setTicketCounter(ticketCounter);

            // ایجاد embed پیام خوشامد
            const welcomeEmbed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🎫 تیکت جدید ایجاد شد')
                .setDescription(`سلام ${user}!\n\nتیکت شما با موفقیت ایجاد شد. لطفاً مشکل یا سوال خود را به صورت کامل توضیح دهید.\n\nتیم پشتیبانی به زودی پاسخ شما را خواهد داد.`)
                .addFields([
                    { name: '👤 کاربر', value: user.toString(), inline: true },
                    { name: '🕒 زمان ایجاد', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                    { name: '🔢 شماره تیکت', value: `#${String(ticketCounter - 1).padStart(4, '0')}`, inline: true }
                ])
                .setFooter({ text: 'برای بستن تیکت، روی دکمه زیر کلیک کنید' })
                .setTimestamp();

            // دکمه بستن تیکت
            const closeButton = new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('🔒 بستن تیکت')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(closeButton);

            // ارسال پیام خوشامد در تیکت
            await ticketChannel.send({
                content: `${user} - تیکت شما ایجاد شد!`,
                embeds: [welcomeEmbed],
                components: [row]
            });

            // ارسال لاگ ایجاد تیکت
            await this.sendTicketActionLog({
                guild,
                actorUser: user,
                ticketNumber: ticketCounter - 1,
                action: 'Created'
            });

            // پاسخ به کاربر
            await interaction.editReply({
                content: `✅ تیکت شما با موفقیت ایجاد شد: ${ticketChannel}`
            });

            console.log(`✅ New ticket created: ${ticketChannel.name} by ${user.tag}`);

        } catch (error) {
            console.error('❌ Error creating ticket:', error);
            await interaction.editReply({
                content: '❌ خطا در ایجاد تیکت! لطفاً دوباره تلاش کنید.'
            });
        }
    }

    // بستن تیکت
    async closeTicket(interaction) {
        try {
            // بررسی دسترسی (ادمین یا رول‌های مجاز)
            const hasAdminPermission = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
            const hasAllowedRole = TICKET_CONFIG.allowedRoles.some(roleId => 
                interaction.member.roles.cache.has(roleId)
            );

            if (!hasAdminPermission && !hasAllowedRole) {
                return await interaction.reply({
                    content: '❌ شما نمیتوانید تیکت را ببندید.',
                    ephemeral: true
                });
            }

            const channel = interaction.channel;
            let ticketInfo = activeTickets.get(channel.id) || getTicketByChannel(channel.id);

            // اگر در لیست فعال نیست، سعی کن از نام چنل اطلاعات را استخراج کنی
            if (!ticketInfo) {
                const channelName = channel.name;
                let ticketMatch = channelName.match(/ticket-(\d+)-(.+)/);
                
                if (ticketMatch) {
                    const ticketNumber = parseInt(ticketMatch[1]);
                    const username = ticketMatch[2];
                    
                    // پیدا کردن کاربر اصلی
                    let originalUserId = null;
                    try {
                        const guild = interaction.guild;
                        const members = await guild.members.fetch();
                        const originalUser = members.find(member => member.user.username === username)?.user;
                        originalUserId = originalUser?.id;
                    } catch (error) {
                        console.error('Error finding original user:', error);
                    }

                    // ایجاد ticketInfo موقت
                    ticketInfo = {
                        ticketNumber: ticketNumber,
                        userId: originalUserId,
                        channelId: channel.id,
                        createdAt: Date.now()
                    };
                }
            }

            if (!ticketInfo) {
                return await interaction.reply({
                    content: '❌ این چنل یک تیکت معتبر نیست!',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            // انتقال تیکت به کتگوری بسته
            await channel.setParent(TICKET_CONFIG.closeCategoryId);
            await channel.setName(`closed-${channel.name}`);

            // حذف کامل دسترسی کاربر اصلی (انگار تیکت حذف شده)
            const originalUser = await this.client.users.fetch(ticketInfo.userId);
            if (originalUser) {
                await channel.permissionOverwrites.edit(originalUser.id, {
                    ViewChannel: false,
                    SendMessages: false,
                    ReadMessageHistory: false,
                    AttachFiles: false,
                    EmbedLinks: false
                });
            }

            // پیام بستن تیکت
            const closeEmbed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('🔒 تیکت بسته شد')
                .setDescription('این تیکت توسط عضو تیم پشتیبانی بسته شد.')
                .addFields([
                    { name: '👤 بسته شده توسط', value: interaction.user.toString(), inline: true },
                    { name: '🕒 زمان بسته شدن', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setTimestamp();

            // دکمه‌های مدیریت تیکت بسته
            const deleteButton = new ButtonBuilder()
                .setCustomId('delete_ticket')
                .setLabel('🗑️ حذف تیکت')
                .setStyle(ButtonStyle.Danger);

            const reopenButton = new ButtonBuilder()
                .setCustomId('reopen_ticket')
                .setLabel('🔓 باز کردن تیکت')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(reopenButton, deleteButton);

            await interaction.editReply({
                embeds: [closeEmbed],
                components: [row]
            });

            // ارسال اطلاع‌رسانی به کاربر اصلی
            if (originalUser) {
                try {
                    const userNotificationEmbed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('🔒 تیکت شما بسته شد')
                        .setDescription(`تیکت #${String(ticketInfo.ticketNumber).padStart(4, '0')} شما توسط تیم پشتیبانی بسته شد.`)
                        .addFields([
                            { name: '🕒 زمان بسته شدن', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                            { name: '👤 بسته شده توسط', value: interaction.user.tag, inline: true }
                        ])
                        .setFooter({ text: 'Nova_ticket' })
                        .setTimestamp();

                    await originalUser.send({ embeds: [userNotificationEmbed] });
                    console.log(`📩 Closure notification sent to ${originalUser.tag}`);
                } catch (dmError) {
                    console.error('Error sending closure notification to user:', dmError);
                }
            }

            // حذف از لیست تیکت‌های فعال
            activeTickets.delete(channel.id);
            deleteTicket(channel.id);

            console.log(`✅ Ticket closed: ${channel.name} by ${interaction.user.tag}`);

        } catch (error) {
            console.error('❌ Error closing ticket:', error);
            await interaction.editReply({
                content: '❌ خطا در بستن تیکت!'
            });
        }
    }

    // باز کردن مجدد تیکت
    async reopenTicket(interaction) {
        try {
            // بررسی دسترسی ادمین
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({
                    content: '❌ شما دسترسی لازم برای باز کردن تیکت را ندارید!',
                    ephemeral: true
                });
            }

            const channel = interaction.channel;

            // بررسی اینکه در کتگوری بسته است
            if (channel.parentId !== TICKET_CONFIG.closeCategoryId) {
                return await interaction.reply({
                    content: '❌ فقط تیکت‌های بسته شده قابل باز کردن مجدد هستند!',
                    ephemeral: true
                });
            }

            await interaction.deferReply();

            // استخراج اطلاعات از نام چنل
            const channelName = channel.name;
            let ticketMatch = channelName.match(/closed-ticket-(\d+)-(.+)/);
            
            // اگر پیدا نشد، شاید فرمت دیگری باشد
            if (!ticketMatch) {
                ticketMatch = channelName.match(/closed-(\d+)-(.+)/);
            }
            
            if (!ticketMatch) {
                return await interaction.editReply({
                    content: '❌ نام تیکت نامعتبر است! فرمت نام: ' + channelName
                });
            }

            const ticketNumber = parseInt(ticketMatch[1]);
            const username = ticketMatch[2];

            // پیدا کردن کاربر اصلی
            let originalUser = null;
            try {
                // جستجو در اعضای سرور برای پیدا کردن کاربر
                const guild = interaction.guild;
                const members = await guild.members.fetch();
                originalUser = members.find(member => member.user.username === username)?.user;
            } catch (error) {
                console.error('Error finding original user:', error);
            }

            // انتقال تیکت به کتگوری باز
            await channel.setParent(TICKET_CONFIG.openCategoryId);
            await channel.setName(`ticket-${String(ticketNumber).padStart(4, '0')}-${username}`);

            // بازگرداندن دسترسی کاربر اصلی (اگر پیدا شد)
            if (originalUser) {
                await channel.permissionOverwrites.create(originalUser.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    EmbedLinks: true
                });
            }

            // اضافه کردن مجدد به لیست تیکت‌های فعال (حتی اگر کاربر پیدا نشد)
            activeTickets.set(channel.id, {
                userId: originalUser?.id || null,
                createdAt: Date.now(), // زمان باز کردن مجدد
                ticketNumber: ticketNumber,
                channelId: channel.id
            });

            // بازگرداندن دسترسی رول‌های مجاز
            for (const roleId of TICKET_CONFIG.allowedRoles) {
                await channel.permissionOverwrites.create(roleId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    EmbedLinks: true,
                    ManageMessages: true
                });
            }

            // پیام باز کردن مجدد تیکت (پیام موقت)
            const reopenEmbed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🔓 تیکت مجدداً باز شد')
                .setDescription('این تیکت توسط عضو تیم پشتیبانی مجدداً باز شد.')
                .addFields([
                    { name: '👤 باز شده توسط', value: interaction.user.toString(), inline: true },
                    { name: '🕒 زمان باز شدن', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setTimestamp();

            // ارسال پیام موقت که حذف می‌شود
            const tempMessage = await interaction.editReply({
                embeds: [reopenEmbed],
                components: []  // بدون دکمه
            });

            // حذف پیام بعد از 8 ثانیه
            setTimeout(async () => {
                try {
                    await tempMessage.delete();
                } catch (error) {
                    // اگر پیام قبلاً حذف شده، خطا نادیده گرفته می‌شود
                }
            }, 8000);

            // دکمه بستن تیکت حذف شد - فقط ادمین‌ها می‌توانند از slash command استفاده کنند

            // منشن کردن کاربر در تیکت بجای DM
            if (originalUser) {
                await channel.send({
                    content: `${originalUser} 🔓 **تیکت مجدداً باز شد**`,
                    allowedMentions: { users: [originalUser.id] }
                });
            }

            console.log(`✅ Ticket reopened: ${channel.name} by ${interaction.user.tag}`);

        } catch (error) {
            console.error('❌ Error reopening ticket:', error);
            await interaction.editReply({
                content: '❌ خطا در باز کردن مجدد تیکت!'
            });
        }
    }

    // حذف تیکت
    async deleteTicket(interaction) {
        try {
            // بررسی دسترسی ادمین (فقط ادمین‌ها می‌توانند حذف کنند)
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({
                    content: '❌ شما دسترسی لازم برای حذف تیکت را ندارید!',
                    ephemeral: true
                });
            }

            const channel = interaction.channel;

            // بررسی اینکه در کتگوری بسته است
            if (channel.parentId !== TICKET_CONFIG.closeCategoryId) {
                return await interaction.reply({
                    content: '❌ فقط تیکت‌های بسته شده قابل حذف هستند!',
                    ephemeral: true
                });
            }

            await interaction.reply({
                content: '🗑️ تیکت در حال حذف...',
                ephemeral: true
            });

            // استخراج اطلاعات تیکت از نام چنل
            const channelName = channel.name;
            let ticketMatch = channelName.match(/closed-ticket-(\d+)-(.+)/);
            
            // اگر پیدا نشد، شاید فرمت دیگری باشد
            if (!ticketMatch) {
                ticketMatch = channelName.match(/closed-(\d+)-(.+)/);
            }
            
            let ticketInfo = null;
            if (ticketMatch) {
                const ticketNumber = parseInt(ticketMatch[1]);
                const username = ticketMatch[2];
                
                // پیدا کردن کاربر اصلی
                let originalUserId = null;
                try {
                    const guild = interaction.guild;
                    const members = await guild.members.fetch();
                    const originalUser = members.find(member => member.user.username === username)?.user;
                    originalUserId = originalUser?.id;
                } catch (error) {
                    console.error('Error finding original user:', error);
                }

                ticketInfo = {
                    ticketNumber: ticketNumber,
                    userId: originalUserId,
                    channelId: channel.id
                };

                // ایجاد ترنسکریپت قبل از حذف
                const transcript = await this.generateTranscript(channel, ticketInfo);
                
                // ارسال ترنسکریپت
                await this.sendTranscript(transcript, ticketInfo);
            }

            // تاخیر 3 ثانیه برای خواندن پیام
            setTimeout(async () => {
                try {
                    await channel.delete();
                    console.log(`✅ Ticket deleted: ${channel.name} by ${interaction.user.tag}`);
                    // ارسال لاگ حذف تیکت
                    await this.sendTicketActionLog({
                        guild: interaction.guild,
                        actorUser: interaction.user,
                        ticketNumber: ticketInfo?.ticketNumber || 0,
                        action: 'Deleted'
                    });
                } catch (error) {
                    console.error('❌ Error deleting ticket:', error);
                }
            }, 3000);

        } catch (error) {
            console.error('❌ Error deleting ticket:', error);
        }
    }

    // تولید ترنسکریپت
    async generateTranscript(channel, ticketInfo) {
        try {
            const messages = await channel.messages.fetch({ limit: 100 });
            const sortedMessages = Array.from(messages.values()).reverse();
            const openerTag = await this.client.users.fetch(ticketInfo.userId).then(u => u.tag).catch(() => 'نامشخص');

            function escapeHtml(value) {
                try {
                    return (value || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/\"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                } catch (_) { return ''; }
            }

            let html = `<!doctype html>
<html lang="fa"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Transcript #${String(ticketInfo.ticketNumber).padStart(4, '0')}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,IRANSans;background:#1e1f22;color:#f2f3f5;margin:0;padding:24px}
.container{max-width:1000px;margin:0 auto}
.header{background:#2b2d31;border:1px solid #1e1f22;border-radius:12px;padding:16px 20px;margin-bottom:16px}
.h{margin:0 0 8px 0;font-size:18px}
.meta{color:#b5bac1;font-size:13px}
.msg{display:grid;grid-template-columns:56px 1fr;gap:12px;padding:12px 14px;border-bottom:1px solid #2b2d31}
.avatar{width:40px;height:40px;border-radius:50%;background:#2b2d31}
.author{font-weight:600;color:#e3e5e8}
.time{color:#a3a6aa;font-size:12px;margin-inline-start:8px}
.content{white-space:pre-wrap;word-wrap:break-word;line-height:1.6}
.attach{margin-top:6px}
.attach a{color:#949cf7;text-decoration:none}
.attach a:hover{text-decoration:underline}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#5865f2;color:#fff;font-size:12px;margin-inline-start:8px}
</style>
</head><body>
    <div class="container">
        <div class="header">
            <div class="h">📋 ترنسکریپت تیکت #${String(ticketInfo.ticketNumber).padStart(4, '0')} <span class="badge">Discord Style</span></div>
            <div class="meta">🏷️ نام چنل: ${escapeHtml(channel.name)}</div>
            <div class="meta">👤 کاربر: ${escapeHtml(openerTag)} (${escapeHtml(ticketInfo.userId || 'نامشخص')})</div>
            <div class="meta">🕒 زمان ایجاد: ${escapeHtml(new Date(ticketInfo.createdAt).toLocaleString('fa-IR'))}</div>
            <div class="meta">🕒 زمان بسته شدن: ${escapeHtml(new Date().toLocaleString('fa-IR'))}</div>
        </div>`;

            for (const message of sortedMessages) {
                if (message.author.bot && message.author.id === this.client.user.id) continue;
                const timestamp = new Date(message.createdTimestamp).toLocaleString('fa-IR');
                const avatar = message.author.displayAvatarURL ? message.author.displayAvatarURL({ size: 64 }) : '';
                html += `
        <div class="msg">
            <div>
                <img class="avatar" src="${escapeHtml(avatar)}" alt="" onerror="this.style.display='none'" />
            </div>
            <div>
                <div>
                    <span class="author">${escapeHtml(message.author.tag)}</span>
                    <span class="time">${escapeHtml(timestamp)}</span>
                </div>
                <div class="content">${escapeHtml(message.content || '')}</div>
                ${message.attachments.size > 0 ? `<div class="attach">${Array.from(message.attachments.values()).map(a => `<div>📎 <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name || a.url)}</a></div>`).join('')}</div>` : ''}
            </div>
        </div>`;
            }

            html += `
    </div>
</body></html>`;

            return html;
        } catch (error) {
            console.error('❌ Error generating transcript:', error);
            return 'خطا در تولید ترنسکریپت';
        }
    }

    // ارسال ترنسکریپت
    async sendTranscript(transcript, ticketInfo) {
        try {
            const transcriptChannel = await this.client.channels.fetch(TICKET_CONFIG.transcriptChannelId);
            const originalUser = await this.client.users.fetch(ticketInfo.userId);

            if (transcriptChannel) {
                const transcriptEmbed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('📋 ترنسکریپت تیکت جدید')
                    .setDescription(`تیکت #${String(ticketInfo.ticketNumber).padStart(4, '0')} بسته شد.`)
                    .addFields([
                        { name: '👤 کاربر', value: originalUser ? `${originalUser.tag} (${originalUser.id})` : 'نامشخص', inline: true },
                        { name: '🕒 زمان بسته شدن', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                        { name: '🔢 شماره تیکت', value: `#${String(ticketInfo.ticketNumber).padStart(4, '0')}`, inline: true }
                    ])
                    .setFooter({ text: 'سیستم ترنسکریپت تیکت' })
                    .setTimestamp();

                // ارسال embed و فایل ترنسکریپت به چنل
                await transcriptChannel.send({
                    embeds: [transcriptEmbed],
                    files: [{
                        attachment: Buffer.from(transcript, 'utf8'),
                        name: `ticket-${String(ticketInfo.ticketNumber).padStart(4, '0')}-transcript.html`
                    }]
                });

                console.log(`✅ Transcript sent to channel ${transcriptChannel.name}`);
            } else {
                console.error('❌ Transcript channel not found');
            }

        } catch (error) {
            console.error('❌ Error sending transcript:', error);
        }
    }

    // مدیریت کلیک دکمه‌ها
    async handleButtonInteraction(interaction) {
        const { customId } = interaction;

        switch (customId) {
            case 'create_ticket':
                await this.createTicket(interaction);
                break;
            case 'close_ticket':
                await this.closeTicket(interaction);
                break;
            case 'reopen_ticket':
                await this.reopenTicket(interaction);
                break;
            case 'delete_ticket':
                await this.deleteTicket(interaction);
                break;
        }
    }

    // ایجاد پنل تیکت
    async createTicketPanel(channel) {
        try {
            const panelEmbed = new EmbedBuilder()
                .setColor(0x0099ff)
                .setTitle('🎫  تیکت پشتیبانی')
                .addFields([
                    { name: '📋 راهنما', value: '• برای ایجاد تیکت، روی دکمه "ایجاد تیکت" کلیک کنید\n• هر کاربر فقط می‌تواند یک تیکت فعال داشته باشد', inline: false }
                ])
                .setFooter({ text: 'Nova_ticket' });

            const createButton = new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('🎫 ایجاد تیکت')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(createButton);

            await channel.send({
                embeds: [panelEmbed],
                components: [row]
            });

            console.log('✅ Ticket panel created');

        } catch (error) {
            console.error('❌ Error creating ticket panel:', error);
        }
    }

    // اضافه کردن کاربر یا رول به تیکت
    async addToTicket(interaction) {
        try {
            // بررسی دسترسی (ادمین یا رول‌های مجاز)
            const hasAdminPermission = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
            const hasAllowedRole = TICKET_CONFIG.allowedRoles.some(roleId => 
                interaction.member.roles.cache.has(roleId)
            );

            if (!hasAdminPermission && !hasAllowedRole) {
                return await interaction.reply({
                    content: '❌ شما دسترسی لازم برای اضافه کردن به تیکت را ندارید!',
                    ephemeral: true
                });
            }

            const channel = interaction.channel;

            // بررسی اینکه در تیکت هستیم
            if (!channel.parentId || 
                (channel.parentId !== TICKET_CONFIG.openCategoryId && 
                 channel.parentId !== TICKET_CONFIG.closeCategoryId)) {
                return await interaction.reply({
                    content: '❌ این دستور فقط در تیکت‌ها قابل استفاده است!',
                    ephemeral: true
                });
            }

            const user = interaction.options.getUser('user');
            const role = interaction.options.getRole('role');

            if (!user && !role) {
                return await interaction.reply({
                    content: '❌ لطفاً یک کاربر یا رول را انتخاب کنید!',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            let addedItems = [];

            // اضافه کردن کاربر
            if (user) {
                if (user.bot) {
                    return await interaction.editReply({
                        content: '❌ نمی‌توانید ربات را به تیکت اضافه کنید!'
                    });
                }

                await channel.permissionOverwrites.create(user.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    EmbedLinks: true
                });

                addedItems.push(`👤 ${user.toString()}`);
            }

            // اضافه کردن رول
            if (role) {
                if (role.id === interaction.guild.roles.everyone.id) {
                    return await interaction.editReply({
                        content: '❌ نمی‌توانید رول @everyone را اضافه کنید!'
                    });
                }

                await channel.permissionOverwrites.create(role.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    EmbedLinks: true
                });

                addedItems.push(`🎭 ${role.toString()}`);
            }

            // پیام تأیید
            await interaction.editReply({
                content: `✅ با موفقیت اضافه شد:\n${addedItems.join('\n')}`
            });

            // اطلاع‌رسانی در تیکت
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setDescription(`➕ **${interaction.user.toString()} اضافه کرد:**\n${addedItems.join('\n')}`)
                .setFooter({ text: 'Nova_ticket' })
                .setTimestamp();

            await channel.send({ embeds: [embed] });

            console.log(`✅ Added to ticket ${channel.name}: ${addedItems.join(', ')} by ${interaction.user.tag}`);

        } catch (error) {
            console.error('❌ Error adding to ticket:', error);
            await interaction.editReply({
                content: '❌ خطا در اضافه کردن به تیکت!'
            });
        }
    }
}

// دستورات تیکت
const ticketCommands = [
    {
        data: new SlashCommandBuilder()
            .setName('ticket-panel')
            .setDescription('ایجاد پنل تیکت در چنل فعلی'),
        async execute(interaction) {
            // بررسی دسترسی ادمین
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({
                    content: '❌ شما دسترسی لازم برای استفاده از این دستور را ندارید!',
                    ephemeral: true
                });
            }

            const ticketManager = new TicketManager(interaction.client);
            await ticketManager.createTicketPanel(interaction.channel);
            
            await interaction.reply({
                content: '✅ پنل تیکت با موفقیت ایجاد شد!',
                ephemeral: true
            });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('ticket-stats')
            .setDescription('نمایش آمار تیکت‌ها'),
        async execute(interaction) {
            // بررسی دسترسی
            const hasPermission = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
                                TICKET_CONFIG.allowedRoles.some(roleId => interaction.member.roles.cache.has(roleId));

            if (!hasPermission) {
                return await interaction.reply({
                    content: '❌ شما دسترسی لازم برای مشاهده آمار تیکت‌ها را ندارید!',
                    ephemeral: true
                });
            }

            const activeCount = activeTickets.size;
            const totalTickets = ticketCounter - 1;

            const statsEmbed = new EmbedBuilder()
                .setColor(0x0099ff)
                .setTitle('📊 آمار سیستم تیکت')
                .addFields([
                    { name: '🎫 تیکت‌های فعال', value: activeCount.toString(), inline: true },
                    { name: '📈 کل تیکت‌ها', value: totalTickets.toString(), inline: true },
                    { name: '🔒 تیکت‌های بسته', value: (totalTickets - activeCount).toString(), inline: true }
                ])
                .setTimestamp();

            await interaction.reply({
                embeds: [statsEmbed],
                ephemeral: true
            });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('add')
            .setDescription('اضافه کردن کاربر یا رول به تیکت')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('کاربری که می‌خواهید به تیکت اضافه کنید')
                    .setRequired(false))
            .addRoleOption(option =>
                option.setName('role')
                    .setDescription('رولی که می‌خواهید به تیکت اضافه کنید')
                    .setRequired(false)),
        async execute(interaction) {
            const ticketManager = new TicketManager(interaction.client);
            await ticketManager.addToTicket(interaction);
        }
    }
];

module.exports = {
    TicketManager,
    ticketCommands,
    TICKET_CONFIG
};
