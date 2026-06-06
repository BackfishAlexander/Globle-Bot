"use strict";

/**
 * Tiny JSON-file store for per-user daily games.
 *
 * Shape:
 * {
 *   byDate: {
 *     "2026-06-05": {
 *       answerIndex: 196,
 *       players: {
 *         "<userId>": {
 *           userId, displayName, guesses: [{ name, proximity, emoji, correct }],
 *           finished: bool, win: bool, guessCount, finishedAt
 *         }
 *       }
 *     }
 *   }
 * }
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "state.json");

let state = { byDate: {} };

function load() {
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!state.byDate) state.byDate = {};
  } catch {
    state = { byDate: {} };
  }
}
load();

let saveTimer = null;
function save() {
  // Debounced atomic write.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error("Failed to save state:", e);
    }
  }, 250);
}

function getDay(date) {
  if (!state.byDate[date]) state.byDate[date] = { answerIndex: null, players: {} };
  return state.byDate[date];
}

function getAnswerIndex(date) {
  return getDay(date).answerIndex;
}

function setAnswerIndex(date, index) {
  getDay(date).answerIndex = index;
  save();
}

function getPlayer(date, userId) {
  return getDay(date).players[userId] || null;
}

function getOrCreatePlayer(date, userId, displayName) {
  const day = getDay(date);
  if (!day.players[userId]) {
    day.players[userId] = {
      userId,
      displayName,
      guesses: [],
      finished: false,
      win: false,
      guessCount: 0,
      finishedAt: null,
    };
  } else if (displayName) {
    day.players[userId].displayName = displayName; // keep name fresh
  }
  save();
  return day.players[userId];
}

/** All finished players for a date, sorted: winners first (fewest guesses), then give-ups. */
function finishedPlayers(date) {
  const day = getDay(date);
  return Object.values(day.players)
    .filter((p) => p.finished)
    .sort((a, b) => {
      if (a.win !== b.win) return a.win ? -1 : 1;
      if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
      return (a.finishedAt || 0) - (b.finishedAt || 0);
    });
}

/** Per-user lifetime stats across all stored dates. */
function userStats(userId) {
  let played = 0;
  let wins = 0;
  let totalGuessesOnWins = 0;
  let best = null;
  for (const day of Object.values(state.byDate)) {
    const p = day.players[userId];
    if (!p || !p.finished) continue;
    played++;
    if (p.win) {
      wins++;
      totalGuessesOnWins += p.guessCount;
      if (best === null || p.guessCount < best) best = p.guessCount;
    }
  }
  return {
    played,
    wins,
    winRate: played ? Math.round((wins / played) * 100) : 0,
    avgGuesses: wins ? (totalGuessesOnWins / wins).toFixed(1) : null,
    best,
  };
}

function touch() {
  save();
}

module.exports = {
  getAnswerIndex,
  setAnswerIndex,
  getPlayer,
  getOrCreatePlayer,
  finishedPlayers,
  userStats,
  touch,
};
