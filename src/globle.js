"use strict";

/**
 * Core Globle engine.
 *
 * This module reproduces, in Node, exactly what the official globle-game.com
 * client does to obtain and score the daily mystery country:
 *
 *  1. The daily answer is an AES-encrypted country index served by the game's
 *     backend at  GET https://globle-game.com/answer?day=YYYY-MM-DD&list=197
 *     We decrypt it with the same CryptoJS-style passphrase the client uses,
 *     yielding an index into the 197-country dataset (data/country_data.json).
 *
 *  2. Proximity between a guess and the answer is the minimum great-circle
 *     distance between their polygon border points (port of the game's
 *     distance.ts), in metres.
 *
 *  3. A guess is coloured by that proximity using the same emoji bands the
 *     game uses for its shareable results (port of colour.ts).
 */

const crypto = require("crypto");
const https = require("https");
const path = require("path");

// --- Static data ------------------------------------------------------------

const countryData = require(path.join(__dirname, "..", "data", "country_data.json"));
const alternateNames = require(path.join(__dirname, "..", "data", "alternate_names.json"));

/** @type {Array<any>} GeoJSON features; index aligns with the server's answer index. */
const FEATURES = countryData.features;

// --- Answer fetch + decryption ---------------------------------------------

// Passphrase baked into the official client bundle (CryptoJS AES, passphrase mode).
const ANSWER_KEY = "ee53e68c3074206a002bf01333b047d5";
const ANSWER_HOST = "globle-game.com";

/**
 * OpenSSL EVP_BytesToKey (MD5) — how CryptoJS derives key+IV from a passphrase
 * for "Salted__"-prefixed ciphertext. Produces 32-byte key + 16-byte IV.
 */
function deriveKeyAndIv(passphrase, salt) {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  const pass = Buffer.from(passphrase, "binary");
  while (derived.length < 48) {
    block = crypto.createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.slice(0, 32), iv: derived.slice(32, 48) };
}

/** Decrypt a CryptoJS-AES (passphrase mode) base64 string. */
function decryptAnswer(cipherB64, passphrase) {
  const raw = Buffer.from(cipherB64, "base64");
  if (raw.slice(0, 8).toString("binary") !== "Salted__") {
    throw new Error("Unexpected ciphertext (missing salt header)");
  }
  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyAndIv(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "GlobleDiscordBot/1.0", Accept: "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Server returned HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Could not parse server response as JSON"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Request to globle-game.com timed out")));
  });
}

/**
 * Fetch + decrypt the official daily answer index for a given YYYY-MM-DD date.
 * @returns {Promise<number>} index into FEATURES
 */
async function fetchAnswerIndex(dateStr) {
  const url = `https://${ANSWER_HOST}/answer?day=${dateStr}&list=${FEATURES.length}`;
  const json = await httpsGetJson(url);
  if (!json || !json.answer) throw new Error("No answer field in server response");
  const indexStr = decryptAnswer(json.answer, ANSWER_KEY);
  const index = parseInt(indexStr, 10);
  if (Number.isNaN(index) || index < 0 || index >= FEATURES.length) {
    throw new Error("Decrypted answer index is invalid");
  }
  return index;
}

