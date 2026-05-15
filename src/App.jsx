import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// LEAFLET LOADER
// ─────────────────────────────────────────────────────────────────────────────
let _leafletReady = null;
function loadLeaflet() {
  if (_leafletReady) return _leafletReady;
  _leafletReady = new Promise((resolve) => {
    if (window.L) { resolve(window.L); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve(window.L);
    document.head.appendChild(script);
  });
  return _leafletReady;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function computeRTI(disasters, sosReports) {
  if (!disasters.length) return 0;
  const sevScore = { critical:100, high:70, medium:40, low:15 };
  const incidentSeverity = disasters.reduce((s,d)=>s+(sevScore[d.severity]||20),0)/disasters.length;
  const incidentDensity  = Math.min(100, disasters.filter(d=>d.status==="active"||d.status==="warning").length*14);
  const sosDensity       = Math.min(100, sosReports.filter(s=>s.urgency==="critical"||s.urgency==="high").length*18);
  const totalPop         = disasters.reduce((s,d)=>s+(d.affectedPop||0),0);
  const popExposure      = Math.min(100, totalPop/800);
  const envConditions    = disasters.filter(d=>d.type==="wildfire").reduce((s,d)=>s+(d.wind||0)/80*40+(1-(d.humidity||50)/100)*30,0)/Math.max(1,disasters.filter(d=>d.type==="wildfire").length);
  const infraFail        = Math.min(100, sosReports.filter(s=>/power|tower|gas|electric/.test((s.msg||"").toLowerCase())).length*25);
  return Math.round(Math.min(100, 0.30*incidentSeverity+0.20*incidentDensity+0.15*sosDensity+0.15*popExposure+0.10*Math.min(100,envConditions)+0.10*infraFail));
}

function predictEscalation(disaster) {
  if (disaster.type==="wildfire") {
    const wind=disaster.wind||20, temp=disaster.temp||85, hum=disaster.humidity||30;
    const drought=hum<10?80:hum<20?55:hum<35?30:15;
    const score=wind*0.35+(temp/120*100)*0.25+drought*0.20-(hum/100*100)*0.20;
    const pct=Math.round(Math.min(99,Math.max(1,score)));
    return { pct, label:pct>=75?"LIKELY":pct>=45?"POSSIBLE":"UNLIKELY", spread:wind>45?"EXTREME":wind>30?"RAPID":wind>15?"MODERATE":"SLOW", model:"wildfire" };
  }
  if (disaster.type==="earthquake") {
    const pct=Math.round(({critical:80,high:55,medium:30,low:12}[disaster.severity]||20)*(1+(disaster.aftershocks||0)*0.02));
    return { pct:Math.min(95,pct), label:pct>=60?"LIKELY":"POSSIBLE", spread:"AFTERSHOCK SEQ.", model:"earthquake" };
  }
  if (disaster.type==="flood") {
    const base=disaster.severity==="critical"?72:disaster.severity==="high"?50:28;
    return { pct:base, label:base>=60?"LIKELY":"POSSIBLE", spread:"DOWNSTREAM", model:"flood" };
  }
  const base={critical:70,high:45,medium:25,low:10}[disaster.severity]||25;
  return { pct:base, label:base>=60?"LIKELY":"POSSIBLE", spread:"REGIONAL", model:"general" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOS CATEGORY DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const SOS_CATEGORIES = [
  { id:"trapped",    icon:"🪤", label:"Trapped",          color:"#ef4444", urgency:"critical", threat:"structural entrapment",
    immediateActions:["Stay calm and conserve energy","Make noise every few minutes to guide rescuers","Do not shift surrounding debris","Cover mouth and nose if dust present"],
    responderActions:["Activate USAR — structural collapse protocol","Deploy acoustic listening devices","Shore debris field before entry","Stage ALS at extraction point"],
    resources:["USAR Team","Shoring Equipment","Rescue Airbags","ALS Unit","Acoustic Detectors"],
    safetyWarning:"Do NOT disturb debris field. Secondary collapse is the primary rescuer risk." },

  { id:"injured",    icon:"🩸", label:"Injured",           color:"#f97316", urgency:"critical", threat:"medical emergency",
    immediateActions:["Control bleeding with firm direct pressure","Do not move if neck/back injury suspected","Keep patient warm and still","Shout or signal your location every 2 minutes"],
    responderActions:["ALS priority dispatch — immediate response","Establish patient ABCs on arrival","Prepare LZ if air transport required","Coordinate hospital trauma bay notification"],
    resources:["ALS Ambulance","Paramedic Unit","Trauma Kit","Helicopter (rural)","Blood Products"],
    safetyWarning:"Do not give food or water to unconscious patients. Maintain C-spine precaution if trauma suspected." },

  { id:"flooding",   icon:"🌊", label:"Flooding",          color:"#3b82f6", urgency:"high", threat:"flood inundation",
    immediateActions:["Move to highest floor or roof immediately","Do not attempt to wade through moving water","Turn off electrical at main breaker if accessible","Secure floating hazards if safe to do so"],
    responderActions:["Deploy water rescue boats and swift-water teams","Establish upstream safety line before entry","Coordinate helicopter recon for roof survivors","Check levees and upstream gauge levels"],
    resources:["Water Rescue Team","Inflatable Rescue Boat","High-Water Vehicle","PFDs","Helicopter"],
    safetyWarning:"6 inches of moving water can knock a person down. 2 feet can sweep away a vehicle." },

  { id:"fire",       icon:"🔥", label:"Fire / Smoke",      color:"#ef4444", urgency:"critical", threat:"structural fire",
    immediateActions:["Evacuate immediately via nearest unblocked exit","Stay low — smoke rises, air is cleaner near floor","Close doors behind you to slow fire spread","Signal from window only if unable to evacuate"],
    responderActions:["Deploy Engine + Ladder companies simultaneously","Conduct primary search on all floors — account for all occupants","Establish water supply within 3 minutes","Ventilate structure before interior attack"],
    resources:["Fire Engine","Ladder Truck","EMS/ALS Unit","SCBA Units","Thermal Imaging Camera"],
    safetyWarning:"Do NOT re-enter structure for any reason. Maintain 100ft clear perimeter. Watch for flashover indicators." },

  { id:"road",       icon:"🚧", label:"Road Blocked",      color:"#eab308", urgency:"medium", threat:"infrastructure blockage",
    immediateActions:["Move vehicle to safest accessible shoulder","Activate hazard lights and remain with vehicle","Do not attempt to pass on soft shoulder or turn around","Photograph blockage and note GPS coordinates if possible"],
    responderActions:["Dispatch traffic incident management team","Coordinate alternate route with local DOT","Assess for secondary hazards: fuel spills, power lines","Activate emergency traffic management system"],
    resources:["Traffic Incident Team","Tow Service","DOT Crew","Law Enforcement","Fire Engine (standby)"],
    safetyWarning:"Do not exit vehicle on high-speed roadways. Stay buckled until emergency services arrive." },

  { id:"evacuation", icon:"🚨", label:"Need Evacuation",   color:"#a855f7", urgency:"high", threat:"evacuation required",
    immediateActions:["Gather essential items only: IDs, medications, phone/charger","Lock your home and follow designated evacuation route","Do not use elevators — use stairs","Proceed to nearest shelter or assembly point"],
    responderActions:["Activate community notification system — reverse 911","Open emergency shelters along evacuation corridor","Deploy traffic control at key intersections","Coordinate with transit for mobility-limited residents"],
    resources:["Transit Buses","Shelter Facility","Law Enforcement","Red Cross","Medical Support Team"],
    safetyWarning:"Do not delay evacuation. Never return to evacuated areas without official all-clear." },

  { id:"supplies",   icon:"📦", label:"Need Supplies",     color:"#22c55e", urgency:"medium", threat:"resource deprivation",
    immediateActions:["Ration existing water — 1 quart per person per day minimum","Stay sheltered and conserve body heat/energy","Signal your location to increase visibility","Identify any medical needs that are time-critical"],
    responderActions:["Coordinate supply drop with logistics team","Prioritize medical/prescription needs first","Verify medical conditions and prioritize accordingly","Establish supply delivery route and ETA"],
    resources:["Logistics Team","Medical Supplies","Water/Food Cache","Transport Vehicle","Red Cross"],
    safetyWarning:"Prioritize water and medications. Avoid consuming unknown food sources." },

  { id:"other",      icon:"📡", label:"Other Emergency",   color:"#64748b", urgency:"medium", threat:"unclassified emergency",
    immediateActions:["Stay calm and assess your immediate surroundings","Move away from visible hazards","Signal your location clearly","Follow instructions from emergency services"],
    responderActions:["Conduct scene size-up before committing resources","Establish ICS command structure","Assess for secondary hazards","Document all observations for after-action review"],
    resources:["First Responders","Medical Unit","Command Vehicle","Liaison Officer"],
    safetyWarning:"Scene safety is priority. Assess before acting. Unknown situations require systematic approach." },
];

// Safe zone database (mock)
const SAFE_ZONES = [
  { name:"Fresno Fairgrounds Shelter", lat:36.74, lng:-119.78, type:"shelter",   capacity:2400, open:true  },
  { name:"Clovis Memorial Staging",    lat:36.82, lng:-119.70, type:"staging",   capacity:800,  open:true  },
  { name:"Madera Fairgrounds",         lat:36.96, lng:-120.06, type:"shelter",   capacity:1200, open:true  },
  { name:"Los Banos Civic Center",     lat:37.05, lng:-120.85, type:"shelter",   capacity:600,  open:true  },
  { name:"Gilroy Community Center",    lat:37.00, lng:-121.57, type:"shelter",   capacity:900,  open:true  },
  { name:"Livermore Valley HS",        lat:37.68, lng:-121.78, type:"shelter",   capacity:1800, open:false },
  { name:"Stockton Arena",             lat:37.96, lng:-121.31, type:"megashelter",capacity:5000, open:true  },
  { name:"Sacramento Convention Ctr",  lat:38.58, lng:-121.49, type:"megashelter",capacity:8000, open:true  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION DATA (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const SIM_BEATS = [
  { t:0,  type:"phase",      phase:"MONITORING",   label:"SCENARIO INITIALISING…",             color:"cyan"   },
  { t:2,  type:"log",        msg:"NWS red-flag warning issued — Santa Ana wind event detected" },
  { t:3,  type:"escalate",   id:5, severity:"high",     wind:44, humidity:6 },
  { t:4,  type:"log",        msg:"GOES-18 thermal anomaly expanding: +340 acres in 12 min" },
  { t:5,  type:"sos",        sos:{ id:"sim1", lat:37.28, lng:-119.62, msg:"Fire/Smoke · Smoke filling house, can't breathe, 3 kids inside", urgency:"critical", name:"D. Reyes", offline:false }},
  { t:7,  type:"risk",       score:42 },
  { t:8,  type:"log",        msg:"CAL FIRE dispatch: 4 air tankers redirected — ETA 18 min" },
  { t:10, type:"phase",      phase:"ESCALATING",   label:"⚠ ESCALATION DETECTED",             color:"orange" },
  { t:11, type:"escalate",   id:5, severity:"critical", wind:61, humidity:4 },
  { t:12, type:"newincident",incident:{ id:6, type:"wildfire", lat:37.05, lng:-119.82, name:"Fresno Foothills Breakout", severity:"high", wind:55, humidity:5, temp:108, spread:"SW 4.1 mi/hr", status:"active", ts:0, affectedPop:9400 }},
  { t:14, type:"sos",        sos:{ id:"sim2", lat:37.08, lng:-119.78, msg:"Road Blocked · Fire, 20+ vehicles stranded on Hwy 41", urgency:"critical", name:"CHP Unit 14", offline:false }},
  { t:15, type:"risk",       score:67 },
  { t:17, type:"log",        msg:"Cell tower KYA-932 offline — coverage gap in Madera County" },
  { t:18, type:"offline",    active:true },
  { t:19, type:"sos",        sos:{ id:"sim3", lat:37.11, lng:-119.74, msg:"Injured · Bus overturned, multiple injuries, need medevac", urgency:"critical", name:"Bus Driver #7", offline:true }},
  { t:20, type:"risk",       score:78 },
  { t:21, type:"log",        msg:"⚡ OFFLINE QUEUE ACTIVE — 3 messages cached for relay" },
  { t:22, type:"sos",        sos:{ id:"sim4", lat:37.06, lng:-119.69, msg:"Other Emergency · Power lines down across driveway, propane tank nearby", urgency:"high", name:"P. Nguyen", offline:true }},
  { t:24, type:"phase",      phase:"CRITICAL",     label:"🔴 MASS CASUALTY THRESHOLD REACHED", color:"red"    },
  { t:25, type:"risk",       score:89 },
  { t:26, type:"escalate",   id:1, severity:"critical", wind:67, humidity:3 },
  { t:27, type:"log",        msg:"MANDATORY EVACUATION ORDER: Zones A–F, est. 31,000 residents" },
  { t:28, type:"newincident",incident:{ id:7, type:"tornado", lat:37.62, lng:-120.88, name:"EF3 Confirmed – Merced Basin", severity:"critical", speed:"158mph", path:"W→E", status:"active", ts:0, affectedPop:17800 }},
  { t:30, type:"sos",        sos:{ id:"sim5", lat:37.58, lng:-120.81, msg:"Trapped · Tornado hit mobile home park, multiple structures destroyed", urgency:"critical", name:"MCHD Dispatch", offline:true }},
  { t:32, type:"risk",       score:95 },
  { t:34, type:"log",        msg:"FEMA Region IX activated — National Guard en route" },
  { t:36, type:"log",        msg:"Satellite uplink restored on backup frequency — partial coverage" },
  { t:38, type:"phase",      phase:"RECONNECTING", label:"↗ NETWORK RECOVERY INITIATED",      color:"purple" },
  { t:40, type:"offline",    active:false },
  { t:41, type:"log",        msg:"✓ Queued SOS messages transmitted — all units notified" },
  { t:42, type:"risk",       score:91 },
  { t:44, type:"log",        msg:"AI risk model updating with satellite thermal + NWS 3hr forecast…" },
  { t:46, type:"phase",      phase:"BRIEFING",     label:"🤖 AI INCIDENT BRIEFING GENERATING", color:"cyan"   },
  { t:48, type:"briefing" },
  { t:58, type:"risk",       score:88 },
  { t:60, type:"phase",      phase:"COMPLETE",     label:"✓ SIMULATION COMPLETE",             color:"green"  },
];

const SIM_BRIEFING = {
  headline:"CRITICAL: Multi-vector fire event — mass evacuation in progress",
  body:"A catastrophic wind-driven fire event spanning Fresno and Madera counties has exceeded initial modeling parameters. The Sierra Madre Complex merged with the Fresno Foothills Breakout at T+26 minutes, creating a 7,400-acre conflagration with extreme spotting behavior. Simultaneous tornado activity in the Merced Basin has overwhelmed regional dispatch capacity. 31,000 residents are under mandatory evacuation orders.",
  actions:["Activate State OES EOC to Level 1","Request mutual aid from LA, Sacramento, Bay Area strike teams","Deploy 3 medevac helicopters to Hwy 41 staging area","Establish forward command post at Fresno Fairgrounds","Issue shelter-in-place for Merced sectors 1–9"],
  confidence:96,
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIAL DATA
// ─────────────────────────────────────────────────────────────────────────────
const NOW = Date.now();
const INITIAL_DISASTERS = [
  { id:1, type:"wildfire",   lat:37.3,  lng:-119.6, name:"Sierra Madre Complex",          severity:"critical", wind:42, humidity:8,  temp:104, spread:"NE 2.3 mi/hr", status:"active",     ts:NOW-3600000,  affectedPop:14200 },
  { id:2, type:"flood",      lat:38.1,  lng:-121.5, name:"Delta Overflow",                 severity:"high",     rain:"3.8in/hr", riverLevel:"+12ft",                   status:"active",     ts:NOW-7200000,  affectedPop:8300  },
  { id:3, type:"earthquake", lat:36.5,  lng:-121.2, name:"Magnitude 5.8 – Salinas Valley", severity:"medium",   depth:"8km", aftershocks:14,                           status:"monitoring", ts:NOW-10800000, affectedPop:22000 },
  { id:4, type:"tornado",    lat:37.8,  lng:-122.1, name:"EF2 Warning – Contra Costa",     severity:"high",     speed:"115mph", path:"SW→NE",                          status:"warning",    ts:NOW-1800000,  affectedPop:5700  },
  { id:5, type:"wildfire",   lat:36.9,  lng:-120.1, name:"Pacheco Pass Fire",               severity:"medium",   wind:28, humidity:14, temp:97, spread:"N 0.8 mi/hr",  status:"contained",  ts:NOW-86400000, affectedPop:3100  },
];

const INITIAL_SOS = [
  { id:"s1", lat:37.35, lng:-119.55, msg:"Fire/Smoke · House fire, family of 4 trapped, 2nd floor",       urgency:"critical", ts:NOW-900000,  offline:false, name:"A. Torres", category:"fire"      },
  { id:"s2", lat:38.05, lng:-121.45, msg:"Flooding · Elderly neighbor unconscious, flooding basement",     urgency:"critical", ts:NOW-1500000, offline:true,  name:"M. Chen",   category:"flooding"  },
  { id:"s3", lat:37.82, lng:-122.05, msg:"Trapped · Roof collapsed, need extraction, no injuries yet",     urgency:"high",     ts:NOW-2400000, offline:false, name:"R. Patel",  category:"trapped"   },
  { id:"s4", lat:36.52, lng:-121.18, msg:"Need Supplies · Running low on medications, diabetic patient",   urgency:"medium",   ts:NOW-5400000, offline:false, name:"J. Kim",    category:"supplies"  },
];

function buildTimeline(disasters, sos) {
  const snaps = [];
  for (let h = 24; h >= 0; h--) {
    const cutTs = NOW - h*3600000;
    snaps.push({ hour:24-h, label:h===0?"NOW":`-${h}h`, disasters:disasters.filter(d=>d.ts<=cutTs).map(d=>({...d,severity:h>12&&d.severity==="critical"?"high":d.severity})), sos:sos.filter(s=>s.ts<=cutTs) });
  }
  return snaps;
}

const MOCK_AI_SUMMARIES = {
  1:{ headline:"CRITICAL: Extreme fire behavior likely within 6–8 hours", body:"The Sierra Madre Complex is exhibiting Haines Index of 6 (extreme) with red-flag conditions. Wind shift forecast at 18:00 PST will push flames toward three subdivisions totaling ~4,200 structures. Spotting events detected up to 1.2 miles ahead of main front.", actions:["Evacuate Zones A–D immediately","Deploy air tankers to NE flank","Pre-position strike teams at Miller Creek Rd"], confidence:94 },
  2:{ headline:"HIGH: Flash flood surge expected within 3 hours", body:"USGS stream gauge at Sherman Island shows 12-foot rise over baseline. Atmospheric river delivering 3.8 in/hr upstream. Delta levee at Sector 7 showing seepage.", actions:["Open emergency shelter at Dixon Fairgrounds","Close Hwy 160 at Rio Vista Bridge","Dispatch water rescue teams"], confidence:87 },
  3:{ headline:"MEDIUM: Aftershock sequence ongoing — structural assessment needed", body:"14 aftershocks recorded since M5.8 mainshock, largest M3.2. ShakeMap shows MMI VII in Salinas Valley core. Liquefaction risk elevated.", actions:["Inspect unreinforced masonry structures","Check gas infrastructure in MMI VII zone","Monitor Pajaro River levees"], confidence:78 },
  4:{ headline:"HIGH: Tornado on ground, moving NE at 35mph", body:"Doppler confirms EF2 tornado touchdown at 14:23 PST near Martinez. 1/4-mile wide damage path moving NE toward Concord metro area.", actions:["Issue shelter-in-place for Concord sectors 3–7","Activate reverse 911 for path corridor","Position medical teams"], confidence:91 },
  5:{ headline:"MEDIUM: Fire 65% contained, monitoring for rekindle", body:"NWS forecast shows wind increase to 25–35mph tonight which may compromise containment lines on the northern flank.", actions:["Maintain patrol on northern containment line","Pre-position retardant drops for tonight","Monitor overnight wind forecast"], confidence:82 },
  sim:SIM_BRIEFING,
};

const INCIDENT_ICONS = { wildfire:"🔥", flood:"🌊", earthquake:"⚡", tornado:"🌪️", hurricane:"🌀" };
const SEV_COLORS = {
  critical:{ bg:"bg-red-500/20",    text:"text-red-300",    border:"border-red-500/40",    dot:"bg-red-400"    },
  high:    { bg:"bg-orange-500/20", text:"text-orange-300", border:"border-orange-500/40", dot:"bg-orange-400" },
  medium:  { bg:"bg-yellow-500/20", text:"text-yellow-300", border:"border-yellow-500/40", dot:"bg-yellow-400" },
  low:     { bg:"bg-blue-500/20",   text:"text-blue-300",   border:"border-blue-500/40",   dot:"bg-blue-400"   },
};
const URG_COLORS = {
  critical:"text-red-300 border-red-500/50 bg-red-500/10",
  high:    "text-orange-300 border-orange-500/50 bg-orange-500/10",
  medium:  "text-yellow-300 border-yellow-500/50 bg-yellow-500/10",
  low:     "text-blue-300 border-blue-500/50 bg-blue-500/10",
};
const PHASE_COLORS = {
  cyan:  { ring:"border-cyan-400",   text:"text-cyan-300",   bg:"bg-cyan-500/10",   glow:"#06b6d4" },
  orange:{ ring:"border-orange-400", text:"text-orange-300", bg:"bg-orange-500/10", glow:"#f97316" },
  red:   { ring:"border-red-400",    text:"text-red-300",    bg:"bg-red-500/15",    glow:"#ef4444" },
  purple:{ ring:"border-purple-400", text:"text-purple-300", bg:"bg-purple-500/10", glow:"#a855f7" },
  green: { ring:"border-green-400",  text:"text-green-300",  bg:"bg-green-500/10",  glow:"#22c55e" },
};
const REGION_VIEWS = {
  california:{ label:"California", center:[37.5,-120.0], zoom:6 },
  usa:       { label:"USA",        center:[39.5,-98.0],  zoom:4 },
  global:    { label:"Global",     center:[20,0],        zoom:2 },
};

function timeAgo(ts) {
  const d=Math.floor((Date.now()-ts)/1000);
  if (d<5)    return "just now";
  if (d<60)   return `${d}s ago`;
  if (d<3600) return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI TRIAGE (SOS categories aware)
// ─────────────────────────────────────────────────────────────────────────────
async function runAITriage(category, note, deviceCtx) {
  const catDef = SOS_CATEGORIES.find(c=>c.id===category) || SOS_CATEGORIES[7];
  const msgText = `${catDef.label}${note ? " · " + note : ""}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:700,
        messages:[{ role:"user", content:
          `You are an emergency dispatch AI. Triage this SOS and give a precise, calm response.

Emergency category: ${catDef.label}
Additional note: "${note||"(none)"}"
Device context: battery ${deviceCtx.battery}%, network ${deviceCtx.network}, location accuracy ±${deviceCtx.accuracy}m

Respond ONLY with valid JSON (no markdown):
{
  "urgency":"critical"|"high"|"medium"|"low",
  "severity_label":"one word e.g. CRITICAL",
  "immediate_instruction":"Single most important thing for the person to do RIGHT NOW (max 12 words)",
  "safety_instruction":"One actionable safety sentence (max 20 words)",
  "responder_eta":"e.g. 8–12 min",
  "confidence":85
}` }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    return JSON.parse(data.content[0].text.replace(/```json|```/g,"").trim());
  } catch {
    // Local fallback
    return {
      urgency: catDef.urgency,
      severity_label: catDef.urgency.toUpperCase(),
      immediate_instruction: catDef.immediateActions[0],
      safety_instruction: catDef.safetyWarning.slice(0,80),
      responder_eta: catDef.urgency==="critical"?"6–10 min":catDef.urgency==="high"?"10–18 min":"18–30 min",
      confidence: 84,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVICE CONTEXT (mock sensors)
// ─────────────────────────────────────────────────────────────────────────────
function useDeviceContext(offlineMode) {
  const [ctx, setCtx] = useState(null);
  useEffect(() => {
    const battery = Math.floor(35 + Math.random()*55);
    const accuracy = Math.floor(8 + Math.random()*22);
    const coords = { lat:37.1+Math.random()*1.4, lng:-121.8+Math.random()*2.4 };
    setCtx({
      battery,
      network: offlineMode ? "OFFLINE" : "4G LTE",
      accuracy,
      coords,
      timestamp: new Date().toISOString(),
      address: "Madera County, CA, USA",
      batteryLow: battery < 20,
    });
  }, [offlineMode]);
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEAREST SAFE ZONE
// ─────────────────────────────────────────────────────────────────────────────
function findNearestSafeZone(lat, lng) {
  return SAFE_ZONES
    .filter(z => z.open)
    .map(z => ({ ...z, dist: haversine(lat, lng, z.lat, z.lng) }))
    .sort((a,b) => a.dist - b.dist)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// HOLD-TO-SEND BUTTON
// ─────────────────────────────────────────────────────────────────────────────
function HoldToSend({ onComplete, disabled, categoryColor }) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const holdRef = useRef(null);
  const startRef = useRef(null);
  const HOLD_DURATION = 2500;

  const startHold = useCallback((e) => {
    e.preventDefault();
    if (disabled) return;
    setHolding(true);
    startRef.current = Date.now();
    holdRef.current = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.min(100, (elapsed / HOLD_DURATION) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(holdRef.current);
        setHolding(false);
        setProgress(0);
        onComplete();
      }
    }, 30);
  }, [disabled, onComplete]);

  const cancelHold = useCallback(() => {
    clearInterval(holdRef.current);
    setHolding(false);
    setProgress(0);
  }, []);

  useEffect(() => () => clearInterval(holdRef.current), []);

  const col = categoryColor || "#ef4444";
  const circumference = 2 * Math.PI * 44;

  return (
    <button
      onMouseDown={startHold} onMouseUp={cancelHold} onMouseLeave={cancelHold}
      onTouchStart={startHold} onTouchEnd={cancelHold}
      disabled={disabled}
      className="relative w-full flex flex-col items-center justify-center gap-2 py-5 rounded-2xl border-2 transition-all select-none overflow-hidden disabled:opacity-40"
      style={{
        borderColor: holding ? col : `${col}50`,
        background: holding ? `${col}18` : `${col}08`,
        boxShadow: holding ? `0 0 32px ${col}40, 0 0 0 1px ${col}30` : "none",
        cursor: disabled ? "not-allowed" : "pointer",
      }}>
      {/* Radial progress ring */}
      <svg width="80" height="80" viewBox="0 0 96 96" className="relative z-10">
        <circle cx="48" cy="48" r="44" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4"/>
        <circle cx="48" cy="48" r="44" fill="none" stroke={col} strokeWidth="4"
          strokeDasharray={circumference} strokeDashoffset={circumference*(1-progress/100)}
          strokeLinecap="round" transform="rotate(-90 48 48)"
          style={{ transition: holding ? "none" : "stroke-dashoffset 0.15s ease" }}/>
        <text x="48" y="44" textAnchor="middle" fill="white" fontSize="22" style={{ fontFamily:"monospace" }}>
          {holding ? "🆘" : "🆘"}
        </text>
        <text x="48" y="60" textAnchor="middle" fontSize="9" fill={holding ? col : "#64748b"} style={{ fontFamily:"monospace" }}>
          {holding ? `${Math.round(progress)}%` : "HOLD"}
        </text>
      </svg>
      <div className="relative z-10 text-center">
        <p className="font-mono font-bold text-sm" style={{ color: holding ? col : "#e2e8f0" }}>
          {holding ? "SENDING…" : "HOLD TO SEND SOS"}
        </p>
        <p className="text-xs font-mono text-slate-500 mt-0.5">
          {holding ? "Release to cancel" : "Hold 2.5 seconds to confirm"}
        </p>
      </div>
      {/* Ripple effect when holding */}
      {holding && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-0 animate-ping rounded-2xl opacity-10" style={{ background:col }}/>
        </div>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SOS CONFIRMATION SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function SOSConfirmation({ report, onDismiss }) {
  const { category, triage, safeZone, offlineMode, deviceCtx } = report;
  const catDef = SOS_CATEGORIES.find(c=>c.id===category) || SOS_CATEGORIES[7];
  const col = catDef.color;
  const urgColor = triage.urgency==="critical"?"#ef4444":triage.urgency==="high"?"#f97316":triage.urgency==="medium"?"#eab308":"#22c55e";

  return (
    <div className="flex flex-col gap-4" style={{ animation:"fadeInUp 0.4s ease" }}>
      {/* Status header */}
      <div className="rounded-2xl border-2 p-5 flex flex-col items-center gap-3 text-center relative overflow-hidden"
        style={{ borderColor:`${urgColor}60`, background:`${urgColor}10`, boxShadow:`0 0 40px ${urgColor}20` }}>
        <div className="absolute inset-0 pointer-events-none opacity-5"
          style={{ backgroundImage:`repeating-linear-gradient(45deg,${urgColor} 0,${urgColor} 1px,transparent 0,transparent 50%)`, backgroundSize:"8px 8px" }}/>
        <div className="relative z-10 flex flex-col items-center gap-2">
          <div className="text-4xl">{catDef.icon}</div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background:urgColor }}/>
            <span className="text-xs font-mono font-bold" style={{ color:urgColor }}>
              {offlineMode ? "QUEUED — WILL SEND ON RECONNECT" : "SOS TRANSMITTED · RESPONDERS NOTIFIED"}
            </span>
          </div>
          <h2 className="text-white font-bold text-lg">{catDef.label}</h2>
          <p className="text-xs text-slate-400 font-mono">
            {new Date(report.ts).toLocaleTimeString()} · ±{deviceCtx.accuracy}m · {deviceCtx.address}
          </p>
        </div>
      </div>

      {/* AI Triage result */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-slate-500">AI TRIAGE RESULT</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-600">CONF {triage.confidence}%</span>
            <span className="text-xs font-mono font-bold" style={{ color:urgColor }}>{triage.severity_label}</span>
          </div>
        </div>
        {/* Urgency meter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-mono w-16">URGENCY</span>
          <div className="flex-1 h-2.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width:`${triage.urgency==="critical"?100:triage.urgency==="high"?75:triage.urgency==="medium"?50:25}%`, background:`linear-gradient(90deg,${urgColor}80,${urgColor})` }}/>
          </div>
          <span className="text-xs font-mono font-bold w-16 text-right" style={{ color:urgColor }}>{triage.urgency.toUpperCase()}</span>
        </div>
        {/* Immediate instruction */}
        <div className="rounded-lg p-3 border" style={{ borderColor:`${urgColor}40`, background:`${urgColor}10` }}>
          <p className="text-xs font-mono text-slate-400 mb-1">⚡ DO THIS NOW</p>
          <p className="text-sm font-bold" style={{ color:urgColor }}>{triage.immediate_instruction}</p>
        </div>
        {/* ETA */}
        <div className="flex items-center gap-3">
          <div className="flex-1 rounded-lg bg-white/5 border border-white/8 p-3 text-center">
            <p className="text-xs text-slate-500 font-mono mb-1">RESPONDER ETA</p>
            <p className="text-lg font-bold text-cyan-300 font-mono">{triage.responder_eta}</p>
          </div>
          <div className="flex-1 rounded-lg bg-white/5 border border-white/8 p-3 text-center">
            <p className="text-xs text-slate-500 font-mono mb-1">VISIBILITY</p>
            <p className="text-xs font-bold text-green-300 font-mono">{offlineMode?"QUEUED":"LIVE TO DISPATCH"}</p>
          </div>
        </div>
      </div>

      {/* Nearest safe zone */}
      {safeZone && (
        <div className="rounded-xl border border-green-500/25 bg-green-500/8 p-4 flex items-start gap-3">
          <div className="text-2xl flex-shrink-0">🏥</div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono text-green-400 mb-1">NEAREST SAFE ZONE · {safeZone.dist.toFixed(1)} km</p>
            <p className="text-sm text-white font-medium">{safeZone.name}</p>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Capacity: {safeZone.capacity.toLocaleString()} · {safeZone.type.toUpperCase()}
            </p>
          </div>
        </div>
      )}

      {/* Safety instruction */}
      <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/8 px-4 py-3 flex gap-3">
        <span className="text-yellow-400 flex-shrink-0">⚠</span>
        <p className="text-xs text-yellow-200 leading-relaxed font-mono">{triage.safety_instruction}</p>
      </div>

      {/* Responder actions (collapsed/preview) */}
      <div className="rounded-xl border border-white/8 bg-white/3 p-4">
        <p className="text-xs font-mono text-slate-500 mb-2">RESPONDERS HAVE BEEN BRIEFED ON:</p>
        <div className="flex flex-col gap-1.5">
          {catDef.responderActions.map((a,i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-slate-400">
              <span className="text-cyan-600 font-mono flex-shrink-0">{i+1}.</span>
              <span>{a}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {catDef.resources.map((r,i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded bg-white/8 text-slate-400 border border-white/10 font-mono">{r}</span>
          ))}
        </div>
      </div>

      {/* Device context strip */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/3 border border-white/8">
        <span className="text-xs font-mono text-slate-600">
          🔋 {deviceCtx.battery}%{deviceCtx.batteryLow&&<span className="text-red-400 ml-1">LOW</span>}
        </span>
        <span className="text-xs font-mono text-slate-600">📶 {deviceCtx.network}</span>
        <span className="text-xs font-mono text-slate-600">📍 ±{deviceCtx.accuracy}m</span>
        <span className="text-xs font-mono text-slate-600 ml-auto">{new Date(report.ts).toLocaleTimeString()}</span>
      </div>

      <button onClick={onDismiss}
        className="w-full py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:bg-white/8 text-sm font-mono transition-colors">
        ← Return to Dashboard
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW EMERGENCY SOS FORM  (replaces old SOSForm)
// ─────────────────────────────────────────────────────────────────────────────
function EmergencySOSForm({ onSubmit, onCancel, offlineMode }) {
  const [step,         setStep]        = useState("category"); // category | details | sending | confirm
  const [category,     setCategory]    = useState(null);
  const [note,         setNote]        = useState("");
  const [triageResult, setTriageResult]= useState(null);
  const deviceCtx = useDeviceContext(offlineMode);

  const catDef = SOS_CATEGORIES.find(c=>c.id===category);

  const handleHoldComplete = async () => {
    if (!catDef || !deviceCtx) return;
    setStep("sending");
    const triage = await runAITriage(category, note, deviceCtx);
    const safeZone = findNearestSafeZone(deviceCtx.coords.lat, deviceCtx.coords.lng);
    const report = {
      id: `sos_${Date.now()}`,
      lat: deviceCtx.coords.lat,
      lng: deviceCtx.coords.lng,
      msg: `${catDef.label}${note ? " · " + note : ""}`,
      urgency: triage.urgency,
      name: "You",
      offline: offlineMode,
      ts: Date.now(),
      category,
      triage,
      safeZone,
      deviceCtx,
      insights: {
        urgency: triage.urgency,
        threatType: catDef.threat,
        immediateActions: catDef.immediateActions,
        responderActions: catDef.responderActions,
        resources: catDef.resources,
        safetyWarning: catDef.safetyWarning,
        confidence: triage.confidence,
        source: "anthropic",
      },
    };
    setTriageResult(report);
    setStep("confirm");
    onSubmit(report);
  };

  if (step === "confirm" && triageResult) {
    return <SOSConfirmation report={triageResult} onDismiss={onCancel}/>;
  }

  if (step === "sending") {
    return (
      <div className="flex flex-col items-center justify-center gap-5 py-12" style={{ animation:"fadeInUp 0.3s ease" }}>
        <div className="w-16 h-16 border-4 border-red-500/30 border-t-red-400 rounded-full animate-spin"/>
        <div className="flex flex-col items-center gap-1">
          <p className="text-white font-bold font-mono">TRANSMITTING SOS…</p>
          <p className="text-xs text-slate-500 font-mono">AI triage running · notifying responders</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600 font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"/>
          {offlineMode ? "QUEUING FOR OFFLINE RELAY…" : "LIVE TRANSMISSION…"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" style={{ animation:"fadeInUp 0.3s ease" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-red-400 text-xl">🆘</span>
          <div>
            <h3 className="text-white font-bold text-sm font-mono">EMERGENCY SOS</h3>
            <p className="text-xs text-slate-500">Tap your emergency type below</p>
          </div>
        </div>
        <button onClick={onCancel} className="text-slate-600 hover:text-slate-300 text-lg transition-colors">×</button>
      </div>

      {/* Device context bar */}
      {deviceCtx && (
        <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/3 border border-white/8 text-xs font-mono flex-wrap">
          <span className={deviceCtx.batteryLow?"text-red-400":"text-slate-500"}>🔋 {deviceCtx.battery}%{deviceCtx.batteryLow&&" LOW"}</span>
          <span className={offlineMode?"text-purple-300":"text-green-400"}>📶 {deviceCtx.network}</span>
          <span className="text-slate-500">📍 ±{deviceCtx.accuracy}m · {deviceCtx.address}</span>
          <span className="text-slate-600 ml-auto">{new Date().toLocaleTimeString()}</span>
        </div>
      )}

      {/* Category grid */}
      <div>
        <p className="text-xs text-slate-500 font-mono mb-2">WHAT IS YOUR EMERGENCY?</p>
        <div className="grid grid-cols-2 gap-2">
          {SOS_CATEGORIES.map(cat => (
            <button key={cat.id}
              onClick={() => setCategory(cat.id)}
              className="relative flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 transition-all text-left"
              style={{
                borderColor: category===cat.id ? cat.color : "rgba(255,255,255,0.08)",
                background: category===cat.id ? `${cat.color}18` : "rgba(255,255,255,0.03)",
                boxShadow: category===cat.id ? `0 0 20px ${cat.color}30` : "none",
              }}>
              <span className="text-2xl flex-shrink-0">{cat.icon}</span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate" style={{ fontFamily:"monospace" }}>{cat.label}</p>
                <p className="text-xs font-mono capitalize" style={{ color:`${cat.color}90`, fontSize:10 }}>
                  {cat.urgency}
                </p>
              </div>
              {category===cat.id && (
                <div className="absolute top-1.5 right-1.5 w-3 h-3 rounded-full flex items-center justify-center"
                  style={{ background:cat.color }}>
                  <span style={{ fontSize:7, color:"white" }}>✓</span>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Note field — optional */}
      {category && (
        <div style={{ animation:"fadeInUp 0.25s ease" }}>
          <label className="text-xs text-slate-500 font-mono block mb-1.5">
            ADD DETAILS IF SAFE <span className="text-slate-700">(OPTIONAL)</span>
          </label>
          <textarea
            value={note} onChange={e=>setNote(e.target.value)}
            placeholder="e.g. 3 people, ground floor, east side of building…"
            rows={2}
            className="w-full bg-white/3 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-700 focus:outline-none focus:border-white/25 resize-none font-mono"
            style={{ borderColor: catDef ? `${catDef.color}30` : undefined }}
          />
          <p className="text-xs text-slate-700 font-mono mt-1">Do not delay sending for this field</p>
        </div>
      )}

      {/* Hold to send */}
      <HoldToSend
        onComplete={handleHoldComplete}
        disabled={!category || !deviceCtx}
        categoryColor={catDef?.color}
      />

      {offlineMode && (
        <div className="flex items-center gap-2 rounded-lg bg-purple-500/10 border border-purple-500/20 px-3 py-2">
          <span className="text-purple-400 text-xs">⚡</span>
          <p className="text-xs text-purple-300 font-mono">OFFLINE — message will queue and transmit on reconnect</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SOS REPORT CARD (feed)
// ─────────────────────────────────────────────────────────────────────────────
function SOSReportCard({ report: s }) {
  const [expanded, setExpanded] = useState(false);
  const catDef = SOS_CATEGORIES.find(c=>c.id===s.category);
  return (
    <div className={`rounded-xl border overflow-hidden ${URG_COLORS[s.urgency]}`}>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2">
            {catDef && <span className="text-base">{catDef.icon}</span>}
            <span className="text-xs font-mono font-bold">{s.urgency.toUpperCase()}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {s.offline && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono">QUEUED</span>}
            {s.insights && (
              <button onClick={()=>setExpanded(e=>!e)} className="text-xs px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 hover:bg-cyan-500/25 transition-colors font-mono">
                {expanded?"▲ HIDE":"▼ INSIGHTS"}
              </button>
            )}
            <span className="text-xs text-slate-500 font-mono">{timeAgo(s.ts)}</span>
          </div>
        </div>
        <p className="text-sm text-white/90 leading-snug mb-1">{s.msg}</p>
        <p className="text-xs text-slate-500">— {s.name}</p>
        {s.triage && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs font-mono text-slate-600">ETA {s.triage.responder_eta}</span>
            <span className="text-xs font-mono text-cyan-600 ml-auto">{s.offline?"QUEUED":"DISPATCHED"}</span>
          </div>
        )}
      </div>
      {expanded && s.insights && (
        <div className="border-t border-white/5 p-3 bg-black/20 flex flex-col gap-2">
          <p className="text-xs font-mono text-red-400">⚡ IMMEDIATE ACTIONS</p>
          {s.insights.immediateActions.slice(0,3).map((a,i)=>(
            <div key={i} className="flex gap-2 text-xs text-slate-300">
              <span className="text-red-600 font-mono">{i+1}.</span><span>{a}</span>
            </div>
          ))}
          <p className="text-xs font-mono text-yellow-400 mt-1">⚠ {s.insights.safetyWarning}</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE DATA FETCHING
// ─────────────────────────────────────────────────────────────────────────────
function nwsToDisaster(alert, idx) {
  const p=alert.properties||{}, geo=alert.geometry;
  let lat=36.5+Math.random()*2.8, lng=-122.5+Math.random()*3.5;
  if (geo?.type==="Point"){lat=geo.coordinates[1];lng=geo.coordinates[0];}
  else if (geo?.type==="Polygon"){lat=geo.coordinates[0][0][1];lng=geo.coordinates[0][0][0];}
  const ev=(p.event||"").toLowerCase();
  const type=ev.includes("fire")||ev.includes("red flag")?"wildfire":ev.includes("flood")?"flood":ev.includes("tornado")?"tornado":ev.includes("earthquake")?"earthquake":"flood";
  const sev=p.severity==="Extreme"?"critical":p.severity==="Severe"?"high":p.severity==="Moderate"?"medium":"low";
  return { id:`nws_${idx}_${Date.now()}`, type, lat:Math.max(32.5,Math.min(42,lat)), lng:Math.max(-124.5,Math.min(-114.1,lng)), name:(p.headline||p.event||"NWS Alert").slice(0,60), severity:sev, status:"active", ts:Date.now(), affectedPop:Math.floor(2000+Math.random()*18000), liveData:true, source:"NWS" };
}
function usgsToDisaster(f) {
  const p=f.properties||{}, mag=p.mag||0, [lng,lat]=f.geometry?.coordinates||[-120,37];
  const sev=mag>=6?"critical":mag>=5?"high":mag>=4?"medium":"low";
  return { id:`eq_${f.id||Date.now()}`, type:"earthquake", lat:Math.max(32.5,Math.min(42,lat)), lng:Math.max(-124.5,Math.min(-114.1,lng)), name:`M${mag.toFixed(1)} – ${(p.place||"California").slice(0,40)}`, severity:sev, depth:`${(f.geometry?.coordinates?.[2]||10).toFixed(1)}km`, aftershocks:0, status:"monitoring", ts:p.time||Date.now(), affectedPop:Math.floor(mag*4200), liveData:true, source:"USGS" };
}
async function fetchLiveAlerts() {
  const logs=[], incidents=[];
  try {
    logs.push("Querying NWS California alerts…");
    const r=await fetch("https://api.weather.gov/alerts/active?area=CA",{headers:{"Accept":"application/geo+json"},signal:AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    (data.features||[]).slice(0,8).forEach((f,i)=>incidents.push(nwsToDisaster(f,i)));
    logs.push(`✓ NWS: ${Math.min(8,(data.features||[]).length)} active alerts ingested`);
  } catch(e){logs.push(`⚠ NWS failed (${e.message})`);}
  try {
    logs.push("Querying USGS earthquakes (M2.5+, 24h)…");
    const r=await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",{signal:AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    const ca=(data.features||[]).filter(f=>{const[ln,la]=f.geometry?.coordinates||[];return la>=32.5&&la<=42&&ln>=-124.5&&ln<=-114.1;}).slice(0,6);
    ca.forEach(f=>incidents.push(usgsToDisaster(f)));
    logs.push(`✓ USGS: ${ca.length} CA earthquakes merged`);
  } catch(e){logs.push(`⚠ USGS failed (${e.message})`);}
  logs.push("NASA FIRMS: stubbed (CORS)"); logs.push("AQI: placeholder"); logs.push("Flood gauge: placeholder");
  return { incidents, logs };
}
async function generateAIBriefing(disasters, sosReports, mode="operational") {
  const rti=computeRTI(disasters,sosReports), critD=disasters.filter(d=>d.severity==="critical"), critS=sosReports.filter(s=>s.urgency==="critical"), totalPop=disasters.reduce((s,d)=>s+(d.affectedPop||0),0);
  const prompt=`You are a senior EOC analyst. Generate a command-center operational briefing.\n\nRTI: ${rti}/100, Active incidents: ${disasters.filter(d=>d.status==="active"||d.status==="warning").length} (${critD.length} critical), Population exposure: ${totalPop.toLocaleString()}, Critical SOS: ${critS.length}\nIncident types: ${[...new Set(disasters.map(d=>d.type))].join(", ")}\nTop incidents: ${critD.slice(0,3).map(d=>d.name).join("; ")||"none critical"}\n\nWrite 4-5 sentences covering: highest-risk regions, escalation risks, evacuation priorities, responder load, infrastructure stress. Professional EOC language. No bullet points.`;
  try {
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:500,messages:[{role:"user",content:prompt}]}),signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error("API");
    const data=await res.json(); return data.content[0].text.trim();
  } catch {
    return `RTI stands at ${rti}/100 with ${critD.length} critical event${critD.length!==1?"s":""} active. Total population exposure: ${totalPop.toLocaleString()} persons, ${critS.length} critical SOS pending response. ${critD[0]?"Primary concern: "+critD[0].name+". ":""}Responder load ${rti>=70?"near capacity — mutual aid recommended":"within parameters"}. Maintain standard ICS watch posture.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAFLET MAP
// ─────────────────────────────────────────────────────────────────────────────
function LeafletMap({ disasters, sosReports, selected, onSelect, layers, regionMode, newIds, globalMode }) {
  const mapRef=useRef(null), mapInst=useRef(null), markersRef=useRef({});
  const [L,setL]=useState(null), [locating,setLocating]=useState(false), [searchVal,setSearchVal]=useState(""), [searching,setSearching]=useState(false);

  useEffect(()=>{loadLeaflet().then(setL);},[]);
  useEffect(()=>{
    if (!L||!mapRef.current||mapInst.current) return;
    const rv=REGION_VIEWS[regionMode]||REGION_VIEWS.california;
    const map=L.map(mapRef.current,{center:rv.center,zoom:rv.zoom,zoomControl:false,attributionControl:false});
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{subdomains:"abcd",maxZoom:19}).addTo(map);
    L.control.zoom({position:"bottomright"}).addTo(map);
    mapInst.current=map;
    return ()=>{map.remove();mapInst.current=null;};
  },[L]);
  useEffect(()=>{ if(!mapInst.current) return; const rv=REGION_VIEWS[regionMode]||REGION_VIEWS.california; mapInst.current.setView(rv.center,rv.zoom,{animate:true,duration:0.8}); },[regionMode]);

  useEffect(()=>{
    if(!L||!mapInst.current) return;
    const map=mapInst.current;
    Object.values(markersRef.current).forEach(m=>m.remove()); markersRef.current={};
    const sevHex={critical:"#ef4444",high:"#f97316",medium:"#eab308",low:"#22c55e"};

    if (layers.incidents) {
      disasters.forEach(d=>{
        const color=sevHex[d.severity]||"#94a3b8", isNew=newIds.includes(d.id), isSel=selected?.id===d.id, size=isSel?32:24;
        const pulse=(d.severity==="critical"||isNew)?`<span style="position:absolute;inset:-6px;border-radius:50%;background:${color};opacity:0.2;animation:markerPulse 1.8s ease-in-out infinite"/>`:""        ;
        const icon=L.divIcon({className:"",html:`<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(6,14,28,0.9);border:2px solid ${color};box-shadow:0 0 ${isSel?16:8}px ${color}60;cursor:pointer">${pulse}<span style="font-size:${size*0.45}px;line-height:1">${INCIDENT_ICONS[d.type]||"⚠️"}</span>${d.liveData?`<span style="position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#06b6d4;border:1px solid #0a1628"></span>`:""}</div>`,iconSize:[size,size],iconAnchor:[size/2,size/2]});
        const esc=predictEscalation(d);
        const marker=L.marker([d.lat,d.lng],{icon}).addTo(map);
        marker.bindPopup(L.popup({className:"storm-popup",maxWidth:260,closeButton:false}).setContent(`<div style="font-family:monospace;font-size:12px;color:#e2e8f0;background:#0a1628;border:1px solid ${color}40;border-radius:8px;padding:12px;min-width:200px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:16px">${INCIDENT_ICONS[d.type]||"⚠️"}</span><span style="color:${color};font-weight:700;font-size:10px;text-transform:uppercase">${d.severity}</span>${d.liveData?`<span style="margin-left:auto;color:#06b6d4;font-size:10px">●LIVE·${d.source}</span>`:""}</div><div style="font-weight:600;font-size:13px;margin-bottom:4px;color:#f1f5f9">${d.name}</div><div style="color:#64748b;font-size:10px;margin-bottom:8px">${d.status.toUpperCase()}·${timeAgo(d.ts)}</div><div style="background:rgba(255,255,255,0.04);border-radius:4px;padding:6px"><div style="color:#94a3b8;font-size:9px;margin-bottom:2px">ESCALATION RISK</div><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:4px;background:rgba(255,255,255,0.1);border-radius:2px"><div style="height:100%;background:${esc.pct>=70?"#ef4444":esc.pct>=45?"#f97316":"#eab308"};width:${esc.pct}%;border-radius:2px"></div></div><span style="color:${esc.pct>=70?"#ef4444":esc.pct>=45?"#f97316":"#eab308"};font-size:10px;font-weight:700">${esc.pct}%</span></div></div><div style="color:#475569;font-size:9px;margin-top:6px">👥${(d.affectedPop||0).toLocaleString()} at risk</div></div>`));
        marker.on("click",()=>onSelect&&onSelect(d));
        markersRef.current[`d_${d.id}`]=marker;
      });
    }

    if (layers.sos && !globalMode) {
      sosReports.forEach(s=>{
        const catDef=SOS_CATEGORIES.find(c=>c.id===s.category);
        const color=s.urgency==="critical"?"#dc2626":s.urgency==="high"?"#ea580c":"#eab308";
        const icon=L.divIcon({className:"",html:`<div style="position:relative;width:24px;height:24px;background:${color};border:2px solid white;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:${s.offline?0.65:1}"><span style="font-size:11px">${catDef?.icon||"🆘"}</span></div>`,iconSize:[24,24],iconAnchor:[12,12]});
        const marker=L.marker([s.lat,s.lng],{icon}).addTo(map);
        marker.bindPopup(L.popup({className:"storm-popup",closeButton:false,maxWidth:240}).setContent(`<div style="font-family:monospace;font-size:12px;color:#e2e8f0;background:#0a1628;border:1px solid ${color}40;border-radius:8px;padding:10px"><div style="color:${color};font-weight:700;font-size:10px;margin-bottom:4px">${s.urgency.toUpperCase()}${s.offline?" · ⚡OFFLINE":""}</div>${catDef?`<div style="color:#94a3b8;font-size:10px;margin-bottom:4px">${catDef.icon} ${catDef.label}</div>`:""}<div style="font-size:12px;margin-bottom:4px;color:#f1f5f9">${s.msg.replace(/^[^·]+· /,"")}</div><div style="color:#64748b;font-size:10px">— ${s.name} · ${timeAgo(s.ts)}</div></div>`));
        markersRef.current[`s_${s.id}`]=marker;
      });
    }

    // Safe zones layer (when SOS active)
    if (layers.sos) {
      SAFE_ZONES.filter(z=>z.open).forEach((z,i)=>{
        const icon=L.divIcon({className:"",html:`<div style="width:20px;height:20px;background:#166534;border:2px solid #22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center"><span style="font-size:9px">🏥</span></div>`,iconSize:[20,20],iconAnchor:[10,10]});
        markersRef.current[`sz_${i}`]=L.marker([z.lat,z.lng],{icon}).addTo(map).bindPopup(`<div style="font-family:monospace;font-size:12px;color:#e2e8f0;background:#0a1628;padding:10px;border-radius:8px"><div style="color:#22c55e;font-size:10px;font-weight:700;margin-bottom:4px">🏥 SAFE ZONE</div><div style="color:#f1f5f9">${z.name}</div><div style="color:#64748b;font-size:10px">Cap: ${z.capacity.toLocaleString()} · ${z.type}</div></div>`);
      });
    }
  },[L,disasters,sosReports,selected,layers,newIds,globalMode]);

  const handleGeolocate=()=>{
    if(!mapInst.current||locating) return; setLocating(true);
    navigator.geolocation.getCurrentPosition(pos=>{mapInst.current.flyTo([pos.coords.latitude,pos.coords.longitude],11,{duration:1.5});setLocating(false);},()=>setLocating(false),{timeout:8000});
  };
  const handleSearch=async(e)=>{
    e.preventDefault(); if(!searchVal.trim()||!mapInst.current) return;
    const m=searchVal.match(/^(-?\d+\.?\d*)[, ]+(-?\d+\.?\d*)$/);
    if (m){mapInst.current.flyTo([parseFloat(m[1]),parseFloat(m[2])],10,{duration:1.2});setSearchVal("");return;}
    setSearching(true);
    try {const res=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchVal)}&format=json&limit=1`,{headers:{"User-Agent":"StormLink/1.0"},signal:AbortSignal.timeout(6000)});const data=await res.json();if(data[0]){mapInst.current.flyTo([parseFloat(data[0].lat),parseFloat(data[0].lon)],11,{duration:1.2});setSearchVal("");}} catch{}
    setSearching(false);
  };

  const heatmapPoints=useMemo(()=>!layers.heatmap?[]:disasters.map(d=>({lat:d.lat,lng:d.lng,severity:d.severity})).concat(sosReports.filter(s=>s.urgency==="critical").map(s=>({lat:s.lat,lng:s.lng,severity:"critical"}))),[disasters,sosReports,layers.heatmap]);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-white/10 bg-[#0a1628]">
      <div ref={mapRef} className="absolute inset-0" style={{zIndex:1}}/>
      {layers.heatmap&&L&&mapInst.current&&<HeatmapOverlay map={mapInst.current} L={L} points={heatmapPoints}/>}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <form onSubmit={handleSearch} className="flex gap-1.5">
          <input value={searchVal} onChange={e=>setSearchVal(e.target.value)} placeholder="City, ZIP, or lat,lng…" className="bg-black/80 border border-white/20 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/60 font-mono w-40 backdrop-blur-sm"/>
          <button type="submit" disabled={searching} className="bg-black/80 border border-white/20 rounded-lg px-2.5 py-1.5 text-xs text-cyan-400 hover:bg-white/10 font-mono backdrop-blur-sm disabled:opacity-50">{searching?"…":"↗"}</button>
        </form>
        <button onClick={handleGeolocate} disabled={locating} className="self-start bg-black/80 border border-white/20 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 font-mono backdrop-blur-sm">{locating?"⏳…":"◎ MY LOCATION"}</button>
      </div>
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 bg-black/70 backdrop-blur-sm rounded-md px-2 py-1 border border-white/10">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
        <span className="text-xs text-green-400 font-mono">LIVE</span>
      </div>
      {!L&&<div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0a1628]"><div className="flex flex-col items-center gap-3"><div className="w-8 h-8 border-2 border-cyan-500/40 border-t-cyan-400 rounded-full animate-spin"/><span className="text-xs text-slate-500 font-mono">LOADING MAP…</span></div></div>}
      <style>{`.leaflet-popup-content-wrapper,.leaflet-popup-tip{background:transparent!important;box-shadow:none!important;padding:0!important;}.leaflet-popup-content{margin:0!important;}@keyframes markerPulse{0%,100%{opacity:0.25;transform:scale(1)}50%{opacity:0.08;transform:scale(1.4)}}`}</style>
    </div>
  );
}

function HeatmapOverlay({ map, L, points }) {
  const canvasRef=useRef(null);
  const sevAlpha={critical:"rgba(239,68,68,",high:"rgba(249,115,22,",medium:"rgba(234,179,8,",low:"rgba(34,197,94,"};
  const redraw=useCallback(()=>{
    if(!canvasRef.current) return;
    const canvas=canvasRef.current, {x,y}=map.getSize();
    canvas.width=x; canvas.height=y;
    const ctx=canvas.getContext("2d"); ctx.clearRect(0,0,x,y);
    points.forEach(pt=>{
      try {
        const px=map.latLngToContainerPoint([pt.lat,pt.lng]), r=80;
        const grd=ctx.createRadialGradient(px.x,px.y,0,px.x,px.y,r);
        const base=sevAlpha[pt.severity]||"rgba(239,68,68,";
        grd.addColorStop(0,base+"0.28)"); grd.addColorStop(0.4,base+"0.14)"); grd.addColorStop(1,base+"0)");
        ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(px.x,px.y,r,0,Math.PI*2); ctx.fill();
      } catch {}
    });
  },[map,points]);
  useEffect(()=>{ redraw(); map.on("move zoom",redraw); return ()=>map.off("move zoom",redraw); },[map,redraw]);
  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{zIndex:400,opacity:0.7,mixBlendMode:"screen"}}/>;
}

function LayerToggles({ layers, setLayers }) {
  const LAYER_DEFS=[
    {key:"incidents",icon:"🔥",label:"Incidents",color:"text-orange-300"},
    {key:"sos",icon:"🆘",label:"SOS + Zones",color:"text-red-300"},
    {key:"heatmap",icon:"🌡",label:"Heatmap",color:"text-yellow-300"},
    {key:"earthquakes",icon:"⚡",label:"Earthquakes",color:"text-purple-300"},
    {key:"weather",icon:"🌩",label:"Weather",color:"text-blue-300"},
    {key:"wildfires",icon:"🛰",label:"FIRMS",color:"text-red-400",stub:true},
    {key:"airquality",icon:"💨",label:"AQI",color:"text-green-300",stub:true},
    {key:"floods",icon:"🌊",label:"Floods",color:"text-cyan-300",stub:true},
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {LAYER_DEFS.map(l=>(
        <button key={l.key} onClick={()=>setLayers(p=>({...p,[l.key]:!p[l.key]}))}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-mono transition-all ${layers[l.key]?`bg-white/10 border-white/20 ${l.color}`:"bg-white/3 border-white/8 text-slate-600 line-through"}`}>
          <span>{l.icon}</span><span>{l.label}</span>{l.stub&&<span className="text-slate-600 ml-0.5">stub</span>}
        </button>
      ))}
    </div>
  );
}

function RTIGauge({ rti, breakdown }) {
  const color=rti>=80?"#ef4444":rti>=60?"#f97316":rti>=40?"#eab308":"#22c55e";
  const label=rti>=80?"CRITICAL":rti>=60?"HIGH":rti>=40?"ELEVATED":"MODERATE";
  const r=38,cx=50,cy=54,circ=Math.PI*r,offset=circ*(1-rti/100);
  const FACTORS=[{k:"Incident Severity",w:"30%",v:breakdown[0]},{k:"Incident Density",w:"20%",v:breakdown[1]},{k:"SOS Density",w:"15%",v:breakdown[2]},{k:"Population Exposure",w:"15%",v:breakdown[3]},{k:"Environmental",w:"10%",v:breakdown[4]},{k:"Infrastructure Fail.",w:"10%",v:breakdown[5]}];
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between"><span className="text-xs font-mono text-slate-500">REGIONAL THREAT INDEX</span><span className="text-xs font-mono" style={{color}}>RTI FORMULA</span></div>
      <div className="flex items-center gap-4">
        <svg width="100" height="62" viewBox="0 0 100 62" className="flex-shrink-0">
          <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7" strokeLinecap="round"/>
          <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} style={{transition:"stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1),stroke 0.6s"}}/>
          <text x={cx} y={cy-6} textAnchor="middle" fill="white" fontSize="22" fontWeight="700" style={{fontFamily:"monospace"}}>{rti}</text>
          <text x={cx} y={cy+6} textAnchor="middle" fontSize="7" fill={color} style={{fontFamily:"monospace"}}>{label}</text>
        </svg>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          {FACTORS.map((f,i)=>(
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-slate-600 font-mono text-xs w-4 text-right">{f.w}</span>
              <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-700" style={{width:`${Math.min(100,f.v||0)}%`,background:`${color}90`}}/></div>
              <span className="text-slate-500 font-mono truncate" style={{maxWidth:80,fontSize:9}}>{f.k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EscalationCard({ disaster }) {
  const esc=predictEscalation(disaster);
  const color=esc.pct>=70?"#ef4444":esc.pct>=45?"#f97316":"#eab308";
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-3">
      <div className="flex items-center justify-between mb-2"><span className="text-xs font-mono text-slate-500">PREDICTIVE ESCALATION</span><span className="text-xs font-mono" style={{color}}>{esc.label}</span></div>
      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-700" style={{width:`${esc.pct}%`,background:`linear-gradient(90deg,${color}60,${color})`}}/></div>
        <span className="text-sm font-bold font-mono" style={{color}}>{esc.pct}%</span>
      </div>
      <div className="flex gap-3 text-xs font-mono"><span className="text-slate-500">Model: <span className="text-slate-300 capitalize">{esc.model}</span></span><span className="text-slate-500">Spread: <span className="text-slate-300">{esc.spread}</span></span></div>
      {esc.pct>=60&&<div className="mt-2 text-xs text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg px-2 py-1.5 font-mono">⚠ Escalation likely — pre-position resources</div>}
    </div>
  );
}

function TimelineReplay({ disasters, sosReports, onSnapshotChange }) {
  const [playing,setPlaying]=useState(false), [frame,setFrame]=useState(24);
  const timeline=useMemo(()=>buildTimeline(disasters,sosReports),[disasters,sosReports]);
  const timerRef=useRef(null);
  useEffect(()=>{ const snap=timeline[frame]; if(snap) onSnapshotChange(snap); },[frame,timeline]);
  useEffect(()=>{
    if(playing){timerRef.current=setInterval(()=>setFrame(f=>{if(f>=24){setPlaying(false);return 24;}return f+1;}),600);}
    else clearInterval(timerRef.current);
    return ()=>clearInterval(timerRef.current);
  },[playing]);
  const snap=timeline[frame], rti=computeRTI(snap?.disasters||[],snap?.sos||[]);
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between"><span className="text-xs font-mono text-slate-500">TIMELINE REPLAY · PAST 24H</span><span className={`text-xs font-mono ${frame===24?"text-green-400":"text-cyan-300"}`}>{frame===24?"● LIVE":snap?.label}</span></div>
      <div className="flex items-center gap-3">
        <button onClick={()=>{setPlaying(p=>!p);if(frame>=24)setFrame(0);}} className={`px-3 py-1 rounded-lg border text-xs font-mono transition-all ${playing?"bg-orange-500/20 text-orange-300 border-orange-500/30":"bg-cyan-500/10 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/20"}`}>{playing?"⏸ PAUSE":"▶ REPLAY"}</button>
        <button onClick={()=>{setPlaying(false);setFrame(24);}} className="px-2 py-1 rounded-lg border text-xs font-mono text-slate-400 border-white/10 hover:bg-white/8">⬛ LIVE</button>
        <div className="flex-1 flex flex-col gap-1">
          <input type="range" min={0} max={24} value={frame} step={1} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value));}} className="w-full accent-cyan-400"/>
          <div className="flex justify-between text-xs text-slate-700 font-mono"><span>-24h</span><span>-12h</span><span>NOW</span></div>
        </div>
      </div>
      {snap&&(
        <div className="grid grid-cols-4 gap-2">
          {[{k:"INCIDENTS",v:snap.disasters.length,c:"text-white"},{k:"CRITICAL",v:snap.disasters.filter(d=>d.severity==="critical").length,c:"text-red-400"},{k:"SOS",v:snap.sos.length,c:"text-purple-300"},{k:"RTI",v:rti,c:rti>=70?"text-red-400":rti>=50?"text-orange-300":"text-yellow-300"}].map((s,i)=>(
            <div key={i} className="bg-white/5 rounded-lg p-2 text-center"><p className="text-xs text-slate-600 font-mono" style={{fontSize:9}}>{s.k}</p><p className={`text-lg font-bold ${s.c}`}>{s.v}</p></div>
          ))}
        </div>
      )}
    </div>
  );
}

function GlobalCrisisPanel({ disasters, sosReports }) {
  const REGIONS=[{name:"Western US",lat:37.5,lng:-120,color:"#ef4444"},{name:"Eastern US",lat:38.9,lng:-77,color:"#f97316"},{name:"Central US",lat:38,lng:-96,color:"#eab308"},{name:"Gulf Coast",lat:29.5,lng:-90,color:"#f97316"},{name:"Pacific NW",lat:47.5,lng:-122,color:"#eab308"}];
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4">
      <div className="flex items-center justify-between mb-3"><span className="text-xs font-mono text-slate-500">GLOBAL CRISIS OVERVIEW</span><span className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/25 font-mono">🌐 GLOBAL</span></div>
      <div className="flex flex-col gap-2">
        {REGIONS.map((r,i)=>{
          const rDis=disasters.filter(d=>haversine(d.lat,d.lng,r.lat,r.lng)<800), rSOS=sosReports.filter(s=>haversine(s.lat,s.lng,r.lat,r.lng)<800), rti=computeRTI(rDis,rSOS);
          if(rDis.length===0&&rSOS.length===0) return null;
          return (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/3 px-3 py-2">
              <div className="w-2 h-2 rounded-full" style={{background:r.color}}/><span className="text-xs text-white font-mono flex-1">{r.name}</span>
              <span className="text-xs text-slate-500 font-mono">{rDis.length} incidents</span>
              <span className="text-xs text-purple-300 font-mono">{rSOS.length} SOS</span>
              <div className="flex items-center gap-1.5"><div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden"><div style={{width:`${rti}%`,background:r.color,height:"100%",borderRadius:"9999px",transition:"width 0.8s"}}/></div><span className="text-xs font-mono" style={{color:r.color}}>RTI {rti}</span></div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-600 font-mono mt-2">⚠ Individual SOS locations anonymized in global mode</p>
    </div>
  );
}

function TypedText({ text, speed=20, className="" }) {
  const [typed,setTyped]=useState(""), [done,setDone]=useState(false);
  useEffect(()=>{ setTyped("");setDone(false);let i=0; const iv=setInterval(()=>{i+=3;setTyped(text.slice(0,i));if(i>=text.length){setDone(true);clearInterval(iv);}},speed); return()=>clearInterval(iv); },[text,speed]);
  return <p className={className}>{typed}{!done&&<span className="inline-block w-1 h-4 bg-cyan-400 ml-0.5 animate-pulse align-middle rounded-sm"/>}</p>;
}

function LivePulsePanel({ state, onClose }) {
  const { status, logs, briefing, newCount, riskDelta }=state;
  const logRef=useRef(null);
  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; },[logs.length]);
  return (
    <div className="rounded-2xl border border-cyan-500/30 bg-[#060e1c] overflow-hidden" style={{animation:"fadeInUp 0.4s ease"}}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-cyan-500/20 bg-cyan-500/5">
        <span className={`w-2 h-2 rounded-full ${status==="loading"?"bg-cyan-400 animate-pulse":status==="done"?"bg-green-400":"bg-yellow-400"}`}/>
        <span className="text-xs font-mono text-cyan-300 font-bold">{status==="loading"?"LIVE CRISIS PULSE — FETCHING…":"LIVE CRISIS PULSE — COMPLETE"}</span>
        {newCount>0&&<span className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono ml-auto">+{newCount} NEW</span>}
        {riskDelta!==0&&<span className={`text-xs px-2 py-0.5 rounded font-mono ${riskDelta>0?"bg-red-500/20 text-red-300 border border-red-500/30":"bg-green-500/20 text-green-300 border border-green-500/30"}`}>RTI {riskDelta>0?"+":""}{riskDelta}</span>}
        <button onClick={onClose} className="text-slate-500 hover:text-white text-base ml-auto">×</button>
      </div>
      <div className="grid grid-cols-[1fr_1fr] divide-x divide-white/5">
        <div className="p-4 flex flex-col gap-2">
          <p className="text-xs font-mono text-slate-500 mb-1">INGESTION LOG</p>
          <div ref={logRef} className="flex flex-col gap-1.5 max-h-44 overflow-auto">
            {logs.map((l,i)=><div key={i} className="flex gap-2 text-xs font-mono"><span className="text-slate-600">{l.startsWith("✓")?"✓":l.startsWith("⚠")?"⚠":"›"}</span><span className={l.startsWith("✓")?"text-green-400":l.startsWith("⚠")?"text-yellow-400":"text-slate-400"}>{l}</span></div>)}
            {status==="loading"&&<div className="flex gap-2 text-xs font-mono text-cyan-400 animate-pulse"><span>›</span><span>Awaiting response…</span></div>}
          </div>
        </div>
        <div className="p-4 flex flex-col gap-2">
          <p className="text-xs font-mono text-slate-500 mb-1">LIVE BRIEFING</p>
          {briefing?<TypedText text={briefing} speed={20} className="text-sm text-slate-300 leading-relaxed"/>:<div className="text-xs text-slate-600 font-mono animate-pulse">Generating…</div>}
        </div>
      </div>
    </div>
  );
}

function AISummaryPanel({ disaster, overrideSummary, onClose }) {
  const [typed,setTyped]=useState(""), [done,setDone]=useState(false);
  const summary=overrideSummary||MOCK_AI_SUMMARIES[disaster.id]||MOCK_AI_SUMMARIES[1];
  const sc=SEV_COLORS[disaster.severity]||SEV_COLORS.critical;
  useEffect(()=>{ setTyped("");setDone(false);const text=summary.body;let i=0; const iv=setInterval(()=>{i+=overrideSummary?4:3;setTyped(text.slice(0,i));if(i>=text.length){setDone(true);clearInterval(iv);}},16); return()=>clearInterval(iv); },[disaster.id,summary.body]);
  return (
    <div className="flex flex-col gap-4 h-full overflow-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-lg">{INCIDENT_ICONS[disaster.type]||"⚠️"}</span>
            <span className={`text-xs font-mono px-2 py-0.5 rounded border ${sc.bg} ${sc.text} ${sc.border}`}>{disaster.severity.toUpperCase()}</span>
            {disaster.liveData&&<span className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">LIVE·{disaster.source}</span>}
            <span className="text-xs text-slate-500 font-mono">{timeAgo(disaster.ts)}</span>
          </div>
          <h2 className="text-white font-semibold text-sm leading-snug">{disaster.name}</h2>
        </div>
        {onClose&&<button onClick={onClose} className="text-slate-500 hover:text-white text-lg">×</button>}
      </div>
      {disaster.type==="wildfire"&&disaster.wind&&(
        <div className="flex gap-4 justify-center py-2 border-y border-white/5">
          <div className="flex flex-col items-center gap-1"><div style={{width:72,height:72,position:"relative"}}><svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5"/><circle cx="36" cy="36" r="28" fill="none" stroke="#f97316" strokeWidth="5" strokeDasharray={2*Math.PI*28} strokeDashoffset={2*Math.PI*28*(1-Math.min(disaster.wind,80)/80)} strokeLinecap="round" transform="rotate(-90 36 36)" style={{transition:"stroke-dashoffset 1s"}}/><text x="36" y="33" textAnchor="middle" fill="white" fontSize="11" fontWeight="600">{disaster.wind}</text><text x="36" y="44" textAnchor="middle" fill="#64748b" fontSize="7">mph</text></svg></div><span className="text-xs text-slate-400">Wind</span></div>
          <div className="flex flex-col items-center gap-1"><div style={{width:72,height:72}}><svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5"/><circle cx="36" cy="36" r="28" fill="none" stroke="#38bdf8" strokeWidth="5" strokeDasharray={2*Math.PI*28} strokeDashoffset={2*Math.PI*28*(1-(disaster.humidity||20)/100)} strokeLinecap="round" transform="rotate(-90 36 36)" style={{transition:"stroke-dashoffset 1s"}}/><text x="36" y="33" textAnchor="middle" fill="white" fontSize="11" fontWeight="600">{disaster.humidity||"—"}</text><text x="36" y="44" textAnchor="middle" fill="#64748b" fontSize="7">% RH</text></svg></div><span className="text-xs text-slate-400">Humidity</span></div>
          {disaster.temp&&<div className="flex flex-col items-center gap-1"><div style={{width:72,height:72}}><svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5"/><circle cx="36" cy="36" r="28" fill="none" stroke="#ef4444" strokeWidth="5" strokeDasharray={2*Math.PI*28} strokeDashoffset={2*Math.PI*28*(1-disaster.temp/120)} strokeLinecap="round" transform="rotate(-90 36 36)" style={{transition:"stroke-dashoffset 1s"}}/><text x="36" y="33" textAnchor="middle" fill="white" fontSize="11" fontWeight="600">{disaster.temp}</text><text x="36" y="44" textAnchor="middle" fill="#64748b" fontSize="7">°F</text></svg></div><span className="text-xs text-slate-400">Temp</span></div>}
        </div>
      )}
      <EscalationCard disaster={disaster}/>
      <div className={`rounded-lg border p-3 ${sc.bg} ${sc.border}`}><div className="flex items-center gap-2 mb-1.5"><span className="text-xs font-mono text-slate-400">AI ASSESSMENT</span><span className="text-xs text-slate-400 ml-auto">Conf <span className={`font-mono ${sc.text}`}>{summary.confidence}%</span></span></div><p className={`text-sm font-semibold ${sc.text}`}>{summary.headline}</p></div>
      <div className="text-sm text-slate-300 leading-relaxed">{typed}{!done&&<span className="inline-block w-1.5 h-4 bg-cyan-400 ml-0.5 animate-pulse align-middle rounded-sm"/>}</div>
      {done&&<div className="border-t border-white/5 pt-3"><p className="text-xs font-mono text-slate-500 mb-2">RECOMMENDED ACTIONS</p><div className="flex flex-col gap-1.5">{summary.actions.map((a,i)=><div key={i} className="flex items-start gap-2 text-xs text-slate-300"><span className={`mt-0.5 font-mono ${sc.text}`}>{String(i+1).padStart(2,"0")}</span><span>{a}</span></div>)}</div></div>}
    </div>
  );
}

function AIBriefingPanel({ disasters, sosReports, mode }) {
  const [briefing,setBriefing]=useState(""), [loading,setLoading]=useState(false), [typed,setTyped]=useState(""), [done,setDone]=useState(false);
  const rti=computeRTI(disasters,sosReports), rtiColor=rti>=70?"text-red-400":rti>=50?"text-orange-300":"text-yellow-300";
  const generate=async()=>{
    setLoading(true);setBriefing("");setTyped("");setDone(false);
    const text=await generateAIBriefing(disasters,sosReports,mode);
    setBriefing(text);setLoading(false);let i=0;
    const iv=setInterval(()=>{i+=3;setTyped(text.slice(0,i));if(i>=text.length){setDone(true);clearInterval(iv);}},18);
  };
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between"><span className="text-xs font-mono text-slate-500">AI OPERATIONAL BRIEFING</span><span className={`text-xs font-mono ${rtiColor}`}>RTI {rti}/100</span></div>
      {!briefing&&!loading&&<button onClick={generate} className="w-full py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono font-semibold hover:bg-cyan-500/20 transition-colors">🤖 GENERATE AI BRIEFING</button>}
      {loading&&<div className="flex items-center gap-2 text-xs text-cyan-400 font-mono py-2"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"/>Generating command-center briefing…</div>}
      {briefing&&<div className="flex flex-col gap-3"><div className="text-sm text-slate-300 leading-relaxed">{typed}{!done&&<span className="inline-block w-1 h-4 bg-cyan-400 ml-0.5 animate-pulse align-middle rounded-sm"/>}</div>{done&&<div className="flex gap-2"><button onClick={generate} className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/8 text-xs font-mono">↻ Regenerate</button></div>}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION OVERLAY
// ─────────────────────────────────────────────────────────────────────────────
function SimOverlay({ elapsed, phase, phaseLabel, phaseColor, logs, riskScore, offlineActive, queuedCount, onStop, showBriefing, simDisasters, simSOS }) {
  const logRef=useRef(null), pc=PHASE_COLORS[phaseColor]||PHASE_COLORS.cyan, progress=Math.min(elapsed/60,1);
  const allSOS=[...INITIAL_SOS,...simSOS].filter((s,i,arr)=>arr.findIndex(x=>x.id===s.id)===i);
  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; },[logs.length]);
  const rti=riskScore;

  return (
    <div className="fixed inset-0 z-50 bg-[#030912]/96 backdrop-blur-md flex flex-col" style={{fontFamily:"'IBM Plex Mono',monospace"}}>
      <div className="flex items-center gap-4 px-6 py-3 border-b bg-black/50" style={{borderColor:pc.glow+"60",boxShadow:`0 0 40px ${pc.glow}18`}}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-sm">⚡</div>
          <span className="text-white font-bold text-sm tracking-widest">STORM<span className="text-cyan-400">LINK</span></span>
          <span className="text-slate-600 text-xs pl-2.5 ml-0.5 border-l border-white/10">CRISIS SIMULATION</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border ml-4" style={{borderColor:pc.glow+"60",background:pc.glow+"14"}}>
          <span className="w-2 h-2 rounded-full animate-pulse" style={{background:pc.glow}}/><span className="text-xs font-mono font-bold" style={{color:pc.glow}}>{phaseLabel}</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-xs text-slate-500 font-mono">T+{String(Math.floor(elapsed/60)).padStart(2,"0")}:{String(elapsed%60).padStart(2,"0")} / 01:00</span>
          <button onClick={onStop} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white text-xs font-mono">✕ END</button>
        </div>
      </div>
      <div className="h-0.5 bg-white/5"><div className="h-full transition-all duration-1000 ease-linear" style={{width:`${progress*100}%`,background:`linear-gradient(90deg,${pc.glow}60,${pc.glow})`}}/></div>
      <div className="flex flex-1 overflow-hidden divide-x divide-white/5">
        <div className="w-[380px] flex flex-col overflow-hidden">
          <div className="p-4 flex flex-col gap-3 flex-1 min-h-0">
            <div className="flex items-center justify-between"><span className="text-xs text-slate-500 font-mono">INCIDENT MAP · {simDisasters.length}</span><span className={`text-xs font-mono ${offlineActive?"text-purple-300":"text-green-400"}`}>{offlineActive?"⚡ OFFLINE":"● LIVE"}</span></div>
            <div className="flex-1 min-h-[220px]"><LeafletMap disasters={simDisasters} sosReports={allSOS} selected={null} onSelect={()=>{}} layers={{incidents:true,sos:true,heatmap:true,earthquakes:true,weather:false,wildfires:false,airquality:false,floods:false}} regionMode="california" newIds={[]} globalMode={false}/></div>
          </div>
          <div className="border-t border-white/5 p-4">
            <RTIGauge rti={rti} breakdown={[rti,Math.min(100,simDisasters.filter(d=>d.status==="active").length*14),Math.min(100,allSOS.filter(s=>s.urgency==="critical").length*18),Math.min(100,simDisasters.reduce((s,d)=>s+(d.affectedPop||0),0)/800),60,30]}/>
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between flex-shrink-0"><span className="text-xs text-slate-500 font-mono">COMMAND EVENT LOG</span><span className="text-xs text-slate-700 font-mono">{logs.length} EVENTS</span></div>
          <div ref={logRef} className="flex-1 overflow-auto p-4 flex flex-col gap-2">
            {logs.map((log,i)=>{const isNew=i===logs.length-1;const rs=log.type==="sos"?"bg-red-500/8 border-red-500/25 text-red-200":log.type==="incident"?"bg-orange-500/8 border-orange-500/25 text-orange-200":log.type==="offline"?"bg-purple-500/8 border-purple-500/25 text-purple-200":log.type==="risk"?"bg-yellow-500/5 border-yellow-500/20 text-yellow-200":log.type==="phase"?"border-white/15 text-white bg-white/5":"bg-white/3 border-white/8 text-slate-400";return <div key={i} className={`flex gap-3 text-xs font-mono rounded-lg px-3 py-2 border ${rs}`} style={isNew?{animation:"fadeInUp 0.35s ease"}:{}}><span className="text-slate-600 flex-shrink-0">{log.timestamp}</span><span className="flex-1 leading-relaxed">{log.msg}</span></div>;})}
            {logs.length===0&&<div className="text-center text-slate-700 font-mono text-xs py-8">AWAITING EVENTS…</div>}
          </div>
        </div>
        <div className="w-[360px] flex flex-col overflow-hidden">
          {!showBriefing?(
            <>
              <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between flex-shrink-0"><span className="text-xs text-slate-500 font-mono">SOS · {allSOS.length}</span>{offlineActive&&<span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono animate-pulse">⚡ {queuedCount} QUEUED</span>}</div>
              <div className="flex-1 overflow-auto p-4 flex flex-col gap-2.5">
                {allSOS.map((s,i)=>{const catDef=SOS_CATEGORIES.find(c=>c.id===s.category);return(<div key={s.id} className={`rounded-xl border p-3 ${URG_COLORS[s.urgency]}`} style={i<3?{animation:"fadeInUp 0.4s ease"}:{}}><div className="flex justify-between mb-1.5"><div className="flex items-center gap-1.5">{catDef&&<span>{catDef.icon}</span>}<span className="text-xs font-mono font-bold">{s.urgency.toUpperCase()}</span></div><div className="flex gap-2">{s.offline&&<span className="text-xs text-purple-300 font-mono">⚡</span>}<span className="text-xs text-slate-500">{timeAgo(s.ts)}</span></div></div><p className="text-sm text-white/90 leading-snug mb-1">{s.msg}</p><p className="text-xs text-slate-500">— {s.name}</p></div>);} )}
              </div>
            </>
          ):(
            <>
              <div className="px-5 py-3 border-b border-cyan-500/30 flex items-center gap-2 bg-cyan-500/5 flex-shrink-0"><span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"/><span className="text-xs text-cyan-300 font-mono font-bold">AI FINAL BRIEFING</span></div>
              <div className="flex-1 overflow-auto p-4"><AISummaryPanel disaster={{id:"sim",type:"wildfire",name:"Multi-Vector Fire + Tornado Event",severity:"critical",wind:67,humidity:3,temp:108,ts:Date.now()}} overrideSummary={SIM_BRIEFING}/></div>
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes fadeInUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function StormLink() {
  const [disasters,setDisasters]=useState(INITIAL_DISASTERS);
  const [sosReports,setSosReports]=useState(INITIAL_SOS);
  const [selected,setSelected]=useState(null);
  const [panel,setPanel]=useState("map");
  const [offlineMode,setOfflineMode]=useState(false);
  const [queuedCount,setQueuedCount]=useState(0);
  const [showSOSForm,setShowSOSForm]=useState(false);
  const [syncing,setSyncing]=useState(false);
  const [newIncidentIds,setNewIncidentIds]=useState([]);
  const [pulseState,setPulseState]=useState(null);
  const [pulseLoading,setPulseLoading]=useState(false);
  const [regionMode,setRegionMode]=useState("california");
  const [globalMode,setGlobalMode]=useState(false);
  const [layers,setLayers]=useState({incidents:true,sos:true,heatmap:true,earthquakes:true,weather:false,wildfires:false,airquality:false,floods:false});
  const [replaySnapshot,setReplaySnapshot]=useState(null);
  const displayDisasters=replaySnapshot?replaySnapshot.disasters:disasters;
  const displaySOS=replaySnapshot?replaySnapshot.sos:sosReports;
  const rti=useMemo(()=>computeRTI(displayDisasters,displaySOS),[displayDisasters,displaySOS]);
  const rtiBreakdown=useMemo(()=>{
    const sevScore={critical:100,high:70,medium:40,low:15},d=displayDisasters,s=displaySOS;
    return [d.length?d.reduce((a,x)=>a+(sevScore[x.severity]||20),0)/d.length:0,Math.min(100,d.filter(x=>x.status==="active"||x.status==="warning").length*14),Math.min(100,s.filter(x=>x.urgency==="critical"||x.urgency==="high").length*18),Math.min(100,d.reduce((a,x)=>a+(x.affectedPop||0),0)/800),d.filter(x=>x.type==="wildfire").reduce((a,x)=>a+(x.wind||0)/80*40+(1-(x.humidity||50)/100)*30,0)/Math.max(1,d.filter(x=>x.type==="wildfire").length),Math.min(100,s.filter(x=>/power|tower|gas|electric/.test((x.msg||"").toLowerCase())).length*25)];
  },[displayDisasters,displaySOS]);

  // Simulation
  const [simRunning,setSimRunning]=useState(false), [simElapsed,setSimElapsed]=useState(0), [simPhase,setSimPhase]=useState("MONITORING"), [simPhaseLabel,setSimPhaseLabel]=useState("SCENARIO INITIALISING…"), [simPhaseColor,setSimPhaseColor]=useState("cyan"), [simRisk,setSimRisk]=useState(22), [simOffline,setSimOffline]=useState(false), [simQueued,setSimQueued]=useState(0), [simLogs,setSimLogs]=useState([]), [simBriefing,setSimBriefing]=useState(false), [simDisasters,setSimDisasters]=useState(INITIAL_DISASTERS), [simSOS,setSimSOS]=useState([]);
  const firedBeats=useRef(new Set()), timerRef=useRef(null);
  const addLog=useCallback((msg,type="info")=>{ const ts=new Date().toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"}); setSimLogs(p=>[...p.slice(-80),{msg,type,timestamp:ts}]); },[]);
  const startSim=()=>{ firedBeats.current=new Set();setSimRunning(true);setSimElapsed(0);setSimPhase("MONITORING");setSimPhaseLabel("SCENARIO INITIALISING…");setSimPhaseColor("cyan");setSimRisk(22);setSimOffline(false);setSimQueued(0);setSimBriefing(false);setSimLogs([]);setSimDisasters(INITIAL_DISASTERS.map(d=>({...d,ts:Date.now()-3600000})));setSimSOS([]); };
  const stopSim=useCallback(()=>{setSimRunning(false);clearInterval(timerRef.current);},[]);

  useEffect(()=>{
    if(!simRunning) return;
    timerRef.current=setInterval(()=>{
      setSimElapsed(prev=>{
        const next=prev+1; if(next>61){setSimRunning(false);return prev;}
        SIM_BEATS.forEach(beat=>{
          const key=`${beat.t}_${beat.type}_${beat.id||""}`;
          if(beat.t===next&&!firedBeats.current.has(key)){
            firedBeats.current.add(key);
            switch(beat.type){
              case "phase":       setSimPhase(beat.phase);setSimPhaseLabel(beat.label);setSimPhaseColor(beat.color);addLog(`▶ ${beat.label}`,"phase");break;
              case "log":         addLog(beat.msg,"info");break;
              case "risk":        setSimRisk(beat.score);addLog(`RISK → ${beat.score}/100`,"risk");break;
              case "offline":     setSimOffline(beat.active);addLog(beat.active?"⚡ OFFLINE QUEUE ACTIVE":"✓ Network restored","offline");if(!beat.active)setTimeout(()=>setSimQueued(0),1400);break;
              case "sos":         setSimSOS(p=>[{...beat.sos,ts:Date.now()},...p]);if(beat.sos.offline){setSimQueued(q=>q+1);addLog(`⚡ SOS QUEUED [${beat.sos.urgency.toUpperCase()}]: "${beat.sos.msg.slice(0,50)}…"`,"sos");}else addLog(`🆘 SOS [${beat.sos.urgency.toUpperCase()}]: "${beat.sos.msg.slice(0,50)}…"`,"sos");break;
              case "escalate":    setSimDisasters(p=>p.map(d=>d.id===beat.id?{...d,severity:beat.severity,wind:beat.wind??d.wind,humidity:beat.humidity??d.humidity}:d));addLog(`📈 #${beat.id} → ${beat.severity.toUpperCase()}`,"incident");break;
              case "newincident": setSimDisasters(p=>[...p,{...beat.incident,ts:Date.now()}]);addLog(`🆕 NEW: ${beat.incident.name} [${beat.incident.severity.toUpperCase()}]`,"incident");break;
              case "briefing":    setSimBriefing(true);addLog("🤖 Generating final briefing…","phase");break;
            }
          }
        });
        return next;
      });
    },1000);
    return()=>clearInterval(timerRef.current);
  },[simRunning,addLog]);

  const handleLivePulse=async()=>{
    if(pulseLoading) return;
    setPulseLoading(true);setPulseState({status:"loading",logs:["Initialising Live Crisis Pulse…"],briefing:null,newCount:0,riskDelta:0});setPanel("map");
    const addPL=msg=>setPulseState(p=>p?{...p,logs:[...p.logs,msg]}:p);
    const {incidents,logs}=await fetchLiveAlerts();
    for(const l of logs){addPL(l);await new Promise(r=>setTimeout(r,180));}
    const existNames=new Set(disasters.map(d=>d.name.toLowerCase().slice(0,20)));
    const fresh=incidents.filter(i=>!existNames.has(i.name.toLowerCase().slice(0,20)));
    if(fresh.length>0){setDisasters(p=>[...p,...fresh]);setNewIncidentIds(fresh.map(i=>i.id));setTimeout(()=>setNewIncidentIds([]),8000);}
    const rtiDelta=fresh.filter(i=>i.severity==="critical").length*8+fresh.filter(i=>i.severity==="high").length*4;
    addPL("Generating live AI briefing…");
    const briefingText=await(fresh.length>0?generateAIBriefing([...disasters,...fresh],sosReports):Promise.resolve("No new incidents differ from current baseline. Live feeds (NWS CA + USGS) queried successfully. Dashboard on most current available data."));
    setPulseState({status:"done",logs:[...logs,"Generating live AI briefing…"],briefing:briefingText,newCount:fresh.length,riskDelta});
    setPulseLoading(false);
  };

  const handleSelectDisaster=d=>{setSelected(d);if(d)setPanel("intel");};
  const handleToggleOffline=()=>{ if(offlineMode){setSyncing(true);setTimeout(()=>{setSyncing(false);setOfflineMode(false);setQueuedCount(0);},1800);}else setOfflineMode(true); };

  const handleSOSSubmit=(report)=>{
    // Add to sosReports and optionally update incidents map
    setSosReports(p=>[report,...p]);
    if(report.offline) setQueuedCount(c=>c+1);
    // Add a new disaster pin for fire/flooding/tornado SOS if category suggests it
    if(["fire","flooding","trapped"].includes(report.category)){
      const typeMap={fire:"wildfire",flooding:"flood",trapped:"wildfire"};
      const newInc={
        id:`sos_inc_${Date.now()}`,
        type:typeMap[report.category]||"wildfire",
        lat:report.lat+0.01*(Math.random()-0.5),
        lng:report.lng+0.01*(Math.random()-0.5),
        name:`SOS-Reported: ${SOS_CATEGORIES.find(c=>c.id===report.category)?.label||"Incident"}`,
        severity:report.urgency,
        status:"active",
        ts:Date.now(),
        affectedPop:Math.floor(50+Math.random()*300),
        liveData:true,
        source:"SOS",
      };
      setDisasters(p=>[...p,newInc]);
      setNewIncidentIds([newInc.id]);
      setTimeout(()=>setNewIncidentIds([]),6000);
    }
    setShowSOSForm(false);
  };

  const activeCount=displayDisasters.filter(d=>d.status==="active"||d.status==="warning").length;
  const criticalCount=displayDisasters.filter(d=>d.severity==="critical").length;
  const totalAffected=displayDisasters.reduce((s,d)=>s+(d.affectedPop||0),0);
  const sosCritHigh=displaySOS.filter(s=>s.urgency==="critical"||s.urgency==="high").length;

  return (
    <>
      {simRunning&&<SimOverlay elapsed={simElapsed} phase={simPhase} phaseLabel={simPhaseLabel} phaseColor={simPhaseColor} logs={simLogs} riskScore={simRisk} offlineActive={simOffline} queuedCount={simQueued} onStop={stopSim} showBriefing={simBriefing} simDisasters={simDisasters} simSOS={simSOS}/>}

      <div className="min-h-screen bg-[#060e1c] text-white" style={{fontFamily:"'IBM Plex Mono','Courier New',monospace"}}>
        <div className="fixed inset-0 pointer-events-none z-0" style={{backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,200,0.012) 2px,rgba(0,255,200,0.012) 4px)"}}/>

        <header className="relative z-10 border-b border-white/8 bg-black/40 backdrop-blur-sm">
          <div className="max-w-screen-xl mx-auto px-6 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-sm">⚡</div>
              <span className="text-white font-bold text-sm tracking-widest">STORM<span className="text-cyan-400">LINK</span></span>
              <span className="text-xs text-slate-600 border-l border-white/10 pl-2.5">DISASTER INTELLIGENCE v0.4</span>
            </div>
            <div className="flex items-center gap-2 ml-auto flex-wrap justify-end">
              {syncing&&<span className="text-xs text-cyan-400 font-mono animate-pulse">SYNCING…</span>}
              <div className="flex gap-1 bg-white/3 rounded-lg border border-white/8 p-1">
                {Object.entries(REGION_VIEWS).map(([k,v])=>(
                  <button key={k} onClick={()=>{setRegionMode(k);setGlobalMode(k==="global");}}
                    className={`px-2 py-1 rounded-md text-xs font-mono transition-all ${regionMode===k?"bg-cyan-500/20 text-cyan-300 border border-cyan-500/30":"text-slate-500 hover:text-slate-300"}`}>
                    {v.label}
                  </button>
                ))}
              </div>
              <button onClick={handleLivePulse} disabled={pulseLoading} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-500/50 bg-cyan-500/10 hover:bg-cyan-500/20 transition-all disabled:opacity-60 group" style={{boxShadow:"0 0 16px rgba(6,182,212,0.14)"}}>
                <span className={`w-2 h-2 rounded-full ${pulseLoading?"bg-cyan-400 animate-ping":"bg-cyan-500"}`}/>
                <span className="text-xs font-mono font-bold text-cyan-300">{pulseLoading?"FETCHING…":"LIVE CRISIS PULSE"}</span>
                {!pulseLoading&&<span className="text-cyan-500 text-xs">↗</span>}
              </button>
              <button onClick={startSim} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 transition-all group" style={{boxShadow:"0 0 16px rgba(239,68,68,0.14)"}}>
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse"/>
                <span className="text-xs font-mono font-bold text-red-300">RUN CRISIS SIM</span>
                <span className="text-red-400 text-xs">▶</span>
              </button>
              <button onClick={handleToggleOffline} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono transition-all ${offlineMode?"bg-purple-500/20 text-purple-300 border-purple-500/40":"bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"}`}>
                <span className={`w-2 h-2 rounded-full ${offlineMode?"bg-purple-400 animate-pulse":"bg-slate-600"}`}/>
                {offlineMode?`OFFLINE·${queuedCount}`:"OFFLINE SIM"}
              </button>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/8">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/><span className="text-xs text-slate-400 font-mono">AI·ACTIVE</span>
              </div>
            </div>
          </div>
        </header>

        <div className="relative z-10 max-w-screen-xl mx-auto px-6 py-5 flex flex-col gap-5">
          <div className="grid grid-cols-5 gap-3">
            {[{label:"ACTIVE INCIDENTS",value:activeCount,color:"text-white"},{label:"CRITICAL",value:criticalCount,color:"text-red-400"},{label:"AFFECTED",value:totalAffected.toLocaleString(),color:"text-orange-300"},{label:"SOS CRIT/HIGH",value:sosCritHigh,color:"text-purple-300"},{label:"RTI SCORE",value:rti,color:rti>=70?"text-red-400":rti>=50?"text-orange-300":"text-yellow-300"}].map((s,i)=>(
              <div key={i} className="bg-white/5 rounded-xl border border-white/8 px-4 py-3"><p className="text-xs text-slate-500 font-mono mb-1">{s.label}</p><p className={`text-2xl font-bold ${s.color}`}>{s.value}</p></div>
            ))}
          </div>

          {pulseState&&<LivePulsePanel state={pulseState} onClose={()=>setPulseState(null)}/>}

          <div className="flex gap-1 border-b border-white/8">
            {[{key:"map",label:"🗺 LIVE MAP"},{key:"intel",label:"🤖 AI INTEL"},{key:"sos",label:`🆘 SOS (${sosReports.length})`},{key:"rti",label:"📊 RTI & PREDICT"},{key:"timeline",label:"⏱ TIMELINE"},{key:"briefing",label:"📋 BRIEFINGS"}].map(tab=>(
              <button key={tab.key} onClick={()=>setPanel(tab.key)} className={`px-4 py-2 text-xs font-mono transition-all border-b-2 -mb-px ${panel===tab.key?"border-cyan-400 text-cyan-300":"border-transparent text-slate-500 hover:text-slate-300"}`}>{tab.label}</button>
            ))}
          </div>

          {panel==="map"&&(
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 flex-wrap"><span className="text-xs text-slate-500 font-mono">LAYER CONTROLS</span><LayerToggles layers={layers} setLayers={setLayers}/></div>
              <div className="grid grid-cols-[1fr_300px] gap-5">
                <div style={{height:520}}><LeafletMap disasters={displayDisasters} sosReports={displaySOS} selected={selected} onSelect={handleSelectDisaster} layers={layers} regionMode={regionMode} newIds={newIncidentIds} globalMode={globalMode}/></div>
                <div className="flex flex-col gap-3 overflow-auto" style={{maxHeight:520}}>
                  <p className="text-xs text-slate-500 font-mono">INCIDENT INDEX</p>
                  {displayDisasters.map(d=>{const sc=SEV_COLORS[d.severity],isSel=selected?.id===d.id;return(
                    <button key={d.id} onClick={()=>handleSelectDisaster(isSel?null:d)} className={`text-left w-full rounded-xl border px-3 py-2.5 transition-all ${isSel?`${sc.bg} ${sc.border} shadow-lg`:"bg-white/3 border-white/8 hover:bg-white/8"}`}>
                      <div className="flex items-center gap-2"><span>{INCIDENT_ICONS[d.type]||"⚠️"}</span><span className="text-white text-xs font-medium flex-1 truncate">{d.name}</span>{d.liveData&&<span className="text-xs text-cyan-400 font-mono">LIVE</span>}<span className={`text-xs font-mono ${sc.text}`}>{d.severity.toUpperCase()}</span></div>
                      <div className="flex items-center gap-2 mt-1"><span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`}/><span className="text-xs text-slate-500 font-mono">{d.status.toUpperCase()}</span><span className="text-xs text-slate-600 ml-auto font-mono">{timeAgo(d.ts)}</span></div>
                    </button>
                  );})}
                  {globalMode&&<GlobalCrisisPanel disasters={displayDisasters} sosReports={displaySOS}/>}
                </div>
              </div>
            </div>
          )}

          {panel==="intel"&&(
            <div className="grid grid-cols-[280px_1fr] gap-5" style={{minHeight:520}}>
              <div className="flex flex-col gap-3">
                <p className="text-xs text-slate-500 font-mono">SELECT INCIDENT</p>
                {displayDisasters.map(d=>{const sc=SEV_COLORS[d.severity],isSel=selected?.id===d.id;return(
                  <button key={d.id} onClick={()=>handleSelectDisaster(isSel?null:d)} className={`text-left w-full rounded-xl border px-3 py-2.5 transition-all ${isSel?`${sc.bg} ${sc.border}`:"bg-white/3 border-white/8 hover:bg-white/8"}`}>
                    <div className="flex items-center gap-2"><span>{INCIDENT_ICONS[d.type]||"⚠️"}</span><span className="text-white text-xs flex-1 truncate">{d.name}</span></div>
                  </button>
                );})}
              </div>
              <div className="bg-white/3 rounded-2xl border border-white/8 p-5" style={{minHeight:480}}>
                {selected?<AISummaryPanel disaster={selected} onClose={()=>setSelected(null)}/>
                  :<div className="flex flex-col items-center justify-center h-full gap-3 text-center"><span className="text-5xl opacity-30">🤖</span><p className="text-slate-500 text-sm">Select an incident to view AI intelligence</p></div>}
              </div>
            </div>
          )}

          {panel==="sos"&&(
            <div className="grid grid-cols-[1fr_460px] gap-5" style={{minHeight:520}}>
              {/* SOS feed */}
              <div className="bg-white/3 rounded-2xl border border-white/8 p-5 overflow-auto">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono text-slate-500">SOS REPORTS · {sosReports.length} ACTIVE</span>
                  <button onClick={()=>setShowSOSForm(true)} className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30 font-mono font-bold transition-colors">🆘 NEW EMERGENCY</button>
                </div>
                <div className="flex flex-col gap-3">{sosReports.map(s=><SOSReportCard key={s.id} report={s}/>)}</div>
              </div>

              {/* SOS form / coordination */}
              <div className="bg-white/3 rounded-2xl border border-white/8 p-5 overflow-auto">
                {showSOSForm ? (
                  <EmergencySOSForm onSubmit={handleSOSSubmit} onCancel={()=>setShowSOSForm(false)} offlineMode={offlineMode}/>
                ) : (
                  <div className="flex flex-col gap-4">
                    <p className="text-xs text-slate-500 font-mono">EMERGENCY COORDINATION</p>
                    {/* Large SOS button */}
                    <button onClick={()=>setShowSOSForm(true)}
                      className="w-full py-5 rounded-2xl border-2 border-red-500/50 bg-red-500/10 hover:bg-red-500/18 text-red-300 font-bold text-lg font-mono transition-all flex flex-col items-center gap-2"
                      style={{boxShadow:"0 0 24px rgba(239,68,68,0.18)"}}>
                      <span className="text-4xl">🆘</span>
                      <span>SEND EMERGENCY SOS</span>
                      <span className="text-xs text-red-500 font-normal">Tap · Select category · Hold to send</span>
                    </button>
                    {/* Category preview */}
                    <div>
                      <p className="text-xs text-slate-500 font-mono mb-2">EMERGENCY CATEGORIES</p>
                      <div className="grid grid-cols-4 gap-1.5">
                        {SOS_CATEGORIES.map(cat=>(
                          <div key={cat.id} onClick={()=>setShowSOSForm(true)} className="flex flex-col items-center gap-1 p-2 rounded-xl border border-white/8 bg-white/3 hover:bg-white/8 cursor-pointer transition-all" style={{borderColor:`${cat.color}20`}}>
                            <span className="text-xl">{cat.icon}</span>
                            <span className="text-xs text-white font-mono text-center leading-tight" style={{fontSize:9}}>{cat.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {offlineMode&&(
                      <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4">
                        <p className="text-xs font-mono text-purple-300 mb-1">⚡ OFFLINE ACTIVE</p>
                        <p className="text-xs text-slate-400 mb-3">Queue: {queuedCount} pending.</p>
                        <button onClick={handleToggleOffline} className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/30 font-mono w-full">{syncing?"SYNCING…":"SIMULATE RECONNECT →"}</button>
                      </div>
                    )}
                    <div className="rounded-xl border border-white/8 bg-white/3 p-4">
                      <p className="text-xs font-mono text-slate-500 mb-2">AI TRIAGE PIPELINE</p>
                      <div className="flex flex-col gap-1.5 text-xs text-slate-400">
                        {["Select emergency category (tap-first, typing optional)","Device context auto-captured (battery, network, location)","Hold 2.5s to confirm — prevents accidental sends","AI classifies urgency, generates responder brief","Nearest safe zone identified via Haversine distance","Confirmation with ETA, safety instruction, responder visibility"].map((step,i)=>(
                          <div key={i} className="flex items-start gap-2"><span className="text-cyan-500 font-mono">{i+1}.</span><span>{step}</span></div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {panel==="rti"&&(
            <div className="grid grid-cols-[1fr_1fr] gap-5">
              <div className="flex flex-col gap-4">
                <RTIGauge rti={rti} breakdown={rtiBreakdown}/>
                {globalMode&&<GlobalCrisisPanel disasters={displayDisasters} sosReports={displaySOS}/>}
                <div className="bg-white/3 rounded-xl border border-white/8 p-4">
                  <p className="text-xs font-mono text-slate-500 mb-2">RTI FORMULA</p>
                  <div className="text-xs font-mono text-slate-400 leading-relaxed">
                    <span className="text-cyan-400">RTI</span> = 0.30·<span className="text-red-300">IncidentSeverity</span><br/>
                    + 0.20·<span className="text-orange-300">IncidentDensity</span><br/>
                    + 0.15·<span className="text-purple-300">SOSDensity</span><br/>
                    + 0.15·<span className="text-yellow-300">PopulationExposure</span><br/>
                    + 0.10·<span className="text-green-300">EnvironmentalConditions</span><br/>
                    + 0.10·<span className="text-blue-300">InfrastructureFailure</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-4">
                <p className="text-xs font-mono text-slate-500">PREDICTIVE ESCALATION — ALL INCIDENTS</p>
                {displayDisasters.map(d=>(
                  <div key={d.id} className="bg-white/3 rounded-xl border border-white/8 p-3">
                    <div className="flex items-center gap-2 mb-2"><span>{INCIDENT_ICONS[d.type]||"⚠️"}</span><span className="text-xs text-white font-medium truncate flex-1">{d.name}</span></div>
                    <EscalationCard disaster={d}/>
                  </div>
                ))}
              </div>
            </div>
          )}

          {panel==="timeline"&&(
            <div className="flex flex-col gap-5">
              <TimelineReplay disasters={disasters} sosReports={sosReports} onSnapshotChange={snap=>setReplaySnapshot(snap.hour===24?null:snap)}/>
              <div className="grid grid-cols-[1fr_280px] gap-5">
                <div style={{height:420}}><LeafletMap disasters={displayDisasters} sosReports={displaySOS} selected={null} onSelect={handleSelectDisaster} layers={layers} regionMode={regionMode} newIds={[]} globalMode={globalMode}/></div>
                <div className="flex flex-col gap-3 overflow-auto" style={{maxHeight:420}}>
                  <p className="text-xs text-slate-500 font-mono">SNAPSHOT</p>
                  {displayDisasters.map(d=>{const sc=SEV_COLORS[d.severity];return(<div key={d.id} className="rounded-xl border px-3 py-2 bg-white/3 border-white/8"><div className="flex items-center gap-2"><span>{INCIDENT_ICONS[d.type]||"⚠️"}</span><span className="text-xs text-white flex-1 truncate">{d.name}</span><span className={`text-xs font-mono ${sc.text}`}>{d.severity.slice(0,4).toUpperCase()}</span></div></div>);})}
                </div>
              </div>
            </div>
          )}

          {panel==="briefing"&&(
            <div className="grid grid-cols-[1fr_1fr] gap-5">
              <div className="flex flex-col gap-4">
                <AIBriefingPanel disasters={displayDisasters} sosReports={displaySOS} mode="operational"/>
                <RTIGauge rti={rti} breakdown={rtiBreakdown}/>
              </div>
              <div className="flex flex-col gap-4">
                {globalMode&&<GlobalCrisisPanel disasters={displayDisasters} sosReports={displaySOS}/>}
                <div className="bg-white/3 rounded-xl border border-white/8 p-4">
                  <p className="text-xs font-mono text-slate-500 mb-3">TOP ESCALATION RISKS</p>
                  <div className="flex flex-col gap-2">
                    {displayDisasters.map(d=>({...d,esc:predictEscalation(d)})).sort((a,b)=>b.esc.pct-a.esc.pct).slice(0,4).map(d=>{
                      const c=d.esc.pct>=70?"#ef4444":d.esc.pct>=45?"#f97316":"#eab308";
                      return(<div key={d.id} className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/3 px-3 py-2"><span>{INCIDENT_ICONS[d.type]||"⚠️"}</span><span className="text-xs text-white flex-1 truncate">{d.name}</span><div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden"><div style={{width:`${d.esc.pct}%`,background:c,height:"100%",borderRadius:"9999px"}}/></div><span className="text-xs font-mono font-bold" style={{color:c}}>{d.esc.pct}%</span></div>);
                    })}
                  </div>
                </div>
                <div className="bg-white/3 rounded-xl border border-white/8 p-4">
                  <p className="text-xs font-mono text-slate-500 mb-2">OPERATIONAL METRICS</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[{k:"Active Incidents",v:activeCount,c:"text-white"},{k:"Critical Events",v:criticalCount,c:"text-red-400"},{k:"SOS Critical+High",v:sosCritHigh,c:"text-purple-300"},{k:"Population at Risk",v:totalAffected.toLocaleString(),c:"text-orange-300"},{k:"Wildfire Incidents",v:displayDisasters.filter(d=>d.type==="wildfire").length,c:"text-orange-400"},{k:"Seismic Events",v:displayDisasters.filter(d=>d.type==="earthquake").length,c:"text-yellow-300"}].map((s,i)=>(
                      <div key={i} className="bg-white/5 rounded-lg p-2"><p className="text-xs text-slate-600 font-mono" style={{fontSize:9}}>{s.k}</p><p className={`text-base font-bold ${s.c}`}>{s.v}</p></div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="relative z-10 border-t border-white/5 mt-6 py-3 px-6">
          <div className="max-w-screen-xl mx-auto flex items-center justify-between text-xs text-slate-700 font-mono">
            <span>STORMLINK v0.4 · HACKATHON DEMO · NOT FOR OPERATIONAL USE</span>
            <span>MAP: OpenStreetMap/CARTO · DATA: NWS · USGS · CLAUDE AI</span>
          </div>
        </footer>
      </div>

      <style>{`
        @keyframes fadeInUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </>
  );
}