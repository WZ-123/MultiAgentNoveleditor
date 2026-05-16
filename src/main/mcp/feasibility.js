'use strict';

/**
 * Naive timeline feasibility check.
 *
 * Given two events involving the same character, estimate whether the character
 * could have plausibly traveled between them in the elapsed time.
 *
 * Inputs are best-effort (event.where can be string label, distanceKm hint, or
 * a {lat, lng} pair). transport defaults to 'walk' (5 km/h).
 */

const SPEED_KMH = {
  walk: 5,
  run: 15,
  horse: 30,
  car: 60,
  train: 200,
  plane: 800,
  magic: 1e9, // basically instant — caller must be explicit
};

function haversineKm(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat); const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function distanceBetween(eventA, eventB) {
  // 1) explicit distanceKm on either event's `physical`
  const explicit = eventA?.physical?.distanceKmTo?.[eventB?.where || ''];
  if (typeof explicit === 'number') return explicit;
  // 2) lat/lng coords
  if (eventA?.where?.lat != null && eventB?.where?.lat != null) {
    return haversineKm(eventA.where, eventB.where);
  }
  // 3) same place name → 0
  const ka = typeof eventA?.where === 'string' ? eventA.where : eventA?.where?.name;
  const kb = typeof eventB?.where === 'string' ? eventB.where : eventB?.where?.name;
  if (ka && kb && ka === kb) return 0;
  return null; // unknown
}

/**
 * Returns { feasible: boolean, reason: string, hours: number, neededHours: number, distanceKm }.
 */
/**
 * Build a place-name -> {lat, lng} lookup from the world's places array.
 */
function placesToMap(places) {
  const map = {};
  for (const p of (places || [])) {
    if (p.name && typeof p.lat === 'number' && typeof p.lng === 'number') {
      map[p.name] = { lat: p.lat, lng: p.lng };
    }
  }
  return map;
}

/**
 * Compute haversine distance between two place names using a pre-built places map.
 * Returns null if either name is unknown.
 */
function distanceBetweenPlaceNames(placeA, placeB, placesMap) {
  if (placeA === placeB) return 0;
  const a = placesMap[placeA];
  const b = placesMap[placeB];
  if (!a || !b) return null;
  return haversineKm(a, b);
}

function checkFeasibility(eventA, eventB, { transport = 'walk' } = {}) {
  const speed = SPEED_KMH[transport] ?? SPEED_KMH.walk;
  const tA = eventA?.when ? new Date(eventA.when).getTime() : null;
  const tB = eventB?.when ? new Date(eventB.when).getTime() : null;
  if (tA == null || tB == null || Number.isNaN(tA) || Number.isNaN(tB)) {
    return { feasible: true, reason: 'missing timestamps; cannot evaluate', hours: 0, neededHours: 0, distanceKm: null };
  }
  const hours = Math.abs(tB - tA) / 36e5;
  const dist = distanceBetween(eventA, eventB);
  if (dist == null) {
    return { feasible: true, reason: 'unknown distance; assumed feasible', hours, neededHours: 0, distanceKm: null };
  }
  const neededHours = dist / speed;
  if (hours + 1e-6 < neededHours) {
    return {
      feasible: false,
      reason: `Need ${neededHours.toFixed(2)}h to travel ${dist.toFixed(1)}km by ${transport}, only ${hours.toFixed(2)}h elapsed`,
      hours, neededHours, distanceKm: dist,
    };
  }
  return { feasible: true, reason: 'within transport time budget', hours, neededHours, distanceKm: dist };
}

module.exports = { checkFeasibility, SPEED_KMH, placesToMap, distanceBetweenPlaceNames };
