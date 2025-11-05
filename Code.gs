/** SGA Intake — Apps Script backend (Sheet storage + role/group assignment)
 *  - Saves each submission (duplicate-protected by Email)
 *  - Scores roles: Marketing & Media (cap 6), Finance & Logistics (cap 5), Event Planner & Space (cap 5)
 *  - Places into 5 groups, each with 1 Finance + 1 Space + 1 Media; extra media = Floater
 *  - Stores laneRank as JSON for full ordering
 */

const SHEET_NAME = "Form Responses 1";
const ROLE_CAPS = {"Marketing & Media":6,"Finance & Logistics":5,"Event Planner & Space":5};
const GROUPS = ["G1 — Social & Experiences","G2 — Wellness & Growth","G3 — Service & Philanthropy","G4 — Academic & Career","G5 — Culture & Traditions"];

// Optional: restrict to these emails only (must also be in frontend dropdown)
const ALLOWED_EMAILS = [
  "aschult2@highpoint.edu","2029communications@highpoint.edu","abollar@highpoint.edu",
  "bmendivi@highpoint.edu","2029treasurer@highpoint.edu","ckraras@highpoint.edu",
  "2029president@highpoint.edu","evanzego@highpoint.edu","eravenel@highpoint.edu",
  "espurrie@highpoint.edu","gllopis@highpoint.edu","hdaly1@highpoint.edu",
  "jkrumpe@highpoint.edu","jpace@highpoint.edu","kkincai2@highpoint.edu",
  "mreinharr@highpoint.edu","ncastro@highpoint.edu","2029events@highpoint.edu",
  "2029vp@highpoint.edu","tshah1@highpoint.edu","tvanscot@highpoint.edu","lporter2@highpoint.edu"
];

function doPost(e){
  const body = JSON.parse(e.postData.contents||"{}");
  const email = String(body.email||"").toLowerCase();
  if(!/@highpoint\.edu$/.test(email)) return ContentService.createTextOutput("bad email");
  if(ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) return ContentService.createTextOutput("not allowed");

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh) sh = ss.insertSheet(SHEET_NAME);

  const headers = [
    "Timestamp","Full Name","Phone","Email",
    "Majors (tags JSON)","Dream Job",
    "Attendance","Signature","Acknowledged?",
    "Superpower","Music","First App",
    "Lane Rank (JSON)",
    "Score — Finance & Logistics","Score — Event Planner & Space","Score — Marketing & Media",
    "Total Role Score","Primary Role","Secondary Role",
    "Assigned Group","Is Media Floater (Y/N)"
  ];
  if(sh.getLastRow()===0) sh.getRange(1,1,1,headers.length).setValues([headers]);

  // Upsert by email
  const emailCol = headers.indexOf("Email")+1;
  const last = sh.getLastRow();
  let rowToWrite = last+1;
  if(last>=2){
    const emails = sh.getRange(2,emailCol,last-1,1).getValues().map(r=>String(r[0]).toLowerCase());
    const i = emails.indexOf(email);
    if(i!==-1) rowToWrite = i+2;
  }

  // Write raw
  sh.getRange(rowToWrite,1,1,13).setValues([[
    new Date(), body.name||"", body.phone||"", email,
    JSON.stringify(body.majors||[]), body.dream||"",
    body.attendance||"", body.signature||"", !!body.ack,
    body.superpower||"", body.music||"", body.firstApp||"",
    JSON.stringify(body.laneRank||[])
  ]]);

  // Recompute scores + roles for ALL rows (so caps remain exact)
  const rng = sh.getRange(2,1,Math.max(sh.getLastRow()-1,0), headers.length);
  const data = rng.getValues().map((r,i)=>({
    row:i+2,
    name:r[1], phone:r[2], email:String(r[3]).toLowerCase(),
    majors:parseJSON(r[4]), dream:r[5],
    attendance:r[6], signature:r[7], ack:r[8],
    superpower:r[9], music:r[10], firstApp:r[11],
    laneRank:parseJSON(r[12])
  }));

  const scored = data.map(d => {
    const s = score(d);
    return Object.assign({}, d, s, { total: s.fin + s.space + s.media });
  }).sort((a,b)=> b.total - a.total);

  // Assign roles under caps
  const caps = Object.assign({}, ROLE_CAPS);
  const withRoles = scored.map(r=>{
    const choices = [
      ["Marketing & Media", r.media],
      ["Finance & Logistics", r.fin],
      ["Event Planner & Space", r.space]
    ].sort((a,b)=> b[1]-a[1]);
    let primary=null, secondary=null;
    for(const [role] of choices){
      if(primary===null && caps[role]>0){ primary=role; caps[role]--; }
      else if(secondary===null){ secondary=role; }
    }
    if(!primary) primary = choices[0][0];
    return Object.assign({}, r, {primary, secondary});
  });

  // Slot into 5 groups (round-robin by role). Extra media → floater.
  const finance = withRoles.filter(r=>r.primary==="Finance & Logistics");
  const space   = withRoles.filter(r=>r.primary==="Event Planner & Space");
  const media   = withRoles.filter(r=>r.primary==="Marketing & Media");

  const slots = GROUPS.map(g=>({g, fin:null, space:null, media:null}));
  function deal(list, key){
    let i=0;
    list.forEach(p=>{
      for(let k=0;k<slots.length;k++){
        const gi=(i+k)%slots.length;
        if(!slots[gi][key]){ slots[gi][key]=p; i=gi+1; return; }
      }
    });
  }
  deal(finance,"fin"); deal(space,"space"); deal(media,"media");

  const placed = new Set();
  slots.forEach(s=>{ ["fin","space","media"].forEach(k=>{ if(s[k]) placed.add(s[k].row); }); });
  const mediaLeft = media.filter(m=>!placed.has(m.row));

  // write scores + roles first
  withRoles.forEach(r=>{
    const row = r.row;
    sh.getRange(row, headers.indexOf("Score — Finance & Logistics")+1, 1, 5)
      .setValues([[r.fin, r.space, r.media, r.total, r.primary]]);
    sh.getRange(row, headers.indexOf("Secondary Role")+1).setValue(r.secondary||"");
    sh.getRange(row, headers.indexOf("Is Media Floater (Y/N")+2).setValue(""); // clear
  });

  // write groups
  slots.forEach(s=>{
    if(s.fin)   sh.getRange(s.fin.row,   headers.indexOf("Assigned Group")+1).setValue(s.g);
    if(s.space) sh.getRange(s.space.row, headers.indexOf("Assigned Group")+1).setValue(s.g);
    if(s.media) sh.getRange(s.media.row, headers.indexOf("Assigned Group")+1).setValue(s.g);
  });
  mediaLeft.forEach(m=>{
    sh.getRange(m.row, headers.indexOf("Is Media Floater (Y/N")+2).setValue("Y");
  });

  return ContentService.createTextOutput("ok");
}

