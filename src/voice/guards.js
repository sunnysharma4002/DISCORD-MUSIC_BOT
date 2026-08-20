/**
 * Shared command guards.
 * Each guard returns an error string when the check fails, or null when it passes.
 */

/** Requires an active player and the caller to be in the bot's voice channel. */
export function requireSameVoice(interaction, player) {
  if (!player || !player.connection) {
    return '❌ I\'m not playing anything right now.';
  }

  const userChannelId = interaction.member?.voice?.channelId;
  if (!userChannelId) {
    return '❌ Join a voice channel first.';
  }

  if (userChannelId !== player.voiceChannelId) {
    return `❌ You need to be in <#${player.voiceChannelId}> to control playback.`;
  }

  return null;
}

/** Requires only that a player exists (for read-only commands like /queue). */
export function requirePlayer(player) {
  if (!player) return '❌ Nothing is queued. Start something with `/play`.';
  return null;
}
