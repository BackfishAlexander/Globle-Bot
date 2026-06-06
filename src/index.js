"use strict";

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
} = require("discord.js");

const globle = require("./globle");
const store = require("./store");
const { renderBoard } = require("./render");

const BOARD_FILE = "globle-board.png";

const TZ = process.env.GLOBLE_TZ || "UTC";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Helpers ----------------------------------------------------------------

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function km(meters) {
  return Math.round(meters / 1000).toLocaleString("en-US");
}

/** Resolve (and cache) the official answer feature for a date. */
async function getAnswer(date) {
  let index = store.getAnswerIndex(date);
  if (index === null || index === undefined) {
    index = await globle.fetchAnswerIndex(date);
    store.setAnswerIndex(date, index);
  }
  return globle.FEATURES[index];
}

/** Render the player's current board to a PNG buffer. */
function renderPlayerBoard(player, answer, finished) {
  return renderBoard({ guesses: player.guesses, answer, finished });
}

/** Fresh attachment from a PNG buffer (one per message). */
function boardAttachment(buffer) {
  return new AttachmentBuilder(buffer, { name: BOARD_FILE });
}

/** The emoji grid for a player's guesses, in the order they guessed. */
function resultGrid(player) {
  return player.guesses.map((g) => g.emoji).join("");
}

/** A one-line summary like "✅ 7 guesses  🟧🟨🟥🟩". */
function resultLine(player) {
  const status = player.win ? `✅ ${player.guessCount} guesses` : `🏳️ gave up (${player.guessCount} guesses)`;
  return `${status}  ${resultGrid(player)}`;
}

/** The ongoing board a player sees while playing: their guesses, closest first. */
function buildGameEmbed(player, answer, finished) {
  const sorted = [...player.guesses].sort((a, b) => a.proximity - b.proximity);
  const lines = sorted.map((g) => {
    if (g.correct) return `🟩 **${g.name}** — you got it!`;
    return `${g.emoji} ${g.name} — ${km(g.proximity)} km`;
  });

  const embed = new EmbedBuilder().setColor(finished ? (player.win ? 0x57f287 : 0xed4245) : 0xfaa61a);

  if (finished) {
    embed
      .setTitle(player.win ? "🌍 You found it!" : "🌍 Globle — game over")
      .setDescription(
        (player.win
          ? `The mystery country was **${answer.properties.NAME}**.`
          : `You gave up. The mystery country was **${answer.properties.NAME}**.`) +
          `\n\n**Your result:** ${resultGrid(player)} (${player.guessCount} guesses)`
      );
  } else {
    embed.setTitle("🌍 Globle").setDescription(
      lines.length
        ? "Closest guesses first. Keep going with `/guess`."
        : "Make your first guess with `/guess <country>`."
    );
  }

  if (lines.length) {
    embed.addFields({ name: `Guesses (${player.guesses.length})`, value: lines.join("\n").slice(0, 1024) });
  }
  embed.setImage(`attachment://${BOARD_FILE}`);
  embed.setFooter({ text: `Today's Globle • ${globle.todayStr(TZ)}` });
  return embed;
}

/** The leaderboard a player sees after finishing, plus content for DM pings. */
function buildLeaderboardEmbed(date) {
  const players = store.finishedPlayers(date);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🏆 Globle results — ${date}`)
    .setFooter({ text: `${players.length} player(s) finished today` });

  if (!players.length) {
    embed.setDescription("Nobody has finished yet.");
    return embed;
  }
  const lines = players.map((p, i) => `**${i + 1}.** ${p.displayName} — ${resultLine(p)}`);
  embed.setDescription(lines.join("\n").slice(0, 4000));
  return embed;
}

/**
 * Finalize a player's game: record win/loss, build their leaderboard view, and
 * DM every *other* player who already finished today with this new result.
 */
async function finishGame(date, player, answer, boardBuffer) {
  // Notify everyone who already finished (before this player) about the new result.
  const others = store.finishedPlayers(date).filter((p) => p.userId !== player.userId);
  const notice = new EmbedBuilder()
    .setColor(player.win ? 0x57f287 : 0xed4245)
    .setTitle("🌍 New Globle finisher!")
    .setDescription(`**${player.displayName}** just finished today's Globle.\n\n${resultLine(player)}`)
    .setImage(`attachment://${BOARD_FILE}`)
    .setFooter({ text: `Today's Globle • ${date}` });

  for (const other of others) {
    try {
      const user = await client.users.fetch(other.userId);
      await user.send({ embeds: [notice], files: [boardAttachment(boardBuffer)] });
    } catch {
      // user has DMs closed, or no shared server — skip silently
    }
  }
}

// --- Command handlers -------------------------------------------------------

async function handleGloble(interaction) {
  const date = globle.todayStr(TZ);
  await interaction.deferReply(EPHEMERAL);
  let answer;
  try {
    answer = await getAnswer(date);
  } catch (e) {
    return interaction.editReply(`⚠️ Couldn't reach Globle to load today's answer: ${e.message}`);
  }
  const player = store.getOrCreatePlayer(date, interaction.user.id, displayNameOf(interaction));

  const finished = player.finished;
  const board = await renderPlayerBoard(player, answer, finished);
  const embeds = [buildGameEmbed(player, answer, finished)];
  if (finished) embeds.push(buildLeaderboardEmbed(date));
  return interaction.editReply({ embeds, files: [boardAttachment(board)] });
}