// ---- Scoring logic (same signals you approved) ----
function score(d){
  const sup = (d.superpower||"").trim();
  const music = (d.music||"").trim();
  const first = (d.firstApp||"").trim();
  const majors = (d.majors||[]).join(" ").toLowerCase();
  const dream = (d.dream||"").toLowerCase();

  let fin=0, space=0, media=0;

  // Finance & Logistics
  if(sup==="Time freeze") fin+=1;
  if(sup==="Super speed") fin+=0.5;
  if(first==="Calendar") fin+=1;
  if(first==="Starbucks App") fin+=0.5;
  if(music==="Classical/Jazz") fin+=0.5;
  if(/finance|account|econ|math|supply|ops|statistics|data/.test(majors)) fin+=1;
  if(/analyst|cfo|pm|operator|consultant|manager/.test(dream)) fin+=1;

  // Event Planner & Space
  if(sup==="Shape-shift") space+=1;
  if(sup==="Time freeze") space+=0.5;
  if(sup==="Invisibility") space+=0.5;
  if(first==="Starbucks App") space+=0.5;
  if(first==="Calendar") space+=0.5;
  if(music==="Country") space+=0.5;
  if(/project|event|hospitality|engineering|it|operations|production/.test(majors)) space+=1;
  if(/coordinator|producer|director|engineer/.test(dream)) space+=1;

  // Marketing & Media
  if(sup==="Telepathy") media+=1;
  if(sup==="Shape-shift") media+=0.5;
  if(first==="Instagram / TikTok") media+=1;
  if(first==="Messages / DMs") media+=0.5;
  if(music==="2010s Pop Girl" || music==="Rap / Trap") media+=0.5;
  if(/marketing|comm|graphic|journal|media|film|design|branding/.test(majors)) media+=1;
  if(/marketer|brand|pr|designer|filmmaker|journalist|creator/.test(dream)) media+=1;

  return {fin, space, media};
}

function parseJSON(x){ try{ return JSON.parse(x||"[]"); }catch(e){ return []; } }