/** YYYY-MM-DD date string in the given IANA timezone (default UTC). */
function todayStr(timeZone = "UTC") {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// --- Distance (port of the game's distance.ts) ------------------------------

const EARTH_RADIUS = 6378137; // metres; matches spherical-geometry-js default
const MAX_DISTANCE = 15000000; // metres; colour scale ceiling (from colour.ts)

function greatCircle(lng1, lat1, lng2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Border points [lng, lat] of a feature's outer ring(s). */
function polygonPoints(feature) {
  const g = feature.geometry;
  if (g.type === "Polygon") return g.coordinates[0];
  if (g.type === "MultiPolygon") {
    let points = [];
    for (const polygon of g.coordinates) points = points.concat(polygon[0]);
    return points;
  }
  throw new Error("Unsupported geometry type: " + g.type);
}

// Enclave pairs the game hardcodes to 0 (their polygons don't share vertices).
const ZERO_PAIRS = new Set([
  "South Africa|Lesotho",
  "Lesotho|South Africa",
  "Italy|Vatican",
  "Vatican|Italy",
  "Italy|San Marino",
  "San Marino|Italy",
]);

/** Minimum great-circle distance (metres) between two countries' borders. */
function polygonDistance(a, b) {
  const key = `${a.properties.NAME}|${b.properties.NAME}`;
  if (ZERO_PAIRS.has(key)) return 0;
  const pts1 = polygonPoints(a);
  const pts2 = polygonPoints(b);
  let min = EARTH_RADIUS * Math.PI; // half circumference
  for (let i = 0; i < pts1.length; i++) {
    const p1 = pts1[i];
    for (let j = 0; j < pts2.length; j++) {
      const p2 = pts2[j];
      const d = greatCircle(p1[0], p1[1], p2[0], p2[1]);
      if (d < min) min = d;
    }
  }
  return min;
}

// --- Colour (port of the game's colour.ts getColourEmoji) -------------------

function proximityEmoji(proximityMeters, isCorrect) {
  if (isCorrect) return "🟩";
  const scale = proximityMeters / MAX_DISTANCE;
  if (scale < 0.1) return "🟥";
  if (scale < 0.25) return "🟧";
  if (scale < 0.5) return "🟨";
  return "⬜";
}

// --- Country name matching --------------------------------------------------

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
/** Lowercase, diacritic-free, punctuation -> single spaces. */
function normalize(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/** Lowercase, diacritic-free, all non-alphanumerics removed (e.g. "U.S.A." -> "usa"). */
function compact(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Two-tier lookup: exact normalized first, then punctuation-insensitive "compact".
const NAME_LOOKUP = new Map();
const COMPACT_LOOKUP = new Map();
function addLookup(name, feature) {
  if (!name) return;
  const n = normalize(name);
  if (n && !NAME_LOOKUP.has(n)) NAME_LOOKUP.set(n, feature);
  const c = compact(name);
  if (c && !COMPACT_LOOKUP.has(c)) COMPACT_LOOKUP.set(c, feature);
}
for (const f of FEATURES) {
  const p = f.properties;
  addLookup(p.NAME, f);
  addLookup(p.NAME_LONG, f);
  addLookup(p.FORMAL_EN, f);
  addLookup(p.BRK_NAME, f);
  addLookup(p.ABBREV, f); // "U.S.A." -> compact "usa", "U.K." -> "uk"
  addLookup(p.POSTAL, f);
  if (p.ISO_A2 && p.ISO_A2 !== "-99") addLookup(p.ISO_A2, f);
  if (p.ISO_A2_EH && p.ISO_A2_EH !== "-99") addLookup(p.ISO_A2_EH, f);
}
// Aliases. The data is inconsistent about which of {real, alternative} is the
// dataset's canonical NAME, so resolve whichever side matches and alias both.
for (const list of Object.values(alternateNames)) {
  for (const { real, alternative } of list) {
    const target = NAME_LOOKUP.get(normalize(real)) || NAME_LOOKUP.get(normalize(alternative));
    if (target) {
      addLookup(real, target);
      addLookup(alternative, target);
    }
  }
}

/** Resolve a user-typed country name to a feature, or null. */
function findCountry(input) {
  if (!input) return null;
  return NAME_LOOKUP.get(normalize(input)) || COMPACT_LOOKUP.get(compact(input)) || null;
}

// Exact-NAME -> feature map (for re-hydrating stored guesses into geometry).
const FEATURE_BY_NAME = new Map(FEATURES.map((f) => [f.properties.NAME, f]));
function featureByName(name) {
  return FEATURE_BY_NAME.get(name) || null;
}

/** Up to `limit` country NAMEs matching a (partial) query, for autocomplete. */
function searchCountries(query, limit = 25) {
  const q = normalize(query || "");
  const names = FEATURES.map((f) => f.properties.NAME);
  if (!q) return names.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const name of names) {
    const n = normalize(name);
    if (n.startsWith(q)) starts.push(name);
    else if (n.includes(q)) contains.push(name);
  }
  return starts.concat(contains).slice(0, limit);
}

module.exports = {
  FEATURES,
  fetchAnswerIndex,
  todayStr,
  polygonDistance,
  proximityEmoji,
  findCountry,
  featureByName,
  searchCountries,
  MAX_DISTANCE,
};
