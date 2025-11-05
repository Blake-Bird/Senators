/** SGA Intake — Google Apps Script backend
 * - Writes submissions to the bound Sheet
 * - Prevents duplicates by email
 * - Scores 3 roles: Marketing & Media (cap 6), Finance & Logistics (cap 5), Event Planner & Space (cap 5)
 * - Assigns 5 groups: G1 Social & Experiences, G2 Wellness & Growth, G3 Service & Philanthropy, G4 Academic & Career, G5 Culture & Traditions
 * - Ensures each group has 1 Finance + 1 Space + 1 Media (extra media = Floater)
 */

// ---------- CONFIG ----------
const ROLE_CAPS = {"Marketing & Media":6,"Finance & Logistics":5,"Event Planner & Space":5};
const GROUPS = ["G1 — Social & Experiences","G2 — Wellness & Growth","G3 — Service & Philanthropy","G4 — Academic & Career","G5 — Culture & Traditions"];

// If you want to force allowed HPU emails, fill this; otherwise leave empty to allow any @highpoint.edu
const ALLOWED_EMAILS = [
  "aschult2@highpoint.edu","2029communications@highpoint.edu","abollar@highpoint.edu",
  "bmendivi@highpoint.edu","2029treasurer@highpoint.edu","ckraras@highpoint.edu",
  "2029president@highpoint.edu","evanzego@highpoint.edu","eravenel@highpoint.edu",
  "espurrie@highpoint.edu","gllopis@highpoint.edu","hdaly1@highpoint.edu",
  "jkrumpe@highpoint.edu","jpace@highpoint.edu","kkincai2@highpoint.edu",
  "mreinharr@highpoint.edu","ncastro@highpoint.edu","2029events@highpoint.edu",
  "2029vp@highpoint.edu","tshah1@highpoint.edu","tvanscot@highpoint.edu","lporter2@highpoint.edu"
];

const SHEET_NAME = "Form Responses 1"; // change if your response sheet has a different tab name

// ---------- END CONFIG ----------

