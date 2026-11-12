// Generates the three seller delivery files used in the demo. Seeded, so the
// files are reproducible. All people and companies are synthetic.
//   datasets/ledgerline.csv  1,000 records, all valid           -> full capture
//   datasets/leadsprint.csv  1,000 records, 720 valid, 280 bad  -> partial capture
//   datasets/bulkreach.csv   1,000 records, 0 valid             -> void
import { writeFileSync, mkdirSync } from "node:fs";
import { toCSV } from "../lib/csv.js";

let seed = 20261112;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const pre = ["Lumen","Kora","Brightwire","Tallyo","Paystream","Ledgerly","Clearmint","Novapay","Riverbank","Atlasfin","Coinvale","Settlr","Fundbridge","Monzu","Quanta","Vaultic","Remitly","Payara","Ozone","Sterling","Halcyon","Meridian","Cobalt","Tandem","Juniper","Corvid","Basalt","Ember","Solace","Northstar"];
const suf = ["Pay","Ledger","Capital","Payments","Finance","Labs","Money","Bank","Wallet","Rails","Credit","Markets","Exchange","Treasury"];
const tlds = ["io","co","com","finance","money"];
const first = ["Amara","Tunde","Grace","Liam","Chen","Fatima","Kwame","Sofia","Daniel","Aisha","Noah","Zainab","Ethan","Ngozi","Olivia","Musa","Hannah","Ifeoma","Lucas","Wanjiru","Ama","Thabo","Emily","Yusuf","Chloe","Kofi","Mia","Bola","James","Halima"];
const last = ["Okafor","Bello","Smith","Mensah","Adeyemi","Wang","Kamau","Johnson","Nwosu","Ibrahim","Brown","Osei","Mokoena","Garcia","Eze","Taylor","Abubakar","Owusu","Davies","Chukwu","Naidoo","Clarke","Odhiambo","Lawal","Martin","Danjuma","Walker","Mbeki","Hughes","Sani"];
const titles = ["Founder & CEO","Co-founder","Chief Technology Officer","Chief Financial Officer","VP Payments","Head of Partnerships","VP Engineering","Chief Operating Officer","Head of Product","Director of Risk"];
const countries = { US: "+1", GB: "+44", CA: "+1", NG: "+234", KE: "+254", ZA: "+27", GH: "+233" };

function digits(n) { let s = String(1 + Math.floor(rnd() * 9)); while (s.length < n) s += Math.floor(rnd() * 10); return s; }

const used = new Set();
function validRecord(i, prefix) {
  const company = `${pick(pre)} ${pick(suf)}`;
  const domain = `${company.toLowerCase().replace(/[^a-z]/g, "")}.${pick(tlds)}`;
  const f = pick(first), l = pick(last);
  const cc = pick(Object.keys(countries));
  const local = `${f}.${l}${Math.floor(rnd() * 90 + 10)}`.toLowerCase();
  const email = `${local}@${domain}`;
  if (used.has(email)) return validRecord(i, prefix);
  used.add(email);
  return {
    id: `${prefix}-${String(i).padStart(4, "0")}`, company, contact_name: `${f} ${l}`, title: pick(titles),
    email, phone: `${countries[cc]}${digits(cc === "US" || cc === "CA" ? 10 : 9)}`, country: cc, website: `https://${domain}`,
  };
}

const defects = {
  email: (r) => ({ ...r, email: pick([r.email.replace("@", "."), r.email.replace(/@.*/, "@mailinator.com"), r.email.replace(/@.*/, "@example.com"), "n/a"]) }),
  phone: (r) => ({ ...r, phone: pick(["0803 555 " + digits(4), "555-" + digits(4), "N/A", digits(7)]) }),
  country: (r) => ({ ...r, country: pick(["FR", "BR", "IN", "DE", "RU", "MX"]) }),
  website: (r) => ({ ...r, website: pick([r.website.replace("https://", "http://"), r.website.replace("https://", ""), "coming soon"]) }),
  mismatch: (r) => ({ ...r, email: r.email.replace(/@.*/, "@gmail.com") }),
  empty: (r) => ({ ...r, [pick(["contact_name", "title", "company"])]: "" }),
};

const header = ["id", "company", "contact_name", "title", "email", "phone", "country", "website"];
mkdirSync("datasets", { recursive: true });

// 1) Ledgerline — all valid
const good = Array.from({ length: 1000 }, (_, i) => validRecord(i + 1, "LDL"));
writeFileSync("datasets/ledgerline.csv", toCSV(header, good));

// 2) LeadSprint — 720 valid + 280 defective (incl. 50 duplicates)
const lsValid = Array.from({ length: 720 }, (_, i) => validRecord(i + 1, "LSP"));
const lsBad = [];
const plan = [["email", 60], ["phone", 50], ["country", 40], ["website", 40], ["mismatch", 25], ["empty", 15]];
let n = 721;
for (const [kind, count] of plan) for (let k = 0; k < count; k++) lsBad.push(defects[kind](validRecord(n++, "LSP")));
for (let k = 0; k < 50; k++) { const src = lsValid[Math.floor(rnd() * lsValid.length)]; lsBad.push({ ...src, id: `LSP-${String(n++).padStart(4, "0")}` }); }
const leadsprint = shuffle([...lsValid, ...lsBad]);
writeFileSync("datasets/leadsprint.csv", toCSV(header, leadsprint));

// 3) BulkReach — every record defective
const kinds = Object.keys(defects);
const bulk = Array.from({ length: 1000 }, (_, i) => {
  let r = validRecord(i + 1, "BLK");
  r = defects[pick(kinds)](r);
  if (rnd() < 0.5) r = defects[pick(kinds)](r);
  return r;
});
writeFileSync("datasets/bulkreach.csv", toCSV(header, bulk));
console.log("Wrote datasets/ledgerline.csv, leadsprint.csv, bulkreach.csv");
