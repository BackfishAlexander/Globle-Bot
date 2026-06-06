"use strict";

/**
 * Renders the Globle board as a PNG: a flat Natural-Earth world map (every guess
 * visible at once) with a 3D orthographic globe inset, auto-centered on the
 * player's closest guess.
 *
 * Countries are shaded exactly like the real game: unsolved guesses use the
 * `interpolateOrRd` colour ramp on a square-root distance scale; the answer is
 * green. Geometry comes from the official country dataset (via globle.js).
 *
 * d3 v7 is ESM-only, so it's loaded lazily through dynamic import and cached.
 */

const { createCanvas } = require("@napi-rs/canvas");
const globle = require("./globle");

// Visual palette
const OCEAN = "#a9cce3";
const LAND_BASE = "#e8e8e8"; // un-guessed countries
const BORDER = "#7f8c8d";
const BORDER_GUESS = "#34495e";
const GRATICULE = "rgba(255,255,255,0.45)";
const GREEN = "#2ecc71"; // the answer
const GLOBE_HALO = "rgba(0,0,0,0.18)";

let d3p = null;
async function d3() {
  if (d3p) return d3p;
  const [geo, scale, chromatic] = await Promise.all([
    import("d3-geo"),
    import("d3-scale"),
    import("d3-scale-chromatic"),
  ]);
  d3p = { ...geo, ...scale, ...chromatic };
  return d3p;
}

/** Build the proximity colour function (sqrt OrRd over [MAX_DISTANCE, 0]). */
function makeColourScale(d) {
  return d.scaleSequentialSqrt(d.interpolateOrRd).domain([globle.MAX_DISTANCE, 0]);
}

/** Fill colour for a given feature in the current board state. */
function colourFor(feature, info, colourScale) {
  if (!info) return LAND_BASE;
  if (info.answer || info.correct) return GREEN;
  return colourScale(info.proximity);
}

/** Stroke one feature's path with fill + outline on a d3 geoPath context. */
function drawFeature(ctx, path, feature, fill, stroke, lineWidth) {
  ctx.beginPath();
  path(feature);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

/** A small always-visible marker for countries too tiny to see at map scale. */
function drawMarker(ctx, x, y, fill, r) {
  ctx.beginPath();
  ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.stroke();
}

/**
 * Draw a complete map (flat or globe) onto a context within [0,0,w,h].
 * `projection` is already configured; pass `clip=true` for the globe so we
 * fill the visible sphere as ocean and the far hemisphere stays transparent.
 * `center` ([lon,lat]) is used on the globe to skip markers on the far side.
 */
function drawMap(d, ctx, projection, w, h, features, stateByName, colourScale, isGlobe, center) {
  const path = d.geoPath(projection, ctx);
  const MIN_PX = 7; // footprint below this gets a marker

  // Ocean (sphere outline). For the globe this is the disc; for flat it's the world shape.
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.fillStyle = OCEAN;
  ctx.fill();

  // Graticule
  ctx.beginPath();
  path(d.geoGraticule10());
  ctx.lineWidth = isGlobe ? 0.6 : 0.7;
  ctx.strokeStyle = GRATICULE;
  ctx.stroke();

  // Countries: un-guessed first, then guessed/answer on top for crisp borders.
  const highlighted = [];
  for (const f of features) {
    const info = stateByName.get(f.properties.NAME);
    if (info) {
      highlighted.push([f, info]);
      continue;
    }
    drawFeature(ctx, path, f, LAND_BASE, BORDER, isGlobe ? 0.4 : 0.5);
  }
  for (const [f, info] of highlighted) {
    const fill = colourFor(f, info, colourScale);
    drawFeature(ctx, path, f, fill, BORDER_GUESS, isGlobe ? 0.6 : 0.9);

    // If the country is too small to see, drop a marker at its centroid.
    const b = path.bounds(f);
    const tiny = b[1][0] - b[0][0] < MIN_PX && b[1][1] - b[0][1] < MIN_PX;
    if (tiny) {
      const lonlat = d.geoCentroid(f);
      if (!isGlobe || d.geoDistance(center, lonlat) < Math.PI / 2) {
        const p = projection(lonlat);
        if (p) drawMarker(ctx, p[0], p[1], fill, isGlobe ? 5 : 4.5);
      }
    }
  }

  // Crisp sphere edge (nice rim on the globe)
  if (isGlobe) {
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();
  }
}

/**
 * @param {object} opts
 * @param {Array<{name,proximity,correct}>} opts.guesses
 * @param {object} opts.answer  answer feature (revealed only when finished)
 * @param {boolean} opts.finished
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderBoard({ guesses, answer, finished }) {
  const d = await d3();
  const colourScale = makeColourScale(d);
  const features = globle.FEATURES;

  // Build name -> render info for guessed countries (+ revealed answer).
  const stateByName = new Map();
  for (const g of guesses) {
    stateByName.set(g.name, { proximity: g.proximity, correct: !!g.correct });
  }
  if (finished && answer) {
    const cur = stateByName.get(answer.properties.NAME) || {};
    stateByName.set(answer.properties.NAME, { ...cur, answer: true });
  }

  const W = 1024;
  const H = 540;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#f4f6f7";
  ctx.fillRect(0, 0, W, H);

  // --- Flat map (fills the frame) ---
  const flat = d.geoNaturalEarth1().fitExtent(
    [
      [8, 8],
      [W - 8, H - 8],
    ],
    { type: "Sphere" }
  );
  const center = chooseGlobeCenter(d, guesses, answer, finished);
  drawMap(d, ctx, flat, W, H, features, stateByName, colourScale, false, center);

  // --- Globe inset (bottom-left), centered on the closest guess ---
  const GS = 250; // globe canvas size
  const globeCanvas = createCanvas(GS, GS);
  const gctx = globeCanvas.getContext("2d");
  const globe = d
    .geoOrthographic()
    .rotate([-center[0], -center[1]])
    .clipAngle(90)
    .fitExtent(
      [
        [6, 6],
        [GS - 6, GS - 6],
      ],
      { type: "Sphere" }
    );
  drawMap(d, gctx, globe, GS, GS, features, stateByName, colourScale, true, center);

  // Drop shadow halo + place inset
  const gx = 14;
  const gy = H - GS - 6;
  ctx.save();
  ctx.beginPath();
  ctx.arc(gx + GS / 2, gy + GS / 2, GS / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = GLOBE_HALO;
  ctx.fill();
  ctx.restore();
  ctx.drawImage(globeCanvas, gx, gy);

  return canvas.encode("png");
}

/** Pick a [lon, lat] to center the globe on: closest guess, else answer, else default. */
function chooseGlobeCenter(d, guesses, answer, finished) {
  let focus = null;
  if (guesses.length) {
    focus = guesses.reduce((a, b) => (b.proximity < a.proximity ? b : a));
  }
  let feature = null;
  if (focus) feature = globle.featureByName(focus.name);
  if (!feature && finished && answer) feature = answer;
  if (feature) {
    const c = d.geoCentroid(feature);
    if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) return c;
  }
  return [10, 25]; // default view (Africa/Europe-ish)
}

module.exports = { renderBoard };