function doPost(e){
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh){ sh = ss.insertSheet(SHEET_NAME); }

  const body = JSON.parse(e.postData.contents || "{}");

  // Validation
  const email = (body.email||"").trim().toLowerCase();
  if(!/@highpoint\.edu$/.test(email)) return ContentService.createTextOutput("bad email");
  if(ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) return ContentService.createTextOutput("email not allowed");

  // Ensure headers exist
  const headers = [
    "Timestamp","Full Name","Phone Number","Email",
    "Major(s) / Minor(s)","Dream Job (1–2 words)",
    "Attendance Policy — Even-Date Mondays @ 8 PM (Cottrell)",
    "Pick your everyday superpower","Pick your music taste (go with your gut)","When you start something, what do you actually open first?",
    "Top event lane","Second choice",
    "Score — Finance & Logistics","Score — Event Planner & Space","Score — Marketing & Media",
    "Total Role Score","Primary Role","Secondary Role","Assigned Group","Is Media Floater (Y/N)"
  ];
  if(sh.getLastRow() === 0){
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }

  // Upsert by Email (prevent duplicates)
  const emailCol = headers.indexOf("Email")+1;
  const last = sh.getLastRow();
  let rowToWrite = last+1;
  if(last >= 2){
    const emails = sh.getRange(2,emailCol,last-1,1).getValues().map(r=>String(r[0]).toLowerCase());
    const idx = emails.indexOf(email);
    if(idx !== -1){ rowToWrite = idx + 2; } // existing row
  }

  // Write basic fields
  const vals = [
    new Date(),
    body.name||"",
    body.phone||"",
    email,
    body.majors||"",
    body.dream||"",
    body.attendance||"",
    body.superpower||"",
    body.music||"",
    body.firstApp||"",
    body.laneTop||"",
    body.laneSecond||"",
    "", "", "", "", "", "", "", ""
  ];
  sh.getRange(rowToWrite,1,1,vals.length).setValues([vals]);

  // Recompute scores + assignments for ALL rows to respect caps
  const data = sh.getRange(2,1,Math.max(sh.getLastRow()-1,0), headers.length).getValues();
  const rows = data.map((r,i)=>({
    idx: i+2,
    name: r[1], phone: r[2], email: String(r[3]).toLowerCase(),
    majors: r[4], dream: r[5],
    attendance: r[6],
    superpower: r[7], music:r[8], firstApp:r[9],
    laneTop:r[10], laneSecond:r[11]
  }));

  // Score each row
  const scored = rows.map(r=>{
    const s = score(r);
    return Object.assign({}, r, s, { total: s.fin + s.space + s.media });
  }).sort((a,b)=> b.total - a.total);

  // Assign roles with caps
  const caps = Object.assign({}, ROLE_CAPS);
  const roleAssigned = scored.map(r=>{
    const entries = [
      ["Marketing & Media", r.media],
      ["Finance & Logistics", r.fin],
      ["Event Planner & Space", r.space]
    ].sort((a,b)=> b[1]-a[1]);
    let primary=null, secondary=null;
    for(const [role,_] of entries){
      if(primary===null && caps[role]>0){ primary=role; caps[role]--; }
      else if(secondary===null){ secondary=role; }
    }
    if(!primary){ primary = entries[0][0]; }
    return Object.assign({}, r, { primary, secondary });
  });

  // Grouping — 1 of each role per group; extra media = floater
  const byRole = {
    fin: roleAssigned.filter(r=>r.primary==="Finance & Logistics"),
    space: roleAssigned.filter(r=>r.primary==="Event Planner & Space"),
    media: roleAssigned.filter(r=>r.primary==="Marketing & Media")
  };

  const slots = GROUPS.map(g=>({g, fin:null, space:null, media:null}));
  function deal(list, field){
    let i=0;
    list.forEach(p=>{
      // place into next group that doesn't yet have this field
      let placed=false;
      for(let k=0;k<GROUPS.length;k++){
        const gi = (i+k)%GROUPS.length;
        if(!slots[gi][field]){ slots[gi][field]=p; i = gi+1; placed=true; break; }
      }
      if(!placed){ /* overflow; ignore here (handled as floater for media) */ }
    });
  }
  deal(byRole.fin,"fin");
  deal(byRole.space,"space");
  deal(byRole.media,"media");

  // Mark media floater(s)
  const placedIds = new Set();
  slots.forEach(s=>{
    if(s.fin) placedIds.add(s.fin.idx);
    if(s.space) placedIds.add(s.space.idx);
    if(s.media) placedIds.add(s.media.idx);
  });
  const mediaLeft = byRole.media.filter(r=>!placedIds.has(r.idx));
  const floaterIdxs = mediaLeft.map(r=>r.idx);

  // Write back scores + assignments
  roleAssigned.forEach(r=>{
    const row = r.idx;
    const rowScores = [
      r.fin, r.space, r.media, r.total, r.primary, r.secondary,
      "", "" // group + floater to be set next
    ];
    sh.getRange(row, headers.indexOf("Score — Finance & Logistics")+1, 1, 7).setValues([rowScores]);
  });

  // Write groups
  slots.forEach(s=>{
    if(s.fin) sh.getRange(s.fin.idx, headers.indexOf("Assigned Group")+1).setValue(s.g);
    if(s.space) sh.getRange(s.space.idx, headers.indexOf("Assigned Group")+1).setValue(s.g);
    if(s.media) sh.getRange(s.media.idx, headers.indexOf("Assigned Group")+1).setValue(s.g);
  });
  floaterIdxs.forEach(idx=>{
    sh.getRange(idx, headers.indexOf("Is Media Floater (Y/N")+2).setValue("Y");
  });

  return ContentService.createTextOutput("ok");
}

function score(r){
  const sup = (r.superpower||"").trim();
  const music = (r.music||"").trim();
  const first = (r.firstApp||"").trim();
  const major = (r.majors||"").toLowerCase();
  const dream = (r.dream||"").toLowerCase();

  let fin=0, space=0, media=0;

  // Finance & Logistics
  if(sup==="Time freeze") fin+=1;
  if(sup==="Super speed") fin+=0.5;
  if(first==="Calendar") fin+=1;
  if(first==="Starbucks App") fin+=0.5;
  if(music==="Classical/Jazz") fin+=0.5;
  if(/finance|account|econ|math|supply|ops/.test(major)) fin+=1;
  if(/analyst|cfo|pm|operator|consultant|manager/.test(dream)) fin+=1;

  // Event Planner & Space
  if(sup==="Shape-shift") space+=1;
  if(sup==="Time freeze") space+=0.5;
  if(sup==="Invisibility") space+=0.5;
  if(first==="Starbucks App") space+=0.5;
  if(first==="Calendar") space+=0.5;
  if(music==="Country") space+=0.5;
  if(/project|event|hospitality|engineering|it|operations/.test(major)) space+=1;
  if(/coordinator|producer|director|engineer/.test(dream)) space+=1;

  // Marketing & Media
  if(sup==="Telepathy") media+=1;
  if(sup==="Shape-shift") media+=0.5;
  if(first==="Instagram / TikTok" || first==="Instagram/TikTok") media+=1;
  if(first==="Messages / DMs" || first==="Messages/DMs") media+=0.5;
  if(music==="2010s Pop Girl") media+=0.5;
  if(music==="Rap / Trap") media+=0.5;
  if(/marketing|comm|graphic|journal|media|film|design/.test(major)) media+=1;
  if(/marketer|brand|pr|designer|filmmaker|journalist|creator/.test(dream)) media+=1;

  return {fin, space, media};
}
