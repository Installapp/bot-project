module.exports = {
    // Bot configuration
    botToken: process.env.DISCORD_BOT_TOKEN,
    
    // Channel IDs
    welcomeChannelId: '1411662893635731497',
    onlineMemberCountChannelId: '1423266311835881483',
    
    
    // Server information
    serverId: '1410884345161322638',
    
    // Channel links for DM message
    rulesChannelId: '1414313035526574091',
    rolesChannelId: '1415085128971059201',

    // Anti-spam configuration
    antiSpam: {
        enabled: true,
        exemptRoleIds: [ /* add role IDs to exempt mods/admins */ ],
        exemptChannelIds: [ /* add channel IDs where spam checks are ignored */ ],
        exemptCategoryIds: [ '1415288123344027779', '1415288228776509531' ], // کتگوری تیکت‌های باز و بسته
        // Sliding window thresholds
        windowMs: 7000, // 7s window
        maxMessages: 6, // max messages per window
        maxDuplicates: 3, // identical/near-identical messages in window
        maxMentionsPerMessage: 5,
        maxLinksPerWindow: 5,
        maxEmojisPerMessage: 15,
        maxCapsRatioPerMessage: 0.7, // 70% caps of letters triggers
        minAccountAgeMs: 1000 * 60 * 60 * 24 * 3, // 3 days
        minServerAgeMs: 1000 * 60 * 60 * 12, // 12 hours since join
        // Escalation steps
        punishments: [
            { type: 'warn' },
            { type: 'timeout', durationMs: 10 * 60 * 1000 }, // 10m
            { type: 'timeout', durationMs: 60 * 60 * 1000 }, // 1h
            { type: 'kick' }
        ],
        decayMs: 30 * 60 * 1000, // how long violation score decays (30m)
        // Remove all roles immediately on any violation
        stripRolesOnViolation: true,
        // Users who should ONLY have roles removed (no warn/timeout/kick)
        stripOnlyUserIds: [ '995631414907244646' ]
    }
};
