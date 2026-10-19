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
  boat: 10,
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

function eventTime(value) {
  if (typeof value !== 'string') return null;
  const clock = value.normalize('NFKC').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (clock) {
    const [h,m,s]=clock.slice(1).map(v=>Number(v||0));
    return h<24 && m<60 && s<60 ? {kind:'clock',ms:(h*3600+m*60+s)*1000} : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const ms=Date.parse(value);
  return Number.isFinite(ms)?{kind:'dated',ms}:null;
}
function checkFeasibility(eventA, eventB, { transport = 'walk', minimumTravelMinutes, clockReadings } = {}) {
  const travel = checkTravelFeasibility(eventA,eventB,{transport,minimumTravelMinutes});
  if(clockReadings == null)return travel;
  if(!Array.isArray(clockReadings)||!clockReadings.length)return {...travel,status:'unknown',feasible:null,reason:'clockReadings must contain actual/displayed timestamps and a signed canonical offset'};
  const clockChecks=clockReadings.map(reading=>{
    const actual=eventTime(reading?.actualTime),displayed=eventTime(reading?.displayedTime);
    if(!actual||!displayed||actual.kind!==displayed.kind||!Number.isFinite(reading.offsetMinutes))return {...reading,status:'unknown',feasible:null,reason:'use compatible actual/displayed timestamps and signed offsetMinutes; dates required across midnight'};
    const observedOffsetMinutes=(displayed.ms-actual.ms)/60000;
    const feasible=Math.abs(observedOffsetMinutes-reading.offsetMinutes)<1e-6;
    return {...reading,observedOffsetMinutes,status:feasible?'feasible':'infeasible',feasible,reason:feasible?'clock reading agrees with supplied offset':'displayed minus actual time differs from supplied offset'};
  });
  const impossible=travel.feasible===false||clockChecks.some(reading=>reading.feasible===false);
  const unknown=travel.feasible==null||clockChecks.some(reading=>reading.feasible==null);
  return {...travel,clockChecks,status:impossible?'infeasible':unknown?'unknown':'feasible',feasible:impossible?false:unknown?null:true,
    reason:clockChecks.some(reading=>reading.feasible===false)?'clock offset contradicts supplied timestamps':clockChecks.some(reading=>reading.feasible==null)?'clock comparison is not verified':travel.reason};
}
function checkTravelFeasibility(eventA, eventB, { transport = 'walk', minimumTravelMinutes } = {}) {
  const unknown = reason => ({ status:'unknown', feasible:null, reason, hours:null, neededHours:null, distanceKm:null });
  const a=eventTime(eventA?.when), b=eventTime(eventB?.when);
  if (!a || !b || a.kind!==b.kind) return unknown('missing or incompatible timestamps; use same-day HH:mm or dated ISO timestamps');
  const hours = (b.ms-a.ms) / 36e5;
  if(hours<0) return {status:'infeasible',feasible:false,reason:'eventB is earlier than eventA; specify dates for overnight travel',hours,neededHours:null,distanceKm:null};
  const dist = distanceBetween(eventA, eventB);
  if(minimumTravelMinutes!=null && (!Number.isFinite(minimumTravelMinutes)||minimumTravelMinutes<0)) return unknown('minimumTravelMinutes must be a nonnegative number from canonical evidence');
  if(minimumTravelMinutes==null && (!Number.isFinite(dist)||dist<0)) return unknown('unknown distance and no canonical minimumTravelMinutes; cannot evaluate');
  if(minimumTravelMinutes==null && !Object.hasOwn(SPEED_KMH,transport)) return unknown('unknown transport');
  const neededHours = minimumTravelMinutes!=null ? minimumTravelMinutes/60 : dist/SPEED_KMH[transport];
  const basis = minimumTravelMinutes!=null ? 'canonical_duration' : 'estimated_speed';
  if (hours + 1e-6 < neededHours) {
    return {
      status:'infeasible', feasible: false, basis,
      reason: `Need ${neededHours.toFixed(2)}h, only ${hours.toFixed(2)}h elapsed`,
      hours, neededHours, distanceKm: dist,
    };
  }
  return { status:'feasible', feasible: true, basis, reason: 'within supplied time budget', hours, neededHours, distanceKm: dist };
}

module.exports = { checkFeasibility, SPEED_KMH, placesToMap, distanceBetweenPlaceNames };