async function handleGuess(interaction) {
  const date = globle.todayStr(TZ);
  await interaction.deferReply(EPHEMERAL);

  let answer;
  try {
    answer = await getAnswer(date);
  } catch (e) {
    return interaction.editReply(`⚠️ Couldn't reach Globle to load today's answer: ${e.message}`);
  }

  const player = store.getOrCreatePlayer(date, interaction.user.id, displayNameOf(interaction));
  if (player.finished) {
    return interaction.editReply({
      content: "You've already finished today's Globle. Come back tomorrow! 🌍",
      embeds: [buildLeaderboardEmbed(date)],
    });
  }

  const raw = interaction.options.getString("country", true);
  const guess = globle.findCountry(raw);
  if (!guess) {
    return interaction.editReply(`🤔 I don't recognise **${raw}** as a country. Try the autocomplete suggestions.`);
  }

  if (player.guesses.some((g) => g.name === guess.properties.NAME)) {
    const board = await renderPlayerBoard(player, answer, false);
    return interaction.editReply({
      content: `You already guessed **${guess.properties.NAME}**.`,
      embeds: [buildGameEmbed(player, answer, false)],
      files: [boardAttachment(board)],
    });
  }

  const correct = guess.properties.NAME === answer.properties.NAME;
  const proximity = correct ? 0 : globle.polygonDistance(guess, answer);
  player.guesses.push({
    name: guess.properties.NAME,
    proximity,
    emoji: globle.proximityEmoji(proximity, correct),
    correct,
  });
  player.guessCount = player.guesses.length;

  if (correct) {
    player.finished = true;
    player.win = true;
    player.finishedAt = Date.now();
    store.touch();
    const board = await renderPlayerBoard(player, answer, true);
    await finishGame(date, player, answer, board);
    return interaction.editReply({
      embeds: [buildGameEmbed(player, answer, true), buildLeaderboardEmbed(date)],
      files: [boardAttachment(board)],
    });
  }

  store.touch();
  const board = await renderPlayerBoard(player, answer, false);
  return interaction.editReply({
    embeds: [buildGameEmbed(player, answer, false)],
    files: [boardAttachment(board)],
  });
}

async function handleGiveUp(interaction) {
  const date = globle.todayStr(TZ);
  await interaction.deferReply(EPHEMERAL);

  let answer;
  try {
    answer = await getAnswer(date);
  } catch (e) {
    return interaction.editReply(`⚠️ Couldn't reach Globle to load today's answer: ${e.message}`);
  }

  const player = store.getOrCreatePlayer(date, interaction.user.id, displayNameOf(interaction));
  if (player.finished) {
    const board = await renderPlayerBoard(player, answer, true);
    return interaction.editReply({
      content: "You've already finished today's Globle.",
      embeds: [buildGameEmbed(player, answer, true), buildLeaderboardEmbed(date)],
      files: [boardAttachment(board)],
    });
  }

  player.finished = true;
  player.win = false;
  player.finishedAt = Date.now();
  store.touch();
  const board = await renderPlayerBoard(player, answer, true);
  await finishGame(date, player, answer, board);
  return interaction.editReply({
    embeds: [buildGameEmbed(player, answer, true), buildLeaderboardEmbed(date)],
    files: [boardAttachment(board)],
  });
}

async function handleResults(interaction) {
  const date = globle.todayStr(TZ);
  const player = store.getPlayer(date, interaction.user.id);
  if (!player || !player.finished) {
    return interaction.reply({
      content: "Finish today's Globle first (`/globle`) — no peeking at results before you've played! 🙂",
      ...EPHEMERAL,
    });
  }
  return interaction.reply({ embeds: [buildLeaderboardEmbed(date)], ...EPHEMERAL });
}

async function handleStats(interaction) {
  const s = store.userStats(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 Globle stats — ${displayNameOf(interaction)}`)
    .addFields(
      { name: "Played", value: String(s.played), inline: true },
      { name: "Won", value: `${s.wins} (${s.winRate}%)`, inline: true },
      { name: "Best", value: s.best === null ? "—" : `${s.best} guesses`, inline: true },
      { name: "Avg guesses (wins)", value: s.avgGuesses === null ? "—" : s.avgGuesses, inline: true }
    );
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

function displayNameOf(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const names = globle.searchCountries(focused, 25);
  await interaction.respond(names.map((n) => ({ name: n, value: n })));
}

// --- Wiring -----------------------------------------------------------------

client.once(Events.ClientReady, (c) => {
  console.log(`Globle bot ready as ${c.user.tag} (timezone: ${TZ})`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case "globle":
        return handleGloble(interaction);
      case "guess":
        return handleGuess(interaction);
      case "giveup":
        return handleGiveUp(interaction);
      case "results":
        return handleResults(interaction);
      case "stats":
        return handleStats(interaction);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = "⚠️ Something went wrong handling that command.";
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
    }
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN in environment (.env). See .env.example.");
  process.exit(1);
}
client.login(token);
