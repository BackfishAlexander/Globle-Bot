"use strict";

/**
 * Registers the bot's slash commands with Discord.
 *   BASED GAMER MODE
 *   node deploy-commands.js
 *
 * Set GUILD_ID in .env to register instantly to a single test server.
 * Leave it unset to register globally (can take up to ~1 hour to propagate).
 */

require("dotenv").config();

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("globle")
    .setDescription("Start or resume today's Globle (your private daily game)"),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("Guess a country in today's Globle")
    .addStringOption((opt) =>
      opt
        .setName("country")
        .setDescription("The country you want to guess")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder().setName("giveup").setDescription("Give up and reveal today's mystery country"),

  new SlashCommandBuilder()
    .setName("results")
    .setDescription("See everyone's results for today (after you've finished)"),

  new SlashCommandBuilder().setName("stats").setDescription("Your personal Globle stats"),
].map((c) => c.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN and/or CLIENT_ID in .env. See .env.example.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`Registered ${commands.length} guild commands to ${guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log(`Registered ${commands.length} global commands (may take up to ~1h to appear).`);
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
    process.exit(1);
  }
})();
